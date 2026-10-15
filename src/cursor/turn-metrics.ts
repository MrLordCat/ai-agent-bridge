import { randomUUID } from "node:crypto";
import type { LlamaChatTurnMetrics } from "../llama-provider";
import type { ProviderRuntimeMetrics } from "../provider-metrics";
import type { CursorSession } from "./session-store";

export interface CursorUsage { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number }
export interface CursorRecordedUsage { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; modelId: string; sourceKey: string; durationMs: number; modelTurns: number; estimated?: boolean }
export interface CursorLiveTurn { turn: LlamaChatTurnMetrics; runtime: ProviderRuntimeMetrics; sourceKey: string }

/** SDK inputTokens are fresh tokens: totalTokens also includes both cache fields. */
export function parseCursorUsage(value: unknown): CursorUsage | undefined {
	if (!value || typeof value !== "object") { return undefined; }
	const usage = value as Record<string, unknown>;
	const fields = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
	if (!fields.every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) { return undefined; }
	const [fresh, output, read, write] = fields as number[], total = fresh + output + read + write;
	if (!Number.isSafeInteger(total) || usage.totalTokens !== undefined && usage.totalTokens !== total) { return undefined; }
	return { inputTokens: fresh + read + write, outputTokens: output, cachedInputTokens: read, cacheWriteInputTokens: write };
}

export class CursorTurnMetrics {
	private readonly requestId = `cursor-${randomUUID()}`;
	private readonly started = Date.now();
	private usage?: CursorUsage;
	private missing = false;
	private prompts = 0;
	private outputChars = 0;
	private thinkingChars = 0;
	private toolCalls = 0;
	private parts = 0;
	private firstToken?: number;
	private last = 0;
	private phase: LlamaChatTurnMetrics["lifecyclePhase"] = "running";
	private detail?: string;
	constructor(private readonly modelId: string, private readonly sourceKey: string, private readonly count: number,
		private readonly session: CursorSession, private readonly publish: (update: CursorLiveTurn) => void) {}
	text(value: string, thinking = false): void {
		this.firstToken ??= Date.now() - this.started; this.parts++;
		if (thinking) { this.thinkingChars += value.length; } else { this.outputChars += value.length; }
		if (Date.now() - this.last > 250) { this.emit(); }
	}
	tool(): void { this.toolCalls++; this.emit(); }
	result(value: unknown): void {
		this.prompts++; const usage = parseCursorUsage(value);
		if (!usage) { this.missing = true; } else if (!this.usage) { this.usage = usage; }
		else { for (const key of Object.keys(usage) as Array<keyof CursorUsage>) { this.usage[key] += usage[key]; } }
		this.emit();
	}
	finish(error?: Error): CursorRecordedUsage | undefined {
		this.phase = error ? /Cancel/i.test(error.name) ? "interrupted" : "failed" : "completed";
		this.detail = error?.message; this.emit();
		return this.usage ? { ...this.usage, cachedInputTokens: this.missing ? undefined : this.usage.cachedInputTokens,
			cacheWriteInputTokens: this.missing ? undefined : this.usage.cacheWriteInputTokens, modelId: this.modelId, sourceKey: this.sourceKey, durationMs: Date.now() - this.started,
			modelTurns: this.prompts, estimated: this.missing || undefined } : undefined;
	}
	private emit(): void {
		this.last = Date.now(); const usage = this.usage, cached = this.missing ? undefined : usage?.cachedInputTokens;
		const hit = cached === undefined || !usage?.inputTokens ? undefined : cached / usage.inputTokens * 100;
		const durationMs = this.last - this.started;
		this.publish({ sourceKey: this.sourceKey, turn: {
			requestId: this.requestId, modelId: this.modelId, providerKind: "cursor", lifecyclePhase: this.phase,
			sessionMode: this.session.mode, conversationKey: this.session.key, inputMode: this.session.mode === "warm" || this.session.mode === "restored" ? "user-turn" : "history-import",
			terminalDetail: this.detail, startedAtMs: this.started, durationMs, queueWaitMs: 0, messageCount: this.count,
			firstTokenLatencyMs: this.firstToken, emittedParts: this.parts, outputChars: this.outputChars, thinkingChars: this.thinkingChars,
			estimatedOutputTokens: usage?.outputTokens ?? Math.ceil((this.outputChars + this.thinkingChars) / 4), outputTokens: usage?.outputTokens,
			promptTokens: usage?.inputTokens ?? 0, cachedPromptTokens: cached, cacheWriteInputTokens: this.missing ? undefined : usage?.cacheWriteInputTokens,
			promptCacheHitPercent: hit, cacheMissReason: cached === undefined ? "usage_not_reported" : hit !== undefined && hit >= 90 ? "healthy"
				: this.session.mode === "new" || this.session.mode === "resume-fallback" ? "session_not_reused" : this.session.mode === "restored" ? "session_restored" : "unknown",
			cacheMissDetail: "Cursor SDK run usage. Cache reads are native counters; cumulative billed tokens are separate from context occupancy. Server cache eviction reasons are unknown.",
			compacted: false, modelTurns: this.prompts, usageEstimated: !usage || this.missing,
			retriedAfterOverflow: false, toolCalls: this.toolCalls, repairedToolCalls: 0, rejectedToolCalls: 0, schemaRejectedToolCalls: 0,
			toolCallRepairRetries: 0, toolLoopDetected: false, metricsSource: "live",
		}, runtime: { modelId: this.modelId, phase: this.phase === "running" ? "running" : "completed", estimated: this.missing || undefined,
			inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, cachedInputTokens: cached, updatedAt: this.last,
			throughputTokensPerSecond: usage && durationMs > 0 ? usage.outputTokens / (durationMs / 1000) : undefined } });
	}
}