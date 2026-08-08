import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { asRecord } from "../utils";

const MAX_RETAINED_USAGE_SEGMENTS = 128;

export interface CodexUsageSegmentMetrics {
	index: number;
	recordedAt: string;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	cacheHitPercent?: number;
}

export interface CodexToolDurationMetrics {
	count: number;
	totalMs: number;
	averageMs: number;
	maximumMs: number;
	p95Ms: number;
}

export interface CodexTurnStepMetrics {
	id: string;
	index: number;
	kind: "model" | "tool";
	label: string;
	status: "running" | "completed" | "failed" | "timed_out" | "cancelled";
	toolCategory?: "vscode" | "catalog";
	startedAt: string;
	completedAt?: string;
	durationMs?: number;
	inputTokens?: number;
	cachedInputTokens?: number;
	outputTokens?: number;
	reasoningOutputTokens?: number;
	totalTokens?: number;
	cacheHitPercent?: number;
}

export interface CodexRolloutTurnMetrics {
	source: "rollout";
	turnId: string;
	completed: boolean;
	startedAt?: string;
	completedAt?: string;
	durationMs?: number;
	firstModelEventLatencyMs?: number;
	firstVisibleMessageLatencyMs?: number;
	modelSegments: number;
	usageSegments: CodexUsageSegmentMetrics[];
	usageSegmentsTruncated: boolean;
	steps: CodexTurnStepMetrics[];
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	cacheHitPercent?: number;
	averageSegmentCacheHitPercent?: number;
	worstSegmentCacheHitPercent?: number;
	bestSegmentCacheHitPercent?: number;
	toolCalls: number;
	toolOutputs: number;
	toolNames: Record<string, number>;
	toolDuration?: CodexToolDurationMetrics;
}

export interface CodexLiveTurnMetrics {
	source: "live";
	modelSegments: number;
	usageSegments: CodexUsageSegmentMetrics[];
	usageSegmentsTruncated: boolean;
	steps: CodexTurnStepMetrics[];
	firstModelEventLatencyMs?: number;
	firstVisibleMessageLatencyMs?: number;
	toolCalls: number;
	toolNames: Record<string, number>;
	toolDuration?: CodexToolDurationMetrics;
}

interface PendingToolCall {
	name: string;
	startedAt: number;
	startedAtValue: string;
	toolCategory: "vscode" | "catalog";
}

interface RolloutEnvelope {
	timestamp?: unknown;
	type?: unknown;
	payload?: unknown;
}

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, value)
		: 0;
}

