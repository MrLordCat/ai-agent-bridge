import type { OpenAIChatMessage } from "../types";
import { contentToText } from "../utils";
import { summarizeToolCallArguments, summarizeToolResultContent } from "./tool-result-summary";

const MAX_SUMMARY_MESSAGES = 32;
const MAX_SUMMARY_CHARS = 6000;
const MAX_SUMMARY_LINE_CHARS = 480;
const MAX_SEMANTIC_SUMMARY_CHARS = 24_000;

const SIGNAL_REGEX = /(?:^|\b)(?:error|failed|failure|warning|fixed|implemented|changed|created|updated|removed|decision|todo|next|path|file|commit|ошиб|сбой|исправ|реализ|измен|созда|обнов|удал|решен|решил|далее|следующ)/i;
const PATH_REGEX = /(?:[A-Za-z]:\\|\.?\.?\/|[\w.-]+\/)[\w./\\-]+\.[A-Za-z0-9]{1,10}(?::\d+)?/;
const FENCED_CODE_REGEX = /```([\w.+-]*)\s*\n([\s\S]*?)```/g;

export interface CompactMessagesOptions {
	tokenBudget: number;
	keepLastCount: number;
	label: string;
	estimateTokens(messages: OpenAIChatMessage[]): number;
	/**
	 * Manual recovery compaction keeps only the newest complete turn verbatim.
	 * Every older turn is folded into the summary even when the token budget
	 * would normally allow a larger raw tail. This is intentionally stronger
	 * than automatic compaction: it removes poisoned historical reasoning and
	 * repetitive tool chatter instead of carrying them into the new snapshot.
	 */
	forceKeepLastTurnOnly?: boolean;
	/** Optional model-generated replacement for the deterministic summary. */
	summaryContent?: string;
	/**
	 * Long tool-result messages in the retained tail are truncated to this
	 * many characters. Token volume in real chats is skewed: a few early
	 * turns carry huge tool outputs, so without truncation a binary search
	 * over whole turns cannot fill the token budget and drops almost the
	 * entire history (e.g. 187 -> 15 messages while the budget is 60% of
	 * the current size). Truncating long results lets many more recent
	 * turns survive inside the same budget.
	 */
	maxToolResultChars?: number;
}

export interface CompactMessagesResult {
	messages: OpenAIChatMessage[];
	didCompact: boolean;
	/** Newly removed conversation messages; previous summaries are separate. */
	droppedMessages: OpenAIChatMessage[];
	previousSummary?: string;
}

const SUMMARY_LABEL_PATTERN = /^Conversation summary \([^\n)]+\):/;

export function isCompactionSummary(message: OpenAIChatMessage): boolean {
	if (message.role !== "system" && message.role !== "user") {
		return false;
	}
	if (typeof message.content !== "string") {
		return false;
	}
	return SUMMARY_LABEL_PATTERN.test(message.content);
}

function summaryBody(content: string): string {
	const separator = content.indexOf(":\n");
	return separator >= 0 ? content.slice(separator + 2).trim() : content.trim();
}

function clipHeadAndTail(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value;
	}
	const marker = "\n...[older summary clipped]...\n";
	const remaining = Math.max(0, maxChars - marker.length);
	const headChars = Math.floor(remaining * 0.4);
	return `${value.slice(0, headChars)}${marker}${value.slice(-(remaining - headChars))}`;
}

function isSummarySourceMessage(message: OpenAIChatMessage): boolean {
	return message.providerOverlay !== "shared-memory" && message.ephemeral !== true;
}

function isGeneratedSummary(message: OpenAIChatMessage, label: string): boolean {
	return isCompactionSummary(message)
		|| (typeof message.content === "string" && message.content.startsWith(`${label}:`));
}

interface SummaryCandidate {
	index: number;
	priority: number;
	role: OpenAIChatMessage["role"];
	line: string;
}

