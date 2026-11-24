// Two devices synchronising through the server. Run after `docker compose up -d --build` and a plug-in build.
// Without options the devices are connected through the API; with --encrypted they are set up through the
// plug-in's own dialogues with end-to-end encryption, and the server is checked to hold nothing readable.
import { execFileSync } from "node:child_process";
import type { Page } from "playwright-core";
import { compose, connectThroughApi, device, DEVTOOLS, json, newInvite, read, resetDevices, run, SERVER, SERVER_FROM_DEVICES, sleep, synced } from "./bench.ts";

const LIMIT_MS = 3000;
const ENCRYPTED = process.argv.includes("--encrypted");
const PASSPHRASE = "correct horse battery staple";
let failures = 0;

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

const a = await device(DEVTOOLS.a);
const b = await device(DEVTOOLS.b);

// Fresh start: load the new build, disconnect, and empty both vaults.
await resetDevices([a, b]);

// A new user on the server; device A creates a vault, device B joins it.
const invite = newInvite();
let lastLink = "";
if (ENCRYPTED) {
    await setUpThroughDialogues();
} else {
    await connectThroughApi(a, b);
}

async function setUpThroughDialogues() {
    const field = (page: Page, name: string) => page.locator(`.modal .setting-item:has(.setting-item-name:text-is("${name}")) input`);
    const button = (page: Page, text: string) => page.locator(".modal button", { hasText: new RegExp(`^${text}$`) });
    await run(a, `app.commands.executeCommandById("red-sync:set-up");`);
    await button(a, "Start").click();
    await field(a, "Address").fill(SERVER_FROM_DEVICES);
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

    // As if the QR code was scanned: nothing to type, the passphrase comes with the link.
    await run(b, "plugin.openLink(Object.fromEntries(new URL(arg).searchParams));", link);
    await b.locator(".modal").waitFor({ state: "detached", timeout: 15_000 });
    const joinedB = (await run(b, "return plugin.deviceSettings?.encrypted === true && plugin.passphrase() === arg;", PASSPHRASE)) as boolean;
    if (!joinedB) failures++;
    console.log(`${joinedB ? "PASS" : "FAIL"} opening the setup link joins device B with the passphrase, nothing typed`);
    lastLink = link;
}
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

// A file over the server's limit (2 MB on the test bench) stays on A, once, without blocking the rest.
await run(a, `await app.vault.createBinary("big.bin", new ArrayBuffer(3_000_000)); await app.vault.create("after-big.md", "x");`);
await waitUntil("a note saved with a file that is too large still reaches B", async () => (await read(b, "after-big.md")) === "x", LIMIT_MS);
await run(a, "plugin.engine.checkAll();");
await sleep(LIMIT_MS);
const refusals = await run<number>(a, `return plugin.logLines.filter((line) => line.includes("big.bin is larger than the server accepts")).length;`);
const bigOk = refusals === 1 && (await read(b, "big.bin")) === null && (await run<boolean>(a, `return plugin.status.state === "synced";`));
if (!bigOk) failures++;
console.log(`${bigOk ? "PASS" : "FAIL"} a file over the limit is refused once and stays on A (${refusals} refusal(s))`);

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

// A file the server has lost is skipped on B, and the changes after it still arrive.
const entryOnA = (path: string) => run<string | null>(a, "return plugin.engine.state.get(arg)?.blobId ?? null;", path);
execFileSync("docker", ["network", "disconnect", "redsync-testbench_sync", "redsync-testbench-obsidian-b-1"]);
await run(a, `await app.vault.create("Lost.md", "lost on the server");`);
await waitUntil("A uploads a note the server will lose", async () => (await entryOnA("Lost.md")) !== null, LIMIT_MS);
await run(a, `await app.vault.create("After lost.md", "x");`);
await waitUntil("A uploads a note after it", async () => (await entryOnA("After lost.md")) !== null, LIMIT_MS);
const vaultId = await run<string>(a, "return plugin.deviceSettings.vaultId;");
const lost = (await entryOnA("Lost.md"))!;
await sleep(1000);
execFileSync("docker", ["run", "--rm", "-v", "redsync-testbench_server:/data", "alpine", "rm", "-f", `/data/blobs/${vaultId}/${lost.slice(0, 2)}/${lost}`, `/data/r2/vaults/${vaultId}/blobs/${lost}`]);
execFileSync("docker", ["network", "connect", "redsync-testbench_sync", "redsync-testbench-obsidian-b-1"]);
await waitUntil("a note after a lost one still reaches B", async () => (await read(b, "After lost.md")) === "x", 40_000);
const skipped = await run<boolean>(b, `return plugin.logLines.some((line) => line.includes("Lost.md cannot be downloaded"));`);
if (!skipped) failures++;
console.log(`${skipped ? "PASS" : "FAIL"} B skips the lost note with a notice`);

