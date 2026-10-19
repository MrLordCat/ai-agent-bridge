import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { CocoAcpClient, type CocoPromptContent } from "../coco/acp-client";
import { CocoChatModelProvider } from "../coco/coco-provider";
import { mapCocoModel } from "../coco/model-adapter";
import { CocoHistoryArchive, splitCocoHistory } from "../coco/history-transfer";
import { parseCocoTokenUsage, sumCocoUsage } from "../coco/usage-adapter";
import { ConversationHistory, mergeConversationHistory } from "../providers/conversation-history";
import { CompositeChatModelProvider } from "../composite-provider";
import type { CocoRecordedUsage, CocoLiveTurn } from "../coco/turn-metrics";
import { SessionQualityTracker } from "../diagnostics/session-report";
import { LlamaQuickActionsProvider } from "../ui/quick-access";
import { usageProviderForSource } from "../token-usage-history";

const user = vscode.LanguageModelChatMessage.User;
const assistant = vscode.LanguageModelChatMessage.Assistant;
const none: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined) };
const model = mapCocoModel({ id: "claude-opus-5-5", name: "Opus" }, 1_000_000);
const options = (id = "chat-one") => ({ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _copilotConversationId: id } });
const text = (parts: readonly vscode.LanguageModelResponsePart[]) => parts.filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart).map(p => p.value).join("");
const body = (prompt: string | readonly CocoPromptContent[]) => typeof prompt === "string" ? prompt : prompt.map(p => p.type === "text" ? p.text : "[image]").join("");

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "coco-continuity-"));
	const data = new Map<string, unknown>();
	const state = { get: (key: string, fallback?: unknown) => data.get(key) ?? fallback, update: async (key: string, value: unknown) => { data.set(key, value); }, keys: () => [...data.keys()] } as vscode.Memento;
	let created = 0, disposed = 0, loads = 0, sessions = 0, failLoad = false, importedToolBlocked = false;
	const prompts: string[] = [], updates: CocoLiveTurn[] = [], usage: CocoRecordedUsage[] = [];
	const providers: CocoChatModelProvider[] = [];
	const make = () => {
		const provider = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock", resolveConnection: () => "test-connection", state, storageRoot: root,
			createClient: (_exe, _cwd, _connection, _model, handlers) => {
				created++;
				return {
					initialize: async () => ({ agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } }),
					newSession: async () => { sessions++; return { sessionId: `session-${sessions}` }; },
					loadSession: async () => { loads++; if (failLoad) { throw new Error("Cannot load session"); } handlers?.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD REPLAY MUST STAY HIDDEN" } }); return {}; },
					prompt: async (_id: string, prompt: string | CocoPromptContent[]) => {
						const value = body(prompt); prompts.push(value);
						if (value.includes("History import ")) {
							try { await handlers?.onClientTool?.("forbidden", {}); } catch { importedToolBlocked = true; }
						}
						handlers?.onUpdate?.({ sessionUpdate: "usage_update", used: 10_000 + prompts.length, size: 1_000_000 });
						handlers?.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value.includes("History import ") ? "ACK" : "Visible answer" } });
						return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 90, cachedWriteTokens: 5 } };
					}, cancel: () => undefined, dispose: () => { disposed++; },
				} as unknown as CocoAcpClient;
			} });
		provider.onDidUpdateLiveTurn(update => updates.push(update)); provider.onDidRecordUsage(item => usage.push(item)); providers.push(provider); return provider;
	};
	const send = async (provider: CocoChatModelProvider, messages: vscode.LanguageModelChatRequestMessage[], id = "chat-one", tools?: vscode.LanguageModelChatTool[]) => {
		const parts: vscode.LanguageModelResponsePart[] = [];
		await provider.provideLanguageModelChatResponse(model, messages, { ...options(id), tools }, { report: p => parts.push(p) }, none); return parts;
	};
	return { root, state, data, prompts, updates, usage, make, send, stats: () => ({ created, disposed, loads, sessions, importedToolBlocked }), failLoad: () => { failLoad = true; }, allowLoad: () => { failLoad = false; }, dispose: async () => { providers.forEach(p => p.dispose()); await fs.rm(root, { recursive: true, force: true }); } };
}

