import * as assert from "node:assert";
import * as vscode from "vscode";
import type { CodexAppServerClient, CodexServerNotification } from "../codex/app-server-client";
import { CodexTurnBridge } from "../codex/turn-bridge";

suite("Codex live Chat progress", () => {
	let notifications: vscode.EventEmitter<CodexServerNotification>;
	let stops: vscode.EventEmitter<Error>;
	let bridge: CodexTurnBridge;
	let source: vscode.CancellationTokenSource;
	let parts: vscode.LanguageModelResponsePart[];

	setup(() => {
		notifications = new vscode.EventEmitter<CodexServerNotification>();
		stops = new vscode.EventEmitter<Error>();
		const client = {
			onNotification: notifications.event,
			onDidStop: stops.event,
			request: async () => ({ turn: { id: "turn-1", status: "inProgress" } }),
		} as unknown as CodexAppServerClient;
		bridge = new CodexTurnBridge(client, "thread-1");
		source = new vscode.CancellationTokenSource();
		parts = [];
	});

	teardown(() => { bridge.dispose(); source.dispose(); notifications.dispose(); stops.dispose(); });

	const thinkingText = (parts: vscode.LanguageModelResponsePart[]): string => parts
		.filter(part => !(part instanceof vscode.LanguageModelTextPart) && !(part instanceof vscode.LanguageModelDataPart))
		.map(part => {
			const value = (part as unknown as { value: string | string[] }).value;
			return Array.isArray(value) ? value.join("") : value;
		}).join("");

	function complete(): void {
		notifications.fire({ method: "turn/completed", params: {
			threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null },
		} });
	}

	test("streams raw reasoning and readable summaries immediately without mixing them into the answer", async () => {
		const boundary = bridge.start({ threadId: "thread-1", input: [] }, { report: part => parts.push(part) }, source.token);
		notifications.fire({ method: "item/reasoning/textDelta", params: {
			threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: "Raw reasoning. ",
		} });
		notifications.fire({ method: "item/reasoning/summaryTextDelta", params: {
			threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: "Readable summary.",
		} });
		assert.strictEqual(thinkingText(parts), "Raw reasoning. Readable summary.");
		assert.strictEqual(bridge.finalText, "");
		notifications.fire({ method: "item/agentMessage/delta", params: {
			threadId: "thread-1", turnId: "turn-1", itemId: "answer-1", delta: "Answer.",
		} });
		assert.strictEqual(bridge.finalText, "Answer.");
		complete(); await boundary;
	});

	test("shows a single activity status when reasoning starts without readable content", async () => {
		const boundary = bridge.start({ threadId: "thread-1", input: [] }, { report: part => parts.push(part) }, source.token);
		const event = { method: "item/started", params: {
			threadId: "thread-1", turnId: "turn-1", item: { id: "reason-1", type: "reasoning", summary: [], content: [] },
		} };
		notifications.fire(event); notifications.fire(event);
		assert.strictEqual(thinkingText(parts), "Codex is reasoning…\n");
		assert.strictEqual(bridge.finalText, "");
		assert.ok(bridge.liveMetrics.firstModelEventLatencyMs !== undefined);
		assert.ok(!parts.some(part => part instanceof vscode.LanguageModelDataPart), "activity must not invent measured context");
		complete(); await boundary;
	});

	test("updates measured context during a live turn and accepts smaller usage after compaction", async () => {
		const boundary = bridge.start({ threadId: "thread-1", input: [] }, { report: part => parts.push(part) }, source.token);
		const update = (inputTokens: number, threadId = "thread-1", turnId = "turn-1") => notifications.fire({
			method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: {
				total: { totalTokens: 900_000, inputTokens: 880_000, cachedInputTokens: 850_000, outputTokens: 20_000, reasoningOutputTokens: 10_000 },
				last: { totalTokens: inputTokens + 100, inputTokens, cachedInputTokens: inputTokens, outputTokens: 100, reasoningOutputTokens: 10 },
				modelContextWindow: 354_350,
			} },
		});
		update(200_000);
		update(400_000, "another-thread"); update(400_000, "thread-1", "another-turn");
		update(80_000);
		const snapshots = parts
			.filter((part): part is vscode.LanguageModelDataPart => part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage")
			.map(part => JSON.parse(new TextDecoder().decode(part.data)));
		assert.deepStrictEqual(snapshots.map(usage => usage.prompt_tokens), [200_000, 80_000]);
		assert.deepStrictEqual(snapshots.map(usage => usage.total_tokens), [200_100, 80_100]);
		assert.deepStrictEqual(snapshots.map(usage => usage.prompt_tokens_details.cached_tokens), [200_000, 80_000]);
		complete(); await boundary;
	});
});