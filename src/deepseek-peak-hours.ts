/**
 * DeepSeek peak / off-peak billing windows.
 *
 * Verified against the official pricing page on 2026-08-25:
 * https://api-docs.deepseek.com/quick_start/pricing
 *
 * From 16:00 UTC on August 16, 2026, DeepSeek API billing switches to
 * peak/off-peak rates with off-peak rates at half the peak rates:
 *   Peak hours: 01:00–04:00 UTC and 06:00–10:00 UTC, Monday through Friday.
 *   All other hours (including weekends) are off-peak.
 *
 * Example v4-pro rates per 1M tokens (cache miss / output):
 *   off-peak $0.66 / $1.98, peak $1.32 / $3.96.
 */

export const DEEPSEEK_PEAK_PRICING_EFFECTIVE_AT_MS = Date.parse("2026-08-16T16:00:00Z");

export interface DeepSeekPeakWindow {
	/** Minutes from 00:00 UTC the peak starts (inclusive). */
	startUtcMinutes: number;
	/** Minutes from 00:00 UTC the peak ends (exclusive). */
	endUtcMinutes: number;
}

export const DEEPSEEK_PEAK_WINDOWS_UTC: readonly DeepSeekPeakWindow[] = [
	{ startUtcMinutes: 1 * 60, endUtcMinutes: 4 * 60 },
	{ startUtcMinutes: 6 * 60, endUtcMinutes: 10 * 60 },
];

export type DeepSeekPricingState = "flat" | "peak" | "off-peak";

export interface DeepSeekPricingSnapshot {
	state: DeepSeekPricingState;
	/** True once the peak/off-peak billing is in force (2026-08-16T16:00Z). */
	effective: boolean;
	/** True only while a peak window is active and billing is in force. */
	isPeak: boolean;
	/** Local-time label of both peak windows, e.g. "04:00–07:00, 09:00–13:00". */
	peakWindowsLocal: string;
	/** Local-time label of the next peak/off-peak transition, if any. */
	nextTransitionLocal: string;
	/** Billing state after the next transition. */
	nextState: "peak" | "off-peak";
}

interface PeakBoundary {
	at: number;
	nextPeak: boolean;
}

const PEAK_BOUNDARIES: readonly PeakBoundary[] = [
	{ at: 60, nextPeak: true },
	{ at: 240, nextPeak: false },
	{ at: 360, nextPeak: true },
	{ at: 600, nextPeak: false },
];

function utcMinutesAt(date: Date): number {
	return date.getUTCHours() * 60 + date.getUTCMinutes();
}

export function isDeepSeekPeakUtc(utcMinutes: number, utcWeekday = 1): boolean {
	// Peak billing applies Monday through Friday only (1=Mon..5=Fri, 0=Sun, 6=Sat).
	if (utcWeekday < 1 || utcWeekday > 5) {
		return false;
	}
	const normalized = ((utcMinutes % 1440) + 1440) % 1440;
	return DEEPSEEK_PEAK_WINDOWS_UTC.some(window =>
		normalized >= window.startUtcMinutes && normalized < window.endUtcMinutes
	);
}

/** Formats an absolute UTC minute of the day as a local-time clock label. */
export function formatLocalClock(utcMinutes: number, nowMs = Date.now()): string {
	const now = new Date(nowMs);
	const anchorUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0);
	return new Date(anchorUtc + utcMinutes * 60_000).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

/** Local-time label of when the new peak/off-peak billing takes effect. */
export function formatDeepSeekPeakEffectiveLocal(nowMs = Date.now()): string {
	void nowMs;
	return new Date(DEEPSEEK_PEAK_PRICING_EFFECTIVE_AT_MS).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** Local label of an upcoming transition that lands on a later weekday. */
function formatWeekdayTransition(daysAhead: number, utcMinutes: number, nowMs: number): string {
	const now = new Date(nowMs);
	const target = new Date(Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate() + daysAhead,
		0,
		0
	) + utcMinutes * 60_000);
	const dayLabel = target.toLocaleDateString(undefined, { weekday: "short" });
	return `${dayLabel} ${formatLocalClock(utcMinutes, nowMs)}`;
}

export function resolveDeepSeekPricingSnapshot(nowMs = Date.now()): DeepSeekPricingSnapshot {
	const effective = nowMs >= DEEPSEEK_PEAK_PRICING_EFFECTIVE_AT_MS;
	const now = new Date(nowMs);
	const minute = utcMinutesAt(now);
	const weekday = now.getUTCDay(); // 0=Sun..6=Sat
	const isPeak = effective && weekday >= 1 && weekday <= 5 && isDeepSeekPeakUtc(minute, weekday);
	const peakWindowsLocal = DEEPSEEK_PEAK_WINDOWS_UTC
		.map(window => `${formatLocalClock(window.startUtcMinutes, nowMs)}–${formatLocalClock(window.endUtcMinutes, nowMs)}`)
		.join(", ");
	let nextState: "peak" | "off-peak";
	let nextTransitionLocal: string;
	if (weekday >= 1 && weekday <= 5) {
		const boundary = PEAK_BOUNDARIES.find(candidate => candidate.at > minute);
		if (boundary) {
			nextState = boundary.nextPeak ? "peak" : "off-peak";
			nextTransitionLocal = formatLocalClock(boundary.at, nowMs);
		} else {
			// After the last window (10:00 UTC): Friday rolls to Monday 01:00,
			// other weekdays roll to tomorrow 01:00.
			nextState = "peak";
			const daysAhead = weekday === 5 ? 3 : 1;
			nextTransitionLocal = formatWeekdayTransition(daysAhead, 60, nowMs);
		}
	} else {
		// Weekends are off-peak; the next peak is Monday 01:00 UTC.
		nextState = "peak";
		const daysAhead = weekday === 6 ? 2 : 1;
		nextTransitionLocal = formatWeekdayTransition(daysAhead, 60, nowMs);
	}
	return {
		state: !effective ? "flat" : isPeak ? "peak" : "off-peak",
		effective,
		isPeak,
		peakWindowsLocal,
		nextTransitionLocal,
		nextState,
	};
}
