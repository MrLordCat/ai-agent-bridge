/**
 * DeepSeek peak / off-peak billing windows.
 *
 * Verified against the official pricing page on 2026-08-13:
 * https://api-docs.deepseek.com/quick_start/pricing
 *
 * From 16:00 UTC on August 16, 2026, DeepSeek API billing switches to
 * peak/off-peak rates with off-peak rates at half the peak rates:
 *   Peak hours: 01:00–04:00 UTC and 06:00–10:00 UTC.
 *   All other hours are off-peak.
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

export function isDeepSeekPeakUtc(utcMinutes: number): boolean {
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

export function resolveDeepSeekPricingSnapshot(nowMs = Date.now()): DeepSeekPricingSnapshot {
	const effective = nowMs >= DEEPSEEK_PEAK_PRICING_EFFECTIVE_AT_MS;
	const minute = utcMinutesAt(new Date(nowMs));
	const isPeak = isDeepSeekPeakUtc(minute);
	const peakWindowsLocal = DEEPSEEK_PEAK_WINDOWS_UTC
		.map(window => `${formatLocalClock(window.startUtcMinutes, nowMs)}–${formatLocalClock(window.endUtcMinutes, nowMs)}`)
		.join(", ");
	let next = PEAK_BOUNDARIES.find(boundary => boundary.at > minute);
	if (!next) {
		const first = PEAK_BOUNDARIES[0];
		next = { at: first.at + 1440, nextPeak: first.nextPeak };
	}
	return {
		state: !effective ? "flat" : isPeak ? "peak" : "off-peak",
		effective,
		isPeak: effective && isPeak,
		peakWindowsLocal,
		nextTransitionLocal: formatLocalClock(next.at % 1440, nowMs),
		nextState: next.nextPeak ? "peak" : "off-peak",
	};
}
