import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import type { CocoPromptContent } from "./acp-client";
import { serializeCocoTranscript } from "./message-adapter";
import { convertCocoToolResult } from "./turn-bridge";

export interface CocoHistoryTransfer { imports: CocoPromptContent[][]; prompt: CocoPromptContent[]; archivePath?: string }
const textSize = (parts: readonly CocoPromptContent[]) => parts.reduce((n, p) => n + (p.type === "text" ? p.text.length : 0), 0);

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
	constructor(private readonly root: string) {}
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
	async prepare(messages: readonly vscode.LanguageModelChatRequestMessage[], maximum: number, scope: string): Promise<CocoHistoryTransfer> {
		const parts = serializeCocoTranscript(messages);
		if (textSize(parts) <= maximum) { return { imports: [], prompt: parts }; }
		const archivePath = await this.save(parts, scope);
		const chunks = splitCocoHistory(parts, maximum);
		return { imports: chunks, prompt: [{ type: "text", text: `The complete conversation has now been imported in order. Continue its latest user request normally, using the supplied VS Code tools. Preserve its requirements and decisions. The full transcript remains available at ${JSON.stringify(archivePath)}; use file/search tools if compaction leaves any detail uncertain.` }], archivePath };
	}
	async toolResult(result: vscode.LanguageModelToolResultPart, scope: string): Promise<{ output: string }> {
		const full = convertCocoToolResult(result, Infinity).output;
		if (full.length <= 100_000) { return { output: full }; }
		const file = await this.save([{ type: "text", text: full }], scope);
		return { output: `${convertCocoToolResult(result).output}\nFull tool output: ${JSON.stringify(file)}. The omitted middle is available in that file. Read/search it with VS Code tools before relying on omitted content.` };
	}
}