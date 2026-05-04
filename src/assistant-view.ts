import { ItemView, setIcon, WorkspaceLeaf } from "obsidian";
import { Ollama } from "ollama/dist/browser.mjs";
import type { ModelResponse } from "ollama/dist/browser.d.ts";
import AssistantPlugin from "./main";
import { AssistantPluginSettings, ONBOARDING_DEFAULTS } from "./settings";

export const ASSISTANT_VIEW_TYPE = "assistant-view";

type OnboardingScreen = "welcome" | "ollamaHost" | "ollamaChatModel" | "ollamaEmbeddingModel";
type OnboardingSettingKey = keyof AssistantPluginSettings;

interface SettingStep {
	key: OnboardingSettingKey;
	label: string;
	message: string;
}

const SETTING_STEPS: SettingStep[] = [
	{ key: "ollamaHost", label: "Ollama Host", message: "Where is Ollama running?" },
	{ key: "ollamaChatModel", label: "Ollama Chat Model", message: "Choose a chat model." },
	{ key: "ollamaEmbeddingModel", label: "Ollama Embeddings Model", message: "Choose an embeddings model." },
];

export class AssistantView extends ItemView {
	private plugin: AssistantPlugin;
	private screen: OnboardingScreen = "welcome";
	private models: ModelResponse[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: AssistantPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return ASSISTANT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Assistant";
	}

	getIcon(): string {
		return "origami";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("assistant-view");
		this.screen = this.getInitialScreen();
		await this.loadModelsForModelStep();
		this.render();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.addClass("assistant-view");

		if (this.isOnboardingComplete()) {
			this.renderAssistant();
			return;
		}

		if (this.screen === "welcome") {
			this.renderWelcome();
			return;
		}

		this.renderSettingScreen();
	}

	private renderAssistant(): void {
		this.contentEl.empty();
		this.contentEl.addClass("assistant-view");
		const main = this.contentEl.createDiv({ cls: "assistant-main" });
		main.createEl("h2", { cls: "assistant-header", text: "Assistant" });
		main.createDiv({ cls: "assistant-body" });
	}

	private renderWelcome(): void {
		const wrapper = this.contentEl.createDiv({ cls: "assistant-welcome" });
		const iconEl = wrapper.createDiv({ cls: "assistant-welcome-icon" });
		setIcon(iconEl, "origami");
		wrapper.createEl("h2", { text: "Welcome" });
		wrapper.createEl("p", { text: "Turn your notes into a conversation..." });

		const button = wrapper.createEl("button", {
			cls: "mod-cta assistant-primary-button",
			text: "Let's start",
		});

		button.addEventListener("click", () => {
			this.screen = "ollamaHost";
			this.render();
		});
	}

	private renderSettingScreen(): void {
		const wrapper = this.contentEl.createDiv({ cls: "assistant-settings" });
		const iconEl = wrapper.createDiv({ cls: "assistant-settings-icon" });
		setIcon(iconEl, "origami");
		this.renderVerticalSteps(wrapper);
	}

	private renderVerticalSteps(containerEl: HTMLElement): void {
		const stepsEl = containerEl.createDiv({ cls: "assistant-vertical-steps" });
		const currentStepIndex = this.getCurrentStepIndex();

		SETTING_STEPS.forEach((step, index) => {
			const isActive = index === currentStepIndex;
			const isComplete = this.isStepComplete(step.key);
			const row = stepsEl.createDiv({ cls: "assistant-vertical-step" });
			row.toggleClass("is-active", isActive);
			row.toggleClass("is-complete", isComplete);
			row.toggleClass("is-clickable", isComplete);

			const rail = row.createDiv({ cls: "assistant-step-rail" });
			rail.createDiv({ cls: "assistant-step-node", text: isComplete ? "✓" : String(index + 1) });
			const card = row.createDiv({ cls: "assistant-step-card" });
			this.renderStepSummary(card, step, isComplete);

			if (isComplete) {
				row.addEventListener("click", () => {
					this.screen = step.key;
					void this.loadModelsForModelStep().then(() => this.render());
				});
			}

			if (isActive) {
				this.renderStepEditor(card, step.key);
			}
		});
	}

