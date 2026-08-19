import * as assert from "assert";
import {
	buildCacheDiagnostics,
	classifyCodexTurnCache,
	normalizeSystemDate,
	normalizeVolatileHostContext,
	promptCacheUsageFromCacheReads,
} from "../context/cache-diagnostics";
import { calculatePromptCacheUsage, estimateChatTokenUsage, mergeChatTokenUsage, normalizeChatTokenUsage } from "../context/usage";

suite("chat token usage", () => {
	test("normalizes server usage and cached prompt tokens", () => {
		assert.deepStrictEqual(normalizeChatTokenUsage({
			prompt_tokens: 14.9,
			completion_tokens: 2,
			total_tokens: 16.9,
			prompt_tokens_details: { cached_tokens: 13.8 },
		}), {
			prompt_tokens: 14,
			completion_tokens: 2,
			total_tokens: 16,
			prompt_tokens_details: { cached_tokens: 13 },
		});
	});

	test("rejects incomplete usage objects", () => {
		assert.strictEqual(normalizeChatTokenUsage({ prompt_tokens: 10 }), undefined);
		assert.strictEqual(normalizeChatTokenUsage(null), undefined);
	});

	test("normalizes DeepSeek cache counters and calculates the hit rate", () => {
		const usage = normalizeChatTokenUsage({
			prompt_tokens: 100,
			completion_tokens: 20,
			total_tokens: 120,
			prompt_cache_hit_tokens: 75,
			prompt_cache_miss_tokens: 25,
		});

		assert.deepStrictEqual(usage?.prompt_tokens_details, { cached_tokens: 75 });
		assert.deepStrictEqual(usage && calculatePromptCacheUsage(usage), {
			promptTokens: 100,
			cachedTokens: 75,
			uncachedTokens: 25,
			hitPercent: 75,
		});
	});

	test("estimates completion usage when the server omits it", () => {
		assert.deepStrictEqual(estimateChatTokenUsage(100, 17), {
			prompt_tokens: 100,
			completion_tokens: 5,
			total_tokens: 105,
		});
	});

	test("merges usage across internal model turns without inventing cache telemetry", () => {
		assert.deepStrictEqual(mergeChatTokenUsage(
			{ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 80 } },
			{ prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, prompt_tokens_details: { cached_tokens: 45 } }
		), {
			prompt_tokens: 150,
			completion_tokens: 30,
			total_tokens: 180,
			prompt_tokens_details: { cached_tokens: 125 },
		});
		assert.strictEqual(mergeChatTokenUsage(
			{ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
			{ prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, prompt_tokens_details: { cached_tokens: 45 } }
		).prompt_tokens_details, undefined);
	});
});

