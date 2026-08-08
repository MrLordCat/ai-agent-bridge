import * as vscode from "vscode";
import { nonNegativeInteger } from "./utils";

export type TokenUsageProvider = "local" | "deepseek" | "codex" | "claude";

export interface TokenUsageSample {
	provider: TokenUsageProvider;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens?: number;
	cacheWriteInputTokens?: number;
	reasoningOutputTokens?: number;
	requests?: number;
	modelTurns?: number;
	durationMs?: number;
	estimated?: boolean;
	recordedAt?: number;
}

export interface TokenUsageAggregate {
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	cacheWriteInputTokens: number;
	cacheEligibleInputTokens: number;
	cacheReportedRequests: number;
	zeroCacheReadRequests: number;
	reasoningOutputTokens: number;
	modelTurns: number;
	durationMs: number;
	estimatedRequests: number;
}

export interface TokenUsagePeriodSummary {
	providers: Record<TokenUsageProvider, TokenUsageAggregate>;
	total: TokenUsageAggregate;
}

export interface TokenUsageHistorySummary {
	today: TokenUsagePeriodSummary;
	week: TokenUsagePeriodSummary;
}

interface PersistedTokenUsageHistory {
	version: 1;
	days: Record<string, Partial<Record<TokenUsageProvider, TokenUsageAggregate>>>;
}

const STORAGE_KEY = "llamacpp.tokenUsageHistory.v1";
const RETENTION_DAYS = 35;
export const TOKEN_USAGE_PROVIDERS: readonly TokenUsageProvider[] = [
	"local",
	"deepseek",
	"codex",
	"claude",
];

export function emptyTokenUsageAggregate(): TokenUsageAggregate {
	return {
		requests: 0,
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
		cacheWriteInputTokens: 0,
		cacheEligibleInputTokens: 0,
		cacheReportedRequests: 0,
		zeroCacheReadRequests: 0,
		reasoningOutputTokens: 0,
		modelTurns: 0,
		durationMs: 0,
		estimatedRequests: 0,
	};
}

export function emptyTokenUsagePeriodSummary(): TokenUsagePeriodSummary {
	const providers = Object.fromEntries(
		TOKEN_USAGE_PROVIDERS.map(provider => [provider, emptyTokenUsageAggregate()])
	) as Record<TokenUsageProvider, TokenUsageAggregate>;
	return { providers, total: emptyTokenUsageAggregate() };
}

export function emptyTokenUsageHistorySummary(): TokenUsageHistorySummary {
	return {
		today: emptyTokenUsagePeriodSummary(),
		week: emptyTokenUsagePeriodSummary(),
	};
}

function normalizeAggregate(value: unknown): TokenUsageAggregate {
	const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
	return {
		requests: nonNegativeInteger(record.requests),
		inputTokens: nonNegativeInteger(record.inputTokens),
		outputTokens: nonNegativeInteger(record.outputTokens),
		cachedInputTokens: nonNegativeInteger(record.cachedInputTokens),
		cacheWriteInputTokens: nonNegativeInteger(record.cacheWriteInputTokens),
		cacheEligibleInputTokens: nonNegativeInteger(record.cacheEligibleInputTokens),
		cacheReportedRequests: nonNegativeInteger(record.cacheReportedRequests),
		zeroCacheReadRequests: nonNegativeInteger(record.zeroCacheReadRequests),
		reasoningOutputTokens: nonNegativeInteger(record.reasoningOutputTokens),
		modelTurns: nonNegativeInteger(record.modelTurns),
		durationMs: nonNegativeInteger(record.durationMs),
		estimatedRequests: nonNegativeInteger(record.estimatedRequests),
	};
}

export function mergeTokenUsageAggregates(
	left: TokenUsageAggregate,
	right: TokenUsageAggregate
): TokenUsageAggregate {
	return {
		requests: left.requests + right.requests,
		inputTokens: left.inputTokens + right.inputTokens,
		outputTokens: left.outputTokens + right.outputTokens,
		cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
		cacheWriteInputTokens: left.cacheWriteInputTokens + right.cacheWriteInputTokens,
		cacheEligibleInputTokens: left.cacheEligibleInputTokens + right.cacheEligibleInputTokens,
		cacheReportedRequests: left.cacheReportedRequests + right.cacheReportedRequests,
		zeroCacheReadRequests: left.zeroCacheReadRequests + right.zeroCacheReadRequests,
		reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
		modelTurns: left.modelTurns + right.modelTurns,
		durationMs: left.durationMs + right.durationMs,
		estimatedRequests: left.estimatedRequests + right.estimatedRequests,
	};
}

export function tokenUsageCacheHitPercent(usage: TokenUsageAggregate): number | undefined {
	return usage.cacheReportedRequests > 0 && usage.cacheEligibleInputTokens > 0
		? usage.cachedInputTokens / usage.cacheEligibleInputTokens * 100
		: undefined;
}

