import * as vscode from "vscode";

export const CLAUDE_MODEL_ID_PREFIX = "claude::";
export function encodeClaudeModelId(modelId: string): string { return `${CLAUDE_MODEL_ID_PREFIX}${modelId}`; }
export function decodeClaudeModelId(modelId: string): string | undefined { return modelId.startsWith(CLAUDE_MODEL_ID_PREFIX) ? modelId.slice(CLAUDE_MODEL_ID_PREFIX.length) : undefined; }

/**
 * Curated Claude subscription catalog. Claude Code accepts backend model ids
 * that are not yet present in its bundled UI catalog.
 */
export const CLAUDE_SUBSCRIPTION_MODELS = [
	{
		id: "claude-opus-5",
		name: "Opus 5 (Claude)",
		description: "Latest high-capability Claude model for complex analysis and implementation",
	},
];

export function estimateClaudeTokens(value: string | vscode.LanguageModelChatRequestMessage): number {
	if (typeof value === "string") {
		return Math.max(1, Math.ceil(value.length / 4));
	}
	let characters = 0;
	for (const part of value.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			characters += part.value.length;
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			characters += part.name.length + JSON.stringify(part.input).length + 24;
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			characters += part.callId.length;
			for (const item of part.content) {
				if (item instanceof vscode.LanguageModelTextPart) {
					characters += item.value.length;
				} else if (item instanceof vscode.LanguageModelDataPart) {
					characters += Math.ceil(item.data.byteLength * 4 / 3);
				}
			}
		} else if (part instanceof vscode.LanguageModelDataPart) {
			characters += Math.ceil(part.data.byteLength * 4 / 3);
		}
	}
	return Math.max(1, Math.ceil(characters / 4));
}
