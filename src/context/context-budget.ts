interface ContextBudgetInput {
	contextLength: number;
	contextUtilization: number;
	hardContextUtilization: number;
	maxOutputTokens: number;
	minReplyReserveTokens: number;
	replyReservePercent: number;
	toolTokens: number;
}

export interface ContextBudget {
	modelInputLimit: number;
	inputBudget: number;
	replyReserveTokens: number;
	replyReservePercent: number;
	softInputTarget: number;
	hardInputTarget: number;
}

interface ContextUsageEstimate {
	estimatedUsedTokens: number;
	estimatedFreeTokens: number;
	estimatedUsagePercent: number;
}

export type ContextCompactionDecision =
	| { kind: "none" }
	| { kind: "auto"; target: number };

interface ContextCompactionDecisionInput {
	messageTokens: number;
	autoCompact: boolean;
	softInputTarget: number;
	overflowRetry: boolean;
}

/**
 * Chooses whether to compact for a request. A single soft scheme is used in
 * every case: proactively when the context passes the soft target, and
 * unconditionally on a confirmed overflow retry. Both compact to 75% of the
 * current size (COMPACTION_TARGET_RATIO), so the logic stays simple and the
 * prompt cache is only rewritten when a rewrite is actually needed.
 */
export function selectContextCompaction(
	input: ContextCompactionDecisionInput
): ContextCompactionDecision {
	if (input.overflowRetry || (input.autoCompact && input.messageTokens > input.softInputTarget)) {
		return {
			kind: "auto",
			target: Math.max(1, Math.floor(input.messageTokens * COMPACTION_TARGET_RATIO)),
		};
	}
	return { kind: "none" };
}

/**
 * How much of the current context a compaction should retain. A single soft
 * scheme is used for both proactive compaction and overflow retries: it keeps
 * ~75% of the current message tokens (a ~25% reduction). Compacting to exactly
 * the trigger threshold would re-trigger on the very next turn (a
 * micro-compaction), so the 25% reduction doubles as the headroom that makes
 * one compaction last for many turns. Raised from 0.6 (2026-08-07): a 40%
 * reduction was eating too much working context for agent chats.
 */
export const COMPACTION_TARGET_RATIO = 0.75;

/** Updates the heuristic token multiplier from the latest server observation. */
export function updateHeuristicCalibration(
	previousFactor: number,
	residualRatio: number,
	alpha = 0.3
): number {
	const normalizedPrevious = Math.max(0.2, Math.min(3.0, previousFactor));
	const clampedRatio = Math.max(0.2, Math.min(3.0, residualRatio));
	const observedTarget = Math.max(0.2, Math.min(3.0, normalizedPrevious * clampedRatio));
	const normalizedAlpha = Math.max(0, Math.min(1, alpha));
	return normalizedPrevious * (1 - normalizedAlpha) + observedTarget * normalizedAlpha;
}

export function calculateContextBudget(input: ContextBudgetInput): ContextBudget {
	const modelInputLimit = Math.max(1, Math.floor(input.contextLength));
	const inputBudget = Math.max(1, Math.floor(modelInputLimit * input.contextUtilization));
	const replyReserveCap = Math.floor(input.contextLength * input.replyReservePercent);
	const replyReserveTokens = Math.max(
		input.minReplyReserveTokens,
		Math.min(input.maxOutputTokens, replyReserveCap)
	);
	const softInputTarget = Math.max(1, inputBudget - replyReserveTokens - input.toolTokens);
	const hardInputTarget = Math.max(
		1,
		Math.floor(modelInputLimit * input.hardContextUtilization) - replyReserveTokens - input.toolTokens
	);

	return {
		modelInputLimit,
		inputBudget,
		replyReserveTokens,
		replyReservePercent: input.replyReservePercent,
		softInputTarget,
		hardInputTarget,
	};
}

export function estimateContextUsage(
	contextLength: number,
	messageTokens: number,
	toolTokens: number,
	replyReserveTokens: number
): ContextUsageEstimate {
	const normalizedContextLength = Math.max(1, Math.floor(contextLength));
	const estimatedUsedTokens = Math.max(0, messageTokens + toolTokens + replyReserveTokens);
	const estimatedFreeTokens = Math.max(0, normalizedContextLength - estimatedUsedTokens);
	const estimatedUsagePercent = Number(
		((estimatedUsedTokens / normalizedContextLength) * 100).toFixed(1)
	);

	return {
		estimatedUsedTokens,
		estimatedFreeTokens,
		estimatedUsagePercent,
	};
}
