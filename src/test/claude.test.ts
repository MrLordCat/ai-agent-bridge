import * as assert from "assert";
import * as vscode from "vscode";

import {
	CLAUDE_SUBSCRIPTION_MODELS,
	decodeClaudeModelId,
	encodeClaudeModelId,
	estimateClaudeTokens,
} from "../claude/message-adapter";
import {
	buildClaudeUsageLimits,
	buildClaudeInitialConversationText,
	canonicalizeClaudeTools,
	createClaudeReasoningConfigurationSchema,
	findLatestPersistedClaudeConversation,
	findPersistedClaudeConversation,
	resolveClaudeContextLength,
} from "../claude/claude-provider";
import { buildClaudeModelAvailability } from "../claude/availability";
import {
	createClaudeNativeContextUsage,
	createClaudeNativeUsage,
	isClaudeVsCodeToolName,
	parseClaudeAssistantUsage,
} from "../claude/app-server-client";

type UsageSnapshot = Parameters<typeof buildClaudeUsageLimits>[0];
const AVAILABILITY_NOW = Date.parse("2026-07-19T09:00:00Z");

function availabilityFor(modelId: string, snapshot: UsageSnapshot, now = AVAILABILITY_NOW) {
	return buildClaudeModelAvailability(modelId, snapshot, AVAILABILITY_NOW, undefined, undefined, now);
}

function usageSnapshot(rateLimits: Record<string, unknown>): UsageSnapshot {
	return {
		subscription_type: "pro",
		rate_limits_available: true,
		rate_limits: rateLimits,
	} as unknown as UsageSnapshot;
}