	private renderStepSummary(containerEl: HTMLElement, step: SettingStep, isComplete: boolean): void {
		const header = containerEl.createDiv({ cls: "assistant-step-card-header" });
		header.createEl("strong", { text: step.label });

		if (isComplete) {
			const value = this.plugin.settings[step.key];
			header.createEl("span", { cls: "assistant-step-value", text: value });
			return;
		}

		header.createEl("span", { cls: "assistant-step-message", text: step.message });
	}

	private renderStepEditor(containerEl: HTMLElement, stepKey: OnboardingSettingKey): void {
		if (stepKey === "ollamaHost") {
			this.renderHostEditor(containerEl);
			return;
		}

		if (stepKey === "ollamaChatModel" || stepKey === "ollamaEmbeddingModel") {
			this.renderModelEditor(containerEl, stepKey);
		}
	}

	private renderHostEditor(containerEl: HTMLElement): void {
		const editor = containerEl.createDiv({ cls: "assistant-step-editor" });
		const input = editor.createEl("input", {
			attr: {
				type: "text",
				value: this.plugin.settings.ollamaHost || ONBOARDING_DEFAULTS.ollamaHost,
			},
		});
		const errorEl = editor.createDiv({ cls: "assistant-onboarding-error" });
		const button = this.createNextButton(editor);

		button.addEventListener("click", (event) => {
			event.stopPropagation();
			void this.handleHostNext(input.value.trim(), errorEl, button);
		});
	}

	private renderModelEditor(containerEl: HTMLElement, settingKey: "ollamaChatModel" | "ollamaEmbeddingModel"): void {
		const editor = containerEl.createDiv({ cls: "assistant-step-editor" });
		const defaultValue = settingKey === "ollamaChatModel" ? ONBOARDING_DEFAULTS.ollamaChatModel : ONBOARDING_DEFAULTS.ollamaEmbeddingModel;
		const select = editor.createEl("select");
		const modelNames = this.models.map((model) => model.name);
		const selectedValue = this.getPreferredModelValue(settingKey, defaultValue, modelNames);

		if (modelNames.length === 0) {
			select.createEl("option", { text: "No models available", value: "" });
			select.disabled = true;
		} else {
			modelNames.forEach((modelName) => {
				const option = select.createEl("option", { text: modelName, value: modelName });
				option.selected = modelName === selectedValue;
			});
		}

		const errorEl = editor.createDiv({ cls: "assistant-onboarding-error" });
		if (modelNames.length === 0) {
			this.renderNoModelsGuidance(errorEl);
		}
		const button = this.createNextButton(editor);

		button.addEventListener("click", (event) => {
			event.stopPropagation();
			void this.handleModelNext(settingKey, select.value, errorEl, button);
		});
	}

	private createNextButton(containerEl: HTMLElement): HTMLButtonElement {
		return containerEl.createEl("button", {
			cls: "mod-cta assistant-primary-button",
			text: "Next",
		});
	}

	private async handleHostNext(value: string, errorEl: HTMLElement, button: HTMLButtonElement): Promise<void> {
		errorEl.empty();

		if (!value) {
			errorEl.setText("Ollama host is required.");
			return;
		}

		try {
			new URL(value);
		} catch {
			errorEl.setText("Enter a valid host.");
			return;
		}

		this.setLoading(button, true, "Checking...");

		try {
			this.plugin.settings.ollamaHost = value;
			await this.fetchModels();
			await this.plugin.saveSettings();
			this.screen = "ollamaChatModel";
			this.render();
		} catch {
			this.renderOllamaConnectionGuidance(errorEl);
		} finally {
			this.setLoading(button, false);
		}
	}

