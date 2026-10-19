import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CursorPrompt } from "./api-client";
import type * as vscode from "vscode";
import type { SDKCustomToolResult } from "@cursor/sdk";
import { cursorToolResult } from "./tool-bridge";

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
			const bytes = Buffer.from(image.data, "base64"), imageFile = path.join(dir, `${createHash("sha256").update(bytes).digest("hex")}.image`);
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
}