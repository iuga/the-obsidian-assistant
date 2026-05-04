import { Plugin, WorkspaceLeaf } from "obsidian";
import { AssistantView, ASSISTANT_VIEW_TYPE } from "./assistant-view";
import { AssistantPluginSettings, DEFAULT_SETTINGS } from "./settings";

export default class AssistantPlugin extends Plugin {
	settings: AssistantPluginSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(
			ASSISTANT_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new AssistantView(leaf, this)
		);

		this.addRibbonIcon("origami", "Assistant", () => {
			void this.activateView();
		});
	}

	async activateView(): Promise<void> {
		const existingLeaves = this.app.workspace.getLeavesOfType(ASSISTANT_VIEW_TYPE);
		let leaf: WorkspaceLeaf | null = existingLeaves[0] ?? null;

		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false);
		}

		if (!leaf) {
			return;
		}

		await leaf.setViewState({ type: ASSISTANT_VIEW_TYPE, active: true });
		void this.app.workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<AssistantPluginSettings>);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
