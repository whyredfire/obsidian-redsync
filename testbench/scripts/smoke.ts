// Enables Red Sync on both test devices and saves a screenshot of its settings page to out/.
import { chromium, type Browser, type Page } from "playwright-core";
import { DEVTOOLS } from "./bench.ts";

let failed = false;

for (const [name, port] of Object.entries(DEVTOOLS)) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts().flatMap((context) => context.pages()).find((p) => p.url().includes("index.html"));
    if (!page) throw new Error(`device ${name}: no vault window open`);

    // First start of a vault with plug-ins: Obsidian asks whether to trust its author.
    const trust = page.getByRole("button", { name: "Trust author and enable plugins" });
    if (await trust.isVisible()) await trust.click();

    const loaded = await page.evaluate(async () => {
        const plugins = (window as any).app.plugins;
        if (!plugins.isEnabled()) await plugins.setEnable(true);
        await plugins.enablePluginAndSave("red-sync");
        const app = (window as any).app;
        app.setting.open();
        app.setting.openTabById("red-sync");
        return Boolean(plugins.plugins["red-sync"]);
    });
    // Obsidian opens Settings in a window of its own.
    const settings = await findSettingsWindow(browser);
    await settings.getByText("Set up sync").waitFor();
    await settings.screenshot({ path: `out/${name}.png` });
    console.log(`device ${name}: Red Sync ${loaded ? "loaded" : "NOT loaded"}`);
    failed ||= !loaded;
}
process.exit(failed ? 1 : 0);

async function findSettingsWindow(browser: Browser): Promise<Page> {
    for (let attempt = 0; attempt < 20; attempt++) {
        for (const page of browser.contexts().flatMap((context) => context.pages())) {
            if ((await page.title()).startsWith("Settings")) return page;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("the Settings window did not open");
}
