import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SubscriptionUsageLedger, summarizeSubscriptionEvents } from "../diagnostics/subscription-usage";

const start = Date.UTC(2026, 10, 1, 6, 0, 0);
const minute = 60_000;
const hour = 60 * minute;
const iso = (at: number) => new Date(at).toISOString();
type Provider = "claude" | "codex";
type Kind = "fiveHour" | "weekly";
const usage = (at: number, provider: Provider, fresh: number, cached: number, output: number, modelId = "model-a", cacheWrite = 0) =>
	({ type: "usage" as const, id: `u${at}`, provider, at, modelId, fresh, cached, cacheWrite, output });
const window = (at: number, provider: Provider, kind: Kind, utilization: number, resetsAt?: string) =>
	({ type: "window" as const, provider, kind, at, utilization, resetsAt });
// A window the ledger followed until it reset at `start`, so the next one is tracked from its beginning.
const previous = (provider: Provider, kind: Kind) => window(start - 2 * hour, provider, kind, 30, iso(start));

suite("Subscription usage ledger", () => {
	test("counts cache hits, misses and output inside the current window", () => {
		const report = summarizeSubscriptionEvents([
			window(start, "claude", "fiveHour", 40, "2026-11-01T11:00:00.000Z"),
			usage(start + minute, "claude", 1_000, 4_000, 500, "claude-opus-5-5", 200),
			usage(start + 2 * minute, "claude", 2_000, 8_000, 300, "claude-opus-5-5"),
		], start + hour);
		const claude = report.providers.find(provider => provider.provider === "claude");
		assert.ok(claude);
		assert.strictEqual(claude.plan, undefined);
		const current = claude.current.find(record => record.kind === "fiveHour");
		assert.ok(current);
		assert.strictEqual(current.origin, "first-seen");
		assert.strictEqual(current.partial, true, "tracking began inside this window");
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

	test("saves a window tracked from its start, including the request that hit 100%", () => {
		const firstReset = start + 5 * hour, secondReset = start + 10 * hour + 5 * minute;
		const report = summarizeSubscriptionEvents([
			previous("codex", "fiveHour"),
			window(start + minute, "codex", "fiveHour", 2, iso(firstReset)),
			window(start + minute, "codex", "weekly", 40, iso(start + 72 * hour)),
			usage(start + 2 * minute, "codex", 4_000, 16_000, 1_000),
			window(start + 3 * minute, "codex", "fiveHour", 100, iso(firstReset)),
			// The turn that ran into the limit reports its tokens when it fails.
			usage(start + 4 * minute, "codex", 1_000, 0, 100),
			// The first request after the reset opens the next window before its first sample.
			usage(firstReset + 6 * minute, "codex", 500, 0, 100),
			window(firstReset + 10 * minute, "codex", "fiveHour", 3, iso(secondReset)),
		], firstReset + hour);
		const codex = report.providers.find(provider => provider.provider === "codex");
		assert.ok(codex);
		assert.strictEqual(codex.exhausted.length, 1);
		const full = codex.exhausted[0];
		assert.strictEqual(full.closedBy, "limit-hit");
		assert.strictEqual(full.partial, false);
		assert.strictEqual(full.totals.requests, 2);
		assert.strictEqual(full.totals.totalTokens, 22_100);
		assert.deepStrictEqual(codex.completed.map(record => record.kind), ["fiveHour"], "only the fully tracked window is history");
		const current = codex.current.find(record => record.kind === "fiveHour");
		assert.ok(current);
		assert.strictEqual(current.origin, "reset");
		assert.strictEqual(current.partial, false);
		assert.strictEqual(current.startedAt, secondReset - 5 * hour, "the window starts with the request that opened it");
		assert.strictEqual(current.totals.totalTokens, 600);
		const weekly = codex.current.find(record => record.kind === "weekly");
		assert.strictEqual(weekly?.totals.requests, 3, "every request counts against the weekly window too");
		assert.strictEqual(weekly?.partial, true, "the weekly window was already 40% used when first seen");
	});

	test("takes back the start of a window Codex restarts right after 100%", () => {
		const restart = start + 25 * minute;
		const report = summarizeSubscriptionEvents([
			previous("codex", "weekly"),
			window(start + minute, "codex", "weekly", 3, iso(start + 168 * hour)),
			usage(start + 10 * minute, "codex", 1_000, 0, 0),
			window(start + 12 * minute, "codex", "weekly", 95, iso(start + 168 * hour)),
			window(start + 20 * minute, "codex", "weekly", 100, iso(start + 168 * hour)),
			usage(start + 21 * minute, "codex", 500, 0, 0),
			usage(start + 30 * minute, "codex", 2_000, 0, 0),
			usage(start + 40 * minute, "codex", 3_000, 0, 0),
			// The new window is only noticed at 10%, long after it began.
			window(start + 50 * minute, "codex", "weekly", 10, iso(restart + 168 * hour)),
		], start + hour);
		const codex = report.providers[0];
		assert.strictEqual(codex.exhausted.length, 1);
		assert.strictEqual(codex.exhausted[0].totals.totalTokens, 1_500);
		const current = codex.current[0];
		assert.strictEqual(current.startedAt, restart);
		assert.strictEqual(current.totals.totalTokens, 5_000, "requests after the restart belong to the new window");
		assert.strictEqual(current.partial, false);
	});

	test("usage after the reset time opens the next window", () => {
		const reset = start + 5 * hour;
		const report = summarizeSubscriptionEvents([
			previous("claude", "fiveHour"),
			window(start + minute, "claude", "fiveHour", 2, iso(reset)),
			usage(start + 10 * minute, "claude", 1_000, 0, 0),
			usage(reset + 20 * minute, "claude", 2_000, 0, 0),
		], reset + 30 * minute);
		const claude = report.providers[0];
		assert.strictEqual(claude.completed.length, 1);
		assert.strictEqual(claude.completed[0].endedAt, reset);
		assert.strictEqual(claude.completed[0].totals.totalTokens, 1_000);
		assert.strictEqual(claude.current[0].totals.totalTokens, 2_000);
		assert.strictEqual(claude.current[0].partial, false);
	});

	test("a window first seen already in use is never saved", () => {
		const reset = start + 5 * hour + 30 * minute;
		const report = summarizeSubscriptionEvents([
			previous("codex", "fiveHour"),
			// VS Code was closed when the window started at +30 min and 40% went elsewhere.
			window(start + 2 * hour, "codex", "fiveHour", 40, iso(reset)),
			usage(start + 2 * hour + 5 * minute, "codex", 1_000, 0, 0),
			window(start + 3 * hour, "codex", "fiveHour", 100, iso(reset)),
		], start + 6 * hour);
		const codex = report.providers[0];
		assert.deepStrictEqual(codex.completed, []);
		assert.deepStrictEqual(codex.exhausted, []);
		assert.deepStrictEqual(codex.current, [], "the window ended at its reset");
	});

	test("a window that kept rising without our requests is never saved", () => {
		const reset = start + 5 * hour;
		const events = [
			previous("codex", "fiveHour"),
			window(start + minute, "codex", "fiveHour", 2, iso(reset)),
			usage(start + 5 * minute, "codex", 1_000, 0, 0),
			window(start + 6 * minute, "codex", "fiveHour", 10, iso(reset)),
			window(start + hour, "codex", "fiveHour", 60, iso(reset)),
			window(start + 2 * hour, "codex", "fiveHour", 100, iso(reset)),
		];
		const report = summarizeSubscriptionEvents(events, start + 3 * hour);
		assert.deepStrictEqual(report.providers[0].exhausted, [], "90% of the window was never recorded");
		assert.strictEqual(report.providers[0].current[0].partial, true);
		const recorded = summarizeSubscriptionEvents([...events, usage(start + 2 * hour + minute, "codex", 9_000, 0, 0)], start + 3 * hour);
		assert.strictEqual(recorded.providers[0].exhausted.length, 1, "the failed turn's tokens complete it");
	});

	test("keeps the 5-hour and weekly windows apart", () => {
		const report = summarizeSubscriptionEvents([
			previous("claude", "fiveHour"),
			previous("claude", "weekly"),
			window(start + minute, "claude", "fiveHour", 2, iso(start + 5 * hour)),
			window(start + minute, "claude", "weekly", 1, iso(start + 168 * hour)),
			usage(start + 2 * minute, "claude", 100, 900, 50),
			window(start + 3 * minute, "claude", "fiveHour", 100, iso(start + 5 * hour)),
		], start + hour);
		const claude = report.providers[0];
		assert.deepStrictEqual(claude.exhausted.map(record => record.kind), ["fiveHour"]);
		const weekly = claude.current.find(record => record.kind === "weekly");
		assert.ok(weekly);
		assert.strictEqual(weekly.peakUtilization, 1);
		assert.strictEqual(weekly.closedBy, undefined);
	});

	test("ignores an idle provider that reports 0% with a moving reset time", () => {
		const events = Array.from({ length: 30 }, (_, index) =>
			window(start + index * minute, "codex", "fiveHour", 0, new Date(Date.UTC(2026, 10, 2, 3, 34 + index, 31)).toISOString()));
		const report = summarizeSubscriptionEvents(events, start + hour);
		assert.deepStrictEqual(report.providers, [], "no window exists until something was used");
	});

	test("sub-second reset jitter does not split a window", () => {
		const first = "2026-11-02T00:40:00.230275+00:00", second = "2026-11-02T00:39:59.598225+00:00";
		const report = summarizeSubscriptionEvents([
			window(start, "claude", "fiveHour", 24, first),
			usage(start + minute, "claude", 10, 90, 5),
			window(start + 2 * minute, "claude", "fiveHour", 25, second),
			window(start + 3 * minute, "claude", "fiveHour", 26, first),
		], start + hour);
		const claude = report.providers[0];
		assert.strictEqual(claude.current.length, 1, "one running window, no history yet");
		assert.strictEqual(claude.completed.length, 0);
		assert.strictEqual(claude.current[0].totals.requests, 1);
	});

	test("a window without our tokens is never saved as history", () => {
		const firstReset = start + 5 * hour;
		const report = summarizeSubscriptionEvents([
			previous("codex", "fiveHour"),
			window(start + minute, "codex", "fiveHour", 3, iso(firstReset)),
			window(firstReset + 10 * minute, "codex", "fiveHour", 2, iso(firstReset + 5 * hour + 5 * minute)),
			usage(firstReset + 12 * minute, "codex", 100, 900, 50),
			// A real reset, then an idle window that reports 0% until the next request.
			window(firstReset + 5 * hour + 6 * minute, "codex", "fiveHour", 0, iso(firstReset + 10 * hour + 6 * minute)),
			usage(firstReset + 5 * hour + 8 * minute, "codex", 1_000, 0, 0),
		], firstReset + 6 * hour);
		const codex = report.providers[0];
		assert.strictEqual(codex.completed.length, 1, "only the window that tracked tokens becomes history");
		assert.strictEqual(codex.completed[0].totals.totalTokens, 1_050);
		assert.strictEqual(codex.current.length, 1);
		assert.strictEqual(codex.current[0].totals.totalTokens, 1_000);
	});

	test("a fully used window without tracked requests is not counted as capacity", () => {
		const reset = "2026-11-06T00:00:00.000Z";
		const report = summarizeSubscriptionEvents([
			window(start, "claude", "weekly", 100, reset),
			window(start + minute, "claude", "weekly", 100, "2026-11-06T00:00:00.400Z"),
		], start + hour);
		const claude = report.providers[0];
		assert.strictEqual(claude.exhausted.length, 0);
		assert.strictEqual(claude.completed.length, 0);
		assert.strictEqual(claude.current[0].peakUtilization, 100, "the running window still shows 100%");
	});

	test("one hundred percent is saved once, not on every refresh", () => {
		const reset = iso(start + 5 * hour);
		const report = summarizeSubscriptionEvents([
			previous("claude", "fiveHour"),
			window(start + minute, "claude", "fiveHour", 3, reset),
			usage(start + 2 * minute, "claude", 100, 0, 10),
			window(start + 3 * minute, "claude", "fiveHour", 100, reset),
			window(start + 4 * minute, "claude", "fiveHour", 100, reset),
		], start + hour);
		const claude = report.providers[0];
		assert.strictEqual(claude.exhausted.length, 1);
		assert.strictEqual(claude.current.length, 1, "the exhausted window keeps running until its reset");
		assert.strictEqual(claude.current[0].closedBy, "limit-hit");
		assert.strictEqual(claude.current[0].totals.requests, 1);
	});

	test("every window of this profile adds to the same file", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "subscription-ledger-"));
		try {
			const now = Date.now();
			const first = new SubscriptionUsageLedger(root), second = new SubscriptionUsageLedger(root);
			await first.initialize(); await second.initialize();
			first.observe("claude", { fiveHour: { utilization: 12, resetsAt: iso(now + 2 * hour) } });
			first.record({ provider: "claude", freshInputTokens: 500, cachedInputTokens: 1_500, outputTokens: 200, at: now });
			await first.flush();
			second.record({ provider: "claude", freshInputTokens: 1_000, cachedInputTokens: 0, outputTokens: 50, at: now + 1 });
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

	test("observing a window stores the reset after an idle 0% sample and the 100% boundary", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "subscription-observe-"));
		try {
			const ledger = new SubscriptionUsageLedger(root);
			await ledger.initialize();
			const now = Date.now();
			const firstReset = iso(now + hour), secondReset = iso(now + 5 * hour);
			ledger.observe("codex", { plan: "plus", fiveHour: { utilization: 42, resetsAt: firstReset }, weekly: { utilization: 61 } });
			ledger.observe("codex", { fiveHour: { utilization: 44, resetsAt: firstReset }, weekly: { utilization: 62 } });
			assert.strictEqual(ledger.summary().providers[0].current.length, 2, "same band: no new record");
			// The new window reads 0% first; its first used sample must still count as a reset.
			ledger.observe("codex", { fiveHour: { utilization: 0, resetsAt: secondReset } });
			ledger.observe("codex", { fiveHour: { utilization: 2, resetsAt: secondReset } });
			ledger.record({ provider: "codex", freshInputTokens: 10, cachedInputTokens: 90, outputTokens: 5, at: Date.now() });
			ledger.observe("codex", { fiveHour: { utilization: 100, resetsAt: secondReset } });
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
