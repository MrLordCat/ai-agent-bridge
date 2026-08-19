import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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
	classifyClaudeResumeFailure,
	createClaudeKeepAliveMessage,
	createClaudeReasoningConfigurationSchema,
	createLatestUserMessage,
	estimateClaudeRecoveryTokens,
	findLatestPersistedClaudeConversation,
	truncateLatestUserContent,
	findPersistedClaudeConversation,
	extractFollowUpUserText,
	resolveClaudeResumeFallbackDecision,
	resolveClaudeSafetySettings,
	resolveClaudeInitialInputChars,
	resolveClaudeContextLength,
	resolveClaudeCacheKeepAliveDecision,
	resolveClaudeRuntimeModel,
} from "../claude/claude-provider";
import { buildClaudeModelAvailability } from "../claude/availability";
import {
	CLAUDE_ACTIVE_TURN_TIMEOUT_MS,
	ClaudeAgentSession,
	ClaudeAssistantCheckpointTracker,
	classifyClaudeResumeBoundary,
	createClaudeNativeContextUsage,
	createClaudeNativeUsage,
	hasClaudeAccountEvidence,
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

suite("Claude account evidence", () => {
        test("detects Claude Code login evidence in a temp home", () => {
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-auth-"));
                try {
                        // No files: no evidence.
                        assert.strictEqual(hasClaudeAccountEvidence(dir), false);

                        // ~/.claude/.credentials.json with a token: signed in.
                        fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
                        fs.writeFileSync(path.join(dir, ".claude", ".credentials.json"), '{"token":"x"}');
                        assert.strictEqual(hasClaudeAccountEvidence(dir), true);

                        // Empty credentials file: not evidence.
                        fs.writeFileSync(path.join(dir, ".claude", ".credentials.json"), '{}');
                        assert.strictEqual(hasClaudeAccountEvidence(dir), false);

                        // ~/.claude.json with oauthAccount.accountUuid: signed in.
                        fs.writeFileSync(
                                path.join(dir, ".claude.json"),
                                JSON.stringify({ oauthAccount: { accountUuid: "uuid-1" }, machineID: "m" })
                        );
                        assert.strictEqual(hasClaudeAccountEvidence(dir), true);

                        // ~/.claude.json without oauthAccount: not evidence.
                        fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ machineID: "m" }));
                        assert.strictEqual(hasClaudeAccountEvidence(dir), false);

                        // Invalid JSON: not evidence (no throw).
                        fs.writeFileSync(path.join(dir, ".claude.json"), "{broken");
                        assert.strictEqual(hasClaudeAccountEvidence(dir), false);
                } finally {
                        fs.rmSync(dir, { recursive: true, force: true });
                }
        });
});

