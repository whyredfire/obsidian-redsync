import { Notice, Platform, Plugin } from "obsidian";
import { type Codec, plainCodec } from "./codec";
import { type Account, call } from "./connection";
import { encryptedCodec } from "./crypto";
import { type Status, SyncEngine } from "./engine";
import type { Joined } from "./protocol/Joined";
import { RedSyncSettingTab } from "./settings";
import { AddDeviceModal, parseSetupLink, SetupModal } from "./setup";
import { LocalState } from "./state";

/** Device-local settings, kept in Obsidian's per-vault local storage rather than in the vault. */
export interface DeviceSettings {
    serverUrl: string;
    vaultId: string;
    vaultName: string;
    deviceId: string;
    deviceName: string;
    encrypted: boolean;
    kdfSalt: string | null;
    keyCheck: string | null;
    paused?: boolean;
    silenced?: boolean;
}

const SETTINGS_KEY = "red-sync-settings";
const LOG_LINES = 500;

export default class RedSyncPlugin extends Plugin {
    engine?: SyncEngine;
    status: Status = { state: "stopped", reason: "Not set up." };
    readonly logLines: string[] = [];
    private statusEl!: HTMLElement;
    private settingTab!: RedSyncSettingTab;

    async onload() {
        this.statusEl = this.addStatusBarItem();
        this.settingTab = new RedSyncSettingTab(this.app, this);
        this.addSettingTab(this.settingTab);
        this.addCommand({ id: "set-up", name: "Set up sync", callback: () => this.openSetup() });
        this.addCommand({
            id: "add-device",
            name: "Add a device",
            checkCallback: (checking) => {
                if (!this.deviceSettings) return false;
                if (!checking) new AddDeviceModal(this.app, this).open();
                return true;
            },
        });
        // The QR code and setup link open obsidian://red-sync?server=…&vault=…&code=…
        this.registerObsidianProtocolHandler("red-sync", (params) => {
            const link = parseSetupLink(`obsidian://red-sync?${new URLSearchParams(params as Record<string, string>)}`);
            if (link) this.openSetup(link);
        });
        this.app.workspace.onLayoutReady(() => {
            // Registered after the vault has loaded, so start-up does not report every file as created.
            const changed = (file: Parameters<SyncEngine["onLocalChange"]>[0], oldPath?: string) =>
                this.engine?.onLocalChange(file, oldPath);
            this.registerEvent(this.app.vault.on("create", (file) => changed(file)));
            this.registerEvent(this.app.vault.on("modify", (file) => changed(file)));
            this.registerEvent(this.app.vault.on("delete", (file) => changed(file)));
            this.registerEvent(this.app.vault.on("rename", (file, oldPath) => changed(file, oldPath)));
            this.registerEvent(
                this.app.workspace.on("editor-change", (_editor, info) => {
                    if (info.file) this.engine?.onEditorChange(info.file.path);
                }),
            );
            this.registerDomEvent(window, "online", () => this.engine?.wake());
            this.registerDomEvent(document, "visibilitychange", () => {
                if (document.visibilityState === "visible") this.engine?.wake();
            });
            void this.startSync();
        });
    }

    onunload() {
        this.engine?.stop();
    }

    private openSetup(link?: ReturnType<typeof parseSetupLink>) {
        if (this.deviceSettings) {
            new Notice("Red Sync: this vault already synchronises. Disconnect it in Red Sync's settings first.");
            return;
        }
        new SetupModal(this.app, this, link ?? undefined).open();
    }

    get deviceSettings(): DeviceSettings | null {
        return (this.app.loadLocalStorage(SETTINGS_KEY) as DeviceSettings | null) ?? null;
    }

    saveDeviceSettings(changes: Partial<DeviceSettings>): void {
        const current = this.deviceSettings;
        if (current) this.app.saveLocalStorage(SETTINGS_KEY, { ...current, ...changes });
    }

    private secret(name: "token" | "passphrase"): string {
        return `red-sync-${this.deviceSettings?.vaultId}-${name}`;
    }

    token(): string | null {
        return this.deviceSettings ? this.app.secretStorage.getSecret(this.secret("token")) : null;
    }

    passphrase(): string | null {
        return this.deviceSettings ? this.app.secretStorage.getSecret(this.secret("passphrase")) : null;
    }

