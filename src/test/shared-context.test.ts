import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { CompositeChatModelProvider } from "../composite-provider";
import { ConversationHistory, mergeConversationHistory } from "../providers/conversation-history";
import { prepareSharedHandoff, resolveProviderSwitchContextTokens, sharedContextBudget, sharedImageName } from "../context/provider-handoff";
import { cocoUserAnchors, CocoSessionStore } from "../coco/session-store";
import { conversationUserAnchors } from "../providers/conversation-anchors";
import { PROVIDER_SWITCH_OPTION } from "../providers/provider-switch";
import { CursorSessionStore } from "../cursor/session-store";

const user = vscode.LanguageModelChatMessage.User, assistant = vscode.LanguageModelChatMessage.Assistant;
const none: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined) };
const text = (messages: readonly vscode.LanguageModelChatRequestMessage[]) => JSON.stringify(messages);

suite("Shared provider context", () => {
	test("migrates persisted legacy Coco fingerprints and loads the same native session after reload", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "coco-anchor-migration-"));
		const file = path.join(root, "sessions.json"), loads: string[] = [];
		const makeClient = () => ({ transport: "acp" as const, initialize: async () => ({ agentCapabilities: { loadSession: true } }),
			newSession: async () => ({ sessionId: "existing-native-id" }), loadSession: async (id: string) => { loads.push(id); return { sessionId: id }; },
			setSessionConfigOption: async () => ({}), prompt: async () => ({}), cancel: () => undefined, dispose: () => undefined });
		const identity = CocoSessionStore.identity("cli", root, "connection", "model");
		let store = new CocoSessionStore(undefined, file);
		try {
			const first = [user("FIRST_RULE")], legacy = conversationUserAnchors(first);
			const old = await store.acquire(identity, "chat", legacy, makeClient, {}, first);
			await store.prepare(old, root, []); await store.checkpoint(old, legacy); store.finish(old); store.dispose();
			store = new CocoSessionStore(undefined, file);
			const messages = [...first, assistant("DONE"), user("NEW_TASK")];
			const restored = await store.acquire(identity, "chat", cocoUserAnchors(messages), makeClient, {}, messages);
			await store.prepare(restored, root, []);
			assert.deepStrictEqual(loads, ["existing-native-id"]); assert.strictEqual(restored.fresh, false); assert.strictEqual(restored.deltaStart, 2);
		} finally { store.dispose(); await fs.rm(root, { recursive: true, force: true }); }
	});
	test("Coco anchors ignore host-only updates and text-part boundaries", () => {
		const a = [user("RULE <context>old terminal</context>"), assistant("DONE"), user("NEXT")];
		const b = [user([new vscode.LanguageModelTextPart("RULE "), new vscode.LanguageModelTextPart("<context>new terminal</context>")]), assistant("DONE"), user("NEXT")];
		assert.deepStrictEqual(cocoUserAnchors(a), cocoUserAnchors(b));
	});
	test("summarizes a multi-megabyte unbroken line using bounded excerpts", function () {
		this.timeout(3000);
		const plan = prepareSharedHandoff([user("EARLY_RULE"), assistant("BEGIN_FINDING\n" + "x".repeat(3000000) + "\nEND_FINDING"), user("CURRENT")], 12000);
		assert.ok(plan.wasCompacted); assert.ok(plan.tokenEstimateAfter <= 12000); assert.match(text(plan.compacted), /CURRENT/);
	});
	test("every provider receives the complete common history after retained-window switches and reload", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-context-"));
		const captures = new Map<string, readonly vscode.LanguageModelChatRequestMessage[]>();
		const ids = ["codex", "coco", "http", "claude", "local"];
		const make = () => new CompositeChatModelProvider({ history: new ConversationHistory(root), providers: ids.map(id => ({ id, ownsModel: model => model === id,
			provider: { provideLanguageModelChatInformation: async () => [], provideTokenCount: async () => 1,
				provideLanguageModelChatResponse: async (_model, messages, _options, progress) => { captures.set(id, messages); progress.report(new vscode.LanguageModelTextPart(`${id}_FINDING`)); } } })) });
		let composite = make();
		const options = { toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _conversationId: "same-chat" } };
		const model = { name: "fixture", family: "fixture", version: "1", capabilities: {}, maxInputTokens: 100000, maxOutputTokens: 8192 };
		try {
			await composite.provideLanguageModelChatResponse({ ...model, id: ids[0] }, [user("EARLY_REQUIREMENT"), assistant("MIDDLE_DECISION"), user("FIRST_TASK")], options, { report: () => undefined }, none);
			let previousTask = "FIRST_TASK";
			for (let index = 1; index < ids.length; index++) {
				composite.dispose(); composite = make();
				const id = ids[index], task = `TASK_${id}`;
				await composite.provideLanguageModelChatResponse({ ...model, id }, [user(previousTask), assistant(`${ids[index - 1]}_FINDING`), user(task)], options, { report: () => undefined }, none);
				const received = text(captures.get(id)!);
				assert.match(received, /EARLY_REQUIREMENT/); assert.match(received, /MIDDLE_DECISION/);
				for (const prior of ids.slice(0, index)) { assert.ok(received.includes(`${prior}_FINDING`)); }
				previousTask = task;
			}
		} finally { composite.dispose(); await fs.rm(root, { recursive: true, force: true }); }
	});
	test("a request to another model than the one that last answered is flagged as a provider switch, also after reload", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-switch-"));
		const seen: { model: string; switched: unknown }[] = [];
		let failNext = false;
		const make = () => new CompositeChatModelProvider({ history: new ConversationHistory(root), providers: [{ id: "any", ownsModel: () => true,
			provider: { provideLanguageModelChatInformation: async () => [], provideTokenCount: async () => 1,
				provideLanguageModelChatResponse: async (model, _messages, options, progress) => {
					seen.push({ model: model.id, switched: options.modelOptions?.[PROVIDER_SWITCH_OPTION] });
					if (failNext) { failNext = false; throw new Error("rate limited"); }
					progress.report(new vscode.LanguageModelTextPart(`${model.id} answer`));
				} } }] });
		const model = { name: "fixture", family: "fixture", version: "1", capabilities: {}, maxInputTokens: 100000, maxOutputTokens: 8192 };
		const options = { toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _conversationId: "switch-chat" } };
		let composite = make();
		const ask = (id: string, ...messages: vscode.LanguageModelChatRequestMessage[]) =>
			composite.provideLanguageModelChatResponse({ ...model, id }, messages, options, { report: () => undefined }, none);
		try {
			await ask("codex::a", user("ONE"));
			await ask("codex::a", user("ONE"), assistant("codex::a answer"), user("TWO"));
			composite.dispose(); composite = make();
			await ask("claude::b", user("ONE"), assistant("codex::a answer"), user("TWO"), assistant("codex::a answer"), user("THREE"));
			await ask("claude::b", user("ONE"), assistant("codex::a answer"), user("TWO"), assistant("codex::a answer"), user("THREE"), assistant("claude::b answer"), user("FOUR"));
			failNext = true;
			await assert.rejects(ask("codex::a", user("FOUR"), assistant("claude::b answer"), user("FIVE")), /rate limited/);
			await ask("claude::b", user("FOUR"), assistant("claude::b answer"), user("FIVE"));
			assert.deepStrictEqual(seen.map(entry => entry.switched), [undefined, undefined, "codex::a", undefined, "claude::b", undefined],
				"a failed request without output does not take the chat over");
		} finally { composite.dispose(); await fs.rm(root, { recursive: true, force: true }); }
	});
	test("a takeover budget is 250K tokens by default and never leaves its bounds", () => {
		const withValue = (value: unknown) => ({ get: <T>(key: string, fallback?: T) => (key === "providerSwitchContextTokens" ? (value as T) : fallback) });
		assert.strictEqual(resolveProviderSwitchContextTokens(withValue(undefined) as never), 250_000);
		assert.strictEqual(resolveProviderSwitchContextTokens(withValue(120_000) as never), 120_000);
		assert.strictEqual(resolveProviderSwitchContextTokens(withValue(1) as never), 32_768);
		assert.strictEqual(resolveProviderSwitchContextTokens(withValue(9_999_999) as never), 1_048_576);
		assert.strictEqual(resolveProviderSwitchContextTokens(withValue("nonsense") as never), 250_000);
	});
	test("a takeover transfers only the newest turns within the budget", () => {
		const rounds = Array.from({ length: 300 }, (_, index) => [
			assistant([new vscode.LanguageModelTextPart(`STEP_${index}`), new vscode.LanguageModelToolCallPart(`call-${index}`, "read_file", { index })]),
			user([new vscode.LanguageModelToolResultPart(`call-${index}`, [new vscode.LanguageModelTextPart(`output ${index} `.repeat(200))])]),
		]).flat();
		const messages = [user("FIRST_REQUEST"), assistant("EARLY FINDING"), ...rounds, user("LATEST_REQUEST")];
		const plan = prepareSharedHandoff(messages, 250_000);
		assert.ok(plan.wasCompacted);
		assert.ok(plan.tokenEstimateAfter <= 250_000);
		assert.match(text(plan.compacted), /LATEST_REQUEST/);
		assert.strictEqual(plan.compacted.at(-1)?.content[0], messages.at(-1)?.content[0], "the newest request closes the transfer");
		assert.ok(plan.messageCountAfter < plan.messageCountBefore);
	});
	test("Coco opens a new native session instead of a delta after a provider switch", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "coco-switch-"));
		const makeClient = () => ({ transport: "acp" as const, initialize: async () => ({ agentCapabilities: { loadSession: true } }),
			newSession: async () => ({ sessionId: "native" }), loadSession: async (id: string) => ({ sessionId: id }),
			setSessionConfigOption: async () => ({}), prompt: async () => ({}), cancel: () => undefined, dispose: () => undefined });
		const identity = CocoSessionStore.identity("cli", root, "connection", "model");
		const store = new CocoSessionStore(undefined, path.join(root, "sessions.json"));
		try {
			const first = [user("TASK")];
			const session = await store.acquire(identity, "chat", cocoUserAnchors(first), makeClient, {}, first);
			await store.prepare(session, root, []); await store.checkpoint(session, cocoUserAnchors(first)); store.finish(session);
			const later = [...first, assistant("OTHER MODEL WORK"), user("CONTINUE")];
			const switched = await store.acquire(identity, "chat", cocoUserAnchors(later), makeClient, {}, later, false, true);
			assert.strictEqual(switched.mode, "new"); assert.strictEqual(switched.reason, "provider_switched"); assert.strictEqual(switched.deltaStart, 0);
			assert.strictEqual(switched.sessionId, undefined, "the old native session is not loaded");
		} finally { store.dispose(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
	});
	test("Cursor drops its native agent and starts a cold handoff after a provider switch", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-switch-"));
		const store = new CursorSessionStore(undefined, path.join(root, "sessions.json"));
		const key = "a".repeat(64), identity = "b".repeat(64);
		try {
			const first = [user("TASK")];
			const session = await store.acquire(key, identity, first);
			session.agent = { agentId: "agent-1", close: () => undefined } as unknown as NonNullable<typeof session.agent>;
			await store.complete(session);
			const later = [...first, assistant("OTHER MODEL WORK"), user("CONTINUE")];
			const warm = await store.acquire(key, identity, later);
			assert.strictEqual(warm.mode, "warm"); assert.ok(warm.deltaStart > 0);
			await store.releaseUnstarted(warm);
			const switched = await store.acquire(key, identity, later, [], true);
			assert.strictEqual(switched.mode, "new"); assert.strictEqual(switched.reason, "provider_switched");
			assert.strictEqual(switched.agentId, undefined); assert.strictEqual(switched.deltaStart, 0);
		} finally { await store.settle(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
	});
	test("retained windows do not require the previous final anchor to preserve the omitted middle", () => {
		const old = [user("FIRST"), assistant("EARLY"), user("SECOND"), assistant("SECOND_FINDING"), user("THIRD"), assistant("THIRD_FINDING")];
		const result = mergeConversationHistory(old, [user("SECOND"), assistant("SECOND_FINDING"), user("FOURTH")]);
		assert.match(text(result), /FIRST/); assert.match(text(result), /THIRD_FINDING/); assert.match(text(result), /FOURTH/);
	});
	test("a capped render that drops middle turns keeps the whole journal on a new request", () => {
		const turns = [0, 1, 2, 3, 4, 5].flatMap(index => [user(`TASK_${index}`), assistant(`FINDING_${index}`)]);
		const capped = [user("TASK_0"), assistant("FINDING_0"), user("TASK_4"), assistant("FINDING_4"), user("TASK_5"), assistant("FINDING_5"), user("NEW_TASK")];
		const result = text(mergeConversationHistory(turns, capped));
		const order = [0, 1, 2, 3, 4, 5].map(index => result.indexOf(`FINDING_${index}`));
		assert.ok(order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1])), result);
		assert.ok(result.indexOf("NEW_TASK") > order[5]);
	});
	test("an edit still cuts the abandoned branch when the render dropped middle turns", () => {
		const turns = [0, 1, 2, 3, 4, 5].flatMap(index => [user(`TASK_${index}`), assistant(`FINDING_${index}`)]);
		const result = text(mergeConversationHistory(turns, [user("TASK_0"), assistant("FINDING_0"), user("TASK_3"), assistant("FINDING_3"), user("EDITED_TASK")]));
		assert.match(result, /FINDING_1/); assert.match(result, /FINDING_3/); assert.match(result, /EDITED_TASK/);
		assert.ok(!result.includes("TASK_4") && !result.includes("FINDING_5"), result);
	});
	test("an edit whose text equals a later request does not keep the abandoned branch", () => {
		const old = [user("A"), assistant("A_FINDING"), user("B"), assistant("B_FINDING"), user("C"), assistant("C_FINDING")];
		const result = text(mergeConversationHistory(old, [user("A"), assistant("A_FINDING"), user("C")]));
		assert.ok(!result.includes("B_FINDING") && !result.includes("C_FINDING"), result);
		const regenerated = text(mergeConversationHistory(old, [user("A"), assistant("A_FINDING"), user("B"), assistant("B_FINDING"), user("C")]));
		assert.ok(!regenerated.includes("C_FINDING") && regenerated.includes("B_FINDING"), regenerated);
	});
	test("replaces the current system snapshot instead of retaining duplicates from each provider", () => {
		const system = (value: string) => new vscode.LanguageModelChatMessage(3 as vscode.LanguageModelChatMessageRole, [new vscode.LanguageModelTextPart(value)]);
		const result = mergeConversationHistory([system("OLD_SYSTEM"), user("TASK"), assistant("FINDING")], [system("NEW_SYSTEM"), system("NEW_SYSTEM"), user("TASK"), assistant("FINDING"), user("NEXT")]);
		assert.ok(!text(result).includes("OLD_SYSTEM")); assert.strictEqual(result.filter(message => Number(message.role) === 3).length, 1);
	});
	test("uses the same token budget in every larger window and respects a smaller native window", () => {
		assert.strictEqual(sharedContextBudget(1000000, [], 475000), sharedContextBudget(500000, [], 475000));
		assert.ok(sharedContextBudget(258400, [], 475000) < sharedContextBudget(500000, [], 475000));
	});
	test("one planner preserves typed current tools/images and does not mutate the original transcript", () => {
		const oldResult = new vscode.LanguageModelToolResultPart("old-call", [new vscode.LanguageModelTextPart("result ".repeat(10000))]);
		const image = vscode.LanguageModelDataPart.image(new Uint8Array([1, 2, 3]), "image/png");
		const current = user([new vscode.LanguageModelTextPart("CURRENT_EXACT"), image]);
		const source = [user("EARLY_RULE"), assistant("old history ".repeat(20000)), user([oldResult]), current];
		const plan = prepareSharedHandoff(source, 12000, "/shared/context.json");
		assert.ok(plan.wasCompacted); assert.ok(plan.tokenEstimateAfter <= 12000);
		assert.strictEqual(plan.compacted.at(-1), current); assert.ok(text(plan.compacted).includes("CURRENT_EXACT"));
		assert.strictEqual((oldResult.content[0] as vscode.LanguageModelTextPart).value.length, 70000);
		assert.match(text(plan.compacted), /Conversation summary \(shared provider context\)/);
		assert.throws(() => prepareSharedHandoff([user("x".repeat(10000))], 1024), /current request.*shared context budget/);
	});
	test("a long autonomous turn compacts its older tool rounds instead of failing", () => {
		const request = user("CONTINUE_THE_PORT");
		const rounds = Array.from({ length: 160 }, (_, index) => [
			assistant([new vscode.LanguageModelTextPart(`STEP_${index}`), new vscode.LanguageModelToolCallPart(`call-${index}`, "read_file", { index })]),
			user([new vscode.LanguageModelToolResultPart(`call-${index}`, [new vscode.LanguageModelTextPart(`output ${index} `.repeat(400))])]),
		]).flat();
		const plan = prepareSharedHandoff([user("EARLY_RULE"), assistant("EARLY_FINDING"), request, ...rounds], 20000);
		const rendered = text(plan.compacted);
		assert.ok(plan.wasCompacted); assert.ok(plan.tokenEstimateAfter <= 20000);
		assert.ok(plan.compacted.includes(request)); assert.strictEqual(plan.compacted.at(-1), rounds.at(-1));
		assert.match(rendered, /Earlier steps of the current request/); assert.match(rendered, /STEP_159/);
		const first = plan.compacted.indexOf(request) + 1;
		assert.ok(plan.compacted[first].role === vscode.LanguageModelChatMessageRole.Assistant, "retained steps must not start with an orphaned tool result");
	});
	test("historical image references resolve to exact workspace files after journaling", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-images-"));
		try {
			const image = vscode.LanguageModelDataPart.image(new Uint8Array([4, 5, 6]), "image/png");
			const lease = await new ConversationHistory(root).begin("chat", [user([image, new vscode.LanguageModelTextPart("OLD_IMAGE")]), assistant("Answer"), user("CURRENT")]);
			const plan = prepareSharedHandoff(lease.messages, 20000, lease.transcriptPath);
			const file = path.join(root, "assets", sharedImageName(image.data, image.mimeType));
			assert.ok(text(plan.compacted).includes(sharedImageName(image.data, image.mimeType)));
			assert.deepStrictEqual(await fs.readFile(file), Buffer.from(image.data)); await lease.complete([]);
		} finally { await fs.rm(root, { recursive: true, force: true }); }
	});
	test("repeated screenshots in tool results are saved once as assets and restored after reload", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-assets-"));
		try {
			const bytes = new Uint8Array(4 * 1024 * 1024).map((_, index) => index % 251);
			const shot = (id: string) => [assistant([new vscode.LanguageModelToolCallPart(id, "screenshot", {})]),
				user([new vscode.LanguageModelToolResultPart(id, [vscode.LanguageModelDataPart.image(bytes, "image/png"), new vscode.LanguageModelTextPart(`SHOT_${id}`)])])];
			const messages = [user("CURRENT"), ...shot("a"), ...shot("b"), ...shot("c")];
			const lease = await new ConversationHistory(root).begin("chat", messages); await lease.complete([]);
			assert.ok((await fs.stat(lease.transcriptPath!)).size < 64 * 1024, "the transcript must reference images instead of embedding them");
			const restored = await new ConversationHistory(root).begin("chat", [user("CURRENT"), user("NEXT")]);
			const results = restored.messages.flatMap(message => message.content).filter(part => part instanceof vscode.LanguageModelToolResultPart);
			assert.strictEqual(results.length, 3);
			for (const result of results) {
				const image = result.content[0] as vscode.LanguageModelDataPart;
				assert.ok(image instanceof vscode.LanguageModelDataPart); assert.strictEqual(image.mimeType, "image/png");
				assert.deepStrictEqual(Buffer.from(image.data), Buffer.from(bytes));
			}
			await restored.complete([]);
		} finally { await fs.rm(root, { recursive: true, force: true }); }
	});
	test("journal steps append only new records and reload the same conversation", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-append-"));
		try {
			const journal = new ConversationHistory(root), messages: vscode.LanguageModelChatRequestMessage[] = [user("FIRST")];
			const first = await journal.begin("chat", messages); await first.complete([new vscode.LanguageModelTextPart("ANSWER_0")], "codex");
			const file = first.transcriptPath!, initial = await fs.readFile(file, "utf8");
			messages.push(assistant("ANSWER_0"));
			for (let index = 1; index <= 3; index++) {
				messages.push(user(`TASK_${index}`));
				const lease = await journal.begin("chat", messages); await lease.complete([new vscode.LanguageModelTextPart(`ANSWER_${index}`)], "claude");
				messages.push(assistant(`ANSWER_${index}`));
			}
			const saved = await fs.readFile(file, "utf8");
			assert.ok(saved.startsWith(initial), "earlier records must stay untouched");
			const records = saved.trim().split("\n").map(line => JSON.parse(line));
			assert.strictEqual(records[0].version, 2);
			assert.strictEqual(records.filter(record => record.message).length, 8);
			const restored = await new ConversationHistory(root).begin("chat", [...messages, user("NEXT")]);
			assert.strictEqual(restored.servedBy, "claude");
			assert.deepStrictEqual(restored.messages.map(m => (m.content[0] as vscode.LanguageModelTextPart).value),
				["FIRST", "ANSWER_0", "TASK_1", "ANSWER_1", "TASK_2", "ANSWER_2", "TASK_3", "ANSWER_3", "NEXT"]);
			await restored.complete([]);
		} finally { await fs.rm(root, { recursive: true, force: true }); }
	});
	test("legacy and torn journals load and are rewritten in the line format", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-legacy-"));
		try {
			const probe = await new ConversationHistory(root).begin("chat", [user("PROBE")]); await probe.complete([]);
			const file = probe.transcriptPath!;
			const legacy = { version: 1, servedBy: "codex", messages: [{ role: 1, content: [{ type: "text", text: "OLD_TASK" }] }, { role: 2, content: [{ type: "text", text: "OLD_ANSWER" }] }] };
			await fs.writeFile(file, JSON.stringify(legacy));
			const migrated = await new ConversationHistory(root).begin("chat", [user("OLD_TASK"), assistant("OLD_ANSWER"), user("NEW_TASK")]);
			assert.strictEqual(migrated.servedBy, "codex"); await migrated.complete([new vscode.LanguageModelTextPart("NEW_ANSWER")]);
			const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
			assert.strictEqual(JSON.parse(lines[0]).version, 2); assert.strictEqual(lines.filter(line => line.includes("\"message\"")).length, 4);
			await fs.appendFile(file, "{\"message\":{\"role\":1,\"content\":[{\"type\":\"te");
			const repaired = await new ConversationHistory(root).begin("chat", [user("OLD_TASK"), assistant("OLD_ANSWER"), user("NEW_TASK"), assistant("NEW_ANSWER"), user("LAST")]);
			await repaired.complete([]);
			const records = (await fs.readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
			assert.deepStrictEqual(records.filter(record => record.message).map(record => record.message.content[0].text), ["OLD_TASK", "OLD_ANSWER", "NEW_TASK", "NEW_ANSWER", "LAST"]);
		} finally { await fs.rm(root, { recursive: true, force: true }); }
	});
	test("an edited request rewrites the journal without the abandoned branch", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-branch-"));
		try {
			const journal = new ConversationHistory(root);
			const first = await journal.begin("chat", [user("TASK_A"), assistant("ANSWER_A"), user("TASK_B")]); await first.complete([new vscode.LanguageModelTextPart("ANSWER_B")]);
			const edited = await journal.begin("chat", [user("TASK_A"), assistant("ANSWER_A"), user("TASK_B_EDITED")]); await edited.complete([new vscode.LanguageModelTextPart("ANSWER_B2")]);
			const restored = await new ConversationHistory(root).begin("chat", [user("TASK_A"), assistant("ANSWER_A"), user("TASK_B_EDITED"), assistant("ANSWER_B2"), user("NEXT")]);
			const rendered = text(restored.messages);
			assert.doesNotMatch(rendered, /"TASK_B"|ANSWER_B"/); assert.match(rendered, /TASK_B_EDITED/); await restored.complete([]);
		} finally { await fs.rm(root, { recursive: true, force: true }); }
	});
	test("a trimmed visible chat keeps the earlier journaled turns", () => {
		const old = [user("TASK_1"), assistant("ANSWER_1"), user("TASK_2"), assistant("ANSWER_2"), user("TASK_3"), assistant("ANSWER_3")];
		const merged = text(mergeConversationHistory(old, [user("TASK_2"), assistant("ANSWER_2"), user("TASK_3"), assistant("ANSWER_3"), user("TASK_4")]));
		for (const marker of ["TASK_1", "ANSWER_1", "ANSWER_3", "TASK_4"]) { assert.match(merged, new RegExp(marker)); }
		assert.ok(merged.indexOf("TASK_1") < merged.indexOf("TASK_2") && merged.indexOf("ANSWER_3") < merged.indexOf("TASK_4"));
	});
	test("asset pruning removes only old images that no journal references", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-prune-"));
		try {
			const image = vscode.LanguageModelDataPart.image(new Uint8Array([7, 8, 9]), "image/png");
			const lease = await new ConversationHistory(root).begin("chat", [user([image, new vscode.LanguageModelTextPart("SHOT")])]); await lease.complete([]);
			const folder = path.join(root, "assets"), kept = sharedImageName(image.data, image.mimeType);
			const orphan = `${"a".repeat(64)}.png`, fresh = `${"b".repeat(64)}.png`, old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
			await fs.writeFile(path.join(folder, orphan), "x"); await fs.writeFile(path.join(folder, fresh), "y");
			await fs.utimes(path.join(folder, orphan), old, old); await fs.utimes(path.join(folder, kept), old, old);
			const result = await new ConversationHistory(root).pruneAssets();
			assert.deepStrictEqual(result, { removed: 1, bytes: 1 });
			assert.deepStrictEqual((await fs.readdir(folder)).sort(), [kept, fresh].sort());
		} finally { await fs.rm(root, { recursive: true, force: true }); }
	});
	test("reports a journaled conversation only once its transcript is saved, including after reload", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-has-"));
		try {
			const journal = new ConversationHistory(root);
			assert.strictEqual(journal.has("chat"), false, "an unseen chat must be rendered in full once");
			assert.strictEqual(journal.has(undefined), false);
			const lease = await journal.begin("chat", [user("FIRST")]); await lease.complete([new vscode.LanguageModelTextPart("Answer")]);
			assert.strictEqual(journal.has("chat"), true);
			assert.strictEqual(new ConversationHistory(root).has("chat"), true, "a reloaded host reads the saved transcript");
			assert.strictEqual(journal.has("other"), false);
		} finally { await fs.rm(root, { recursive: true, force: true }); }
	});
});