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
	targetRatio?: number;
}

/**
 * Chooses whether to compact for a request. A single soft scheme is used in
 * every case: proactively when the context passes the soft target, and
 * unconditionally on a confirmed overflow retry. Both use the configured
 * target ratio, so proactive and overflow compaction have identical behavior.
 */
export function selectContextCompaction(
	input: ContextCompactionDecisionInput
): ContextCompactionDecision {
	if (input.overflowRetry || (input.autoCompact && input.messageTokens > input.softInputTarget)) {
		return {
			kind: "auto",
			target: Math.max(1, Math.floor(input.messageTokens * normalizeCompactionTargetRatio(input.targetRatio))),
		};
	}
	return { kind: "none" };
}

/**
 * How much of the current message context a compaction should retain. The
 * default keeps 75% (a 25% reduction), while users can select an extreme 25%
 * target (a 75% reduction). Ratios outside the supported range are clamped so a malformed
 * setting cannot erase nearly all history or leave no useful headroom.
 */
export const DEFAULT_COMPACTION_TARGET_RATIO = 0.75;
export const MIN_COMPACTION_TARGET_RATIO = 0.25;
export const MAX_COMPACTION_TARGET_RATIO = 0.9;

export function normalizeCompactionTargetRatio(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_COMPACTION_TARGET_RATIO;
	}
	return Math.max(MIN_COMPACTION_TARGET_RATIO, Math.min(MAX_COMPACTION_TARGET_RATIO, parsed));
}

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
