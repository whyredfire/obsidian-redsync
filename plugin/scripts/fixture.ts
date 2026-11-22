// Writes server/tests/fixtures/encrypted.json with the plug-in's encryption, for the server's export test.
import { writeFileSync } from "node:fs";
import { encryptedCodec, newVaultKeys } from "../src/crypto";

const passphrase = "fixture passphrase";
const { kdfSalt, keyCheck } = await newVaultKeys(passphrase);
const codec = await encryptedCodec(passphrase, kdfSalt, keyCheck);
const content = new TextEncoder().encode("Hello from the plug-in.\n").buffer as ArrayBuffer;
const sealed = new Uint8Array(await codec.encodeBlob(content));
const fixture = {
    passphrase,
    kdfSalt,
    keyCheck,
    meta: await codec.encodeMeta({ path: "Folder/Note.md", mtime: 1763700000000, size: content.byteLength }),
    blob: btoa(String.fromCharCode(...sealed)),
    blobId: await codec.blobId(content),
};
writeFileSync(new URL("../../server/tests/fixtures/encrypted.json", import.meta.url), JSON.stringify(fixture, null, 2) + "\n");
