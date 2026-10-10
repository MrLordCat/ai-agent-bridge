import * as assert from "node:assert";
import * as vscode from "vscode";
import { CocoAcpClient } from "../coco/acp-client";
import { CocoChatModelProvider } from "../coco/coco-provider";
import { mapCocoModel } from "../coco/model-adapter";
import { CocoResponseStream } from "../coco/response-stream";
import { CocoTurnBridge } from "../coco/turn-bridge";
import { createCocoNativeContextUsage, parseCocoContextUsage } from "../coco/usage-adapter";

suite("Coco context usage", () => {
	const update = (used = 62_229, size = 1_000_000) => ({ sessionUpdate: "usage_update", used, size });
	const usageParts = (parts: vscode.LanguageModelResponsePart[]) => parts
		.filter((part): part is vscode.LanguageModelDataPart => part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage")
		.map(part => JSON.parse(Buffer.from(part.data).toString("utf8")) as Record<string, number>);

	test("reads current snapshots including empty and overfull context without accumulating them", () => {
		assert.deepStrictEqual(parseCocoContextUsage(update()), { usedTokens: 62_229, contextWindowTokens: 1_000_000 });
		assert.deepStrictEqual(parseCocoContextUsage(update(0)), { usedTokens: 0, contextWindowTokens: 1_000_000 });
		assert.deepStrictEqual(parseCocoContextUsage(update(120, 100)), { usedTokens: 120, contextWindowTokens: 100 });
		assert.deepStrictEqual(createCocoNativeContextUsage(parseCocoContextUsage(update())!), { prompt_tokens: 62_229, total_tokens: 62_229 });
	});

	test("rejects invalid sizes, negative, fractional and nonnumeric token counters", () => {
		for (const invalid of [null, {}, { ...update(), sessionUpdate: "other" }, { ...update(), used: "10" },
			update(-1), update(NaN), update(Infinity), update(1.5), update(1, 0), update(1, -1),
			update(1, Infinity), update(1, Number.MAX_SAFE_INTEGER + 1)]) {
			assert.strictEqual(parseCocoContextUsage(invalid), undefined);
		}
	});

	test("emits native usage separately from answer text without inventing billing or cache counters", () => {
		const parts: vscode.LanguageModelResponsePart[] = [];
		const token = new vscode.CancellationTokenSource();
		try {
			const stream = new CocoResponseStream({ report: part => parts.push(part) }, token.token);
			stream.accept(update()); stream.accept(update(60_000)); stream.accept(update(-1));
			stream.accept({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer" } });
			assert.deepStrictEqual(usageParts(parts), [{ prompt_tokens: 62_229, total_tokens: 62_229 }, { prompt_tokens: 60_000, total_tokens: 60_000 }]);
			assert.strictEqual((parts[2] as vscode.LanguageModelTextPart).value, "Answer");
			token.cancel(); stream.accept(update(90_000)); assert.strictEqual(parts.length, 3);
		} finally { token.dispose(); }
	});

	test("keeps the latest context across tool boundaries and accepts a reduction after compaction", async () => {
		const tool = { name: "test_tool", description: "Test tool", inputSchema: { type: "object" } };
		const bridge = new CocoTurnBridge([tool], () => undefined);
		const token = new vscode.CancellationTokenSource();
		const first: vscode.LanguageModelResponsePart[] = [], second: vscode.LanguageModelResponsePart[] = [];
		try {
			await bridge.start(async () => {
				bridge.accept(update()); await bridge.delegate(String(bridge.clientTools[0].name), {});
			}, { report: part => first.push(part) }, token.token);
			const call = first.find((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart)!;
			bridge.accept(update(90_000)); bridge.accept(update(40_000)); bridge.accept(update(-1));
			await bridge.resume([new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart("Done")])],
				{ report: part => second.push(part) }, token.token);
			assert.deepStrictEqual(usageParts(first), [{ prompt_tokens: 62_229, total_tokens: 62_229 }]);
			assert.deepStrictEqual(usageParts(second), [{ prompt_tokens: 40_000, total_tokens: 40_000 }]);
		} finally { bridge.dispose(); token.dispose(); }
	});

	test("updates the model's total context window from ACP and resets it on a source change", async () => {
		let connection = "First";
		const provider = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock", resolveConnection: () => connection,
			createClient: (_exe, _cwd, _connection, _model, handlers) => ({
				initialize: async () => undefined,
				newSession: async () => ({ sessionId: "session" }),
				prompt: async () => { handlers?.onUpdate?.(update()); return { stopReason: "end_turn", usage: { inputTokens: 999_999_999 } }; },
				cancel: () => undefined, dispose: () => undefined,
			}) as unknown as CocoAcpClient });
		const token = new vscode.CancellationTokenSource(), parts: vscode.LanguageModelResponsePart[] = [];
		try {
			await provider.provideLanguageModelChatResponse(mapCocoModel({ id: "auto", name: "Auto" }), [vscode.LanguageModelChatMessage.User("Hi")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: part => parts.push(part) }, token.token);
			assert.deepStrictEqual(usageParts(parts), [{ prompt_tokens: 62_229, total_tokens: 62_229 }]);
			const model = (await provider.provideLanguageModelChatInformation({ silent: true }, token.token))[0];
			assert.strictEqual(model.maxInputTokens + model.maxOutputTokens, 1_000_000);
			provider.refreshLanguageModelChatInformation();
			const refreshed = (await provider.provideLanguageModelChatInformation({ silent: true }, token.token))[0];
			assert.strictEqual(refreshed.maxInputTokens + refreshed.maxOutputTokens, 1_000_000);
			connection = "Second"; provider.refreshLanguageModelChatInformation();
			const reset = (await provider.provideLanguageModelChatInformation({ silent: true }, token.token))[0];
			assert.notStrictEqual(reset.maxInputTokens + reset.maxOutputTokens, 1_000_000);
		} finally { provider.dispose(); token.dispose(); }
	});

	test("does not fabricate context when the runtime supplies only cumulative billing usage", async () => {
		const bridge = new CocoTurnBridge([], () => undefined), token = new vscode.CancellationTokenSource();
		const parts: vscode.LanguageModelResponsePart[] = [];
		try {
			await bridge.start(async () => ({ usage: { inputTokens: 1_000_000, outputTokens: 300 } }), { report: part => parts.push(part) }, token.token);
			assert.deepStrictEqual(usageParts(parts), []);
		} finally { bridge.dispose(); token.dispose(); }
	});
});