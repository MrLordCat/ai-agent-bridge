import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentOptions, SendOptions, SDKUserMessage, TokenUsage } from "@cursor/sdk";
import { CursorSdkTransport, type CursorLocalAgent } from "../cursor/sdk-transport";
import { cursorPrompt, cursorTranscript } from "../cursor/message-adapter";
import { CursorHistoryArchive } from "../cursor/history-transfer";
import { parseCursorUsage, type CursorLiveTurn, type CursorRecordedUsage } from "../cursor/turn-metrics";
import type { ChatModelSource } from "../model-sources/source-routing";
import { CompositeChatModelProvider } from "../composite-provider";
import { ConversationHistory } from "../providers/conversation-history";

const none: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined) };
const source: ChatModelSource = { key: "api-cursor-continuity", label: "Cursor", serverUrl: "https://api.cursor.com/v1", apiKey: "fixture-key", protocol: "cursor" };
const options: vscode.ProvideLanguageModelChatResponseOptions = { tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }], toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _copilotConversationId: "cursor-chat" } };
const user = (text: string) => vscode.LanguageModelChatMessage.User(text);
const assistant = (text: string) => vscode.LanguageModelChatMessage.Assistant(text);
const nativeUsage: TokenUsage = { inputTokens: 3, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 97, totalTokens: 1020 };
function memory() {
	const values = new Map<string, unknown>(); let fail = false;
	const state: vscode.Memento = { keys: () => [...values.keys()], get: <T>(key: string, fallback?: T) => (values.get(key) as T | undefined) ?? fallback,
		update: async (key, value) => { if (fail) { throw new Error("fixture storage unavailable"); } values.set(key, structuredClone(value)); } } as vscode.Memento;
	return { state, values, fail: () => { fail = true; } };
}
async function fixture(state = memory().state) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-continuity-"));
	const sent: Array<{ input: SDKUserMessage; options: SendOptions; agent: string }> = [], created: AgentOptions[] = [], restored: string[] = [];
	const live: CursorLiveTurn[] = [], usage: CursorRecordedUsage[] = [];
	let closes = 0, resumesFail = false, requestTool = false, omitUsage = false;
	const makeAgent = (id: string): CursorLocalAgent => ({ agentId: id, close: () => { closes++; }, send: async (input, send) => {
		sent.push({ input, options: send, agent: id });
		const completion = Promise.resolve().then(async () => {
			if (requestTool && !input.text.startsWith("History import")) { await Object.values(send.local!.customTools!)[0].execute({ path: "test.txt" }, {}); }
			const text = input.text.startsWith("History import") ? "ACK" : "Cursor continued.";
			await send.onDelta?.({ update: { type: "text-delta", text } });
			return { status: "finished", result: text, usage: omitUsage ? undefined : nativeUsage };
		});
		return { wait: () => completion, cancel: async () => undefined };
	} });
	const dependencies = { state, storageRoot: root, cwd: () => root, available: () => true,
		createAgent: async (config: AgentOptions) => { created.push(config); return makeAgent(`agent-${created.length}`); },
		resumeAgent: async (id: string) => { restored.push(id); if (resumesFail) { throw new Error("fixture checkpoint missing"); } return makeAgent(id); } };
	const make = () => { const sdk = new CursorSdkTransport(dependencies); sdk.onDidUpdateLiveTurn(update => live.push(update)); sdk.onDidRecordUsage(value => usage.push(value)); return sdk; };
	let sdk = make();
	return { root, sent, created, restored, live, usage, dependencies, get sdk() { return sdk; },
		reload: () => { sdk.dispose(); sdk = make(); }, failResume: () => { resumesFail = true; }, tool: () => { requestTool = true; }, missingUsage: () => { omitUsage = true; }, closes: () => closes,
		respond: (messages: vscode.LanguageModelChatRequestMessage[], parts: vscode.LanguageModelResponsePart[] = [], config = options, profile = source, token = none, maximum = 1_000_000) =>
			sdk.respond(profile, { id: "test-model" }, () => cursorTranscript(messages), messages, config, { report: part => parts.push(part) }, token, maximum),
		dispose: async () => { sdk.dispose(); await fs.rm(root, { recursive: true, force: true }); } };
}

