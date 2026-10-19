import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { canonicalConversationUserAnchors } from "../providers/conversation-anchors";
import type { CursorFailedTurn } from "./native-store";
import { cursorCallSignature as signature } from "./call-signature";

export const cursorToolAlias = (name: string) => `vscode_${name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 70)}_${createHash("sha256").update(name).digest("hex").slice(0, 10)}`;

/** Repair a 1.18.2 inflight binding only when every native callback matches a completed visible call, including multiplicity. */
export function matchFailedCursorTurn(failure: CursorFailedTurn, messages: readonly vscode.LanguageModelChatRequestMessage[], previousUsers: readonly string[]): { users: string[]; callIds: string[]; replayCallIds?: string[] } | undefined {
	const anchors = canonicalConversationUserAnchors(messages);
	if (!previousUsers.length || previousUsers.length >= anchors.length || !previousUsers.every((key, index) => key === anchors[index]?.key) || !failure.calls.length) { return undefined; }
	const start = anchors[previousUsers.length].index;
	const results = new Set(messages.flatMap(message => message.content.flatMap(part => part instanceof vscode.LanguageModelToolResultPart ? [part.callId] : [])));
	const visible = messages.flatMap((message, index) => index < start || message.role !== vscode.LanguageModelChatMessageRole.Assistant ? [] : message.content.flatMap(part => part instanceof vscode.LanguageModelToolCallPart && part.callId.startsWith("cursor-") ? [{ index, callId: part.callId, signature: signature(cursorToolAlias(part.name), part.input) }] : []));
	if (new Set(visible.map(call => call.callId)).size !== visible.length) { return undefined; }
	const extra = new Set((failure.uncheckpointedCalls ?? []).map(call => signature(call.alias, call.input)));
	// Identical arguments with different results cannot safely identify which
	// callback was checkpointed. Keep the previous recovery point in that case.
	if (failure.calls.some(call => extra.has(signature(call.alias, call.input)))) { return undefined; }
	const wanted = [...failure.calls, ...failure.uncheckpointedCalls ?? []].map(call => signature(call.alias, call.input)).sort();
	const received = visible.map(call => call.signature).sort();
	if (wanted.length !== received.length || wanted.some((key, index) => key !== received[index]) || visible.some(call => !results.has(call.callId))) { return undefined; }
	const first = visible[0].index, last = visible.at(-1)!.index;
	if (anchors.some(anchor => anchor.index > first && anchor.index < last)) { return undefined; }
	return { users: anchors.filter(anchor => anchor.index < first).map(anchor => anchor.key), callIds: visible.map(call => call.callId),
		replayCallIds: extra.size ? visible.filter(call => extra.has(call.signature)).map(call => call.callId) : undefined };
}

/** Completed actions absent from the native snapshot are quoted, never re-executed. */
export function cursorRecoveryReplay(messages: readonly vscode.LanguageModelChatRequestMessage[], ids: readonly string[], before: number): vscode.LanguageModelChatRequestMessage[] {
	if (!ids.length) { return []; }
	const wanted = new Set(ids), calls = new Set<string>(), results = new Set<string>();
	const replay = messages.slice(0, before).flatMap(message => {
		const parts = message.content.filter((part): part is vscode.LanguageModelToolCallPart | vscode.LanguageModelToolResultPart => {
			if (part instanceof vscode.LanguageModelToolCallPart && wanted.has(part.callId)) {
				if (message.role !== vscode.LanguageModelChatMessageRole.Assistant || calls.has(part.callId)) { throw new Error("Cursor recovery found invalid or duplicate historical tool calls. No inference was started."); }
				calls.add(part.callId); return true;
			}
			if (part instanceof vscode.LanguageModelToolResultPart && wanted.has(part.callId)) {
				if (message.role !== vscode.LanguageModelChatMessageRole.User || !calls.has(part.callId) || results.has(part.callId)) { throw new Error("Cursor recovery found an invalid or duplicate historical tool result. No inference was started."); }
				results.add(part.callId); return true;
			}
			return false;
		});
		return parts.length ? [new vscode.LanguageModelChatMessage(message.role, parts)] : [];
	});
	if (ids.some(id => !calls.has(id) || !results.has(id))) { throw new Error("Cursor recovery is missing a completed tool result from the visible history. No inference was started; the checkpoint was preserved."); }
	return [vscode.LanguageModelChatMessage.User("Recovery after an interrupted Cursor stream: the following VS Code tool actions already completed, but their results were not included in the saved native checkpoint. These are quoted historical actions and results. Do not execute them again; use their results and continue the latest new user request."), ...replay];
}