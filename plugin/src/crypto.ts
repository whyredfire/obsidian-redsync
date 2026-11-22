import type { Codec, Meta } from "./codec";

const ITERATIONS = 600_000;
const KEY_CHECK = "red-sync key check";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class WrongPassphrase extends Error {
    constructor() {
        super("The passphrase is wrong.");
    }
}

/** For a new encrypted vault: a random salt, and a value that tells devices whether a passphrase is right. */
export async function newVaultKeys(passphrase: string): Promise<{ kdfSalt: string; keyCheck: string }> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keys = await deriveKeys(passphrase, salt);
    return { kdfSalt: toBase64(salt), keyCheck: toBase64(await seal(keys.encrypt, encoder.encode(KEY_CHECK))) };
}

/**
 * End-to-end encryption. Path IDs and blob IDs are HMACs (the server cannot confirm guesses), content and
 * metadata are AES-256-GCM with a random nonce. Throws WrongPassphrase when `keyCheck` does not open.
 */
export async function encryptedCodec(passphrase: string, kdfSalt: string, keyCheck: string): Promise<Codec> {
    const keys = await deriveKeys(passphrase, fromBase64(kdfSalt));
    try {
        if (decoder.decode(await open(keys.encrypt, fromBase64(keyCheck))) !== KEY_CHECK) throw new WrongPassphrase();
    } catch {
        throw new WrongPassphrase();
    }
    const hmac = async (key: CryptoKey, data: BufferSource) => toBase64Url(await crypto.subtle.sign("HMAC", key, data));
    return {
        pathId: (path) => hmac(keys.path, encoder.encode(path)),
        blobId: (data) => hmac(keys.content, data),
        encodeBlob: (data) => seal(keys.encrypt, data),
        decodeBlob: (data) => open(keys.encrypt, data),
        encodeMeta: async (meta) => toBase64(await seal(keys.encrypt, encoder.encode(JSON.stringify(meta)))),
        decodeMeta: async (meta) => JSON.parse(decoder.decode(await open(keys.encrypt, fromBase64(meta)))) as Meta,
    };
}

async function deriveKeys(passphrase: string, salt: Uint8Array) {
    const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: ITERATIONS }, material, 256);
    const master = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    const derive = (info: string, algorithm: HmacKeyGenParams | AesKeyGenParams, usages: KeyUsage[]) =>
        crypto.subtle.deriveKey(
            { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(info) },
            master,
            algorithm,
            false,
            usages,
        );
    return {
        path: await derive("red-sync path", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
        content: await derive("red-sync content", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
        encrypt: await derive("red-sync encrypt", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
    };
}

/** 12-byte nonce, then the AES-GCM ciphertext and tag. */
async function seal(key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
    const out = new Uint8Array(12 + sealed.length);
    out.set(iv);
    out.set(sealed, 12);
    return out.buffer;
}

async function open(key: CryptoKey, data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
    const bytes = new Uint8Array(data);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
}

function toBase64(data: ArrayBuffer | Uint8Array): string {
    let binary = "";
    for (const byte of new Uint8Array(data)) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function toBase64Url(data: ArrayBuffer): string {
    return toBase64(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(text: string): Uint8Array {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
