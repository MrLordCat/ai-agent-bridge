import type { OpenAIChatMessage } from "../types";

export const MANUAL_COMPACTION_TRIGGER = "AI Agent Bridge: force provider context compaction now.";

export const MANUAL_COMPACTION_EXPIRY_MS = 60_000;

export function normalizeManualCompactionConversationId(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim();
	return normalized.length > 0 && normalized.length <= 256 ? normalized : undefined;
}

function stripExactRepeatedTail(value: string): string {
	const minimumRepeatedChars = 1_024;
	let bestStart = value.length;
	for (let unitLength = 1; unitLength <= 64 && unitLength * 32 <= value.length; unitLength += 1) {
		const unit = value.slice(value.length - unitLength);
		let start = value.length - unitLength;
		while (start >= unitLength && value.slice(start - unitLength, start) === unit) {
			start -= unitLength;
		}
		if (value.length - start >= minimumRepeatedChars) {
			bestStart = Math.min(bestStart, start);
		}
	}
	if (bestStart === value.length) {
		return value;
	}
	const prefix = value.slice(0, bestStart).trimEnd();
	const notice = "[repetitive historical reasoning tail removed during manual compaction]";
	return prefix ? `${prefix}\n${notice}` : notice;
}

/**
 * A manual compaction is an intentional reasoning reset. DeepSeek tool-call
 * continuity no longer crosses this boundary, so private reasoning can be
 * removed. The content guard also handles hosts that serialized a cancelled
 * ThinkingPart as ordinary assistant text instead of reasoning_content.
 */
export function sanitizeManualCompactionHistory(
	messages: readonly OpenAIChatMessage[]
): OpenAIChatMessage[] {
	return messages.map(message => {
		if (message.role !== "assistant") {
			return message;
		}
		const sanitized = { ...message };
		delete sanitized.reasoning_content;
		sanitized.content = typeof message.content === "string"
			? stripExactRepeatedTail(message.content)
			: message.content;
		return sanitized;
	});
}