suite("Coco conversation continuity", () => {
	test("a 3M-character handoff keeps the current request and archives historical images and exact text", async () => {
		const f = await fixture();
		try {
			const history = "BEGIN_REQUIREMENT\n" + "source code и результаты инструментов\n".repeat(82_000) + "\nEND_FINDING";
			assert.ok(history.length > 3_045_543);
			const images = Array.from({ length: 14 }, () => vscode.LanguageModelDataPart.image(new Uint8Array([1, 2, 3]), "image/png"));
			await f.send(f.make(), [user("Initial rule"), user([...images,new vscode.LanguageModelTextPart("Earlier attachments")]), assistant(history), user("Continue the latest task")]);
			assert.strictEqual(f.prompts.length, 1); assert.ok(f.prompts[0].length < 1_000_000);
			assert.match(f.prompts[0], /Initial rule/); assert.match(f.prompts[0], /Continue the latest task/);
			assert.strictEqual(f.prompts[0].split("[image]").length - 1, 0);
			assert.strictEqual(f.updates.at(-1)?.turn.compacted,true);
			const scope = (await fs.readdir(f.root)).find(name => name !== "sessions.json")!;
			const entries = await fs.readdir(path.join(f.root,scope));
			const archived = await fs.readFile(path.join(f.root,scope,entries.find(name => name.endsWith(".txt"))!),"utf8");
			assert.ok(archived.includes(history)); assert.strictEqual(archived.split("[Image attachment:").length - 1,14);
			assert.ok(!f.prompts[0].includes("History import"));
		} finally { await f.dispose(); }
	});
	test("switching providers cancels only the matching pending chat and rejects its stale tool results", async () => {
		let first = true, cancelled = 0, closed = 0;
		const tool: vscode.LanguageModelChatTool = { name: "test_tool", description: "Test", inputSchema: { type: "object" } };
		const opts = { ...options("one"), tools: [tool] };
		const p = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock",
			createClient: (_exe, _cwd, _connection, _model, handlers) => {
				let alias = "";
				return { initialize: async () => undefined,
					newSession: async (_cwd: string, tools: Array<Record<string, unknown>>) => { alias = String(tools[0].name); return { sessionId: "pending" }; },
					prompt: async () => { if (first) { first = false; await handlers?.onClientTool?.(alias, {}); } handlers?.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "New request completed" } }); return { stopReason: "end_turn" }; },
					cancel: () => { cancelled++; }, dispose: () => { closed++; },
				} as unknown as CocoAcpClient;
			} });
		try {
			const old: vscode.LanguageModelResponsePart[] = [];
			await p.provideLanguageModelChatResponse(model, [user("Old request")], opts, { report: part => old.push(part) }, none);
			const call = old.find((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart)!;
			assert.ok(call);
			await p.onForeignRequest("other-chat"); assert.strictEqual(cancelled, 0);
			await p.onForeignRequest("one"); assert.strictEqual(cancelled, 1); assert.strictEqual(closed, 1);
			await assert.rejects(p.provideLanguageModelChatResponse(model, [user([new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart("stale")])])], opts, { report: () => undefined }, none), /no longer active/);
			const fresh: vscode.LanguageModelResponsePart[] = [];
			await p.provideLanguageModelChatResponse(model, [user("New user task")], opts, { report: part => fresh.push(part) }, none);
			assert.strictEqual(text(fresh), "New request completed");
		} finally { p.dispose(); }
	});
	test("refreshes changed client tools through loadSession without losing native history", async () => {
		const f = await fixture();
		try {
			const p = f.make();
			await f.send(p, [user("ORIGINAL")], "one", [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }]);
			const parts = await f.send(p, [user("ORIGINAL"), assistant("Visible answer"), user("Next")], "one", [{ name: "read_file", description: "Read with updated schema", inputSchema: { type: "object", properties: { path: { type: "string" } } } }]);
			assert.strictEqual(f.stats().loads, 1); assert.strictEqual(f.stats().sessions, 1);
			assert.ok(!f.prompts[1].includes("ORIGINAL")); assert.strictEqual(text(parts), "Visible answer");
		} finally { await f.dispose(); }
	});
	test("reuses a warm session and appends foreign-provider turns exactly once", async () => {
		const f = await fixture();
		try {
			const p = f.make(); await f.send(p, [user("Keep the INITIAL constraint")]);
			const oldResult = user([new vscode.LanguageModelTextPart("OLD_TOOL_LABEL"), new vscode.LanguageModelToolResultPart("coco-completed", [new vscode.LanguageModelTextPart("OLD_TOOL_OUTPUT")])]);
			const foreignResult = user([new vscode.LanguageModelTextPart("FOREIGN_TOOL_LABEL"), new vscode.LanguageModelToolResultPart("codex-foreign", [new vscode.LanguageModelTextPart("FOREIGN_TOOL_OUTPUT")])]);
			await f.send(p, [user("Keep the INITIAL constraint"), assistant("Visible answer"), oldResult, user("Codex investigated FOREIGN_FILE"), foreignResult, assistant("FOREIGN_FINDING: must preserve"), user("Continue in Coco")]);
			assert.strictEqual(f.stats().created, 1); assert.strictEqual(f.stats().sessions, 1); assert.strictEqual(f.stats().disposed, 0);
			assert.ok(!f.prompts[1].includes("INITIAL")); assert.match(f.prompts[1], /FOREIGN_FILE/); assert.match(f.prompts[1], /FOREIGN_FINDING/);
			assert.ok(!f.prompts[1].includes("OLD_TOOL_OUTPUT")); assert.match(f.prompts[1], /FOREIGN_TOOL_OUTPUT/);
			assert.strictEqual(f.usage.length, 2); assert.strictEqual(f.usage[1].inputTokens, 105); assert.strictEqual(f.usage[1].cachedInputTokens, 90);
			assert.strictEqual(f.updates.at(-1)?.turn.sessionMode, "warm"); assert.strictEqual(f.updates.at(-1)?.turn.providerKind, "coco");
		} finally { await f.dispose(); }
	});
	test("restores after reload, hides replay notifications and persists only ids/fingerprints", async () => {
		const f = await fixture();
		try {
			const p = f.make(); await f.send(p, [user("PRIVATE original constraint")]); p.dispose();
			assert.ok(!JSON.stringify([...f.data]).includes("PRIVATE"));
			const restored = f.make();
			const parts = await f.send(restored, [user("PRIVATE original constraint"), assistant("Visible answer"), user("Follow-up")]);
			assert.strictEqual(f.stats().loads, 1); assert.strictEqual(f.stats().sessions, 1);
			assert.strictEqual(text(parts), "Visible answer"); assert.ok(!f.prompts[1].includes("PRIVATE"));
			assert.strictEqual(f.updates.at(-1)?.turn.sessionMode, "restored");
			assert.strictEqual(f.updates.at(-1)?.turn.inputMode, "user-turn");
		} finally { await f.dispose(); }
	});
	test("a failed native restore preserves its binding without cold replay", async () => {
		const f = await fixture();
		try {
			const p = f.make(); await f.send(p, [user("Original requirement")]); p.dispose(); f.failLoad();
			const restored = f.make(), messages = [user("Original requirement"), assistant("Answer"), user("Next")];
			await assert.rejects(f.send(restored, messages), /binding was preserved/);
			assert.strictEqual(f.prompts.length, 1); assert.strictEqual(f.stats().sessions, 1);
			f.allowLoad(); await f.send(restored, messages);
			assert.ok(!f.prompts[1].includes("Original requirement")); assert.match(f.prompts[1], /Next/);
		} finally { await f.dispose(); }
	});
	test("recovers a legacy successful checkpoint whose native answer was an internal error", async () => {
		const f = await fixture();
		try {
			const first = f.make(); await f.send(first,[user("ORIGINAL_TASK")]); first.dispose();
			await f.send(f.make(),[user("ORIGINAL_TASK"),assistant("Error: internal error (request_id: 8f87cfae-6b7f-496f-8881-7fafe57caf39)"),user("NEW_EXPLICIT_REQUEST")]);
			assert.strictEqual(f.stats().sessions,2); assert.strictEqual(f.stats().loads,0);
			assert.strictEqual(f.updates.at(-1)?.turn.sessionMode,"new"); assert.match(f.prompts[1],/NEW_EXPLICIT_REQUEST/);
		} finally { await f.dispose(); }
	});
	test("isolates chat ids and rebuilds edited branches without native future context", async () => {
		const f = await fixture();
		try {
			const p = f.make(); await f.send(p, [user("First branch")], "one");
			await f.send(p, [user("Separate chat")], "two");
			await f.send(p, [user("Edited first branch")], "one");
			assert.strictEqual(f.stats().sessions, 3); assert.ok(!f.prompts[2].includes("Separate chat"));
			assert.strictEqual(f.updates.at(-1)?.turn.sessionMode, "new");
		} finally { await f.dispose(); }
	});
	test("restores the disk binding when Memento is missing", async () => {
		const f = await fixture();
		try {
			const first = f.make(); await f.send(first, [user("FIRST_DISK")]); first.dispose(); f.data.clear();
			await f.send(f.make(), [user("FIRST_DISK"), assistant("Done"), user("NEXT_DISK")]);
			assert.strictEqual(f.stats().sessions, 1); assert.strictEqual(f.stats().loads, 1);
			assert.ok(!f.prompts[1].includes("FIRST_DISK")); assert.match(f.prompts[1], /NEXT_DISK/);
		} finally { await f.dispose(); }
	});
	test("a warm preflight failure preserves the session for the next valid request", async () => {
		const f = await fixture();
		try {
			const provider = f.make(); await f.send(provider, [user("FIRST")]);
			const unsupported = new vscode.LanguageModelDataPart(new Uint8Array([1, 2]), "application/octet-stream");
			await assert.rejects(f.send(provider, [user("FIRST"), assistant("Done"), user([unsupported])]), /cannot import application\/octet-stream/);
			await f.send(provider, [user("FIRST"), assistant("Done"), user("VALID_NEXT")]);
			assert.strictEqual(f.stats().sessions, 1); assert.strictEqual(f.prompts.length, 2); assert.ok(!f.prompts[1].includes("FIRST"));
		} finally { await f.dispose(); }
	});
	test("a broken sidecar does not block a confirmed native continuation", async () => {
		const f = await fixture();
		try {
			const native = f.make(); await f.send(native, [user("FIRST")]);
			const blocked = path.join(f.root, "blocked-sidecar"); await fs.writeFile(blocked, "not a directory");
			const composite = new CompositeChatModelProvider({ history: new ConversationHistory(blocked), providers: [{ id: "coco", provider: native, ownsModel: () => true }] });
			await composite.provideLanguageModelChatResponse(model, [user("FIRST"), assistant("Done"), user("NEXT")], options(), { report: () => undefined }, none);
			assert.strictEqual(f.stats().sessions, 1); assert.strictEqual(f.prompts.length, 2); composite.dispose();
		} finally { await f.dispose(); }
	});
	test("updates volatile editor context without replaying stable history", async () => {
		const f = await fixture();
		try {
			const p = f.make(); await f.send(p, [user("RULE <context>terminal OLD</context>")]);
			await f.send(p, [user("RULE <context>terminal NEW</context>"), assistant("Visible answer"), user("Next")]);
			assert.strictEqual(f.stats().sessions, 1); assert.match(f.prompts[1], /terminal NEW/); assert.ok(!f.prompts[1].includes("RULE"));
		} finally { await f.dispose(); }
	});
	test("hands off a large fitting history in exactly one native prompt without ACK requests", async () => {
		const f = await fixture();
		try {
			const p = f.make(); const history = "a".repeat(550_000) + "MIDDLE_REQUIREMENT" + "b".repeat(550_000);
			const parts = await f.send(p, [user("Initial rule"), assistant(history), user("Latest task")]);
			assert.strictEqual(f.prompts.length, 1); assert.ok(f.prompts[0].length < 1_000_000); assert.match(f.prompts[0],/Historical excerpt/);
			assert.match(f.prompts[0], /Latest task/); assert.ok(!f.prompts[0].includes("History import"));
			assert.match(text(parts),/Coco: prepared/); assert.ok(text(parts).endsWith("Visible answer"));
			assert.strictEqual(f.usage.length, 1); assert.strictEqual(f.usage[0].inputTokens, 105);
		} finally { await f.dispose(); }
	});
});

