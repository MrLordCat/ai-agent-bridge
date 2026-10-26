import * as vscode from "vscode";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { buildSummaryContent } from "./message-compaction";
import { canonicalConversationUserAnchors } from "../providers/conversation-anchors";
import type { OpenAIChatMessage } from "../types";

export interface SharedHandoff {
	compacted: vscode.LanguageModelChatRequestMessage[];
	wasCompacted: boolean;
	messageCountBefore: number;
	messageCountAfter: number;
	tokenEstimateBefore: number;
	tokenEstimateAfter: number;
}

export function sharedImageName(data: Uint8Array, mimeType: string): string {
	const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as Record<string, string>)[mimeType] ?? "image";
	return `${createHash("sha256").update(data).digest("hex")}.${extension}`;
}

/** Common conservative estimate, not a model-specific tokenizer or usage counter. */
export function estimateSharedTextTokens(text: string): number { return Math.ceil(Buffer.byteLength(text, "utf8") / 2); }

export const SHARED_CONTEXT_MIN = 32_768;
export const SHARED_CONTEXT_MAX = 1_048_576;
const DEFAULT_SHARED_CONTEXT_LENGTH = 258_400;

/**
 * One working-context limit, in tokens, for Codex, Claude, Coco and Cursor.
 * Zero keeps the historical codexWorkingContextTarget value. Each provider then
 * applies only its real model window (and native threshold bounds) on top.
 */
export function resolveSharedContextLimit(config: Pick<vscode.WorkspaceConfiguration, "get"> = vscode.workspace.getConfiguration("llamacpp")): number {
	const shared = Number(config.get("sharedContextLength", 0));
	const value = Number.isFinite(shared) && shared > 0 ? shared : Number(config.get("codexWorkingContextTarget", DEFAULT_SHARED_CONTEXT_LENGTH));
	return Math.floor(Math.min(SHARED_CONTEXT_MAX, Math.max(SHARED_CONTEXT_MIN, Number.isFinite(value) && value > 0 ? value : DEFAULT_SHARED_CONTEXT_LENGTH)));
}

export function sharedContextBudget(contextWindow: number, tools: readonly vscode.LanguageModelChatTool[] = [], configuredTarget?: number): number {
	const target = configuredTarget ?? resolveSharedContextLimit();
	const window = Math.min(contextWindow, Math.max(SHARED_CONTEXT_MIN, target));
	// Same reserve for every adapter, including the largest native CLI prefix.
	const reserve = Math.min(98304, Math.floor(window * .25)) + Math.min(32768, Math.floor(window * .125))
		+ Math.max(8192, Math.ceil(window * .03)) + estimateSharedTextTokens(JSON.stringify(tools));
	return Math.max(1024, Math.floor(window - reserve));
}

function renderPart(part: unknown): string {
	if (part instanceof vscode.LanguageModelTextPart) { return part.value; }
	if (part instanceof vscode.LanguageModelToolCallPart) { return `[tool call: ${part.name}, callId: ${part.callId}] ${JSON.stringify(part.input)}`; }
	if (part instanceof vscode.LanguageModelToolResultPart) { return `[tool result, callId: ${part.callId}] ${part.content.map(renderPart).join("\n")}`; }
	if (part instanceof vscode.LanguageModelDataPart) { return part.mimeType.startsWith("text/") || part.mimeType === "application/json" ? Buffer.from(part.data).toString("utf8") : `[data: ${part.mimeType}, ${part.data.byteLength} bytes]`; }
	return "";
}
export function estimateSharedMessageTokens(message: vscode.LanguageModelChatRequestMessage): number {
	let imageTokens = 0;
	const images = (part: unknown) => {
		if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) { imageTokens += 4096; }
		if (part instanceof vscode.LanguageModelToolResultPart) { part.content.forEach(images); }
	};
	message.content.forEach(images);
	return 16 + imageTokens + estimateSharedTextTokens(message.content.map(renderPart).join("\n"));
}

