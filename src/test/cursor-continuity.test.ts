import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import type { AgentOptions, SendOptions, SDKUserMessage, TokenUsage } from "@cursor/sdk";
import { CursorSdkTransport, type CursorLocalAgent } from "../cursor/sdk-transport";
import { cursorPrompt, cursorTranscript } from "../cursor/message-adapter";
import { CursorHistoryArchive } from "../cursor/history-transfer";
import { parseCursorUsage, type CursorLiveTurn, type CursorRecordedUsage } from "../cursor/turn-metrics";
import type { ChatModelSource } from "../model-sources/source-routing";
import { CompositeChatModelProvider } from "../composite-provider";
import { ConversationHistory } from "../providers/conversation-history";
import { conversationUserAnchors } from "../providers/conversation-anchors";
import { CursorApiClient } from "../cursor/api-client";
import { CursorProfileTransport } from "../cursor/profile-transport";
import type { CursorFailedTurn } from "../cursor/native-store";
import { cursorToolAlias } from "../cursor/tool-turn-recovery";

const none: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined) };
const source: ChatModelSource = { key: "api-cursor-continuity", label: "Cursor", serverUrl: "https://api.cursor.com/v1", apiKey: "fixture-key", protocol: "cursor" };
const options: vscode.ProvideLanguageModelChatResponseOptions = { tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }], toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _copilotConversationId: "cursor-chat" } };
const user = (text: string) => vscode.LanguageModelChatMessage.User(text);
const assistant = (text: string) => vscode.LanguageModelChatMessage.Assistant(text);
const nativeUsage: TokenUsage = { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 97, totalTokens: 2017 };
function memory() {
	const values = new Map<string, unknown>(); let fail = false;
	const state: vscode.Memento = { keys: () => [...values.keys()], get: <T>(key: string, fallback?: T) => (values.get(key) as T | undefined) ?? fallback,
		update: async (key, value) => { if (fail) { throw new Error("fixture storage unavailable"); } values.set(key, structuredClone(value)); } } as vscode.Memento;
	return { state, values, fail: () => { fail = true; } };
}
async function fixture(state = memory().state, coldStartMaxChars?: number) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-continuity-"));
	const sent: Array<{ input: SDKUserMessage; options: SendOptions; agent: string }> = [], created: AgentOptions[] = [], restored: string[] = [];
	const live: CursorLiveTurn[] = [], usage: CursorRecordedUsage[] = [];
	let closes = 0, resumesFail = false, requestTool = false, omitUsage = false, backendFailed = false;
	let oldFailure: CursorFailedTurn | undefined;
	const makeAgent = (id: string): CursorLocalAgent => ({ agentId: id, close: () => { closes++; }, send: async (input, send) => {
		sent.push({ input, options: send, agent: id });
		const completion = Promise.resolve().then(async () => {
			if (requestTool && !input.text.startsWith("History import")) { await Object.values(send.local!.customTools!)[0].execute({ path: "test.txt" }, {}); }
			const text = input.text.startsWith("History import") ? "ACK" : "Cursor continued.";
			await send.onDelta?.({ update: { type: "text-delta", text } });
			return { status: backendFailed ? "error" : "finished", result: text, error: backendFailed ? { message: "[resource_exhausted] Error" } : undefined, usage: omitUsage ? undefined : nativeUsage };
		});
		return { wait: () => completion, cancel: async () => undefined };
	} });
	const dependencies = { state, storageRoot: root, coldStartMaxChars, cwd: () => root, available: () => true,
		checkpoint: async () => ({ schemaVersion: 1 as const, rootBlobId: `native-${sent.length}` }),
		failedTurn: async () => oldFailure ?? (backendFailed ? { runId: "run-failed", error: "[resource_exhausted] Error", checkpoint: { schemaVersion: 1 as const, rootBlobId: "native-failed-safe" }, calls: [] } : undefined),
		createAgent: async (config: AgentOptions) => { created.push(config); return makeAgent(`agent-${created.length}`); },
		resumeAgent: async (id: string) => { restored.push(id); if (resumesFail) { throw new Error("fixture checkpoint missing"); } return makeAgent(id); } };
	const make = () => { const sdk = new CursorSdkTransport(dependencies); sdk.onDidUpdateLiveTurn(update => live.push(update)); sdk.onDidRecordUsage(value => usage.push(value)); return sdk; };
	let sdk = make();
	return { root, sent, created, restored, live, usage, dependencies, get sdk() { return sdk; },
		reload: () => { sdk.dispose(); sdk = make(); }, failResume: () => { resumesFail = true; }, allowResume: () => { resumesFail = false; }, tool: () => { requestTool = true; }, stopTool: () => { requestTool = false; }, missingUsage: () => { omitUsage = true; }, closes: () => closes,
		failBackend: () => { backendFailed = true; }, recoverBackend: () => { backendFailed = false; },
		recoverOldFailure: (value?: CursorFailedTurn) => { oldFailure = value; },
		respond: (messages: vscode.LanguageModelChatRequestMessage[], parts: vscode.LanguageModelResponsePart[] = [], config = options, profile = source, token = none, maximum = 1_000_000) =>
			sdk.respond(profile, { id: "test-model" }, () => cursorTranscript(messages), messages, config, { report: part => parts.push(part) }, token, maximum),
		dispose: async () => { sdk.dispose(); await fs.rm(root, { recursive: true, force: true }); } };
}