	private async handleModelNext(settingKey: "ollamaChatModel" | "ollamaEmbeddingModel", value: string, errorEl: HTMLElement, button: HTMLButtonElement): Promise<void> {
		errorEl.empty();

		if (!value) {
			this.renderNoModelsGuidance(errorEl);
			return;
		}

		this.setLoading(button, true);

		try {
			this.plugin.settings[settingKey] = value;
			await this.plugin.saveSettings();

			if (settingKey === "ollamaChatModel") {
				this.screen = "ollamaEmbeddingModel";
				this.render();
				return;
			}

			this.renderAssistant();
		} finally {
			this.setLoading(button, false);
		}
	}

	private async fetchModels(): Promise<void> {
		const ollama = this.createOllamaClient();

		await ollama.version();
		const response = await ollama.list();
		this.models = response.models;
	}

	private async loadModelsForModelStep(): Promise<void> {
		if (this.screen !== "ollamaChatModel" && this.screen !== "ollamaEmbeddingModel") {
			return;
		}

		try {
			await this.fetchModels();
		} catch {
			this.models = [];
		}
	}

	private createOllamaClient(): Ollama {
		return new Ollama({ host: this.getOllamaBaseUrl() });
	}

	private getOllamaBaseUrl(): string {
		return this.plugin.settings.ollamaHost || ONBOARDING_DEFAULTS.ollamaHost;
	}

	private getPreferredModelValue(settingKey: "ollamaChatModel" | "ollamaEmbeddingModel", defaultValue: string, modelNames: string[]): string {
		if (this.plugin.settings[settingKey]) {
			return this.plugin.settings[settingKey];
		}

		const latestValue = `${defaultValue}:latest`;
		if (modelNames.includes(latestValue)) {
			return latestValue;
		}

		if (modelNames.includes(defaultValue)) {
			return defaultValue;
		}

		return modelNames[0] ?? "";
	}

	private renderOllamaConnectionGuidance(containerEl: HTMLElement): void {
		const contentEl = this.createHint(containerEl);
		contentEl.createEl("p", { text: "Unable to connect. Try these steps:" });
		const list = contentEl.createEl("ol");
		const installItem = list.createEl("li");
		installItem.appendText("Install ollama: ");
		installItem.createEl("a", {
			text: "https://ollama.com/download",
			attr: { href: "https://ollama.com/download" },
		});
		list.createEl("li", { text: "Make sure ollama is running, then try again." });
	}

	private renderNoModelsGuidance(containerEl: HTMLElement): void {
		const contentEl = this.createHint(containerEl);
		contentEl.createEl("p", { text: "No models are installed. Download a model from your terminal, for example:" });
		const command = contentEl.createEl("code");
		command.appendText("ollama run gemma4");
	}

	private createHint(containerEl: HTMLElement): HTMLElement {
		containerEl.empty();
		const hintEl = containerEl.createDiv({ cls: "assistant-hint" });
		const iconEl = hintEl.createDiv({ cls: "assistant-hint-icon" });
		setIcon(iconEl, "lightbulb");
		return hintEl.createDiv({ cls: "assistant-hint-content" });
	}

	private setLoading(button: HTMLButtonElement, isLoading: boolean, loadingText = "Saving..."): void {
		button.disabled = isLoading;
		button.setText(isLoading ? loadingText : "Next");
	}

	private getCurrentStepIndex(): number {
		if (this.screen === "ollamaHost") {
			return 0;
		}

		if (this.screen === "ollamaChatModel") {
			return 1;
		}

		return 2;
	}

	private getInitialScreen(): OnboardingScreen {
		if (!this.plugin.settings.ollamaHost) {
			return "welcome";
		}

		if (!this.plugin.settings.ollamaChatModel) {
			return "ollamaChatModel";
		}

		if (!this.plugin.settings.ollamaEmbeddingModel) {
			return "ollamaEmbeddingModel";
		}

		return "ollamaEmbeddingModel";
	}

	private isStepComplete(stepKey: OnboardingSettingKey): boolean {
		return Boolean(this.plugin.settings[stepKey]);
	}

	private isOnboardingComplete(): boolean {
		return Boolean(
			this.plugin.settings.ollamaHost &&
			this.plugin.settings.ollamaChatModel &&
			this.plugin.settings.ollamaEmbeddingModel
		);
	}
}
