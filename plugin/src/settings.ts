import { type App, Notice, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import { call } from "./connection";
import type RedSyncPlugin from "./main";
import { statusText } from "./main";
import type { DeviceInfo } from "./protocol/DeviceInfo";
import type { VaultInfo } from "./protocol/VaultInfo";
import { AddDeviceModal, ConfirmModal, SetupModal, TextModal } from "./setup";

const REFRESH_MS = 10_000;

function size(bytes: number): string {
    for (const [unit, value] of [["GB", 2 ** 30], ["MB", 2 ** 20], ["KB", 2 ** 10]] as const) {
        if (bytes >= value) return `${(bytes / value).toFixed(1)} ${unit}`;
    }
    return `${bytes} B`;
}

function ago(time: number | null): string {
    if (time === null) return "Never connected";
    const minutes = Math.round((Date.now() - time) / 60_000);
    if (minutes < 2) return "Last seen just now";
    if (minutes < 120) return `Last seen ${minutes} minutes ago`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `Last seen ${hours} hours ago` : `Last seen ${Math.round(hours / 24)} days ago`;
}

export class RedSyncSettingTab extends PluginSettingTab {
    private vault?: VaultInfo;
    private devices?: DeviceInfo[];
    private fetchedAt = 0;

    constructor(
        app: App,
        private readonly plugin: RedSyncPlugin,
    ) {
        super(app, plugin);
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        const plugin = this.plugin;
        const settings = plugin.deviceSettings;
        const footer = { name: `Red Sync ${plugin.manifest.version}` };
        if (!settings) {
            return [
                {
                    name: "Set up sync",
                    desc: "Start a new vault on your Red Sync server, or join one that another of your devices synchronises.",
                    action: () => new SetupModal(this.app, plugin).open(),
                },
                footer,
            ];
        }
        return [
            {
                type: "group",
                heading: "Sync",
                items: [
                    {
                        name: "Status",
                        render: (setting) => {
                            setting.setName("Status").setDesc(statusText(plugin.status));
                            void this.refresh();
                        },
                    },
                    { name: "Pause sync", desc: "Stop synchronising this device until you turn this off.", control: { type: "toggle", key: "paused" } },
                    {
                        name: "Server",
                        render: (setting) =>
                            void setting
                                .setName("Server")
                                .setDesc(`${settings.serverUrl}, vault '${settings.vaultName}'`)
                                .addButton((button) =>
                                    button
                                        .setButtonText("Disconnect this device")
                                        .setWarning()
                                        .onClick(() =>
                                            new ConfirmModal(
                                                this.app,
                                                "Disconnect this device?",
                                                "This device stops synchronising and forgets the server and passphrase. The notes in this vault stay as they are.",
                                                "Disconnect",
                                                () => void plugin.disconnect().then(() => this.update()),
                                            ).open(),
                                        ),
                                ),
                    },
                ],
            },
            {
                type: "group",
                heading: "Devices",
                items: [
                    { name: "This device's name", control: { type: "text", key: "deviceName", validate: (v: string) => (v.trim() ? undefined : "Enter a name.") } },
                    {
                        name: "Add a device",
                        desc: "Show a setup link and QR code for a phone, tablet, or computer.",
                        action: () => new AddDeviceModal(this.app, plugin).open(),
                    },
                ],
            },
            {
                type: "list",
                heading: "Your devices",
                emptyState: this.devices ? "No devices." : "Loading…",
                items: (this.devices ?? []).map((device) => ({
                    name: device.thisDevice ? `${device.name} (this device)` : device.name,
                    desc: device.thisDevice ? "Connected" : ago(device.lastSeen),
                })),
                onDelete: (index) => {
                    const device = this.devices?.[index];
                    if (!device) return;
                    if (device.thisDevice) return new Notice("To remove this device, select 'Disconnect this device'.");
                    new ConfirmModal(
                        this.app,
                        `Disconnect ${device.name}?`,
                        "It stops synchronising at once and needs a new setup link to join again. Its notes stay on it.",
                        "Disconnect",
                        () => void plugin.revokeDevice(device.id).then(() => this.refresh(true)),
                    ).open();
                },
            },
            {
                type: "group",
                heading: "Encryption",
                items: [
                    {
                        name: "End-to-end encryption",
                        desc: settings.encrypted
                            ? "On. The server stores only what it cannot read."
                            : "Off. It was chosen when the vault was created; to encrypt, start a new vault.",
                    },
                    {
                        name: "Passphrase",
                        desc: "Every new device needs it.",
                        visible: settings.encrypted,
                        render: (setting) =>
                            void setting
                                .setName("Passphrase")
                                .setDesc("Every new device needs it.")
                                .addButton((button) =>
                                    button.setButtonText("Show").onClick(() => new TextModal(this.app, "Passphrase", plugin.passphrase() ?? "").open()),
                                ),
                    },
                ],
            },
            {
                type: "group",
                heading: "Storage",
                items: [
                    {
                        name: "Used on the server",
                        desc: this.vault ? `${size(this.vault.usedBytes)} of ${size(this.vault.quotaBytes)}, history included` : "Loading…",
                    },
                ],
            },
            {
                type: "group",
                heading: "Notifications",
                items: [
                    {
                        name: "Silence notifications",
                        desc: "Show no pop-up messages from Red Sync on this device. Everything is still recorded in the log.",
                        control: { type: "toggle", key: "silenced" },
                    },
                ],
            },
            {
                type: "group",
                heading: "Troubleshooting",
                items: [
                    {
                        name: "Check everything again",
                        desc: "Compare every file with the server and fix any difference.",
                        action: () => {
                            plugin.engine?.checkAll();
                            new Notice("Red Sync: checking every file.");
                        },
                    },
                    { name: "Show log", action: () => new TextModal(this.app, "Red Sync log", plugin.logLines.join("\n") || "Nothing yet.").open() },
                    {
                        name: "Copy debug report",
                        desc: "Status, settings (no secrets), and the recent log, to share when asking for help.",
                        action: async () => {
                            await navigator.clipboard.writeText(plugin.debugReport());
                            new Notice("Red Sync: debug report copied.");
                        },
                    },
                ],
            },
            footer,
        ];
    }

    getControlValue(key: string): unknown {
        return (this.plugin.deviceSettings as Record<string, unknown> | null)?.[key];
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        const plugin = this.plugin;
        if (key === "deviceName") {
            await plugin.renameDevice(String(value).trim());
            return;
        }
        plugin.saveDeviceSettings({ [key]: value });
        if (key === "paused") await plugin.startSync();
    }

    /** Storage and devices come from the server; fetched when the page is drawn, at most every few seconds. */
    private async refresh(force = false): Promise<void> {
        const settings = this.plugin.deviceSettings;
        const token = this.plugin.token();
        if (!settings || !token || (!force && Date.now() - this.fetchedAt < REFRESH_MS)) return;
        this.fetchedAt = Date.now();
        try {
            const base = `/vaults/${settings.vaultId}`;
            [this.vault, this.devices] = await Promise.all([
                call<VaultInfo>(settings.serverUrl, "GET", base, { token }),
                call<DeviceInfo[]>(settings.serverUrl, "GET", `${base}/devices`, { token }),
            ]);
            this.update();
        } catch (error) {
            this.plugin.log(`Could not load the settings from the server: ${String(error)}`);
        }
    }
}
