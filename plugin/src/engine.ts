import { MarkdownView, normalizePath, type App, type Editor, type EditorChange, type TAbstractFile, TFile, TFolder } from "obsidian";
import DiffMatchPatch from "diff-match-patch";
import type { Codec, Meta } from "./codec";
import { type Account, Server, Socket } from "./connection";
import { conflictedCopyPath, isText, merge3, toData, toText } from "./merge";
import type { Change } from "./protocol/Change";
import type { CommitOp } from "./protocol/CommitOp";
import type { CommitResult } from "./protocol/CommitResult";
import type { LocalState } from "./state";

/** A local change is uploaded once typing pauses this long… */
const IDLE_MS = 1000;
/** …or after this long of continuous typing. */
const MAX_DELAY_MS = 3000;
/** Paths per commit, and uploads at once, so a first sync of thousands of files is not one round trip per file. */
const BATCH = 50;
const PARALLEL_UPLOADS = 6;

export type Status =
    | { state: "synced" | "syncing" | "offline"; pending: number }
    | { state: "stopped"; reason: string };

interface Local {
    data: ArrayBuffer;
    /** The file on disk, which lags the editor while typing. */
    mtime: number;
    size: number;
}

/** A local change ready to commit. */
interface Prepared {
    path: string;
    baseBlob: string | null;
    local: Local | null;
    blobId: string | null;
    op: CommitOp;
}

/** The version a path should end up at, as told by the server. */
interface Remote {
    version: number;
    blobId: string | null;
    meta: string;
}

export interface EngineHooks {
    log(message: string): void;
    /** Every change and upload; recorded only with 'Detailed log' on. */
    debug(message: string): void;
    notice(message: string): void;
    status(status: Status): void;
    /** The server refused this device: revoked, or its owner removed. */
    revoked(): void;
}

export class SyncEngine {
    private readonly server: Server;
    private readonly socket: Socket;
    private queue: Promise<void> = Promise.resolve();
    private running = 0;
    /** Local changes waiting for typing to pause. */
    private debounced = new Map<string, { first: number; timer: number }>();
    /** Paths to upload when connected. */
    private waiting = new Set<string>();
    private epoch: string | null;
    /** On macOS, Windows, and most phones, "Note.md" and "note.md" are the same file. */
    private caseInsensitive = false;
    private flushTimer?: number;
    /** When each open note was last typed in. */
    private lastTyped = new Map<string, number>();
    /** Changes received and not yet applied. */
    private incoming: Change[] = [];
    /** Downloads started ahead of applying a batch of changes. */
    private prefetched = new Map<string, Promise<ArrayBuffer>>();

    constructor(
        private readonly app: App,
        private readonly account: Account,
        private readonly state: LocalState,
        private readonly codec: Codec,
        private readonly hooks: EngineHooks,
    ) {
        this.server = new Server(account);
        this.epoch = state.cursor.epoch;
        this.socket = new Socket(account, () => this.state.cursor, {
            message: (message) => {
                switch (message.type) {
                    case "welcome":
                        // The server resends everything after the cursor: drop what an earlier connection left.
                        this.incoming.length = 0;
                        if (this.state.cursor.epoch === null) {
                            this.enqueue(() => this.reconcile());
                        } else {
                            this.epoch = message.epoch;
                            this.flush();
                        }
                        break;
                    case "changes":
                        // Changes arrive one message per commit; collect them so a burst is applied as one batch.
                        if (this.incoming.length === 0) this.enqueue(() => this.applyChanges(this.incoming.splice(0)));
                        this.incoming.push(...message.items);
                        break;
                    case "reset":
                        this.hooks.log("The server's history changed; comparing every file with it.");
                        this.enqueue(() => this.reconcile());
                        break;
                }
                this.report();
            },
            closed: (code) => {
                if (code === 4001 || code === 4003) {
                    this.hooks.revoked();
                } else {
                    this.report();
                }
            },
        });
    }

    start(): void {
        this.enqueue(async () => {
            this.caseInsensitive = await this.detectCaseInsensitive();
            await this.scan();
        });
        this.socket.start();
        this.report();
    }

    stop(): void {
        this.socket.stop();
        for (const { timer } of this.debounced.values()) window.clearTimeout(timer);
        this.debounced.clear();
        this.state.close();
    }

    /** Compares every file with the server, from the settings page. */
    checkAll(): void {
        this.enqueue(() => this.reconcile());
    }

    /** When the network returns or the app comes to the foreground: reconnect now instead of after the back-off. */
    wake(): void {
        if (!this.socket.connected) this.socket.restart();
    }

    // Local changes.

