import { AIMessageChunk, BaseMessageLike } from "@langchain/core/messages";
import { ChatOllama } from "@langchain/ollama";
import { App } from "obsidian";
import { createAgent } from "langchain";
import { createAgentTools } from "./tools";

export type AgentChatRole = "user" | "assistant";

export interface AgentChatMessage {
	role: AgentChatRole;
	content: string;
}

export interface LocalAgentOptions {
	app: App;
	ollamaHost: string;
	ollamaChatModel: string;
	ollamaThinking: boolean;
	systemPrompt: string;
	messages: AgentChatMessage[];
}

export interface LocalAgentResponse {
	content: string;
	thinking: string;
}

export interface LocalAgentStreamHandlers {
	onContentDelta?: (delta: string) => void;
	onThinkingDelta?: (delta: string) => void;
}

const MODEL_NODE_NAME = "model_request";

export async function streamLocalAgent(options: LocalAgentOptions, handlers: LocalAgentStreamHandlers = {}): Promise<LocalAgentResponse> {
	const agent = createAgent({
		model: new ChatOllama({
			baseUrl: options.ollamaHost,
			model: options.ollamaChatModel,
			think: options.ollamaThinking,
		}),
		tools: createAgentTools(options.app),
		systemPrompt: options.systemPrompt,
	});

	const stream = await agent.stream(
		{ messages: options.messages.map(toLangChainMessage) },
		{ streamMode: "messages" },
	);

	let content = "";
	let thinking = "";

	for await (const [message, metadata] of stream) {
		if (!AIMessageChunk.isInstance(message)) {
			continue;
		}

		if ((metadata as { langgraph_node?: string }).langgraph_node !== MODEL_NODE_NAME) {
			continue;
		}

		const reasoningDelta = getReasoningDelta(message);
		if (reasoningDelta) {
			thinking += reasoningDelta;
			handlers.onThinkingDelta?.(reasoningDelta);
		}

		const contentDelta = typeof message.content === "string" ? message.content : "";
		if (contentDelta) {
			content += contentDelta;
			handlers.onContentDelta?.(contentDelta);
		}
	}

	return { content, thinking };
}

function getReasoningDelta(message: AIMessageChunk): string {
	const reasoning = message.additional_kwargs?.reasoning_content;
	return typeof reasoning === "string" ? reasoning : "";
}

function toLangChainMessage(message: AgentChatMessage): BaseMessageLike {
	return {
		role: message.role,
		content: message.content,
	};
}