suite("Cursor conversation continuity", () => {
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
		} finally { await f.dispose(); }
	});
	test("falls back to the entire visible history if a native checkpoint cannot load", async () => {
		const f = await fixture();
		try {
			await f.respond([user("FIRST_KEEP")]); f.reload(); f.failResume();
			await f.respond([user("FIRST_KEEP"), assistant("MIDDLE_KEEP"), user("NEXT_KEEP")]);
			assert.strictEqual(f.created.length, 2); assert.match(f.sent[1].input.text, /FIRST_KEEP[\s\S]*MIDDLE_KEEP[\s\S]*NEXT_KEEP/);
			assert.strictEqual(f.live.at(-1)?.turn.sessionMode, "resume-fallback");
		} finally { await f.dispose(); }
	});
	test("isolates keys, profiles, context settings, conversations and edited user branches", async () => {
		for (const change of ["key", "profile", "context", "conversation", "edit"]) {
			const f = await fixture();
			try {
				await f.respond([user("ORIGINAL")]);
				await f.respond([user(change === "edit" ? "EDITED" : "ORIGINAL"), assistant("OLD"), user("NEXT")], [],
					change === "conversation" ? { ...options, modelOptions: { _copilotConversationId: "other-chat" } } : options,
					change === "key" ? { ...source, apiKey: "new-key" } : change === "profile" ? { ...source, key: "api-other" } : change === "context" ? { ...source, workingContextLength: 100_000 } : source);
				assert.strictEqual(f.created.length, 2); assert.ok(f.sent[1].input.text.includes(change === "edit" ? "EDITED" : "ORIGINAL"));
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
	test("imports every history character with tools disabled and hides intermediate ACKs", async () => {
		const f = await fixture(), parts: vscode.LanguageModelResponsePart[] = [], text = "BEGIN" + "💡x".repeat(30_000) + "MIDDLE_END";
		try {
			await f.respond([user(text), assistant("FOREIGN_DETAIL"), user("continue")], parts, options, source, none, 100_000);
			const imports = f.sent.filter(call => call.input.text.startsWith("History import")); assert.ok(imports.length > 1);
			for (const call of imports) { assert.deepStrictEqual(call.options.local?.customTools, {}); }
			const restored = imports.map(call => call.input.text.slice(call.input.text.indexOf("\n\n") + 2)).join("");
			assert.strictEqual(restored, cursorTranscript([user(text), assistant("FOREIGN_DETAIL"), user("continue")]).text);
			assert.ok(!parts.some(part => part instanceof vscode.LanguageModelTextPart && part.value === "ACK"));
			assert.strictEqual(f.usage[0].modelTurns, imports.length + 1);
		} finally { await f.dispose(); }
	});
	test("stops oversized imports before inference and keeps the full local archive", async () => {
		const f = await fixture();
		const limited = new CursorSdkTransport({ ...f.dependencies, maxImportParts: 1 });
		try {
			await assert.rejects(limited.respond(source, { id: "test" }, { text: "x".repeat(1_100_000) }, [user("large")], options, { report: () => undefined }, none, undefined), /limit 1/);
			assert.strictEqual(f.sent.length, 0);
			const scopes = await fs.readdir(path.join(f.root, "history")); const files = await fs.readdir(path.join(f.root, "history", scopes[0]));
			assert.ok(files.some(file => file.endsWith(".txt")));
		} finally { limited.dispose(); await f.dispose(); }
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
	test("counts fresh plus cache once and rejects malformed native counters", () => {
		assert.deepStrictEqual(parseCursorUsage(nativeUsage), { inputTokens: 1000, outputTokens: 20, cachedInputTokens: 900, cacheWriteInputTokens: 97 });
		for (const usage of [undefined, {}, { ...nativeUsage, inputTokens: -1 }, { ...nativeUsage, cacheReadTokens: NaN }, { ...nativeUsage, totalTokens: 999 }]) { assert.strictEqual(parseCursorUsage(usage), undefined); }
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