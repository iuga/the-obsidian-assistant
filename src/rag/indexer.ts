import { OllamaEmbeddings } from "@langchain/ollama";
import { App, TFile } from "obsidian";
import { PorygonPluginSettings } from "../settings";
import { buildMarkdownChunks } from "./chunks";
import { float32ArrayToArrayBuffer, RagIndexedDbStore } from "./indexeddb-store";
import { RagChunkRecord, RagFileRecord, RagIndexProgress, RagVectorRecord } from "./types";

const INDEX_BATCH_SIZE = 1;
const INDEX_YIELD_MS = 25;
const MODIFY_DEBOUNCE_MS = 1500;
const MAX_CHUNKS_PER_FILE = 256;
const EMBEDDING_BATCH_SIZE = 16;

export class RagIndexer {
	private app: App;
	private settings: PorygonPluginSettings;
	private store: RagIndexedDbStore;
	private queue: TFile[] = [];
	private queuedPaths = new Set<string>();
	private isRunning = false;
	private isReconciling = false;
	private disposed = false;
	private cachedEmbeddings: { host: string; model: string; client: OllamaEmbeddings } | null = null;
	private progress: RagIndexProgress = {
		status: "idle",
		indexedFiles: 0,
		totalFiles: 0,
		queuedFiles: 0,
	};
	private listeners = new Set<(progress: RagIndexProgress) => void>();
	private modifyDebounceTimeouts = new Map<string, number>();

	constructor(app: App, settings: PorygonPluginSettings, store: RagIndexedDbStore) {
		this.app = app;
		this.settings = settings;
		this.store = store;
	}

	getProgress(): RagIndexProgress {
		return { ...this.progress };
	}

	onProgress(listener: (progress: RagIndexProgress) => void): () => void {
		this.listeners.add(listener);
		listener(this.getProgress());
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		this.disposed = true;
		for (const timeout of this.modifyDebounceTimeouts.values()) {
			window.clearTimeout(timeout);
		}
		this.modifyDebounceTimeouts.clear();
		this.queue = [];
		this.queuedPaths.clear();
		this.listeners.clear();
		this.cachedEmbeddings = null;
	}

	async reconcile(): Promise<void> {
		if (this.disposed || this.isReconciling) {
			return;
		}

		this.isReconciling = true;
		try {
			const markdownFiles = this.app.vault.getMarkdownFiles().filter((file) => !this.isIgnored(file.path));
			const vaultPaths = new Set(markdownFiles.map((file) => file.path));
			const indexedFiles = await this.store.getAllFiles();
			await Promise.all(indexedFiles
				.filter((file) => !vaultPaths.has(file.path))
				.map((file) => this.store.deleteFile(file.path)));

			this.setProgress({
				status: markdownFiles.length > 0 ? "indexing" : "ready",
				indexedFiles: 0,
				totalFiles: markdownFiles.length,
				queuedFiles: this.queue.length,
				lastError: undefined,
			});

			const embeddingConfig = this.getEmbeddingConfig();
			for (const file of markdownFiles) {
				if (this.disposed) {
					return;
				}

				const content = await this.app.vault.cachedRead(file);
				const contentHash = await hashText(content);
				const isFresh = await this.store.isFileFresh({
					path: file.path,
					mtime: file.stat.mtime,
					size: file.stat.size,
					contentHash,
					embeddingConfig,
				});
				if (!isFresh) {
					this.enqueue(file, { content, contentHash });
				} else {
					this.setProgress({ indexedFiles: this.progress.indexedFiles + 1 });
				}
				await sleep(0);
			}

			this.start();
		} finally {
			this.isReconciling = false;
		}
	}

	enqueue(file: TFile, _prefetched?: { content: string; contentHash: string }): void {
		if (this.disposed || this.isIgnored(file.path) || this.queuedPaths.has(file.path)) {
			return;
		}

		this.queue.push(file);
		this.queuedPaths.add(file.path);
		this.setProgress({
			status: "indexing",
			queuedFiles: this.queue.length,
			totalFiles: Math.max(this.progress.totalFiles, this.progress.indexedFiles + this.queue.length),
		});
		this.start();
	}

	debounceEnqueue(file: TFile): void {
		if (this.disposed) {
			return;
		}

		const existingTimeout = this.modifyDebounceTimeouts.get(file.path);
		if (existingTimeout !== undefined) {
			window.clearTimeout(existingTimeout);
		}

		const timeout = window.setTimeout(() => {
			this.modifyDebounceTimeouts.delete(file.path);
			this.enqueue(file);
		}, MODIFY_DEBOUNCE_MS);
		this.modifyDebounceTimeouts.set(file.path, timeout);
	}

	async deleteFile(path: string): Promise<void> {
		const existingTimeout = this.modifyDebounceTimeouts.get(path);
		if (existingTimeout !== undefined) {
			window.clearTimeout(existingTimeout);
			this.modifyDebounceTimeouts.delete(path);
		}

		this.queue = this.queue.filter((file) => file.path !== path);
		this.queuedPaths.delete(path);
		await this.store.deleteFile(path);
		this.setProgress({ queuedFiles: this.queue.length });
	}

	updateSettings(settings: PorygonPluginSettings): void {
		const shouldReconcile = this.settings.ollamaHost !== settings.ollamaHost ||
			this.settings.ollamaEmbeddingModel !== settings.ollamaEmbeddingModel ||
			this.settings.ragIgnoredPaths !== settings.ragIgnoredPaths;
		this.settings = settings;
		if (shouldReconcile) {
			this.cachedEmbeddings = null;
			void this.reconcile();
		}
	}