// The server thins out history while B is away, so the change log skips seqs: B still catches up.
const versionOnA = (path: string) => run<number>(a, "return plugin.engine.state.get(arg)?.version ?? 0;", path);
execFileSync("docker", ["network", "disconnect", "redsync-testbench_sync", "redsync-testbench-obsidian-b-1"]);
for (const [i, text] of ["one", "two", "three"].entries()) {
    await run(a, `const f = app.vault.getFileByPath("Thinned.md"); f ? await app.vault.modify(f, arg) : await app.vault.create("Thinned.md", arg);`, text);
    await waitUntil(`A uploads version ${i + 1} of a note`, async () => (await versionOnA("Thinned.md")) === i + 1, LIMIT_MS);
}
const thinnedPath = await run<string>(a, "return await plugin.engine.codec.pathId(arg);", "Thinned.md");
const thin = `DELETE FROM versions WHERE vault_id = '${vaultId}' AND path_id = '${thinnedPath}' AND version < 3`;
execFileSync("docker", ["run", "--rm", "-v", "redsync-testbench_server:/data", "alpine", "sh", "-c", 'apk add -q sqlite > /dev/null && sqlite3 /data/redsync.db "$0"', thin]);
execFileSync("docker", ["network", "connect", "redsync-testbench_sync", "redsync-testbench-obsidian-b-1"]);
await waitUntil("after its history was thinned, the note's last version reaches B", async () => (await read(b, "Thinned.md")) === "three", 40_000);

// Folders: an empty one, created, renamed, and deleted on A; and one deleted with a note in it.
const folderOn = (page: Page, path: string) => run<boolean>(page, "return app.vault.getFolderByPath(arg) !== null;", path);
await run(a, `await app.vault.createFolder("Empty");`);
await waitUntil("an empty folder reaches B", () => folderOn(b, "Empty"), LIMIT_MS);
await run(a, `await app.fileManager.renameFile(app.vault.getFolderByPath("Empty"), "Still empty");`);
await waitUntil("its rename reaches B", async () => (await folderOn(b, "Still empty")) && !(await folderOn(b, "Empty")), LIMIT_MS);
await run(a, `await app.fileManager.trashFile(app.vault.getFolderByPath("Still empty"));`);
await waitUntil("its deletion reaches B", async () => !(await folderOn(b, "Still empty")), LIMIT_MS);
await run(a, `await app.vault.createFolder("Outer/Inner/Innermost");`);
await waitUntil("nested empty folders reach B", () => folderOn(b, "Outer/Inner/Innermost"), LIMIT_MS);
await run(a, `await app.fileManager.trashFile(app.vault.getFolderByPath("Outer"));`);
await waitUntil("deleting the outer one removes them all on B", async () => !(await folderOn(b, "Outer")), LIMIT_MS);
await run(a, `await app.vault.createFolder("Again");`);
await waitUntil("another empty folder reaches B", () => folderOn(b, "Again"), LIMIT_MS);
await run(a, `await app.fileManager.trashFile(app.vault.getFolderByPath("Again"));`);
await waitUntil("and its deletion", async () => !(await folderOn(b, "Again")), LIMIT_MS);
await run(a, `plugin.engine.stop(); plugin.engine = undefined; await app.vault.createFolder("Again"); await plugin.startSync();`);
await waitUntil("made again while sync was off, it reaches B", () => folderOn(b, "Again"), LIMIT_MS);
await run(a, `await app.vault.createFolder("Box"); await app.vault.create("Box/inside.md", "x");`);
await waitUntil("a folder with a note reaches B", async () => (await read(b, "Box/inside.md")) === "x", LIMIT_MS);
await run(a, `await app.fileManager.trashFile(app.vault.getFolderByPath("Box"));`);
await waitUntil("deleting it removes both on B", async () => !(await folderOn(b, "Box")), LIMIT_MS);

// History: an earlier version of a note, restored from A's history view, reaches B.
await run(a, `await app.vault.create("History.md", "first");`);
await waitUntil("a note for the history reaches B", async () => (await read(b, "History.md")) === "first", LIMIT_MS);
await run(a, `await app.vault.modify(app.vault.getFileByPath("History.md"), "second");`);
await waitUntil("its edit reaches B", async () => (await read(b, "History.md")) === "second", LIMIT_MS);
await run(a, `await app.workspace.getLeaf(true).openFile(app.vault.getFileByPath("History.md")); app.commands.executeCommandById("red-sync:show-history");`);
await a.locator(".modal .setting-item").nth(1).waitFor({ timeout: 10_000 });
const rows = await a.locator(".modal .setting-item-description").allTextContents();
const listed = rows.length === 2 && rows[0].startsWith("Current version, from this device") && rows[1].startsWith("Saved, from this device");
if (!listed) failures++;
console.log(`${listed ? "PASS" : "FAIL"} the history lists both versions (${JSON.stringify(rows)})`);
await a.locator(".modal .setting-item").nth(1).locator("button", { hasText: /^Restore$/ }).click();
await waitUntil("a restored version reaches B", async () => (await read(b, "History.md")) === "first", LIMIT_MS);
await run(a, "app.workspace.getLeaf().detach();");

