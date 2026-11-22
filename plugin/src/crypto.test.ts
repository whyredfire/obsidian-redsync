import { describe, expect, it } from "vitest";
import { encryptedCodec, newVaultKeys, openFromLink, sealForLink, WrongPassphrase } from "./crypto";

describe("setup link sealing", () => {
    it("opens with the link's key only", async () => {
        const { key, sealed } = await sealForLink("correct horse");
        expect(sealed).not.toContain("horse");
        expect(await openFromLink(key, sealed)).toBe("correct horse");
        const other = await sealForLink("x");
        await expect(openFromLink(other.key, sealed)).rejects.toThrow();
    });
});

describe("encrypted codec", async () => {
    const { kdfSalt, keyCheck } = await newVaultKeys("correct horse battery staple");
    const codec = await encryptedCodec("correct horse battery staple", kdfSalt, keyCheck);
    const note = new TextEncoder().encode("Dear diary").buffer as ArrayBuffer;

    it("round-trips content and metadata without revealing them", async () => {
        const sealed = await codec.encodeBlob(note);
        expect(new TextDecoder().decode(sealed)).not.toContain("diary");
        expect(new TextDecoder().decode(await codec.decodeBlob(sealed))).toBe("Dear diary");
        const meta = { path: "Private/Diary.md", mtime: 1, size: 10 };
        const encoded = await codec.encodeMeta(meta);
        expect(encoded).not.toContain("Diary");
        expect(await codec.decodeMeta(encoded)).toEqual(meta);
    });

    it("gives stable IDs that the server can store and cannot read", async () => {
        const pathId = await codec.pathId("Private/Diary.md");
        expect(pathId).toBe(await codec.pathId("Private/Diary.md"));
        expect(pathId).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(await codec.blobId(note)).toBe(await codec.blobId(note.slice(0)));
        expect(await codec.blobId(note)).not.toBe(await codec.pathId("Dear diary"));
    });

    it("refuses a wrong passphrase", async () => {
        await expect(encryptedCodec("wrong", kdfSalt, keyCheck)).rejects.toBeInstanceOf(WrongPassphrase);
    });

    it("lets another device with the same passphrase read everything", async () => {
        const other = await encryptedCodec("correct horse battery staple", kdfSalt, keyCheck);
        expect(new TextDecoder().decode(await other.decodeBlob(await codec.encodeBlob(note)))).toBe("Dear diary");
        expect(await other.pathId("a.md")).toBe(await codec.pathId("a.md"));
    });
});