    onLocalChange(file: TAbstractFile, oldPath?: string): void {
        if (file instanceof TFile) {
            if (oldPath) this.touch(oldPath);
            this.touch(file.path);
        } else if (file instanceof TFolder) {
            // A folder was renamed or deleted: everything under its old and new paths.
            for (const folder of [oldPath ?? file.path, file.path]) {
                for (const path of this.state.files.keys()) if (path.startsWith(`${folder}/`)) this.touch(path);
            }
            for (const child of this.app.vault.getFiles()) if (child.path.startsWith(`${file.path}/`)) this.touch(child.path);
        }
    }

    onEditorChange(path: string): void {
        this.lastTyped.set(path, Date.now());
        this.touch(path);
    }

    private touch(path: string): void {
        const now = Date.now();
        const previous = this.debounced.get(path);
        window.clearTimeout(previous?.timer);
        const first = previous?.first ?? now;
        const timer = window.setTimeout(
            () => {
                this.debounced.delete(path);
                this.waiting.add(path);
                this.scheduleFlush();
            },
            Math.max(0, Math.min(IDLE_MS, first + MAX_DELAY_MS - now)),
        );
        this.debounced.set(path, { first, timer });
        this.report();
    }

    /** Many timers fire together after a burst of changes; one flush shortly after collects them into batches. */
    private scheduleFlush(): void {
        if (this.flushTimer !== undefined) return;
        this.flushTimer = window.setTimeout(() => {
            this.flushTimer = undefined;
            this.flush();
        }, 50);
    }

    /** Queues every waiting path, if connected. */
    private flush(): void {
        if (!this.socket.connected || this.state.cursor.epoch === null) return;
        const paths = [...this.waiting];
        this.waiting.clear();
        for (let i = 0; i < paths.length; i += BATCH) {
            const batch = paths.slice(i, i + BATCH);
            this.enqueue(async () => {
                try {
                    await this.uploadBatch(batch);
                } catch (error) {
                    for (const path of batch) this.waiting.add(path);
                    throw error;
                }
            });
        }
    }

    private enqueue(task: () => Promise<void>): void {
        this.running++;
        this.report();
        const previous = this.queue;
        this.queue = (async () => {
            await previous;
            try {
                await task();
            } catch (error) {
                this.hooks.log(`Synchronisation step failed: ${String(error)}`);
            } finally {
                this.running--;
                this.report();
            }
        })();
    }

    private report(): void {
        const pending = this.running + this.waiting.size + this.debounced.size;
        if (!this.socket.connected) this.hooks.status({ state: "offline", pending });
        else this.hooks.status({ state: pending > 0 ? "syncing" : "synced", pending });
    }

    /** Finds files changed while Obsidian was closed. */
    private async scan(): Promise<void> {
        for (const file of this.app.vault.getFiles()) {
            const entry = this.state.get(file.path);
            if (!entry || entry.blobId === null || entry.mtime !== file.stat.mtime || entry.size !== file.stat.size) {
                this.waiting.add(file.path);
            }
        }
        for (const [path, entry] of this.state.files) {
            if (entry.blobId !== null && !this.app.vault.getFileByPath(path)) this.waiting.add(path);
        }
        this.flush();
    }

    /**
     * Commits the paths together; contents the server reports missing are uploaded and committed again. Asking
     * first (HEAD) would save nothing, and Obsidian's HTTP client on Android fails on bodiless answers.
     */
    private async uploadBatch(paths: string[]): Promise<void> {
        const prepared = (await inParallel(paths, PARALLEL_UPLOADS, (path) => this.prepare(path))).filter((p): p is Prepared => p !== null);
        if (prepared.length === 0) return;
        const results = await this.socket.commit(prepared.map((p) => p.op));
        const missing = prepared.filter((_, i) => results[i].status === "missingBlob");
        if (missing.length > 0) {
            await inParallel(missing, PARALLEL_UPLOADS, async (p) => this.server.putBlob(p.blobId!, await this.codec.encodeBlob(p.local!.data)));
            const retried = await this.socket.commit(missing.map((p) => p.op));
            missing.forEach((p, i) => (results[prepared.indexOf(p)] = retried[i]));
        }
        for (const [i, p] of prepared.entries()) await this.handleResult(p.path, p.baseBlob, p.local, p.blobId, results[i]);
    }

