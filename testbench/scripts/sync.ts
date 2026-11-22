// Two devices synchronising through the server. Run after `docker compose up -d --build` and a plug-in build.
// Without options the devices are connected through the API; with --encrypted they are set up through the
// plug-in's own dialogues with end-to-end encryption, and the server is checked to hold nothing readable.
import { execFileSync } from "node:child_process";
import { chromium, type Page } from "playwright-core";

const SERVER = "http://127.0.0.1:8080";
const SERVER_FROM_DEVICES = "http://server:8080";
const LIMIT_MS = 3000;
const ENCRYPTED = process.argv.includes("--encrypted");
const PASSPHRASE = "correct horse battery staple";
let failures = 0;

const compose = (...args: string[]) => execFileSync("docker", ["compose", ...args], { encoding: "utf8" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function device(port: number): Promise<Page> {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("index.html"));
    if (!page) throw new Error(`no vault window on port ${port}`);
    return page;
}

/** Runs `body` in Obsidian with `app` and the plug-in in scope. */
function run<T>(page: Page, body: string, arg?: unknown): Promise<T> {
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
const READ = `
    const file = app.vault.getFileByPath(arg);
    if (!file) return null;
    for (const leaf of app.workspace.getLeavesOfType("markdown")) if (leaf.view.file?.path === arg) return leaf.view.editor.getValue();
    return app.vault.read(file);`;
const read = (page: Page, path: string) => run<string | null>(page, READ, path);

async function waitUntil(what: string, check: () => Promise<boolean>, limitMs: number): Promise<number> {
    const start = Date.now();
    while (Date.now() - start < 60_000) {
        if (await check()) {
            const took = Date.now() - start;
            const ok = took <= limitMs;
            if (!ok) failures++;
            console.log(`${ok ? "PASS" : "SLOW"} ${what} (${(took / 1000).toFixed(1)} s)`);
            return took;
        }
        await sleep(100);
    }
    failures++;
    console.log(`FAIL ${what} (not within 60 s)`);
    return -1;
}

async function json(method: string, path: string, body?: unknown, token?: string) {
    const response = await fetch(SERVER + path, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json();
}

const a = await device(9223);
const b = await device(9224);

// Fresh start: load the new build, disconnect, and empty both vaults.
for (const page of [a, b]) {
    await run(page, `
        app.saveLocalStorage("red-sync-settings", null);
        await app.plugins.disablePlugin("red-sync");
        await app.plugins.enablePlugin("red-sync");
        app.workspace.getLeavesOfType("markdown").forEach((leaf) => leaf.detach());
        for (const child of [...app.vault.getRoot().children]) await app.vault.delete(child, true);`);
}

// A new user on the server; device A creates a vault, device B joins it.
const user = `bench${Date.now()}`;
const invite = compose("exec", "server", "redsync-server", "user", "add", user).match(/[0-9A-Z]{4}(-[0-9A-Z]{4}){3}/)![0];
if (ENCRYPTED) {
    await setUpThroughDialogues();
} else {
    const joinedA = await json("POST", "/v1/vaults", { invite, name: "Bench", deviceName: "Device A", encrypted: false });
    const vault = joinedA.vault.id;
    const { code } = await json("POST", `/v1/vaults/${vault}/enrolments`, undefined, joinedA.token);
    const joinedB = await json("POST", `/v1/vaults/${vault}/devices`, { code, deviceName: "Device B" });
    await run(a, "await plugin.connect(...arg)", [SERVER_FROM_DEVICES, joinedA, "Device A"]);
    await run(b, "await plugin.connect(...arg)", [SERVER_FROM_DEVICES, joinedB, "Device B"]);
}

async function setUpThroughDialogues() {
    const field = (page: Page, name: string) => page.locator(`.modal .setting-item:has(.setting-item-name:text-is("${name}")) input`);
    const button = (page: Page, text: string) => page.locator(".modal button", { hasText: new RegExp(`^${text}$`) });
    await run(a, `app.commands.executeCommandById("red-sync:set-up");`);
    await button(a, "Start").click();
    await field(a, "Server address").fill(SERVER_FROM_DEVICES);
    await field(a, "Invite code").fill(invite.toLowerCase());
    await field(a, "This device's name").fill("Device A");
    await field(a, "Passphrase").fill(PASSPHRASE);
    await field(a, "Repeat the passphrase").fill(PASSPHRASE);
    await button(a, "Create and upload").click();
    await a.locator(".modal").waitFor({ state: "detached" });

    await run(a, `app.commands.executeCommandById("red-sync:add-device");`);
    const link = (await a.locator(".modal .red-sync-link").textContent())!;
    await a.screenshot({ path: "out/m3-add-device.png" });
    await a.keyboard.press("Escape");

    await run(b, `app.commands.executeCommandById("red-sync:set-up");`);
    await button(b, "Join").click();
    await field(b, "Setup link").fill(link);
    await field(b, "This device's name").fill("Device B");
    await field(b, "Passphrase").fill("not the passphrase");
    await button(b, "Join and download").click();
    const warning = b.locator(".modal .mod-warning", { hasText: "The passphrase is wrong." });
    await warning.waitFor({ timeout: 10_000 });
    console.log("PASS a wrong passphrase is refused, and the setup link still works");
    await field(b, "Passphrase").fill(PASSPHRASE);
    await button(b, "Join and download").click();
    await b.locator(".modal").waitFor({ state: "detached", timeout: 10_000 });
}
const synced = (page: Page) => run<boolean>(page, `return plugin.status.state === "synced";`);
await waitUntil("both devices connect", async () => (await synced(a)) && (await synced(b)), 10_000);

// Files.
await run(a, `await app.vault.createFolder("Notes"); await app.vault.create("Notes/hello.md", "Hello from A");`);
await waitUntil("a new note reaches B", async () => (await read(b, "Notes/hello.md")) === "Hello from A", LIMIT_MS);
await run(a, `await app.vault.modify(app.vault.getFileByPath("Notes/hello.md"), "Hello again from A");`);
await waitUntil("an edit reaches B", async () => (await read(b, "Notes/hello.md")) === "Hello again from A", LIMIT_MS);
await run(b, `await app.fileManager.renameFile(app.vault.getFileByPath("Notes/hello.md"), "Notes/renamed.md");`);
await waitUntil(
    "a rename on B reaches A",
    async () => (await read(a, "Notes/renamed.md")) === "Hello again from A" && (await read(a, "Notes/hello.md")) === null,
    LIMIT_MS,
);
await run(a, `await app.fileManager.trashFile(app.vault.getFileByPath("Notes/renamed.md"));`);
await waitUntil("a deletion reaches B", async () => (await read(b, "Notes/renamed.md")) === null, LIMIT_MS);
await run(a, `await app.vault.createBinary("image.bin", new Uint8Array(arg).buffer);`, Array.from({ length: 300_000 }, (_, i) => (i * 7) % 256));
const SIZE = `const f = app.vault.getFileByPath("image.bin"); return f ? (await app.vault.readBinary(f)).byteLength : 0;`;
await waitUntil("a 300 kB binary reaches B", async () => (await run<number>(b, SIZE)) === 300_000, LIMIT_MS);

// The same note open on both devices.
const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join("\n");
await run(a, `await app.vault.create("Live.md", arg);`, lines);
await waitUntil("the shared note reaches B", async () => (await read(b, "Live.md")) === lines, LIMIT_MS);
const OPEN = `const leaf = app.workspace.getLeaf(true); await leaf.openFile(app.vault.getFileByPath("Live.md")); window.liveEditor = leaf.view.editor;`;
await run(a, OPEN);
await run(b, OPEN + ` window.liveEditor.setCursor({ line: 5, ch: 3 });`);
await run(a, `window.liveEditor.replaceRange("Added by A\\n", { line: 0, ch: 0 });`);
await waitUntil("typing on A appears in B's open editor", async () => (await read(b, "Live.md"))?.startsWith("Added by A\n") ?? false, LIMIT_MS);
const cursor = await run<{ line: number; ch: number }>(b, "return window.liveEditor.getCursor();");
const cursorStayed = cursor.line === 6 && cursor.ch === 3;
if (!cursorStayed) failures++;
console.log(`${cursorStayed ? "PASS" : "FAIL"} B's cursor moved with its text (line ${cursor.line}, ch ${cursor.ch}; expected 6, 3)`);

const TYPE = `
    for (const ch of arg.text) {
        const line = window.liveEditor.getLine(arg.line);
        window.liveEditor.replaceRange(ch, { line: arg.line, ch: line.length });
        await new Promise((r) => setTimeout(r, 60));
    }`;
await Promise.all([run(a, TYPE, { line: 1, text: " typed on A" }), run(b, TYPE, { line: 8, text: " typed on B" })]);
const converged = async () => {
    const [ta, tb] = [await read(a, "Live.md"), await read(b, "Live.md")];
    return ta === tb && !!ta?.includes("Line 1 typed on A") && !!ta?.includes("Line 8 typed on B");
};
await waitUntil("typing on both at once converges with both edits", converged, 5000);

// Offline: B loses the server, both keep working, B catches up when it returns.
compose("exec", "-T", "server", "redsync-server", "user", "list"); // keeps the server warm
execFileSync("docker", ["network", "disconnect", "redsync-testbench_sync", "redsync-testbench-obsidian-b-1"]);
await run(a, `await app.vault.create("from-a-while-b-offline.md", "A");`);
await run(b, `await app.vault.create("from-b-while-offline.md", "B");`);
await sleep(3000);
execFileSync("docker", ["network", "connect", "redsync-testbench_sync", "redsync-testbench-obsidian-b-1"]);
await waitUntil(
    "after B reconnects, each has the other's offline work",
    async () => (await read(b, "from-a-while-b-offline.md")) === "A" && (await read(a, "from-b-while-offline.md")) === "B",
    40_000,
);

if (ENCRYPTED) {
    // What the server stores: no names, no content.
    const settings = await run<{ vaultId: string }>(a, "return plugin.deviceSettings;");
    const token = await run<string>(a, "return plugin.token();");
    const listing = await json("GET", `/v1/vaults/${settings.vaultId}/files`, undefined, token);
    const blob = await (await fetch(`${SERVER}/v1/vaults/${settings.vaultId}/blobs/${listing.files.find((f: any) => f.blobId).blobId}`, {
        headers: { authorization: `Bearer ${token}` },
    })).text();
    const leaked = JSON.stringify(listing).match(/Live|\.md|Notes|Line|offline/) ?? blob.match(/Line|Hello|typed/);
    if (leaked) failures++;
    console.log(`${leaked ? "FAIL" : "PASS"} the server holds no file names, metadata, or content in readable form${leaked ? ` (found "${leaked[0]}")` : ""}`);

    // Revoking B from A: B stops at once and receives nothing more.
    const deviceB = await run<string>(b, "return plugin.deviceSettings.deviceId;");
    await run(a, "await plugin.revokeDevice(arg);", deviceB);
    await waitUntil("a revoked device stops and forgets the server", async () => (await run(b, "return plugin.deviceSettings;")) === null, LIMIT_MS);
    await run(a, `await app.vault.create("after-revoke.md", "secret");`);
    await sleep(3000);
    const reached = (await read(b, "after-revoke.md")) !== null;
    if (reached) failures++;
    console.log(`${reached ? "FAIL" : "PASS"} nothing reaches the revoked device`);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
