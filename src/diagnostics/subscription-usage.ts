import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type SubscriptionProvider = "claude" | "codex" | `codex:${string}`;
export type SubscriptionWindowKind = "fiveHour" | "weekly";

export interface SubscriptionWindowObservation {
	/** Percentage of the limit window used, 0-100. */
	utilization: number;
	/** ISO timestamp when the window resets, when the provider reports it. */
	resetsAt?: string;
}

export interface SubscriptionObservation {
	plan?: string;
	fiveHour?: SubscriptionWindowObservation;
	weekly?: SubscriptionWindowObservation;
}

export interface SubscriptionUsageSample {
	provider: SubscriptionProvider;
	modelId?: string;
	/** Input tokens that were not served from the provider cache (a cache miss). */
	freshInputTokens: number;
	/** Input tokens served from the prompt cache. */
	cachedInputTokens: number;
	cacheWriteInputTokens?: number;
	outputTokens: number;
	at?: number;
}

interface UsageEvent {
	type: "usage";
	id: string;
	provider: SubscriptionProvider;
	at: number;
	modelId?: string;
	fresh: number;
	cached: number;
	cacheWrite: number;
	output: number;
}

interface WindowEvent {
	type: "window";
	provider: SubscriptionProvider;
	kind: SubscriptionWindowKind;
	at: number;
	utilization: number;
	resetsAt?: string;
	plan?: string;
}

type LedgerEvent = UsageEvent | WindowEvent;

export interface SubscriptionUsageTotals {
	requests: number;
	inputTokens: number;
	freshInputTokens: number;
	cachedInputTokens: number;
	cacheWriteInputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cacheHitPercent?: number;
}

export interface SubscriptionModelTotals extends SubscriptionUsageTotals {
	modelId: string;
}

export interface SubscriptionWindowRecord {
	provider: SubscriptionProvider;
	kind: SubscriptionWindowKind;
	startedAt: number;
	endedAt?: number;
	resetsAt?: string;
	/** "first-seen" for the first window tracked for this provider, "reset" after a window the ledger already followed. */
	origin: "first-seen" | "reset";
	/** True when tracking began inside an already-running window: the totals are a lower bound and never become history. */
	partial: boolean;
	closedBy?: "limit-hit" | "reset";
	peakUtilization?: number;
	plan?: string;
	totals: SubscriptionUsageTotals;
	models: SubscriptionModelTotals[];
}

export interface SubscriptionProviderReport {
	provider: SubscriptionProvider;
	plan?: string;
	current: SubscriptionWindowRecord[];
	/** Finished windows, newest first. */
	completed: SubscriptionWindowRecord[];
	/** Windows that ended because the provider reported 100% utilization. */
	exhausted: SubscriptionWindowRecord[];
}

export interface SubscriptionReport {
	generatedAt: number;
	providers: SubscriptionProviderReport[];
	/** True once events from more than one extension host were merged. */
	shared?: boolean;
}

function emptyTotals(): SubscriptionUsageTotals {
	return {
		requests: 0,
		inputTokens: 0,
		freshInputTokens: 0,
		cachedInputTokens: 0,
		cacheWriteInputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
	};
}

const rate = (part: number, whole: number): number | undefined =>
	whole > 0 ? Number((part / whole * 100).toFixed(1)) : undefined;

function finalizeTotals(totals: SubscriptionUsageTotals): SubscriptionUsageTotals {
	const inputTokens = totals.freshInputTokens + totals.cachedInputTokens + totals.cacheWriteInputTokens;
	return {
		...totals,
		inputTokens,
		totalTokens: inputTokens + totals.outputTokens,
		cacheHitPercent: rate(totals.cachedInputTokens, inputTokens),
	};
}

const WINDOW_KINDS: readonly SubscriptionWindowKind[] = ["fiveHour", "weekly"];
/** Providers move the reset timestamp by sub-seconds between polls of the same window. */
export const RESET_TOLERANCE_MS = 5 * 60_000;

function sameWindow(left: string | undefined, right: string | undefined): boolean {
	if (left === undefined || right === undefined) {
		return left === right;
	}
	const leftAt = Date.parse(left), rightAt = Date.parse(right);
	if (Number.isNaN(leftAt) || Number.isNaN(rightAt)) {
		return left === right;
	}
	return Math.abs(leftAt - rightAt) <= RESET_TOLERANCE_MS;
}