// Many files at once, as on a first upload.
await run(a, `await app.vault.createFolder("Bulk"); await Promise.all(Array.from({ length: 300 }, (_, i) => app.vault.create(\`Bulk/note \${i}.md\`, \`Note \${i}\`)));`);
const bulk = `return app.vault.getFiles().filter((f) => f.path.startsWith("Bulk/")).length;`;
await waitUntil("300 new files reach B", async () => (await run<number>(b, bulk)) === 300, 15_000);

// Hundreds of files missing at start-up (a vault folder not all there) are not deleted on the other devices.
await run(b, "plugin.engine.stop(); plugin.engine = undefined;");
await run(b, `for (const file of app.vault.getFiles().filter((f) => f.path.startsWith("Bulk/"))) await app.vault.delete(file);`);
await run(b, "await plugin.startSync();");
await sleep(LIMIT_MS);
const bulkOnA = await run<number>(a, bulk);
if (bulkOnA !== 300) failures++;
console.log(`${bulkOnA === 300 ? "PASS" : "FAIL"} files missing in bulk at start-up stay on A (${bulkOnA} of 300)`);
await run(b, "plugin.engine.checkAll();");
await waitUntil("'Check everything again' brings them back on B", async () => (await run<number>(b, bulk)) === 300, 15_000);

// A full quota is reported on A; once raised, the note goes through.
const userList = compose("exec", "-T", "server", "redsync-server", "user", "list");
const owner = userList.slice(0, userList.indexOf(await run<string>(a, "return plugin.deviceSettings.vaultId;"))).match(/^\S+(?=: )/gm)!.at(-1)!;
compose("exec", "-T", "server", "redsync-server", "user", "quota", owner, "1");
await run(a, `await app.vault.create("Too much.md", "over the quota");`);
await waitUntil(
    "A says storage on the server is full",
    () => run<boolean>(a, `return plugin.logLines.some((line) => line.includes("storage on the server is full"));`),
    LIMIT_MS,
);
compose("exec", "-T", "server", "redsync-server", "user", "quota", owner, "10GB");
await run(a, `await app.vault.modify(app.vault.getFileByPath("Too much.md"), "within the quota");`);
await waitUntil("with more storage, the note reaches B", async () => (await read(b, "Too much.md")) === "within the quota", LIMIT_MS);

// Device B's vault is on a case-insensitive file system, like macOS: it must not let one overwrite the other.
await run(a, `await app.vault.create("Case.md", "upper"); await app.vault.create("case.md", "lower");`);
await sleep(LIMIT_MS);
const onB = await run<string[]>(b, `return app.vault.getFiles().filter((f) => f.path.toLowerCase() === "case.md").map((f) => f.path);`);
const keptOnA = (await read(a, "Case.md")) === "upper" && (await read(a, "case.md")) === "lower";
const caseOk = keptOnA && onB.length === 1 && (await read(b, onB[0])) === (onB[0] === "Case.md" ? "upper" : "lower");
if (!caseOk) failures++;
console.log(`${caseOk ? "PASS" : "FAIL"} names differing only in case: A keeps both, B keeps one intact (B has ${JSON.stringify(onB)})`);

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

    // A link without the passphrase (as from 0.1.0): B is asked for it, and a wrong one is refused.
    await run(a, `app.commands.executeCommandById("red-sync:add-device");`);
    const withKey = (await a.locator(".modal .red-sync-link").textContent())!;
    await a.keyboard.press("Escape");
    const noKey = new URL(withKey);
    noKey.searchParams.delete("key");
    await run(b, "plugin.openLink(Object.fromEntries(new URL(arg).searchParams));", noKey.toString());
    const passphraseField = b.locator('.modal .setting-item:has(.setting-item-name:text-is("Passphrase")) input');
    await passphraseField.waitFor({ timeout: 10_000 });
    await passphraseField.fill("not the passphrase");
    await b.locator(".modal button", { hasText: /^Join and download$/ }).click();
    await b.locator(".modal .mod-warning", { hasText: "The passphrase is wrong." }).waitFor({ timeout: 10_000 });
    await passphraseField.fill(PASSPHRASE);
    await b.locator(".modal button", { hasText: /^Join and download$/ }).click();
    await b.locator(".modal").waitFor({ state: "detached", timeout: 10_000 });
    console.log("PASS without the key in the link, the passphrase is asked for and a wrong one refused");
    void lastLink;
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
