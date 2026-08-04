import type { PromptCacheUsage } from "./usage";

/**
 * Why an upstream prompt cache did not serve most of the prompt.
 *
 * The classification exists because a bare hit percentage is not actionable: a
 * rewritten history, a changed tool catalog, and a genuinely cold conversation
 * all look identical in the usage payload while requiring completely different
 * fixes.
 */
export type CacheMissReason =
	| "healthy"
	| "cold_start"
	| "request_params_changed"
	| "tool_catalog_changed"
	| "system_prompt_changed"
	| "history_rewritten"
	| "history_truncated"
	| "history_summarized"
	| "session_not_reused"
	| "upstream_expired"
	| "upstream_cache_pending"
	| "unknown";

/** Prompt-prefix comparison against the previous request of the same conversation. */
export interface CachePrefixTelemetry {
	previousRequestId?: string;
	staticFieldsMatch?: boolean;
	toolsMatch?: boolean;
	/** Advertised tool count of this request (0 = no tools). */
	toolsCount?: number;
	/** Advertised tool count of the previous request, when known. */
	previousToolsCount?: number;
	/** Hash of the first (system) message; undefined when no system message. */
	systemHash?: string;
	/** True when the system message changed since the previous request. */
	systemChanged?: boolean;
	identicalMessagePrefix?: number;
	messageCount?: number;
	previousMessageCount?: number;
	reusableMessagePercent?: number;
}

/** Session reuse signals reported by subscription runtimes. */
export interface CacheSessionTelemetry {
	/** False when the runtime had to start a fresh thread or SDK session. */
	reused?: boolean;
	/** Runtime specific explanation for a miss, e.g. a tool catalog change. */
	reuseMissReason?: string;
}

export interface CacheDiagnosticsInput {
	provider: string;
	modelId: string;
	requestId: string;
	usage?: PromptCacheUsage;
	prefix?: CachePrefixTelemetry;
	session?: CacheSessionTelemetry;
	/** True when auto-compaction ran this turn — always produces a cache miss. */
	autoCompacted?: boolean;
	/** True when the previous turn of this conversation compacted its history. */
	previousTurnCompacted?: boolean;
}

export interface CacheDiagnosticsReport extends Record<string, unknown> {
	provider: string;
	modelId: string;
	requestId: string;
	promptTokens?: number;
	cachedTokens?: number;
	uncachedTokens?: number;
	hitPercent?: number;
	missPercent?: number;
	reason: CacheMissReason;
	detail: string;
}

export interface CodexTurnCacheClassificationInput {
	threadMode?: string;
	threadReuseMissReason?: string;
	initialSegmentHitPercent?: number;
	finalSegmentHitPercent?: number;
	processedHitPercent?: number;
	/** Seconds since the reused thread's last request (idle gap). */
	idleGapSeconds?: number;
}

/** Separates a real cold first segment from the health of later Codex continuations. */
export function classifyCodexTurnCache(
	input: CodexTurnCacheClassificationInput
): { reason?: CacheMissReason; detail?: string } {
	const effectiveHit = input.finalSegmentHitPercent ?? input.processedHitPercent;
	if (effectiveHit === undefined) {
		return {};
	}
	const newThread = input.threadMode === "new";
	// A cold first segment is expected on a brand-new thread (nothing cached);
	// it only signals a problem when the thread was REUSED — the upstream
	// server-side cache entry expired between turns (idle TTL).
	const initialCold = !newThread && input.initialSegmentHitPercent !== undefined
		&& input.initialSegmentHitPercent <= 10;
	if (effectiveHit >= HEALTHY_HIT_PERCENT) {
		const coldStartDetail = initialCold
			? `The first segment was cold at ${formatHit(input.initialSegmentHitPercent)} — ` +
			  coldFirstSegmentCause(input.idleGapSeconds) +
			  ` Continuation recovered to ${formatHit(effectiveHit)}.`
			: undefined;
		return {
			reason: initialCold ? "upstream_expired" : "healthy",
			detail: newThread
				? `A new Codex thread was required (${input.threadReuseMissReason ?? "no compatible completed thread"}). ` +
				  (coldStartDetail ?? `Its first model segment was ${formatHit(input.initialSegmentHitPercent)}, then continuation recovered to ${formatHit(effectiveHit)}.`)
				: coldStartDetail,
		};
	}
	if (newThread) {
		return {
			reason: "session_not_reused",
			detail: `A new Codex thread was required (${input.threadReuseMissReason ?? "no compatible completed thread"}). Later model segments did not recover above ${HEALTHY_HIT_PERCENT}%.`,
		};
	}
	// Thread was reused: the upstream cache served little of the prompt.
	// This is either an expired long-lived thread with an accumulated large
	// delta, or the server compacted the context between turns.
	const initialNote = input.initialSegmentHitPercent !== undefined
		&& input.initialSegmentHitPercent <= 10
		? "initial segment " + formatHit(input.initialSegmentHitPercent) + "; "
		: "";
	return {
		reason: "upstream_expired",
		detail: initialNote
			+ "the thread was reused but the upstream cache entry expired "
			+ "or the server compacted the context between turns",
	};
}

