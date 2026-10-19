import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { normalizeSystemDate, normalizeVolatileHostContext } from "../context/cache-diagnostics";

export interface ConversationAnchor { key: string; index: number }
/** Cursor v2: text-part boundaries and regenerated host-only parts are transport details. */
export function canonicalConversationUserAnchors(messages: readonly vscode.LanguageModelChatRequestMessage[]): ConversationAnchor[] {
	return messages.flatMap((message, index) => {
		if (message.role !== vscode.LanguageModelChatMessageRole.User || message.content.some(part => part instanceof vscode.LanguageModelToolResultPart)) { return []; }
		const parts: Array<{ kind: "text"; text: string } | { kind: "data"; mimeType: string; hash: string }> = [];
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				const last = parts.at(-1);
				if (last?.kind === "text") { last.text += part.value; } else { parts.push({ kind: "text", text: part.value }); }
			} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType !== "usage") {
				parts.push({ kind: "data", mimeType: part.mimeType, hash: createHash("sha256").update(part.data).digest("hex") });
			}
		}
		const stable = parts.map(part => part.kind === "text" ? { ...part, text: normalizeSystemDate(normalizeVolatileHostContext(part.text)).replace(/<host-context\/>/g, "") } : part)
			.filter(part => part.kind !== "text" || part.text.trim());
		return stable.length ? [{ key: createHash("sha256").update(JSON.stringify(stable)).digest("hex"), index }] : [];
	});
}

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