/** What this device last agreed with the server, per path. */
export interface Entry {
    version: number;
    /** null: deleted. */
    blobId: string | null;
    /** The file's mtime and size on disk at that point, to skip hashing unchanged files. */
    mtime: number;
    size: number;
}

export interface Cursor {
    /** null until the first reconciliation. */
    epoch: string | null;
    seq: number;
}

/** The local sync state in IndexedDB, mirrored in memory. */
export class LocalState {
    private constructor(
        private readonly db: IDBDatabase,
        readonly files: Map<string, Entry>,
        public cursor: Cursor,
    ) {}

    static async open(name: string): Promise<LocalState> {
        const opening = indexedDB.open(name, 1);
        opening.onupgradeneeded = () => {
            opening.result.createObjectStore("files");
            opening.result.createObjectStore("meta");
        };
        const db = await done(opening);
        const read = db.transaction(["files", "meta"], "readonly");
        const [keys, values, cursor] = await Promise.all([
            done(read.objectStore("files").getAllKeys()),
            done(read.objectStore("files").getAll()),
            done(read.objectStore("meta").get("cursor")),
        ]);
        const files = new Map(keys.map((key, i) => [String(key), values[i] as Entry]));
        return new LocalState(db, files, (cursor as Cursor | undefined) ?? { epoch: null, seq: 0 });
    }

    get(path: string): Entry | undefined {
        return this.files.get(path);
    }

    async set(path: string, entry: Entry): Promise<void> {
        this.files.set(path, entry);
        await this.write("files", (store) => store.put(entry, path));
    }

    async remove(path: string): Promise<void> {
        this.files.delete(path);
        await this.write("files", (store) => store.delete(path));
    }

    async setCursor(cursor: Cursor): Promise<void> {
        this.cursor = cursor;
        await this.write("meta", (store) => store.put(cursor, "cursor"));
    }

    close(): void {
        this.db.close();
    }

    private write(store: string, action: (store: IDBObjectStore) => void): Promise<void> {
        // Relaxed: a write lost in a crash only means that file is compared with the server again.
        const tx = this.db.transaction(store, "readwrite", { durability: "relaxed" });
        action(tx.objectStore(store));
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = tx.onabort = () => reject(tx.error);
        });
    }
}

function done<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
