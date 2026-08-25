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

	test("applies peak windows on weekdays only (Monday-Friday)", () => {
		assert.strictEqual(isDeepSeekPeakUtc(120, 1), true);   // Mon 02:00 UTC
		assert.strictEqual(isDeepSeekPeakUtc(120, 2), true);   // Tue
		assert.strictEqual(isDeepSeekPeakUtc(120, 3), true);   // Wed
		assert.strictEqual(isDeepSeekPeakUtc(120, 4), true);   // Thu
		assert.strictEqual(isDeepSeekPeakUtc(120, 5), true);   // Fri
		assert.strictEqual(isDeepSeekPeakUtc(120, 6), false);  // Sat
		assert.strictEqual(isDeepSeekPeakUtc(120, 0), false);  // Sun
		assert.strictEqual(isDeepSeekPeakUtc(360, 6), false);  // Sat 06:00 UTC
		assert.strictEqual(isDeepSeekPeakUtc(360, 0), false);  // Sun 06:00 UTC
	});

	test("reports weekends as off-peak and rolls the next peak to Monday", () => {
		// Saturday 2026-08-22 02:30 UTC: within a weekday peak window, but weekend.
		const saturday = resolveDeepSeekPricingSnapshot(Date.parse("2026-08-22T02:30:00Z"));
		assert.strictEqual(saturday.state, "off-peak");
		assert.strictEqual(saturday.isPeak, false);
		assert.strictEqual(saturday.nextState, "peak");
		assert.match(saturday.nextTransitionLocal, /^\S+ \d{2}:\d{2}$/); // "Mon 01:00" (localized)

		// Sunday 2026-08-23 08:00 UTC is off-peak too.
		const sunday = resolveDeepSeekPricingSnapshot(Date.parse("2026-08-23T08:00:00Z"));
		assert.strictEqual(sunday.state, "off-peak");
		assert.strictEqual(sunday.nextState, "peak");

		// Friday after 10:00 UTC rolls past the weekend to Monday 01:00.
		const fridayLate = resolveDeepSeekPricingSnapshot(Date.parse("2026-08-21T22:00:00Z"));
		assert.strictEqual(fridayLate.state, "off-peak");
		assert.strictEqual(fridayLate.nextState, "peak");
		assert.match(fridayLate.nextTransitionLocal, /^\S+ \d{2}:\d{2}$/);

		// Monday 02:30 UTC is still peak.
		const monday = resolveDeepSeekPricingSnapshot(Date.parse("2026-08-24T02:30:00Z"));
		assert.strictEqual(monday.state, "peak");
		assert.strictEqual(monday.isPeak, true);
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
		assert.match(late.nextTransitionLocal, /^\S+ \d{2}:\d{2}$/);
	});

	test("formats both peak windows as local clock labels", () => {
		const snapshot = resolveDeepSeekPricingSnapshot(Date.parse("2026-08-17T12:00:00Z"));
		assert.match(snapshot.peakWindowsLocal, /^\d{2}:\d{2}–\d{2}:\d{2}, \d{2}:\d{2}–\d{2}:\d{2}$/);
		assert.match(formatLocalClock(60, Date.parse("2026-08-17T12:00:00Z")), /^\d{2}:\d{2}$/);
	});
});
