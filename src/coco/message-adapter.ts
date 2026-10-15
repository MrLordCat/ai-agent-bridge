import * as vscode from "vscode";
import type { CocoPromptContent } from "./acp-client";
import { convertCocoToolResult } from "./turn-bridge";

export const COCO_MAX_PROMPT_CHARS = 500_000;

function shorten(text: string, maximum: number): string {
	if (text.length <= maximum) { return text; }
	const marker = "\n[Older text shortened]\n";
	const available = Math.max(0, maximum - marker.length);
	const head = Math.ceil(available / 2);
	return text.slice(0, head) + marker + (available > head ? text.slice(-(available - head)) : "");
}

function serializeMessage(message: vscode.LanguageModelChatRequestMessage, toolResultLimit = COCO_MAX_PROMPT_CHARS, lossless = false): CocoPromptContent[] {
	const blocks: CocoPromptContent[] = [];
	const appendText = (text: string) => {
		if (!text) { return; }
		const last = blocks[blocks.length - 1];
		if (last?.type === "text") { last.text += text; }
		else { blocks.push({ type: "text", text }); }
	};
	const appendImage = (part: vscode.LanguageModelDataPart) => {
		if (part.data.byteLength === 0) { throw new Error("Coco received an empty image attachment."); }
		blocks.push({ type: "image", mimeType: part.mimeType, data: Buffer.from(part.data).toString("base64") });
	};
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
				else if (lossless) { throw new Error(`Coco ACP cannot import ${part.mimeType} attachments directly. Supply extracted text or use VS Code file tools; the original attachment remains in the Chat journal.`); }
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				begin(); appendText(`[VS Code tool call: ${part.name}, call id: ${part.callId}]\n${JSON.stringify(part.input)}\n`);
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
								begin(); appendText(`[VS Code tool result, call id: ${part.callId}]\n${lossless ? convertCocoToolResult(part, Infinity).output : shorten(convertCocoToolResult(part).output, toolResultLimit)}\n`);
				for (const item of part.content) {
					if (item instanceof vscode.LanguageModelDataPart && item.mimeType.startsWith("image/")) { appendImage(item); }
				}
			}
		}
	return blocks;
}

function textLength(blocks: readonly CocoPromptContent[]): number {
	return blocks.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0);
}

function joinBlocks(groups: readonly (readonly CocoPromptContent[])[]): CocoPromptContent[] {
	const result: CocoPromptContent[] = [];
	for (const blocks of groups) {
		for (const block of blocks) {
			const last = result.at(-1);
			if (last?.type === "text" && block.type === "text") { last.text += block.text; }
			else { result.push({ ...block }); }
		}
	}
	return result;
}

/** @deprecated Bounded preview only. Executable requests use serializeCocoTranscript and history-transfer. */
export function serializeCocoMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[], maximumTextChars = COCO_MAX_PROMPT_CHARS
): CocoPromptContent[] {
	const requested = Number.isFinite(maximumTextChars) ? maximumTextChars : COCO_MAX_PROMPT_CHARS;
	const budget = Math.max(256, Math.min(COCO_MAX_PROMPT_CHARS, Math.floor(requested)));
	const snapshots = messages.map(message => serializeMessage(message));
	if (snapshots.reduce((total, blocks) => total + textLength(blocks), 0) <= budget) { return joinBlocks(snapshots); }
	let latestUser = messages.length - 1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === vscode.LanguageModelChatMessageRole.User && messages[index].content.some(part =>
			(part instanceof vscode.LanguageModelTextPart && Boolean(part.value))
			|| (part instanceof vscode.LanguageModelDataPart && (part.mimeType.startsWith("image/") || part.mimeType.startsWith("text/") || part.mimeType === "application/json")))) {
			latestUser = index; break;
		}
	}
	const marker: CocoPromptContent = { type: "text", text: "[Earlier conversation shortened to fit Coco's context. Treat retained messages as history and continue the latest user request.]\n" };
	const current = messages.slice(Math.max(0, latestUser)).map(message => serializeMessage(message, Math.min(32_768, Math.floor(budget / 8))));
	let remaining = budget - marker.text.length - current.reduce((total, blocks) => total + textLength(blocks), 0);
	if (remaining < 0) { throw new Error("The latest Coco request is too large for its context budget. Reduce the current attachments or request text."); }
	const history = new Map<number, CocoPromptContent[]>();
	const keep = (index: number, maximum: number) => {
		if (remaining < 128 || maximum < 128) { return; }
		const text = snapshots[index].map(block => block.type === "text" ? block.text : "[Earlier image omitted]\n").join("");
		const excerpt = shorten(text, Math.min(maximum, remaining));
		history.set(index, [{ type: "text", text: excerpt }]);
		remaining -= excerpt.length;
	};
	// Keep initial instructions plus the most recent useful history.
	if (latestUser > 0) { keep(0, Math.floor(budget / 5)); }
	for (let index = latestUser - 1; index > 0 && remaining >= 128; index--) {
		keep(index, Math.min(16_384, remaining));
	}
	return joinBlocks([[marker], ...[...history].sort(([a], [b]) => a - b).map(([, blocks]) => blocks), ...current]);
}

export function estimateCocoTokens(value: string | vscode.LanguageModelChatRequestMessage): number {
	if (typeof value === "string") { return Math.max(1, Math.ceil(value.length / 4)); }
	// Counting must not serialize/compact a message or reject old, oversized history.
	let characters = 16, images = 0;
	const countData = (part: vscode.LanguageModelDataPart) => {
		if (part.mimeType.startsWith("image/")) { images += Math.max(1_024, Math.ceil(part.data.byteLength / 3)); }
		else if (part.mimeType.startsWith("text/") || part.mimeType === "application/json") { characters += Buffer.from(part.data).toString("utf8").length; }
	};
	for (const part of value.content) {
		if (part instanceof vscode.LanguageModelTextPart) { characters += part.value.length; }
		else if (part instanceof vscode.LanguageModelDataPart) { countData(part); }
		else if (part instanceof vscode.LanguageModelToolCallPart) { characters += JSON.stringify(part.input).length + part.name.length + part.callId.length + 32; }
		else if (part instanceof vscode.LanguageModelToolResultPart) {
			characters += convertCocoToolResult(part).output.length + part.callId.length + 32;
			for (const content of part.content) {
				if (content instanceof vscode.LanguageModelDataPart && content.mimeType.startsWith("image/")) { countData(content); }
			}
		}
	}
	return Math.max(1, Math.ceil(characters / 4) + images);
}

/** Import all available history; bounded transfers split it, never delete its middle. */
export function serializeCocoTranscript(messages: readonly vscode.LanguageModelChatRequestMessage[]): CocoPromptContent[] {
	return joinBlocks(messages.map(message => serializeMessage(message, Infinity, true)));
}