    /** The commit for a changed path; null when the path matches the last sync. */
    private async prepare(path: string): Promise<Prepared | null> {
        const entry = this.state.get(path);
        const local = await this.readLocal(path);
        let blobId: string | null = null;
        if (local) {
            blobId = await this.codec.blobId(local.data);
            if (entry?.blobId === blobId) {
                if (entry.mtime !== local.mtime || entry.size !== local.size) await this.remember(path, entry.version, blobId);
                return null;
            }
        } else if (!entry || entry.blobId === null) {
            return null;
        }
        const meta = await this.codec.encodeMeta({ path, mtime: local?.mtime ?? Date.now(), size: local?.data.byteLength ?? 0 });
        const op = { pathId: await this.codec.pathId(path), baseVersion: entry?.version ?? 0, blobId, meta };
        return { path, baseBlob: entry?.blobId ?? null, local, blobId, op };
    }

    private async handleResult(path: string, baseBlob: string | null, local: Local | null, blobId: string | null, result: CommitResult) {
        this.hooks.debug(`Commit ${path} (${short(blobId)} on ${short(baseBlob)}): ${result.status}${"version" in result ? ` version ${result.version}` : ""}.`);
        switch (result.status) {
            case "ok":
                await this.remember(path, result.version, blobId);
                break;
            case "missingBlob":
                this.waiting.add(path);
                break;
            case "conflict":
                await this.resolve(path, baseBlob, local, result);
                break;
        }
    }

    // Remote changes.

    private async applyChanges(changes: Change[]): Promise<void> {
        const todo = changes.filter((change) => change.seq > this.state.cursor.seq && change.deviceId !== this.account.deviceId);
        // Start downloads ahead; most are needed, and a few extra are harmless.
        void inParallel(todo, PARALLEL_UPLOADS, async (change) => {
            if (change.blobId) await this.download(change.blobId).catch(() => undefined);
        });
        let applied = this.state.cursor.seq;
        try {
            for (const change of changes) {
                if (change.seq <= applied) continue;
                if (change.seq !== applied + 1) {
                    // A change is missing (an earlier one failed): have the server send everything after the cursor again.
                    this.socket.restart();
                    return;
                }
                if (change.deviceId !== this.account.deviceId) await this.applyChange(change);
                applied = change.seq;
            }
        } catch (error) {
            this.socket.restart();
            throw error;
        } finally {
            this.prefetched.clear();
            // Saved once per batch: re-applying a change after a crash finds the file already up to date.
            if (applied > this.state.cursor.seq) await this.state.setCursor({ epoch: this.epoch, seq: applied });
        }
    }

    private async applyChange(change: Change): Promise<void> {
        const path = await this.pathOf(change.meta);
        const entry = this.state.get(path);
        // Already past this version (learnt from a conflict answer or the listing): replaying it would undo newer changes.
        if (entry && change.version <= entry.version) return;
        const local = await this.readLocal(path);
        const localId = local ? await this.codec.blobId(local.data) : null;
        this.hooks.debug(`Change ${change.seq}: ${path} version ${change.version} (${short(change.blobId)}); here version ${entry?.version} (${short(entry?.blobId)}), file ${short(localId)}.`);
        if (localId === change.blobId) {
            await this.remember(path, change.version, change.blobId);
        } else if ((entry?.blobId ?? null) === localId) {
            await this.takeRemote(path, change, local);
        } else {
            await this.resolve(path, entry?.blobId ?? null, local, change);
        }
    }

    /** Makes the file what the server says; `local` (what is on this device) is unchanged since the last sync. */
    private async takeRemote(path: string, remote: Remote, local: Local | null): Promise<void> {
        if (remote.blobId === null) {
            const file = this.app.vault.getFileByPath(path);
            if (file) {
                await this.app.fileManager.trashFile(file);
                // The system trash can fail silently (some network or container file systems): use Obsidian's own.
                if (this.app.vault.getFileByPath(path)) await this.app.vault.trash(file, false);
            }
            await this.remember(path, remote.version, null);
            return;
        }
        const data = await this.download(remote.blobId);
        const meta = await this.codec.decodeMeta(remote.meta);
        if (local && isText(path)) {
            // Typing may have continued while downloading: merge rather than overwrite.
            const merged = await this.mergeText(path, toText(local.data), toText(data));
            if (merged === null) return this.keepBoth(path, local, data, meta.mtime, remote);
            await this.remember(path, remote.version, remote.blobId);
            if (merged !== toText(data)) this.waiting.add(path);
            return;
        }
        if (!local && this.caseClash(path)) return;
        await this.writeLocal(path, data, meta.mtime);
        await this.remember(path, remote.version, remote.blobId);
    }

