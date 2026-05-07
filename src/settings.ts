import defaultPersonalPrompt from "../prompts/personal.md";

export interface AssistantPluginSettings {
	ollamaHost: string;
	ollamaChatModel: string;
	ollamaEmbeddingModel: string;
	ollamaThinking: boolean;
	showToolUsage: boolean;
	personalPrompt: string;
}

export interface LegacyAssistantPluginSettings extends Partial<AssistantPluginSettings> {
	chatSystemPrompt?: string;
}

export const DEFAULT_PERSONAL_PROMPT = defaultPersonalPrompt.trim();

export const DEFAULT_SETTINGS: AssistantPluginSettings = {
	ollamaHost: "",
	ollamaChatModel: "",
	ollamaEmbeddingModel: "",
	ollamaThinking: false,
	showToolUsage: false,
	personalPrompt: DEFAULT_PERSONAL_PROMPT,
};

export const ONBOARDING_DEFAULTS: AssistantPluginSettings = {
	ollamaHost: "http://localhost:11434",
	ollamaChatModel: "gemma4",
	ollamaEmbeddingModel: "nomic-embed-text",
	ollamaThinking: false,
	showToolUsage: false,
	personalPrompt: DEFAULT_PERSONAL_PROMPT,
};
