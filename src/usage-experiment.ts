import * as vscode from "vscode";

import type {
	TokenUsageSample,
	TokenUsageAggregate,
	TokenUsageProvider,
} from "./token-usage-history";
import {
	tokenUsageCacheHitPercent,
	mergeTokenUsageAggregates,
	emptyTokenUsageAggregate,
} from "./token-usage-history";
import { nonNegativeInteger } from "./utils";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ExperimentVariant = "baseline" | "delegated";

/** One completed or in-progress experiment run. */
export interface ExperimentRun {
	readonly id: string;
	readonly label: string;
	readonly variant: ExperimentVariant;
	readonly startedAt: number;
	readonly stoppedAt?: number;
	/** Per-provider aggregates (all models collapsed). */
	readonly providers: Record<string, TokenUsageAggregate>;
	/** Per-model aggregates keyed as `"provider::modelId"` (or `"provider::unknown"`). */
	readonly models: Record<string, TokenUsageAggregate>;
}

/** Codex-only savings comparison between latest baseline and delegated runs. */
export interface ExperimentComparison {
	/** (baselineCodexTotal – delegatedCodexTotal) / baselineCodexTotal × 100 */
	readonly totalSavingsPercent: number | undefined;
	/** (baselineCodexInput – delegatedCodexInput) / baselineCodexInput × 100 */
	readonly inputSavingsPercent: number | undefined;
	/** Uncached-input delta / baseline uncached input × 100 */
	readonly uncachedInputSavingsPercent: number | undefined;
	/** (baselineCodexOutput – delegatedCodexOutput) / baselineCodexOutput × 100 */
	readonly outputSavingsPercent: number | undefined;
	/** Cache-hit percentage for the delegated Codex provider (or undefined). */
	readonly delegatedCacheHitPercent: number | undefined;
	readonly baselineCodex: TokenUsageAggregate;
	readonly delegatedCodex: TokenUsageAggregate;
	/**
	 * Non-Codex provider aggregates from the delegated run.
	 * These are NOT included in Codex saving numerators or denominators.
	 */
	readonly delegatedChildProviders: Record<string, TokenUsageAggregate>;
}

/** Top-level summary exposed by the tracker. */
export interface ExperimentSummary {
	readonly active: ExperimentRun | undefined;
	readonly latestBaseline: ExperimentRun | undefined;
	readonly latestDelegated: ExperimentRun | undefined;
	readonly comparison: ExperimentComparison | undefined;
}

