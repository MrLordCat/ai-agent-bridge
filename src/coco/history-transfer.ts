import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { CocoPromptContent } from "./acp-client";
import { serializeCocoTranscript } from "./message-adapter";
import { convertCocoToolResult } from "./turn-bridge";
import { prepareSharedHandoff, sharedContextBudget, sharedImageName } from "../context/provider-handoff";
import { canonicalConversationUserAnchors } from "../providers/conversation-anchors";

export interface CocoHistoryTransfer { imports: CocoPromptContent[][]; prompt: CocoPromptContent[]; archivePath?: string; compacted?: boolean; originalChars?: number; sentChars?: number; estimatedTokens?: number; tokenBudget?: number }
/** Memory/IPC guard only; this is not a model context or token limit. */
export const COCO_MAX_PROMPT_BYTES = 64 * 1024 * 1024;

function payloadBytes(parts: readonly CocoPromptContent[]): number {
	return parts.reduce((bytes, part, index) => bytes + Buffer.byteLength(JSON.stringify(part), "utf8") + (index ? 1 : 0), 2);
}

/** Split lossless content at a bounded text size; no middle excerpts are discarded. */
export function splitCocoHistory(parts: readonly CocoPromptContent[], maximum: number): CocoPromptContent[][] {
	const size = Number.isFinite(maximum) ? Math.max(1024, Math.floor(maximum)) : 4096;
	const chunks: CocoPromptContent[][] = []; let current: CocoPromptContent[] = [], used = 0;
	for (const part of parts) {
		if (part.type === "image") { current.push(part); continue; }
		let offset = 0;
		while (offset < part.text.length) {
			if (used >= size) { chunks.push(current); current = []; used = 0; }
			let end = Math.min(part.text.length, offset + size - used);
			if (end < part.text.length && /[\uD800-\uDBFF]/.test(part.text[end - 1])) { end--; }
			if (end === offset) { chunks.push(current); current = []; used = 0; continue; }
			current.push({ type: "text", text: part.text.slice(offset, end) }); used += end - offset; offset = end;
		}
	}
	if (current.length) { chunks.push(current); }
	return chunks;
}

/** Workspace-private copies preserve details even after native model compaction. */
export class CocoHistoryArchive {
	constructor(private readonly root: string, private readonly maximumBytes = COCO_MAX_PROMPT_BYTES) {}
	/**
	 * Deletes archived transcripts and images not written for `maxAgeMs`. Each
	 * save rewrites the files it references, so a live conversation keeps its
	 * own. Only the per-scope hash directories are touched: the same root also
	 * holds the session store.
	 */
	async prune(maxAgeMs: number): Promise<number> {
		const cutoff = Date.now() - maxAgeMs;
		let removed = 0;
		const scopes = await fs.readdir(this.root, { withFileTypes: true }).catch(() => []);
		for (const scope of scopes) {
			if (!scope.isDirectory() || !/^[0-9a-f]{64}$/.test(scope.name)) { continue; }
			const directory = path.join(this.root, scope.name);
			const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
			let kept = 0;
			for (const file of files) {
				const filePath = path.join(directory, file.name);
				const stat = file.isFile() ? await fs.stat(filePath).catch(() => undefined) : undefined;
				if (stat && stat.mtimeMs < cutoff) {
					await fs.rm(filePath, { force: true });
					removed++;
				} else {
					kept++;
				}
			}
			if (!kept) { await fs.rmdir(directory).catch(() => undefined); }
		}
		return removed;
	}
	async save(parts: readonly CocoPromptContent[], scope: string): Promise<string> {
		const directory = path.join(this.root, createHash("sha256").update(scope).digest("hex"));
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		const lines: string[] = [];
		for (const part of parts) {
			if (part.type === "text") { lines.push(part.text); continue; }
			const bytes = Buffer.from(part.data, "base64");
			const file = path.join(directory, sharedImageName(bytes, part.mimeType));
			await fs.writeFile(file, bytes, { mode: 0o600 }); lines.push(`\n[Image attachment: ${JSON.stringify(file)}; ${part.mimeType}]\n`);
		}
		const text = lines.join("");
		const file = path.join(directory, `${createHash("sha256").update(text).digest("hex")}.txt`);
		await fs.writeFile(file, text, { mode: 0o600 });
		return file;
	}
	async prepare(messages: readonly vscode.LanguageModelChatRequestMessage[], scope: string, tokenBudget = sharedContextBudget(1_000_000)): Promise<CocoHistoryTransfer> {
		const parts = serializeCocoTranscript(messages);
		const bytes = payloadBytes(parts);
		if (bytes > this.maximumBytes) {
			const archivePath = await this.save(parts, scope);
			throw new Error(`The Coco history payload exceeds the bridge transport safety limit (${bytes} encoded bytes, maximum ${this.maximumBytes}). This is not a model token limit. No inference was started. Reduce large attachments or compact the source chat. Full transcript: ${archivePath}`);
		}
		let plan = prepareSharedHandoff(messages, tokenBudget);
		const archivePath = plan.wasCompacted ? await this.save(parts, scope) : undefined;
		if (archivePath) { plan = prepareSharedHandoff(messages, tokenBudget, archivePath); }
		const latest = canonicalConversationUserAnchors(plan.compacted).at(-1)?.index ?? 0;
		const history = serializeCocoTranscript(plan.compacted.slice(0, latest)).map(part => part.type === "text" ? { ...part, text: part.text.replace(/@/g, "\\u0040") } : part);
		const prompt = [...history, ...serializeCocoTranscript(plan.compacted.slice(latest))];
		const size = (blocks: readonly CocoPromptContent[]) => blocks.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
		return { imports: [], prompt, archivePath, compacted: plan.wasCompacted, originalChars: size(parts), sentChars: size(prompt), estimatedTokens: plan.tokenEstimateAfter, tokenBudget };
	}
	async toolResult(result: vscode.LanguageModelToolResultPart, scope: string): Promise<{ output: string }> {
		const full = convertCocoToolResult(result, Infinity).output;
		if (full.length <= 100_000) { return { output: full }; }
		const file = await this.save([{ type: "text", text: full }], scope);
		return { output: `${convertCocoToolResult(result).output}\nFull tool output: ${JSON.stringify(file)}. The omitted middle is available in that file. Read/search it with VS Code tools before relying on omitted content.` };
	}
}