export interface CocoContextUsage {
	usedTokens: number;
	contextWindowTokens: number;
}

/** ACP used/size describe the current context, not cumulative billable tokens. */
export function parseCocoContextUsage(update: unknown): CocoContextUsage | undefined {
	if (!update || typeof update !== "object") { return undefined; }
	const data = update as Record<string, unknown>;
	if (data.sessionUpdate !== "usage_update" || typeof data.used !== "number" || typeof data.size !== "number"
		|| !Number.isSafeInteger(data.used) || !Number.isSafeInteger(data.size) || data.used < 0 || data.size <= 0) {
		return undefined;
	}
	return { usedTokens: data.used, contextWindowTokens: data.size };
}

export function createCocoNativeContextUsage(usage: CocoContextUsage): { prompt_tokens: number; total_tokens: number } {
	// ACP does not split this footprint into input/output/cache tokens. Do not invent those counters.
	return { prompt_tokens: usage.usedTokens, total_tokens: usage.usedTokens };
}