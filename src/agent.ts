import { AIMessageChunk, BaseMessageLike } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ChatOllama } from "@langchain/ollama";
import { App, normalizePath, prepareSimpleSearch, TFile } from "obsidian";
import { createAgent } from "langchain";
import { z } from "zod";

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

interface SearchResult {
	note: string;
	lines: number[];
}

interface CreateResult {
	status: "success" | "failure";
	filename: string;
	sizeBytes: number;
	message?: string;
}

export const currentTimestampTool = tool(
	() => new Date().toISOString(),
	{
		name: "current_timestamp",
		description: "Returns the current timestamp in ISO 8601 format.",
		schema: z.object({}),
	}
);

export function createSearchTool(app: App) {
	return tool(
		async ({ queryString }: { queryString: string }): Promise<string> => {
			const search = prepareSimpleSearch(queryString);
			const results: SearchResult[] = [];

			for (const file of app.vault.getMarkdownFiles()) {
				const content = await app.vault.cachedRead(file);
				const lines = content.split(/\r?\n/);
				const matchingLines: number[] = [];

				lines.forEach((line, index) => {
					if (search(line)) {
						matchingLines.push(index + 1);
					}
				});

				if (matchingLines.length > 0) {
					results.push({ note: file.path, lines: matchingLines });
				}
			}

			return JSON.stringify(results);
		},
		{
			name: "search",
			description: "Searches all markdown notes for the query string and returns a JSON string of matching note paths with 1-based line numbers.",
			schema: z.object({
				queryString: z.string().describe("The query string to search for in all markdown notes."),
			}),
		}
	);
}

export function createListTool(app: App) {
	return tool(
		({ filter = "" }: { filter?: string }): string => {
			const trimmedFilter = filter.trim();
			const regex = trimmedFilter ? new RegExp(trimmedFilter) : null;
			const notes = app.vault.getMarkdownFiles()
				.filter((file) => !regex || regex.test(file.basename) || regex.test(file.name) || regex.test(file.path))
				.map((file) => file.path);

			return JSON.stringify(notes);
		},
		{
			name: "list",
			description: "Lists markdown note paths. If filter is provided, only returns notes whose filename or path matches the regex filter. Returns a JSON string array.",
			schema: z.object({
				filter: z.string().optional().default("").describe("Optional regex used to filter note filenames or paths."),
			}),
		}
	);
}

export function createViewTool(app: App) {
	return tool(
		async ({ linkToMarkdownfile, line, surrounding = 5 }: { linkToMarkdownfile: string; line?: number; surrounding?: number }): Promise<string> => {
			const file = resolveMarkdownFile(app, linkToMarkdownfile);
			if (!file) {
				return `Note not found: ${linkToMarkdownfile}`;
			}

			const content = await app.vault.cachedRead(file);
			if (line === undefined) {
				return content;
			}

			const lines = content.split(/\r?\n/);
			const targetIndex = Math.max(0, Math.min(lines.length - 1, line - 1));
			const surroundingLineCount = Math.max(0, surrounding);
			const startIndex = Math.max(0, targetIndex - surroundingLineCount);
			const endIndex = Math.min(lines.length - 1, targetIndex + surroundingLineCount);
			const selectedLines = lines.slice(startIndex, endIndex + 1);

			return selectedLines.map((lineContent, index) => `${startIndex + index + 1}: ${lineContent}`).join("\n");
		},
		{
			name: "view",
			description: "Reads a markdown note. If line is provided, returns that 1-based line with surrounding lines before and after it; otherwise returns the full file.",
			schema: z.object({
				linkToMarkdownfile: z.string().describe("The note path or wikilink to read."),
				line: z.number().int().positive().optional().describe("Optional 1-based line number to center the returned excerpt on."),
				surrounding: z.number().int().min(0).optional().default(5).describe("Optional number of lines before and after the target line. Defaults to 5."),
			}),
		}
	);
}

export function createCreateTool(app: App) {
	return tool(
		async ({ filenameMd, contentInMarkdown }: { filenameMd: string; contentInMarkdown: string }): Promise<string> => {
			const filename = normalizeMarkdownPath(filenameMd);
			const sizeBytes = new TextEncoder().encode(contentInMarkdown).byteLength;

			try {
				if (app.vault.getAbstractFileByPath(filename)) {
					return stringifyCreateResult({
						status: "failure",
						filename,
						sizeBytes,
						message: "A note already exists at this path.",
					});
				}

				await app.vault.create(filename, contentInMarkdown);
				return stringifyCreateResult({ status: "success", filename, sizeBytes });
			} catch (error) {
				return stringifyCreateResult({
					status: "failure",
					filename,
					sizeBytes,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		},
		{
			name: "create",
			description: "Creates a new markdown note and returns a JSON string status with success or failure, filename, and size in bytes.",
			schema: z.object({
				filenameMd: z.string().describe("The markdown note path or filename to create. .md is appended if missing."),
				contentInMarkdown: z.string().describe("The markdown content to write into the new note."),
			}),
		}
	);
}

export async function streamLocalAgent(options: LocalAgentOptions, handlers: LocalAgentStreamHandlers = {}): Promise<LocalAgentResponse> {
	const agent = createAgent({
		model: new ChatOllama({
			baseUrl: options.ollamaHost,
			model: options.ollamaChatModel,
			think: options.ollamaThinking,
		}),
		tools: [currentTimestampTool, createSearchTool(options.app), createListTool(options.app), createViewTool(options.app), createCreateTool(options.app)],
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

function normalizeMarkdownPath(filenameMd: string): string {
	const normalizedFilename = normalizePath(stripWikiLinkSyntax(filenameMd).replace(/\\/g, "/"));
	return normalizedFilename.endsWith(".md") ? normalizedFilename : `${normalizedFilename}.md`;
}

function stringifyCreateResult(result: CreateResult): string {
	return JSON.stringify(result);
}

function resolveMarkdownFile(app: App, linkToMarkdownfile: string): TFile | null {
	const normalizedLink = stripWikiLinkSyntax(linkToMarkdownfile).replace(/\\/g, "/");
	const withoutSubpath = normalizedLink.split("#")[0] ?? normalizedLink;
	const withoutAlias = withoutSubpath.split("|")[0] ?? withoutSubpath;
	const trimmedPath = withoutAlias.trim();
	const pathCandidates = trimmedPath.endsWith(".md") ? [trimmedPath] : [trimmedPath, `${trimmedPath}.md`];

	for (const pathCandidate of pathCandidates) {
		const file = app.vault.getAbstractFileByPath(pathCandidate);
		if (file instanceof TFile) {
			return file;
		}
	}

	const destination = app.metadataCache.getFirstLinkpathDest(trimmedPath, "");
	return destination instanceof TFile ? destination : null;
}

function stripWikiLinkSyntax(link: string): string {
	const trimmedLink = link.trim();
	if (trimmedLink.startsWith("[[") && trimmedLink.endsWith("]]")) {
		return trimmedLink.slice(2, -2);
	}

	return trimmedLink;
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
