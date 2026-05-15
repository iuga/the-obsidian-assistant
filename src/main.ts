import { Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { PorygonView, PORYGON_VIEW_TYPE } from "./porygon-view";
import { RagIndexer, RagSemanticSearchService } from "./rag";
import { PorygonPluginSettings, DEFAULT_SETTINGS, LegacyPorygonPluginSettings } from "./settings";
import { PorygonSettingTab } from "./settings-tab";

export default class PorygonPlugin extends Plugin {
	settings: PorygonPluginSettings;
	ragIndexer: RagIndexer;
	ragSemanticSearch: RagSemanticSearchService;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.ragIndexer = new RagIndexer(this.app, this.settings);
		this.ragSemanticSearch = new RagSemanticSearchService(this.settings);

		this.registerView(
			PORYGON_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new PorygonView(leaf, this)
		);
		this.addSettingTab(new PorygonSettingTab(this));

		this.addRibbonIcon("origami", "Porygon", () => {
			void this.activateView();
		});

		this.registerRagIndexEvents();
		void this.ragIndexer.reconcile();
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
		this.ragIndexer?.updateSettings(this.settings);
		this.ragSemanticSearch?.updateSettings(this.settings);
	}

	private registerRagIndexEvents(): void {
		this.registerEvent(this.app.vault.on("create", (file) => {
			if (file instanceof TFile && file.extension === "md") {
				this.ragIndexer.enqueue(file);
			}
		}));
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (file instanceof TFile && file.extension === "md") {
				this.ragIndexer.debounceEnqueue(file);
			}
		}));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			if (file instanceof TFile && file.extension === "md") {
				void this.ragIndexer.deleteFile(file.path);
			}
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (oldPath.endsWith(".md")) {
				void this.ragIndexer.deleteFile(oldPath);
			}

			if (file instanceof TFile && file.extension === "md") {
				this.ragIndexer.enqueue(file);
			}
		}));
	}
}
