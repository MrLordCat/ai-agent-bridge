import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type SubscriptionProvider = "claude" | "codex";
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
	/** Why tracking restarted: the first event, a provider window reset, or the previous window hitting 100%. */
	origin: "first-seen" | "reset" | "limit-hit";
	/** True when tracking began inside an already-running window, so the totals are a lower bound. */
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

function hasActivity(record: SubscriptionWindowRecord): boolean {
	return record.totals.requests > 0;
}

function createRecord(provider: SubscriptionProvider, kind: SubscriptionWindowKind, at: number,
	origin: SubscriptionWindowRecord["origin"], observed: WindowEvent | undefined): SubscriptionWindowRecord {
	const record: SubscriptionWindowRecord = {
		provider,
		kind,
		startedAt: at,
		origin,
		// Only a window observed from its start has complete totals; a limit hit or an
		// adoption mid-window both start counting from zero partway through.
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

/**
 * Turns the append-only ledger into per-window records. Every window starts
 * with zero totals when the provider reports a reset or a fully used window,
 * so a completed record never mixes usage from two periods.
 */
export function summarizeSubscriptionEvents(events: readonly LedgerEvent[]): SubscriptionReport {
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
		const perProvider = new Map<SubscriptionProvider, SubscriptionWindowRecord>();
		const ensure = (provider: SubscriptionProvider, at: number, origin: SubscriptionWindowRecord["origin"], observed?: WindowEvent) => {
			const existing = perProvider.get(provider);
			if (existing) {
				return existing;
			}
			const created = createRecord(provider, windowKind, at, origin, observed);
			perProvider.set(provider, created);
			reportFor(provider).current.push(created);
			return created;
		};
		for (const event of sorted) {
			if (!reportedKinds.get(event.provider)?.has(windowKind)) {
				continue;
			}
			if (event.type === "window") {
				if (event.kind !== windowKind) {
					continue;
				}
				const current = perProvider.get(event.provider);
				if (!current && event.utilization <= 0) {
					// Nothing has been used and no window is running: do not create a record.
					continue;
				}
				const report = reportFor(event.provider);
				// A timestamp the provider only sometimes reports must not split the window;
				// both sides have to name a reset time that actually differs.
				const windowChanged = current?.resetsAt !== undefined && event.resetsAt !== undefined
					&& !sameWindow(current.resetsAt, event.resetsAt);
				// Some providers omit the reset timestamp; a deep drop still means a fresh window.
				const dropped = current !== undefined && hasActivity(current)
					&& (current.peakUtilization ?? 0) - event.utilization >= 50;
				if (current && (windowChanged || dropped)) {
					// An idle provider reports 0% with a reset time that keeps moving; that is not a
					// window worth keeping. Only a window with tracked tokens becomes history.
					if (hasActivity(current)) {
						if (!current.closedBy) {
							current.endedAt = event.at;
							current.closedBy = "reset";
						}
						report.completed.push(current);
					}
					report.current = report.current.filter(record => record !== current);
					const next = createRecord(event.provider, windowKind, event.at, hasActivity(current) ? "reset" : "first-seen", event);
					perProvider.set(event.provider, next);
					report.current.push(next);
					continue;
				}
				const record = ensure(event.provider, event.at, current ? current.origin : "first-seen", event);
				record.plan = event.plan ?? record.plan;
				record.resetsAt = event.resetsAt ?? record.resetsAt;
				const previousPeak = record.peakUtilization ?? 0;
				record.peakUtilization = Math.max(previousPeak, event.utilization);
				if (event.utilization >= 100 && previousPeak < 100 && !record.closedBy && hasActivity(record)) {
					// Full window: keep the totals and start the next window from zero.
					record.endedAt = event.at;
					record.closedBy = "limit-hit";
					report.completed.push(record);
					report.exhausted.push(record);
					report.current = report.current.filter(candidate => candidate !== record);
					// The next window starts after the hit, so the 100% report is not its usage.
					const next = createRecord(event.provider, windowKind, event.at, "limit-hit", undefined);
					next.resetsAt = event.resetsAt;
					perProvider.set(event.provider, next);
					report.current.push(next);
				}
				continue;
			}
			if (event.type !== "usage") {
				continue;
			}
			const record = ensure(event.provider, event.at, "first-seen");
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
			plan: report.current.find(record => record.plan)?.plan ?? report.completed.at(-1)?.plan,
			current: report.current.map(finish),
			completed: [...report.completed].reverse().map(finish),
			exhausted: [...report.exhausted].reverse().map(finish),
		});
	}
	return { generatedAt: Date.now(), providers: output.sort((left, right) => left.provider.localeCompare(right.provider)) };
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
	if (record.provider !== "claude" && record.provider !== "codex") {
		return undefined;
	}
	const number = (input: unknown) => typeof input === "number" && Number.isFinite(input) && input >= 0 ? Math.floor(input) : 0;
	const at = number(record.at);
	if (!at) {
		return undefined;
	}
	if (record.type === "usage") {
		return {
			type: "usage",
			id: typeof record.id === "string" ? record.id : `${record.provider}:${at}`,
			provider: record.provider,
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
		provider: record.provider,
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
			this.windows.set(key, { utilization, resetsAt });
			// An idle provider reports 0% with a reset time that moves every minute; storing that
			// only creates empty windows. A real reset is detected from the next used sample.
			if (utilization <= 0 && !hitLimit) {
				continue;
			}
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
