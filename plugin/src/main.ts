import { Notice, Plugin, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import { plainCodec } from "./codec";
import type { Account } from "./connection";
import { type Status, SyncEngine } from "./engine";
import { LocalState } from "./state";

/** Device-local settings, kept in Obsidian's per-vault local storage rather than in the vault. */
interface Settings {
    serverUrl: string;
    vaultId: string;
    deviceId: string;
    silenced?: boolean;
}

const SETTINGS_KEY = "red-sync-settings";
const LOG_LINES = 500;

export default class RedSyncPlugin extends Plugin {
    engine?: SyncEngine;
    status: Status = { state: "stopped", reason: "Not set up." };
    readonly logLines: string[] = [];
    private statusEl!: HTMLElement;

    async onload() {
        this.statusEl = this.addStatusBarItem();
        this.addSettingTab(new RedSyncSettingTab(this.app, this));
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

    get deviceSettings(): Settings | null {
        return (this.app.loadLocalStorage(SETTINGS_KEY) as Settings | null) ?? null;
    }

    private tokenSecret(vaultId: string): string {
        return `red-sync-${vaultId}-token`;
    }

    /** Connects this vault to a server vault; called by setup (and by the test bench). */
    async connect(serverUrl: string, vaultId: string, deviceId: string, token: string): Promise<void> {
        this.app.secretStorage.setSecret(this.tokenSecret(vaultId), token);
        this.app.saveLocalStorage(SETTINGS_KEY, { ...this.deviceSettings, serverUrl, vaultId, deviceId });
        await this.startSync();
    }

    async startSync(): Promise<void> {
        this.engine?.stop();
        this.engine = undefined;
        const settings = this.deviceSettings;
        const token = settings && this.app.secretStorage.getSecret(this.tokenSecret(settings.vaultId));
        if (!settings || !token) {
            this.setStatus({ state: "stopped", reason: "Not set up." });
            return;
        }
        const account: Account = { serverUrl: settings.serverUrl, vaultId: settings.vaultId, deviceId: settings.deviceId, token };
        const state = await LocalState.open(`red-sync-${settings.vaultId}`);
        this.engine = new SyncEngine(this.app, account, state, plainCodec, {
            log: (message) => this.log(message),
            notice: (message) => {
                this.log(message);
                if (!this.deviceSettings?.silenced) new Notice(message);
            },
            status: (status) => this.setStatus(status),
        });
        this.engine.start();
    }

    log(message: string): void {
        const line = `${new Date().toISOString()} ${message}`;
        this.logLines.push(line);
        if (this.logLines.length > LOG_LINES) this.logLines.shift();
        console.debug(`[Red Sync] ${message}`);
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
            return "Sync stopped";
    }
}

class RedSyncSettingTab extends PluginSettingTab {
    constructor(
        app: RedSyncPlugin["app"],
        private readonly plugin: RedSyncPlugin,
    ) {
        super(app, plugin);
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            {
                name: "Status",
                desc: this.plugin.status.state === "stopped" ? this.plugin.status.reason : statusText(this.plugin.status),
            },
            {
                name: "Set up sync",
                desc: "Connect this vault to a Red Sync server.",
                action: () => new Notice("Setup is not available yet."),
            },
        ];
    }
}
