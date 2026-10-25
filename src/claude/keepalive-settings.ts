/** Anthropic's subscription prompt cache lives 1 hour; the keep-alive timer only checks every 5 minutes. */
export const CLAUDE_KEEPALIVE_MAX_INTERVAL_MS = 55 * 60_000;
export const CLAUDE_KEEPALIVE_DEFAULT_INTERVAL_MS = 45 * 60_000;
export const CLAUDE_KEEPALIVE_DEFAULT_MAX_IDLE_MS = 2 * 60 * 60_000;
const CLAUDE_KEEPALIVE_MAX_IDLE_LIMIT_MS = 24 * 60 * 60_000;

export interface ClaudeKeepAliveSettings {
	enabled: boolean;
	intervalMs: number;
	/** Keep-alive stops once the session has had no real Claude turn for this long. */
	maxIdleMs: number;
}

interface ConfigurationReader {
	get<T>(section: string, defaultValue: T): T;
}

function bounded(value: unknown, fallback: number, minimum: number, maximum: number): number {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

export function resolveClaudeKeepAliveSettings(config: ConfigurationReader): ClaudeKeepAliveSettings {
	const intervalMs = bounded(
		config.get("claudeCacheKeepAliveMs", CLAUDE_KEEPALIVE_DEFAULT_INTERVAL_MS),
		CLAUDE_KEEPALIVE_DEFAULT_INTERVAL_MS, 60_000, CLAUDE_KEEPALIVE_MAX_INTERVAL_MS
	);
	return {
		enabled: config.get<boolean>("claudeCacheKeepAliveEnabled", true) !== false,
		intervalMs,
		maxIdleMs: bounded(
			config.get("claudeCacheKeepAliveMaxIdleMs", CLAUDE_KEEPALIVE_DEFAULT_MAX_IDLE_MS),
			CLAUDE_KEEPALIVE_DEFAULT_MAX_IDLE_MS, intervalMs, CLAUDE_KEEPALIVE_MAX_IDLE_LIMIT_MS
		),
	};
}