function clip(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function summarizeCodeAwareText(content: string): { text: string; priority: number } {
	const normalized = content.replace(/\r/g, "").trim();
	if (!normalized) {
		return { text: "", priority: 0 };
	}

	const lines = normalized.split("\n").map(line => line.trim()).filter(Boolean);

	const details: string[] = [];
	let priority = 1;

	for (const line of lines) {
		if ((SIGNAL_REGEX.test(line) || PATH_REGEX.test(line)) && !details.includes(line)) {
			details.push(line);
			priority = Math.max(priority, 3);
			if (details.length >= 3) {
				break;
			}
		}
	}

	let match: RegExpExecArray | null;
	FENCED_CODE_REGEX.lastIndex = 0;
	while ((match = FENCED_CODE_REGEX.exec(normalized)) !== null && details.length < 4) {
		const codeLines = match[2].split("\n").map(line => line.trim()).filter(Boolean);
		if (codeLines.length === 0) {
			continue;
		}
		const language = match[1] ? `${match[1]} ` : "";
		const edge = codeLines.length === 1
			? codeLines[0]
			: `${codeLines[0]} ... ${codeLines[codeLines.length - 1]}`;
		details.push(`[${language}code] ${edge}`);
		priority = 4;
	}

	if (details.length === 0) {
		const first = lines[0] ?? normalized;
		const last = lines.length > 1 ? lines[lines.length - 1] : "";
		return {
			text: first === last || !last ? first : `${first} | ${last}`,
			priority,
		};
	}

	return { text: details.join(" | "), priority };
}

function summarizeMessage(message: OpenAIChatMessage): { text: string; priority: number } {
	if (message.role === "tool") {
		const toolName = typeof message.name === "string" && message.name.trim().length > 0
			? message.name.trim()
			: "tool";
		const content = typeof message.content === "string" ? message.content : "";
		return {
			text: `[tool_result ${toolName}] ${summarizeToolResultContent(content, 700)}`,
			priority: 4,
		};
	}

	if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
		const calls = message.tool_calls
			.filter(call => typeof call.function?.name === "string" && call.function.name.length > 0)
			.map(call => {
				const args = summarizeToolCallArguments(call.function.arguments);
				return `${call.function.name}${args ? `(${args})` : ""}`;
			});
		if (calls.length > 0) {
			const shown = calls.slice(0, 3).join(", ");
			const extra = calls.length > 3 ? ` +${calls.length - 3} more` : "";
			return { text: `[tool_calls] ${shown}${extra}`, priority: 4 };
		}
		return { text: `[tool_calls] ${message.tool_calls.length}`, priority: 4 };
	}

	const summary = summarizeCodeAwareText(contentToText(message.content));
	return {
		text: summary.text,
		priority: message.role === "user" ? 5 : summary.priority,
	};
}

function cloneMessage(message: OpenAIChatMessage): OpenAIChatMessage {
	return {
		...message,
		...(Array.isArray(message.content)
			? { content: message.content.map(part => ({ ...part })) }
			: {}),
		...(Array.isArray(message.tool_calls)
			? { tool_calls: message.tool_calls.map(call => ({ ...call, function: { ...call.function } })) }
			: {}),
	};
}

function groupConversationTurns(messages: OpenAIChatMessage[]): OpenAIChatMessage[][] {
	const turns: OpenAIChatMessage[][] = [];
	for (const message of messages) {
		if (message.role === "user" || turns.length === 0) {
			turns.push([message]);
		} else {
			turns[turns.length - 1].push(message);
		}
	}
	return turns;
}

function isToolResultLike(message: OpenAIChatMessage): boolean {
	return message.role === "tool"
		|| typeof message.tool_call_id === "string"
		|| (
			message.role === "user"
			&& typeof message.content === "string"
			&& message.content.includes("[tool_result")
		);
}

/**
 * Automatic compaction may split one very long user turn, but only between
 * complete assistant transactions. An assistant tool-call message stays in
 * the same unit as all following tool results, so a retained suffix can never
 * begin with an orphaned tool result. This gives the budget search finer
 * granularity than whole user turns without producing an invalid API history.
 */
function groupAutomaticCompactionUnits(messages: OpenAIChatMessage[]): OpenAIChatMessage[][] {
	const units: OpenAIChatMessage[][] = [];
	for (const message of messages) {
		const startsUnit = units.length === 0
			|| message.role === "assistant"
			|| (message.role === "user" && !isToolResultLike(message));
		if (startsUnit) {
			units.push([message]);
		} else {
			units[units.length - 1].push(message);
		}
	}
	return units;
}

