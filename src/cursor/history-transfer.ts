import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CursorPrompt } from "./api-client";
import * as vscode from "vscode";
import type { SDKCustomToolResult } from "@cursor/sdk";
import { cursorToolResult } from "./tool-bridge";
import { cursorTranscript } from "./message-adapter";
import { prepareSharedHandoff, sharedImageName, estimateSharedTextTokens } from "../context/provider-handoff";

export class CursorHistoryArchive {
	constructor(private readonly root: string) {}
	async toolResult(result: vscode.LanguageModelToolResultPart, scope: string): Promise<SDKCustomToolResult> {
		const converted = cursorToolResult(result);
		const texts = converted.content.filter(part => part.type === "text");
		const text = texts.map(part => part.text).join("\n");
		if (text.length <= 100_000) { return converted; }
		const file = await this.save({ text }, scope);
		return { content: [{ type: "text", text: `${text.slice(0, 60_000)}\n[Large tool output archived]\n${text.slice(-30_000)}\nComplete tool result: ${JSON.stringify(file)}. Use VS Code file/search tools before relying on omitted details.` }, ...converted.content.filter(part => part.type !== "text")] };
	}
	async save(prompt: CursorPrompt, scope: string): Promise<string> {
		const dir = path.join(this.root, createHash("sha256").update(scope).digest("hex"));
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		const references: string[] = [];
		for (const [index, image] of (prompt.images ?? []).entries()) {
			const bytes = Buffer.from(image.data, "base64"), imageFile = path.join(dir, sharedImageName(bytes, image.mimeType));
			await fs.writeFile(imageFile, bytes, { mode: 0o600 }); references.push(`[Image attachment ${index + 1}: ${JSON.stringify(imageFile)}; ${image.mimeType}]`);
		}
		const text = prompt.text + (references.length ? `\n${references.join("\n")}` : "");
		const file = path.join(dir, `${createHash("sha256").update(text).digest("hex")}.txt`);
		await fs.writeFile(file, text, { mode: 0o600 }); return file;
	}
	async prepare(prompt: CursorPrompt, maximum: number, scope: string): Promise<{ imports: CursorPrompt[]; prompt: CursorPrompt; archivePath?: string }> {
		if (prompt.text.length <= maximum && (prompt.images?.length ?? 0) <= 5) { return { imports: [], prompt }; }
		const archivePath = await this.save(prompt, scope);
		throw new Error(`Cursor history exceeds one request's working budget or five images. No inference requests were sent. Full transcript: ${archivePath}. Compact the chat, choose a larger supported context, or start a new chat. Automatic multi-prompt imports are disabled.`);
	}
	async coldHandoff(messages: readonly vscode.LanguageModelChatRequestMessage[], original: CursorPrompt, tokenBudget: number, scope: string): Promise<{ prompt: CursorPrompt; archivePath?: string; estimatedTokens?: number }> {
		const structured = cursorTranscript(messages);
		if (structured.text !== original.text || (structured.images?.length ?? 0) !== (original.images?.length ?? 0)
			|| structured.images?.some((image, index) => image.data !== original.images?.[index].data || image.mimeType !== original.images?.[index].mimeType)) {
			if (estimateSharedTextTokens(original.text) + (original.images?.length ?? 0) * 4096 + 16 <= tokenBudget && (original.images?.length ?? 0) <= 5) { return { prompt: original }; }
			const file = await this.save(original, scope);
			throw new Error(`Cannot prepare an unstructured Cursor prompt without losing its instructions. No inference requests were sent. Full transcript: ${file}`);
		}
		let plan = prepareSharedHandoff(messages, tokenBudget);
		const archivePath = plan.wasCompacted ? await this.save(original, scope) : undefined;
		if (archivePath) { plan = prepareSharedHandoff(messages, tokenBudget, archivePath); }
		const prompt = cursorTranscript(plan.compacted);
		if ((prompt.images?.length ?? 0) > 5) { throw new Error("Cursor accepts at most five current images; no inference was started."); }
		return { prompt, archivePath, estimatedTokens: plan.tokenEstimateAfter };
	}
}