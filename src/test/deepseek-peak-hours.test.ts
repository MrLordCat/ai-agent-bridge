import * as assert from "assert";

import {
	DEEPSEEK_PEAK_PRICING_EFFECTIVE_AT_MS,
	formatLocalClock,
	isDeepSeekPeakUtc,
	resolveDeepSeekPricingSnapshot,
} from "../deepseek-peak-hours";

suite("deepseek peak hours", () => {
	test("classifies the official DeepSeek peak windows (01:00-04:00 and 06:00-10:00 UTC)", () => {
		assert.strictEqual(isDeepSeekPeakUtc(0), false);        // 00:00 UTC
		assert.strictEqual(isDeepSeekPeakUtc(59), false);       // 00:59 UTC
		assert.strictEqual(isDeepSeekPeakUtc(60), true);        // 01:00 UTC
		assert.strictEqual(isDeepSeekPeakUtc(239), true);       // 03:59 UTC
		assert.strictEqual(isDeepSeekPeakUtc(240), false);      // 04:00 UTC
		assert.strictEqual(isDeepSeekPeakUtc(300), false);      // 05:00 UTC
		assert.strictEqual(isDeepSeekPeakUtc(360), true);       // 06:00 UTC
		assert.strictEqual(isDeepSeekPeakUtc(599), true);       // 09:59 UTC
		assert.strictEqual(isDeepSeekPeakUtc(600), false);      // 10:00 UTC
		assert.strictEqual(isDeepSeekPeakUtc(1439), false);     // 23:59 UTC
		// Wraps across day boundaries.
		assert.strictEqual(isDeepSeekPeakUtc(1440 + 120), true); // 02:00 UTC next day
	});

	test("switches to peak billing on Aug 16 2026 at 16:00 UTC", () => {
		assert.ok(DEEPSEEK_PEAK_PRICING_EFFECTIVE_AT_MS === Date.parse("2026-08-16T16:00:00Z"));

		const before = resolveDeepSeekPricingSnapshot(Date.parse("2026-08-16T15:59:59Z"));
		assert.strictEqual(before.state, "flat");
		assert.strictEqual(before.effective, false);
		assert.strictEqual(before.isPeak, false);

		const after = resolveDeepSeekPricingSnapshot(Date.parse("2026-08-16T16:00:00Z"));
		assert.strictEqual(after.effective, true);
		assert.strictEqual(after.state, "off-peak");
		assert.strictEqual(after.isPeak, false);
		assert.strictEqual(after.nextState, "peak");
	});

	test("reports peak, off-peak, and the next transition in local time", () => {
		const peak = resolveDeepSeekPricingSnapshot(Date.parse("2026-08-17T02:30:00Z"));
		assert.strictEqual(peak.state, "peak");
		assert.strictEqual(peak.isPeak, true);
		assert.strictEqual(peak.nextState, "off-peak");
		assert.match(peak.nextTransitionLocal, /^\d{2}:\d{2}$/);

		const offPeakGap = resolveDeepSeekPricingSnapshot(Date.parse("2026-08-17T05:00:00Z"));
		assert.strictEqual(offPeakGap.state, "off-peak");
		assert.strictEqual(offPeakGap.isPeak, false);
		assert.strictEqual(offPeakGap.nextState, "peak");

		// After the last window of the day the next peak wraps to the next day.
		const late = resolveDeepSeekPricingSnapshot(Date.parse("2026-08-17T22:00:00Z"));
		assert.strictEqual(late.state, "off-peak");
		assert.strictEqual(late.nextState, "peak");
		assert.match(late.nextTransitionLocal, /^\d{2}:\d{2}$/);
	});

	test("formats both peak windows as local clock labels", () => {
		const snapshot = resolveDeepSeekPricingSnapshot(Date.parse("2026-08-17T12:00:00Z"));
		assert.match(snapshot.peakWindowsLocal, /^\d{2}:\d{2}–\d{2}:\d{2}, \d{2}:\d{2}–\d{2}:\d{2}$/);
		assert.match(formatLocalClock(60, Date.parse("2026-08-17T12:00:00Z")), /^\d{2}:\d{2}$/);
	});
});
