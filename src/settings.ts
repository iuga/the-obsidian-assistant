export interface AssistantPluginSettings {
	ollamaHost: string;
	ollamaChatModel: string;
	ollamaEmbeddingModel: string;
	ollamaThinking: boolean;
	chatSystemPrompt: string;
}

export const DEFAULT_CHAT_SYSTEM_PROMPT = "You are a helpful assistant that helps users to find answers in its own notes.\nYour answers are alwas concise and to the point, you never use buzzwords.\nBe friendly and polite.\nTry to avoid emojis as much as possible except when the user uses them first or are key for a better understanding.";

export const DEFAULT_SETTINGS: AssistantPluginSettings = {
	ollamaHost: "",
	ollamaChatModel: "",
	ollamaEmbeddingModel: "",
	ollamaThinking: false,
	chatSystemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
};

export const ONBOARDING_DEFAULTS: AssistantPluginSettings = {
	ollamaHost: "http://localhost:11434",
	ollamaChatModel: "gemma4",
	ollamaEmbeddingModel: "nomic-embed-text",
	ollamaThinking: false,
	chatSystemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
};
