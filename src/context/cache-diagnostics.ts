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
	| "session_not_reused"
	| "upstream_expired"
	| "unknown";

/** Prompt-prefix comparison against the previous request of the same conversation. */
export interface CachePrefixTelemetry {
	previousRequestId?: string;
	staticFieldsMatch?: boolean;
	toolsMatch?: boolean;
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

/** Below this share of a reused prompt the miss is worth explaining. */
const HEALTHY_HIT_PERCENT = 90;

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
		return {
			reason: "tool_catalog_changed",
			detail: "the advertised tool catalog changed, which rewrites the prompt before any message",
		};
	}

	const identical = prefix.identicalMessagePrefix;
	const previousCount = prefix.previousMessageCount;
	if (identical !== undefined) {
		if (identical === 0) {
			return {
				reason: "system_prompt_changed",
				detail: "the first message already differs from the previous request",
			};
		}
		if (previousCount !== undefined && identical < previousCount) {
			const reason: CacheMissReason = prefix.messageCount !== undefined
				&& prefix.messageCount < previousCount
				&& identical >= prefix.messageCount
				? "history_truncated"
				: "history_rewritten";
			const detail = reason === "history_truncated"
				? `history shrank from ${previousCount} to ${prefix.messageCount} messages`
				: `history diverged at message ${identical} of ${previousCount}; `
					+ "an already sent message was rewritten, so everything after it missed";
			return { reason, detail };
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
