import * as vscode from "vscode";
import type { CocoPromptContent } from "./acp-client";
import { convertCocoToolResult } from "./turn-bridge";

/** Keep binary image attachments separate from the conversation text. */
export function serializeCocoMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): CocoPromptContent[] {
	const blocks: CocoPromptContent[] = [];
	let textLength = 0;
	const appendText = (text: string) => {
		if (!text) { return; }
		textLength += text.length;
		if (textLength > 500_000) {
			throw new Error("Coco conversation is too large. Start a new chat or reduce the attached text.");
		}
		const last = blocks[blocks.length - 1];
		if (last?.type === "text") { last.text += text; }
		else { blocks.push({ type: "text", text }); }
	};
	const appendImage = (part: vscode.LanguageModelDataPart) => {
		if (part.data.byteLength === 0) { throw new Error("Coco received an empty image attachment."); }
		blocks.push({ type: "image", mimeType: part.mimeType, data: Buffer.from(part.data).toString("base64") });
	};
	for (const message of messages) {
		let roleWritten = false;
		const begin = () => {
			if (!roleWritten) {
				appendText(`\n\n${message.role === vscode.LanguageModelChatMessageRole.User ? "User" : "Assistant"}:\n`);
				roleWritten = true;
			}
		};
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart && part.value) {
				begin(); appendText(`${part.value}\n`);
			} else if (part instanceof vscode.LanguageModelDataPart) {
				if (part.mimeType.startsWith("image/")) { begin(); appendImage(part); }
				else if (part.mimeType.startsWith("text/") || part.mimeType === "application/json") {
					begin(); appendText(`${Buffer.from(part.data).toString("utf8")}\n`);
				}
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				begin(); appendText(`[VS Code tool call: ${part.name}, call id: ${part.callId}]\n${JSON.stringify(part.input)}\n`);
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				begin(); appendText(`[VS Code tool result, call id: ${part.callId}]\n${convertCocoToolResult(part).output}\n`);
				for (const item of part.content) {
					if (item instanceof vscode.LanguageModelDataPart && item.mimeType.startsWith("image/")) { appendImage(item); }
				}
			}
		}
	}
	return blocks;
}

export function estimateCocoTokens(value: string | vscode.LanguageModelChatRequestMessage): number {
	if (typeof value === "string") { return Math.max(1, Math.ceil(value.length / 4)); }
	// Image cost varies by model and dimensions; count it conservatively without putting base64 in text.
	return Math.max(1, serializeCocoMessages([value]).reduce((total, block) => total
		+ (block.type === "text" ? Math.ceil(block.text.length / 4) : Math.max(1_024, Math.ceil(block.data.length / 4))), 0));
}