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
	| { kind: "auto" | "hard"; target: number };

interface ContextCompactionDecisionInput {
	messageTokens: number;
	autoCompact: boolean;
	softInputTarget: number;
	hardInputTarget: number;
	overflowRetry: boolean;
}

/**
 * Chooses one compaction tier for a request.
 *
 * Normal requests may compact to the soft target. The lower hard target is
 * deliberately reserved for a retry after the backend confirms an overflow;
 * applying both tiers to one normal request needlessly rewrites the prompt and
 * destroys an otherwise reusable DeepSeek cache prefix.
 */
export function selectContextCompaction(
	input: ContextCompactionDecisionInput
): ContextCompactionDecision {
	if (input.overflowRetry) {
		return { kind: "hard", target: Math.max(1, Math.floor(input.hardInputTarget)) };
	}
	if (input.autoCompact && input.messageTokens > input.softInputTarget) {
		return { kind: "auto", target: Math.max(1, Math.floor(input.softInputTarget)) };
	}
	return { kind: "none" };
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