export function emptyUsageExperimentSummary(): ExperimentSummary {
	return {
		active: undefined,
		latestBaseline: undefined,
		latestDelegated: undefined,
		comparison: undefined,
	};
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = "llamacpp.usageExperiment.v1";
const MAX_COMPLETED = 20;
const CODEX_PROVIDER: TokenUsageProvider = "codex";
const UNKNOWN_MODEL = "unknown";

// ---------------------------------------------------------------------------
// Normalization helpers (safe from malformed persisted data)
// ---------------------------------------------------------------------------

function normalizeAggregate(value: unknown): TokenUsageAggregate {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
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

function normalizeString(value: unknown, maxLength = 256): string {
	return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function normalizeStringMap(value: unknown): Record<string, TokenUsageAggregate> {
	if (!value || typeof value !== "object") {
		return {};
	}
	const record = value as Record<string, unknown>;
	const result: Record<string, TokenUsageAggregate> = {};
	for (const [key, val] of Object.entries(record)) {
		if (typeof key === "string" && key.length > 0 && key.length <= 256) {
			result[key] = normalizeAggregate(val);
		}
	}
	return result;
}

function isValidVariant(value: unknown): value is ExperimentVariant {
	return value === "baseline" || value === "delegated";
}

function normalizeRun(value: unknown): ExperimentRun | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const id = normalizeString(record.id, 128);
	if (!id) {
		return undefined;
	}
	const variant = record.variant;
	if (!isValidVariant(variant)) {
		return undefined;
	}
	return {
		id,
		label: normalizeString(record.label, 256),
		variant,
		startedAt: nonNegativeInteger(record.startedAt),
		stoppedAt:
			record.stoppedAt !== undefined ? nonNegativeInteger(record.stoppedAt) : undefined,
		providers: normalizeStringMap(record.providers),
		models: normalizeStringMap(record.models),
	};
}

// ---------------------------------------------------------------------------
// Persistence wire format
// ---------------------------------------------------------------------------

interface PersistedExperimentData {
	version: 1;
	active: unknown;
	completed: unknown[];
}

function normalizePersisted(value: unknown): PersistedExperimentData {
	const candidate =
		value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const completed = Array.isArray(candidate.completed) ? candidate.completed : [];
	return {
		version: 1,
		active: candidate.active,
		completed,
	};
}

// ---------------------------------------------------------------------------
// Comparison math (Codex-only)
// ---------------------------------------------------------------------------

function safePercent(numerator: number, denominator: number): number | undefined {
	if (denominator <= 0) {
		return undefined;
	}
	return (numerator / denominator) * 100;
}

function buildComparison(
	baseline: ExperimentRun,
	delegated: ExperimentRun,
): ExperimentComparison {
	const baselineCodex =
		baseline.providers[CODEX_PROVIDER] ?? emptyTokenUsageAggregate();
	const delegatedCodex =
		delegated.providers[CODEX_PROVIDER] ?? emptyTokenUsageAggregate();

	// Codex-only totals – child provider tokens are NEVER summed here.
	const baselineTotal = baselineCodex.inputTokens + baselineCodex.outputTokens;
	const delegatedTotal = delegatedCodex.inputTokens + delegatedCodex.outputTokens;
	const totalDelta = baselineTotal - delegatedTotal;
	const inputDelta = baselineCodex.inputTokens - delegatedCodex.inputTokens;
	const outputDelta = baselineCodex.outputTokens - delegatedCodex.outputTokens;

	const baselineUncached =
		baselineCodex.inputTokens - baselineCodex.cachedInputTokens;
	const delegatedUncached =
		delegatedCodex.inputTokens - delegatedCodex.cachedInputTokens;
	const uncachedDelta = baselineUncached - delegatedUncached;

	// Non-Codex child providers from the delegated run (reported separately).
	const delegatedChildProviders: Record<string, TokenUsageAggregate> = {};
	for (const [provider, agg] of Object.entries(delegated.providers)) {
		if (provider !== CODEX_PROVIDER) {
			delegatedChildProviders[provider] = agg;
		}
	}

	return {
		totalSavingsPercent: safePercent(totalDelta, baselineTotal),
		inputSavingsPercent: safePercent(inputDelta, baselineCodex.inputTokens),
		uncachedInputSavingsPercent: safePercent(uncachedDelta, baselineUncached),
		outputSavingsPercent: safePercent(outputDelta, baselineCodex.outputTokens),
		delegatedCacheHitPercent: tokenUsageCacheHitPercent(delegatedCodex),
		baselineCodex,
		delegatedCodex,
		delegatedChildProviders,
	};
}

function formatReportNumber(value: number): string {
	return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function formatReportPercent(value: number | undefined): string {
	return value === undefined ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function renderRunSection(title: string, run: ExperimentRun | undefined): string[] {
	if (!run) {
		return [`## ${title}`, "", "No completed run.", ""];
	}
	const providerRows = Object.entries(run.providers)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([provider, usage]) =>
			`| ${provider} | ${usage.requests} | ${formatReportNumber(usage.inputTokens)} | ${formatReportNumber(usage.outputTokens)} | ${formatReportNumber(usage.cachedInputTokens)} | ${usage.estimatedRequests} |`
		);
	const modelRows = Object.entries(run.models)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([model, usage]) =>
			`| ${model} | ${usage.requests} | ${formatReportNumber(usage.inputTokens)} | ${formatReportNumber(usage.outputTokens)} | ${formatReportNumber(usage.cachedInputTokens)} |`
		);
	return [
		`## ${title}`,
		"",
		`- Label: ${run.label}`,
		`- Run id: ${run.id}`,
		`- Started: ${new Date(run.startedAt).toISOString()}`,
		`- Stopped: ${run.stoppedAt ? new Date(run.stoppedAt).toISOString() : "active"}`,
		"",
		"### Providers",
		"",
		"| Provider | Requests | Input | Output | Cached input | Estimated requests |",
		"|---|---:|---:|---:|---:|---:|",
		...(providerRows.length > 0 ? providerRows : ["| none | 0 | 0 | 0 | 0 | 0 |"]),
		"",
		"### Models",
		"",
		"| Model | Requests | Input | Output | Cached input |",
		"|---|---:|---:|---:|---:|",
		...(modelRows.length > 0 ? modelRows : ["| none | 0 | 0 | 0 | 0 |"]),
		"",
	];
}

export function renderUsageExperimentMarkdown(
	summary: ExperimentSummary,
	generatedAt: string = new Date().toISOString()
): string {
	const comparison = summary.comparison;
	const label = summary.latestBaseline?.label === summary.latestDelegated?.label
		? summary.latestBaseline?.label
		: undefined;
	const lines = [
		"# Usage Experiment Report",
		"",
		`Generated: ${generatedAt}`,
		"",
		"This report compares observed runs with the same task label. Codex savings use Codex tokens only; child-provider usage is listed separately and is not converted into a combined cost.",
		"It does not prove causality unless both variants used the same repository state, prompt, acceptance criteria, and verification.",
		"",
		"## Codex comparison",
		"",
		`- Matched task: ${label ?? "none"}`,
		`- Total token saving: ${formatReportPercent(comparison?.totalSavingsPercent)}`,
		`- Input saving: ${formatReportPercent(comparison?.inputSavingsPercent)}`,
		`- Uncached input saving: ${formatReportPercent(comparison?.uncachedInputSavingsPercent)}`,
		`- Output saving: ${formatReportPercent(comparison?.outputSavingsPercent)}`,
		`- Delegated Codex cache hit: ${comparison?.delegatedCacheHitPercent === undefined ? "n/a" : `${comparison.delegatedCacheHitPercent.toFixed(1)}%`}`,
		"",
		...renderRunSection("Baseline", summary.latestBaseline),
		...renderRunSection("Delegated", summary.latestDelegated),
	];
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export class UsageExperimentTracker implements vscode.Disposable {
	private readonly _changes = new vscode.EventEmitter<void>();
	readonly onDidChange = this._changes.event;

	private _active: ExperimentRun | undefined;
	private _completed: ExperimentRun[] = [];
	private _persistQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly memento: vscode.Memento,
		private readonly onPersistError?: (error: Error) => void,
		private readonly _now: () => number = Date.now,
		private readonly _idFactory: () => string = () =>
			`${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
	) {
		const raw = memento.get<unknown>(STORAGE_KEY);
		const data = normalizePersisted(raw);
		this._active = normalizeRun(data.active);
		this._completed = data.completed
			.map(normalizeRun)
			.filter((r): r is ExperimentRun => r !== undefined)
			.slice(0, MAX_COMPLETED);
	}

	// -- summary ------------------------------------------------------------

	get summary(): ExperimentSummary {
		const latestBaseline = this._completed.find(r => r.variant === "baseline");
		const latestDelegated = this._completed.find(r => r.variant === "delegated");
		const comparison =
			latestBaseline && latestDelegated && latestBaseline.label === latestDelegated.label
				? buildComparison(latestBaseline, latestDelegated)
				: undefined;

		return {
			active: this._active,
			latestBaseline,
			latestDelegated,
			comparison,
		};
	}

	// -- lifecycle -----------------------------------------------------------

	/** Begin a new run. An active run must be stopped explicitly first. */
	start(label: string, variant: ExperimentVariant): ExperimentRun {
		if (this._active) {
			throw new Error(`Usage experiment "${this._active.label}" is already active. Stop it before starting another run.`);
		}
		const normalizedLabel = label.trim().slice(0, 256);
		if (!normalizedLabel) {
			throw new Error("Usage experiment label must not be empty.");
		}

		const run: ExperimentRun = {
			id: this._idFactory(),
			label: normalizedLabel,
			variant,
			startedAt: this._now(),
			providers: {},
			models: {},
		};
		this._active = run;
		this._persist();
		this._changes.fire();
		return run;
	}

	/**
	 * Record a token-usage sample against the active run.
	 * No-op when no run is active.
	 */
	record(sample: TokenUsageSample, modelId?: string): void {
		if (!this._active) {
			return;
		}

		const provider = sample.provider;
		const normalizedModelId = modelId?.split("::").at(-1)?.trim().slice(0, 256);
		const resolvedModelId = normalizedModelId
			? `${provider}::${normalizedModelId}`
			: `${provider}::${UNKNOWN_MODEL}`;

		const inputTokens = nonNegativeInteger(sample.inputTokens);
		const outputTokens = nonNegativeInteger(sample.outputTokens);
		const requests = Math.max(1, nonNegativeInteger(sample.requests ?? 1));
		const cachedInputTokens =
			sample.cachedInputTokens === undefined
				? undefined
				: Math.min(inputTokens, nonNegativeInteger(sample.cachedInputTokens));

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

		// Aggregate by provider.
		const currentProvider =
			this._active.providers[provider] ?? emptyTokenUsageAggregate();
		this._active.providers[provider] = mergeTokenUsageAggregates(
			currentProvider,
			increment,
		);

		// Aggregate by model.
		const currentModel =
			this._active.models[resolvedModelId] ?? emptyTokenUsageAggregate();
		this._active.models[resolvedModelId] = mergeTokenUsageAggregates(
			currentModel,
			increment,
		);

		this._persist();
		this._changes.fire();
	}

	/**
	 * Stop the active run and archive it.
	 * Returns the stopped run, or `undefined` when no run is active.
	 */
	stop(): ExperimentRun | undefined {
		if (!this._active) {
			return undefined;
		}

		const run: ExperimentRun = {
			...this._active,
			stoppedAt: this._now(),
		};
		this._active = undefined;

		this._completed.unshift(run);
		if (this._completed.length > MAX_COMPLETED) {
			this._completed.length = MAX_COMPLETED;
		}

		this._persist();
		this._changes.fire();
		return run;
	}

	/** Discard the active run and all completed history. */
	clear(): void {
		this._active = undefined;
		this._completed = [];
		this._persist();
		this._changes.fire();
	}

	/** Resolves when the last scheduled persist has settled. */
	async flush(): Promise<void> {
		await this._persistQueue;
	}

	dispose(): void {
		this._changes.dispose();
	}

	// -- internal ------------------------------------------------------------

	private _persist(): void {
		const snapshot = JSON.parse(JSON.stringify({
			version: 1,
			active: this._active,
			completed: this._completed,
		})) as PersistedExperimentData;
		this._persistQueue = this._persistQueue
			.catch(() => undefined)
			.then(() => this.memento.update(STORAGE_KEY, snapshot))
			.catch(error => {
				this.onPersistError?.(
					error instanceof Error ? error : new Error(String(error)),
				);
			});
	}
}