/** Below this share of a reused prompt the miss is worth explaining. */
const HEALTHY_HIT_PERCENT = 90;

function formatHit(value: number | undefined): string {
	return value === undefined ? "unreported" : `${value.toFixed(1)}% cache hit`;
}

function classify(input: CacheDiagnosticsInput): { reason: CacheMissReason; detail: string } {
	const { usage, prefix, session } = input;
	if (!usage) {
		return { reason: "unknown", detail: "upstream reported no prompt cache counters" };
	}
	if (usage.hitPercent >= HEALTHY_HIT_PERCENT) {
		return { reason: "healthy", detail: "" };
	}

	if (session && session.reused === false) {
		return {
			reason: "session_not_reused",
			detail: session.reuseMissReason
				? `a fresh runtime session was started: ${session.reuseMissReason}`
				: "a fresh runtime session was started, so no prefix could be reused",
		};
	}

	if (!prefix || !prefix.previousRequestId) {
		if (session?.reused) {
			// Subscription runtimes own the transcript, so there is no local prefix
			// to compare; a reused session that still missed points upstream.
			return {
				reason: "upstream_expired",
				detail: "the runtime session was reused, so the upstream cache entry expired "
					+ "or this turn added a large uncached prefix",
			};
		}
		return {
			reason: "cold_start",
			detail: "first request of this conversation, nothing was cached upstream yet",
		};
	}
	if (prefix.staticFieldsMatch === false) {
		return {
			reason: "request_params_changed",
			detail: "sampling or request parameters changed, which invalidates the whole prefix",
		};
	}
	if (prefix.toolsMatch === false) {
		const toolDelta = prefix.toolsCount !== undefined && prefix.previousToolsCount !== undefined
			? ` (${prefix.previousToolsCount} → ${prefix.toolsCount} tools)`
			: "";
		return {
			reason: "tool_catalog_changed",
			detail: `the advertised tool catalog changed${toolDelta}, which rewrites the prompt before any message`,
		};
	}

	const identical = prefix.identicalMessagePrefix;
	const previousCount = prefix.previousMessageCount;
	if (identical !== undefined) {
		if (identical === 0) {
			return {
				reason: "system_prompt_changed",
				detail: prefix.systemChanged
					? "the first (system) message changed since the previous request — "
						+ "usually VS Code rewrites system instructions or history (e.g. after an interruption)"
					: "the first message already differs from the previous request",
			};
		}
		if (previousCount !== undefined && identical < previousCount) {
			const currentCount = prefix.messageCount ?? previousCount;
			const changedCount = previousCount - identical;
			const newCount = Math.max(0, currentCount - previousCount);
			const totalChanged = changedCount + newCount;
			const changedShare = previousCount > 0 ? totalChanged / previousCount : 1;
			const uncachedShare = usage.promptTokens > 0
				? usage.uncachedTokens / usage.promptTokens
				: 0;

			// Compaction replaced most of the history with a summary.
			if (input.autoCompacted || currentCount < previousCount * 0.3) {
				return {
					reason: "history_summarized",
					detail: `history was compacted from ${previousCount} to ${currentCount} messages ` +
						`(${usage.hitPercent.toFixed(1)}% hit — expected after compaction)`,
				};
			}

			// Few messages changed at the tail, but most tokens are uncached →
			// the real cause is upstream cache eviction, not the rewrite.
			if (changedShare < 0.3 && uncachedShare > changedShare * 2 + 0.15) {
				return {
					reason: "upstream_expired",
					detail: `${identical} of ${previousCount} messages matched ` +
						`(${(100 - changedShare * 100).toFixed(1)}% reusable), ` +
						`but the upstream cache entry expired (only ${usage.hitPercent.toFixed(1)}% hit)`,
				};
			}

			const reason: CacheMissReason = currentCount < previousCount
				&& identical >= currentCount
				? "history_truncated"
				: "history_rewritten";
			const detail = reason === "history_truncated"
				? `history shrank from ${previousCount} to ${currentCount} messages`
				: `history diverged at message ${identical} of ${previousCount}; `
					+ "an already sent message was rewritten, so everything after it missed";
			return { reason, detail };
		}

		// All prior messages matched byte-for-byte → the reused portion should be
		// fully cached.  A hit% below 90% is expected when several new messages
		// were appended this turn (they are uncached by definition).  Only flag a
		// problem when the hit% is suspiciously low despite a perfect prefix match.
		if (identical !== undefined && previousCount !== undefined && identical >= previousCount) {
			if (usage.hitPercent >= 70) {
				const newMsgs = (prefix.messageCount ?? previousCount) - previousCount;
				return {
					reason: "healthy",
					detail: `all ${previousCount} prior messages matched; ` +
						`${newMsgs} new message(s) added this turn`,
				};
			}
			if (input.previousTurnCompacted) {
				return {
					reason: "upstream_cache_pending",
					detail: `all ${previousCount} prior messages matched ` +
						`but only ${usage.hitPercent.toFixed(1)}% was cached — ` +
						`the previous turn compacted the history and the upstream disk-cache ` +
						`write was not yet readable (async write race)`,
				};
			}
			return {
				reason: "upstream_expired",
				detail: `all ${previousCount} prior messages matched ` +
					`but only ${usage.hitPercent.toFixed(1)}% was cached — ` +
					`upstream cache entry was evicted or expired`,
			};
		}
	}

	return {
		reason: "upstream_expired",
		detail: "the outgoing prefix was unchanged, so the upstream cache entry expired or was evicted",
	};
}

