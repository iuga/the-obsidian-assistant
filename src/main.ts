import { Plugin, WorkspaceLeaf } from "obsidian";
import { PorygonView, PORYGON_VIEW_TYPE } from "./porygon-view";
import { PorygonPluginSettings, DEFAULT_SETTINGS, LegacyPorygonPluginSettings } from "./settings";
import { PorygonSettingTab } from "./settings-tab";

export default class PorygonPlugin extends Plugin {
	settings: PorygonPluginSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(
			PORYGON_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new PorygonView(leaf, this)
		);
		this.addSettingTab(new PorygonSettingTab(this));

		this.addRibbonIcon("origami", "Porygon", () => {
			void this.activateView();
		});
	}

	async activateView(): Promise<void> {
		const existingLeaves = this.app.workspace.getLeavesOfType(PORYGON_VIEW_TYPE);
		let leaf: WorkspaceLeaf | null = existingLeaves[0] ?? null;

		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false);
		}

		if (!leaf) {
			return;
		}

		await leaf.setViewState({ type: PORYGON_VIEW_TYPE, active: true });
		this.app.workspace.rightSplit.expand();
	}

	async loadSettings(): Promise<void> {
		const savedSettings = await this.loadData() as LegacyPorygonPluginSettings | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
		delete (this.settings as LegacyPorygonPluginSettings).chatSystemPrompt;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
