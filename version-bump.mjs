import { readFileSync, writeFileSync } from "node:fs";

// Set the release version in manifest.json, versions.json, and the chart's appVersion.
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

// appVersion picks the server image tag; the chart's own version changes only when the chart does.
const chart = readFileSync("chart/Chart.yaml", "utf8").replace(/^appVersion: .*$/m, `appVersion: "${version}"`);
writeFileSync("chart/Chart.yaml", chart);
