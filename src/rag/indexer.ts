import { OllamaEmbeddings } from "@langchain/ollama";
import { App, TFile } from "obsidian";
import { PorygonPluginSettings } from "../settings";
import { buildMarkdownChunks } from "./chunks";
import { float32ArrayToArrayBuffer, RagIndexedDbStore } from "./indexeddb-store";
import { RagChunkRecord, RagFileRecord, RagIndexProgress, RagVectorRecord } from "./types";

const INDEX_BATCH_SIZE = 1;
const INDEX_YIELD_MS = 25;
const MODIFY_DEBOUNCE_MS = 1500;

export class RagIndexer {
	private app: App;
	private settings: PorygonPluginSettings;
	private store: RagIndexedDbStore;
	private queue: TFile[] = [];
	private queuedPaths = new Set<string>();
	private isRunning = false;
	private progress: RagIndexProgress = {
		status: "idle",
		indexedFiles: 0,
		totalFiles: 0,
		queuedFiles: 0,
	};
	private listeners = new Set<(progress: RagIndexProgress) => void>();
	private modifyDebounceTimeouts = new Map<string, number>();

	constructor(app: App, settings: PorygonPluginSettings, store = new RagIndexedDbStore()) {
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

	async reconcile(): Promise<void> {
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

		for (const file of markdownFiles) {
			const content = await this.app.vault.cachedRead(file);
			const contentHash = await hashText(content);
			const isFresh = await this.store.isFileFresh({
				path: file.path,
				mtime: file.stat.mtime,
				size: file.stat.size,
				contentHash,
				embeddingConfig: this.getEmbeddingConfig(),
			});
			if (!isFresh) {
				this.enqueue(file);
			} else {
				this.setProgress({ indexedFiles: this.progress.indexedFiles + 1 });
			}
			await sleep(0);
		}

		this.start();
	}

	enqueue(file: TFile): void {
		if (this.isIgnored(file.path) || this.queuedPaths.has(file.path)) {
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
			void this.reconcile();
		}
	}

	private start(): void {
		if (this.isRunning) {
			return;
		}

		this.isRunning = true;
		void this.processQueue();
	}

	private async processQueue(): Promise<void> {
		try {
			while (this.queue.length > 0) {
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

			this.setProgress({ status: "ready", queuedFiles: 0 });
		} catch (error) {
			this.setProgress({
				status: "error",
				lastError: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.isRunning = false;
		}
	}

	private async indexFile(file: TFile): Promise<void> {
		const content = await this.app.vault.cachedRead(file);
		const chunks = await buildMarkdownChunks({
			path: file.path,
			basename: file.basename,
			content,
			mtime: file.stat.mtime,
			size: file.stat.size,
		});
		const embeddings = new OllamaEmbeddings({
			baseUrl: this.settings.ollamaHost,
			model: this.settings.ollamaEmbeddingModel,
		});
		const vectors = chunks.length > 0 ? await embeddings.embedDocuments(chunks.map((chunk) => chunk.text)) : [];
		const now = Date.now();
		const chunkRecords: RagChunkRecord[] = chunks.map((chunk) => ({
			...chunk,
			heading: undefined,
			tags: [],
			links: [],
			embeddingModel: this.settings.ollamaEmbeddingModel,
			createdAt: now,
		}));
		const vectorRecords: RagVectorRecord[] = vectors.map((vector, index) => ({
			chunkId: chunks[index]?.id ?? `${file.path}#${index}`,
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
			contentHash: await hashText(content),
			embeddingConfig: this.getEmbeddingConfig(),
			embeddingModel: this.settings.ollamaEmbeddingModel,
			indexedAt: now,
			chunkCount: chunks.length,
		};

		await this.store.replaceFile({ file: fileRecord, chunks: chunkRecords, vectors: vectorRecords });
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

export function matchesIgnoredPath(path: string, pattern: string): boolean {
	const normalizedPath = normalizeIndexPath(path);
	const normalizedPattern = normalizeIndexPath(pattern);
	if (!normalizedPattern) {
		return false;
	}

	if (normalizedPattern.includes("*")) {
		return new RegExp(`^${escapeRegex(normalizedPattern).replace(/\\\*/g, ".*")}$`).test(normalizedPath);
	}

	return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern.replace(/\/$/, "")}/`);
}

async function hashText(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeIndexPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function escapeRegex(value: string): string {
	return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
