import type { OpenAIChatMessage } from "../types";
import type { PromptCacheUsage } from "./usage";

/**
 * Replaces the "Current date: YYYY-MM-DD" line in a system prompt with a
 * constant, so two prompts that differ only by the calendar date hash equal.
 * VS Code rewrites the injected date every midnight; without this the first
 * turn of each day looks like a real system change and defeats the cache.
 */
export function normalizeSystemDate(systemText: string): string {
	return systemText.replace(/Current date: \d{4}-\d{2}-\d{2}/g, "Current date: <date>");
}

/**
 * Blocks that VS Code re-generates from live editor state on every request:
 * open terminals and their last exit code, the workspace file tree, attached
 * context. They sit in the *first* user message, so a single new file in the
 * workspace root rewrites message #1 and invalidates the whole prompt cache
 * behind it.
 */
const VOLATILE_HOST_BLOCKS: readonly RegExp[] = [
	/<environment_info>[\s\S]*?<\/environment_info>/g,
	/<workspace_info>[\s\S]*?<\/workspace_info>/g,
	/<context>[\s\S]*?<\/context>/g,
	/<attachments>[\s\S]*?<\/attachments>/g,
	/<reminderInstructions>[\s\S]*?<\/reminderInstructions>/g,
];

/** Masks host-regenerated context so two renderings of one message compare equal. */
export function normalizeVolatileHostContext(text: string): string {
	let normalized = text;
	for (const pattern of VOLATILE_HOST_BLOCKS) {
		normalized = normalized.replace(pattern, "<host-context/>");
	}
	return normalized;
}

function toolCallIds(message: OpenAIChatMessage): string {
	return (message.tool_calls ?? []).map(call => call.id).join(" ");
}

function stableMessageText(message: OpenAIChatMessage): string {
	const content = typeof message.content === "string"
		? message.content
		: JSON.stringify(message.content ?? "");
	return normalizeSystemDate(normalizeVolatileHostContext(content));
}

/**
 * True when two renderings describe the same conversation entry.
 *
 * The host re-renders history between turns: tool results get re-summarized or
 * re-truncated and context blocks are regenerated, so byte equality reports
 * "different" for messages the model already saw. Tool call ids are unique per
 * call and survive every re-render, which makes them a reliable anchor; the
 * remaining turns fall back to their text with volatile blocks masked out.
 */
/**
 * Comparable identity of a message, for indexed lookups over long histories.
 * Messages without a stable anchor get a position-unique key so they can never
 * be mistaken for another message.
 */
export function conversationMessageKey(message: OpenAIChatMessage, index: number): string {
	if (message.role === "tool") {
		return message.tool_call_id ? `tool:${message.tool_call_id}` : `tool@${index}`;
	}
	const callIds = toolCallIds(message);
	if (callIds.length > 0) {
		return `calls:${callIds}`;
	}
	return `${message.role}:${stableMessageText(message)}`;
}

export function isSameConversationMessage(a: OpenAIChatMessage, b: OpenAIChatMessage): boolean {
	if (a.role !== b.role) {
		return false;
	}
	if (a.role === "tool") {
		return Boolean(a.tool_call_id) && a.tool_call_id === b.tool_call_id;
	}
	const callIds = toolCallIds(a);
	if (callIds !== toolCallIds(b)) {
		return false;
	}
	if (callIds.length > 0) {
		return true;
	}
	return stableMessageText(a) === stableMessageText(b);
}

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
	| "date_rollover"
	| "history_rebuilt_after_restart"
	| "history_rewritten"
	| "history_truncated"
	| "history_summarized"
	| "ephemeral_context_changed"
	| "session_not_reused"
	| "upstream_route_changed"
	| "upstream_cache_partial"
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
	/** Tool names removed since the previous request (when the catalog changed). */
	removedTools?: string[];
	/** Tool names added since the previous request (when the catalog changed). */
	addedTools?: string[];
	/** Hash of the first (system) message; undefined when no system message. */
	systemHash?: string;
	/** systemHash with the date line normalized away (rollover detection). */
	systemHashNormalized?: string;
	/** Normalized system hash of the previous request, when known. */
	previousSystemHashNormalized?: string;
	/** True when the system message changed since the previous request. */
	systemChanged?: boolean;
	identicalMessagePrefix?: number;
	messageCount?: number;
	previousMessageCount?: number;
	reusableMessagePercent?: number;
	/** Hash and size of provider-only memory/guard messages sent outside durable history. */
	ephemeralHash?: string;
	previousEphemeralHash?: string;
	ephemeralChanged?: boolean;
	ephemeralChars?: number;
	previousEphemeralChars?: number;
}