    /**
     * Writing "note.md" where "Note.md" exists would overwrite it on a case-insensitive file system. This device
     * then keeps only the first; the other stays on the server and on devices that can hold both.
     */
    private caseClash(path: string): boolean {
        if (!this.caseInsensitive) return false;
        const lower = path.toLowerCase();
        const clash = this.app.vault.getFiles().find((file) => file.path !== path && file.path.toLowerCase() === lower);
        if (!clash) return false;
        this.hooks.notice(`Red Sync: ${path} and ${clash.path} differ only in capital letters, which this device cannot keep apart. Rename one of them on another device.`);
        return true;
    }

    private async detectCaseInsensitive(): Promise<boolean> {
        const adapter = this.app.vault.adapter;
        const probe = `${this.app.vault.configDir}/red-sync-case-probe`;
        try {
            await adapter.write(probe, "");
            return await adapter.exists(`${this.app.vault.configDir}/RED-SYNC-CASE-PROBE`, false);
        } catch {
            return false;
        } finally {
            await adapter.remove(probe).catch(() => undefined);
        }
    }

    /**
     * Both sides changed the path since `baseBlob`. Edits beat deletions; text merges; otherwise the newer
     * version stays at the path and the other is saved next to it as a conflicted copy.
     */
    private async resolve(path: string, baseBlob: string | null, local: Local | null, remote: Remote): Promise<void> {
        if (remote.blobId === null || !local) {
            if (local) {
                // Deleted elsewhere, edited here: upload the edit on top of the deletion.
                await this.remember(path, remote.version, null);
                this.waiting.add(path);
            } else {
                await this.takeRemote(path, remote, null);
            }
            return;
        }
        const theirs = await this.download(remote.blobId);
        const theirsMeta = await this.codec.decodeMeta(remote.meta);
        if (isText(path) && baseBlob !== null) {
            const merged = await this.mergeText(path, toText(await this.download(baseBlob)), toText(theirs));
            if (merged !== null) {
                await this.remember(path, remote.version, remote.blobId);
                if (merged !== toText(theirs)) this.waiting.add(path);
                this.hooks.log(`Merged changes to ${path} from another device.`);
                return;
            }
        }
        await this.keepBoth(path, local, theirs, theirsMeta.mtime, remote);
    }

    /** The newer version stays at the path; the older is saved next to it as a conflicted copy. */
    private async keepBoth(path: string, local: Local, theirs: ArrayBuffer, theirsMtime: number, remote: Remote): Promise<void> {
        const mine = (await this.readLocal(path))?.data ?? local.data;
        const mineIsNewer = local.mtime >= theirsMtime;
        const [older, olderMtime] = mineIsNewer ? [theirs, theirsMtime] : [mine, local.mtime];
        const copy = conflictedCopyPath(path, olderMtime, (p) => this.app.vault.getAbstractFileByPath(p) !== null);
        await this.writeLocal(copy, older, olderMtime);
        if (!mineIsNewer) await this.writeLocal(path, theirs, theirsMtime);
        await this.remember(path, remote.version, remote.blobId);
        if (mineIsNewer) this.waiting.add(path);
        this.waiting.add(copy);
        this.hooks.notice(`Red Sync: ${path} was changed on two devices. The other version is saved as ${copy}.`);
    }

    /** Compares every file with the server's listing; after a new device joins or the server lost history. */
    private async reconcile(): Promise<void> {
        const listing = await this.server.listing();
        const seen = new Set<string>();
        for (const file of listing.files) {
            const path = await this.pathOf(file.meta);
            seen.add(path);
            const entry = this.state.get(path);
            const local = await this.readLocal(path);
            const localId = local ? await this.codec.blobId(local.data) : null;
            if (localId === file.blobId) {
                await this.remember(path, file.version, file.blobId);
            } else if (entry && entry.version > file.version) {
                // The server went back in time (restored from a snapshot): this device has the newer version; upload it.
                await this.remember(path, file.version, file.blobId);
                this.waiting.add(path);
            } else if (!local && entry?.blobId && entry.blobId === file.blobId) {
                // Deleted here while the server was behind.
                await this.remember(path, file.version, entry.blobId);
                this.waiting.add(path);
            } else if (!local || (entry !== undefined && entry.blobId === localId)) {
                await this.takeRemote(path, file, local);
            } else {
                await this.resolve(path, entry?.blobId ?? null, local, file);
            }
        }
        // What the server does not know: upload it as new.
        for (const file of this.app.vault.getFiles()) {
            if (seen.has(file.path)) continue;
            if (this.state.get(file.path)) await this.state.remove(file.path);
            this.waiting.add(file.path);
        }
        for (const path of [...this.state.files.keys()]) {
            if (!seen.has(path) && !this.app.vault.getFileByPath(path)) await this.state.remove(path);
        }
        this.epoch = listing.epoch;
        await this.state.setCursor({ epoch: listing.epoch, seq: listing.headSeq });
        // Reconnect from the listing's position, so changes made meanwhile arrive in order.
        this.socket.restart();
    }

