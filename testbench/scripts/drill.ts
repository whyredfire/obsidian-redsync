// Restore drill: the server loses its database and cache, is rebuilt from the last snapshot, and the devices
// put back what the snapshot missed.
import { execFileSync } from "node:child_process";
import { compose, connectThroughApi, device, DEVTOOLS, read, resetDevices, run, SERVER, sleep, snapshot, synced } from "./bench.ts";

const a = await device(DEVTOOLS.a);
const b = await device(DEVTOOLS.b);
let failures = 0;
const check = (ok: boolean, what: string) => {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
};
const quiet = async () => {
    for (let i = 0; i < 300; i++) {
        if ((await synced(a)) && (await synced(b))) return true;
        await sleep(200);
    }
    return false;
};

await resetDevices([a, b]);
await connectThroughApi(a, b);
await quiet();
await run(a, `for (let i = 1; i <= 5; i++) await app.vault.create(\`Before \${i}.md\`, \`Written before the snapshot (\${i}).\`);`);
for (let i = 0; i < 100 && (await read(b, "Before 5.md")) === null; i++) await sleep(100);
console.log(compose("exec", "server", "redsync-server", "snapshot").trim());

// Changes the snapshot does not have.
await run(a, `await app.vault.create("After.md", "Written after the snapshot.");`);
await run(b, `await app.vault.modify(app.vault.getFileByPath("Before 1.md"), "Edited on B after the snapshot.");`);
await run(a, `await app.fileManager.trashFile(app.vault.getFileByPath("Before 2.md"));`);
await sleep(1500);
await quiet();

// Lose the database and the cache; R2 (a folder in this volume on the test bench) survives.
compose("stop", "server");
execFileSync("docker", ["run", "--rm", "-v", "redsync-testbench_server:/data", "alpine", "sh", "-c", "rm -rf /data/redsync.db* /data/blobs /data/tmp"]);
console.log(compose("run", "--rm", "server", "restore").trim());
compose("start", "server");
const started = Date.now();

// The devices reconnect, see a new epoch, compare everything, and upload what is missing.
await sleep(2000);
let same = false;
for (let i = 0; i < 90 && !same; i++) {
    await sleep(1000);
    if (!((await synced(a)) && (await synced(b)))) continue;
    same = JSON.stringify(Object.entries(await snapshot(a)).sort()) === JSON.stringify(Object.entries(await snapshot(b)).sort());
}
check(same, `both devices agree after the restore (${((Date.now() - started) / 1000).toFixed(1)} s)`);
check((await read(b, "After.md")) === "Written after the snapshot.", "the note written after the snapshot is back on the server and on B");
check((await read(a, "Before 1.md")) === "Edited on B after the snapshot.", "the edit made after the snapshot reached A");
const settings = await run<{ vaultId: string }>(a, "return plugin.deviceSettings;");
const token = await run<string>(a, "return plugin.token();");
const listing = await (await fetch(`${SERVER}/v1/vaults/${settings.vaultId}/files`, { headers: { authorization: `Bearer ${token}` } })).json();
check((await read(b, "Before 2.md")) === null, "the note deleted after the snapshot stays deleted");
check(listing.files.filter((f: { blobId: string | null }) => f.blobId).length === 5, "the server lists the five remaining notes");
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