function selectSummaryLines(messages: OpenAIChatMessage[]): string[] {
	const candidates: SummaryCandidate[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		if (!isSummarySourceMessage(messages[index])) {
			continue;
		}
		const summary = summarizeMessage(messages[index]);
		const text = summary.text.replace(/\s+/g, " ").trim();
		if (!text) {
			continue;
		}
		candidates.push({
			index,
			priority: summary.priority,
			role: messages[index].role,
			line: `- ${messages[index].role}: ${clip(text, MAX_SUMMARY_LINE_CHARS)}`,
		});
	}

	let selected = candidates;
	if (candidates.length > MAX_SUMMARY_MESSAGES) {
		const picked = new Map<number, SummaryCandidate>();
		const takeRecent = (matching: SummaryCandidate[], limit: number): void => {
			for (const candidate of matching.slice().sort((left, right) => right.index - left.index)) {
				if (picked.size >= MAX_SUMMARY_MESSAGES || limit <= 0) {
					return;
				}
				if (!picked.has(candidate.index)) {
					picked.set(candidate.index, candidate);
					limit -= 1;
				}
			}
		};

		const firstUser = candidates.find(candidate => candidate.role === "user");
		if (firstUser) {
			picked.set(firstUser.index, firstUser);
		}
		takeRecent(candidates.filter(candidate => candidate.role === "user"), 11);
		takeRecent(candidates.filter(candidate => candidate.priority >= 4 && candidate.role !== "user"), 16);
		takeRecent(candidates, MAX_SUMMARY_MESSAGES - picked.size);
		selected = [...picked.values()].sort((left, right) => left.index - right.index);
	}

	const lines: string[] = [];
	let chars = 0;
	for (let index = selected.length - 1; index >= 0; index -= 1) {
		const candidate = selected[index];
		if (lines.length > 0 && chars + candidate.line.length > MAX_SUMMARY_CHARS) {
			continue;
		}
		lines.unshift(candidate.line);
		chars += candidate.line.length;
	}
	return lines;
}

function buildSummaryContent(
	label: string,
	previousSummaries: string[],
	head: OpenAIChatMessage[],
	override: string | undefined
): string {
	const semantic = override?.trim();
	if (semantic) {
		return `${label}:\n${clipHeadAndTail(summaryBody(semantic), MAX_SEMANTIC_SUMMARY_CHARS)}`;
	}

	const previous = previousSummaries
		.map(summaryBody)
		.filter(Boolean)
		.join("\n\n");
	const previousBudget = previous ? Math.floor(MAX_SUMMARY_CHARS * 0.6) : 0;
	const previousPart = previous
		? `[previous]\n${clipHeadAndTail(previous, previousBudget)}`
		: "";
	const remainingChars = Math.max(0, MAX_SUMMARY_CHARS - previousPart.length - 64);
	const newLines = selectSummaryLines(head);
	const selectedNewLines: string[] = [];
	let newChars = 0;
	for (let index = newLines.length - 1; index >= 0; index -= 1) {
		const line = newLines[index];
		if (selectedNewLines.length > 0 && newChars + line.length > remainingChars) {
			continue;
		}
		selectedNewLines.unshift(line);
		newChars += line.length;
	}
	const newPart = selectedNewLines.length > 0
		? `${previous ? "[newly compacted]\n" : ""}${selectedNewLines.join("\n")}`
		: "";
	const body = [previousPart, newPart].filter(Boolean).join("\n\n");
	return body
		? `${label}:\n${body}`
		: `${label}: prior turns were compacted to fit model context.`;
}

