import { type App, Modal, Notice, Setting } from "obsidian";
import { call } from "./connection";
import type RedSyncPlugin from "./main";
import { isText, toText } from "./merge";
import type { DeviceInfo } from "./protocol/DeviceInfo";
import type { VersionEntry } from "./protocol/VersionEntry";
import { TextModal } from "./setup";

/** The server's versions of one file, to look at or put back. */
export class HistoryModal extends Modal {
    constructor(
        app: App,
        private readonly plugin: RedSyncPlugin,
        private readonly path: string,
    ) {
        super(app);
        this.setTitle(`History of ${path.slice(path.lastIndexOf("/") + 1)}`);
    }

    async onOpen(): Promise<void> {
        const status = this.contentEl.createEl("p", { text: "Loading…" });
        try {
            const [versions, devices] = await Promise.all([this.plugin.engine!.versions(this.path), this.devices()]);
            status.setText(versions.length ? "Changes from the last 30 days, newest first." : "No changes in the last 30 days.");
            versions.forEach((version, i) => this.show(version, i === 0, devices));
        } catch (error) {
            status.setText(`The history cannot be loaded: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private show(version: VersionEntry, current: boolean, devices: Map<string, string>): void {
        const settings = this.plugin.deviceSettings!;
        const from = version.deviceId === settings.deviceId ? "this device" : (devices.get(version.deviceId) ?? "a removed device");
        const what = version.blobId === null ? "Deleted" : current ? "Current version" : "Saved";
        const setting = new Setting(this.contentEl).setName(new Date(version.createdAt).toLocaleString()).setDesc(`${what}, from ${from}`);
        const blobId = version.blobId;
        if (blobId === null) return;
        if (isText(this.path)) {
            setting.addButton((button) =>
                button.setButtonText("Show").onClick(() =>
                    this.attempt(async () => {
                        const text = toText(await this.plugin.engine!.versionData(blobId));
                        new TextModal(this.app, setting.nameEl.getText(), text).open();
                    }),
                ),
            );
        }
        if (current) return;
        setting.addButton((button) =>
            button.setButtonText("Restore").onClick(() =>
                this.attempt(async () => {
                    await this.plugin.engine!.restore(this.path, await this.plugin.engine!.versionData(blobId));
                    new Notice(`Red Sync: restored ${this.path} as it was on ${setting.nameEl.getText()}.`);
                    this.close();
                }),
            ),
        );
    }

    private async attempt(action: () => Promise<void>): Promise<void> {
        try {
            await action();
        } catch (error) {
            new Notice(`Red Sync: this version cannot be loaded: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** Device names by ID; the history only records IDs. */
    private async devices(): Promise<Map<string, string>> {
        const settings = this.plugin.deviceSettings!;
        const list = await call<DeviceInfo[]>(settings.serverUrl, "GET", `/vaults/${settings.vaultId}/devices`, { token: this.plugin.token()! });
        return new Map(list.map((device) => [device.id, device.name]));
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
