import { createHash, randomUUID } from "node:crypto";
import type { LlamaChatTurnMetrics } from "../llama-provider";
import type { ProviderRuntimeMetrics } from "../provider-metrics";
import type { CursorSession } from "./session-store";

export interface CursorUsage { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number }
export interface CursorRecordedUsage { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; modelId: string; sourceKey: string; durationMs: number; modelTurns: number; estimated?: boolean }
export interface CursorLiveTurn { turn: LlamaChatTurnMetrics; runtime: ProviderRuntimeMetrics; sourceKey: string }

/** Cursor native inputTokens already includes cache reads/writes. SDK 1.0.37 can double-count them in totalTokens. */
export function parseCursorUsage(value: unknown): CursorUsage | undefined {
	if (!value || typeof value !== "object") { return undefined; }
	const usage = value as Record<string, unknown>;
	const fields = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
	if (!fields.every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) { return undefined; }
	const [input, output, read, write] = fields as number[], total = input + output, expanded = total + read + write;
	if (read + write > input || !Number.isSafeInteger(expanded) || usage.totalTokens !== undefined && usage.totalTokens !== total && usage.totalTokens !== expanded) { return undefined; }
	return { inputTokens: input, outputTokens: output, cachedInputTokens: read, cacheWriteInputTokens: write };
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
	private readonly previousCompletedAt: number | undefined;
	private readonly previousCatalog: string | undefined;
	private readonly diagnostics: NonNullable<LlamaChatTurnMetrics["cursorCacheDiagnostics"]> = {
		usageScope: "native-run-aggregate", modelCallBreakdown: "unreported", compactionStatus: "unreported", toolCatalogChangesDuringRun: 0,
	};
	constructor(private readonly modelId: string, private readonly sourceKey: string, private readonly count: number,
		private readonly session: CursorSession, private readonly publish: (update: CursorLiveTurn) => void) {
		this.previousCompletedAt = session.completedAt; this.previousCatalog = session.toolCatalogHash;
	}
	catalog(tools: Record<string, unknown>): void {
		// Compare the effective SDK schemas/descriptions; executable callbacks are omitted.
		const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
			? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== "function").sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
		const hash = createHash("sha256").update(JSON.stringify(stable(tools))).digest("hex");
		if (this.diagnostics.toolCatalogHash && this.diagnostics.toolCatalogHash !== hash) { this.diagnostics.toolCatalogChangesDuringRun++; }
		this.diagnostics.toolCatalogHash = hash;
		this.diagnostics.toolCatalogChanged = this.previousCatalog === undefined ? undefined : this.previousCatalog !== hash;
	}
	input(text: string, messages: number, images: number): void {
		this.diagnostics.sentTextChars = text.length; this.diagnostics.sentMessages = messages; this.diagnostics.sentImages = images;
	}
	run(id?: string): void { this.diagnostics.nativeRunId = id; }
	get catalogHash(): string | undefined { return this.diagnostics.toolCatalogHash; }
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
			gapSinceLastResponseMs: this.previousCompletedAt !== undefined && this.previousCompletedAt <= this.started ? this.started - this.previousCompletedAt : undefined,
			gapKind: this.previousCompletedAt === undefined ? undefined : "user",
			cursorCacheDiagnostics: { ...this.diagnostics, sessionReason: this.session.reason,
				uncachedInputTokens: usage && !this.missing ? usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens : undefined },
			firstTokenLatencyMs: this.firstToken, emittedParts: this.parts, outputChars: this.outputChars, thinkingChars: this.thinkingChars,
			estimatedOutputTokens: usage?.outputTokens ?? Math.ceil((this.outputChars + this.thinkingChars) / 4), outputTokens: usage?.outputTokens,
			promptTokens: usage?.inputTokens ?? 0, cachedPromptTokens: cached, cacheWriteInputTokens: this.missing ? undefined : usage?.cacheWriteInputTokens,
			promptCacheHitPercent: hit, cacheMissReason: cached === undefined ? "usage_not_reported" : hit !== undefined && hit >= 90 ? "healthy"
				: this.session.mode === "new" && this.session.reason === "new_conversation" ? "cold_start"
				: this.session.mode === "new" || this.session.mode === "resume-fallback" ? "session_not_reused" : "unknown",
				cacheMissDetail: `Cursor aggregate usage across a native run, including internal tool/model work; session ${this.session.mode} (${this.session.reason ?? "unknown"}). Cache writes are observed usage, not proof of a lost session. Per-model-call usage, compaction, cache TTL and eviction reasons are unreported. Input includes cache once.`,
			modelTurns: this.prompts, usageEstimated: !usage || this.missing,
			retriedAfterOverflow: false, toolCalls: this.toolCalls, repairedToolCalls: 0, rejectedToolCalls: 0, schemaRejectedToolCalls: 0,
			toolCallRepairRetries: 0, toolLoopDetected: false, metricsSource: "live",
		}, runtime: { modelId: this.modelId, phase: this.phase === "running" ? "running" : "completed", estimated: this.missing || undefined,
			inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, cachedInputTokens: cached, updatedAt: this.last,
			throughputTokensPerSecond: usage && durationMs > 0 ? usage.outputTokens / (durationMs / 1000) : undefined } });
	}
}