import { ItemView, MarkdownRenderer, setIcon, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { AgentChatMessage, AgentToolCallIntent, streamLocalAgent } from "./agent";
import PorygonPlugin from "./main";
import { OllamaHttpClient, OllamaModel } from "./ollama-client";
import { ONBOARDING_DEFAULTS } from "./settings";

export const PORYGON_VIEW_TYPE = "porygon-view";

type OnboardingScreen = "welcome" | "ollamaHost" | "ollamaChatModel" | "ollamaEmbeddingModel";
type OnboardingSettingKey = "ollamaHost" | "ollamaChatModel" | "ollamaEmbeddingModel";

interface SettingStep {
	key: OnboardingSettingKey;
	label: string;
	message: string;
}

type ChatRole = "user" | "porygon" | "warning" | "file";
type MentionType = "note" | "folder" | "active-note";

interface MentionedItem {
	type: MentionType;
	path: string;
	basename: string;
	files: MentionedFile[];
}

interface MentionedFile {
	path: string;
	basename: string;
}

interface MentionSearchResult {
	type: MentionType;
	path: string;
	label: string;
	title: string;
	files: TFile[];
}

interface ChatMessage {
	role: ChatRole;
	content: string;
	mentions?: MentionedItem[];
	thinking?: string;
	isThinkingCollapsed?: boolean;
	thinkingDurationSeconds?: number;
	toolIntents?: AgentToolCallIntent[];
	areToolsCollapsed?: boolean;
}

const SETTING_STEPS: SettingStep[] = [
	{ key: "ollamaHost", label: "Ollama Host", message: "Where is Ollama running?" },
	{ key: "ollamaChatModel", label: "Ollama Chat Model", message: "Choose a chat model." },
	{ key: "ollamaEmbeddingModel", label: "Ollama Embeddings Model", message: "Choose an embeddings model." },
];

export class PorygonView extends ItemView {
	private plugin: PorygonPlugin;
	private screen: OnboardingScreen = "welcome";
	private models: OllamaModel[] = [];
	private messages: ChatMessage[] = [];
	private chatHistoryEl: HTMLElement | null = null;
	private composerInputEl: HTMLTextAreaElement | null = null;
	private sendButtonEl: HTMLButtonElement | null = null;
	private mentionTagsEl: HTMLElement | null = null;
	private mentionPopoverEl: HTMLElement | null = null;
	private mentionKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
	private mentionResults: MentionSearchResult[] = [];
	private selectedMentionResultIndex = 0;
	private selectedMentions: MentionedItem[] = [];
	private isStreaming = false;
	private healthIntervalId: number | null = null;
	private isHealthy = false;

	constructor(leaf: WorkspaceLeaf, plugin: PorygonPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return PORYGON_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Porygon";
	}

	getIcon(): string {
		return "origami";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("porygon-view");
		this.screen = this.getInitialScreen();
		await this.loadModelsForModelStep();
		this.render();
	}

	onClose(): Promise<void> {
		this.stopHealthPolling();
		this.contentEl.empty();
		return Promise.resolve();
	}

	private render(): void {
		this.stopHealthPolling();
		this.contentEl.empty();
		this.contentEl.addClass("porygon-view");

		if (this.isOnboardingComplete()) {
			this.renderPorygon();
			return;
		}

		if (this.screen === "welcome") {
			this.renderWelcome();
			return;
		}

		this.renderSettingScreen();
	}

	private renderPorygon(): void {
		this.contentEl.empty();
		this.contentEl.addClass("porygon-view");
		const main = this.contentEl.createDiv({ cls: "porygon-main" });
		this.chatHistoryEl = main.createDiv({ cls: "porygon-chat-history" });
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
			const row = this.chatHistoryEl.createDiv({ cls: "porygon-message-row is-warning" });
			const warningEl = row.createDiv({ cls: "porygon-chat-warning" });
			const iconEl = warningEl.createDiv({ cls: "porygon-chat-warning-icon" });
			setIcon(iconEl, "triangle-alert");
			warningEl.createDiv({ cls: "porygon-chat-warning-content", text: message.content });
			return;
		}

		if (message.role === "file") {
			return;
		}

		const row = this.chatHistoryEl.createDiv({ cls: `porygon-message-row is-${message.role}` });
		const messageStack = row.createDiv({ cls: "porygon-message-stack" });
		if (message.role === "user" && message.mentions && message.mentions.length > 0) {
			const messageMentionTagsEl = messageStack.createDiv({ cls: "porygon-mention-tags" });
			this.renderMentionTagList(messageMentionTagsEl, message.mentions, false);
		}
		if (message.role === "porygon" && message.thinking) {
			this.renderThinkingBubble(messageStack, message);
		}
		if (this.plugin.settings.showToolUsage && message.role === "porygon" && message.toolIntents && message.toolIntents.length > 0) {
			this.renderToolsBubble(messageStack, message);
		}

		if (message.role === "porygon" && !message.content) {
			return;
		}

		const bubble = messageStack.createDiv({ cls: "porygon-message-bubble" });
		const iconEl = bubble.createDiv({ cls: "porygon-message-icon" });
		setIcon(iconEl, message.role === "user" ? "user" : "origami");
		const contentEl = bubble.createDiv({ cls: "porygon-message-content" });
		if (message.role === "porygon") {
			contentEl.addClass("markdown-rendered");
			void MarkdownRenderer.render(this.plugin.app, message.content, contentEl, "", this);
			return;
		}

		contentEl.setText(message.content);
	}

	private renderThinkingBubble(containerEl: HTMLElement, message: ChatMessage): void {
		const details = containerEl.createEl("details", { cls: "porygon-thinking-bubble" });
		details.open = !message.isThinkingCollapsed;
		const summary = details.createEl("summary", { cls: "porygon-thinking-summary" });
		const iconEl = summary.createSpan({ cls: "porygon-thinking-icon" });
		setIcon(iconEl, "lightbulb");
		summary.createSpan({ text: this.getThinkingTitle(message) });
		summary.addEventListener("click", () => {
			window.setTimeout(() => {
				message.isThinkingCollapsed = !details.open;
			}, 0);
		});
		const contentEl = details.createDiv({ cls: "porygon-thinking-content markdown-rendered" });
		void MarkdownRenderer.render(this.plugin.app, message.thinking ?? "", contentEl, "", this).then(() => {
			if (details.open) {
				contentEl.scrollTop = contentEl.scrollHeight;
			}
		});
	}

	private renderToolsBubble(containerEl: HTMLElement, message: ChatMessage): void {
		const details = containerEl.createEl("details", { cls: "porygon-tools-bubble" });
		details.open = !message.areToolsCollapsed;
		const summary = details.createEl("summary", { cls: "porygon-tools-summary" });
		const iconEl = summary.createSpan({ cls: "porygon-tools-icon" });
		setIcon(iconEl, "wrench");
		summary.createSpan({ text: this.getToolsTitle(message) });
		summary.addEventListener("click", () => {
			window.setTimeout(() => {
				message.areToolsCollapsed = !details.open;
			}, 0);
		});
		const listEl = details.createEl("ul", { cls: "porygon-tools-list" });
		(message.toolIntents ?? []).forEach((toolIntent) => {
			const itemEl = listEl.createEl("li", { cls: "porygon-tools-item" });
			itemEl.createSpan({ cls: "porygon-tools-name", text: toolIntent.name });
			itemEl.createSpan({ cls: "porygon-tools-intent", text: toolIntent.intent });
		});
	}

	private renderComposer(containerEl: HTMLElement): void {
		const composer = containerEl.createDiv({ cls: "porygon-composer" });
		this.mentionTagsEl = composer.createDiv({ cls: "porygon-mention-tags" });
		this.renderMentionTags();
		composer.createDiv({ cls: "porygon-attachments" });
		this.composerInputEl = composer.createEl("textarea", {
			cls: "porygon-message-input",
			attr: { placeholder: "Ask anything..." },
		});
		const actionsRow = composer.createDiv({ cls: "porygon-composer-actions" });
		const leftActions = actionsRow.createDiv({ cls: "porygon-composer-left-actions" });
		const newConversationButton = leftActions.createEl("button", {
			cls: "porygon-composer-button",
			attr: { title: "New conversation", "aria-label": "New conversation" },
		});
		setIcon(newConversationButton, "circle-plus");
		newConversationButton.addEventListener("click", () => this.startNewChat());
		const mentionButton = leftActions.createEl("button", {
			cls: "porygon-composer-button",
			attr: { title: "Mention notes", "aria-label": "Mention notes" },
		});
		setIcon(mentionButton, "at-sign");
		mentionButton.addEventListener("click", () => this.toggleMentionPopover(composer));
		this.sendButtonEl = actionsRow.createEl("button", {
			cls: "porygon-send-button",
			attr: { title: "Type a message...", "aria-label": "Type a message..." },
		});
		setIcon(this.sendButtonEl, "send-horizontal");
		this.updateSendButtonState();

		this.composerInputEl.addEventListener("input", () => this.handleComposerInput());
		this.composerInputEl.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && this.mentionPopoverEl) {
				event.preventDefault();
				this.closeMentionPopover();
				return;
			}

			if (event.key === "@" && !this.mentionPopoverEl) {
				window.setTimeout(() => this.renderMentionPopover(composer), 0);
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
		const wrapper = this.contentEl.createDiv({ cls: "porygon-welcome" });
		const iconEl = wrapper.createDiv({ cls: "porygon-welcome-icon" });
		setIcon(iconEl, "origami");
		wrapper.createEl("h2", { text: "Welcome" });
		wrapper.createEl("p", { text: "Turn your notes into a conversation..." });

		const button = wrapper.createEl("button", {
			cls: "mod-cta porygon-primary-button",
			text: "Let's start",
		});

		button.addEventListener("click", () => {
			this.screen = "ollamaHost";
			this.render();
		});
	}

	private renderSettingScreen(): void {
		const wrapper = this.contentEl.createDiv({ cls: "porygon-settings" });
		const iconEl = wrapper.createDiv({ cls: "porygon-settings-icon" });
		setIcon(iconEl, "origami");
		this.renderVerticalSteps(wrapper);
	}

	private renderVerticalSteps(containerEl: HTMLElement): void {
		const stepsEl = containerEl.createDiv({ cls: "porygon-vertical-steps" });
		const currentStepIndex = this.getCurrentStepIndex();

		SETTING_STEPS.forEach((step, index) => {
			const isActive = index === currentStepIndex;
			const isComplete = this.isStepComplete(step.key);
			const row = stepsEl.createDiv({ cls: "porygon-vertical-step" });
			row.toggleClass("is-active", isActive);
			row.toggleClass("is-complete", isComplete);
			row.toggleClass("is-clickable", isComplete);

			const rail = row.createDiv({ cls: "porygon-step-rail" });
			rail.createDiv({ cls: "porygon-step-node", text: isComplete ? "✓" : String(index + 1) });
			const card = row.createDiv({ cls: "porygon-step-card" });
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
		const header = containerEl.createDiv({ cls: "porygon-step-card-header" });
		header.createEl("strong", { text: step.label });

		if (isComplete) {
			const value = this.plugin.settings[step.key];
			header.createEl("span", { cls: "porygon-step-value", text: value });
			return;
		}

		header.createEl("span", { cls: "porygon-step-message", text: step.message });
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
		const editor = containerEl.createDiv({ cls: "porygon-step-editor" });
		const input = editor.createEl("input", {
			attr: {
				type: "text",
				value: this.plugin.settings.ollamaHost || ONBOARDING_DEFAULTS.ollamaHost,
			},
		});
		const errorEl = editor.createDiv({ cls: "porygon-onboarding-error" });
		const button = this.createNextButton(editor);

		button.addEventListener("click", (event) => {
			event.stopPropagation();
			void this.handleHostNext(input.value.trim(), errorEl, button);
		});
	}

	private renderModelEditor(containerEl: HTMLElement, settingKey: "ollamaChatModel" | "ollamaEmbeddingModel"): void {
		const editor = containerEl.createDiv({ cls: "porygon-step-editor" });
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

		const errorEl = editor.createDiv({ cls: "porygon-onboarding-error" });
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
			cls: "mod-cta porygon-primary-button",
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

			this.renderPorygon();
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
		const hintEl = containerEl.createDiv({ cls: "porygon-hint" });
		const iconEl = hintEl.createDiv({ cls: "porygon-hint-icon" });
		setIcon(iconEl, "lightbulb");
		return hintEl.createDiv({ cls: "porygon-hint-content" });
	}

	private startNewChat(): void {
		this.messages = [];
		this.selectedMentions = [];
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
		this.renderMentionTagList(this.mentionTagsEl, this.selectedMentions, true);
	}

	private renderMentionTagList(containerEl: HTMLElement, mentions: MentionedItem[], isRemovable: boolean): void {
		mentions.forEach((mention) => {
			const tag = containerEl.createEl(isRemovable ? "button" : "div", {
				cls: "porygon-mention-tag",
				attr: { title: mention.path, "aria-label": isRemovable ? `Remove ${mention.basename}` : mention.basename },
			});
			const noteIcon = tag.createSpan({ cls: "porygon-mention-tag-icon" });
			setIcon(noteIcon, this.getMentionIcon(mention.type));
			tag.createSpan({ cls: "porygon-mention-tag-title", text: mention.basename });

			if (!isRemovable) {
				return;
			}

			const removeIcon = tag.createSpan({ cls: "porygon-mention-tag-remove" });
			setIcon(removeIcon, "x");
			tag.addEventListener("click", () => this.removeMentionedItemByPath(mention.path));
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
		const popover = composerEl.createDiv({ cls: "porygon-mention-popover" });
		this.mentionPopoverEl = popover;
		const panel = popover.createDiv({ cls: "porygon-mention-panel" });
		const filterInput = panel.createEl("input", {
			cls: "porygon-mention-filter",
			attr: { type: "text", placeholder: "Filter notes and folders..." },
		});
		const notesEl = panel.createDiv({ cls: "porygon-mention-results" });
		const renderNotes = () => this.renderMentionResults(notesEl, filterInput.value);

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
			const selectedResult = this.mentionResults[this.selectedMentionResultIndex];
			if (selectedResult) {
				this.addMentionedItem(selectedResult);
				return;
			}

			this.closeMentionPopover();
			this.composerInputEl?.focus();
		}
	}

	private renderMentionResults(containerEl: HTMLElement, query: string): void {
		containerEl.empty();
		const results = this.getMentionResults(query);
		this.mentionResults = results;
		this.selectedMentionResultIndex = Math.min(this.selectedMentionResultIndex, Math.max(results.length - 1, 0));

		if (results.length === 0) {
			containerEl.createDiv({ cls: "porygon-mention-empty", text: "No notes or folders found" });
			return;
		}

		results.forEach((result, index) => {
			const mentionButton = containerEl.createEl("button", {
				cls: "porygon-mention-result",
				attr: { title: result.title, "aria-label": `Mention ${result.title}`, type: "button" },
			});
			mentionButton.toggleClass("is-selected", index === this.selectedMentionResultIndex);
			const iconEl = mentionButton.createSpan({ cls: "porygon-mention-result-icon" });
			setIcon(iconEl, this.getMentionIcon(result.type));
			mentionButton.createSpan({ cls: "porygon-mention-result-path", text: result.label });
			mentionButton.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.addMentionedItem(result);
			});
		});
	}

	private moveMentionSelection(direction: number, containerEl: HTMLElement, query: string): void {
		if (this.mentionResults.length === 0) {
			return;
		}

		this.selectedMentionResultIndex = (this.selectedMentionResultIndex + direction + this.mentionResults.length) % this.mentionResults.length;
		this.renderMentionResults(containerEl, query);
		const selectedEl = containerEl.querySelector<HTMLElement>(".porygon-mention-result.is-selected");
		selectedEl?.scrollIntoView({ block: "nearest" });
	}

	private getMentionResults(query: string): MentionSearchResult[] {
		const normalizedQuery = query.trim().toLowerCase();
		const unavailablePaths = this.getUnavailableMentionPaths();
		const results: MentionSearchResult[] = [];
		const activeFile = this.plugin.app.workspace.getActiveFile();

		if (activeFile instanceof TFile && activeFile.extension === "md" && !unavailablePaths.has(activeFile.path)) {
			results.push({
				type: "active-note",
				path: activeFile.path,
				label: "Active Note",
				title: activeFile.path,
				files: [activeFile],
			});
		}

		this.plugin.app.vault.getMarkdownFiles()
			.filter((file) => !unavailablePaths.has(file.path))
			.map((file): MentionSearchResult => ({
				type: "note",
				path: file.path,
				label: file.path,
				title: file.path,
				files: [file],
			}))
			.forEach((result) => results.push(result));

		this.plugin.app.vault.getAllFolders(false)
			.filter((folder) => !unavailablePaths.has(folder.path))
			.map((folder): MentionSearchResult => ({
				type: "folder",
				path: folder.path,
				label: folder.path,
				title: folder.path,
				files: this.getDirectMarkdownFiles(folder),
			}))
			.forEach((result) => results.push(result));

		return results
			.filter((result) => this.doesMentionResultMatch(result, normalizedQuery))
			.sort((first, second) => this.getMentionSortValue(first).localeCompare(this.getMentionSortValue(second)));
	}

	private doesMentionResultMatch(result: MentionSearchResult, normalizedQuery: string): boolean {
		if (!normalizedQuery) {
			return true;
		}

		return result.label.toLowerCase().includes(normalizedQuery) || result.path.toLowerCase().includes(normalizedQuery);
	}

	private getMentionSortValue(result: MentionSearchResult): string {
		if (result.type === "active-note") {
			return `0-${result.path}`;
		}

		return `${result.type === "folder" ? "1" : "2"}-${result.path}`;
	}

	private getDirectMarkdownFiles(folder: TFolder): TFile[] {
		return folder.children
			.filter((child): child is TFile => child instanceof TFile && child.extension === "md")
			.sort((first, second) => first.path.localeCompare(second.path));
	}

	private addMentionedItem(result: MentionSearchResult): void {
		if (this.getUnavailableMentionPaths().has(result.path)) {
			this.closeMentionPopover();
			this.composerInputEl?.focus();
			return;
		}

		const mention = this.toMentionedItem(result);
		this.selectedMentions = [...this.selectedMentions, mention];
		this.insertMentionLink(mention);
		this.renderMentionTags();
		this.updateSendButtonState();
		this.closeMentionPopover();
		this.composerInputEl?.focus();
	}

	private insertMentionLink(mention: MentionedItem): void {
		if (!this.composerInputEl) {
			return;
		}

		const link = this.getMentionLink(mention);
		const selectionStart = this.composerInputEl.selectionStart;
		const selectionEnd = this.composerInputEl.selectionEnd;
		const value = this.composerInputEl.value;
		const atIndex = value.lastIndexOf("@", selectionStart - 1);
		const replaceStart = atIndex === -1 ? selectionStart : atIndex;
		this.composerInputEl.value = `${value.slice(0, replaceStart)}${link}${value.slice(selectionEnd)}`;
		const cursor = replaceStart + link.length;
		this.composerInputEl.setSelectionRange(cursor, cursor);
	}

	private handleComposerInput(): void {
		this.syncMentionsWithComposerText();
		this.updateSendButtonState();
	}

	private syncMentionsWithComposerText(): void {
		if (!this.composerInputEl || this.selectedMentions.length === 0) {
			return;
		}

		const content = this.composerInputEl.value;
		const syncedMentions = this.selectedMentions.filter((mention) => content.includes(this.getMentionLink(mention)));
		if (syncedMentions.length === this.selectedMentions.length) {
			return;
		}

		this.selectedMentions = syncedMentions;
		this.renderMentionTags();
	}

	private getMentionLink(mention: MentionedItem): string {
		return `[[${mention.basename}]]`;
	}

	private removeMentionedItemByPath(path: string): void {
		this.selectedMentions = this.selectedMentions.filter((selectedMention) => selectedMention.path !== path);
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
		this.mentionResults = [];
		this.selectedMentionResultIndex = 0;
	}

	private getUnavailableMentionPaths(): Set<string> {
		const paths = new Set(this.selectedMentions.map((mention) => mention.path));
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

		const hasMessage = this.composerInputEl.value.trim().length > 0 || this.selectedMentions.length > 0;
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
		const mentionSnapshots = [...this.selectedMentions];
		if (!content && mentionSnapshots.length === 0) {
			this.updateSendButtonState();
			return;
		}

		if (!this.isHealthy) {
			this.updateSendButtonState();
			return;
		}

		this.composerInputEl.value = "";
		this.selectedMentions = [];
		this.renderMentionTags();
		this.closeMentionPopover();
		this.messages.push({ role: "user", content, mentions: mentionSnapshots });
		const fileMessages = await this.createFileContextMessages(mentionSnapshots);
		this.messages.push(...fileMessages);
		const porygonMessage: ChatMessage = { role: "porygon", content: this.plugin.settings.ollamaThinking ? "" : "Thinking..." };
		this.messages.push(porygonMessage);
		this.isStreaming = true;
		this.updateSendButtonState();
		this.renderMessages();

		try {
			let thinkingStartedAt: number | null = null;
			let hasStartedStreamingContent = false;
			await streamLocalAgent({
				app: this.plugin.app,
				ollamaHost: this.getOllamaBaseUrl(),
				ollamaChatModel: this.plugin.settings.ollamaChatModel,
				ollamaThinking: this.plugin.settings.ollamaThinking,
				personalPrompt: this.plugin.settings.personalPrompt.trim(),
				messages: await this.buildAgentMessages(porygonMessage),
			}, {
				onToolIntent: (toolIntent) => {
					if (!hasStartedStreamingContent && porygonMessage.content === "Thinking...") {
						porygonMessage.content = "";
					}
					porygonMessage.toolIntents = [...(porygonMessage.toolIntents ?? []), toolIntent];
					porygonMessage.areToolsCollapsed = false;
					this.renderMessages();
				},
				onContentDelta: (delta) => {
					if (!hasStartedStreamingContent) {
						if (porygonMessage.content === "Thinking...") {
							porygonMessage.content = "";
						}
						hasStartedStreamingContent = true;
					}

					porygonMessage.content += delta;
					this.renderMessages();
				},
				onThinkingDelta: (delta) => {
					thinkingStartedAt = thinkingStartedAt ?? Date.now();
					porygonMessage.thinking = `${porygonMessage.thinking ?? ""}${delta}`;
					porygonMessage.isThinkingCollapsed = false;
					this.renderMessages();
				},
			});

			if (porygonMessage.thinking && thinkingStartedAt !== null) {
				porygonMessage.thinkingDurationSeconds = this.getThinkingDurationSeconds(thinkingStartedAt);
				porygonMessage.isThinkingCollapsed = true;
			}
			if (porygonMessage.toolIntents && porygonMessage.toolIntents.length > 0) {
				porygonMessage.areToolsCollapsed = true;
			}
			this.renderMessages();
		} catch (error) {
			this.messages = this.messages.filter((message) => message !== porygonMessage);
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

	private getToolsTitle(message: ChatMessage): string {
		const toolCount = message.toolIntents?.length ?? 0;
		const unit = toolCount === 1 ? "tool" : "tools";
		return `${toolCount} ${unit} used`;
	}

	private getThinkingDurationSeconds(startedAt: number): number {
		return Math.max(1, Math.round((Date.now() - startedAt) / 1000));
	}

	private async buildAgentMessages(excludedMessage: ChatMessage): Promise<AgentChatMessage[]> {
		const messages = this.messages.filter((message): message is ChatMessage & { role: AgentChatMessage["role"] } =>
			(message.role === "user" || message.role === "porygon" || message.role === "file") && message !== excludedMessage,
		);
		return messages.map((message) => ({
			role: message.role,
			content: this.buildAgentMessageContent(message),
		}));
	}

	private buildAgentMessageContent(message: ChatMessage): string {
		return message.content;
	}

	private async createFileContextMessages(mentions: MentionedItem[]): Promise<ChatMessage[]> {
		const fileMentions = mentions.flatMap((mention) => mention.files);
		return Promise.all(fileMentions.map(async (mentionFile): Promise<ChatMessage> => {
			const file = this.plugin.app.vault.getAbstractFileByPath(mentionFile.path);
			if (!(file instanceof TFile)) {
				return { role: "file", content: `Attached Obsidian file not found: ${mentionFile.path}` };
			}

			const content = await this.plugin.app.vault.cachedRead(file);
			return { role: "file", content: `<file path="${file.path}">\n${content}\n</file>` };
		}));
	}

	private toMentionedItem(result: MentionSearchResult): MentionedItem {
		return {
			type: result.type,
			path: result.path,
			basename: result.type === "active-note" ? result.files[0]?.basename ?? result.label : result.path.split("/").last() ?? result.label,
			files: result.files.map((file) => this.toMentionedFile(file)),
		};
	}

	private toMentionedFile(file: TFile): MentionedFile {
		return { path: file.path, basename: file.basename };
	}

	private getMentionIcon(type: MentionType): string {
		if (type === "folder") {
			return "folder";
		}

		if (type === "active-note") {
			return "star";
		}

		return "sticky-note";
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
