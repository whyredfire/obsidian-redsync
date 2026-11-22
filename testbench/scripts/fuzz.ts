// Random use of both devices at once: edits, typing in open notes, renames, deletions, and device B dropping off
// the network. Then both vaults must end up identical. With --safe there are no renames or deletions, and every
// line ever written must survive somewhere (in its note or a conflicted copy).
//
//   node scripts/fuzz.ts [--seed 42] [--steps 150] [--safe]
import type { Page } from "playwright-core";
import { connectThroughApi, device, resetDevices, run, setOnline, sleep, snapshot, synced } from "./bench.ts";

const option = (name: string, fallback: number) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const seed = option("seed", Math.floor(Math.random() * 1e9));
const steps = option("steps", 150);
const safe = process.argv.includes("--safe");

// Mulberry32: small, seeded, good enough to choose operations.
let state = seed >>> 0;
const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];

const NAMES = ["Inbox.md", "Ideas.md", "Journal/Monday.md", "Journal/Tuesday.md", "Projects/Plan.md", "Projects/Notes.md", "Todo.md"];

const CREATE_OR_APPEND = `
    const file = app.vault.getFileByPath(arg.path);
    if (!file) {
        const folder = arg.path.includes("/") ? arg.path.slice(0, arg.path.lastIndexOf("/")) : "";
        if (folder && !app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
        await app.vault.create(arg.path, arg.token + "\\n");
        return;
    }
    const open = app.workspace.getLeavesOfType("markdown").find((leaf) => leaf.view.file?.path === arg.path);
    if (!open) return app.vault.process(file, (text) => text + (text && !text.endsWith("\\n") ? "\\n" : "") + arg.token + "\\n");
    const editor = open.view.editor;
    const last = editor.lastLine();
    editor.replaceRange((editor.getLine(last) ? "\\n" : "") + arg.token + "\\n", { line: last, ch: editor.getLine(last).length });`;

// Like a person: open the note, put the cursor at the end of a line, start a new line, and type a key at a time.
const TYPE = `
    const file = app.vault.getFileByPath(arg.path);
    if (!file) return false;
    let leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === arg.path);
    if (!leaf) { leaf = app.workspace.getLeaf(false); await leaf.openFile(file); }
    const editor = leaf.view.editor;
    const line = Math.min(Math.floor(Math.random() * (editor.lineCount() + 1)), editor.lastLine());
    editor.setCursor({ line, ch: editor.getLine(line).length });
    editor.replaceSelection("\\n");
    for (const ch of arg.token) {
        editor.replaceSelection(ch);
        await new Promise((r) => setTimeout(r, 30));
    }
    return true;`;

const RENAME = `
    const file = app.vault.getFileByPath(arg.path);
    if (!file || app.vault.getAbstractFileByPath(arg.to)) return;
    const folder = arg.to.includes("/") ? arg.to.slice(0, arg.to.lastIndexOf("/")) : "";
    if (folder && !app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
    await app.fileManager.renameFile(file, arg.to);`;

const DELETE = `const file = app.vault.getFileByPath(arg); if (file) await app.fileManager.trashFile(file);`;

const a = await device(9223);
const b = await device(9224);
const devices: [string, Page][] = [["A", a], ["B", b]];
const written = new Set<string>();
let offline = false;

console.log(`seed ${seed}, ${steps} steps${safe ? ", safe mode" : ""}`);
await resetDevices([a, b]);
await connectThroughApi(a, b);
for (let i = 0; i < 50 && !((await synced(a)) && (await synced(b))); i++) await sleep(200);

const counts: Record<string, number> = {};
for (let step = 0; step < steps; step++) {
    const [name, page] = pick(devices);
    const token = `t${step}${name}`;
    const op = pick(safe ? ["append", "append", "type", "create"] : ["append", "append", "type", "create", "rename", "delete", "network"]);
    counts[op] = (counts[op] ?? 0) + 1;
    const path = pick(NAMES);
    try {
        if (op === "create" || op === "append") {
            written.add(token);
            await run(page, CREATE_OR_APPEND, { path, token });
        } else if (op === "type") {
            if (await run<boolean>(page, TYPE, { path, token })) written.add(token);
        } else if (op === "rename") {
            await run(page, RENAME, { path, to: pick(NAMES) });
        } else if (op === "delete") {
            await run(page, DELETE, path);
        } else {
            offline = !offline;
            setOnline(!offline);
        }
    } catch (error) {
        console.log(`step ${step} (${name} ${op} ${path}) failed in the test itself: ${String(error).split("\n")[0]}`);
    }
    await sleep(random() * 400);
}
if (offline) setOnline(true);
console.log(`operations: ${JSON.stringify(counts)}`);

// Wait until both are quiet and identical.
const start = Date.now();
let same = false;
let left: Record<string, string> = {};
let right: Record<string, string> = {};
while (Date.now() - start < 120_000) {
    await sleep(1000);
    if (!((await synced(a)) && (await synced(b)))) continue;
    [left, right] = [await snapshot(a), await snapshot(b)];
    same = JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());
    if (same) break;
}
const copies = Object.keys(left).filter((path) => path.includes("Conflicted copy")).length;
let failed = !same;
if (same) {
    console.log(`PASS both vaults identical after ${((Date.now() - start) / 1000).toFixed(1)} s: ${Object.keys(left).length} files, ${copies} conflicted copies`);
} else {
    console.log("FAIL the vaults differ:");
    for (const path of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (left[path] !== right[path]) console.log(`  ${path}\n    A: ${JSON.stringify(left[path])}\n    B: ${JSON.stringify(right[path])}`);
    }
}
if (safe) {
    const everything = Object.values(left).join("\n");
    const lost = [...written].filter((token) => !new RegExp(`(^|\\n)${token}(\\n|$)`).test(everything));
    if (lost.length) failed = true;
    for (const token of lost.slice(0, 8)) {
        const at = everything.indexOf(token);
        const loose = everything.match(new RegExp(token.split("").join("[^]{0,40}?")));
        console.log(`  ${token}: ${at >= 0 ? `whole but joined: ${JSON.stringify(everything.slice(Math.max(0, at - 12), at + token.length + 12))}` : loose ? `split: ${JSON.stringify(loose[0])}` : "missing"}`);
    }
    console.log(`${lost.length ? "FAIL" : "PASS"} ${written.size - lost.length} of ${written.size} written lines survive whole${lost.length ? `; lost or split: ${lost.join(", ")}` : ""}`);
}
console.log(`${failed ? "FAILED" : "passed"} (seed ${seed})`);
process.exit(failed ? 1 : 0);