const WINDOW_DURATION_MS: Record<SubscriptionWindowKind, number> = { fiveHour: 5 * 3_600_000, weekly: 7 * 86_400_000 };
/** Points of a window used outside the ledger's view that still leave it complete. */
const UNTRACKED_MAX_UTILIZATION = 5;
/** Polls (1 min for Codex, ~6 min for Claude) see a new window this soon after it starts. */
const FULL_START_GRACE_MS = 20 * 60_000;
/** A request's own consumption can reach the next sample this late. */
const SAMPLE_LAG_MS = 7 * 60_000;

function parseReset(resetsAt: string | undefined): number | undefined {
	const at = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt);
	return Number.isNaN(at) ? undefined : at;
}

interface WindowState {
	record: SubscriptionWindowRecord;
	usages: UsageEvent[];
	resetAt?: number;
	firstWindowAt?: number;
	firstUtilization?: number;
	/** The provider's start of the window (`resetsAt - duration`), once a reset time is known. */
	windowStartAt?: number;
	samples: Array<{ at: number; utilization: number }>;
}

/** Points the window rose after our last request: consumption the ledger never saw, e.g. an unrecorded failed turn. */
function untrackedTail(state: WindowState): number {
	const peak = state.record.peakUtilization;
	const lastUsageAt = state.usages.at(-1)?.at;
	if (peak === undefined || lastUsageAt === undefined) {
		return 0;
	}
	const seen = state.samples
		.filter(sample => sample.at <= lastUsageAt + SAMPLE_LAG_MS)
		.reduce((highest, sample) => Math.max(highest, sample.utilization), state.samples[0]?.utilization ?? 0);
	return peak - seen;
}

function createRecord(provider: SubscriptionProvider, kind: SubscriptionWindowKind, at: number,
	origin: SubscriptionWindowRecord["origin"], observed: WindowEvent | undefined): SubscriptionWindowRecord {
	const record: SubscriptionWindowRecord = {
		provider,
		kind,
		startedAt: at,
		origin,
		partial: origin === "first-seen",
		totals: emptyTotals(),
		models: [],
	};
	if (observed) {
		record.resetsAt = observed.resetsAt;
		record.peakUtilization = observed.utilization;
		record.plan = observed.plan;
	}
	return record;
}

function applyUsages(record: SubscriptionWindowRecord, usages: readonly UsageEvent[]): void {
	for (const event of usages) {
		const totals = record.totals;
		totals.requests += 1;
		totals.freshInputTokens += event.fresh;
		totals.cachedInputTokens += event.cached;
		totals.cacheWriteInputTokens += event.cacheWrite;
		totals.outputTokens += event.output;
		const modelId = event.modelId ?? "unknown";
		let model = record.models.find(entry => entry.modelId === modelId);
		if (!model) {
			model = { modelId, ...emptyTotals() };
			record.models.push(model);
		}
		model.requests += 1;
		model.freshInputTokens += event.fresh;
		model.cachedInputTokens += event.cached;
		model.cacheWriteInputTokens += event.cacheWrite;
		model.outputTokens += event.output;
	}
}

/**
 * Turns the ledger into per-window records spanning `[resetsAt - duration, resetsAt)`. Only windows
 * tracked from their start become history; one first seen mid-way is shown while it runs, never saved.
 */
