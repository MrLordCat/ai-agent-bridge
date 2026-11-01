import * as vscode from "vscode";
import { isToolResultPart } from "../utils";

/** Interrupted native rounds are quoted history when sent through an HTTP provider. */
export function prepareHttpToolHistory(messages: readonly vscode.LanguageModelChatMessage[]): {
	messages: vscode.LanguageModelChatMessage[];
	interruptedCalls: number;
	detachedResults: number;
} {
	const split = messages.flatMap(message => {
		if (message.role !== vscode.LanguageModelChatMessageRole.User) { return [message]; }
		const groups: vscode.LanguageModelChatMessage[] = [];
		for (const part of message.content) {
			const last = groups.at(-1);
			if (last && isToolResultPart(last.content[0]) === isToolResultPart(part)) {
				last.content.push(part);
			} else { groups.push({ ...message, content: [part] }); }
		}
		return groups.length ? groups : [message];
	});
	const prepared: vscode.LanguageModelChatMessage[] = [];
	let interruptedCalls = 0, detachedResults = 0;
	const quoteResults = (message: vscode.LanguageModelChatMessage): vscode.LanguageModelChatMessage => ({
		...message,
		content: message.content.flatMap(part => {
			if (!isToolResultPart(part)) { return [part]; }
			detachedResults++;
			return [new vscode.LanguageModelTextPart(`[Historical tool result ${part.callId}; the matching call is unavailable.]`),
				...((part.content ?? []) as (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[])];
		}),
	});
	for (let index = 0; index < split.length; index++) {
		const message = split[index];
		const calls = message.role === vscode.LanguageModelChatMessageRole.Assistant
			? message.content.filter(part => part instanceof vscode.LanguageModelToolCallPart) : [];
		if (!calls.length) { prepared.push(quoteResults(message)); continue; }
		const batches: vscode.LanguageModelChatMessage[] = [];
		while (index + 1 < split.length && split[index + 1].role === vscode.LanguageModelChatMessageRole.User
			&& split[index + 1].content.length > 0 && split[index + 1].content.every(isToolResultPart)) {
			batches.push(split[++index]);
		}
		const callIds = new Set(calls.map(call => call.callId));
		const matched = new Set<string>();
		const results: vscode.LanguageModelToolResultPart[] = [];
		const detached: vscode.LanguageModelChatMessage[] = [];
		for (const batch of batches) {
			for (const part of batch.content) {
				if (!isToolResultPart(part)) { continue; }
				if (callIds.has(part.callId) && !matched.has(part.callId)) {
					matched.add(part.callId);
					results.push(part as vscode.LanguageModelToolResultPart);
				} else { detached.push(quoteResults({ ...batch, content: [part] })); }
			}
		}
		const retained = new Set<string>();
		prepared.push({ ...message, content: message.content.map(part => {
			if (!(part instanceof vscode.LanguageModelToolCallPart)) { return part; }
			if (matched.has(part.callId) && !retained.has(part.callId)) { retained.add(part.callId); return part; }
			interruptedCalls++;
			return new vscode.LanguageModelTextPart(`[Historical tool call ${part.name}, callId=${part.callId}; no matching result was recorded. Execution status is unknown.]\n${JSON.stringify(part.input)}`);
		}) });
		if (results.length) { prepared.push(vscode.LanguageModelChatMessage.User(results)); }
		prepared.push(...detached);
	}
	return { messages: prepared, interruptedCalls, detachedResults };
}