    /** Connects this vault to a server vault; called by setup. */
    async connect(serverUrl: string, joined: Joined, deviceName: string, passphrase?: string): Promise<void> {
        const vault = joined.vault;
        this.app.saveLocalStorage(SETTINGS_KEY, {
            serverUrl,
            vaultId: vault.id,
            vaultName: vault.name,
            deviceId: joined.deviceId,
            deviceName,
            encrypted: vault.encrypted,
            kdfSalt: vault.kdfSalt,
            keyCheck: vault.keyCheck,
        } satisfies DeviceSettings);
        this.app.secretStorage.setSecret(this.secret("token"), joined.token);
        this.app.secretStorage.setSecret(this.secret("passphrase"), passphrase ?? "");
        this.settingTab.update();
        await this.startSync();
    }

    /** Forgets the server on this device (and tells the server, when it can be reached). The notes stay. */
    async disconnect(revoke = true): Promise<void> {
        const settings = this.deviceSettings;
        const token = this.token();
        this.engine?.stop();
        this.engine = undefined;
        if (!settings) return;
        if (revoke && token) {
            await call(settings.serverUrl, "DELETE", `/vaults/${settings.vaultId}/devices/${settings.deviceId}`, { token }).catch(() => undefined);
        }
        this.app.secretStorage.setSecret(this.secret("token"), "");
        this.app.secretStorage.setSecret(this.secret("passphrase"), "");
        this.app.saveLocalStorage(SETTINGS_KEY, null);
        indexedDB.deleteDatabase(`red-sync-${settings.vaultId}`);
        this.setStatus({ state: "stopped", reason: "Not set up." });
        this.settingTab.update();
    }

    async revokeDevice(deviceId: string): Promise<void> {
        const settings = this.deviceSettings!;
        await call(settings.serverUrl, "DELETE", `/vaults/${settings.vaultId}/devices/${deviceId}`, { token: this.token()! });
    }

    async renameDevice(name: string): Promise<void> {
        const settings = this.deviceSettings!;
        await call(settings.serverUrl, "PATCH", `/vaults/${settings.vaultId}/devices/${settings.deviceId}`, {
            token: this.token()!,
            json: { name },
        });
        this.saveDeviceSettings({ deviceName: name });
    }

    async startSync(): Promise<void> {
        this.engine?.stop();
        this.engine = undefined;
        const settings = this.deviceSettings;
        const token = this.token();
        if (!settings || !token) return this.setStatus({ state: "stopped", reason: "Not set up." });
        if (settings.paused) return this.setStatus({ state: "stopped", reason: "Paused." });
        let codec: Codec = plainCodec;
        if (settings.encrypted) {
            try {
                codec = await encryptedCodec(this.passphrase() ?? "", settings.kdfSalt!, settings.keyCheck!);
            } catch {
                return this.setStatus({ state: "stopped", reason: "The passphrase is missing. Disconnect and set up sync again." });
            }
        }
        const account: Account = { serverUrl: settings.serverUrl, vaultId: settings.vaultId, deviceId: settings.deviceId, token };
        const state = await LocalState.open(`red-sync-${settings.vaultId}`);
        this.engine = new SyncEngine(this.app, account, state, codec, {
            log: (message) => this.log(message),
            notice: (message) => this.notice(message),
            status: (status) => this.setStatus(status),
            revoked: () => {
                this.notice("Red Sync: this device was disconnected from the server. Set up sync again to reconnect it.");
                void this.disconnect(false);
            },
        });
        this.engine.start();
    }

    notice(message: string): void {
        this.log(message);
        if (!this.deviceSettings?.silenced) new Notice(message);
    }

    log(message: string): void {
        const line = `${new Date().toISOString()} ${message}`;
        this.logLines.push(line);
        if (this.logLines.length > LOG_LINES) this.logLines.shift();
        console.debug(`[Red Sync] ${message}`);
    }

    debugReport(): string {
        const { kdfSalt: _salt, keyCheck: _check, ...settings } = this.deviceSettings ?? ({} as DeviceSettings);
        return [
            `Red Sync ${this.manifest.version}, Obsidian ${navigator.userAgent.match(/obsidian\/([\d.]+)/)?.[1] ?? "?"}, ${Platform.isMobile ? "mobile" : "desktop"}`,
            `Status: ${statusText(this.status)}`,
            `Settings: ${JSON.stringify(settings)}`,
            "",
            ...this.logLines.slice(-100),
        ].join("\n");
    }

    private setStatus(status: Status): void {
        this.status = status;
        this.statusEl.setText(statusText(status));
    }
}

export function statusText(status: Status): string {
    switch (status.state) {
        case "synced":
            return "Synchronised";
        case "syncing":
            return `Synchronising ${status.pending}`;
        case "offline":
            return status.pending > 0 ? `Offline, ${status.pending} waiting` : "Offline";
        case "stopped":
            return status.reason === "Not set up." ? "Sync not set up" : `Sync stopped: ${status.reason}`;
    }
}