/**
 * Builds a uniform cache report so every provider explains a miss the same way.
 */
export function buildCacheDiagnostics(input: CacheDiagnosticsInput): CacheDiagnosticsReport {
	const { reason, detail } = classify(input);
	const usage = input.usage;
	return {
		provider: input.provider,
		modelId: input.modelId,
		requestId: input.requestId,
		promptTokens: usage?.promptTokens,
		cachedTokens: usage?.cachedTokens,
		uncachedTokens: usage?.uncachedTokens,
		hitPercent: usage?.hitPercent,
		missPercent: usage === undefined
			? undefined
			: Number((100 - usage.hitPercent).toFixed(1)),
		reason,
		detail,
		...(input.prefix ? { prefix: input.prefix } : {}),
		...(input.session ? { session: input.session } : {}),
	};
}

/** Derives prompt cache usage from Anthropic style cache-read/creation counters. */
export function promptCacheUsageFromCacheReads(
	inputTokens: number,
	cacheReadInputTokens: number,
	cacheCreationInputTokens: number
): PromptCacheUsage | undefined {
	const promptTokens = Math.max(0, inputTokens)
		+ Math.max(0, cacheReadInputTokens)
		+ Math.max(0, cacheCreationInputTokens);
	if (promptTokens === 0) {
		return undefined;
	}
	const cachedTokens = Math.min(promptTokens, Math.max(0, cacheReadInputTokens));
	return {
		promptTokens,
		cachedTokens,
		uncachedTokens: promptTokens - cachedTokens,
		hitPercent: Number(((cachedTokens / promptTokens) * 100).toFixed(1)),
	};
}
/**
 * Explains an unexplained cold first segment on a reused Codex thread.
 * A short idle gap (< 15 min) rules out TTL expiry and points to cache
 * eviction or a different backend instance serving the request.
 */
function coldFirstSegmentCause(idleGapSeconds: number | undefined): string {
        if (idleGapSeconds === undefined) {
                return "the upstream cache did not serve the prefix (TTL expiry, eviction, or a different backend).";
        }
        if (idleGapSeconds < 15 * 60) {
                return `the thread was idle only ${formatIdleGap(idleGapSeconds)}, so TTL expiry is unlikely — ` +
                        "the cache entry was evicted or the request was routed to a different backend.";
        }
        return `the thread was idle ${formatIdleGap(idleGapSeconds)} — consistent with server-side TTL expiry.`;
}

function formatIdleGap(seconds: number): string {
        if (seconds < 90) {
                return `${Math.max(1, Math.round(seconds))}s`;
        }
        if (seconds < 3600) {
                return `${Math.round(seconds / 60)}min`;
        }
        return `${(seconds / 3600).toFixed(1)}h`;
}