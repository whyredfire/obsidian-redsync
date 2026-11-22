import { MarkdownView, normalizePath, type App, type Editor, type EditorChange, type TAbstractFile, TFile, TFolder } from "obsidian";
import DiffMatchPatch from "diff-match-patch";
import type { Codec, Meta } from "./codec";
import { type Account, Server, Socket } from "./connection";
import { conflictedCopyPath, isText, merge3, toData, toText } from "./merge";
import type { Change } from "./protocol/Change";
import type { CommitResult } from "./protocol/CommitResult";
import type { LocalState } from "./state";

/** A local change is uploaded once typing pauses this long… */
const IDLE_MS = 1000;
/** …or after this long of continuous typing. */
const MAX_DELAY_MS = 3000;

export type Status =
    | { state: "synced" | "syncing" | "offline"; pending: number }
    | { state: "stopped"; reason: string };

interface Local {
    data: ArrayBuffer;
    /** The file on disk, which lags the editor while typing. */
    mtime: number;
    size: number;
}

/** The version a path should end up at, as told by the server. */
interface Remote {
    version: number;
    blobId: string | null;
    meta: string;
}

export interface EngineHooks {
    log(message: string): void;
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
                        if (this.state.cursor.epoch === null) {
                            this.enqueue(() => this.reconcile());
                        } else {
                            this.epoch = message.epoch;
                            this.flush();
                        }
                        break;
                    case "changes":
                        this.enqueue(() => this.applyChanges(message.items));
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
        this.enqueue(() => this.scan());
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
                this.flush();
            },
            Math.max(0, Math.min(IDLE_MS, first + MAX_DELAY_MS - now)),
        );
        this.debounced.set(path, { first, timer });
        this.report();
    }

    /** Queues every waiting path, if connected. */
    private flush(): void {
        if (!this.socket.connected || this.state.cursor.epoch === null) return;
        const paths = [...this.waiting];
        this.waiting.clear();
        for (const path of paths) {
            this.enqueue(async () => {
                try {
                    await this.upload(path);
                } catch (error) {
                    this.waiting.add(path);
                    throw error;
                }
            });
        }
    }

    private enqueue(task: () => Promise<void>): void {
        this.running++;
        this.report();
        this.queue = this.queue
            .then(task)
            .catch((error: unknown) => this.hooks.log(`Synchronisation step failed: ${String(error)}`))
            .finally(() => {
                this.running--;
                this.report();
            });
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

    private async upload(path: string): Promise<void> {
        const entry = this.state.get(path);
        const local = await this.readLocal(path);
        let blobId: string | null = null;
        if (local) {
            blobId = await this.codec.blobId(local.data);
            if (entry?.blobId === blobId) {
                if (entry.mtime !== local.mtime || entry.size !== local.size) await this.remember(path, entry.version, blobId);
                return;
            }
            if (!(await this.server.hasBlob(blobId))) await this.server.putBlob(blobId, await this.codec.encodeBlob(local.data));
        } else if (!entry || entry.blobId === null) {
            return;
        }
        const meta = await this.codec.encodeMeta({ path, mtime: local?.mtime ?? Date.now(), size: local?.data.byteLength ?? 0 });
        const [result] = await this.socket.commit([
            { pathId: await this.codec.pathId(path), baseVersion: entry?.version ?? 0, blobId, meta },
        ]);
        await this.handleResult(path, entry?.blobId ?? null, local, blobId, result);
    }

    private async handleResult(path: string, baseBlob: string | null, local: Local | null, blobId: string | null, result: CommitResult) {
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
        for (const change of changes) {
            if (change.seq <= this.state.cursor.seq) continue;
            if (change.deviceId !== this.account.deviceId) await this.applyChange(change);
            await this.state.setCursor({ epoch: this.epoch, seq: change.seq });
        }
    }

    private async applyChange(change: Change): Promise<void> {
        const path = await this.pathOf(change.meta);
        const entry = this.state.get(path);
        const local = await this.readLocal(path);
        const localId = local ? await this.codec.blobId(local.data) : null;
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
        await this.writeLocal(path, data, meta.mtime);
        await this.remember(path, remote.version, remote.blobId);
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

    private async download(blobId: string): Promise<ArrayBuffer> {
        return this.codec.decodeBlob(await this.server.getBlob(blobId));
    }

    /**
     * Applies the changes from `base` to `theirs` onto the text as it is right now (the open editor, or the file
     * on disk), with no await between reading and writing so no keystroke is lost. Null when they cannot be combined.
     */
    private async mergeText(path: string, base: string, theirs: string): Promise<string | null> {
        const editor = this.editorFor(path);
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
