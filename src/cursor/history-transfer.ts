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
		const archivePath = await this.save(prompt, scope), imports: CursorPrompt[] = [];
		const size = Math.max(1024, Math.floor(maximum));
		for (let offset = 0; offset < prompt.text.length;) {
			let end = Math.min(prompt.text.length, offset + size);
			if (end < prompt.text.length && /[\uD800-\uDBFF]/.test(prompt.text[end - 1])) { end--; }
			imports.push({ text: prompt.text.slice(offset, end) }); offset = end;
		}
		for (let index = 0; index < (prompt.images?.length ?? 0); index += 5) {
			imports.push({ text: `Quoted history image attachments ${index + 1} through ${Math.min(index + 5, prompt.images!.length)}.`, images: prompt.images!.slice(index, index + 5) });
		}
		return { imports, archivePath, prompt: { text: `All history parts have been imported in order. Continue the latest user request normally with the supplied VS Code tools. The complete transcript remains at ${JSON.stringify(archivePath)}; reread exact details when compaction leaves them uncertain. Do not repeat historical actions.` } };
	}
}