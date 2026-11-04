/**
 * Subscription limit errors arrive as long provider text ("You've hit your
 * 5-hour limit · resets 4pm (Europe/Tallinn)"). They are not failures to retry:
 * the provider will reject every attempt until the window resets. This module
 * turns such an error into one short English notice and remembers the reset so
 * retries fail instantly instead of starting a new provider turn each time.
 */

export type LimitProvider = "claude" | "codex";

export interface LimitMatch {
	provider: LimitProvider;
	/** Window wording from the provider, e.g. "5-hour" or "weekly". */
	window?: string;
	resetAt?: Date;
	/** IANA zone the provider named with the reset time, e.g. "Europe/Tallinn". */
	timeZone?: string;
	/** Short provider-neutral cause, e.g. "usage limit". */
	reason: string;
	/**
	 * True when the limit was read from an error message rather than from the
	 * provider's own window report. A message can be old, and its bare clock time
	 * resolves to the next occurrence, so such a block needs verification.
	 */
	provisional?: boolean;
}

const CLAUDE_PATTERNS: readonly RegExp[] = [
	/hit your .{0,40}limit/i,
	/claude api error:.*(?:usage|rate|weekly|5-hour).{0,24}limit/i,
	/usage limit reached/i,
	/rate[_ ]?limit[_ ]?(?:error|exceeded)|rate limit (?:exceeded|reached)/i,
	/\b429\b|too many requests/i,
];
const CODEX_PATTERNS: readonly RegExp[] = [
	/hit your .{0,40}limit/i,
	/purchase more credits/i,
	/usage limit reached/i,
	/rate limit (?:exceeded|reached)/i,
	/at capacity|too many requests/i,
	/\b429\b/,
];
/** Context and payload limits are not subscription windows; retrying or waiting does not help. */
const NOT_A_SUBSCRIPTION_LIMIT = /context (?:length|window)|maximum length|too many tokens|input exceeds|tool (?:call|output) limit|message too long/i;

const WINDOW_PATTERNS: readonly RegExp[] = [
	/\b(\d+-hour)\b/i,
	/\b(weekly|daily|monthly)\b/i,
];

export function detectLimitError(error: unknown, provider?: LimitProvider, now = new Date()): LimitMatch | undefined {
	const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
	if (!text || NOT_A_SUBSCRIPTION_LIMIT.test(text)) {
		return undefined;
	}
	const candidate: LimitProvider | undefined = provider
		?? (/claude/i.test(text) ? "claude"
			: /codex|chatgpt|purchase more credits/i.test(text) ? "codex"
				: /\b\d+-hour\b|\bweekly\b|\([A-Za-z]+\/[A-Za-z_+-]+\)/i.test(text) ? "claude"
					: undefined);
	if (!candidate) {
		return undefined;
	}
	const patterns = candidate === "claude" ? CLAUDE_PATTERNS : CODEX_PATTERNS;
	if (!patterns.some(pattern => pattern.test(text))) {
		return undefined;
	}
	const window = WINDOW_PATTERNS.map(pattern => pattern.exec(text)?.[1]).find(Boolean);
	const reset = parseResetTime(text, now);
	return {
		provider: candidate,
		...(window ? { window: window.toLowerCase() } : {}),
		...(reset ? { resetAt: reset.at, ...(reset.timeZone ? { timeZone: reset.timeZone } : {}) } : {}),
		reason: /\b429\b|too many requests/i.test(text) && !/hit your/i.test(text) ? "rate limit" : "usage limit",
		provisional: true,
	};
}

interface ParsedReset {
	at: Date;
	timeZone?: string;
}

const ZONE_PATTERN = /\(([A-Za-z]+(?:\/[A-Za-z_+-]+)+)\)/;
const CLOCK_PATTERN = /(?:resets?|reset|try again|available again|until)\s*(?:at|on|by)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
const ISO_PATTERN = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)/;

/** Reads "resets 4pm (Europe/Tallinn)", "try again at 2:32 PM" or an ISO timestamp. */
export function parseResetTime(text: string, now = new Date()): ParsedReset | undefined {
	const iso = ISO_PATTERN.exec(text);
	if (iso) {
		const parsed = new Date(iso[1]);
		if (!Number.isNaN(parsed.getTime())) {
			return { at: parsed };
		}
	}
	const clock = CLOCK_PATTERN.exec(text);
	if (!clock) {
		return undefined;
	}
	let hour = Number(clock[1]);
	const minute = clock[2] ? Number(clock[2]) : 0;
	const meridiem = clock[3]?.toLowerCase();
	if (!Number.isFinite(hour) || hour > 23 || minute > 59) {
		return undefined;
	}
	if (meridiem === "pm" && hour < 12) {
		hour += 12;
	} else if (meridiem === "am" && hour === 12) {
		hour = 0;
	}
	const timeZone = ZONE_PATTERN.exec(text)?.[1];
	const at = nextOccurrence(hour, minute, timeZone, now);
	return at ? { at, ...(timeZone ? { timeZone } : {}) } : undefined;
}