/** Session reuse signals reported by subscription runtimes. */
export interface CacheSessionTelemetry {
	/** False when the runtime had to start a fresh thread or SDK session. */
	reused?: boolean;
	/** Runtime specific explanation for a miss, e.g. a tool catalog change. */
	reuseMissReason?: string;
}

/** Upstream route and previous prompt-size signals used to explain cache misses. */
export interface CacheBackendTelemetry {
	currentVia?: string;
	previousVia?: string;
	currentCfPop?: string;
	previousCfPop?: string;
	/** Server-reported prompt size for the prior request of this conversation. */
	previousPromptTokens?: number;
}

export interface CacheDiagnosticsInput {
	provider: string;
	modelId: string;
	requestId: string;
	usage?: PromptCacheUsage;
	prefix?: CachePrefixTelemetry;
	session?: CacheSessionTelemetry;
	backend?: CacheBackendTelemetry;
	/** True when auto-compaction ran this turn — always produces a cache miss. */
	autoCompacted?: boolean;
	/** True when the previous turn of this conversation compacted its history. */
	previousTurnCompacted?: boolean;
	/** First request for this conversation scope since extension-host startup. */
	firstRequestSinceStartup?: boolean;
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

interface PerfectPrefixCacheAnalysis {
	expectedNewTokens: number;
	lostPreviouslySentTokens: number;
	lostPriorSharePercent: number;
	materialLoss: boolean;
}

function changedRouteValue(previous: string | undefined, current: string | undefined): boolean {
	return Boolean(previous && current && previous !== current);
}

function backendRouteChanged(backend: CacheBackendTelemetry | undefined): boolean {
	return Boolean(backend) && (
		changedRouteValue(backend?.previousVia, backend?.currentVia)
		|| changedRouteValue(backend?.previousCfPop, backend?.currentCfPop)
	);
}

/**
 * Measures how much of the already-sent prompt stopped being cache-readable.
 *
 * Comparing hit percentage or total uncached tokens is misleading: a large new
 * tool result is correctly uncached. With a byte-stable durable prefix, the
 * actionable signal is previousPromptTokens - currentCachedTokens. A loss is
 * material only when it is at least 2K tokens and 4% of the previous prompt;
 * smaller chunk-rounding/visibility gaps remain healthy.
 */
function analyzePerfectPrefixCache(input: CacheDiagnosticsInput): PerfectPrefixCacheAnalysis | undefined {
	const { usage, prefix, backend } = input;
	if (
		!usage
		|| input.autoCompacted
		|| !prefix?.previousRequestId
		|| prefix.staticFieldsMatch !== true
		|| prefix.toolsMatch !== true
		|| prefix.identicalMessagePrefix === undefined
		|| prefix.previousMessageCount === undefined
		|| prefix.identicalMessagePrefix < prefix.previousMessageCount
		|| backend?.previousPromptTokens === undefined
	) {
		return undefined;
	}
	const expectedNewTokens = Math.max(0, usage.promptTokens - backend.previousPromptTokens);
	const lostPreviouslySentTokens = Math.max(0, backend.previousPromptTokens - usage.cachedTokens);
	const lostPriorShare = backend.previousPromptTokens > 0
		? lostPreviouslySentTokens / backend.previousPromptTokens
		: 0;
	return {
		expectedNewTokens,
		lostPreviouslySentTokens,
		lostPriorSharePercent: Number((lostPriorShare * 100).toFixed(1)),
		materialLoss: lostPreviouslySentTokens >= Math.max(2_048, backend.previousPromptTokens * 0.04),
	};
}

function formatRouteChange(backend: CacheBackendTelemetry | undefined): string {
	const changes: string[] = [];
	if (changedRouteValue(backend?.previousCfPop, backend?.currentCfPop)) {
		changes.push(`${backend?.previousCfPop} → ${backend?.currentCfPop}`);
	}
	if (changedRouteValue(backend?.previousVia, backend?.currentVia)) {
		changes.push(`${backend?.previousVia} → ${backend?.currentVia}`);
	}
	return changes.join("; ");
}

function classify(input: CacheDiagnosticsInput): { reason: CacheMissReason; detail: string } {
	const { usage, prefix, session } = input;
	if (!usage) {
		return { reason: "unknown", detail: "upstream reported no prompt cache counters" };
	}
	const perfectPrefixCache = analyzePerfectPrefixCache(input);
	if (perfectPrefixCache?.materialLoss) {
		const missDetail = `${perfectPrefixCache.lostPreviouslySentTokens.toLocaleString("en-US")} `
			+ `previously sent tokens stopped being cache-readable (${perfectPrefixCache.lostPriorSharePercent.toFixed(1)}% `
			+ `of the prior prompt); this turn added ${perfectPrefixCache.expectedNewTokens.toLocaleString("en-US")} tokens `
			+ `and reported ${usage.uncachedTokens.toLocaleString("en-US")} uncached in total`;
		if (prefix?.ephemeralChanged) {
			return {
				reason: "upstream_cache_partial",
				detail: `${missDetail}; a tail-only provider guard/nudge changed `
					+ `(${prefix.previousEphemeralChars ?? 0} → ${prefix.ephemeralChars ?? 0} chars), `
					+ "but it was appended after the reusable prefix and cannot explain loss of previously cached tokens",
			};
		}
		if (input.previousTurnCompacted) {
			return {
				reason: "upstream_cache_pending",
				detail: `${missDetail}; the previous turn compacted the history, so its new cache prefix is still only partially readable upstream`,
			};
		}
		const routeDetail = backendRouteChanged(input.backend)
			? `the observed CloudFront route also changed (${formatRouteChange(input.backend)}); `
				+ "that coincided with the loss but does not identify the internal DeepSeek cache shard"
			: "the visible CloudFront route stayed unchanged, so the fluctuation occurred behind that edge or inside the upstream cache tier";
		return {
			reason: "upstream_cache_partial",
			detail: `${missDetail}; ${routeDetail}`,
		};
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
		// A same-count catalog change (e.g. an MCP server swapped its tool set
		// between restarts) is invisible in the count — surface the actual diff.
		const removed = Array.isArray(prefix.removedTools) && prefix.removedTools.length > 0
			? prefix.removedTools.join(", ")
			: "";
		const added = Array.isArray(prefix.addedTools) && prefix.addedTools.length > 0
			? prefix.addedTools.join(", ")
			: "";
		const toolDiff = removed || added
			? ` — removed: ${removed || "none"}, added: ${added || "none"}`
			: "";
		return {
			reason: "tool_catalog_changed",
			detail: `the advertised tool catalog changed${toolDelta}${toolDiff}, which rewrites the prompt before any message`,
		};
	}

	const identical = prefix.identicalMessagePrefix;
	const previousCount = prefix.previousMessageCount;
	if (identical !== undefined) {
		if (identical === 0) {
			if (
				prefix.systemChanged
				&& prefix.systemHashNormalized
				&& prefix.previousSystemHashNormalized === prefix.systemHashNormalized
			) {
				return {
					reason: "date_rollover",
					detail: "the system prompt differs only by the current date — VS Code rewrites it at midnight, so the first turn of each day starts uncached (expected once per day)",
				};
			}
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

			if (input.firstRequestSinceStartup) {
				return {
					reason: "history_rebuilt_after_restart",
					detail: `first request for this conversation after extension-host startup: `
						+ `the persisted ${previousCount}-message prefix and the host-rebuilt `
						+ `${currentCount}-message history diverged at message ${identical}; `
						+ "the resulting cold rewrite is expected for this reconstructed transcript",
				};
			}

			// Few messages changed at the tail, but most tokens are uncached →
			// the rewrite alone cannot explain the observed upstream cache loss.
			if (changedShare < 0.3 && uncachedShare > changedShare * 2 + 0.15) {
				return {
					reason: input.provider === "deepseek" || input.provider === "local"
					? "upstream_cache_partial"
					: "upstream_expired",
					detail: `${identical} of ${previousCount} messages matched ` +
						`(${(100 - changedShare * 100).toFixed(1)}% reusable), ` +
						`but the cache loss was much larger than that rewrite ` +
						`(only ${usage.hitPercent.toFixed(1)}% hit)`,
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
			if (input.backend?.previousPromptTokens !== undefined) {
				const expectedNewTokens = Math.max(
					0,
					usage.promptTokens - input.backend.previousPromptTokens
				);
				const unexplainedTokens = Math.max(0, usage.uncachedTokens - expectedNewTokens);
				return {
					reason: "healthy",
					detail: `all ${previousCount} prior messages matched; prompt grew by `
						+ `${expectedNewTokens.toLocaleString("en-US")} tokens and the remaining `
						+ `${unexplainedTokens.toLocaleString("en-US")} uncached tokens stayed below the anomaly threshold`,
				};
			}
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
				reason: input.provider === "deepseek" || input.provider === "local"
					? "upstream_cache_partial"
					: "upstream_expired",
				detail: `all ${previousCount} prior messages matched ` +
					`but only ${usage.hitPercent.toFixed(1)}% was cached — ` +
					`the upstream cache returned only a partial copy of the unchanged prefix`,
			};
		}
	}

	return {
		reason: input.provider === "deepseek" || input.provider === "local"
			? "upstream_cache_partial"
			: "upstream_expired",
		detail: "the outgoing prefix was unchanged, but the upstream cache returned only part of it",
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
		...(input.backend ? { backend: input.backend } : {}),
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