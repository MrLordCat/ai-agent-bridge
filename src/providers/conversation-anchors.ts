import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { normalizeSystemDate, normalizeVolatileHostContext } from "../context/cache-diagnostics";

export interface ConversationAnchor { key: string; index: number }
export function conversationUserAnchors(messages: readonly vscode.LanguageModelChatRequestMessage[]): ConversationAnchor[] {
	return messages.flatMap((message, index) => {
		if (message.role !== vscode.LanguageModelChatMessageRole.User || message.content.some(part => part instanceof vscode.LanguageModelToolResultPart)) { return []; }
		const parts = message.content.flatMap(part => {
			if (part instanceof vscode.LanguageModelTextPart && part.value.trim()) { return [{ text: normalizeSystemDate(normalizeVolatileHostContext(part.value)) }]; }
			if (part instanceof vscode.LanguageModelDataPart) { return [{ text: `${part.mimeType}:${createHash("sha256").update(part.data).digest("hex")}` }]; }
			return [];
		});
		return parts.length ? [{ key: createHash("sha256").update(JSON.stringify(parts)).digest("hex"), index }] : [];
	});
}