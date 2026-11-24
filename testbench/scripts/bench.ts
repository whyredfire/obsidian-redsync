// Shared helpers for driving the two test devices.
import { execFileSync } from "node:child_process";
import { chromium, type Page } from "playwright-core";

export const SERVER = "http://127.0.0.1:8080";
export const SERVER_FROM_DEVICES = "http://server:8080";
export const B_CONTAINER = "redsync-testbench-obsidian-b-1";
export const SYNC_NETWORK = "redsync-testbench_sync";

export const compose = (...args: string[]) => execFileSync("docker", ["compose", ...args], { encoding: "utf8" });
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const setOnline = (online: boolean) =>
    execFileSync("docker", ["network", online ? "connect" : "disconnect", SYNC_NETWORK, B_CONTAINER], { stdio: "pipe" });

export async function device(port: number): Promise<Page> {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("index.html"));
    if (!page) throw new Error(`no vault window on port ${port}`);
    return page;
}

/** Runs `body` in Obsidian with `app` and the plug-in in scope. */
export function run<T>(page: Page, body: string, arg?: unknown): Promise<T> {
    return page.evaluate(
        ([body, arg]) => {
            const app = (window as any).app;
            const plugin = app.plugins.plugins["red-sync"];
            return new Function("app", "plugin", "arg", `return (async () => { ${body} })()`)(app, plugin, arg);
        },
        [body, arg] as const,
    );
}

/** What a device shows for `path`: the editor's text when open, else the file; null when missing. */
export const read = (page: Page, path: string) =>
    run<string | null>(
        page,
        `
        const file = app.vault.getFileByPath(arg);
        if (!file) return null;
        for (const leaf of app.workspace.getLeavesOfType("markdown")) if (leaf.view.file?.path === arg) return leaf.view.editor.getValue();
        // Synchronisation may delete it at this very moment.
        return app.vault.read(file).catch(() => null);`,
        path,
    );

/** Every text file of a device with its content, as the user sees it. */
export const snapshot = (page: Page) =>
    run<Record<string, string>>(
        page,
        `
        const out = {};
        const open = new Map(app.workspace.getLeavesOfType("markdown").map((leaf) => [leaf.view.file?.path, leaf.view.editor]));
        for (const file of app.vault.getFiles()) out[file.path] = open.get(file.path)?.getValue() ?? (await app.vault.read(file).catch(() => "(vanished)"));
        for (const folder of app.vault.getAllFolders()) out[folder.path + "/"] = "(folder)";
        return out;`,
    );

export async function json(method: string, path: string, body?: unknown, token?: string) {
    const response = await fetch(SERVER + path, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json();
}

/** Loads the current build on both devices, disconnects them, and empties their vaults. */
export async function resetDevices(pages: Page[]): Promise<void> {
    try {
        setOnline(true);
    } catch {
        // Already connected.
    }
    for (const page of pages) {
        await run(
            page,
            `
            // Dialogues and notices left by an earlier run would cover what this run clicks.
            document.querySelectorAll(".modal-container, .notice").forEach((element) => element.remove());
            app.saveLocalStorage("red-sync-settings", null);
            await app.plugins.disablePlugin("red-sync");
            await app.plugins.enablePlugin("red-sync");
            app.workspace.getLeavesOfType("markdown").forEach((leaf) => leaf.detach());
            for (const child of [...app.vault.getRoot().children]) await app.vault.delete(child, true);`,
        );
    }
}

/** A new user with an invite code. */
export function newInvite(): string {
    return compose("exec", "server", "redsync-server", "user", "add", `bench${Date.now()}`).match(/[0-9A-Z]{4}(-[0-9A-Z]{4}){3}/)![0];
}

/** Creates an unencrypted vault for A and joins B to it through the API. */
export async function connectThroughApi(a: Page, b: Page): Promise<void> {
    const joinedA = await json("POST", "/v1/vaults", { invite: newInvite(), name: "Bench", deviceName: "Device A", encrypted: false });
    const vault = joinedA.vault.id;
    const { code } = await json("POST", `/v1/vaults/${vault}/enrolments`, undefined, joinedA.token);
    const joinedB = await json("POST", `/v1/vaults/${vault}/devices`, { code, deviceName: "Device B" });
    await run(a, "await plugin.connect(...arg)", [SERVER_FROM_DEVICES, joinedA, "Device A"]);
    await run(b, "await plugin.connect(...arg)", [SERVER_FROM_DEVICES, joinedB, "Device B"]);
}

export const synced = (page: Page) => run<boolean>(page, `return plugin.status.state === "synced";`);
