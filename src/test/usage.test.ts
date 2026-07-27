import * as assert from "assert";
import { buildCacheDiagnostics, promptCacheUsageFromCacheReads } from "../context/cache-diagnostics";
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

	test("blames an unchanged prefix on upstream eviction", () => {
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
		assert.strictEqual(report.reason, "upstream_expired");
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

	test("derives usage from Anthropic cache-read counters", () => {
		assert.deepStrictEqual(
			promptCacheUsageFromCacheReads(200, 800, 0),
			{ promptTokens: 1000, cachedTokens: 800, uncachedTokens: 200, hitPercent: 80 }
		);
		assert.strictEqual(promptCacheUsageFromCacheReads(0, 0, 0), undefined);
	});
});
