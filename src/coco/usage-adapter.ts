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

export interface CocoTokenUsage {
	/** Total processed input, including cache reads and writes. */
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens?: number;
	cacheWriteInputTokens?: number;
}

/** ACP inputTokens excludes cache; cachedReadTokens/cachedWriteTokens are separate. */
export function parseCocoTokenUsage(result: unknown): CocoTokenUsage | undefined {
	if (!result || typeof result !== "object") { return undefined; }
	const usage = (result as Record<string, unknown>).usage;
	if (!usage || typeof usage !== "object") { return undefined; }
	const value = usage as Record<string, unknown>;
	const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
	if (!valid(value.inputTokens) || !valid(value.outputTokens)) { return undefined; }
	for (const name of ["cachedReadTokens", "cachedWriteTokens"]) {
		if (value[name] !== undefined && !valid(value[name])) { return undefined; }
	}
	const cached = value.cachedReadTokens as number | undefined, written = value.cachedWriteTokens as number | undefined;
	const total = value.inputTokens + (cached ?? 0) + (written ?? 0);
	if (!Number.isSafeInteger(total)) { return undefined; }
	return { inputTokens: total, outputTokens: value.outputTokens, cachedInputTokens: cached, cacheWriteInputTokens: written };
}

export function sumCocoUsage(items: readonly CocoTokenUsage[]): CocoTokenUsage | undefined {
	if (!items.length) { return undefined; }
	return {
		inputTokens: items.reduce((n, u) => n + u.inputTokens, 0), outputTokens: items.reduce((n, u) => n + u.outputTokens, 0),
		cachedInputTokens: items.every(u => u.cachedInputTokens !== undefined) ? items.reduce((n, u) => n + u.cachedInputTokens!, 0) : undefined,
		cacheWriteInputTokens: items.every(u => u.cacheWriteInputTokens !== undefined) ? items.reduce((n, u) => n + u.cacheWriteInputTokens!, 0) : undefined,
	};
}