suite("Cursor conversation continuity", () => {
	test("recovers a stream interrupted between callback execution and checkpointing without rerunning completed tools", async () => {
		const f = await fixture();
		try {
			await f.respond([user("EARLIER_COMPLETE")]);
			const file = path.join(f.root, "completed-sessions.json"), document = JSON.parse(await fs.readFile(file, "utf8"));
			document.sessions[0].inflight = true; await fs.writeFile(file, JSON.stringify(document));
			const first = new vscode.LanguageModelToolCallPart("cursor-checkpointed", "read_file", { file: "first" });
			const tail = new vscode.LanguageModelToolCallPart("cursor-completed-tail", "run_in_terminal", { command: "already executed" });
			const results = [new vscode.LanguageModelToolResultPart(first.callId, [new vscode.LanguageModelTextPart("CHECKPOINTED_OUTPUT")]),
				new vscode.LanguageModelToolResultPart(tail.callId, [new vscode.LanguageModelTextPart("UNACKNOWLEDGED_OUTPUT")])];
			const messages = [user("EARLIER_COMPLETE"), assistant("Done"), user("FAILED_REQUEST"),
				new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [first, tail]),
				new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, results)];
			f.recoverOldFailure({ runId: "run-partial", error: "[unknown] Premature close", checkpoint: { schemaVersion: 1, rootBlobId: "partial-safe" },
				startCheckpoint: document.sessions[0].nativeCheckpoint, calls: [{ alias: cursorToolAlias(first.name), input: first.input }],
				uncheckpointedCalls: [{ alias: cursorToolAlias(tail.name), input: tail.input }] });
			f.reload();
			for (let retry = 0; retry < 3; retry++) {
				await assert.rejects(f.respond(messages), /Premature close/);
				if (retry === 0) {
					const oldReceipt = JSON.parse(await fs.readFile(file, "utf8"));
					oldReceipt.failures[0].message = "Cursor SDK run ended with status error: [unknown] Premature close";
					await fs.writeFile(file, JSON.stringify(oldReceipt)); f.reload();
					await assert.rejects(f.respond(messages), /Send a new message/);
				}
			}
			assert.strictEqual(f.sent.length, 1);
			let saved = JSON.parse(await fs.readFile(file, "utf8")).sessions[0];
			assert.strictEqual(saved.nativeCheckpoint.rootBlobId, "partial-safe"); assert.deepStrictEqual(saved.replayCallIds, [tail.callId]);
			f.reload();
			const missing = [...messages.slice(0, -1), new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [results[0]]), user("CONTINUE_NEW")];
			await assert.rejects(f.respond(missing), /missing a completed tool result/); assert.strictEqual(f.sent.length, 1);
			saved = JSON.parse(await fs.readFile(file, "utf8")).sessions[0]; assert.strictEqual(saved.nativeCheckpoint.rootBlobId, "partial-safe");
			f.reload(); await f.respond([...messages, user("CONTINUE_NEW")]);
			assert.strictEqual(f.sent.length, 2); assert.strictEqual(f.created.length, 1);
			assert.match(f.sent[1].input.text, /already completed/); assert.match(f.sent[1].input.text, /UNACKNOWLEDGED_OUTPUT/);
			assert.ok(!f.sent[1].input.text.includes("CHECKPOINTED_OUTPUT")); assert.ok(!f.sent[1].input.text.includes("FAILED_REQUEST"));
			assert.strictEqual(JSON.parse(await fs.readFile(file, "utf8")).sessions[0].replayCallIds, undefined);
			f.reload(); await f.respond([...messages, user("CONTINUE_NEW"), assistant("Cursor continued."), user("NEXT")]);
			assert.ok(!f.sent[2].input.text.includes("UNACKNOWLEDGED_OUTPUT")); assert.strictEqual(f.created.length, 1);
		} finally { await f.dispose(); }
	});
	test("repairs an orphaned 1.18.2 result batch from the matching failed checkpoint without replaying completed work", async () => {
		const f = await fixture();
		try {
			await f.respond([user("EARLIER_COMPLETE")]);
			const file = path.join(f.root, "completed-sessions.json"), document = JSON.parse(await fs.readFile(file, "utf8"));
			document.sessions[0].inflight = true; await fs.writeFile(file, JSON.stringify(document));
			const call = new vscode.LanguageModelToolCallPart("cursor-legacy-completed", "read_file", { file: "already-read.txt" });
			const messages = [user("EARLIER_COMPLETE"), assistant("Done"), user("CURRENT_FAILED"), new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [call]),
				new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart("EXISTING_RESULT")])])];
			f.recoverOldFailure({ runId: "run-legacy-failed", error: "[resource_exhausted] Error", checkpoint: { schemaVersion: 1, rootBlobId: "legacy-failed-safe" },
				startCheckpoint: document.sessions[0].nativeCheckpoint, calls: [{ alias: cursorToolAlias(call.name), input: call.input }] });
			f.reload(); await assert.rejects(f.respond(messages), /resource_exhausted/);
			assert.strictEqual(f.sent.length, 1); assert.strictEqual(f.created.length, 1);
			const repaired = JSON.parse(await fs.readFile(file, "utf8")).sessions[0];
			assert.strictEqual(repaired.users.length, 2); assert.strictEqual(repaired.nativeCheckpoint.rootBlobId, "legacy-failed-safe");
			f.recoverOldFailure(); f.reload(); await f.respond([...messages, user("CONTINUE_NOW")]);
			assert.strictEqual(f.sent.length, 2); assert.strictEqual(f.created.length, 1); assert.deepStrictEqual(f.restored, ["agent-1"]);
			assert.ok(!f.sent[1].input.text.includes("EXISTING_RESULT")); assert.match(f.sent[1].input.text, /CONTINUE_NOW/);
		} finally { await f.dispose(); }
	});
	test("repeated tool results retain the original backend error across reload and never start another model run", async () => {
		const f = await fixture(), parts: vscode.LanguageModelResponsePart[] = [];
		try {
			f.tool(); f.failBackend(); await f.respond([user("ORIGINAL_REQUEST")], parts);
			const call = parts.find(part => part instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart;
			const result = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart("ALREADY_EXECUTED_RESULT")])]);
			const messages = [user("ORIGINAL_REQUEST"), new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [call]), result];
			for (let retry = 0; retry < 4; retry++) {
				if (retry === 2) { f.reload(); }
				await assert.rejects(f.respond(messages), error => {
					assert.ok(error instanceof Error); assert.match(error.message, /resource_exhausted/);
					assert.doesNotMatch(error.message, /no longer active/); return true;
				});
			}
			assert.strictEqual(f.sent.length, 1); assert.strictEqual(f.created.length, 1);
			const disk = JSON.parse(await fs.readFile(path.join(f.root, "completed-sessions.json"), "utf8"));
			assert.strictEqual(disk.sessions[0].nativeCheckpoint.rootBlobId, "native-failed-safe");
			assert.deepStrictEqual(disk.failures[0].callIds, [call.callId]);
			f.recoverBackend(); f.stopTool();
			await f.respond([...messages, assistant("Provider stopped"), user("CONTINUE_NEW_MESSAGE")]);
			assert.deepStrictEqual(f.restored, ["agent-1"]); assert.strictEqual(f.sent.length, 2); assert.strictEqual(f.created.length, 1);
			assert.match(f.sent[1].input.text, /CONTINUE_NEW_MESSAGE/); assert.ok(!f.sent[1].input.text.includes("ORIGINAL_REQUEST"));
			await assert.rejects(f.respond(messages, [], { ...options, modelOptions: { _copilotConversationId: "different-chat" } }), /no longer active/);
		} finally { await f.dispose(); }
	});
	test("keeps one agent when VS Code splits text parts and refreshes host-only metadata", async () => {
		const f = await fixture();
		try {
			await f.respond([user("RULE<context>terminal OLD</context>FIRST")]);
			const repacked = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("RULE<con"), new vscode.LanguageModelTextPart("text>terminal NEW</context>FIRST"), new vscode.LanguageModelTextPart("<attachments>new editor state</attachments>")]);
			await f.respond([repacked, assistant("Cursor continued."), user("SECOND")]);
			assert.strictEqual(f.created.length, 1); assert.strictEqual(f.sent.length, 2); assert.ok(!f.sent[1].input.text.includes("RULE"));
			assert.match(f.sent[1].input.text, /terminal NEW/); assert.strictEqual(f.live.at(-1)?.turn.sessionMode, "warm");
		} finally { await f.dispose(); }
	});
	test("continues from the last retained completed user anchor after earlier history is repacked", async () => {
		const f = await fixture();
		try {
			await f.respond([user("OLDER"), assistant("old answer"), user("LAST_COMPLETED")]);
			await f.respond([user("RENDERER_PREFIX_CHANGED"), assistant("old answer"), user("LAST_COMPLETED"), assistant("Cursor continued."), user("NEXT")]);
			assert.strictEqual(f.created.length, 1); assert.ok(!f.sent[1].input.text.includes("LAST_COMPLETED"));
			assert.match(f.live.at(-1)!.turn.cacheMissDetail!, /history_rebased/);
		} finally { await f.dispose(); }
	});
	test("rejects an unmatched edited branch without replaying or discarding its valid session", async () => {
		const f = await fixture();
		try {
			await f.respond([user("ORIGINAL")]);
			await assert.rejects(f.respond([user("EDITED"), user("NEXT")]), /No inference was started/);
			assert.strictEqual(f.created.length, 1); assert.strictEqual(f.sent.length, 1); assert.strictEqual(f.closes(), 0);
			await f.respond([user("ORIGINAL"), assistant("Cursor continued."), user("VALID_NEXT")]);
			assert.strictEqual(f.created.length, 1); assert.strictEqual(f.sent.length, 2);
		} finally { await f.dispose(); }
	});
	test("model catalog refresh preserves a warm native session", async () => {
		const f = await fixture();
		const profile = new CursorProfileTransport(s => new CursorApiClient(s.apiKey!, s.serverUrl), f.sdk);
		try {
			await f.respond([user("FIRST")]); profile.refresh();
			await f.respond([user("FIRST"), assistant("Cursor continued."), user("SECOND")]);
			assert.strictEqual(f.created.length, 1); assert.strictEqual(f.restored.length, 0); assert.strictEqual(f.sent.length, 2);
		} finally { profile.dispose(); await f.dispose(); }
	});
	test("tool availability, parameter ordering and payload-budget changes do not reset native history", async () => {
		const f = await fixture();
		const invoke = (messages: vscode.LanguageModelChatRequestMessage[], params: Array<{ id: string; value: string }>, config = options, profile = source) =>
			f.sdk.respond(profile, { id: "test-model", params }, () => cursorTranscript(messages), messages, config, { report: () => undefined }, none, 1_000_000);
		try {
			await invoke([user("FIRST")], [{ id: "effort", value: "xhigh" }, { id: "context", value: "1m" }]);
			await invoke([user("FIRST"), assistant("Cursor continued."), user("SECOND")], [{ id: "context", value: "1m" }, { id: "effort", value: "xhigh" }], { ...options, tools: [] }, { ...source, workingContextLength: 900_000 });
			assert.strictEqual(f.created.length, 1); assert.strictEqual(f.sent.length, 2); assert.deepStrictEqual(f.sent[1].options.local?.customTools, {});
		} finally { await f.dispose(); }
	});
	test("migrates a completed 1.18 checkpoint without paying for a full-history replay", async () => {
		const state = memory(), f = await fixture(state.state);
		const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
		try {
			state.values.set("llamacpp.cursor.sessions.v1", [{ key: hash([f.root, source.key, "cursor-chat"]),
				identity: hash([f.root, source.key, source.serverUrl, source.apiKey, undefined, { id: "test-model" }, "cursor-chat", true]),
				agentId: "agent-legacy", users: conversationUserAnchors([user("LEGACY_FIRST")]).map(a => a.key), updatedAt: Date.now() }]);
			f.reload(); await f.respond([user("LEGACY_FIRST"), assistant("old answer"), user("NEXT")]);
			assert.deepStrictEqual(f.restored, ["agent-legacy"]); assert.strictEqual(f.created.length, 0); assert.strictEqual(f.sent.length, 1);
			assert.ok(!f.sent[0].input.text.includes("LEGACY_FIRST"));
		} finally { await f.dispose(); }
	});
	test("a warm preflight size error keeps its completed agent for the next valid request", async () => {
		const f = await fixture();
		try {
			await f.respond([user("FIRST")]);
			await assert.rejects(f.respond([user("FIRST"), assistant("Cursor continued."), user("x".repeat(80_000))], [], options, source, none, 60_000), /No inference requests were sent/);
			assert.strictEqual(f.sent.length, 1); assert.strictEqual(f.closes(), 0);
			await f.respond([user("FIRST"), assistant("Cursor continued."), user("SMALL_NEXT")]);
			assert.strictEqual(f.created.length, 1); assert.strictEqual(f.sent.length, 2);
		} finally { await f.dispose(); }
	});
	test("recovers retained-away Codex messages from the shared journal after reload", async () => {
		const f = await fixture();
		try {
			const makeComposite = () => new CompositeChatModelProvider({ history: new ConversationHistory(path.join(f.root, "journal")), providers: [
				{ id: "codex", ownsModel: id => id.startsWith("codex::"), provider: { provideLanguageModelChatInformation: async () => [], provideTokenCount: async () => 1,
					provideLanguageModelChatResponse: async (_model, _messages, _options, progress) => { progress.report(new vscode.LanguageModelTextPart("CODEX_FINDING")); } } },
				{ id: "http", ownsModel: id => id.startsWith("api-"), usesConversationHistory: async () => true, provider: { provideLanguageModelChatInformation: async () => [], provideTokenCount: async () => 1,
					provideLanguageModelChatResponse: async (_model, messages, config, progress, token) => f.sdk.respond(source, { id: "test-model" }, () => cursorTranscript(messages), messages, config, progress, token, 1_000_000) } },
			] });
			const model = { id: "codex::fixture" } as vscode.LanguageModelChatInformation;
			const first = makeComposite();
			await first.provideLanguageModelChatResponse(model, [user("EARLY_REQUIREMENT"), assistant("OLD_FACT"), user("Investigate")], options, { report: () => undefined }, none); first.dispose();
			const restored = makeComposite();
			await restored.provideLanguageModelChatResponse({ ...model, id: "api-cursor::test-model" }, [user("Investigate"), assistant("CODEX_FINDING"), user("Continue in Cursor")], options, { report: () => undefined }, none);
			assert.match(f.sent[0].input.text, /EARLY_REQUIREMENT/); assert.match(f.sent[0].input.text, /OLD_FACT/); assert.match(f.sent[0].input.text, /CODEX_FINDING/);
			assert.match(f.sent[0].input.text, /Complete visible Chat transcript/); restored.dispose();
		} finally { await f.dispose(); }
	});
	test("a native host conversation ID restores the legacy large-chat checkpoint and resumes tools without a cold replay", async () => {
		const f = await fixture(undefined, 2_000_000), first = "ORIGINAL_NATIVE_HISTORY" + "x".repeat(1_453_124);
		const model = { id: "api-cursor::test-model" } as vscode.LanguageModelChatInformation;
		const config = { ...options, modelOptions: { _conversationId: "cursor-chat" } };
		const make = () => new CompositeChatModelProvider({ history: new ConversationHistory(path.join(f.root, "journal")), providers: [
			{ id: "http", ownsModel: () => true, usesConversationHistory: async () => true, provider: { provideLanguageModelChatInformation: async () => [], provideTokenCount: async () => 1,
				provideLanguageModelChatResponse: async (_model, messages, options, progress, token) => f.sdk.respond(source, { id: "test-model" }, () => cursorTranscript(messages), messages, options, progress, token, 3_000_000) } },
		] });
		let composite = make();
		try {
			await f.respond([user(first)], [], options, source, none, 3_000_000);
			f.dependencies.coldStartMaxChars = 64_000; f.reload(); f.tool();
			const messages = [user(first), assistant("Cursor continued."), user("NEW_HOST_CONTINUATION")], parts: vscode.LanguageModelResponsePart[] = [];
			await composite.provideLanguageModelChatResponse(model, messages, config, { report: part => parts.push(part) }, none);
			const call = parts.find(p => p instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart;
			assert.ok(call); assert.deepStrictEqual(f.restored, ["agent-1"]); assert.strictEqual(f.created.length, 1);
			assert.ok(!f.sent[1].input.text.includes("ORIGINAL_NATIVE_HISTORY")); assert.match(f.sent[1].input.text, /NEW_HOST_CONTINUATION/);
			messages.push(vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart("TOOL_DONE")])]));
			await composite.provideLanguageModelChatResponse(model, messages, config, { report: () => undefined }, none);
			assert.strictEqual(f.sent.length, 2);
			composite.dispose(); f.reload(); f.stopTool(); composite = make();
			messages.push(assistant("Cursor continued."), user("NEXT_RELOAD_CONTINUATION"));
			await composite.provideLanguageModelChatResponse(model, messages, config, { report: () => undefined }, none);
			assert.strictEqual(f.created.length, 1); assert.deepStrictEqual(f.restored, ["agent-1", "agent-1"]);
			assert.ok(f.sent[2].input.text.length < 10_000); assert.match(f.sent[2].input.text, /NEXT_RELOAD_CONTINUATION/);
			assert.ok((await fs.readdir(path.join(f.root, "journal"))).some(file => file.endsWith(".json")));
		} finally { composite.dispose(); await f.dispose(); }
	});
	test("updates volatile host context without replaying the stable prefix", async () => {
		const f = await fixture();
		try {
			await f.respond([user("RULE <context>terminal OLD</context>")]);
			await f.respond([user("RULE <context>terminal NEW</context>"), assistant("Cursor continued."), user("NEXT")]);
			assert.strictEqual(f.created.length, 1); assert.match(f.sent[1].input.text, /terminal NEW/); assert.ok(!f.sent[1].input.text.includes("RULE"));
		} finally { await f.dispose(); }
	});
	test("keeps a warm native agent and sends only new own and foreign-provider turns", async () => {
		const f = await fixture();
		try {
			await f.respond([user("PIN_FIRST=42")]);
			await f.respond([user("PIN_FIRST=42"), assistant("Cursor continued."), user("Codex checked the repo"), assistant("CODEX_FOUND=77"), user("Continue with Cursor")]);
			assert.strictEqual(f.created.length, 1); assert.strictEqual(f.closes(), 0);
			assert.ok(!f.sent[1].input.text.includes("PIN_FIRST")); assert.ok(f.sent[1].input.text.includes("CODEX_FOUND=77"));
			assert.strictEqual(f.live.at(-1)?.turn.sessionMode, "warm"); assert.strictEqual(f.usage.length, 2);
			assert.strictEqual(f.usage[1].inputTokens, 1000); assert.strictEqual(f.live.at(-1)?.turn.promptCacheHitPercent, 90);
			assert.strictEqual(f.live.at(-1)?.turn.providerKind, "cursor"); assert.strictEqual(f.live.at(-1)?.sourceKey, source.key);
			assert.strictEqual(f.live.at(-1)?.runtime.contextUsedTokens, undefined);
		} finally { await f.dispose(); }
	});
	test("restores a durable checkpoint with the current callback catalog after reload", async () => {
		const f = await fixture();
		try {
			await f.respond([user("FIRST")]); f.reload();
			const next = { ...options, tools: [{ ...options.tools![0], name: "search_repo" }] };
			await f.respond([user("FIRST"), assistant("Cursor continued."), user("SECOND")], [], next);
			assert.deepStrictEqual(f.restored, ["agent-1"]); assert.strictEqual(f.created.length, 1);
			assert.ok(f.sent[1].input.text.includes("SECOND")); assert.ok(!f.sent[1].input.text.includes("FIRST"));
			assert.ok(Object.keys(f.sent[1].options.local!.customTools!).some(name => name.includes("search_repo")));
			assert.strictEqual(f.live.at(-1)?.turn.sessionMode, "restored");
			const turn = f.live.at(-1)!.turn;
			assert.strictEqual(turn.cursorCacheDiagnostics?.toolCatalogChanged, true);
			assert.strictEqual(turn.cursorCacheDiagnostics?.sentTextChars, f.sent[1].input.text.length);
			assert.strictEqual(turn.cursorCacheDiagnostics?.sentMessages, 1);
			assert.ok(turn.gapSinceLastResponseMs! >= 0);
			const saved = JSON.parse(await fs.readFile(path.join(f.root, "completed-sessions.json"), "utf8")).sessions[0];
			assert.strictEqual(saved.toolCatalogHash, turn.cursorCacheDiagnostics?.toolCatalogHash);
			assert.ok(saved.completedAt > 0);
		} finally { await f.dispose(); }
	});
	test("preserves a failed native resume instead of silently paying for a full replay", async () => {
		const f = await fixture();
		try {
			await f.respond([user("FIRST_KEEP")]); f.reload(); f.failResume();
			const messages = [user("FIRST_KEEP"), assistant("MIDDLE_KEEP"), user("NEXT_KEEP")];
			await assert.rejects(f.respond(messages), /checkpoint was preserved; no inference was started/);
			assert.strictEqual(f.created.length, 1); assert.strictEqual(f.sent.length, 1);
			f.allowResume(); f.reload(); await f.respond(messages);
			assert.strictEqual(f.created.length, 1); assert.strictEqual(f.sent.length, 2);
			assert.ok(!f.sent[1].input.text.includes("FIRST_KEEP")); assert.ok(f.sent[1].input.text.includes("NEXT_KEEP"));
		} finally { await f.dispose(); }
	});
	test("restores native state from disk when VS Code loses the Memento binding", async () => {
		const state = memory(), f = await fixture(state.state);
		try {
			await f.respond([user("FIRST_DISK")]);
			const saved = await fs.readFile(path.join(f.root, "completed-sessions.json"), "utf8");
			assert.ok(!saved.includes(source.apiKey!)); assert.ok(!saved.includes("FIRST_DISK"));
			assert.strictEqual(JSON.parse(saved).sessions[0].nativeCheckpoint.rootBlobId, "native-1");
			state.values.clear(); f.reload();
			await f.respond([user("FIRST_DISK"), assistant("DONE"), user("SECOND_DISK")]);
			assert.deepStrictEqual(f.restored, ["agent-1"]); assert.strictEqual(f.created.length, 1);
			assert.ok(!f.sent[1].input.text.includes("FIRST_DISK")); assert.ok(f.sent[1].input.text.includes("SECOND_DISK"));
		} finally { await f.dispose(); }
	});
	test("reload during a later tool run retains the last completed native checkpoint", async () => {
		const f = await fixture();
		try {
			await f.respond([user("FIRST_COMPLETE")]);
			f.tool(); await f.respond([user("FIRST_COMPLETE"), assistant("DONE"), user("INTERRUPTED_SECOND")]);
			const saved = JSON.parse(await fs.readFile(path.join(f.root, "completed-sessions.json"), "utf8")).sessions[0];
			assert.strictEqual(saved.inflight, true); assert.strictEqual(saved.nativeCheckpoint.rootBlobId, "native-1");
			f.reload(); f.stopTool();
			await f.respond([user("FIRST_COMPLETE"), assistant("DONE"), user("INTERRUPTED_SECOND"), assistant("Interrupted"), user("CONTINUE_THIRD")]);
			assert.deepStrictEqual(f.restored, ["agent-1"]); assert.strictEqual(f.created.length, 1);
			assert.ok(!f.sent[2].input.text.includes("FIRST_COMPLETE")); assert.match(f.sent[2].input.text, /INTERRUPTED_SECOND[\s\S]*CONTINUE_THIRD/);
		} finally { await f.dispose(); }
	});
	test("a large completed chat survives repeated reloads using only new deltas", async () => {
		const f = await fixture(undefined, 2_000_000), first = "OLD_NATIVE_HISTORY" + "x".repeat(1_400_000);
		try {
			const messages = [user(first)]; await f.respond(messages, [], options, source, none, 3_000_000);
			for (const next of ["AFTER_RELOAD_ONE", "AFTER_RELOAD_TWO"]) {
				f.reload(); messages.push(assistant("DONE"), user(next));
				await f.respond(messages, [], options, source, none, 3_000_000);
				assert.ok(f.sent.at(-1)!.input.text.includes(next)); assert.ok(f.sent.at(-1)!.input.text.length < 10_000);
			}
			assert.strictEqual(f.created.length, 1); assert.deepStrictEqual(f.restored, ["agent-1", "agent-1"]);
		} finally { await f.dispose(); }
	});
	test("isolates keys, profiles and conversations", async () => {
		for (const change of ["key", "profile", "conversation"]) {
			const f = await fixture();
			try {
				await f.respond([user("ORIGINAL")]);
				await f.respond([user("ORIGINAL"), assistant("OLD"), user("NEXT")], [],
					change === "conversation" ? { ...options, modelOptions: { _copilotConversationId: "other-chat" } } : options,
					change === "key" ? { ...source, apiKey: "new-key" } : change === "profile" ? { ...source, key: "api-other" } : source);
				assert.strictEqual(f.created.length, 2); assert.ok(f.sent[1].input.text.includes("ORIGINAL"));
			} finally { await f.dispose(); }
		}
	});
	test("resumes the same tool run with wrapped results and never replays old own calls", async () => {
		const f = await fixture(), parts: vscode.LanguageModelResponsePart[] = [];
		try {
			f.tool(); await f.respond([user("FIRST")], parts);
			const call = parts.find(p => p instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart;
			const result = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart("FILE_CONTENTS")]), new vscode.LanguageModelTextPart("<context>tool metadata</context>")]);
			await f.respond([user("FIRST"), result]); assert.strictEqual(f.sent.length, 1);
			await f.respond([user("FIRST"), result, assistant("Cursor continued."), user("SECOND")], []);
			assert.strictEqual(f.created.length, 1); assert.ok(!f.sent[1].input.text.includes("FILE_CONTENTS"));
			f.sdk.cancelConversation("cursor-chat");
		} finally { await f.dispose(); }
	});
	test("cancels only the requested conversation and rejects its stale results", async () => {
		const f = await fixture(), parts: vscode.LanguageModelResponsePart[] = [];
		try {
			f.tool(); await f.respond([user("WAIT")], parts);
			const call = parts.find(p => p instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart;
			f.sdk.cancelConversation("other-chat"); assert.strictEqual(f.closes(), 0);
			f.sdk.cancelConversation("cursor-chat"); assert.strictEqual(f.closes(), 1);
			const result = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart("stale")])]);
			await assert.rejects(f.respond([result]), /no longer active/);
		} finally { await f.dispose(); }
	});
	test("uses one SDK run for explicitly permitted large history that fits the selected context", async () => {
		const f = await fixture(undefined, 2_000_000), parts: vscode.LanguageModelResponsePart[] = [], text = "BEGIN" + "💡x".repeat(400_000) + "MIDDLE_END";
		try {
			await f.respond([user(text), assistant("FOREIGN_DETAIL"), user("continue")], parts, options, source, none, 3_000_000);
			assert.strictEqual(f.sent.length, 1); assert.ok(f.sent[0].input.text.includes(text)); assert.ok(f.sent[0].input.text.includes("FOREIGN_DETAIL"));
			assert.ok(!f.sent[0].input.text.includes("History import"));
			assert.ok(!parts.some(part => part instanceof vscode.LanguageModelTextPart && part.value === "ACK"));
			assert.strictEqual(f.usage[0].modelTurns, 1);
		} finally { await f.dispose(); }
	});
	test("blocks a costly cold replay before inference even with the legacy import setting enabled", async () => {
		const f = await fixture();
		const limited = new CursorSdkTransport({ ...f.dependencies, maxImportParts: 128 });
		try {
			await assert.rejects(limited.respond(source, { id: "test" }, { text: "x".repeat(1_100_000) }, [user("large")], options, { report: () => undefined }, none, undefined), /No inference requests were sent/);
			assert.strictEqual(f.sent.length, 0);
			const scopes = await fs.readdir(path.join(f.root, "history")); const files = await fs.readdir(path.join(f.root, "history", scopes[0]));
			assert.ok(files.some(file => file.endsWith(".txt")));
		} finally { limited.dispose(); await f.dispose(); }
	});
	test("explains a missing host conversation ID without creating an agent or replaying large history", async () => {
		const f = await fixture();
		try {
			await assert.rejects(f.respond([user("x".repeat(100_000))], [], { ...options, modelOptions: {} }), /host did not supply a conversation ID/);
			assert.strictEqual(f.sent.length, 0); assert.strictEqual(f.created.length, 0);
		} finally { await f.dispose(); }
	});
	test("refuses inference if durable checkpoint invalidation fails", async () => {
		const state = memory(), f = await fixture(state.state);
		try {
			await f.respond([user("FIRST")]); state.fail();
			await assert.rejects(f.respond([user("FIRST"), assistant("Cursor continued."), user("SECOND")]), /storage unavailable/);
			assert.strictEqual(f.sent.length, 1);
		} finally { await f.dispose(); }
	});
	test("redacts SDK startup errors without retaining a credential-bearing cause or stack", async () => {
		const f = await fixture();
		const broken = new CursorSdkTransport({ ...f.dependencies, createAgent: async () => { throw new Error(`backend rejected ${source.apiKey}; Authorization: Bearer secret-value`); } });
		try {
			await assert.rejects(broken.respond(source, { id: "test" }, { text: "hello" }, [user("hello")], options, { report: () => undefined }, none), error => {
				assert.ok(error instanceof Error); assert.ok(!error.stack?.includes(source.apiKey!)); assert.ok(!error.stack?.includes("secret-value"));
				assert.strictEqual(error.cause, undefined); assert.match(error.message, /redacted/); return true;
			});
		} finally { broken.dispose(); await f.dispose(); }
	});
	test("does not fabricate cache counters when the SDK omits usage", async () => {
		const f = await fixture();
		try {
			f.missingUsage(); await f.respond([user("FIRST")]);
			assert.strictEqual(f.usage.length, 0); assert.strictEqual(f.live.at(-1)?.turn.cacheMissReason, "usage_not_reported");
			assert.strictEqual(f.live.at(-1)?.turn.cachedPromptTokens, undefined);
		} finally { await f.dispose(); }
	});
});

