import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { CompositeChatModelProvider } from "../composite-provider";
import { ConversationHistory, mergeConversationHistory } from "../providers/conversation-history";
import { prepareSharedHandoff, sharedContextBudget, sharedImageName } from "../context/provider-handoff";
import { cocoUserAnchors, CocoSessionStore } from "../coco/session-store";
import { conversationUserAnchors } from "../providers/conversation-anchors";

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