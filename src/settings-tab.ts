import { PluginSettingTab, Setting } from "obsidian";
import PorygonPlugin from "./main";
import { ONBOARDING_DEFAULTS } from "./settings";

export class PorygonSettingTab extends PluginSettingTab {
	plugin: PorygonPlugin;

	constructor(plugin: PorygonPlugin) {
		super(plugin.app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Ollama host")
			.setDesc("Host for ollama.")
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
			.setName("Model thinking")
			.setDesc("Reasoning stream for supported ollama models.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.ollamaThinking)
				.onChange(async (value) => {
					this.plugin.settings.ollamaThinking = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Tool usage reporting")
			.setDesc("Show tool calls and their intent in chat history.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.showToolUsage)
				.onChange(async (value) => {
					this.plugin.settings.showToolUsage = value;
					await this.plugin.saveSettings();
				}));

		const personalPromptSetting = new Setting(containerEl)
			.setName("Personal prompt")
			.setDesc("Tone and response preferences sent before each chat.")
			.addTextArea((textArea) => {
				textArea
					.setValue(this.plugin.settings.personalPrompt)
					.onChange(async (value) => {
						this.plugin.settings.personalPrompt = value;
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 14;
				textArea.inputEl.addClass("porygon-settings-prompt");
			});
		personalPromptSetting.settingEl.addClass("porygon-settings-prompt-setting");
	}
}
