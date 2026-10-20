import * as vscode from "vscode";
import type { CursorPrompt } from "./api-client";

export function cursorTranscript(messages: readonly vscode.LanguageModelChatRequestMessage[]): CursorPrompt {
	const images: NonNullable<CursorPrompt["images"]> = [];
	const content = (parts: readonly unknown[]): string => parts.map(part => {
		if (part instanceof vscode.LanguageModelTextPart) { return part.value; }
		if (part instanceof vscode.LanguageModelToolCallPart) { return `[Previous tool call: ${part.name}; ${part.callId}] ${JSON.stringify(part.input)}`; }
		if (part instanceof vscode.LanguageModelToolResultPart) { return `[Previous tool result: ${part.callId}] ${content(part.content)}`; }
		if (part instanceof vscode.LanguageModelDataPart) {
			if (/^image\/(png|jpeg|gif|webp)$/.test(part.mimeType)) {
				if (part.data.byteLength > 15 * 1024 * 1024) { throw new Error("Cursor accepts images up to 15 MB each."); }
				images.push({ data: Buffer.from(part.data).toString("base64"), mimeType: part.mimeType }); return `[Image attachment ${images.length}]`;
			}
			if (part.mimeType.startsWith("text/") || part.mimeType === "application/json") { return Buffer.from(part.data).toString("utf8"); }
			throw new Error(`Cursor does not support attachment type ${part.mimeType}.`);
		}
		return "";
	}).filter(Boolean).join("\n");
	const blocks = messages.map(message => `${message.role === vscode.LanguageModelChatMessageRole.User ? "User" : message.role === vscode.LanguageModelChatMessageRole.Assistant ? "Assistant" : "System"}:\n${content(message.content)}`);
	return { text: blocks.join("\n\n"), ...(images.length ? { images } : {}) };
}

/** Cloud fallback has no local archive tools: reject overflow explicitly. */
export function cursorPrompt(messages: readonly vscode.LanguageModelChatRequestMessage[], maximumChars: number): CursorPrompt {
	const prompt = cursorTranscript(messages);
	if ((prompt.images?.length ?? 0) > 5) { throw new Error("Cursor accepts at most five images per prompt."); }
	if (prompt.text.length > maximumChars) { throw new Error("The conversation exceeds the Cursor working context. Increase the profile's context slider or start a shorter chat; no earlier messages were silently removed."); }
	return prompt;
}