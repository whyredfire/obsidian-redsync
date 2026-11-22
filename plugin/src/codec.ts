/** Metadata stored with every version; encrypted along with the content when the vault is. */
export interface Meta {
    path: string;
    mtime: number;
    size: number;
}

/** How paths, content, and metadata are turned into what the server stores. */
export interface Codec {
    pathId(path: string): Promise<string>;
    blobId(data: ArrayBuffer): Promise<string>;
    encodeBlob(data: ArrayBuffer): Promise<ArrayBuffer>;
    decodeBlob(data: ArrayBuffer): Promise<ArrayBuffer>;
    encodeMeta(meta: Meta): Promise<string>;
    decodeMeta(meta: string): Promise<Meta>;
}

/** Without end-to-end encryption: paths and metadata as they are, blob IDs are SHA-256 of the content. */
export const plainCodec: Codec = {
    pathId: async (path) => path,
    blobId: async (data) => hex(await crypto.subtle.digest("SHA-256", data)),
    encodeBlob: async (data) => data,
    decodeBlob: async (data) => data,
    encodeMeta: async (meta) => JSON.stringify(meta),
    decodeMeta: async (meta) => JSON.parse(meta) as Meta,
};

export function hex(data: ArrayBuffer): string {
    return Array.from(new Uint8Array(data), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
