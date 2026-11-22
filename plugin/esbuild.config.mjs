import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { copyFile, mkdir } from "node:fs/promises";

const production = process.argv[2] === "production";
await mkdir("build", { recursive: true });
// The manifest lives at the repository root, where Obsidian and BRAT look for it.
await copyFile("../manifest.json", "build/manifest.json");
await copyFile("styles.css", "build/styles.css");

const context = await esbuild.context({
    entryPoints: ["src/main.ts"],
    bundle: true,
    format: "cjs",
    target: "es2021",
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
    outfile: "build/main.js",
    sourcemap: production ? false : "inline",
    minify: production,
    logLevel: "info",
});
if (production) {
    await context.rebuild();
    await context.dispose();
} else {
    await context.watch();
}