suite("Cursor lossless handoff contracts", () => {
	test("uses inclusive native input and ignores the SDK double-counted total", () => {
		assert.deepStrictEqual(parseCursorUsage(nativeUsage), { inputTokens: 1000, outputTokens: 20, cachedInputTokens: 900, cacheWriteInputTokens: 97 });
		const measured = parseCursorUsage({ inputTokens: 224876, outputTokens: 213, cacheReadTokens: 4121, cacheWriteTokens: 220751, totalTokens: 449961 });
		assert.strictEqual(measured?.inputTokens, 224876); assert.strictEqual(measured!.inputTokens - measured!.cachedInputTokens - measured!.cacheWriteInputTokens, 4);
		assert.strictEqual(parseCursorUsage({ ...nativeUsage, totalTokens: 1020 })?.inputTokens, 1000);
		for (const usage of [undefined, {}, { ...nativeUsage, inputTokens: -1 }, { ...nativeUsage, inputTokens: 3 }, { ...nativeUsage, cacheReadTokens: NaN }, { ...nativeUsage, totalTokens: 999 }]) { assert.strictEqual(parseCursorUsage(usage), undefined); }
	});
	test("preserves nested image/text results and refuses Cloud overflow without dropping old messages", () => {
		const result = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelToolResultPart("foreign-call", [new vscode.LanguageModelTextPart("EXACT_RESULT"), vscode.LanguageModelDataPart.image(new Uint8Array([1, 2, 3]), "image/png")])]);
		const value = cursorTranscript([user("FIRST"), result, user("NEXT")]); assert.ok(value.text.includes("EXACT_RESULT")); assert.strictEqual(value.images?.[0].data, "AQID");
		assert.throws(() => cursorPrompt([user("x".repeat(400)), user("short")], 100), /no earlier messages/);
	});
	test("keeps large tool output byte-for-byte in an accessible archive", async () => {
		const f = await fixture();
		try {
			const text = "A".repeat(80_000) + "PIN_MIDDLE" + "Z".repeat(80_000);
			const result = await new CursorHistoryArchive(f.root).toolResult(new vscode.LanguageModelToolResultPart("call", [new vscode.LanguageModelTextPart(text)]), "scope");
			assert.ok(result && typeof result === "object" && "content" in result);
			const scopes = (await fs.readdir(f.root)).filter(name => name !== "history");
			const files = await fs.readdir(path.join(f.root, scopes[0])); const file = files.find(name => name.endsWith(".txt"))!;
			assert.strictEqual(await fs.readFile(path.join(f.root, scopes[0], file), "utf8"), text);
		} finally { await f.dispose(); }
	});
});