suite("Claude subscription provider", () => {
	test("fails safe and explains why Claude cache keep-alive is paused", () => {
		const now = Date.parse("2026-08-02T10:00:00Z");
		const common = { enabled: true, now, intervalMs: 45 * 60_000, sessions: [] };
		assert.strictEqual(resolveClaudeCacheKeepAliveDecision(common).state, "paused_usage_unknown");
		assert.strictEqual(resolveClaudeCacheKeepAliveDecision({
			...common, usagePercent: 20, usageSnapshotAgeMs: 700_000,
		}).state, "paused_usage_stale");
		assert.strictEqual(resolveClaudeCacheKeepAliveDecision({
			...common, usagePercent: 90, usageSnapshotAgeMs: 1_000,
		}).state, "paused_usage_limit");
		const noSession = resolveClaudeCacheKeepAliveDecision({
			...common, usagePercent: 20, usageSnapshotAgeMs: 1_000,
		});
		assert.strictEqual(noSession.state, "no_eligible_session");
		assert.ok(noSession.reason.includes("Run one Claude turn after reload"));
	});

	test("schedules keep-alive and selects the largest eligible Claude prefix", () => {
		const now = Date.parse("2026-08-02T10:00:00Z");
		const intervalMs = 45 * 60_000;
		const sessions = [{
			healthy: true, busy: false, prefixTokens: 120_000, lastUsedAt: now - intervalMs,
		}, {
			healthy: true, busy: false, prefixTokens: 280_000, lastUsedAt: now - intervalMs,
		}];
		const ready = resolveClaudeCacheKeepAliveDecision({
			enabled: true, now, intervalMs, usagePercent: 42, usageSnapshotAgeMs: 1_000, sessions,
		});
		assert.strictEqual(ready.state, "ready");
		assert.strictEqual(ready.candidateIndex, 1);
		assert.strictEqual(ready.eligibleSessionCount, 2);

		const waiting = resolveClaudeCacheKeepAliveDecision({
			enabled: true,
			now,
			intervalMs,
			usagePercent: 42,
			usageSnapshotAgeMs: 1_000,
			sessions: [{ ...sessions[1], lastUsedAt: now - 60_000 }],
		});
		assert.strictEqual(waiting.state, "waiting");
		assert.ok((waiting.nextAttemptAt ?? 0) > now);

		const throttled = resolveClaudeCacheKeepAliveDecision({
			enabled: true,
			now,
			intervalMs,
			usagePercent: 42,
			usageSnapshotAgeMs: 1_000,
			sessions: [{ ...sessions[1], lastAttemptAt: now - 60_000 }],
		});
		assert.strictEqual(throttled.state, "waiting");
	});

	test("uses conservative Claude safety defaults and clamps invalid values", () => {
		assert.deepStrictEqual(resolveClaudeSafetySettings({}), {
			maxAgentTurns: 0,
			maxCumulativeInputTokens: 10_000_000,
			resumeFallbackPolicy: "safe",
			resumeFallbackMaxInputTokens: 64_000,
			resumeFallbackMaxUsagePercent: 80,
		});
		assert.deepStrictEqual(resolveClaudeSafetySettings({
			maxAgentTurns: 0,
			maxCumulativeInputTokens: 1,
			resumeFallbackPolicy: "invalid",
			resumeFallbackMaxInputTokens: -1,
			resumeFallbackMaxUsagePercent: 101,
		}), {
			maxAgentTurns: 0,
			maxCumulativeInputTokens: 100_000,
			resumeFallbackPolicy: "safe",
			resumeFallbackMaxInputTokens: 0,
			resumeFallbackMaxUsagePercent: 100,
		});
	});

	test("blocks unsafe Claude cold replay and allows only fresh low-cost fallback", () => {
		assert.strictEqual(resolveClaudeResumeFallbackDecision({
			policy: "safe", estimatedInputTokens: 71_666, maxInputTokens: 64_000,
			usagePercent: 20, usageSnapshotAgeMs: 1_000, maxUsagePercent: 80,
		}).reason, "input_limit");
		assert.strictEqual(resolveClaudeResumeFallbackDecision({
			policy: "safe", estimatedInputTokens: 32_000, maxInputTokens: 64_000,
			maxUsagePercent: 80,
		}).reason, "usage_unknown");
		assert.strictEqual(resolveClaudeResumeFallbackDecision({
			policy: "safe", estimatedInputTokens: 32_000, maxInputTokens: 64_000,
			usagePercent: 20, usageSnapshotAgeMs: 700_000, maxUsagePercent: 80,
		}).reason, "usage_stale");
		assert.strictEqual(resolveClaudeResumeFallbackDecision({
			policy: "safe", estimatedInputTokens: 32_000, maxInputTokens: 64_000,
			usagePercent: 80, usageSnapshotAgeMs: 1_000, maxUsagePercent: 80,
		}).reason, "usage_limit");
		assert.deepStrictEqual(resolveClaudeResumeFallbackDecision({
			policy: "safe", estimatedInputTokens: 32_000, maxInputTokens: 64_000,
			usagePercent: 50, usageSnapshotAgeMs: 1_000, maxUsagePercent: 80,
		}).allowed, true);
		assert.strictEqual(resolveClaudeResumeFallbackDecision({
			policy: "never", estimatedInputTokens: 1, maxInputTokens: 64_000,
			usagePercent: 1, usageSnapshotAgeMs: 1, maxUsagePercent: 80,
		}).reason, "policy_never");
		assert.deepStrictEqual(resolveClaudeResumeFallbackDecision({
			policy: "always", estimatedInputTokens: 500_000, maxInputTokens: 64_000,
			maxUsagePercent: 80,
		}).allowed, true);
	});

	test("classifies the original durable resume failure for live diagnostics", () => {
		assert.deepStrictEqual(
			classifyClaudeResumeFailure(new Error("Claude Agent SDK stream closed unexpectedly")),
			{
				reason: "stream_closed",
				stage: "sdk_resume",
				detail: "Claude Agent SDK stream closed unexpectedly",
			}
		);
		assert.strictEqual(
			classifyClaudeResumeFailure(new Error("Invalid resumeSessionAt message UUID")).reason,
			"invalid_resume_boundary"
		);
		assert.strictEqual(
			classifyClaudeResumeFailure(new Error("Claude API error: rate_limit (429)")).reason,
			"rate_limit"
		);
		assert.strictEqual(
			classifyClaudeResumeFailure(new Error("Claude produced no activity for 90 seconds")).reason,
			"timeout"
		);
	});

	test("extracts a brand-new user message from a tool continuation", () => {
	const toolResult = new vscode.LanguageModelToolResultPart(
		"call-1",
		[{ content: [new vscode.LanguageModelTextPart("tool output")] }]
	);
	const toolMessage = {
		role: vscode.LanguageModelChatMessageRole.User,
		name: "tool-result",
		content: [toolResult],
	};
	const freshMessage = {
		role: vscode.LanguageModelChatMessageRole.User,
		name: "user",
		content: [new vscode.LanguageModelTextPart("Stop and switch to the tower 3D task")],
	};
	assert.strictEqual(
		extractFollowUpUserText([toolMessage, freshMessage]),
		"Stop and switch to the tower 3D task"
	);
	// Pure tool continuation: no follow-up text.
	assert.strictEqual(extractFollowUpUserText([toolMessage]), undefined);
	// Older user text must not be mistaken for a follow-up.
	const oldUser = {
		role: vscode.LanguageModelChatMessageRole.User,
		name: "user",
		content: [new vscode.LanguageModelTextPart("old task")],
	};
	assert.strictEqual(extractFollowUpUserText([oldUser, toolMessage]), undefined);
});

test("advances Claude resume checkpoints only after a logical turn completes", () => {
		const tracker = new ClaudeAssistantCheckpointTracker();
		tracker.recordFragment("thinking-fragment");
		tracker.recordFragment("tool-use-fragment");
		assert.strictEqual(tracker.stableFragmentId, undefined);

		assert.strictEqual(tracker.completeLogicalTurn(), "tool-use-fragment");
		tracker.recordFragment("next-turn-thinking");
		assert.strictEqual(tracker.stableFragmentId, "tool-use-fragment");
	});

	test("rejects an incomplete tool-use fragment as a Claude resume boundary", () => {
		assert.strictEqual(classifyClaudeResumeBoundary({
			type: "assistant",
			message: {
				role: "assistant",
				stop_reason: "tool_use",
				content: [{ type: "thinking", thinking: "" }],
			},
		}), "boundary_incomplete");
		assert.strictEqual(classifyClaudeResumeBoundary({
			type: "assistant",
			message: {
				role: "assistant",
				stop_reason: "end_turn",
				content: [{ type: "text", text: "done" }],
			},
		}), "ok");
	});

	test("uses a conservative Claude recovery estimate", () => {
		assert.strictEqual(estimateClaudeRecoveryTokens(4_000, 12_000), 48_000);
		assert.strictEqual(estimateClaudeRecoveryTokens(0, 0), 16_000);
	});

	test("allows only tools hosted by the native VS Code MCP server", () => {
		assert.strictEqual(isClaudeVsCodeToolName("mcp__vscode__read_file"), true);
		assert.strictEqual(isClaudeVsCodeToolName("Read"), false);
		assert.strictEqual(isClaudeVsCodeToolName("Bash"), false);
		assert.strictEqual(isClaudeVsCodeToolName("mcp__other__write_file"), false);
	});

	test("keeps the Claude activity watchdog tolerant of slow xhigh turns and long tools", () => {
	// The observed live failure: an Opus xhigh chain resumed warm, called four
	// tools (4.2 min of tool execution), and still died with "no activity for
	// 90 seconds" between model segments. The watchdog must outlast both a
	// slow first token (measured up to ~110s) and in-flight VS Code tools.
	assert.ok(
		CLAUDE_ACTIVE_TURN_TIMEOUT_MS >= 300_000,
		"watchdog must tolerate multi-minute xhigh reasoning and tool execution"
	);
});

test("marks the session stream as closed after an interrupt", async () => {
		const session = new ClaudeAgentSession({
			model: "claude-opus-5[1m]",
			cwd: ".",
			executable: "claude",
			extensionVersion: "test",
			tools: [],
			callbacks: {
				onUsage: () => undefined,
				onRateLimit: () => undefined,
			},
		});
		assert.strictEqual(session.isStreamHealthy, true);
		assert.strictEqual(session.hasActiveTurn, false);
		await session.interrupt();
		// Per the Agent SDK the query stream ends after an interrupt, so the
		// session must never be warm-reused afterwards (follow-up bug).
		assert.strictEqual(session.isStreamHealthy, false);
		session.dispose();
		assert.strictEqual(session.isStreamHealthy, false);
	});

	test("builds a minimal keep-alive message that forbids tool use", () => {
		const message = createClaudeKeepAliveMessage();
		const content = message.message.content as Array<{ type: string; text?: string }>;
		assert.ok(Array.isArray(content));
		const text = content
			.filter(part => part.type === "text")
			.map(part => part.text ?? "")
			.join(" ");
		assert.ok(/keep-alive/i.test(text));
		assert.ok(/exactly: ok/.test(text));
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

	test("emits native Claude usage on every completed response boundary", () => {
		const parts: vscode.LanguageModelResponsePart[] = [
			new vscode.LanguageModelToolCallPart("call-1", "read_file", { path: "README.md" }),
		];
		let resolved = false;
		const session = new ClaudeAgentSession({
			model: "claude-opus-5",
			cwd: process.cwd(),
			executable: "claude",
			extensionVersion: "1.9.1",
			tools: [],
			callbacks: {
				onUsage: () => undefined,
				onRateLimit: () => undefined,
			},
		});
		const timeout = setTimeout(() => undefined, 10_000);
		const internals = session as unknown as {
			logicalTurn: unknown;
			activeTurn: unknown;
			completeActiveTurn(): void;
		};
		internals.logicalTurn = {
			requestId: "request-1",
			startedAt: Date.now() - 100,
			context: {
				sessionMode: "warm",
				inputMode: "user-turn",
				messageCount: 2,
				toolCount: 1,
				toolSchemaTokens: 10,
			},
			outputChars: 0,
			thinkingChars: 0,
			usageSegments: new Map([[
				"segment-1",
				{
					id: "segment-1",
					index: 1,
					recordedAt: "2026-07-29T16:38:39.649Z",
					freshInputTokens: 2,
					cacheReadInputTokens: 65_987,
					cacheCreationInputTokens: 5_804,
					inputTokens: 71_793,
					outputTokens: 4,
					thinkingTokens: 0,
					totalTokens: 71_797,
					cacheHitPercent: 91.9,
				},
			]]),
			steps: new Map(),
			terminal: false,
		};
		internals.activeTurn = {
			progress: { report: (part: vscode.LanguageModelResponsePart) => parts.push(part) },
			resolve: () => { resolved = true; },
			reject: () => undefined,
			cancellation: new vscode.Disposable(() => undefined),
			timeout,
			settled: false,
			partialTextSeen: false,
			partialThinkingSeen: false,
			reportedTextChars: 0,
		};

		internals.completeActiveTurn();

		assert.strictEqual(resolved, true);
		assert.ok(parts[0] instanceof vscode.LanguageModelToolCallPart);
		assert.ok(parts[1] instanceof vscode.LanguageModelDataPart);
		const usagePart = parts[1] as vscode.LanguageModelDataPart;
		assert.strictEqual(usagePart.mimeType, "usage");
		assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(usagePart.data)), {
			prompt_tokens: 71_793,
			completion_tokens: 4,
			total_tokens: 71_797,
			prompt_tokens_details: { cached_tokens: 65_987 },
		});
		session.dispose();
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

	test("restores an advanced Claude conversation across runtime drift", () => {
		const entry = {
			conversationId: "conversation-1",
			sdkSessionId: "11111111-1111-4111-8111-111111111111",
			modelId: "claude-opus-5",
			runtimeKey: "runtime-a",
			copilotTurnIndex: 10,
			userSignatures: ["user-a"],
			lastUsedAt: AVAILABILITY_NOW - 60_000,
		};
		assert.strictEqual(findPersistedClaudeConversation([entry], {
			conversationId: "conversation-1",
			modelId: "claude-opus-5",
			runtimeKey: "runtime-a",
			copilotTurnIndex: 11,
			userSignatures: ["user-a", "user-b"],
			now: AVAILABILITY_NOW,
		})?.sdkSessionId, entry.sdkSessionId);
		assert.strictEqual(findPersistedClaudeConversation([entry], {
			conversationId: "conversation-1",
			modelId: "claude-opus-5",
			runtimeKey: "runtime-b",
			copilotTurnIndex: 11,
			userSignatures: ["user-a", "user-b"],
			now: AVAILABILITY_NOW,
		})?.sdkSessionId, entry.sdkSessionId);
		assert.strictEqual(findPersistedClaudeConversation([entry], {
			conversationId: "conversation-1",
			modelId: "claude-opus-5",
			runtimeKey: "runtime-a",
			copilotTurnIndex: 10,
			userSignatures: ["user-a", "user-b"],
			now: AVAILABILITY_NOW,
		})?.sdkSessionId, entry.sdkSessionId);
		assert.strictEqual(findPersistedClaudeConversation([{ ...entry, lastUsedAt: AVAILABILITY_NOW - 8 * 24 * 60 * 60_000 }], {
			conversationId: "conversation-1",
			modelId: "claude-opus-5",
			runtimeKey: "runtime-a",
			copilotTurnIndex: 11,
			userSignatures: ["user-a", "user-b"],
			now: AVAILABILITY_NOW,
		}), undefined);
		assert.strictEqual(findPersistedClaudeConversation([{
			...entry,
			quarantinedAt: AVAILABILITY_NOW - 1_000,
			quarantineReason: "timeout:no activity",
		}], {
			conversationId: "conversation-1",
			modelId: "claude-opus-5",
			runtimeKey: "runtime-a",
			copilotTurnIndex: 11,
			userSignatures: ["user-a", "user-b"],
			now: AVAILABILITY_NOW,
		}), undefined);
		assert.strictEqual(findPersistedClaudeConversation([{ ...entry, copilotTurnIndex: undefined }], {
			conversationId: "conversation-1",
			modelId: "claude-opus-5",
			runtimeKey: "runtime-b",
			userSignatures: ["rewritten-a", "user-b"],
			now: AVAILABILITY_NOW,
		})?.sdkSessionId, entry.sdkSessionId);
		assert.strictEqual(findPersistedClaudeConversation([{
			...entry,
			copilotTurnIndex: undefined,
			userSignatures: ["old-a", "old-b", "old-c"],
		}], {
			conversationId: "conversation-1",
			modelId: "claude-opus-5",
			runtimeKey: "runtime-b",
			copilotTurnIndex: 20,
			userSignatures: ["rewritten-a"],
			now: AVAILABILITY_NOW,
		})?.sdkSessionId, entry.sdkSessionId);
		// A mid-turn notification or retry resends the same copilotTurnIndex
		// with a truncated/rewritten transcript (fewer signatures). It must
		// still restore the persisted session instead of cold-replaying the
		// whole chat — the exact conversationId pins the record to this chat.
		assert.strictEqual(findPersistedClaudeConversation([{
			...entry,
			copilotTurnIndex: 29,
			userSignatures: ["sig-1", "sig-2", "sig-3", "sig-4"],
		}], {
			conversationId: "conversation-1",
			modelId: "claude-opus-5",
			runtimeKey: "runtime-a",
			copilotTurnIndex: 29,
			userSignatures: ["sig-1"],
			now: AVAILABILITY_NOW,
		})?.sdkSessionId, entry.sdkSessionId);
		assert.strictEqual(findPersistedClaudeConversation([{ ...entry, copilotTurnIndex: 30 }], {
			conversationId: "conversation-1",
			modelId: "claude-opus-5",
			runtimeKey: "runtime-a",
			copilotTurnIndex: 29,
			userSignatures: ["user-a", "user-b"],
			now: AVAILABILITY_NOW,
		})?.sdkSessionId, entry.sdkSessionId);
		assert.strictEqual(findPersistedClaudeConversation([{
			...entry,
			copilotTurnIndex: undefined,
		}], {
			conversationId: "conversation-1",
			modelId: "claude-opus-5",
			runtimeKey: "runtime-b",
			copilotTurnIndex: 20,
			userSignatures: ["user-a"],
			now: AVAILABILITY_NOW,
		})?.sdkSessionId, entry.sdkSessionId);
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
			findLatestPersistedClaudeConversation([
				stale,
				older,
				{ ...newest, quarantinedAt: AVAILABILITY_NOW - 1_000 },
			], AVAILABILITY_NOW)?.conversationId,
			"older"
		);
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

	test("skips orphan tool-result tails when building the latest user message", () => {
		// VS Code can deliver an already-executed tool result after the user
		// stopped the turn; the provider then restores the session and must
		// append the user's real task, not a JSON blob of the tool result.
		const messages = [
			vscode.LanguageModelChatMessage.User("old task"),
			vscode.LanguageModelChatMessage.Assistant("done"),
			vscode.LanguageModelChatMessage.User("new task: move the tower"),
			vscode.LanguageModelChatMessage.Assistant("ok"),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart("call-1", [
					new vscode.LanguageModelTextPart("file content"),
				]),
			]),
		];
		const built = createLatestUserMessage(messages);
		const content = built.message.content as Array<{ type: string; text?: string }>;

		assert.strictEqual(content.length, 1);
		assert.strictEqual(content[0].type, "text");
		assert.ok(content[0].text?.includes("new task: move the tower"));
		assert.ok(!content[0].text?.includes("file content"));
	});

	test("prefers the latest focused user message over a trailing transcript-sized one", () => {
		// Regression for the 2026-08-15 Agents Window failure: the trailing user
		// message can be a whole-transcript blob (~45K tokens) with no question in
		// it. The recovery must pick the user's actual short follow-up instead.
		const messages = [
			vscode.LanguageModelChatMessage.User("old task"),
			vscode.LanguageModelChatMessage.Assistant("done"),
			vscode.LanguageModelChatMessage.User("fix the failing test please"),
			vscode.LanguageModelChatMessage.Assistant("ok"),
			vscode.LanguageModelChatMessage.User("TRANSCRIPT-FILLER".repeat(1_000)),
		];
		const built = createLatestUserMessage(messages);
		const content = built.message.content as Array<{ type: string; text?: string }>;

		assert.strictEqual(content.length, 1);
		assert.strictEqual(content[0].text, "fix the failing test please");
	});

	test("falls back to Continue when the tail has no real user content", () => {
		const built = createLatestUserMessage([
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart("call-1", [
					new vscode.LanguageModelTextPart("result"),
				]),
			]),
		]);
		const content = built.message.content as Array<{ type: string; text?: string }>;

		assert.strictEqual(content.length, 1);
		assert.strictEqual(content[0].type, "text");
		assert.strictEqual(content[0].text, "Continue.");
	});

	test("truncates an oversized latest user message to fit the token budget, keeping the tail", () => {
		// Regression for the 2026-08-15 production failure: the last user message
		// in an Agents Window transcript can carry the whole conversation
		// (~178K tokens), so the latest-only recovery was blocked instead of
		// sending a bounded tail.
		const tailMarker = "ANSWER-THIS-FRESH-QUESTION";
		const oversized = [
			{ type: "text", text: "history-filler".repeat(60_000) + tailMarker },
		];
		const before = estimateClaudeTokens(JSON.stringify(oversized));
		assert.ok(before > 64_000, `expected an oversized message, got ${before} tokens`);
		const result = truncateLatestUserContent(oversized, 64_000);
		const after = estimateClaudeTokens(JSON.stringify(result.content));
		assert.ok(after <= 64_000, `truncated content must fit the budget: ${after}`);
		assert.ok(result.truncatedChars > 0);
		const text = (result.content.find(part => part.type === "text") as { text: string }).text;
		assert.ok(text.endsWith(tailMarker), "the fresh tail of the message must be preserved");
		assert.ok(text.length < (oversized[0] as { text: string }).text.length, "the message must actually be shortened");
	});

	test("keeps an undersized latest user message unchanged", () => {
		const content = [{ type: "text", text: "small question" }];
		const result = truncateLatestUserContent(content, 64_000);
		assert.deepStrictEqual(result.content, content);
		assert.strictEqual(result.truncatedChars, 0);
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
		assert.strictEqual(resolveClaudeContextLength(131_072), 258_400);
		assert.strictEqual(resolveClaudeContextLength(1_048_576), 967_000);
	});

	test("selects the real Claude 1M runtime and scales cold-start history", () => {
		assert.strictEqual(resolveClaudeRuntimeModel("claude-opus-5"), "claude-opus-5[1m]");
		assert.strictEqual(resolveClaudeRuntimeModel("claude-opus-5[1m]"), "claude-opus-5[1m]");
		assert.strictEqual(resolveClaudeInitialInputChars(4_000_000, 258_400), 777_600);
		assert.strictEqual(resolveClaudeInitialInputChars(4_000_000, 967_000), 3_558_560);
		assert.strictEqual(resolveClaudeInitialInputChars(300_000, 967_000), 300_000);
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
