import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { CocoPromptContent } from "./acp-client";
import { serializeCocoTranscript } from "./message-adapter";
import { convertCocoToolResult } from "./turn-bridge";

export interface CocoHistoryTransfer { imports: CocoPromptContent[][]; prompt: CocoPromptContent[]; archivePath?: string; compacted?: boolean; originalChars?: number; sentChars?: number }
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
	async save(parts: readonly CocoPromptContent[], scope: string): Promise<string> {
		const directory = path.join(this.root, createHash("sha256").update(scope).digest("hex"));
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		const lines: string[] = [];
		for (const part of parts) {
			if (part.type === "text") { lines.push(part.text); continue; }
			const bytes = Buffer.from(part.data, "base64");
			const file = path.join(directory, `${createHash("sha256").update(bytes).digest("hex")}.${part.mimeType === "image/png" ? "png" : part.mimeType === "image/jpeg" ? "jpg" : part.mimeType === "image/webp" ? "webp" : "image"}`);
			await fs.writeFile(file, bytes, { mode: 0o600 }); lines.push(`\n[Image attachment: ${JSON.stringify(file)}; ${part.mimeType}]\n`);
		}
		const text = lines.join("");
		const file = path.join(directory, `${createHash("sha256").update(text).digest("hex")}.txt`);
		await fs.writeFile(file, text, { mode: 0o600 });
		return file;
	}
	async prepare(messages: readonly vscode.LanguageModelChatRequestMessage[], scope: string, targetChars = 1_000_000): Promise<CocoHistoryTransfer> {
		const parts = serializeCocoTranscript(messages);
		const bytes = payloadBytes(parts);
		if (bytes > this.maximumBytes) {
			const archivePath = await this.save(parts, scope);
			throw new Error(`The Coco history payload exceeds the bridge transport safety limit (${bytes} encoded bytes, maximum ${this.maximumBytes}). This is not a model token limit. No inference was started. Reduce large attachments or compact the source chat. Full transcript: ${archivePath}`);
		}
		const size = (blocks: readonly CocoPromptContent[]) => blocks.reduce((n,p) => n + (p.type === "text" ? p.text.length : 0),0);
		const budget = Math.max(16_384, Math.floor(targetChars));
		let latest = messages.length - 1;
		for (; latest >= 0; latest--) {
			if (messages[latest].role === vscode.LanguageModelChatMessageRole.User && messages[latest].content.some(part =>
				part instanceof vscode.LanguageModelTextPart && part.value.trim() || part instanceof vscode.LanguageModelDataPart)) { break; }
		}
		latest = Math.max(0,latest);
		// This is a working target, never an assertion about the model tokenizer.
		// Native compaction cannot reliably bootstrap a multi-megabyte user message.
		const originalChars = size(parts);
		if (originalChars <= budget) {
			const history = serializeCocoTranscript(messages.slice(0,latest)).map(part => part.type === "text" ? { ...part,text:part.text.replace(/@/g,"\\u0040") } : part);
			return { imports: [], prompt: [...history,...serializeCocoTranscript(messages.slice(latest))] };
		}
		const archivePath = await this.save(parts, scope);
		const current = serializeCocoTranscript(messages.slice(latest));
		const note = `Earlier conversation was compacted locally for this handoff. The current request below is complete. Older tool output, images and omitted text remain in the exact archive: ${JSON.stringify(archivePath)}. Read/search that archive with VS Code tools when an earlier detail matters; do not assume excerpts contain every requirement. Historical @ signs are encoded as \\u0040 to prevent automatic attachment loading. Do not repeat historical actions.\n`;
		if (size(current) + note.length > budget) {
			throw new Error(`The latest Coco request alone exceeds the handoff working target. Earlier history was archived at ${archivePath}; reduce the current request or attachments. No inference was started.`);
		}
		const excerpt = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0,Math.floor(limit * .6))}\n[Historical excerpt; full text in archive]\n${text.slice(-Math.floor(limit * .4))}`;
		const history = messages.slice(0,latest).map((message,index) => {
			// Tool output dominates long chats. Keep requirements and answers in
			// preference to logs, and leave historical images in the exact archive.
			const content = message.content.map(part => {
				if (part instanceof vscode.LanguageModelToolResultPart) {
					return new vscode.LanguageModelTextPart(`[Historical tool result ${part.callId}]\n${excerpt(convertCocoToolResult(part,Infinity).output,2_000)}`);
				}
				if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) {
					return new vscode.LanguageModelTextPart(`[Historical ${part.mimeType} attachment; original bytes in archive]`);
				}
				return part;
			});
			const blocks = serializeCocoTranscript([{ ...message, content }]);
			const value = blocks.map(part => part.type === "text" ? part.text : "[Historical attachment in archive]").join("").replace(/@/g,"\\u0040");
			return { index, user: message.role === vscode.LanguageModelChatMessageRole.User && message.content.some(p => p instanceof vscode.LanguageModelTextPart && p.value.trim()), text: value };
		});
		let remaining = budget - size(current) - note.length - 1_024;
		const kept = new Map<number,string>();
		const keep = (entry: typeof history[number], limit: number) => {
			if (remaining < 256 || kept.has(entry.index)) { return; }
			const value = excerpt(entry.text,Math.max(0,Math.min(limit,remaining) - 128));
			kept.set(entry.index,value); remaining -= value.length;
		};
		if (history[0]) { keep(history[0],Math.floor(remaining / 4)); }
		// Preserve all reasonably sized user instructions before filling with
		// recent assistant/tool context, rather than retaining only the tail.
		for (const entry of history.filter(e => e.user)) { keep(entry,Math.min(16_000,Math.floor(remaining / 2))); }
		for (const entry of [...history].reverse()) { keep(entry,Math.min(32_000,remaining)); }
		const text = note + [...kept].sort(([a],[b]) => a-b).map(([,value]) => value).join("\n");
		const prompt: CocoPromptContent[] = [{type:"text",text}, ...current];
		return { imports: [], prompt, archivePath, compacted: true, originalChars, sentChars: size(prompt) };
	}
	async toolResult(result: vscode.LanguageModelToolResultPart, scope: string): Promise<{ output: string }> {
		const full = convertCocoToolResult(result, Infinity).output;
		if (full.length <= 100_000) { return { output: full }; }
		const file = await this.save([{ type: "text", text: full }], scope);
		return { output: `${convertCocoToolResult(result).output}\nFull tool output: ${JSON.stringify(file)}. The omitted middle is available in that file. Read/search it with VS Code tools before relying on omitted content.` };
	}
}