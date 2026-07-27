import type { OpenAIChatMessage } from "../types";
import { summarizeToolCallArguments, summarizeToolResultContent } from "./tool-result-summary";

const MAX_SUMMARY_MESSAGES = 32;
const MAX_SUMMARY_CHARS = 6000;
const MAX_SUMMARY_LINE_CHARS = 480;

const SIGNAL_REGEX = /(?:^|\b)(?:error|failed|failure|warning|fixed|implemented|changed|created|updated|removed|decision|todo|next|path|file|commit|ошиб|сбой|исправ|реализ|измен|созда|обнов|удал|решен|решил|далее|следующ)/i;
const PATH_REGEX = /(?:[A-Za-z]:\\|\.?\.?\/|[\w.-]+\/)[\w./\\-]+\.[A-Za-z0-9]{1,10}(?::\d+)?/;
const FENCED_CODE_REGEX = /```([\w.+-]*)\s*\n([\s\S]*?)```/g;

interface CompactMessagesOptions {
	tokenBudget: number;
	keepLastCount: number;
	label: string;
	estimateTokens(messages: OpenAIChatMessage[]): number;
}

interface SummaryCandidate {
	index: number;
	priority: number;
	role: OpenAIChatMessage["role"];
	line: string;
}

function contentToText(content: OpenAIChatMessage["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map(part => part.type === "text" && typeof part.text === "string" ? part.text : "")
			.join("\n");
	}
	return "";
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

function selectSummaryLines(messages: OpenAIChatMessage[]): string[] {
	const candidates: SummaryCandidate[] = [];
	for (let index = 0; index < messages.length; index += 1) {
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

export function compactMessages(
	messages: OpenAIChatMessage[],
	options: CompactMessagesOptions
): OpenAIChatMessage[] {
	if (messages.length <= 2) {
		return messages.map(cloneMessage);
	}

	const systems = messages.filter(message => message.role === "system").map(cloneMessage);
	const nonSystem = messages.filter(message => message.role !== "system");
	if (nonSystem.length === 0) {
		return systems;
	}

	const turns = groupConversationTurns(nonSystem);
	let keptMessageCount = 0;
	let keepTurnIndex = turns.length - 1;
	while (keepTurnIndex > 0 && keptMessageCount < Math.max(1, options.keepLastCount)) {
		keptMessageCount += turns[keepTurnIndex].length;
		keepTurnIndex -= 1;
	}
	if (keptMessageCount < Math.max(1, options.keepLastCount)) {
		keepTurnIndex = 0;
	} else {
		keepTurnIndex += 1;
	}

	const head = turns.slice(0, keepTurnIndex).flat();
	let tailTurns = turns.slice(keepTurnIndex).map(turn => turn.map(cloneMessage));
	const summaryLines = selectSummaryLines(head);
	const summaryMessages: OpenAIChatMessage[] = head.length > 0
		? [{
			role: "system",
			content: summaryLines.length > 0
				? `${options.label}:\n${summaryLines.join("\n")}`
				: `${options.label}: prior turns were compacted to fit model context.`,
		}]
		: [];
	const compacted: OpenAIChatMessage[] = [
		...systems,
		...summaryMessages,
		...tailTurns.flat(),
	];
	const tailStart = systems.length + summaryMessages.length;

	while (options.estimateTokens(compacted) > options.tokenBudget && tailTurns.length > 1) {
		tailTurns = tailTurns.slice(1);
		compacted.splice(tailStart, compacted.length - tailStart, ...tailTurns.flat());
	}

	if (options.estimateTokens(compacted) > options.tokenBudget) {
		for (let index = systems.length; index < compacted.length; index += 1) {
			const message = compacted[index];
			if (typeof message.content === "string" && message.content.length > 1200) {
				message.content = `${message.content.slice(0, 1200)}...`;
			}
		}
	}

	return compacted;
}
