import { ItemView, MarkdownRenderer, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { AgentChatMessage, streamLocalAgent } from "./agent";
import AssistantPlugin from "./main";
import { OllamaHttpClient, OllamaModel } from "./ollama-client";
import { ONBOARDING_DEFAULTS } from "./settings";

export const ASSISTANT_VIEW_TYPE = "assistant-view";

type OnboardingScreen = "welcome" | "ollamaHost" | "ollamaChatModel" | "ollamaEmbeddingModel";
type OnboardingSettingKey = "ollamaHost" | "ollamaChatModel" | "ollamaEmbeddingModel";

interface SettingStep {
	key: OnboardingSettingKey;
	label: string;
	message: string;
}

type ChatRole = "user" | "assistant" | "warning";

interface MentionedNote {
	path: string;
	basename: string;
}

interface ChatMessage {
	role: ChatRole;
	content: string;
	mentions?: MentionedNote[];
	thinking?: string;
	isThinkingCollapsed?: boolean;
	thinkingDurationSeconds?: number;
}

const SETTING_STEPS: SettingStep[] = [
	{ key: "ollamaHost", label: "Ollama Host", message: "Where is Ollama running?" },
	{ key: "ollamaChatModel", label: "Ollama Chat Model", message: "Choose a chat model." },
	{ key: "ollamaEmbeddingModel", label: "Ollama Embeddings Model", message: "Choose an embeddings model." },
];

export class AssistantView extends ItemView {
	private plugin: AssistantPlugin;
	private screen: OnboardingScreen = "welcome";
	private models: OllamaModel[] = [];
	private messages: ChatMessage[] = [];
	private chatHistoryEl: HTMLElement | null = null;
	private composerInputEl: HTMLTextAreaElement | null = null;
	private sendButtonEl: HTMLButtonElement | null = null;
	private mentionTagsEl: HTMLElement | null = null;
	private mentionPopoverEl: HTMLElement | null = null;
	private mentionKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
	private mentionResultFiles: TFile[] = [];
	private selectedMentionResultIndex = 0;
	private selectedNoteFiles: TFile[] = [];
	private isStreaming = false;
	private healthIntervalId: number | null = null;
	private isHealthy = false;

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
		this.stopHealthPolling();
		this.contentEl.empty();
	}

	private render(): void {
		this.stopHealthPolling();
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
		this.chatHistoryEl = main.createDiv({ cls: "assistant-chat-history" });
		this.renderMessages();
		this.renderComposer(main);
		this.startHealthPolling();
	}

	private renderMessages(): void {
		if (!this.chatHistoryEl) {
			return;
		}

		this.chatHistoryEl.empty();
		this.messages.forEach((message) => this.renderMessage(message));
		this.scrollChatToBottom();
	}

	private renderMessage(message: ChatMessage): void {
		if (!this.chatHistoryEl) {
			return;
		}

		if (message.role === "warning") {
			const row = this.chatHistoryEl.createDiv({ cls: "assistant-message-row is-warning" });
			const warningEl = row.createDiv({ cls: "assistant-chat-warning" });
			const iconEl = warningEl.createDiv({ cls: "assistant-chat-warning-icon" });
			setIcon(iconEl, "triangle-alert");
			warningEl.createDiv({ cls: "assistant-chat-warning-content", text: message.content });
			return;
		}

		const row = this.chatHistoryEl.createDiv({ cls: `assistant-message-row is-${message.role}` });
		const messageStack = row.createDiv({ cls: "assistant-message-stack" });
		if (message.role === "user" && message.mentions && message.mentions.length > 0) {
			this.renderMentionTagList(messageStack, message.mentions, false);
		}
		if (message.role === "assistant" && message.thinking) {
			this.renderThinkingBubble(messageStack, message);
		}

		if (message.role === "assistant" && !message.content) {
			return;
		}

		const bubble = messageStack.createDiv({ cls: "assistant-message-bubble" });
		const iconEl = bubble.createDiv({ cls: "assistant-message-icon" });
		setIcon(iconEl, message.role === "user" ? "user" : "origami");
		const contentEl = bubble.createDiv({ cls: "assistant-message-content" });
		if (message.role === "assistant") {
			contentEl.addClass("markdown-rendered");
			void MarkdownRenderer.render(this.plugin.app, message.content, contentEl, "", this);
			return;
		}

		contentEl.setText(message.content);
	}

	private renderThinkingBubble(containerEl: HTMLElement, message: ChatMessage): void {
		const details = containerEl.createEl("details", { cls: "assistant-thinking-bubble" });
		details.open = !message.isThinkingCollapsed;
		const summary = details.createEl("summary", { cls: "assistant-thinking-summary" });
		const iconEl = summary.createSpan({ cls: "assistant-thinking-icon" });
		setIcon(iconEl, "lightbulb");
		summary.createSpan({ text: this.getThinkingTitle(message) });
		summary.addEventListener("click", () => {
			window.setTimeout(() => {
				message.isThinkingCollapsed = !details.open;
			}, 0);
		});
		const contentEl = details.createDiv({ cls: "assistant-thinking-content markdown-rendered" });
		void MarkdownRenderer.render(this.plugin.app, message.thinking ?? "", contentEl, "", this);
	}

	private renderComposer(containerEl: HTMLElement): void {
		const composer = containerEl.createDiv({ cls: "assistant-composer" });
		this.mentionTagsEl = composer.createDiv({ cls: "assistant-mention-tags" });
		this.renderMentionTags();
		composer.createDiv({ cls: "assistant-attachments" });
		this.composerInputEl = composer.createEl("textarea", {
			cls: "assistant-message-input",
			attr: { placeholder: "Ask anything..." },
		});
		const actionsRow = composer.createDiv({ cls: "assistant-composer-actions" });
		const leftActions = actionsRow.createDiv({ cls: "assistant-composer-left-actions" });
		const newConversationButton = leftActions.createEl("button", {
			cls: "assistant-composer-button",
			attr: { title: "New conversation", "aria-label": "New conversation" },
		});
		setIcon(newConversationButton, "circle-plus");
		newConversationButton.addEventListener("click", () => this.startNewChat());
		const mentionButton = leftActions.createEl("button", {
			cls: "assistant-composer-button",
			attr: { title: "Mention notes", "aria-label": "Mention notes" },
		});
		setIcon(mentionButton, "at-sign");
		mentionButton.addEventListener("click", () => this.toggleMentionPopover(composer));
		this.sendButtonEl = actionsRow.createEl("button", {
			cls: "assistant-send-button",
			attr: { title: "Type a message...", "aria-label": "Type a message..." },
		});
		setIcon(this.sendButtonEl, "send-horizontal");
		this.updateSendButtonState();

		this.composerInputEl.addEventListener("input", () => this.updateSendButtonState());
		this.composerInputEl.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && this.mentionPopoverEl) {
				event.preventDefault();
				this.closeMentionPopover();
				return;
			}

			if (event.key !== "Enter" || event.shiftKey) {
				return;
			}

			event.preventDefault();
			void this.sendCurrentMessage();
		});
		this.sendButtonEl.addEventListener("click", () => {
			void this.sendCurrentMessage();
		});
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

	private createOllamaClient(): OllamaHttpClient {
		return new OllamaHttpClient(this.getOllamaBaseUrl());
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

	private startNewChat(): void {
		this.messages = [];
		this.selectedNoteFiles = [];
		this.renderMentionTags();
		this.closeMentionPopover();
		this.updateSendButtonState();
		this.renderMessages();
		this.composerInputEl?.focus();
	}

	private renderMentionTags(): void {
		if (!this.mentionTagsEl) {
			return;
		}

		this.mentionTagsEl.empty();
		this.renderMentionTagList(this.mentionTagsEl, this.selectedNoteFiles.map((file) => this.toMentionedNote(file)), true);
	}

	private renderMentionTagList(containerEl: HTMLElement, mentions: MentionedNote[], isRemovable: boolean): void {
		mentions.forEach((mention) => {
			const tag = containerEl.createEl(isRemovable ? "button" : "div", {
				cls: "assistant-mention-tag",
				attr: { title: mention.path, "aria-label": isRemovable ? `Remove ${mention.basename}` : mention.basename },
			});
			const noteIcon = tag.createSpan({ cls: "assistant-mention-tag-icon" });
			setIcon(noteIcon, "sticky-note");
			tag.createSpan({ cls: "assistant-mention-tag-title", text: mention.basename });

			if (!isRemovable) {
				return;
			}

			const removeIcon = tag.createSpan({ cls: "assistant-mention-tag-remove" });
			setIcon(removeIcon, "x");
			tag.addEventListener("click", () => this.removeMentionedNoteByPath(mention.path));
		});
	}

	private toggleMentionPopover(composerEl: HTMLElement): void {
		if (this.mentionPopoverEl) {
			this.closeMentionPopover();
			return;
		}

		this.renderMentionPopover(composerEl);
	}

	private renderMentionPopover(composerEl: HTMLElement): void {
		this.closeMentionPopover();
		const popover = composerEl.createDiv({ cls: "assistant-mention-popover" });
		this.mentionPopoverEl = popover;
		const filterInput = popover.createEl("input", {
			cls: "assistant-mention-filter",
			attr: { type: "text", placeholder: "Filter notes..." },
		});
		const notesEl = popover.createDiv({ cls: "assistant-mention-results" });
		const renderNotes = () => this.renderMentionNoteResults(notesEl, filterInput.value);

		filterInput.addEventListener("input", () => {
			this.selectedMentionResultIndex = 0;
			renderNotes();
		});
		this.mentionKeydownHandler = (event: KeyboardEvent) => this.handleMentionPopoverKeydown(event, notesEl, filterInput.value);
		window.addEventListener("keydown", this.mentionKeydownHandler, true);
		renderNotes();
		filterInput.focus();
	}

	private handleMentionPopoverKeydown(event: KeyboardEvent, notesEl: HTMLElement, query: string): void {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			this.closeMentionPopover();
			this.composerInputEl?.focus();
			return;
		}

		if (event.key === "ArrowDown") {
			event.preventDefault();
			event.stopPropagation();
			this.moveMentionSelection(1, notesEl, query);
			return;
		}

		if (event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			this.moveMentionSelection(-1, notesEl, query);
			return;
		}

		if (event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			const selectedFile = this.mentionResultFiles[this.selectedMentionResultIndex];
			if (selectedFile) {
				this.addMentionedNote(selectedFile);
				return;
			}

			this.closeMentionPopover();
			this.composerInputEl?.focus();
		}
	}

	private renderMentionNoteResults(containerEl: HTMLElement, query: string): void {
		containerEl.empty();
		const normalizedQuery = query.trim().toLowerCase();
		const unavailablePaths = this.getUnavailableMentionPaths();
		const files = this.plugin.app.vault.getMarkdownFiles()
			.filter((file) => !unavailablePaths.has(file.path))
			.filter((file) => {
				if (!normalizedQuery) {
					return true;
				}

				return file.basename.toLowerCase().includes(normalizedQuery) || file.path.toLowerCase().includes(normalizedQuery);
			})
			.sort((first, second) => first.path.localeCompare(second.path));
		this.mentionResultFiles = files;
		this.selectedMentionResultIndex = Math.min(this.selectedMentionResultIndex, Math.max(files.length - 1, 0));

		if (files.length === 0) {
			containerEl.createDiv({ cls: "assistant-mention-empty", text: "No notes found" });
			return;
		}

		files.forEach((file, index) => {
			const noteButton = containerEl.createEl("button", {
				cls: "assistant-mention-result",
				attr: { title: file.path, "aria-label": `Mention ${file.path}`, type: "button" },
			});
			noteButton.toggleClass("is-selected", index === this.selectedMentionResultIndex);
			noteButton.createSpan({ cls: "assistant-mention-result-path", text: file.path });
			noteButton.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.addMentionedNote(file);
			});
		});
	}

	private moveMentionSelection(direction: number, containerEl: HTMLElement, query: string): void {
		if (this.mentionResultFiles.length === 0) {
			return;
		}

		this.selectedMentionResultIndex = (this.selectedMentionResultIndex + direction + this.mentionResultFiles.length) % this.mentionResultFiles.length;
		this.renderMentionNoteResults(containerEl, query);
		const selectedEl = containerEl.querySelector<HTMLElement>(".assistant-mention-result.is-selected");
		selectedEl?.scrollIntoView({ block: "nearest" });
	}

	private addMentionedNote(file: TFile): void {
		if (this.getUnavailableMentionPaths().has(file.path)) {
			this.closeMentionPopover();
			this.composerInputEl?.focus();
			return;
		}

		this.selectedNoteFiles = [...this.selectedNoteFiles, file];
		this.renderMentionTags();
		this.updateSendButtonState();
		this.closeMentionPopover();
		this.composerInputEl?.focus();
	}

	private removeMentionedNoteByPath(path: string): void {
		this.selectedNoteFiles = this.selectedNoteFiles.filter((selectedFile) => selectedFile.path !== path);
		this.renderMentionTags();
		this.updateSendButtonState();
		this.composerInputEl?.focus();
	}

	private closeMentionPopover(): void {
		if (this.mentionKeydownHandler) {
			window.removeEventListener("keydown", this.mentionKeydownHandler, true);
			this.mentionKeydownHandler = null;
		}

		this.mentionPopoverEl?.remove();
		this.mentionPopoverEl = null;
		this.mentionResultFiles = [];
		this.selectedMentionResultIndex = 0;
	}

	private getUnavailableMentionPaths(): Set<string> {
		const paths = new Set(this.selectedNoteFiles.map((file) => file.path));
		this.messages.forEach((message) => {
			message.mentions?.forEach((mention) => paths.add(mention.path));
		});
		return paths;
	}

	private updateSendButtonState(): void {
		if (!this.sendButtonEl || !this.composerInputEl) {
			return;
		}

		this.sendButtonEl.empty();
		this.sendButtonEl.toggleClass("is-healthy", this.isHealthy);
		this.sendButtonEl.toggleClass("is-unhealthy", !this.isHealthy);
		setIcon(this.sendButtonEl, this.isHealthy ? "send-horizontal" : "unlink");

		const hasMessage = this.composerInputEl.value.trim().length > 0 || this.selectedNoteFiles.length > 0;
		this.sendButtonEl.disabled = this.isHealthy && (!hasMessage || this.isStreaming);
		const tooltip = this.isHealthy ? (hasMessage ? "Send message" : "Type a message...") : "Ollama is unreachable";
		this.sendButtonEl.title = tooltip;
		this.sendButtonEl.ariaLabel = tooltip;
	}

	private async sendCurrentMessage(): Promise<void> {
		if (!this.composerInputEl || this.isStreaming) {
			return;
		}

		const content = this.composerInputEl.value.trim();
		const mentionedNoteFiles = [...this.selectedNoteFiles];
		if (!content && mentionedNoteFiles.length === 0) {
			this.updateSendButtonState();
			return;
		}

		if (!this.isHealthy) {
			this.updateSendButtonState();
			return;
		}

		const mentionSnapshots = mentionedNoteFiles.map((file) => this.toMentionedNote(file));

		this.composerInputEl.value = "";
		this.selectedNoteFiles = [];
		this.renderMentionTags();
		this.closeMentionPopover();
		this.messages.push({ role: "user", content, mentions: mentionSnapshots });
		const assistantMessage: ChatMessage = { role: "assistant", content: this.plugin.settings.ollamaThinking ? "" : "Thinking..." };
		this.messages.push(assistantMessage);
		this.isStreaming = true;
		this.updateSendButtonState();
		this.renderMessages();

		try {
			let thinkingStartedAt: number | null = null;
			let hasStartedStreamingContent = false;
			await streamLocalAgent({
				ollamaHost: this.getOllamaBaseUrl(),
				ollamaChatModel: this.plugin.settings.ollamaChatModel,
				ollamaThinking: this.plugin.settings.ollamaThinking,
				systemPrompt: this.plugin.settings.chatSystemPrompt.trim(),
				messages: await this.buildAgentMessages(assistantMessage),
			}, {
				onContentDelta: (delta) => {
					if (!hasStartedStreamingContent) {
						assistantMessage.content = "";
						hasStartedStreamingContent = true;
					}

					assistantMessage.content += delta;
					this.renderMessages();
				},
				onThinkingDelta: (delta) => {
					thinkingStartedAt = thinkingStartedAt ?? Date.now();
					assistantMessage.thinking = `${assistantMessage.thinking ?? ""}${delta}`;
					this.renderMessages();
				},
			});

			if (assistantMessage.thinking && thinkingStartedAt !== null) {
				assistantMessage.thinkingDurationSeconds = this.getThinkingDurationSeconds(thinkingStartedAt);
				assistantMessage.isThinkingCollapsed = true;
			}
			this.renderMessages();
		} catch (error) {
			this.messages = this.messages.filter((message) => message !== assistantMessage);
			this.messages.push({ role: "warning", content: error instanceof Error ? error.message : String(error) });
			this.renderMessages();
		} finally {
			this.isStreaming = false;
			this.updateSendButtonState();
		}
	}

	private getThinkingTitle(message: ChatMessage): string {
		if (message.thinkingDurationSeconds === undefined) {
			return "Thinking...";
		}

		const unit = message.thinkingDurationSeconds === 1 ? "second" : "seconds";
		return `Thought for ${message.thinkingDurationSeconds} ${unit}`;
	}

	private getThinkingDurationSeconds(startedAt: number): number {
		return Math.max(1, Math.round((Date.now() - startedAt) / 1000));
	}

	private async buildAgentMessages(excludedMessage: ChatMessage): Promise<AgentChatMessage[]> {
		const messages = this.messages.filter((message): message is ChatMessage & { role: AgentChatMessage["role"] } =>
			(message.role === "user" || message.role === "assistant") && message !== excludedMessage,
		);
		return Promise.all(messages.map(async (message) => ({
			role: message.role,
			content: await this.buildAgentMessageContent(message),
		})));
	}

	private async buildAgentMessageContent(message: ChatMessage): Promise<string> {
		const mentions = message.mentions ?? [];
		if (mentions.length === 0) {
			return message.content;
		}

		const noteContext = await this.getMentionedNotesContext(mentions);
		return `${noteContext}\n\n${message.content}`.trim();
	}

	private async getMentionedNotesContext(mentions: MentionedNote[]): Promise<string> {
		if (mentions.length === 0) {
			return "";
		}

		const noteContents = await Promise.all(mentions.map(async (mention) => {
			const file = this.plugin.app.vault.getAbstractFileByPath(mention.path);
			if (!(file instanceof TFile)) {
				return `# ${mention.basename}\n\nNote not found: ${mention.path}`;
			}

			const content = await this.plugin.app.vault.cachedRead(file);
			return `# ${file.basename}\n\n${content}`;
		}));

		return `Use these Obsidian notes as context:\n\n${noteContents.join("\n\n---\n\n")}`;
	}

	private toMentionedNote(file: TFile): MentionedNote {
		return { path: file.path, basename: file.basename };
	}

	private scrollChatToBottom(): void {
		if (!this.chatHistoryEl) {
			return;
		}

		this.chatHistoryEl.scrollTop = this.chatHistoryEl.scrollHeight;
	}

	private startHealthPolling(): void {
		this.stopHealthPolling();
		void this.updateHealthStatus();
		this.healthIntervalId = window.setInterval(() => {
			void this.updateHealthStatus();
		}, 5000);
	}

	private stopHealthPolling(): void {
		if (this.healthIntervalId === null) {
			return;
		}

		window.clearInterval(this.healthIntervalId);
		this.healthIntervalId = null;
	}

	private async updateHealthStatus(): Promise<void> {
		try {
			await this.createOllamaClient().version();
			this.isHealthy = true;
		} catch {
			this.isHealthy = false;
		}

		this.updateSendButtonState();
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