export function summarizeSubscriptionEvents(events: readonly LedgerEvent[], now = Date.now()): SubscriptionReport {
	const sorted = [...events].sort((left, right) => left.at - right.at);
	// A provider only has the windows it reports; usage alone cannot invent a weekly row.
	const reportedKinds = new Map<SubscriptionProvider, Set<SubscriptionWindowKind>>();
	for (const event of sorted) {
		if (event.type === "window") {
			const kinds = reportedKinds.get(event.provider) ?? new Set<SubscriptionWindowKind>();
			kinds.add(event.kind);
			reportedKinds.set(event.provider, kinds);
		}
	}
	const providers = new Map<SubscriptionProvider, SubscriptionProviderReport>();
	const reportFor = (provider: SubscriptionProvider): SubscriptionProviderReport => {
		const existing = providers.get(provider);
		if (existing) {
			return existing;
		}
		const created: SubscriptionProviderReport = { provider, current: [], completed: [], exhausted: [] };
		providers.set(provider, created);
		return created;
	};
	for (const windowKind of WINDOW_KINDS) {
		const duration = WINDOW_DURATION_MS[windowKind];
		const open = new Map<SubscriptionProvider, WindowState>();
		const previousEnd = new Map<SubscriptionProvider, number>();
		const states: WindowState[] = [];
		const begin = (provider: SubscriptionProvider, at: number, observed: WindowEvent | undefined): WindowState => {
			const origin = previousEnd.has(provider) ? "reset" : "first-seen";
			const state: WindowState = {
				record: createRecord(provider, windowKind, at, origin, observed),
				usages: [],
				resetAt: parseReset(observed?.resetsAt),
				firstWindowAt: observed?.at,
				firstUtilization: observed?.utilization,
				samples: observed ? [{ at: observed.at, utilization: observed.utilization }] : [],
			};
			if (state.resetAt !== undefined) {
				state.windowStartAt = state.resetAt - duration;
			}
			reportFor(provider);
			open.set(provider, state);
			states.push(state);
			return state;
		};
		const close = (state: WindowState, at: number): void => {
			const record = state.record;
			if (!record.closedBy) {
				record.closedBy = "reset";
				record.endedAt = Math.max(record.startedAt, Math.min(at, state.resetAt ?? at));
			}
			previousEnd.set(record.provider, record.endedAt ?? at);
			open.delete(record.provider);
		};
		// The provider's own start of a window, never before the previous window ended or after it was seen.
		const windowStart = (provider: SubscriptionProvider, event: WindowEvent, floor: number | undefined): number => {
			const resetAt = parseReset(event.resetsAt);
			const start = resetAt === undefined ? event.at : resetAt - duration;
			return Math.min(event.at, Math.max(start, floor ?? previousEnd.get(provider) ?? start));
		};
		for (const event of sorted) {
			if (!reportedKinds.get(event.provider)?.has(windowKind)) {
				continue;
			}
			const current = open.get(event.provider);
			if (event.type === "usage") {
				let state = current;
				if (state?.resetAt !== undefined && event.at > state.resetAt) {
					close(state, state.resetAt);
					state = undefined;
				}
				state ??= begin(event.provider, event.at, undefined);
				state.usages.push(event);
				continue;
			}
			if (event.kind !== windowKind) {
				continue;
			}
			if (!current) {
				// An idle provider reports 0% with a moving reset time: no window until something is used.
				if (event.utilization > 0) {
					begin(event.provider, windowStart(event.provider, event, undefined), event);
				}
				continue;
			}
			const record = current.record;
			// A timestamp the provider only sometimes reports must not split the window;
			// both sides have to name a reset time that actually differs.
			const windowChanged = record.resetsAt !== undefined && event.resetsAt !== undefined
				&& !sameWindow(record.resetsAt, event.resetsAt);
			// Without reset timestamps a deep drop is the only sign of a fresh window.
			const dropped = (record.resetsAt === undefined || event.resetsAt === undefined)
				&& (record.peakUtilization ?? 0) - event.utilization >= 50;
			if (windowChanged || dropped) {
				const start = windowStart(event.provider, event, record.startedAt);
				close(current, start);
				if (event.utilization <= 0) {
					continue;
				}
				const next = begin(event.provider, start, event);
				// Codex restarts a window early (right after a weekly 100%); requests since then are the new window's.
				next.usages = current.usages.filter(usage => usage.at >= start);
				current.usages = current.usages.filter(usage => usage.at < start);
				continue;
			}
			if (event.utilization <= 0) {
				continue;
			}
			if (current.firstWindowAt === undefined) {
				current.firstWindowAt = event.at;
				current.firstUtilization = event.utilization;
				const resetAt = parseReset(event.resetsAt);
				if (resetAt !== undefined) {
					// The request that opened this window started before it was recorded.
					current.windowStartAt = resetAt - duration;
					const start = Math.max(current.windowStartAt, previousEnd.get(event.provider) ?? current.windowStartAt);
					record.startedAt = Math.min(record.startedAt, start, event.at);
				}
			}
			current.samples.push({ at: event.at, utilization: event.utilization });
			record.plan = event.plan ?? record.plan;
			record.resetsAt = event.resetsAt ?? record.resetsAt;
			current.resetAt = parseReset(record.resetsAt);
			const previousPeak = record.peakUtilization ?? 0;
			record.peakUtilization = Math.max(previousPeak, event.utilization);
			if (event.utilization >= 100 && previousPeak < 100 && !record.closedBy) {
				// Exhausted: the totals so far are the window's capacity; it still runs until the reset.
				record.closedBy = "limit-hit";
				record.endedAt = event.at;
			}
		}
		for (const state of [...open.values()]) {
			if (state.resetAt !== undefined && state.resetAt <= now) {
				close(state, state.resetAt);
			}
		}
		for (const state of states) {
			const record = state.record;
			const firstWindowAt = state.firstWindowAt;
			const sawStart = firstWindowAt === undefined
				|| (state.firstUtilization ?? 0) <= UNTRACKED_MAX_UTILIZATION
				|| (state.windowStartAt !== undefined && firstWindowAt - state.windowStartAt <= FULL_START_GRACE_MS)
				// Our own requests ran before the first sample, so tracking was live when it opened.
				|| state.usages.some(usage => usage.at <= firstWindowAt);
			const sawEnd = !record.closedBy || untrackedTail(state) <= UNTRACKED_MAX_UTILIZATION;
			record.partial = record.origin === "first-seen" || !sawStart || !sawEnd;
			applyUsages(record, state.usages);
			const report = reportFor(record.provider);
			if (open.get(record.provider) === state) {
				report.current.push(record);
			}
			// Only a window tracked from its start, with tokens of ours, becomes history.
			if (record.closedBy && !record.partial && state.usages.length > 0) {
				report.completed.push(record);
				if (record.closedBy === "limit-hit") {
					report.exhausted.push(record);
				}
			}
		}
	}
	const newestFirst = (left: SubscriptionWindowRecord, right: SubscriptionWindowRecord) =>
		(right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt);
	const output: SubscriptionProviderReport[] = [];
	for (const report of providers.values()) {
		const finish = (record: SubscriptionWindowRecord) => ({
			...record,
			totals: finalizeTotals(record.totals),
			models: record.models.map(model => ({ ...model, ...finalizeTotals(model) }))
				.sort((left, right) => right.totalTokens - left.totalTokens),
		});
		output.push({
			provider: report.provider,
			plan: report.current.find(record => record.plan)?.plan
				?? [...report.completed].sort(newestFirst).find(record => record.plan)?.plan,
			current: report.current.map(finish),
			completed: [...report.completed].sort(newestFirst).map(finish),
			exhausted: [...report.exhausted].sort(newestFirst).map(finish),
		});
	}
	return { generatedAt: now, providers: output.sort((left, right) => left.provider.localeCompare(right.provider)) };
}