/** One semantic policy for Codex, Coco and Cursor; transport encoding happens later. */
export function prepareSharedHandoff(messages: readonly vscode.LanguageModelChatRequestMessage[], tokenBudget: number, archivePath?: string): SharedHandoff {
	const budget = Math.max(1024, Math.floor(tokenBudget));
	const latest = canonicalConversationUserAnchors(messages).at(-1)?.index ?? Math.max(0, messages.length - 1);
	const historicalImage = (part: vscode.LanguageModelDataPart) => {
		const root = archivePath ? path.join(path.dirname(archivePath), archivePath.endsWith(".json") ? "assets" : "") : undefined;
		return new vscode.LanguageModelTextPart(`[Historical image ${part.mimeType}; original bytes: ${root ? JSON.stringify(path.join(root, sharedImageName(part.data, part.mimeType))) : "shared original transcript"}]`);
	};
	const trimmed = messages.map((message, index) => index >= latest ? message : { ...message, content: message.content.map(part => {
		if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) { return historicalImage(part); }
		if (!(part instanceof vscode.LanguageModelToolResultPart)) { return part; }
		return new vscode.LanguageModelToolResultPart(part.callId, part.content.map(content => content instanceof vscode.LanguageModelDataPart && content.mimeType.startsWith("image/") ? historicalImage(content) : content instanceof vscode.LanguageModelTextPart && content.value.length > 12000
			? new vscode.LanguageModelTextPart(`${content.value.slice(0, 8000)}\n[Historical tool output abbreviated; complete original in the shared transcript]\n${content.value.slice(-3800)}`) : content));
	}) });
	const before = messages.reduce((total, message) => total + estimateSharedMessageTokens(message), 0);
	const costs = trimmed.map(estimateSharedMessageTokens);
	const systems = trimmed.map((message, index) => ({ message, index })).filter(({ message }) => message.role !== vscode.LanguageModelChatMessageRole.User && message.role !== vscode.LanguageModelChatMessageRole.Assistant);
	const systemIndices = new Set(systems.map(({ index }) => index));
	const fixed = systems.reduce((sum, { index }) => sum + costs[index], 0);
	// Only the request message itself is pinned; a long autonomous turn may compact its older tool rounds.
	const pinnedCost = fixed + (systemIndices.has(latest) ? 0 : costs[latest]);
	if (pinnedCost > budget) { throw new Error(`The current request and required instructions exceed the shared context budget (${pinnedCost} estimated tokens, budget ${budget}). No inference was started; the complete transcript is preserved.`); }
	let result: vscode.LanguageModelChatRequestMessage[] = [...trimmed];
	if (costs.reduce((sum, cost) => sum + cost, 0) > budget) {
		const summaryReserve = Math.min(16000, Math.floor((budget - pinnedCost) / 3));
		let start = trimmed.length, used = pinnedCost;
		while (start > 0) {
			const next = start - 1, cost = systemIndices.has(next) || next === latest ? 0 : costs[next];
			if (used + cost + summaryReserve > budget) { break; }
			used += cost; start = next;
		}
		// Do not start a suffix with an orphaned tool result.
		while (start < trimmed.length && start !== latest && trimmed[start].content.some(part => part instanceof vscode.LanguageModelToolResultPart)) { start++; }
		const kept = (index: number) => !systemIndices.has(index) && (index >= start || index === latest);
		const raw = (from: number, to: number): OpenAIChatMessage[] => trimmed.slice(from, to).flatMap((message, offset) => kept(from + offset) || systemIndices.has(from + offset) ? [] : [{
			role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" as const : "user" as const, content: message.content.map(renderPart).join("\n"),
		}]);
		const head = raw(0, latest), progress = raw(latest + 1, trimmed.length);
		let headSummary = head.length || !progress.length ? buildSummaryContent("Conversation summary (shared provider context)", [], head, undefined) : "";
		let progressSummary = progress.length ? buildSummaryContent("Earlier steps of the current request (already done; continue from the retained recent steps)", [], progress, undefined) : "";
		const suffix = trimmed.filter((_, index) => kept(index));
		const suffixCost = suffix.reduce((sum, message) => sum + estimateSharedMessageTokens(message), fixed);
		const reference = archivePath ? `\nComplete original transcript: ${JSON.stringify(archivePath)}. Search/read it when exact earlier details matter. Do not repeat historical actions.\n` : "\nEarlier details remain in the shared Chat transcript. Do not repeat historical actions.\n";
		const availableBytes = Math.max(0, (budget - suffixCost - estimateSharedTextTokens(reference) - 32) * 2);
		const excerptOf = () => [headSummary, progressSummary].filter(Boolean).join("\n\n");
		const shrink = (text: string) => text.slice(0, Math.max(0, Math.floor(text.length * .9)));
		// Recent progress of the running request outranks older conversation history.
		while (headSummary && Buffer.byteLength(excerptOf(), "utf8") > availableBytes) { headSummary = shrink(headSummary); }
		while (progressSummary && Buffer.byteLength(excerptOf(), "utf8") > availableBytes) { progressSummary = shrink(progressSummary); }
		const excerpt = excerptOf();
		const summaryMessage = vscode.LanguageModelChatMessage.User(excerpt + reference);
		if (estimateSharedMessageTokens(summaryMessage) + suffixCost > budget) { throw new Error("The current request leaves no room for the shared context summary. Reduce the request or increase the working context; no inference was started."); }
		result = [...systems.map(({ message }) => message), summaryMessage, ...suffix];
	}
	const after = result.reduce((total, message) => total + estimateSharedMessageTokens(message), 0);
	const changed = before !== after || result.length !== messages.length;
	return { compacted: result, wasCompacted: changed, messageCountBefore: messages.length, messageCountAfter: result.length, tokenEstimateBefore: before, tokenEstimateAfter: after };
}