/** Resolves a wall-clock time in `timeZone` to the next moment it occurs. */
function nextOccurrence(hour: number, minute: number, timeZone: string | undefined, now: Date): Date | undefined {
	if (!timeZone) {
		const candidate = new Date(now);
		candidate.setHours(hour, minute, 0, 0);
		if (candidate.getTime() <= now.getTime()) {
			candidate.setDate(candidate.getDate() + 1);
		}
		return candidate;
	}
	try {
		for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
			const parts = zonedParts(now, timeZone, dayOffset);
			if (!parts) {
				return undefined;
			}
			const candidate = zonedTimeToUtc(parts.year, parts.month, parts.day, hour, minute, timeZone);
			if (candidate && candidate.getTime() > now.getTime()) {
				return candidate;
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function zonedParts(date: Date, timeZone: string, dayOffset: number): { year: number; month: number; day: number } | undefined {
	try {
		const formatted = new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(date);
		const [year, month, day] = formatted.split("-").map(Number);
		if (!year || !month || !day) {
			return undefined;
		}
		const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset));
		return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
	} catch {
		return undefined;
	}
}

function zonedTimeToUtc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timeZone: string
): Date | undefined {
	try {
		const guess = Date.UTC(year, month - 1, day, hour, minute);
		const formatter = new Intl.DateTimeFormat("en-CA", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		});
		const parts = formatter.formatToParts(new Date(guess));
		const read = (type: string) => Number(parts.find(part => part.type === type)?.value);
		const observed = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"));
		if (!Number.isFinite(observed)) {
			return undefined;
		}
		// The zone offset is the difference between what UTC looked like and the wall clock.
		return new Date(guess - (observed - guess));
	} catch {
		return undefined;
	}
}

export function formatWait(until: Date, now = new Date()): string {
	const ms = until.getTime() - now.getTime();
	if (ms <= 0) {
		return "now";
	}
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) {
		return `${minutes} min`;
	}
	const hours = Math.floor(minutes / 60), rest = minutes % 60;
	return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function formatResetClock(reset: Pick<LimitMatch, "resetAt" | "timeZone">): string | undefined {
	if (!reset.resetAt) {
		return undefined;
	}
	try {
		return new Intl.DateTimeFormat("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			...(reset.timeZone ? { timeZone: reset.timeZone } : {}),
			...(reset.timeZone ? { timeZoneName: "short" } : {}),
		}).format(reset.resetAt);
	} catch {
		return reset.resetAt.toISOString();
	}
}

export function formatLimitNotice(provider: LimitProvider, match: LimitMatch | undefined, now = new Date()): string {	const owner = provider === "claude" ? "Claude" : "Codex";
	const window = match?.window ? ` ${match.window}` : "";
	const clock = formatResetClock(match ?? {});
	if (!match?.resetAt || !clock) {
		return `${owner}${window} limit reached. Wait for the limit to reset, then send the message again. No retry was made.`;
	}
	return `${owner}${window} limit reached. It resets at ${clock} (in ${formatWait(match.resetAt, now)}). `
		+ "Wait for the reset, then send the message again. No retry was made.";
}

/**
 * A text-derived block may not outlive the window it talks about. A bare clock
 * time in a day-old message resolves to the next occurrence, which would hold
 * the chat for up to a whole day after the real reset.
 */
export function limitBlockCeilingMs(match: Pick<LimitMatch, "window">): number {
	const hours = /(\d+)-hour/i.exec(match.window ?? "")?.[1];
	if (hours) {
		return (Number(hours) + 1) * 3_600_000;
	}
	if (/week/i.test(match.window ?? "")) {
		return 7.5 * 24 * 3_600_000;
	}
	if (/day/i.test(match.window ?? "")) {
		return 26 * 3_600_000;
	}
	// Unknown window: the shortest subscription window in use is five hours.
	return 6 * 3_600_000;
}

/** Short error shown in chat instead of the raw provider text. */
export class SubscriptionLimitError extends Error {
	constructor(
		readonly provider: LimitProvider,
		readonly match: LimitMatch | undefined,
		now = new Date()
	) {
		super(formatLimitNotice(provider, match, now));
		this.name = "SubscriptionLimitError";
	}

	/** Whether a provider turn should be attempted again without user action. */
	readonly retryable = false;
}

/** Fails fast after a limit error until the provider window resets. */
export class LimitGate {
	private readonly blockedUntil = new Map<LimitProvider, { until: number; armedAt: number; match?: LimitMatch; notice: string }>();

	/** Records a hit; without a reset time the provider is blocked until the next successful turn. */
	note(provider: LimitProvider, match: LimitMatch | undefined, now = Date.now()): void {
		const ceiling = match?.provisional ? now + limitBlockCeilingMs(match) : Number.POSITIVE_INFINITY;
		const until = match?.resetAt
			? Math.min(Math.max(match.resetAt.getTime(), now + 60_000), ceiling)
			: ceiling;
		this.blockedUntil.set(provider, { until, armedAt: now, match, notice: formatLimitNotice(provider, match, new Date(now)) });
	}

	/**
	 * True when the block came from provider text, or is old enough that the
	 * provider's own report should be read again before a request is refused.
	 */
	shouldRecheck(provider: LimitProvider, now = Date.now(), recheckAfterMs = 2 * 60_000): boolean {
		const entry = this.blockedUntil.get(provider);
		if (!entry) {
			return false;
		}
		if (Number.isFinite(entry.until) && now >= entry.until) {
			return false;
		}
		return entry.match?.provisional === true || now - entry.armedAt >= recheckAfterMs;
	}

	/** Returns the short notice when the provider is still limited, otherwise undefined. */
	blocked(provider: LimitProvider, now = Date.now()): string | undefined {
		const entry = this.blockedUntil.get(provider);
		if (!entry) {
			return undefined;
		}
		if (Number.isFinite(entry.until) && now >= entry.until) {
			this.blockedUntil.delete(provider);
			return undefined;
		}
		const match = entry.match;
		if (!match?.resetAt) {
			return entry.notice;
		}
		return formatLimitNotice(provider, match, new Date(now));
	}

	/** Clears the block after a successful turn or a provider report below 100%. */
	clear(provider: LimitProvider): void {
		this.blockedUntil.delete(provider);
	}

	get(provider: LimitProvider): LimitMatch | undefined {
		return this.blockedUntil.get(provider)?.match;
	}
}