function timestampMs(value: unknown): number | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function percentile95(sorted: readonly number[]): number {
	if (sorted.length === 0) {
		return 0;
	}
	return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

export function summarizeCodexToolDurations(values: readonly number[]): CodexToolDurationMetrics | undefined {
	const normalized = values
		.filter(value => Number.isFinite(value) && value >= 0)
		.map(value => Math.round(value))
		.sort((a, b) => a - b);
	if (normalized.length === 0) {
		return undefined;
	}
	const totalMs = normalized.reduce((sum, value) => sum + value, 0);
	return {
		count: normalized.length,
		totalMs,
		averageMs: Math.round(totalMs / normalized.length),
		maximumMs: normalized[normalized.length - 1],
		p95Ms: percentile95(normalized),
	};
}

class CodexRolloutAccumulator {
	private active = false;
	private found = false;
	private completed = false;
	private startedAtValue: string | undefined;
	private startedAtMs: number | undefined;
	private completedAtValue: string | undefined;
	private completedAtMs: number | undefined;
	private firstModelEventAtMs: number | undefined;
	private firstVisibleMessageAtMs: number | undefined;
	private readonly usageSegments: CodexUsageSegmentMetrics[] = [];
	private usageSegmentCount = 0;
	private inputTokens = 0;
	private cachedInputTokens = 0;
	private outputTokens = 0;
	private reasoningOutputTokens = 0;
	private totalTokens = 0;
	private segmentCacheHitTotal = 0;
	private segmentCacheHitCount = 0;
	private worstSegmentCacheHitPercent: number | undefined;
	private bestSegmentCacheHitPercent: number | undefined;
	private readonly pendingTools = new Map<string, PendingToolCall>();
	private readonly toolSteps = new Map<string, CodexTurnStepMetrics>();
	private readonly toolNames = new Map<string, number>();
	private toolOutputs = 0;
	private readonly toolDurations: number[] = [];

	constructor(private readonly turnId: string) {}

	get isComplete(): boolean {
		return this.completed;
	}

	addLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}
		let envelope: RolloutEnvelope;
		try {
			envelope = JSON.parse(trimmed) as RolloutEnvelope;
		} catch {
			// A rollout can end with a partially flushed JSONL line while a turn is live.
			return;
		}
		this.addEnvelope(envelope);
	}

	result(): CodexRolloutTurnMetrics | undefined {
		if (!this.found) {
			return undefined;
		}
		const cacheHitPercent = this.inputTokens > 0
			? Number((this.cachedInputTokens / this.inputTokens * 100).toFixed(1))
			: undefined;
		const durationMs = this.startedAtMs !== undefined && this.completedAtMs !== undefined
			? Math.max(0, this.completedAtMs - this.startedAtMs)
			: undefined;
		return {
			source: "rollout",
			turnId: this.turnId,
			completed: this.completed,
			startedAt: this.startedAtValue,
			completedAt: this.completedAtValue,
			durationMs,
			firstModelEventLatencyMs: this.latencyFromStart(this.firstModelEventAtMs),
			firstVisibleMessageLatencyMs: this.latencyFromStart(this.firstVisibleMessageAtMs),
			modelSegments: this.usageSegmentCount,
			usageSegments: [...this.usageSegments],
			usageSegmentsTruncated: this.usageSegmentCount > this.usageSegments.length,
			steps: this.buildSteps(),
			inputTokens: this.inputTokens,
			cachedInputTokens: this.cachedInputTokens,
			outputTokens: this.outputTokens,
			reasoningOutputTokens: this.reasoningOutputTokens,
			totalTokens: this.totalTokens,
			cacheHitPercent,
			averageSegmentCacheHitPercent: this.segmentCacheHitCount > 0
				? Number((this.segmentCacheHitTotal / this.segmentCacheHitCount).toFixed(1))
				: undefined,
			worstSegmentCacheHitPercent: this.worstSegmentCacheHitPercent,
			bestSegmentCacheHitPercent: this.bestSegmentCacheHitPercent,
			toolCalls: this.pendingTools.size,
			toolOutputs: this.toolOutputs,
			toolNames: Object.fromEntries(
				[...this.toolNames.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
			),
			toolDuration: summarizeCodexToolDurations(this.toolDurations),
		};
	}

	private addEnvelope(envelope: RolloutEnvelope): void {
		const payload = asRecord(envelope.payload);
		const payloadType = typeof payload.type === "string" ? payload.type : undefined;
		const envelopeType = typeof envelope.type === "string" ? envelope.type : undefined;
		const recordedAt = typeof envelope.timestamp === "string" ? envelope.timestamp : undefined;
		const recordedAtMs = timestampMs(envelope.timestamp);

		if (envelopeType === "event_msg" && payloadType === "task_started") {
			if (payload.turn_id === this.turnId) {
				this.active = true;
				this.found = true;
				this.startedAtValue = recordedAt;
				this.startedAtMs = recordedAtMs;
			} else if (this.active) {
				this.active = false;
			}
			return;
		}
		if (!this.active) {
			return;
		}
		if (envelopeType === "event_msg" && payloadType === "task_complete") {
			if (payload.turn_id === undefined || payload.turn_id === this.turnId) {
				this.completed = true;
				this.active = false;
				this.completedAtValue = recordedAt;
				this.completedAtMs = recordedAtMs;
				for (const [callId, step] of this.toolSteps) {
					if (step.status === "running") {
						this.toolSteps.set(callId, {
							...step,
							status: "failed",
							completedAt: recordedAt,
							durationMs: recordedAtMs !== undefined
								? Math.max(0, recordedAtMs - Date.parse(step.startedAt))
								: undefined,
						});
					}
				}
			}
			return;
		}

		if (
			(envelopeType === "event_msg" && (payloadType === "agent_reasoning" || payloadType === "agent_message"))
			|| (envelopeType === "response_item" && (payloadType === "function_call" || payloadType === "tool_search_call"))
		) {
			this.firstModelEventAtMs ??= recordedAtMs;
		}
		if (envelopeType === "event_msg" && payloadType === "agent_message") {
			this.firstVisibleMessageAtMs ??= recordedAtMs;
		}

		if (envelopeType === "event_msg" && payloadType === "token_count") {
			this.addUsageSegment(payload, recordedAt);
			return;
		}
		if (envelopeType !== "response_item") {
			return;
		}
		if (payloadType === "function_call" || payloadType === "tool_search_call") {
			const callId = typeof payload.call_id === "string"
				? payload.call_id
				: typeof payload.id === "string" ? payload.id : undefined;
			if (!callId || this.pendingTools.has(callId)) {
				return;
			}
			const toolCategory = payloadType === "tool_search_call" ? "catalog" : "vscode";
			const name = typeof payload.name === "string" ? payload.name : payloadType;
			const startedAtValue = recordedAt ?? new Date(recordedAtMs ?? 0).toISOString();
			this.pendingTools.set(callId, {
				name,
				startedAt: recordedAtMs ?? 0,
				startedAtValue,
				toolCategory,
			});
			this.toolSteps.set(callId, {
				id: `tool-${callId}`,
				index: 0,
				kind: "tool",
				label: toolCategory === "catalog" ? "Tool catalog search" : name,
				status: "running",
				toolCategory,
				startedAt: startedAtValue,
			});
			this.toolNames.set(name, (this.toolNames.get(name) ?? 0) + 1);
			return;
		}
		if (payloadType === "function_call_output" || payloadType === "tool_search_output") {
			this.toolOutputs += 1;
			const callId = typeof payload.call_id === "string"
				? payload.call_id
				: typeof payload.id === "string" ? payload.id : undefined;
			const pending = callId ? this.pendingTools.get(callId) : undefined;
			if (pending && recordedAtMs !== undefined && pending.startedAt > 0 && recordedAtMs >= pending.startedAt) {
				const durationMs = recordedAtMs - pending.startedAt;
				this.toolDurations.push(durationMs);
				const step = callId ? this.toolSteps.get(callId) : undefined;
				if (step) {
					this.toolSteps.set(callId!, {
						...step,
						status: "completed",
						completedAt: recordedAt,
						durationMs,
					});
				}
			}
		}
	}

	private buildSteps(): CodexTurnStepMetrics[] {
		const steps: CodexTurnStepMetrics[] = [
			...this.usageSegments.map(segment => ({
				id: `model-${segment.index}`,
				index: 0,
				kind: "model" as const,
				label: `Model segment ${segment.index}`,
				status: "completed" as const,
				startedAt: segment.recordedAt,
				inputTokens: segment.inputTokens,
				cachedInputTokens: segment.cachedInputTokens,
				outputTokens: segment.outputTokens,
				reasoningOutputTokens: segment.reasoningOutputTokens,
				totalTokens: segment.totalTokens,
				cacheHitPercent: segment.cacheHitPercent,
			})),
			...this.toolSteps.values(),
		];
		return steps
			.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
			.map((step, index) => ({ ...step, index: index + 1 }));
	}

	private addUsageSegment(payload: Record<string, unknown>, recordedAt: string | undefined): void {
		const info = asRecord(payload.info);
		const usage = asRecord(info.last_token_usage);
		if (Object.keys(usage).length === 0) {
			return;
		}
		const inputTokens = finiteNonNegative(usage.input_tokens);
		const cachedInputTokens = finiteNonNegative(usage.cached_input_tokens);
		const outputTokens = finiteNonNegative(usage.output_tokens);
		const reasoningOutputTokens = finiteNonNegative(usage.reasoning_output_tokens);
		const totalTokens = finiteNonNegative(usage.total_tokens) || inputTokens + outputTokens;
		const cacheHitPercent = inputTokens > 0
			? Number((cachedInputTokens / inputTokens * 100).toFixed(1))
			: undefined;
		this.usageSegmentCount += 1;
		this.inputTokens += inputTokens;
		this.cachedInputTokens += cachedInputTokens;
		this.outputTokens += outputTokens;
		this.reasoningOutputTokens += reasoningOutputTokens;
		this.totalTokens += totalTokens;
		if (cacheHitPercent !== undefined) {
			this.segmentCacheHitTotal += cacheHitPercent;
			this.segmentCacheHitCount += 1;
			this.worstSegmentCacheHitPercent = this.worstSegmentCacheHitPercent === undefined
				? cacheHitPercent
				: Math.min(this.worstSegmentCacheHitPercent, cacheHitPercent);
			this.bestSegmentCacheHitPercent = this.bestSegmentCacheHitPercent === undefined
				? cacheHitPercent
				: Math.max(this.bestSegmentCacheHitPercent, cacheHitPercent);
		}
		if (this.usageSegments.length < MAX_RETAINED_USAGE_SEGMENTS) {
			this.usageSegments.push({
				index: this.usageSegmentCount,
				recordedAt: recordedAt ?? "",
				inputTokens,
				cachedInputTokens,
				outputTokens,
				reasoningOutputTokens,
				totalTokens,
				cacheHitPercent,
			});
		}
	}

	private latencyFromStart(value: number | undefined): number | undefined {
		return this.startedAtMs !== undefined && value !== undefined
			? Math.max(0, value - this.startedAtMs)
			: undefined;
	}
}

export function parseCodexRolloutMetrics(content: string, turnId: string): CodexRolloutTurnMetrics | undefined {
	const accumulator = new CodexRolloutAccumulator(turnId);
	for (const line of content.split(/\r?\n/)) {
		accumulator.addLine(line);
		if (accumulator.isComplete) {
			break;
		}
	}
	return accumulator.result();
}

export async function readCodexRolloutMetrics(
	filePath: string,
	turnId: string
): Promise<CodexRolloutTurnMetrics | undefined> {
	const accumulator = new CodexRolloutAccumulator(turnId);
	const input = createReadStream(filePath, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			accumulator.addLine(line);
			if (accumulator.isComplete) {
				break;
			}
		}
	} finally {
		lines.close();
		input.destroy();
	}
	return accumulator.result();
}