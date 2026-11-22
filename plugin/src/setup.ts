import { type App, Modal, Notice, Platform, Setting } from "obsidian";
import qrcode from "qrcode-generator";
import { call } from "./connection";
import { encryptedCodec, newVaultKeys, WrongPassphrase } from "./crypto";
import type RedSyncPlugin from "./main";
import type { Enrolment } from "./protocol/Enrolment";
import type { Joined } from "./protocol/Joined";

export interface SetupLink {
    server: string;
    vault: string;
    code: string;
}

export function setupLink({ server, vault, code }: SetupLink): string {
    return `obsidian://red-sync?${new URLSearchParams({ server, vault, code })}`;
}

export function parseSetupLink(text: string): SetupLink | null {
    try {
        const url = new URL(text.trim());
        const [server, vault, code] = ["server", "vault", "code"].map((key) => url.searchParams.get(key));
        return server && vault && code ? { server, vault, code } : null;
    } catch {
        return null;
    }
}

function defaultDeviceName(): string {
    if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
    if (Platform.isAndroidApp) return Platform.isTablet ? "Android tablet" : "Android phone";
    if (Platform.isMacOS) return "Mac";
    if (Platform.isWin) return "Windows computer";
    return "Linux computer";
}

function passwordField(setting: Setting, onChange: (value: string) => void): Setting {
    return setting.addText((text) => {
        text.inputEl.type = "password";
        text.onChange(onChange);
    });
}

/** Connects this vault: a new vault with an invite code, or an existing one with a setup link. */
export class SetupModal extends Modal {
    private message!: HTMLElement;
    /** Kept after a join, so a mistyped passphrase does not need a new setup link. */
    private joined?: { server: string; joined: Joined };

    constructor(
        app: App,
        private readonly plugin: RedSyncPlugin,
        private readonly link?: SetupLink,
    ) {
        super(app);
    }

    onOpen() {
        if (this.link) this.showJoin();
        else this.showStart();
    }

    private reset(title: string) {
        this.contentEl.empty();
        this.setTitle(title);
    }

    private showStart() {
        this.reset("Set up Red Sync");
        new Setting(this.contentEl)
            .setName("Start a new vault")
            .setDesc("Upload this vault to your server, with the invite code from the server's owner.")
            .addButton((button) => button.setButtonText("Start").setCta().onClick(() => this.showCreate()));
        new Setting(this.contentEl)
            .setName("Join a vault")
            .setDesc("Download a vault that another of your devices already synchronises, with its setup link.")
            .addButton((button) => button.setButtonText("Join").onClick(() => this.showJoin()));
    }

