import * as assert from "assert";

import { calculateOverallHealth } from "../diagnostics/provider-health";
import { SessionQualityTracker } from "../diagnostics/session-report";
import type { LlamaChatContextUsageMetrics, LlamaChatTurnMetrics } from "../llama-provider";

function turn(overrides: Partial<LlamaChatTurnMetrics> = {}): LlamaChatTurnMetrics {
	return {
		requestId: "request-1",
		modelId: "local::qwen",
		durationMs: 1000,
		queueWaitMs: 0,
		firstTokenLatencyMs: 100,
		emittedParts: 2,
		outputChars: 400,
		thinkingChars: 100,
		estimatedOutputTokens: 100,
		modelTurns: 1,
		usageEstimated: false,
		tokensPerSecond: 20,
		promptTokens: 1000,
		cachedPromptTokens: 750,
		promptCacheHitPercent: 75,
		retriedAfterOverflow: false,
		toolCalls: 2,
		repairedToolCalls: 1,
		rejectedToolCalls: 0,
		schemaRejectedToolCalls: 0,
		toolCallRepairRetries: 0,
		toolLoopDetected: false,
		...overrides,
	};
}

suite("diagnostics", () => {
	test("calculates and renders provider health", () => {
		const checks = [
			{ id: "models", label: "Models", status: "pass" as const, detail: "1 model" },
			{ id: "cache", label: "Cache", status: "warning" as const, detail: "disabled" },
		];
		assert.strictEqual(calculateOverallHealth(checks), "warning");
	});

	test("aggregates session quality without message bodies", () => {
		const tracker = new SessionQualityTracker();
		const context = {
			requestId: "request-1",
			modelId: "local::qwen",
			attemptNo: 1,
			contextLength: 131072,
			inputBudget: 100000,
			softInputTarget: 90000,
			hardInputTarget: 80000,
			messageTokensBeforeCompact: 50000,
			messageTokensAfterCompact: 40000,
			messageCountBeforeCompact: 20,
			messageCountAfterCompact: 12,
			toolTokens: 5000,
			replyReserveTokens: 8000,
			cappedTools: 48,
			autoCompacted: true,
			hardCompacted: false,
			estimatedUsedTokens: 53000,
			estimatedFreeTokens: 78072,
			estimatedUsagePercent: 40.4,
			tokenCountSource: "server",
		} satisfies LlamaChatContextUsageMetrics;
		tracker.recordContext(context);
		tracker.recordTurn(turn({ modelTurns: 4 }));

		assert.strictEqual(tracker.summary.cacheHitPercent, 75);
		assert.strictEqual(tracker.summary.turns, 1);
		assert.strictEqual(tracker.summary.totalModelTurns, 4);
		assert.strictEqual(tracker.summary.cacheByModel[0].modelSegments, 4);
		assert.strictEqual(tracker.summary.compactedTurns, 1);
		assert.strictEqual(tracker.summary.repairedToolCalls, 1);
		});

		test("upserts a running turn and replaces it with the finalized snapshot", () => {
		const tracker = new SessionQualityTracker();
		tracker.updateTurn(turn({ durationMs: 100, usageEstimated: true, modelTurns: 1 }));
		tracker.updateTurn(turn({ durationMs: 250, usageEstimated: true, modelTurns: 2 }));
		tracker.recordTurn(turn({ durationMs: 400, usageEstimated: false, modelTurns: 3 }));

		assert.strictEqual(tracker.count, 1);
		assert.strictEqual(tracker.records[0].turn.durationMs, 400);
		assert.strictEqual(tracker.records[0].turn.modelTurns, 3);
		assert.strictEqual(tracker.records[0].turn.usageEstimated, false);
	});

	test("uses the final Codex segment for continuation health without losing processed totals", () => {
		const tracker = new SessionQualityTracker();
		tracker.recordTurn(turn({
			providerKind: "codex",
			modelId: "codex::gpt-5.6-sol",
			threadMode: "new",
			threadReuseMissReason: "no-stored-thread",
			promptTokens: 235_703,
			cachedPromptTokens: 115_456,
			promptCacheHitPercent: 49,
			initialSegmentCacheHitPercent: 0,
			continuationCacheHitPercent: 96.7,
			cacheMissReason: "healthy",
			modelTurns: 2,
		}));

		assert.strictEqual(tracker.summary.cacheHitPercent, 49);
		assert.strictEqual(tracker.summary.cacheAverageHitPercent, 96.7);
		assert.strictEqual(tracker.summary.cacheWorstHitPercent, 96.7);
		assert.strictEqual(tracker.summary.cacheHealthyTurns, 1);
		assert.strictEqual(tracker.summary.cacheStartupMissTurns, 1);
		});

		test("correlates a local subagent turn with the only running Codex runSubagent step", () => {
		const tracker = new SessionQualityTracker();
		tracker.updateTurn(turn({
			requestId: "parent-request",
			providerKind: "codex",
			modelId: "codex::gpt-5.6-sol",
			lifecyclePhase: "running",
			conversationKey: "conversation-a",
			steps: [{
				id: "tool-call-subagent",
				index: 1,
				kind: "tool",
				label: "runSubagent",
				status: "running",
				toolCategory: "vscode",
				startedAt: "2026-07-29T07:00:00.000Z",
			}],
		}));
		tracker.recordTurn(turn({
			requestId: "child-request",
			providerKind: "local",
			modelId: "local::qwen",
			conversationKey: undefined,
		}));

		const child = tracker.records.find(record => record.turn.requestId === "child-request")?.turn;
		assert.strictEqual(child?.isSubagent, true);
		assert.strictEqual(child?.parentRequestId, "parent-request");
		assert.strictEqual(child?.parentToolCallId, "call-subagent");
	});

	test("correlates a DeepSeek subagent turn with a running Claude runSubagent step", () => {
		const tracker = new SessionQualityTracker();
		tracker.updateTurn(turn({
			requestId: "claude-parent",
			providerKind: "claude",
			modelId: "claude::claude-opus-5",
			lifecyclePhase: "running",
			steps: [{
				id: "tool-claude-subagent",
				index: 1,
				kind: "tool",
				label: "runSubagent",
				status: "running",
				toolCategory: "vscode",
				startedAt: "2026-07-29T08:00:00.000Z",
			}],
		}));
		tracker.recordTurn(turn({
			requestId: "deepseek-child",
			providerKind: "deepseek",
			modelId: "deepseek::deepseek-v4-pro",
		}));

		const child = tracker.records.find(record => record.turn.requestId === "deepseek-child")?.turn;
		assert.strictEqual(child?.isSubagent, true);
		assert.strictEqual(child?.parentRequestId, "claude-parent");
		assert.strictEqual(child?.parentToolCallId, "claude-subagent");
	});
});