const BAND_SIZE = 10;
const RESET_DROP = 10;

function parseEvent(line: string): LedgerEvent | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (record.type !== "usage" && record.type !== "window") {
		return undefined;
	}
	if (typeof record.provider !== "string"
		|| !/^(?:claude|codex)(?::[a-z0-9][a-z0-9_-]{0,31})?$/.test(record.provider)) {
		return undefined;
	}
	const provider = record.provider as SubscriptionProvider;
	const number = (input: unknown) => typeof input === "number" && Number.isFinite(input) && input >= 0 ? Math.floor(input) : 0;
	const at = number(record.at);
	if (!at) {
		return undefined;
	}
	if (record.type === "usage") {
		return {
			type: "usage",
			id: typeof record.id === "string" ? record.id : `${provider}:${at}`,
			provider,
			at,
			modelId: typeof record.modelId === "string" ? record.modelId.slice(0, 200) : undefined,
			fresh: number(record.fresh),
			cached: number(record.cached),
			cacheWrite: number(record.cacheWrite),
			output: number(record.output),
		};
	}
	const kind = record.kind === "weekly" ? "weekly" : record.kind === "fiveHour" ? "fiveHour" : undefined;
	if (!kind) {
		return undefined;
	}
	return {
		type: "window",
		provider,
		kind,
		at,
		utilization: Math.max(0, Math.min(100, number(record.utilization))),
		resetsAt: typeof record.resetsAt === "string" ? record.resetsAt.slice(0, 64) : undefined,
		plan: typeof record.plan === "string" ? record.plan.slice(0, 64) : undefined,
	};
}

/** Token and window history per subscription, appended by every VS Code window of this profile. */
export class SubscriptionUsageLedger {
	private readonly file: string;
	private events: LedgerEvent[] = [];
	private known = new Set<string>();
	private windows = new Map<string, { utilization: number; resetsAt?: string }>();
	private queue: Promise<void> = Promise.resolve();
	private report: SubscriptionReport = { generatedAt: Date.now(), providers: [] };
	private loaded = false;