    private showCreate() {
        this.reset("Start a new vault");
        const form = { server: "", invite: "", name: this.app.vault.getName(), device: defaultDeviceName(), encrypt: true, passphrase: "", repeat: "" };
        new Setting(this.contentEl).setName("Server address").addText((t) => t.setPlaceholder("https://sync.example.com").onChange((v) => (form.server = v)));
        new Setting(this.contentEl).setName("Invite code").addText((t) => t.setPlaceholder("XXXX-XXXX-XXXX-XXXX").onChange((v) => (form.invite = v)));
        new Setting(this.contentEl).setName("Vault name").addText((t) => t.setValue(form.name).onChange((v) => (form.name = v)));
        new Setting(this.contentEl).setName("This device's name").addText((t) => t.setValue(form.device).onChange((v) => (form.device = v)));
        const passphrase = passwordField(new Setting(this.contentEl).setName("Passphrase"), (v) => (form.passphrase = v)).setDesc(
            "Every device needs it. Nobody, including the server's owner, can recover your notes from the server without it.",
        );
        const repeat = passwordField(new Setting(this.contentEl).setName("Repeat the passphrase"), (v) => (form.repeat = v));
        new Setting(this.contentEl)
            .setName("End-to-end encryption")
            .setDesc("Encrypt notes and file names on this device, so the server stores only what it cannot read.")
            .addToggle((toggle) =>
                toggle.setValue(true).onChange((on) => {
                    form.encrypt = on;
                    passphrase.settingEl.toggle(on);
                    repeat.settingEl.toggle(on);
                }),
            );
        // The toggle reads better above the passphrase fields it controls.
        this.contentEl.insertBefore(this.contentEl.lastElementChild!, passphrase.settingEl);
        this.message = this.contentEl.createEl("p", { cls: "mod-warning" });
        new Setting(this.contentEl).addButton((button) =>
            button
                .setButtonText("Create and upload")
                .setCta()
                .onClick(() =>
                    this.busy(button.buttonEl, "Creating…", async () => {
                        const server = checkServer(form.server);
                        if (!form.invite.trim()) throw new Error("Enter the invite code.");
                        if (form.encrypt && form.passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
                        if (form.encrypt && form.passphrase !== form.repeat) throw new Error("The passphrases do not match.");
                        const keys = form.encrypt ? await newVaultKeys(form.passphrase) : { kdfSalt: null, keyCheck: null };
                        const joined = await call<Joined>(server, "POST", "/vaults", {
                            json: { invite: form.invite, name: form.name, deviceName: form.device, encrypted: form.encrypt, ...keys },
                        });
                        await this.finish(server, joined, form.device, form.encrypt ? form.passphrase : undefined);
                    }),
                ),
        );
    }

    private showJoin() {
        this.reset("Join a vault");
        const form = { link: this.link ? setupLink(this.link) : "", device: defaultDeviceName(), passphrase: "" };
        if (!this.link) {
            new Setting(this.contentEl)
                .setName("Setup link")
                .setDesc("On a device that already synchronises, open Red Sync's settings and select 'Add a device'.")
                .addText((t) => t.setPlaceholder("obsidian://red-sync?…").onChange((v) => (form.link = v)));
        }
        new Setting(this.contentEl).setName("This device's name").addText((t) => t.setValue(form.device).onChange((v) => (form.device = v)));
        passwordField(new Setting(this.contentEl).setName("Passphrase"), (v) => (form.passphrase = v)).setDesc(
            "The vault's encryption passphrase. Leave it empty if the vault is not encrypted.",
        );
        this.message = this.contentEl.createEl("p", { cls: "mod-warning" });
        new Setting(this.contentEl).addButton((button) =>
            button
                .setButtonText("Join and download")
                .setCta()
                .onClick(() =>
                    this.busy(button.buttonEl, "Joining…", async () => {
                        if (!this.joined) {
                            const link = parseSetupLink(form.link);
                            if (!link) throw new Error("This is not a Red Sync setup link.");
                            const server = checkServer(link.server);
                            const joined = await call<Joined>(server, "POST", `/vaults/${link.vault}/devices`, {
                                json: { code: link.code, deviceName: form.device },
                            });
                            this.joined = { server, joined };
                        }
                        const { server, joined } = this.joined;
                        if (joined.vault.encrypted) await encryptedCodec(form.passphrase, joined.vault.kdfSalt!, joined.vault.keyCheck!);
                        await this.finish(server, joined, form.device, joined.vault.encrypted ? form.passphrase : undefined);
                    }),
                ),
        );
    }

    private async finish(server: string, joined: Joined, deviceName: string, passphrase?: string) {
        await this.plugin.connect(server, joined, deviceName.trim(), passphrase);
        this.close();
        new Notice("Red Sync is set up. Synchronising now.");
    }

    private async busy(button: HTMLButtonElement, label: string, work: () => Promise<void>) {
        const original = button.textContent;
        button.disabled = true;
        button.textContent = label;
        this.message.setText("");
        try {
            await work();
        } catch (error) {
            const reason = error instanceof WrongPassphrase ? error.message : error instanceof Error ? error.message : String(error);
            this.message.setText(reason);
        } finally {
            button.disabled = false;
            button.textContent = original;
        }
    }
}

function checkServer(text: string): string {
    const server = text.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^/]+/.test(server)) throw new Error("Enter the server address, starting with https://.");
    return server;
}

/** Shows a one-use setup link and its QR code for another device. */
export class AddDeviceModal extends Modal {
    constructor(
        app: App,
        private readonly plugin: RedSyncPlugin,
    ) {
        super(app);
    }

    async onOpen() {
        this.setTitle("Add a device");
        const settings = this.plugin.deviceSettings!;
        const status = this.contentEl.createEl("p", { text: "Creating a setup link…" });
        try {
            const enrolment = await call<Enrolment>(settings.serverUrl, "POST", `/vaults/${settings.vaultId}/enrolments`, {
                token: this.plugin.token() ?? undefined,
            });
            const link = setupLink({ server: settings.serverUrl, vault: settings.vaultId, code: enrolment.code });
            status.setText(
                "On the new device, scan this code with the camera, or copy the link and paste it into Red Sync's setup. It works once, for 15 minutes.",
            );
            const qr = qrcode(0, "M");
            qr.addData(link);
            qr.make();
            this.contentEl.createEl("img", { cls: "red-sync-qr", attr: { src: qr.createDataURL(5, 4), alt: "Setup QR code" } });
            this.contentEl.createEl("p", { cls: "red-sync-link", text: link });
            new Setting(this.contentEl).addButton((button) =>
                button.setButtonText("Copy link").onClick(async () => {
                    await navigator.clipboard.writeText(link);
                    button.setButtonText("Copied");
                }),
            );
        } catch (error) {
            status.setText(`No setup link could be created: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

/** A question with a destructive answer. */
export class ConfirmModal extends Modal {
    constructor(app: App, title: string, text: string, action: string, onConfirm: () => void) {
        super(app);
        this.setTitle(title);
        this.contentEl.createEl("p", { text });
        new Setting(this.contentEl)
            .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
            .addButton((button) =>
                button
                    .setButtonText(action)
                    .setWarning()
                    .onClick(() => {
                        this.close();
                        onConfirm();
                    }),
            );
    }
}

/** Read-only text with a copy button: the log, or the passphrase. */
export class TextModal extends Modal {
    constructor(app: App, title: string, text: string) {
        super(app);
        this.setTitle(title);
        this.contentEl.createEl("pre", { cls: "red-sync-text", text });
        new Setting(this.contentEl).addButton((button) =>
            button.setButtonText("Copy").onClick(async () => {
                await navigator.clipboard.writeText(text);
                button.setButtonText("Copied");
            }),
        );
    }
}
