import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SubscriptionUsageLedger, summarizeSubscriptionEvents } from "../diagnostics/subscription-usage";

const start = Date.UTC(2026, 10, 1, 6, 0, 0);
const minute = 60_000;
const usage = (at: number, provider: "claude" | "codex", fresh: number, cached: number, output: number, modelId = "model-a", cacheWrite = 0) =>
	({ type: "usage" as const, id: `u${at}`, provider, at, modelId, fresh, cached, cacheWrite, output });
const window = (at: number, provider: "claude" | "codex", kind: "fiveHour" | "weekly", utilization: number, resetsAt?: string) =>
	({ type: "window" as const, provider, kind, at, utilization, resetsAt });

suite("Subscription usage ledger", () => {
	test("counts cache hits, misses and output inside the current window", () => {
		const report = summarizeSubscriptionEvents([
			window(start, "claude", "fiveHour", 40, "2026-11-01T11:00:00.000Z"),
			usage(start + minute, "claude", 1_000, 4_000, 500, "claude-opus-5-5", 200),
			usage(start + 2 * minute, "claude", 2_000, 8_000, 300, "claude-opus-5-5"),
		]);
		const claude = report.providers.find(provider => provider.provider === "claude");
		assert.ok(claude);
		assert.strictEqual(claude.plan, undefined);
		const current = claude.current.find(record => record.kind === "fiveHour");
		assert.ok(current);
		assert.strictEqual(current.origin, "first-seen");
		assert.strictEqual(current.partial, true);
		assert.strictEqual(current.peakUtilization, 40);
		assert.deepStrictEqual(
			{ ...current.totals },
			{
				requests: 2,
				freshInputTokens: 3_000,
				cachedInputTokens: 12_000,
				cacheWriteInputTokens: 200,
				outputTokens: 800,
				inputTokens: 15_200,
				totalTokens: 16_000,
				cacheHitPercent: 78.9,
			}
		);
		assert.strictEqual(current.models.length, 1);
		assert.strictEqual(current.models[0].modelId, "claude-opus-5-5");
		assert.strictEqual(current.models[0].totalTokens, 16_000);
	});

	test("saves a full window and restarts the totals from zero", () => {
		const firstReset = "2026-11-01T11:00:00.000Z", secondReset = "2026-11-01T16:00:00.000Z";
		const weeklyReset = "2026-11-06T00:00:00.000Z";
		const report = summarizeSubscriptionEvents([
			window(start, "codex", "fiveHour", 50, firstReset),
			window(start, "codex", "weekly", 40, weeklyReset),
			usage(start + minute, "codex", 4_000, 16_000, 1_000),
			window(start + 2 * minute, "codex", "fiveHour", 100, firstReset),
			usage(start + 3 * minute, "codex", 2_000, 18_000, 700),
			window(start + 4 * minute, "codex", "fiveHour", 15, secondReset),
			usage(start + 5 * minute, "codex", 500, 0, 100),
		]);
		const codex = report.providers.find(provider => provider.provider === "codex");
		assert.ok(codex);
		assert.strictEqual(codex.exhausted.length, 1);
		const full = codex.exhausted[0];
		assert.strictEqual(full.closedBy, "limit-hit");
		assert.strictEqual(full.totals.requests, 1);
		assert.strictEqual(full.totals.totalTokens, 21_000);
		assert.strictEqual(full.totals.cacheHitPercent, 80);
		assert.strictEqual(codex.completed.length, 2, "the post-100% stretch ends at the real reset");
		const afterLimit = codex.completed[0];
		assert.strictEqual(afterLimit.origin, "limit-hit");
		assert.strictEqual(afterLimit.closedBy, "reset");
		assert.strictEqual(afterLimit.totals.requests, 1);
		const current = codex.current.find(record => record.kind === "fiveHour");
		assert.ok(current);
		assert.strictEqual(current.origin, "reset");
		assert.strictEqual(current.partial, false, "a provider reset starts a complete window");
		assert.strictEqual(current.totals.requests, 1);
		assert.strictEqual(current.totals.totalTokens, 600);
		const weekly = codex.current.find(record => record.kind === "weekly");
		assert.strictEqual(weekly?.totals.requests, 3, "every request counts against the weekly window too");
	});

	test("keeps the 5-hour and weekly windows apart", () => {
		const report = summarizeSubscriptionEvents([
			window(start, "claude", "fiveHour", 20, "2026-11-01T11:00:00.000Z"),
			window(start, "claude", "weekly", 60, "2026-11-06T00:00:00.000Z"),
			usage(start + minute, "claude", 100, 900, 50),
			window(start + 2 * minute, "claude", "fiveHour", 100, "2026-11-01T11:00:00.000Z"),
		]);
		const claude = report.providers[0];
		assert.strictEqual(claude.exhausted.length, 1);
		assert.strictEqual(claude.exhausted[0].kind, "fiveHour");
		const weekly = claude.current.find(record => record.kind === "weekly");
		assert.ok(weekly);
		assert.strictEqual(weekly.peakUtilization, 60);
		assert.strictEqual(weekly.closedBy, undefined);
	});

	test("ignores an idle provider that reports 0% with a moving reset time", () => {
		const events = Array.from({ length: 30 }, (_, index) =>
			window(start + index * minute, "codex", "fiveHour", 0, new Date(Date.UTC(2026, 10, 2, 3, 34 + index, 31)).toISOString()));
		const report = summarizeSubscriptionEvents(events);
		assert.deepStrictEqual(report.providers, [], "no window exists until something was used");
	});

	test("sub-second reset jitter does not split a window", () => {
		const first = "2026-11-02T00:40:00.230275+00:00", second = "2026-11-02T00:39:59.598225+00:00";
		const report = summarizeSubscriptionEvents([
			window(start, "claude", "fiveHour", 24, first),
			usage(start + minute, "claude", 10, 90, 5),
			window(start + 2 * minute, "claude", "fiveHour", 25, second),
			window(start + 3 * minute, "claude", "fiveHour", 26, first),
		]);
		const claude = report.providers[0];
		assert.strictEqual(claude.current.length, 1, "one running window, no history yet");
		assert.strictEqual(claude.completed.length, 0);
		assert.strictEqual(claude.current[0].totals.requests, 1);
	});

	test("an empty window is never saved as history", () => {
		const firstReset = "2026-11-02T11:50:00.000Z", secondReset = "2026-11-02T16:50:00.000Z";
		const report = summarizeSubscriptionEvents([
			window(start, "codex", "fiveHour", 20, firstReset),
			usage(start + minute, "codex", 1_000, 4_000, 500),
			// A real reset, then an idle window that reports 0% until the next period.
			window(start + 2 * minute, "codex", "fiveHour", 0, secondReset),
			usage(start + 3 * minute, "codex", 100, 900, 50),
		]);
		const codex = report.providers[0];
		assert.strictEqual(codex.completed.length, 1, "only the window that tracked tokens becomes history");
		assert.strictEqual(codex.completed[0].totals.requests, 1);
		assert.strictEqual(codex.current.length, 1);
		assert.strictEqual(codex.current[0].totals.requests, 1);
	});

	test("a fully used window without tracked requests is not counted as capacity", () => {
		const reset = "2026-11-06T00:00:00.000Z";
		const report = summarizeSubscriptionEvents([
			window(start, "claude", "weekly", 100, reset),
			window(start + minute, "claude", "weekly", 100, "2026-11-06T00:00:00.400Z"),
		]);
		const claude = report.providers[0];
		assert.strictEqual(claude.exhausted.length, 0);
		assert.strictEqual(claude.completed.length, 0);
		assert.strictEqual(claude.current[0].peakUtilization, 100, "the running window still shows 100%");
	});

	test("one hundred percent is saved once, not on every refresh", () => {
		const report = summarizeSubscriptionEvents([
			window(start, "claude", "fiveHour", 90, "2026-11-01T11:00:00.000Z"),
			usage(start + minute, "claude", 100, 0, 10),
			window(start + 2 * minute, "claude", "fiveHour", 100, "2026-11-01T11:00:00.000Z"),
			window(start + 3 * minute, "claude", "fiveHour", 100, "2026-11-01T11:00:00.000Z"),
		]);
		const claude = report.providers[0];
		assert.strictEqual(claude.exhausted.length, 1);
		assert.strictEqual(claude.current.length, 1, "only the reported 5-hour window exists");
		assert.strictEqual(claude.current[0].kind, "fiveHour");
		const afterHit = claude.current.find(record => record.kind === "fiveHour");
		assert.strictEqual(afterHit?.origin, "limit-hit");
		assert.strictEqual(afterHit?.totals.requests, 0);
	});

	test("every window of this profile adds to the same file", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "subscription-ledger-"));
		try {
			const first = new SubscriptionUsageLedger(root), second = new SubscriptionUsageLedger(root);
			await first.initialize(); await second.initialize();
			first.observe("claude", { fiveHour: { utilization: 12, resetsAt: "2026-11-02T00:40:00.000+00:00" } });
			first.record({ provider: "claude", freshInputTokens: 500, cachedInputTokens: 1_500, outputTokens: 200, at: start });
			await first.flush();
			second.record({ provider: "claude", freshInputTokens: 1_000, cachedInputTokens: 0, outputTokens: 50, at: start + minute });
			await second.flush();
			await first.refresh();
			const merged = first.summary().providers.find(provider => provider.provider === "claude");
			assert.ok(merged);
			assert.strictEqual(merged.current[0].totals.requests, 2, "the first window sees the second window's request");
			assert.strictEqual(merged.current[0].totals.totalTokens, 3_250);
			await second.refresh();
			assert.strictEqual(second.summary().providers[0].current[0].totals.requests, 2, "and the second sees the first's");
			first.dispose(); second.dispose();
		} finally { await fs.rm(root, { recursive: true, force: true }); }
	});

	test("observing a window stores bands and the 100% boundary", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "subscription-observe-"));
		try {
			const ledger = new SubscriptionUsageLedger(root);
			await ledger.initialize();
			const resetsAt = "2026-11-01T11:00:00.000Z";
			ledger.observe("codex", { plan: "plus", fiveHour: { utilization: 42, resetsAt }, weekly: { utilization: 61 } });
			ledger.observe("codex", { fiveHour: { utilization: 44, resetsAt }, weekly: { utilization: 62 } });
			assert.strictEqual(ledger.summary().providers[0].current.length, 2, "same band: no new record");
			ledger.record({ provider: "codex", freshInputTokens: 10, cachedInputTokens: 90, outputTokens: 5, at: start });
			ledger.observe("codex", { fiveHour: { utilization: 100, resetsAt } });
			await ledger.flush();
			const codex = ledger.summary().providers[0];
			assert.strictEqual(codex.plan, "plus");
			assert.strictEqual(codex.exhausted.length, 1);
			assert.strictEqual(codex.exhausted[0].totals.totalTokens, 105);
			const reloaded = new SubscriptionUsageLedger(root);
			await reloaded.initialize();
			assert.strictEqual(reloaded.summary().providers[0].exhausted.length, 1, "records survive a reload");
			ledger.dispose(); reloaded.dispose();
		} finally { await fs.rm(root, { recursive: true, force: true }); }
	});
});