function truncateToBudget(
	messages: OpenAIChatMessage[],
	options: CompactMessagesOptions,
	systemCount: number
): void {
	if (options.estimateTokens(messages) <= options.tokenBudget) {
		return;
	}
	const latestUserIndex = messages.findLastIndex(message =>
		message.role === "user" && !isGeneratedSummary(message, options.label)
	);
	const candidates = messages
		.map((message, index) => ({ message, index }))
		.filter(({ message, index }) => index >= systemCount && typeof message.content === "string" && message.content.length > 0)
		.sort((left, right) => {
			const priority = (entry: { message: OpenAIChatMessage; index: number }): number => {
				if (entry.message.role === "tool") {
					return 0;
				}
				if (entry.message.role === "assistant") {
					return 1;
				}
				if (entry.index !== latestUserIndex && !isGeneratedSummary(entry.message, options.label)) {
					return 2;
				}
				if (entry.index === latestUserIndex) {
					return 3;
				}
				return 4;
			};
			return priority(left) - priority(right)
				|| String(right.message.content).length - String(left.message.content).length;
		});

	for (const { message } of candidates) {
		if (options.estimateTokens(messages) <= options.tokenBudget || typeof message.content !== "string") {
			break;
		}
		const original = message.content;
		const beforeTokens = options.estimateTokens(messages);
		message.content = "";
		const emptyTokens = options.estimateTokens(messages);
		message.content = original;
		if (emptyTokens >= beforeTokens) {
			// Some callers use message-count-only estimators in tests or planning.
			// Destroying content cannot help those estimators, so retain the useful
			// text instead of zeroing it without moving toward the budget.
			continue;
		}
		const summary = isGeneratedSummary(message, options.label);
		const separator = summary ? original.indexOf(":\n") : -1;
		const fixedPrefix = separator >= 0 ? original.slice(0, separator + 2) : "";
		const trimmable = fixedPrefix ? original.slice(fixedPrefix.length) : original;
		const suffix = summary ? "..." : "\n...[message truncated to fit compaction budget]...";
		let low = 0;
		let high = trimmable.length;
		let best = -1;
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			message.content = middle < trimmable.length
				? `${fixedPrefix}${trimmable.slice(0, middle)}${suffix}`
				: original;
			if (options.estimateTokens(messages) <= options.tokenBudget) {
				best = middle;
				low = middle + 1;
			} else {
				high = middle - 1;
			}
		}
		message.content = best >= 0
			? (best < trimmable.length ? `${fixedPrefix}${trimmable.slice(0, best)}${suffix}` : original)
			: fixedPrefix;
	}
}

export function compactMessages(
	messages: OpenAIChatMessage[],
	options: CompactMessagesOptions
): OpenAIChatMessage[] {
	return compactMessagesDetailed(messages, options).messages;
}

