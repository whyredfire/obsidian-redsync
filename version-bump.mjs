import { readFileSync, writeFileSync } from "node:fs";

// Set the release version in manifest.json, versions.json, and plugin/package.json.
// Usage: node version-bump.mjs 2.0.0
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    console.error("Version must look like 2.0.0");
    process.exit(1);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value, indent) => writeFileSync(path, JSON.stringify(value, null, indent) + "\n");

const manifest = readJson("manifest.json");
manifest.version = version;
writeJson("manifest.json", manifest, 4);

// Obsidian reads versions.json to find the newest release an older app version can install.
const versions = readJson("versions.json");
versions[version] ??= manifest.minAppVersion;
writeJson("versions.json", versions, 4);

const pkg = readJson("plugin/package.json");
pkg.version = version;
writeJson("plugin/package.json", pkg, 2);