suite("prompt cache diagnostics", () => {
	const usage = (promptTokens: number, cachedTokens: number) => ({
		promptTokens,
		cachedTokens,
		uncachedTokens: promptTokens - cachedTokens,
		hitPercent: Number(((cachedTokens / promptTokens) * 100).toFixed(1)),
	});
	const base = { provider: "deepseek", modelId: "deepseek-v4-pro", requestId: "req-1" };

	test("stays silent when the prompt was mostly served from cache", () => {
		const report = buildCacheDiagnostics({ ...base, usage: usage(100_000, 99_000) });
		assert.strictEqual(report.reason, "healthy");
		assert.strictEqual(report.missPercent, 1);
	});

	test("reports a partial upstream cache when an anomalous miss coincides with a route change", () => {
		const report = buildCacheDiagnostics({
			...base,
			// Real turn 54: only ~810 prompt tokens were appended, but 18,614
			// tokens missed immediately after CloudFront changed route.
			usage: usage(186_806, 168_192),
			prefix: {
				previousRequestId: "req-0",
				staticFieldsMatch: true,
				toolsMatch: true,
				identicalMessagePrefix: 220,
				messageCount: 222,
				previousMessageCount: 220,
			},
			backend: {
				previousPromptTokens: 185_996,
				previousVia: "1.1 edb62db.cloudfront.net",
				currentVia: "1.1 d6095b.cloudfront.net",
				previousCfPop: "HEL51-P7",
				currentCfPop: "HEL51-P1",
			},
		});
		assert.strictEqual(report.reason, "upstream_cache_partial");
		assert.ok(report.detail.includes("18,614"));
		assert.ok(report.detail.includes("HEL51-P7"));
		assert.ok(report.detail.includes("HEL51-P1"));
		assert.ok(report.detail.includes("coincided"));
	});

	test("cloudflare partial miss explains instance pinning and model support", () => {
		const report = buildCacheDiagnostics({
			provider: "cloudflare",
			modelId: "@cf/deepseek-ai/deepseek-v4-pro-0813",
			requestId: "req-2",
			usage: usage(126_436, 0),
			prefix: {
				previousRequestId: "req-1",
				staticFieldsMatch: true,
				toolsMatch: true,
				identicalMessagePrefix: 210,
				messageCount: 212,
				previousMessageCount: 210,
			},
			backend: { previousPromptTokens: 124_913 },
		});
		assert.strictEqual(report.reason, "upstream_cache_partial");
		assert.ok(report.detail.includes("x-session-affinity"), "must mention instance pinning");
		assert.ok(report.detail.includes("model to support it"), "must mention model support");
	});

	test("does not blame a route change when uncached tokens are explained by the new tail", () => {
		const report = buildCacheDiagnostics({
			...base,
			// Real turn 56: route changed, but only 489 tokens missed while the
			// prompt grew by 645 tokens. This is a healthy new tail.
			usage: usage(188_009, 187_520),
			prefix: {
				previousRequestId: "req-0",
				staticFieldsMatch: true,
				toolsMatch: true,
				identicalMessagePrefix: 224,
				messageCount: 226,
				previousMessageCount: 224,
			},
			backend: {
				previousPromptTokens: 187_364,
				previousVia: "1.1 d6095b.cloudfront.net",
				currentVia: "1.1 b786785.cloudfront.net",
				previousCfPop: "HEL51-P1",
				currentCfPop: "HEL51-P4",
			},
		});
		assert.strictEqual(report.reason, "healthy");
	});

	test("classifies turn 57 and same-route anomalies as partial upstream cache", () => {
		const input = {
			...base,
			usage: usage(189_706, 163_840),
			prefix: {
				previousRequestId: "req-0",
				staticFieldsMatch: true,
				toolsMatch: true,
				identicalMessagePrefix: 226,
				messageCount: 229,
				previousMessageCount: 226,
			},
			backend: {
				previousPromptTokens: 188_009,
				previousVia: "1.1 b786785.cloudfront.net",
				currentVia: "1.1 11abd6.cloudfront.net",
				previousCfPop: "HEL51-P4",
				currentCfPop: "HEL51-P7",
			},
		};
		assert.strictEqual(buildCacheDiagnostics(input).reason, "upstream_cache_partial");

		assert.strictEqual(buildCacheDiagnostics({
			...input,
			backend: {
				...input.backend,
				previousVia: input.backend.currentVia,
				previousCfPop: input.backend.currentCfPop,
			},
		}).reason, "upstream_cache_partial");
	});

	test("names a first post-restart host-history rebuild separately", () => {
		const report = buildCacheDiagnostics({
			...base,
			usage: usage(255_550, 16_384),
			firstRequestSinceStartup: true,
			prefix: {
				previousRequestId: "req-before-reload",
				staticFieldsMatch: true,
				toolsMatch: true,
				identicalMessagePrefix: 1,
				messageCount: 287,
				previousMessageCount: 197,
			},
		});
		assert.strictEqual(report.reason, "history_rebuilt_after_restart");
		assert.ok(report.detail.includes("first request"));
		assert.ok(report.detail.includes("197"));
		assert.ok(report.detail.includes("287"));
	});

	test("keeps a small loss of the prior prefix healthy", () => {
		const report = buildCacheDiagnostics({
			...base,
			usage: usage(257_154, 248_320),
			prefix: {
				previousRequestId: "req-0",
				staticFieldsMatch: true,
				toolsMatch: true,
				identicalMessagePrefix: 289,
				messageCount: 291,
				previousMessageCount: 289,
			},
			backend: {
				previousPromptTokens: 256_461,
				previousVia: "same",
				currentVia: "same",
			},
		});
		assert.strictEqual(report.reason, "healthy");
	});

	test("marks a materially cold compacted prefix as pending despite a large new tail", () => {
		const report = buildCacheDiagnostics({
			...base,
			usage: usage(184_878, 124_544),
			previousTurnCompacted: true,
			prefix: {
				previousRequestId: "compact-turn",
				staticFieldsMatch: true,
				toolsMatch: true,
				identicalMessagePrefix: 171,
				messageCount: 173,
				previousMessageCount: 171,
			},
			backend: {
				previousPromptTokens: 164_674,
				previousVia: "same",
				currentVia: "same",
			},
		});
		assert.strictEqual(report.reason, "upstream_cache_pending");
	});

	test("catches the 4.98 percent post-compaction cache gap from the real session", () => {
		const report = buildCacheDiagnostics({
			...base,
			usage: usage(188_415, 177_024),
			previousTurnCompacted: true,
			prefix: {
				previousRequestId: "compact-turn",
				staticFieldsMatch: true,
				toolsMatch: true,
				identicalMessagePrefix: 228,
				messageCount: 230,
				previousMessageCount: 228,
			},
			backend: { previousPromptTokens: 186_310 },
		});
		assert.strictEqual(report.reason, "upstream_cache_pending");
	});

	test("keeps a large genuinely new tail healthy when prior-prefix loss is small", () => {
		const report = buildCacheDiagnostics({
			...base,
			usage: usage(213_128, 196_608),
			prefix: {
				previousRequestId: "req-0",
				staticFieldsMatch: true,
				toolsMatch: true,
				identicalMessagePrefix: 248,
				messageCount: 250,
				previousMessageCount: 248,
			},
			backend: { previousPromptTokens: 201_458 },
		});
		assert.strictEqual(report.reason, "healthy");
	});

	test("does not blame a tail-only guard for loss of the durable prefix", () => {
		const report = buildCacheDiagnostics({
			...base,
			usage: usage(200_000, 150_000),
			prefix: {
				previousRequestId: "req-0",
				staticFieldsMatch: true,
				toolsMatch: true,
				identicalMessagePrefix: 200,
				messageCount: 202,
				previousMessageCount: 200,
				ephemeralChanged: true,
				ephemeralChars: 8_000,
				previousEphemeralChars: 4_000,
			},
			backend: { previousPromptTokens: 198_000 },
		});
		assert.strictEqual(report.reason, "upstream_cache_partial");
		assert.match(report.detail, /cannot explain loss of previously cached tokens/);
	});

	test("names a rewritten history and points at the diverging message", () => {
		const report = buildCacheDiagnostics({
			...base,
			usage: usage(126_420, 14_464),
			prefix: {
				previousRequestId: "req-0",
				staticFieldsMatch: true,
				toolsMatch: true,
				identicalMessagePrefix: 2,
				messageCount: 417,
				previousMessageCount: 413,
			},
		});
		assert.strictEqual(report.reason, "history_rewritten");
		assert.ok(report.detail.includes("message 2 of 413"));
		assert.strictEqual(report.uncachedTokens, 111_956);
	});

	test("separates a changed tool catalog from changed request parameters", () => {
		assert.strictEqual(buildCacheDiagnostics({
			...base,
			usage: usage(1000, 10),
			prefix: { previousRequestId: "req-0", staticFieldsMatch: true, toolsMatch: false },
		}).reason, "tool_catalog_changed");

		assert.strictEqual(buildCacheDiagnostics({
			...base,
			usage: usage(1000, 10),
			prefix: { previousRequestId: "req-0", staticFieldsMatch: false, toolsMatch: true },
		}).reason, "request_params_changed");
	});

	test("classifies a midnight date rollover separately from a real system change", () => {
		// Only the Current date line differs → date_rollover, not a scary
		// system_prompt_changed.
		const rollover = buildCacheDiagnostics({
			...base,
			usage: usage(1000, 10),
			prefix: {
				previousRequestId: "req-0",
				staticFieldsMatch: true,
				toolsMatch: true,
				identicalMessagePrefix: 0,
				systemChanged: true,
				systemHashNormalized: "abc",
				previousSystemHashNormalized: "abc",
			},
		});
		assert.strictEqual(rollover.reason, "date_rollover");
		assert.ok(rollover.detail.includes("midnight"));

		// A real system change (normalized hashes differ) keeps the original
		// classification.
		assert.strictEqual(buildCacheDiagnostics({
			...base,
			usage: usage(1000, 10),
			prefix: {
				previousRequestId: "req-0",
				staticFieldsMatch: true,
				toolsMatch: true,
				identicalMessagePrefix: 0,
				systemChanged: true,
				systemHashNormalized: "abc",
				previousSystemHashNormalized: "def",
			},
		}).reason, "system_prompt_changed");
	});

	test("normalizes the date line in system prompts", () => {
		const before = 'You are a careful coding agent.\nCurrent date: 2026-08-06.\nCheck facts.';
		const after = 'You are a careful coding agent.\nCurrent date: 2026-08-07.\nCheck facts.';
		assert.strictEqual(normalizeSystemDate(before), normalizeSystemDate(after));
		assert.notStrictEqual(normalizeSystemDate(before), before);
	});

	test("masks host-regenerated context blocks", () => {
		const before = 'Fix the bug\n<workspace_info>\nsrc/a.ts\n</workspace_info>\n<context>\nTerminal: exit 0\n</context>';
		const after = 'Fix the bug\n<workspace_info>\nsrc/a.ts\nsnapshot.html\n</workspace_info>\n<context>\nTerminal: exit 1\n</context>';
		assert.strictEqual(normalizeVolatileHostContext(before), normalizeVolatileHostContext(after));
		assert.notStrictEqual(
			normalizeVolatileHostContext(before),
			normalizeVolatileHostContext('Ship the feature\n<workspace_info>\nsrc/a.ts\n</workspace_info>')
		);
	});

	test("reports a partial upstream cache for an unchanged direct-provider prefix", () => {
		const report = buildCacheDiagnostics({
			...base,
			usage: usage(1000, 10),
			prefix: {
				previousRequestId: "req-0",
				staticFieldsMatch: true,
				toolsMatch: true,
				identicalMessagePrefix: 20,
				messageCount: 22,
				previousMessageCount: 20,
			},
		});
		assert.strictEqual(report.reason, "upstream_cache_partial");
	});

	test("names the async cache-write race when the previous turn compacted", () => {
		const report = buildCacheDiagnostics({
			...base,
			usage: usage(1000, 10),
			prefix: {
				previousRequestId: "req-0",
				staticFieldsMatch: true,
				toolsMatch: true,
				identicalMessagePrefix: 20,
				messageCount: 22,
				previousMessageCount: 20,
			},
			previousTurnCompacted: true,
		});
		assert.strictEqual(report.reason, "upstream_cache_pending");
		assert.ok(report.detail.includes("write race"));
	});

	test("reports session reuse for subscription runtimes", () => {
		assert.strictEqual(buildCacheDiagnostics({
			provider: "codex",
			modelId: "gpt-5.6-luna",
			requestId: "turn-1",
			usage: usage(1000, 10),
			session: { reused: false, reuseMissReason: "no durable thread matched" },
		}).reason, "session_not_reused");

		assert.strictEqual(buildCacheDiagnostics({
			provider: "claude",
			modelId: "claude-opus-5",
			requestId: "session-1",
			usage: usage(1000, 10),
			session: { reused: true },
		}).reason, "upstream_expired");
	});

	test("separates a cold Codex startup from healthy continuation reuse", () => {
		assert.deepStrictEqual(classifyCodexTurnCache({
			threadMode: "new",
			threadReuseMissReason: "no-stored-thread",
			initialSegmentHitPercent: 0,
			finalSegmentHitPercent: 99.5,
			processedHitPercent: 74.5,
		}), {
			reason: "healthy",
			detail: "A new Codex thread was required (no-stored-thread). Its first model segment was 0.0% cache hit, then continuation recovered to 99.5% cache hit.",
		});

		assert.strictEqual(classifyCodexTurnCache({
			threadMode: "new",
			initialSegmentHitPercent: 0,
			finalSegmentHitPercent: 42,
		}).reason, "session_not_reused");
	});

	test("derives usage from Anthropic cache-read counters", () => {
		assert.deepStrictEqual(
			promptCacheUsageFromCacheReads(200, 800, 0),
			{ promptTokens: 1000, cachedTokens: 800, uncachedTokens: 200, hitPercent: 80 }
		);
		assert.strictEqual(promptCacheUsageFromCacheReads(0, 0, 0), undefined);
	});
});