	constructor(private readonly root: string) {
		this.file = path.join(root, "subscription-usage.jsonl");
	}

	async initialize(): Promise<void> {
		await fs.mkdir(this.root, { recursive: true });
		await this.refresh();
	}

	/** Merges events appended by other VS Code windows. */
	async refresh(): Promise<void> {
		let content = "";
		try {
			content = await fs.readFile(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}
		let changed = !this.loaded;
		this.loaded = true;
		for (const line of content.split("\n")) {
			if (!line) {
				continue;
			}
			const event = parseEvent(line);
			if (!event) {
				continue;
			}
			const id = event.type === "usage" ? event.id : `${event.type}:${event.provider}:${event.kind}:${event.at}:${event.utilization}`;
			if (this.known.has(id)) {
				continue;
			}
			this.known.add(id);
			this.events.push(event);
			changed = true;
		}
		if (changed) {
			this.report = summarizeSubscriptionEvents(this.events);
		}
	}

	summary(): SubscriptionReport {
		// A window whose reset passed moves to history even when no new event arrived.
		if (Date.now() - this.report.generatedAt > 60_000) {
			this.report = summarizeSubscriptionEvents(this.events);
		}
		return this.report;
	}

	record(sample: SubscriptionUsageSample): void {
		const event: UsageEvent = {
			type: "usage",
			id: randomUUID(),
			provider: sample.provider,
			at: sample.at ?? Date.now(),
			modelId: sample.modelId,
			fresh: Math.max(0, Math.floor(sample.freshInputTokens)),
			cached: Math.max(0, Math.floor(sample.cachedInputTokens)),
			cacheWrite: Math.max(0, Math.floor(sample.cacheWriteInputTokens ?? 0)),
			output: Math.max(0, Math.floor(sample.outputTokens)),
		};
		this.known.add(event.id);
		this.events.push(event);
		this.report = summarizeSubscriptionEvents(this.events);
		this.append(event);
	}

	/** Stores a boundary event when a provider window resets or reaches 100%. */
	observe(provider: SubscriptionProvider, observation: SubscriptionObservation | undefined): void {
		if (!observation) {
			return;
		}
		for (const kind of WINDOW_KINDS) {
			const window = observation[kind];
			if (!window || !Number.isFinite(window.utilization)) {
				continue;
			}
			const utilization = Math.max(0, Math.min(100, Math.round(window.utilization)));
			const key = `${provider}:${kind}`;
			const last = this.windows.get(key);
			const resetsAt = window.resetsAt;
			const windowChanged = last !== undefined && !sameWindow(last.resetsAt, resetsAt);
			const hitLimit = utilization >= 100 && (last?.utilization ?? 0) < 100;
			const resetWithoutTimestamp = last !== undefined && last.resetsAt === resetsAt
				&& utilization + RESET_DROP <= last.utilization;
			const bandChanged = last === undefined || Math.floor(utilization / BAND_SIZE) !== Math.floor(last.utilization / BAND_SIZE);
			// Idle 0% samples (with a moving reset) are neither stored nor remembered, so the first
			// used sample of a new window still reads as a reset instead of waiting for the 10% band.
			if (utilization <= 0 && !hitLimit) {
				continue;
			}
			this.windows.set(key, { utilization, resetsAt });
			if (!windowChanged && !hitLimit && !resetWithoutTimestamp && !bandChanged) {
				continue;
			}
			const event: WindowEvent = {
				type: "window",
				provider,
				kind,
				at: Date.now(),
				utilization,
				resetsAt,
				plan: observation.plan,
			};
			this.known.add(`${event.type}:${event.provider}:${event.kind}:${event.at}:${event.utilization}`);
			this.events.push(event);
			this.report = summarizeSubscriptionEvents(this.events);
			this.append(event);
		}
	}

	private append(event: LedgerEvent): void {
		const line = `${JSON.stringify(event)}\n`;
		this.queue = this.queue
			.then(() => fs.appendFile(this.file, line, { mode: 0o600 }))
			.catch(() => undefined);
	}

	/** Resolves once every queued append reached the file. */
	async flush(): Promise<void> {
		await this.queue;
	}

	dispose(): void {
		this.events = [];
		this.known.clear();
	}
}
