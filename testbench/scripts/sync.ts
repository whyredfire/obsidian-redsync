// M2 checks: two devices synchronise through the server. Run after `docker compose up -d --build` and a plug-in build.
import { execFileSync } from "node:child_process";
import { chromium, type Page } from "playwright-core";

const SERVER = "http://127.0.0.1:8080";
const SERVER_FROM_DEVICES = "http://server:8080";
const LIMIT_MS = 3000;
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

// A new user and vault on the server; device A creates it, device B joins.
const user = `bench${Date.now()}`;
const invite = compose("exec", "server", "redsync-server", "user", "add", user).match(/[0-9A-Z]{4}(-[0-9A-Z]{4}){3}/)![0];
const joinedA = await json("POST", "/v1/vaults", { invite, name: "Bench", deviceName: "Device A", encrypted: false });
const vault = joinedA.vault.id;
const { code } = await json("POST", `/v1/vaults/${vault}/enrolments`, undefined, joinedA.token);
const joinedB = await json("POST", `/v1/vaults/${vault}/devices`, { code, deviceName: "Device B" });
for (const [page, joined] of [[a, joinedA], [b, joinedB]] as const) {
    await run(page, "await plugin.connect(...arg)", [SERVER_FROM_DEVICES, vault, joined.deviceId, joined.token]);
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

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