    // The vault and the editor.

    private async pathOf(meta: string): Promise<string> {
        const decoded: Meta = await this.codec.decodeMeta(meta);
        return normalizePath(decoded.path.normalize("NFC"));
    }

    private download(blobId: string): Promise<ArrayBuffer> {
        let pending = this.prefetched.get(blobId);
        if (!pending) {
            pending = (async () => this.codec.decodeBlob(await this.server.getBlob(blobId)))();
            this.prefetched.set(blobId, pending);
            // Only kept while a batch of changes is applied.
            if (this.prefetched.size > 1000) this.prefetched.clear();
        }
        return pending;
    }

    /**
     * Applies the changes from `base` to `theirs` onto the text as it is right now (the open editor, or the file
     * on disk), with no await between reading and writing so no keystroke is lost. Null when they cannot be combined.
     */
    private async mergeText(path: string, base: string, theirs: string): Promise<string | null> {
        let editor = this.editorFor(path);
        if (editor) {
            // Merging into a word being typed can split it; wait for a pause (but not forever).
            const start = Date.now();
            while (Date.now() - (this.lastTyped.get(path) ?? 0) < IDLE_MS && Date.now() - start < 5000) await sleep(100);
            editor = this.editorFor(path);
        }
        if (editor) {
            const merged = merge3(base, editor.getValue(), theirs);
            if (merged !== null) applyToEditor(editor, merged);
            return merged;
        }
        const file = this.app.vault.getFileByPath(path);
        if (!file) {
            await this.writeLocal(path, toData(theirs));
            return theirs;
        }
        let merged = null as string | null;
        await this.app.vault.process(file, (current) => (merged = merge3(base, current, theirs)) ?? current);
        return merged;
    }

    private async remember(path: string, version: number, blobId: string | null): Promise<void> {
        const stat = this.app.vault.getFileByPath(path)?.stat;
        await this.state.set(path, { version, blobId, mtime: stat?.mtime ?? 0, size: stat?.size ?? 0 });
    }

    private editorFor(path: string): Editor | null {
        if (!isText(path)) return null;
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) return leaf.view.editor;
        }
        return null;
    }

    /** The file as the user sees it: the editor's text when it is open, which may not be saved yet. */
    private async readLocal(path: string): Promise<Local | null> {
        const file = this.app.vault.getFileByPath(path);
        if (!file) return null;
        const editor = this.editorFor(path);
        const data = editor ? toData(editor.getValue()) : await this.app.vault.readBinary(file);
        return { data, mtime: file.stat.mtime, size: file.stat.size };
    }

    /** Writes a file; an open note is changed in its editor instead, so the cursor and undo history stay. */
    private async writeLocal(path: string, data: ArrayBuffer, mtime?: number): Promise<void> {
        const editor = this.editorFor(path);
        if (editor) {
            applyToEditor(editor, toText(data));
            return;
        }
        const options = mtime ? { mtime } : undefined;
        const file = this.app.vault.getFileByPath(path);
        if (file) {
            await this.app.vault.modifyBinary(file, data, options);
            return;
        }
        const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (folder && !this.app.vault.getFolderByPath(folder)) await this.app.vault.createFolder(folder);
        await this.app.vault.createBinary(path, data, options);
    }
}

/** Turns the editor's text into `next` with the smallest edits, so the cursor moves with the text around it. */
export function applyToEditor(editor: Editor, next: string): void {
    const current = editor.getValue();
    if (current === next) return;
    const dmp = new DiffMatchPatch();
    const diffs = dmp.diff_main(current, next);
    dmp.diff_cleanupEfficiency(diffs);
    const changes: EditorChange[] = [];
    let offset = 0;
    for (const [operation, text] of diffs) {
        if (operation === DiffMatchPatch.DIFF_EQUAL) {
            offset += text.length;
        } else if (operation === DiffMatchPatch.DIFF_DELETE) {
            changes.push({ from: editor.offsetToPos(offset), to: editor.offsetToPos(offset + text.length), text: "" });
            offset += text.length;
        } else {
            changes.push({ from: editor.offsetToPos(offset), text });
        }
    }
    editor.transaction({ changes });
}

/** Maps `items` through `work`, at most `limit` at a time, keeping their order. */
async function inParallel<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await work(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const short = (id: string | null | undefined) => (id === undefined ? "none" : id === null ? "deleted" : id.slice(0, 8));