	private start(): void {
		if (this.isRunning || this.disposed) {
			return;
		}

		this.isRunning = true;
		void this.processQueue();
	}

	private async processQueue(): Promise<void> {
		try {
			while (this.queue.length > 0) {
				if (this.disposed) {
					return;
				}

				const batch = this.queue.splice(0, INDEX_BATCH_SIZE);
				for (const file of batch) {
					this.queuedPaths.delete(file.path);
					await this.indexFile(file);
					this.setProgress({
						indexedFiles: this.progress.indexedFiles + 1,
						queuedFiles: this.queue.length,
						lastIndexedAt: Date.now(),
					});
				}
				await sleep(INDEX_YIELD_MS);
			}
		} catch (error) {
			this.setProgress({
				status: "error",
				lastError: error instanceof Error ? error.message : String(error),
			});
			this.isRunning = false;
			return;
		}

		this.isRunning = false;
		// Re-check after releasing the running flag in case work was enqueued
		// between the loop exit and this point.
		if (this.queue.length > 0) {
			this.start();
			return;
		}

		this.setProgress({ status: "ready", queuedFiles: 0 });
	}

	private async indexFile(file: TFile): Promise<void> {
		const content = await this.app.vault.cachedRead(file);
		const contentHash = await hashText(content);
		const chunks = await buildMarkdownChunks({
			path: file.path,
			basename: file.basename,
			content,
			mtime: file.stat.mtime,
			size: file.stat.size,
		});
		const cappedChunks = chunks.length > MAX_CHUNKS_PER_FILE ? chunks.slice(0, MAX_CHUNKS_PER_FILE) : chunks;
		if (chunks.length > MAX_CHUNKS_PER_FILE) {
			console.warn(`[Porygon RAG] truncating ${file.path}: ${chunks.length} chunks exceeds cap of ${MAX_CHUNKS_PER_FILE}`);
		}

		const embeddings = this.getEmbeddingsClient();
		const vectors: number[][] = [];
		for (let offset = 0; offset < cappedChunks.length; offset += EMBEDDING_BATCH_SIZE) {
			if (this.disposed) {
				return;
			}

			const batchTexts = cappedChunks.slice(offset, offset + EMBEDDING_BATCH_SIZE).map((chunk) => chunk.text);
			const batchVectors = await embeddings.embedDocuments(batchTexts);
			vectors.push(...batchVectors);
		}

		const now = Date.now();
		const chunkRecords: RagChunkRecord[] = cappedChunks.map((chunk) => ({
			...chunk,
			embeddingModel: this.settings.ollamaEmbeddingModel,
			createdAt: now,
		}));
		const vectorRecords: RagVectorRecord[] = vectors.map((vector, index) => ({
			chunkId: cappedChunks[index]?.id ?? `${file.path}#${index}`,
			path: file.path,
			embeddingModel: this.settings.ollamaEmbeddingModel,
			dimensions: vector.length,
			vector: float32ArrayToArrayBuffer(new Float32Array(vector)),
			createdAt: now,
		}));
		const fileRecord: RagFileRecord = {
			path: file.path,
			mtime: file.stat.mtime,
			size: file.stat.size,
			contentHash,
			embeddingConfig: this.getEmbeddingConfig(),
			embeddingModel: this.settings.ollamaEmbeddingModel,
			indexedAt: now,
			chunkCount: cappedChunks.length,
		};

		await this.store.replaceFile({ file: fileRecord, chunks: chunkRecords, vectors: vectorRecords });
	}

	private getEmbeddingsClient(): OllamaEmbeddings {
		const host = this.settings.ollamaHost;
		const model = this.settings.ollamaEmbeddingModel;
		if (!this.cachedEmbeddings || this.cachedEmbeddings.host !== host || this.cachedEmbeddings.model !== model) {
			this.cachedEmbeddings = {
				host,
				model,
				client: new OllamaEmbeddings({ baseUrl: host, model }),
			};
		}
		return this.cachedEmbeddings.client;
	}

	private isIgnored(path: string): boolean {
		const patterns = this.settings.ragIgnoredPaths
			.split(/\r?\n/)
			.map((pattern) => pattern.trim())
			.filter(Boolean);
		return patterns.some((pattern) => matchesIgnoredPath(path, pattern));
	}

	private getEmbeddingConfig(): string {
		return `${this.settings.ollamaHost}|${this.settings.ollamaEmbeddingModel}`;
	}

	private setProgress(progress: Partial<RagIndexProgress>): void {
		this.progress = { ...this.progress, ...progress };
		for (const listener of this.listeners) {
			listener(this.getProgress());
		}
	}
}

// Standard glob semantics:
//   - `*` matches any run of characters except `/`
//   - `**` matches across path separators
//   - a trailing `/` (or a bare folder name) matches everything inside
export function matchesIgnoredPath(path: string, pattern: string): boolean {
	const normalizedPath = normalizeIndexPath(path);
	const normalizedPattern = normalizeIndexPath(pattern);
	if (!normalizedPattern) {
		return false;
	}

	if (normalizedPattern.includes("*")) {
		const regex = globToRegExp(normalizedPattern);
		return regex.test(normalizedPath);
	}

	return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern.replace(/\/$/, "")}/`);
}

function globToRegExp(pattern: string): RegExp {
	let regex = "";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index] ?? "";
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				regex += ".*";
				index += 1;
			} else {
				regex += "[^/]*";
			}
			continue;
		}

		regex += /[.+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
	}
	return new RegExp(`^${regex}$`);
}

async function hashText(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeIndexPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