export function compactMessagesDetailed(
	messages: OpenAIChatMessage[],
	options: CompactMessagesOptions
): CompactMessagesResult {
	if (messages.length <= 2) {
		const cloned = messages.map(cloneMessage);
		if (options.estimateTokens(cloned) > options.tokenBudget) {
			const systemCount = cloned.filter(message => message.role === "system").length;
			truncateToBudget(cloned, options, systemCount);
		}
		return { messages: cloned, didCompact: options.estimateTokens(messages) > options.tokenBudget, droppedMessages: [] };
	}

	// Fast path: already fits within budget — no compaction needed.
	// This prevents unnecessary summary creation that would invalidate the
	// upstream prompt cache on every turn of a long conversation.
	if (!options.forceKeepLastTurnOnly && options.estimateTokens(messages) <= options.tokenBudget) {
		return { messages: messages.map(cloneMessage), didCompact: false, droppedMessages: [] };
	}

	// Keep original system messages but exclude previously generated compaction
	// summaries.  Each compaction adds a new summary; stale ones would
	// accumulate and waste context budget every cycle.
	const previousSummaries = messages
		.filter(message => isGeneratedSummary(message, options.label))
		.map(message => typeof message.content === "string" ? message.content : "");
	const systems = messages
		.filter(message => message.role === "system" && !isGeneratedSummary(message, options.label))
		.map(cloneMessage);
	const nonSystem = messages.filter(message =>
		message.role !== "system" && !isGeneratedSummary(message, options.label)
	);
	if (nonSystem.length === 0) {
		return {
			messages: systems,
			didCompact: true,
			droppedMessages: [],
			previousSummary: previousSummaries.at(-1),
		};
	}

	// Manual recovery intentionally keeps only the newest complete user turn.
	// Normal compaction uses smaller transaction-safe units so an oversized
	// agent/tool turn cannot make a 50% target collapse to a ~16% retained tail.
	const turns = options.forceKeepLastTurnOnly
		? groupConversationTurns(nonSystem)
		: groupAutomaticCompactionUnits(nonSystem);
	let keptMessageCount = 0;
	let preferredKeepTurnIndex = turns.length - 1;
	while (preferredKeepTurnIndex > 0 && keptMessageCount < Math.max(1, options.keepLastCount)) {
		keptMessageCount += turns[preferredKeepTurnIndex].length;
		preferredKeepTurnIndex -= 1;
	}
	if (keptMessageCount < Math.max(1, options.keepLastCount)) {
		preferredKeepTurnIndex = 0;
	} else {
		preferredKeepTurnIndex += 1;
	}

	const buildCandidate = (keepTurnIndex: number): {
		messages: OpenAIChatMessage[];
		tailTurns: OpenAIChatMessage[][];
		summaryCount: number;
		keepTurnIndex: number;
	} => {
		const head = turns.slice(0, keepTurnIndex).flat();
		const truncateToolResult = (message: OpenAIChatMessage): OpenAIChatMessage => {
			if (!options.maxToolResultChars || options.maxToolResultChars <= 0) {
				return message;
			}
			if (typeof message.content !== "string") {
				return message;
			}
			const isToolResult = message.role === "tool"
				|| (message.role === "user" && message.content.includes("[tool_result"));
			if (!isToolResult || message.content.length <= options.maxToolResultChars) {
				return message;
			}
			return {
				...message,
				content: `${message.content.slice(0, Math.max(1, options.maxToolResultChars - 64))}\n...[tool result truncated during compaction to keep more recent context]...`,
			};
		};
		const tailTurns = turns.slice(keepTurnIndex).map(turn => turn.map(message => truncateToolResult(cloneMessage(message))));
		// The summary intentionally uses the user role (not system):
		// OpenAI-style prompts keep system messages and the tools block
		// before the conversation, and the upstream prompt cache covers
		// a byte-identical prefix. A system-role summary sits before
		// tools and changes on every compaction, so the changed summary
		// invalidated the cache for tools and every message after it.
		// As a user message it lands after the tools block, so a
		// compaction keeps system + tools cached and only the messages
		// block rewrites.
		const summaryMessages: OpenAIChatMessage[] = head.length > 0 || previousSummaries.length > 0
			? [{
				role: "user",
				content: buildSummaryContent(options.label, previousSummaries, head, options.summaryContent),
			}]
			: [];
		return {
			messages: [...systems, ...summaryMessages, ...tailTurns.flat()],
			tailTurns,
			summaryCount: summaryMessages.length,
			keepTurnIndex,
		};
	};

	// Find the earliest turn boundary whose summary + recent suffix fits. This
	// preserves as much useful recent context as the target allows. The previous
	// implementation jumped directly to preferredKeepTurnIndex and therefore
	// kept only a handful of messages even when most of the budget was free.
	const lastKeepTurnIndex = Math.max(0, turns.length - 1);
	let chosen = buildCandidate(lastKeepTurnIndex);
	if (!options.forceKeepLastTurnOnly) {
		const preferred = buildCandidate(preferredKeepTurnIndex);
		let low: number;
		let high: number;
		if (options.estimateTokens(preferred.messages) <= options.tokenBudget) {
			chosen = preferred;
			low = 1;
			high = preferredKeepTurnIndex - 1;
		} else {
			low = Math.max(1, preferredKeepTurnIndex + 1);
			high = lastKeepTurnIndex - 1;
		}
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			const candidate = buildCandidate(middle);
			if (options.estimateTokens(candidate.messages) <= options.tokenBudget) {
				chosen = candidate;
				high = middle - 1;
			} else {
				low = middle + 1;
			}
		}
	}

	const compacted = chosen.messages;
	let tailTurns = chosen.tailTurns;
	let droppedTurnCount = chosen.keepTurnIndex;
	const tailStart = systems.length + chosen.summaryCount;

	while (options.estimateTokens(compacted) > options.tokenBudget && tailTurns.length > 1) {
		tailTurns = tailTurns.slice(1);
		droppedTurnCount += 1;
		compacted.splice(tailStart, compacted.length - tailStart, ...tailTurns.flat());
	}

	truncateToBudget(compacted, options, systems.length);

	return {
		messages: compacted,
		didCompact: true,
		droppedMessages: turns.slice(0, droppedTurnCount).flat().map(cloneMessage),
		previousSummary: previousSummaries.at(-1),
	};
}
