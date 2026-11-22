import { type App, ButtonComponent, Modal, Notice, Platform, Setting, SettingGroup } from "obsidian";
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

/** Settings grouped under an optional heading, like Obsidian's own settings. */
function group(containerEl: HTMLElement, heading?: string): SettingGroup {
    const settings = new SettingGroup(containerEl);
    if (heading) settings.setHeading(heading);
    return settings;
}

/** Adds one setting to a group and returns it. */
function add(settings: SettingGroup, name: string, desc?: string): Setting {
    let added!: Setting;
    settings.addSetting((setting) => {
        added = setting.setName(name);
        if (desc) setting.setDesc(desc);
    });
    return added;
}

/** Obsidian's standard row of dialogue buttons, at the bottom right. */
function buttonBar(containerEl: HTMLElement): HTMLElement {
    return containerEl.createDiv({ cls: "modal-button-container" });
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
        const choices = group(this.contentEl);
        add(choices, "Start a new vault", "Upload this vault to your server, with the invite code from the server's owner.").addButton((button) =>
            button.setButtonText("Start").setCta().onClick(() => this.showCreate()),
        );
        add(choices, "Join a vault", "Download a vault that another of your devices already synchronises, with its setup link.").addButton(
            (button) => button.setButtonText("Join").onClick(() => this.showJoin()),
        );
    }

    private showCreate() {
        this.reset("Start a new vault");
        const form = { server: "", invite: "", name: this.app.vault.getName(), device: defaultDeviceName(), encrypt: true, passphrase: "", repeat: "" };

        const server = group(this.contentEl, "Server");
        add(server, "Address").addText((t) => t.setPlaceholder("https://sync.example.com").onChange((v) => (form.server = v)));
        add(server, "Invite code", "From the server's owner.").addText((t) => t.setPlaceholder("XXXX-XXXX-…").onChange((v) => (form.invite = v)));

        const vault = group(this.contentEl, "This vault");
        add(vault, "Vault name").addText((t) => t.setValue(form.name).onChange((v) => (form.name = v)));
        add(vault, "This device's name").addText((t) => t.setValue(form.device).onChange((v) => (form.device = v)));

        const encryption = group(this.contentEl, "Encryption");
        const toggle = add(encryption, "End-to-end encryption", "The server stores only what it cannot read.");
        const passphrase = passwordField(add(encryption, "Passphrase", "Every device needs it. Nobody can recover your notes without it."), (v) => (form.passphrase = v));
        const repeat = passwordField(add(encryption, "Repeat the passphrase"), (v) => (form.repeat = v));
        toggle.addToggle((t) =>
            t.setValue(true).onChange((on) => {
                form.encrypt = on;
                passphrase.settingEl.toggle(on);
                repeat.settingEl.toggle(on);
            }),
        );

        this.message = this.contentEl.createEl("p", { cls: "mod-warning" });
        const create = new ButtonComponent(buttonBar(this.contentEl)).setButtonText("Create and upload").setCta();
        create.onClick(() =>
            this.busy(create.buttonEl, "Creating…", async () => {
                const address = checkServer(form.server);
                if (!form.invite.trim()) throw new Error("Enter the invite code.");
                if (form.encrypt && form.passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
                if (form.encrypt && form.passphrase !== form.repeat) throw new Error("The passphrases do not match.");
                const keys = form.encrypt ? await newVaultKeys(form.passphrase) : { kdfSalt: null, keyCheck: null };
                const joined = await call<Joined>(address, "POST", "/vaults", {
                    json: { invite: form.invite, name: form.name, deviceName: form.device, encrypted: form.encrypt, ...keys },
                });
                await this.finish(address, joined, form.device, form.encrypt ? form.passphrase : undefined);
            }),
        );
    }

    private showJoin() {
        this.reset("Join a vault");
        const form = { link: this.link ? setupLink(this.link) : "", device: defaultDeviceName(), passphrase: "" };
        const fields = group(this.contentEl);
        if (!this.link) {
            add(fields, "Setup link", "On a device that already synchronises: Red Sync's settings, 'Add a device'.").addText((t) =>
                t.setPlaceholder("obsidian://red-sync?…").onChange((v) => (form.link = v)),
            );
        }
        add(fields, "This device's name").addText((t) => t.setValue(form.device).onChange((v) => (form.device = v)));
        passwordField(add(fields, "Passphrase", "Leave it empty if the vault is not encrypted."), (v) => (form.passphrase = v));

        this.message = this.contentEl.createEl("p", { cls: "mod-warning" });
        const join = new ButtonComponent(buttonBar(this.contentEl)).setButtonText("Join and download").setCta();
        join.onClick(() =>
            this.busy(join.buttonEl, "Joining…", async () => {
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
            const copy = new ButtonComponent(buttonBar(this.contentEl)).setButtonText("Copy link").setCta();
            copy.onClick(async () => {
                await navigator.clipboard.writeText(link);
                copy.setButtonText("Copied");
            });
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
        const buttons = buttonBar(this.contentEl);
        new ButtonComponent(buttons).setButtonText(action).setWarning().onClick(() => {
            this.close();
            onConfirm();
        });
        new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
    }
}

/** Read-only text with a copy button: the log, or the passphrase. */
export class TextModal extends Modal {
    constructor(app: App, title: string, text: string) {
        super(app);
        this.setTitle(title);
        this.contentEl.createEl("pre", { cls: "red-sync-text", text });
        const copy = new ButtonComponent(buttonBar(this.contentEl)).setButtonText("Copy");
        copy.onClick(async () => {
            await navigator.clipboard.writeText(text);
            copy.setButtonText("Copied");
        });
    }
}