export function localDayKey(timestamp: number): string {
	const date = new Date(timestamp);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function recentLocalDayKeys(timestamp: number, count: number): string[] {
	const date = new Date(timestamp);
	const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	return Array.from({ length: count }, (_, offset) => {
		const candidate = new Date(midnight);
		candidate.setDate(midnight.getDate() - offset);
		return localDayKey(candidate.getTime());
	});
}

function normalizePersisted(value: unknown): PersistedTokenUsageHistory {
	const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
	const rawDays = candidate.days && typeof candidate.days === "object"
		? candidate.days as Record<string, unknown>
		: {};
	const days: PersistedTokenUsageHistory["days"] = {};
	for (const [day, rawProviders] of Object.entries(rawDays)) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !rawProviders || typeof rawProviders !== "object") {
			continue;
		}
		const providers: Partial<Record<TokenUsageProvider, TokenUsageAggregate>> = {};
		for (const provider of TOKEN_USAGE_PROVIDERS) {
			const raw = (rawProviders as Record<string, unknown>)[provider];
			if (raw !== undefined) {
				providers[provider] = normalizeAggregate(raw);
			}
		}
		days[day] = providers;
	}
	return { version: 1, days };
}

function createPeriod(
	days: PersistedTokenUsageHistory["days"],
	dayKeys: readonly string[]
): TokenUsagePeriodSummary {
	const providers = Object.fromEntries(
		TOKEN_USAGE_PROVIDERS.map(provider => {
			let aggregate = emptyTokenUsageAggregate();
			for (const day of dayKeys) {
				const value = days[day]?.[provider];
				if (value) {
					aggregate = mergeTokenUsageAggregates(aggregate, value);
				}
			}
			return [provider, aggregate];
		})
	) as Record<TokenUsageProvider, TokenUsageAggregate>;
	const total = TOKEN_USAGE_PROVIDERS.reduce(
		(aggregate, provider) => mergeTokenUsageAggregates(aggregate, providers[provider]),
		emptyTokenUsageAggregate()
	);
	return { providers, total };
}

export class TokenUsageHistory implements vscode.Disposable {
	private readonly changes = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changes.event;
	private data: PersistedTokenUsageHistory;
	private persistQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly memento: vscode.Memento,
		private readonly onPersistError?: (error: Error) => void,
		private readonly now: () => number = Date.now
	) {
		this.data = normalizePersisted(memento.get<unknown>(STORAGE_KEY));
		this.prune();
	}

	get summary(): TokenUsageHistorySummary {
		const now = this.now();
		return {
			today: createPeriod(this.data.days, recentLocalDayKeys(now, 1)),
			week: createPeriod(this.data.days, recentLocalDayKeys(now, 7)),
		};
	}

	record(sample: TokenUsageSample): void {
		const inputTokens = nonNegativeInteger(sample.inputTokens);
		const outputTokens = nonNegativeInteger(sample.outputTokens);
		const requests = Math.max(1, nonNegativeInteger(sample.requests ?? 1));
		const cachedInputTokens = sample.cachedInputTokens === undefined
			? undefined
			: Math.min(inputTokens, nonNegativeInteger(sample.cachedInputTokens));
		const day = localDayKey(sample.recordedAt ?? this.now());
		const current = this.data.days[day]?.[sample.provider] ?? emptyTokenUsageAggregate();
		const increment: TokenUsageAggregate = {
			requests,
			inputTokens,
			outputTokens,
			cachedInputTokens: cachedInputTokens ?? 0,
			cacheWriteInputTokens: nonNegativeInteger(sample.cacheWriteInputTokens),
			cacheEligibleInputTokens: cachedInputTokens === undefined ? 0 : inputTokens,
			cacheReportedRequests: cachedInputTokens === undefined ? 0 : requests,
			zeroCacheReadRequests: cachedInputTokens === 0 && inputTokens > 0 ? requests : 0,
			reasoningOutputTokens: nonNegativeInteger(sample.reasoningOutputTokens),
			modelTurns: Math.max(requests, nonNegativeInteger(sample.modelTurns ?? requests)),
			durationMs: nonNegativeInteger(sample.durationMs),
			estimatedRequests: sample.estimated ? requests : 0,
		};
		this.data.days[day] = {
			...this.data.days[day],
			[sample.provider]: mergeTokenUsageAggregates(current, increment),
		};
		this.prune();
		this.persist();
		this.changes.fire();
	}

	clear(): void {
		this.data = { version: 1, days: {} };
		this.persist();
		this.changes.fire();
	}

	async flush(): Promise<void> {
		await this.persistQueue;
	}

	dispose(): void {
		this.changes.dispose();
	}

	private prune(): void {
		const keep = new Set(recentLocalDayKeys(this.now(), RETENTION_DAYS));
		for (const day of Object.keys(this.data.days)) {
			if (!keep.has(day)) {
				delete this.data.days[day];
			}
		}
	}

	private persist(): void {
		const snapshot = JSON.parse(JSON.stringify(this.data)) as PersistedTokenUsageHistory;
		this.persistQueue = this.persistQueue
			.catch(() => undefined)
			.then(() => this.memento.update(STORAGE_KEY, snapshot))
			.catch(error => {
				this.onPersistError?.(error instanceof Error ? error : new Error(String(error)));
			});
	}
}