suite("Coco lossless handoff contracts", () => {
	test("quoted historical image paths cannot trigger CLI attachment expansion", async () => {
		const f = await fixture();
		try {
			const transfer = await new CocoHistoryArchive(f.root).prepare([user("Earlier @assets/logo.png"),assistant("See @assets/logo.png"),user("Current @attached.png")],"quoted-paths");
			const prompt = body(transfer.prompt);
			assert.ok(!prompt.includes("@assets/logo.png")); assert.ok(prompt.includes("\\u0040assets/logo.png")); assert.match(prompt,/@attached.png/);
		} finally { await f.dispose(); }
	});
	test("compaction preserves every short user requirement and current image while archiving tool logs", async () => {
		const f = await fixture();
		try {
			const messages = [user("FIRST: preserve existing APIs"),assistant("x".repeat(100_000)),user("MIDDLE: Windows support is required"),
				user([new vscode.LanguageModelToolResultPart("old",[new vscode.LanguageModelTextPart("log ".repeat(50_000))])]),
				user([new vscode.LanguageModelTextPart("LATEST: fix the provider"),vscode.LanguageModelDataPart.image(new Uint8Array([1,2,3]),"image/png")])];
			const transfer = await new CocoHistoryArchive(f.root).prepare(messages,"bounded",64_000);
			const prompt = body(transfer.prompt); assert.ok(prompt.length <= 64_000); assert.deepStrictEqual(transfer.imports,[]);
			for (const label of ["FIRST:","MIDDLE:","LATEST:"]) { assert.ok(prompt.includes(label)); }
			assert.ok(transfer.prompt.some(part => part.type === "image" && part.data === "AQID")); assert.ok(transfer.archivePath);
			assert.match(await fs.readFile(transfer.archivePath!,"utf8"),/log log log/);
		} finally { await f.dispose(); }
	});
	test("the transport guard counts encoded UTF-8, escaping and image bytes without claiming token overflow", async () => {
		const f = await fixture();
		try {
			const content = 'Ж\n"'.repeat(350), limit = 2_048;
			assert.ok(content.length < limit);
			const archive = new CocoHistoryArchive(f.root, limit);
			await assert.rejects(archive.prepare([user(content)], "text-overflow"), /transport safety limit.*not a model token limit/);
			const directory = (await fs.readdir(f.root))[0], file = (await fs.readdir(path.join(f.root, directory)))[0];
			assert.ok((await fs.readFile(path.join(f.root, directory, file), "utf8")).includes(content));
			const image = vscode.LanguageModelDataPart.image(new Uint8Array(2_000).fill(7), "image/png");
			await assert.rejects(archive.prepare([user([image])], "image-overflow"), /transport safety limit/);
			const fitting = await archive.prepare([user("Fits"), user([vscode.LanguageModelDataPart.image(new Uint8Array([1, 2, 3]), "image/png")])], "fits");
			assert.deepStrictEqual(fitting.imports, []);
			assert.ok(fitting.prompt.some(part => part.type === "image" && part.data === "AQID"));
		} finally { await f.dispose(); }
	});
	test("a broken journal leaves Codex usable and explicitly prevents an unsafe Coco handoff", async () => {
		const f = await fixture();
		try {
			const blocked = path.join(f.root, "blocked"); await fs.writeFile(blocked, "not a directory");
			let calls = 0;
			const provider: vscode.LanguageModelChatProvider = { provideLanguageModelChatInformation: async () => [], provideTokenCount: async () => 1, provideLanguageModelChatResponse: async () => { calls++; } };
			const composite = new CompositeChatModelProvider({ history: new ConversationHistory(blocked), providers: [
				{ id: "codex", provider, ownsModel: id => id.startsWith("codex::") }, { id: "coco", provider, ownsModel: id => id.startsWith("coco::") },
			] });
			await composite.provideLanguageModelChatResponse({ ...model, id: "codex::test" }, [user("Task")], options(), { report: () => undefined }, none);
			assert.strictEqual(calls, 1);
			await assert.rejects(composite.provideLanguageModelChatResponse(model, [user("Task")], options(), { report: () => undefined }, none), /Cannot (restore|save).*Chat transcript/);
			assert.strictEqual(calls, 1); composite.dispose();
		} finally { await f.dispose(); }
	});
	test("Coco measured cache appears as one diagnostic turn and on its Quick Access card", async () => {
		const f = await fixture(); const tracker = new SessionQualityTracker();
		try {
			const p = f.make();
			p.onDidUpdateLiveTurn(update => { if (update.context) { tracker.recordContext(update.context); } if (update.turn.lifecyclePhase === "running") { tracker.updateTurn(update.turn); } else { tracker.recordTurn(update.turn); } });
			await f.send(p, [user("Hi")]);
			assert.strictEqual(tracker.records.length, 1); assert.strictEqual(tracker.records[0].turn.providerKind, "coco");
			assert.strictEqual(tracker.records[0].turn.cachedPromptTokens, 90); assert.strictEqual(tracker.records[0].turn.usageEstimated, false);
			assert.strictEqual(tracker.records[0].context?.tokenCountSource, "server"); assert.strictEqual(usageProviderForSource("coco"), "coco");
			const view = new LlamaQuickActionsProvider({ getProviderSnapshots: () => new Map([["coco", { sourceId: "coco", label: "Coco", state: "online", summary: "Connected", metrics: p.runtimeMetrics }]]) });
			const roots = await Promise.resolve(view.getChildren()) ?? [];
			const card = roots.find(item => item.label === "Coco")!;
			assert.ok(card.children?.some(item => item.id?.endsWith("coco.cache") && String(item.description).includes("85.7%")));
			assert.ok(card.children?.some(item => item.id?.endsWith("coco.context") && String(item.description).includes("1.0M")));
		} finally { await f.dispose(); }
	});
	test("does not start inference when its durable pre-request checkpoint cannot be written", async () => {
		const f = await fixture(), update = f.state.update;
		try {
			await fs.mkdir(path.join(f.root, "sessions.json.tmp"));
			f.state.update = async () => { throw new Error("Storage unavailable"); };
			await assert.rejects(f.send(f.make(), [user("Do not lose this task")]), /Cannot checkpoint Coco/);
			assert.strictEqual(f.prompts.length, 0);
		} finally { f.state.update = update; await f.dispose(); }
	});
	test("concurrent journal leases cannot let a late old response overwrite a newer request", async () => {
		const f = await fixture();
		try {
			const journal = new ConversationHistory(f.root);
			const [old, current] = await Promise.all([journal.begin("one", [user("OLD request")]), journal.begin("one", [user("CURRENT request")])]);
			await Promise.all([old.complete([new vscode.LanguageModelTextPart("OLD response")]), current.complete([new vscode.LanguageModelTextPart("CURRENT response")])]);
			const restored = await new ConversationHistory(f.root).begin("one", [user("CURRENT request"), assistant("CURRENT response"), user("Next")]);
			assert.ok(!JSON.stringify(restored.messages).includes("OLD response")); assert.ok(JSON.stringify(restored.messages).includes("CURRENT response"));
			await restored.complete([]);
		} finally { await f.dispose(); }
	});
	test("the workspace journal preserves original image bytes across reload", async () => {
		const f = await fixture();
		try {
			const image = vscode.LanguageModelDataPart.image(new Uint8Array([1, 2, 3, 4]), "image/png");
			const initial = user([new vscode.LanguageModelTextPart("Inspect image"), image]);
			const lease = await new ConversationHistory(f.root).begin("image-chat", [initial]); await lease.complete([new vscode.LanguageModelTextPart("Image finding")]);
			const restored = await new ConversationHistory(f.root).begin("image-chat", [initial, assistant("Image finding"), user("Continue")]);
			const part = restored.messages[0].content.find(p => p instanceof vscode.LanguageModelDataPart) as vscode.LanguageModelDataPart;
			assert.deepStrictEqual([...part.data], [1, 2, 3, 4]); await restored.complete([]);
		} finally { await f.dispose(); }
	});
	test("splits UTF-16 text without dropping characters or splitting surrogate pairs", () => {
		const original = "x".repeat(1023) + "🦄" + "z".repeat(4000);
		const chunks = splitCocoHistory([{ type: "text", text: original }], 1024);
		assert.strictEqual(chunks.flat().map(p => p.type === "text" ? p.text : "").join(""), original);
		assert.ok(chunks.flat().every(p => p.type !== "text" || !/[\uD800-\uDBFF]$/.test(p.text)));
	});
	test("preserves the middle of a large tool result in a readable archive", async () => {
		const f = await fixture();
		try {
			const full = "a".repeat(70_000) + "CRITICAL_MIDDLE_FACT" + "z".repeat(70_000);
			const result = await new CocoHistoryArchive(f.root).toolResult(new vscode.LanguageModelToolResultPart("call", [new vscode.LanguageModelTextPart(full)]), "test");
			assert.match(result.output, /Full tool output:/);
			const directory = (await fs.readdir(f.root))[0], file = (await fs.readdir(path.join(f.root, directory)))[0];
			assert.strictEqual(await fs.readFile(path.join(f.root, directory, file), "utf8"), full);
		} finally { await f.dispose(); }
	});
	test("normalizes ACP cache counters once and leaves missing cache unreported", () => {
		assert.deepStrictEqual(parseCocoTokenUsage({ usage: { inputTokens: 3, outputTokens: 36, cachedReadTokens: 60_650, cachedWriteTokens: 22 } }), { inputTokens: 60_675, outputTokens: 36, cachedInputTokens: 60_650, cacheWriteInputTokens: 22 });
		assert.strictEqual(parseCocoTokenUsage({ usage: { inputTokens: 10 } }), undefined);
		assert.strictEqual(parseCocoTokenUsage({ usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: -1 } }), undefined);
		const usage = parseCocoTokenUsage({ usage: { inputTokens: 10, outputTokens: 2 } })!;
		assert.strictEqual(usage.cachedInputTokens, undefined);
		assert.strictEqual(sumCocoUsage([usage, { inputTokens: 100, outputTokens: 1, cachedInputTokens: 90 }])?.cachedInputTokens, undefined);
	});
	test("recovers retained-away history and drops abandoned branch messages", () => {
		const previous = [user("FIRST requirement"), assistant("OLD important finding"), user("Second task"), assistant("Second answer")];
		const merged = mergeConversationHistory(previous, [user("Second task"), assistant("Second answer"), user("Continue")]);
		assert.strictEqual((merged[0].content[0] as vscode.LanguageModelTextPart).value, "FIRST requirement");
		const edited = mergeConversationHistory(previous, [user("FIRST requirement"), assistant("OLD important finding"), user("REPLACEMENT task")]);
		assert.ok(!JSON.stringify(edited).includes("Second task")); assert.ok(!JSON.stringify(edited).includes("Second answer"));
		const omittedReply = mergeConversationHistory(previous, [user("Second task"), user("Continue")]);
		assert.ok(JSON.stringify(omittedReply).includes("Second answer"));
		const updatedInstructions = mergeConversationHistory(previous, [user("UPDATED PROJECT RULE"), user("Second task"), assistant("Second answer"), user("Continue")]);
		assert.ok(JSON.stringify(updatedInstructions).includes("UPDATED PROJECT RULE"));
		assert.ok(JSON.stringify(updatedInstructions).includes("OLD important finding"));
	});
	test("Codex → Coco restores omitted history from the workspace journal, including after reload", async () => {
		const f = await fixture();
		try {
			const makeComposite = () => new CompositeChatModelProvider({ history: new ConversationHistory(f.root), providers: [
				{ id: "codex", ownsModel: id => id.startsWith("codex::"), provider: { provideLanguageModelChatInformation: async () => [], provideTokenCount: async () => 1,
					provideLanguageModelChatResponse: async (_model, _messages, _options, progress) => { progress.report(new vscode.LanguageModelTextPart("CODEX_FINDING")); } } },
				{ id: "coco", ownsModel: id => id.startsWith("coco::"), provider: f.make() },
			] });
			const first = makeComposite();
			await first.provideLanguageModelChatResponse({ ...model, id: "codex::test" }, [user("EARLY REQUIREMENT"), assistant("OLD FACT"), user("Investigate")], options(), { report: () => undefined }, none);
			first.dispose();
			const restored = makeComposite();
			await restored.provideLanguageModelChatResponse(model, [user("Investigate"), assistant("CODEX_FINDING"), user("Continue in Coco")], options(), { report: () => undefined }, none);
			assert.match(f.prompts.at(-1)!, /EARLY REQUIREMENT/); assert.match(f.prompts.at(-1)!, /OLD FACT/); assert.match(f.prompts.at(-1)!, /CODEX_FINDING/);
			assert.match(f.prompts.at(-1)!, /Complete visible Chat transcript \(JSON\)/);
			restored.dispose();
		} finally { await f.dispose(); }
	});
});