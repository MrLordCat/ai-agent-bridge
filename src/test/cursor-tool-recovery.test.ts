import * as assert from "node:assert";
import * as vscode from "vscode";
import { canonicalConversationUserAnchors } from "../providers/conversation-anchors";
import { cursorRecoveryReplay, cursorToolAlias, matchFailedCursorTurn } from "../cursor/tool-turn-recovery";
import type { CursorFailedTurn } from "../cursor/native-store";

function fixture() {
	const calls = [new vscode.LanguageModelToolCallPart("cursor-one", "replace_string_in_file", { file: "one", old: "a", new: "b" }), new vscode.LanguageModelToolCallPart("cursor-two", "read_file", { file: "two" })];
	const messages = [vscode.LanguageModelChatMessage.User("EARLIER_DONE"), vscode.LanguageModelChatMessage.Assistant("Done"), vscode.LanguageModelChatMessage.User("FAILED_CURRENT"),
		new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, calls),
		new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, calls.map(call => new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart("Completed result")]))),
		vscode.LanguageModelChatMessage.User("NEW_CONTINUATION")];
	const failure: CursorFailedTurn = { runId: "run-failed", error: "[resource_exhausted] Error", checkpoint: { schemaVersion: 1, rootBlobId: "failed-safe" },
		calls: calls.map(call => ({ alias: cursorToolAlias(call.name), input: call.input })).reverse() };
	const previous = canonicalConversationUserAnchors(messages.slice(0, 1)).map(anchor => anchor.key);
	return { calls, messages, failure, previous };
}
suite("Cursor failed tool-turn recovery", () => {
	test("quotes only completed calls that native events show outside the checkpoint", () => {
		const f = fixture(), [acknowledged, tail] = f.failure.calls;
		const matched = matchFailedCursorTurn({ ...f.failure, calls: [acknowledged], uncheckpointedCalls: [tail] }, f.messages, f.previous);
		assert.deepStrictEqual(matched?.replayCallIds, ["cursor-one"]);
		const replay = cursorRecoveryReplay(f.messages, matched!.replayCallIds!, 5);
		assert.strictEqual(replay.length, 3);
		assert.ok(replay[0].content.some(p => p instanceof vscode.LanguageModelTextPart && p.value.includes("already completed")));
		assert.deepStrictEqual(replay[1].content.map(p => (p as vscode.LanguageModelToolCallPart).callId), ["cursor-one"]);
		assert.deepStrictEqual(replay[2].content.map(p => (p as vscode.LanguageModelToolResultPart).callId), ["cursor-one"]);
		assert.strictEqual(matched?.users.length, 2);
	});
	test("rejects missing, reordered or duplicate recovery results and ambiguous checkpoint/tail signatures", () => {
		const f = fixture();
		assert.throws(() => cursorRecoveryReplay(f.messages.filter((_, i) => i !== 4), ["cursor-one"], 4), /missing a completed tool result/);
		assert.throws(() => cursorRecoveryReplay([f.messages[4], f.messages[3]], ["cursor-one"], 2), /invalid or duplicate historical tool result/);
		assert.throws(() => cursorRecoveryReplay([f.messages[3], f.messages[4], f.messages[4]], ["cursor-one"], 3), /invalid or duplicate historical tool result/);
		assert.strictEqual(matchFailedCursorTurn({ ...f.failure, uncheckpointedCalls: [f.failure.calls[0]] }, f.messages, f.previous), undefined);
	});
	test("matches a completed parallel batch independent of callback completion order and excludes the next user turn", () => {
		const f = fixture(), matched = matchFailedCursorTurn(f.failure, f.messages, f.previous);
		assert.deepStrictEqual(matched?.callIds, ["cursor-one", "cursor-two"]); assert.strictEqual(matched?.users.length, 2);
	});
	test("rejects missing results, changed inputs, duplicate call counts and rewritten user branches", () => {
		const f = fixture();
		assert.strictEqual(matchFailedCursorTurn(f.failure, f.messages.filter((_, i) => i !== 4), f.previous), undefined);
		assert.strictEqual(matchFailedCursorTurn({ ...f.failure, calls: [...f.failure.calls, f.failure.calls[0]] }, f.messages, f.previous), undefined);
		assert.strictEqual(matchFailedCursorTurn({ ...f.failure, calls: f.failure.calls.map(call => ({ ...call, input: { changed: true } })) }, f.messages, f.previous), undefined);
		assert.strictEqual(matchFailedCursorTurn(f.failure, [vscode.LanguageModelChatMessage.User("EDITED"), ...f.messages.slice(1)], f.previous), undefined);
	});
});