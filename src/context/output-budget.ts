interface OutputTokenBudgetInput {
	family: string;
	requestedMaxTokens?: number;
	modelMaxOutputTokens: number;
	hardCap: number;
	localDefault: number;
	deepSeekDefault: number;
	deepSeekMaximum: number;
}

interface OutputTokenBudget {
	defaultMaxTokens: number;
	requestedMaxTokens: number;
	maxTokens: number;
	requestProvidedLimit: boolean;
}

function clampInteger(value: number, minimum: number, maximum: number, fallback: number): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

export function resolveOutputTokenBudget(input: OutputTokenBudgetInput): OutputTokenBudget {
	const isDeepSeek = input.family.toLowerCase() === "deepseek";
	const defaultMaximum = isDeepSeek ? input.deepSeekMaximum : 131072;
	const configuredDefault = isDeepSeek ? input.deepSeekDefault : input.localDefault;
	const defaultMaxTokens = clampInteger(configuredDefault, 1024, defaultMaximum, isDeepSeek ? 131072 : 32768);
	const requestProvidedLimit = typeof input.requestedMaxTokens === "number" && Number.isFinite(input.requestedMaxTokens);
	const requestedMaxTokens = clampInteger(
		requestProvidedLimit ? input.requestedMaxTokens as number : defaultMaxTokens,
		1,
		input.deepSeekMaximum,
		defaultMaxTokens
	);
	const effectiveModelLimit = isDeepSeek
		? Math.max(1, input.modelMaxOutputTokens, input.deepSeekMaximum)
		: Math.max(1, input.modelMaxOutputTokens);
	const hardCap = clampInteger(input.hardCap, 1, input.deepSeekMaximum, defaultMaxTokens);

	return {
		defaultMaxTokens,
		requestedMaxTokens,
		maxTokens: Math.max(1, Math.min(requestedMaxTokens, effectiveModelLimit, hardCap)),
		requestProvidedLimit,
	};
}
