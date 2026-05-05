import { PluginSettingTab, Setting } from "obsidian";
import AssistantPlugin from "./main";
import { ONBOARDING_DEFAULTS } from "./settings";

export class AssistantSettingTab extends PluginSettingTab {
	plugin: AssistantPlugin;

	constructor(plugin: AssistantPlugin) {
		super(plugin.app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Assistant settings" });

		new Setting(containerEl)
			.setName("Ollama host")
			.setDesc("URL where Ollama is running.")
			.addText((text) => text
				.setPlaceholder(ONBOARDING_DEFAULTS.ollamaHost)
				.setValue(this.plugin.settings.ollamaHost)
				.onChange(async (value) => {
					this.plugin.settings.ollamaHost = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Ollama chat model")
			.setDesc("Model used for chat responses.")
			.addText((text) => text
				.setPlaceholder(ONBOARDING_DEFAULTS.ollamaChatModel)
				.setValue(this.plugin.settings.ollamaChatModel)
				.onChange(async (value) => {
					this.plugin.settings.ollamaChatModel = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Ollama embeddings model")
			.setDesc("Model used for note embeddings.")
			.addText((text) => text
				.setPlaceholder(ONBOARDING_DEFAULTS.ollamaEmbeddingModel)
				.setValue(this.plugin.settings.ollamaEmbeddingModel)
				.onChange(async (value) => {
					this.plugin.settings.ollamaEmbeddingModel = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Enable thinking")
			.setDesc("Ask supported Ollama models to stream their thinking separately.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.ollamaThinking)
				.onChange(async (value) => {
					this.plugin.settings.ollamaThinking = value;
					await this.plugin.saveSettings();
				}));
	}
}
