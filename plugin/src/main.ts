import { Notice, Plugin, PluginSettingTab, type SettingDefinitionItem } from "obsidian";

export default class RedSyncPlugin extends Plugin {
    async onload() {
        this.addSettingTab(new RedSyncSettingTab(this.app, this));
    }
}

class RedSyncSettingTab extends PluginSettingTab {
    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            {
                name: "Set up sync",
                desc: "Connect this vault to a Red Sync server.",
                action: () => new Notice("Setup is not available yet."),
            },
        ];
    }
}
