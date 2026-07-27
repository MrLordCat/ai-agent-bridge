interface ContextBudgetInput {
	contextLength: number;
	contextUtilization: number;
	hardContextUtilization: number;
	maxOutputTokens: number;
	minReplyReserveTokens: number;
	toolTokens: number;
}

export interface ContextBudget {
	modelInputLimit: number;
	inputBudget: number;
	replyReserveTokens: number;
	softInputTarget: number;
	hardInputTarget: number;
}

interface ContextUsageEstimate {
	estimatedUsedTokens: number;
	estimatedFreeTokens: number;
	estimatedUsagePercent: number;
}

export function calculateContextBudget(input: ContextBudgetInput): ContextBudget {
	const modelInputLimit = Math.max(1, Math.floor(input.contextLength));
	const inputBudget = Math.max(1, Math.floor(modelInputLimit * input.contextUtilization));
	const replyReserveTokens = Math.max(input.minReplyReserveTokens, input.maxOutputTokens);
	const softInputTarget = Math.max(1, inputBudget - replyReserveTokens - input.toolTokens);
	const hardInputTarget = Math.max(
		1,
		Math.floor(modelInputLimit * input.hardContextUtilization) - replyReserveTokens - input.toolTokens
	);

	return {
		modelInputLimit,
		inputBudget,
		replyReserveTokens,
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