suite("Claude subscription provider", () => {
	test("allows only tools hosted by the native VS Code MCP server", () => {
		assert.strictEqual(isClaudeVsCodeToolName("mcp__vscode__read_file"), true);
		assert.strictEqual(isClaudeVsCodeToolName("Read"), false);
		assert.strictEqual(isClaudeVsCodeToolName("Bash"), false);
		assert.strictEqual(isClaudeVsCodeToolName("mcp__other__write_file"), false);
	});

	test("parses exact Claude cache read, creation, and thinking usage", () => {
		const segment = parseClaudeAssistantUsage({
			id: "message-1",
			usage: {
				input_tokens: 312,
				cache_read_input_tokens: 4096,
				cache_creation_input_tokens: 512,
				output_tokens: 120,
				output_tokens_details: { thinking_tokens: 80 },
			},
		}, "fallback", 2, "2026-07-29T08:00:00.000Z");

		assert.deepStrictEqual(segment, {
			id: "message-1",
			index: 2,
			recordedAt: "2026-07-29T08:00:00.000Z",
			freshInputTokens: 312,
			cacheReadInputTokens: 4096,
			cacheCreationInputTokens: 512,
			inputTokens: 4920,
			outputTokens: 120,
			thinkingTokens: 80,
			totalTokens: 5040,
			cacheHitPercent: 83.3,
		});
	});

	test("emits Claude usage in the native Copilot context contract", () => {
		assert.deepStrictEqual(createClaudeNativeUsage({
			inputTokens: 312,
			cacheReadInputTokens: 4096,
			cacheCreationInputTokens: 512,
			outputTokens: 120,
			durationMs: 1000,
			numTurns: 1,
		}), {
			prompt_tokens: 4920,
			completion_tokens: 120,
			total_tokens: 5040,
			prompt_tokens_details: { cached_tokens: 4096 },
		});
	});

	test("uses the final Claude model segment for native context occupancy", () => {
		assert.deepStrictEqual(createClaudeNativeContextUsage({
			inputTokens: 10_000,
			cacheReadInputTokens: 15_000,
			cacheCreationInputTokens: 2_000,
			outputTokens: 500,
			durationMs: 2_000,
			numTurns: 2,
		}, [
			{
				id: "segment-1",
				index: 1,
				recordedAt: "2026-07-29T08:00:00.000Z",
				freshInputTokens: 10_000,
				cacheReadInputTokens: 7_000,
				cacheCreationInputTokens: 1_700,
				inputTokens: 18_700,
				outputTokens: 400,
				thinkingTokens: 200,
				totalTokens: 19_100,
			},
			{
				id: "segment-2",
				index: 2,
				recordedAt: "2026-07-29T08:00:01.000Z",
				freshInputTokens: 200,
				cacheReadInputTokens: 8_000,
				cacheCreationInputTokens: 300,
				inputTokens: 8_500,
				outputTokens: 100,
				thinkingTokens: 50,
				totalTokens: 8_600,
			},
		]), {
			prompt_tokens: 8_500,
			completion_tokens: 100,
			total_tokens: 8_600,
			prompt_tokens_details: { cached_tokens: 8_000 },
		});
	});

	test("canonicalizes Claude tool and schema order across Copilot reloads", () => {
		const left = canonicalizeClaudeTools([
			{ name: "zeta", description: "Z", inputSchema: { type: "object", properties: { b: { type: "string" }, a: { type: "number" } } } },
			{ name: "alpha", description: "A", inputSchema: { required: ["value"], properties: { value: { type: "string" } }, type: "object" } },
		]);
		const right = canonicalizeClaudeTools([
			{ name: "alpha", description: "A", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } },
			{ name: "zeta", description: "Z", inputSchema: { properties: { a: { type: "number" }, b: { type: "string" } }, type: "object" } },
		]);
		assert.deepStrictEqual(left, right);
		assert.deepStrictEqual(left.map(tool => tool.name), ["alpha", "zeta"]);
	});

	test("selects only a matching non-stale durable Claude session", () => {
		const entry = {
			conversationId: "conversation-1",
			sdkSessionId: "11111111-1111-4111-8111-111111111111",
			modelId: "claude-opus-5",
			runtimeKey: "runtime-a",
			userSignatures: ["user-a"],
			lastUsedAt: AVAILABILITY_NOW - 60_000,
		};
		assert.strictEqual(findPersistedClaudeConversation([entry], {
			conversationId: "conversation-1",
			modelId: "claude-opus-5",
			runtimeKey: "runtime-a",
			userSignatures: ["user-a", "user-b"],
			now: AVAILABILITY_NOW,
		})?.sdkSessionId, entry.sdkSessionId);
		assert.strictEqual(findPersistedClaudeConversation([entry], {
			conversationId: "conversation-1",
			modelId: "claude-opus-5",
			runtimeKey: "runtime-b",
			userSignatures: ["user-a", "user-b"],
			now: AVAILABILITY_NOW,
		}), undefined);
		assert.strictEqual(findPersistedClaudeConversation([{ ...entry, lastUsedAt: AVAILABILITY_NOW - 8 * 24 * 60 * 60_000 }], {
			conversationId: "conversation-1",
			modelId: "claude-opus-5",
			runtimeKey: "runtime-a",
			userSignatures: ["user-a", "user-b"],
			now: AVAILABILITY_NOW,
		}), undefined);
	});

	test("selects the newest non-stale Claude session for an explicit rollover", () => {
		const stale = {
			conversationId: "stale",
			sdkSessionId: "11111111-1111-4111-8111-111111111111",
			modelId: "claude-opus-5",
			runtimeKey: "runtime-old",
			userSignatures: ["old"],
			lastUsedAt: AVAILABILITY_NOW - 8 * 24 * 60 * 60_000,
		};
		const older = {
			...stale,
			conversationId: "older",
			sdkSessionId: "22222222-2222-4222-8222-222222222222",
			lastUsedAt: AVAILABILITY_NOW - 120_000,
		};
		const newest = {
			...stale,
			conversationId: "newest",
			sdkSessionId: "33333333-3333-4333-8333-333333333333",
			lastUsedAt: AVAILABILITY_NOW - 30_000,
		};

		assert.strictEqual(
			findLatestPersistedClaudeConversation([stale, older, newest], AVAILABILITY_NOW)?.conversationId,
			"newest"
		);
		assert.strictEqual(
			findLatestPersistedClaudeConversation([stale], AVAILABILITY_NOW),
			undefined
		);
	});

	test("round-trips provider model ids and advertises only Opus 5", () => {
		assert.strictEqual(
			decodeClaudeModelId(encodeClaudeModelId("claude-opus-5")),
			"claude-opus-5"
		);
		assert.strictEqual(decodeClaudeModelId("other::claude-opus-5"), undefined);
		assert.deepStrictEqual(
			CLAUDE_SUBSCRIPTION_MODELS.map(model => model.id),
			["claude-opus-5"]
		);
	});

	test("estimates text, native tool calls, and native tool results", () => {
		const textTokens = estimateClaudeTokens("x".repeat(400));
		assert.strictEqual(textTokens, 100);

		const toolMessage = vscode.LanguageModelChatMessage.Assistant([
			new vscode.LanguageModelToolCallPart("call-1", "read_file", {
				filePath: "README.md",
				startLine: 1,
				endLine: 100,
			}),
		]);
		assert.ok(estimateClaudeTokens(toolMessage) > 10);

		const resultMessage = vscode.LanguageModelChatMessage.User([
			new vscode.LanguageModelToolResultPart("call-1", [
				new vscode.LanguageModelTextPart("result ".repeat(100)),
			]),
		]);
		assert.ok(estimateClaudeTokens(resultMessage) > 100);
	});

	test("bounds a multi-thousand-message cold start before joining the transcript", () => {
		const messages = Array.from({ length: 5_109 }, (_, index) =>
			index % 2 === 0
				? vscode.LanguageModelChatMessage.User(`user-${index}-${"u".repeat(512)}`)
				: vscode.LanguageModelChatMessage.Assistant(`assistant-${index}-${"a".repeat(512)}`)
		);
		const prepared = buildClaudeInitialConversationText(messages, 300_000);

		assert.strictEqual(prepared.truncated, true);
		assert.strictEqual(prepared.includedMessages, 25);
		assert.ok(prepared.text.length <= 300_000);
		assert.ok(prepared.text.includes("older middle messages omitted"));
		assert.ok(prepared.text.includes("user-5108-"));
	});

	test("keeps a small Claude cold-start transcript intact", () => {
		const messages = [
			vscode.LanguageModelChatMessage.User("first"),
			vscode.LanguageModelChatMessage.Assistant("second"),
			vscode.LanguageModelChatMessage.User("latest"),
		];
		const prepared = buildClaudeInitialConversationText(messages, 32_768);

		assert.strictEqual(prepared.truncated, false);
		assert.strictEqual(prepared.includedMessages, messages.length);
		assert.ok(prepared.text.includes("first"));
		assert.ok(prepared.text.includes("second"));
		assert.ok(prepared.text.includes("latest"));
	});

	test("builds separate 5h, weekly, and model-scoped usage limits", () => {
		const snapshot = {
			subscription_type: "max",
			rate_limits_available: true,
			rate_limits: {
				five_hour: { utilization: 42.4, resets_at: "2026-07-19T18:00:00Z" },
				seven_day: { utilization: 87, resets_at: "2026-07-25T09:47:00Z" },
				seven_day_opus: { utilization: 12, resets_at: "2026-07-25T09:47:00Z" },
				model_scoped: [
					{ display_name: "Fable", utilization: 100, resets_at: "2026-07-25T09:47:00Z" },
				],
			},
		} as unknown as UsageSnapshot;

		const limits = buildClaudeUsageLimits(snapshot);
		assert.deepStrictEqual(
			limits.map(limit => limit.label),
			["Session Limit (5h)", "Weekly Limit", "Weekly Opus Limit"]
		);
		assert.ok(limits[0].description.startsWith("42% used / resets "));
		assert.ok(limits[1].description.startsWith("87% used / resets "));
		assert.ok(limits[2].description.startsWith("12% used / resets "));
	});

	test("returns no usage limits when the plan does not expose them", () => {
		assert.deepStrictEqual(buildClaudeUsageLimits(undefined), []);
		const apiKeySnapshot = {
			subscription_type: null,
			rate_limits_available: false,
			rate_limits: null,
		} as unknown as UsageSnapshot;
		assert.deepStrictEqual(buildClaudeUsageLimits(apiKeySnapshot), []);
	});

	test("advertises native thinking effort choices for Claude models", () => {
		const opus = createClaudeReasoningConfigurationSchema("claude-opus-5", "max") as {
			properties: { reasoningEffort: { enum: string[]; default: string } };
		};
		assert.deepStrictEqual(opus.properties.reasoningEffort.enum, ["low", "medium", "high", "xhigh", "max"]);
		assert.strictEqual(opus.properties.reasoningEffort.default, "max");
	});

	test("caps observed Claude context at the configured maximum", () => {
		assert.strictEqual(resolveClaudeContextLength(258_400, 1_000_000), 258_400);
		assert.strictEqual(resolveClaudeContextLength(524_288, 200_000), 200_000);
		assert.strictEqual(resolveClaudeContextLength(131_072), 131_072);
	});

	test("marks every Claude profile unavailable when the common 5-hour window is exhausted", () => {
		const snapshot = usageSnapshot({
			five_hour: { utilization: 100, resets_at: "2026-07-19T10:50:00Z" },
			seven_day: { utilization: 19, resets_at: "2026-07-21T23:00:00Z" },
		});
		for (const model of CLAUDE_SUBSCRIPTION_MODELS) {
			const availability = availabilityFor(model.id, snapshot);
			assert.strictEqual(availability.state, "unavailable", model.id);
			assert.ok(availability.reason.includes("5-hour limit 100%"));
			assert.strictEqual(availability.unavailableUntil, "2026-07-19T10:50:00.000Z");
		}
	});

	test("keeps allowed_warning advisory and blocks only a rejected runtime status", () => {
		const snapshot = usageSnapshot({
			five_hour: { utilization: 93, resets_at: "2026-07-19T10:50:00Z" },
			seven_day: { utilization: 19, resets_at: "2026-07-21T23:00:00Z" },
		});
		const resetsAt = Date.parse("2026-07-19T10:50:00Z") / 1000;
		const warning = buildClaudeModelAvailability(
			"claude-opus-5",
			snapshot,
			AVAILABILITY_NOW,
			{ status: "allowed_warning", resetsAt, utilization: 0.93 },
			AVAILABILITY_NOW,
			AVAILABILITY_NOW
		);
		assert.strictEqual(warning.state, "available");
		assert.ok(warning.reason.includes("5-hour 93%"));

		const rejected = buildClaudeModelAvailability(
			"claude-opus-5",
			snapshot,
			AVAILABILITY_NOW,
			{ status: "rejected", resetsAt, utilization: 1 },
			AVAILABILITY_NOW,
			AVAILABILITY_NOW
		);
		assert.strictEqual(rejected.state, "unavailable");
		assert.strictEqual(rejected.reason, "Claude runtime reports rejected");
		assert.strictEqual(rejected.unavailableUntil, "2026-07-19T10:50:00.000Z");
	});

	test("applies Opus-specific windows and ignores removed model families", () => {
		const base = {
			five_hour: { utilization: 20, resets_at: "2026-07-19T10:50:00Z" },
			seven_day: { utilization: 19, resets_at: "2026-07-21T23:00:00Z" },
		};
		const weeklyOpus = usageSnapshot({
			...base,
			seven_day_opus: { utilization: 100, resets_at: "2026-07-22T23:00:00Z" },
		});
		assert.strictEqual(availabilityFor("claude-opus-5", weeklyOpus).state, "unavailable");

		const scopedOpus = usageSnapshot({
			...base,
			model_scoped: [{ display_name: "Opus 5", utilization: 100, resets_at: "2026-07-22T23:00:00Z" }],
		});
		assert.strictEqual(availabilityFor("claude-opus-5", scopedOpus).state, "unavailable");

		const removedFamily = usageSnapshot({
			...base,
			model_scoped: [{ display_name: "Fable", utilization: 100, resets_at: "2026-07-22T23:00:00Z" }],
		});
		assert.strictEqual(availabilityFor("claude-opus-5", removedFamily).state, "available");
	});

	test("does not block on ambiguous scoped labels, stale snapshots, or an expired full window", () => {
		const ambiguous = usageSnapshot({
			five_hour: { utilization: 20, resets_at: "2026-07-19T10:50:00Z" },
			seven_day: { utilization: 19, resets_at: "2026-07-21T23:00:00Z" },
			model_scoped: [{ display_name: "Premium Fable models", utilization: 100, resets_at: "2026-07-22T23:00:00Z" }],
		});
		assert.strictEqual(availabilityFor("claude-opus-5", ambiguous).state, "available");

		const stale = buildClaudeModelAvailability(
			"claude-opus-5",
			ambiguous,
			AVAILABILITY_NOW - 180_000,
			undefined,
			undefined,
			AVAILABILITY_NOW
		);
		assert.strictEqual(stale.state, "unknown");

		const expired = usageSnapshot({
			five_hour: { utilization: 100, resets_at: "2026-07-19T08:59:00Z" },
			seven_day: { utilization: 19, resets_at: "2026-07-21T23:00:00Z" },
		});
		assert.strictEqual(availabilityFor("claude-opus-5", expired).state, "unknown");
	});

	test("keeps Claude available after subscription exhaustion when paid extra usage has capacity", () => {
		const snapshot = usageSnapshot({
			five_hour: { utilization: 100, resets_at: "2026-07-19T10:50:00Z" },
			seven_day: { utilization: 19, resets_at: "2026-07-21T23:00:00Z" },
			extra_usage: { is_enabled: true, utilization: 25 },
		});
		const availability = availabilityFor("claude-opus-5", snapshot);
		assert.strictEqual(availability.state, "available");
		assert.ok(availability.reason.includes("paid extra usage is enabled"));
	});
});
