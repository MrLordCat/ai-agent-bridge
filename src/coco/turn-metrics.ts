import { randomUUID } from "node:crypto";
import type { LlamaChatContextUsageMetrics, LlamaChatTurnMetrics } from "../llama-provider";
import type { ProviderRuntimeMetrics } from "../provider-metrics";
import { parseCocoContextUsage, parseCocoTokenUsage, sumCocoUsage, type CocoContextUsage, type CocoTokenUsage } from "./usage-adapter";

export interface CocoLiveTurn { turn: LlamaChatTurnMetrics; context?: LlamaChatContextUsageMetrics; runtime: ProviderRuntimeMetrics }
export interface CocoRecordedUsage extends CocoTokenUsage { modelId: string; durationMs: number; modelTurns: number; estimated?: boolean }

export class CocoTurnMetrics {
	readonly requestId = `coco-${randomUUID()}`;
	readonly started = Date.now();
	private readonly usage: CocoTokenUsage[] = [];
	private missingUsage = false;
	private context?: CocoContextUsage;
	private compacted = false;
	private outputChars = 0;
	private thinkingChars = 0;
	private emittedParts = 0;
	private toolCalls = 0;
	private firstToken?: number;
	private lastPublished = 0;
	private phase: LlamaChatTurnMetrics["lifecyclePhase"] = "running";
	private terminalDetail?: string;
	private mode: LlamaChatTurnMetrics["sessionMode"] = "new";
	private conversationKey?: string;
	private reason?: string;
	constructor(readonly modelId: string, private readonly messageCount: number, private readonly publish: (value: CocoLiveTurn) => void) {}
	private transport = "acp";
	setSession(mode: LlamaChatTurnMetrics["sessionMode"], conversationKey: string, reason?: string, transport = "acp"): void { this.mode = mode; this.conversationKey = conversationKey; this.reason = reason; this.transport = transport; this.emit(); }
	accept(update: Record<string, unknown>, importing = false): void {
		if (update.sessionUpdate === "compaction") { this.compacted = true; this.emit(); return; }
		const context = parseCocoContextUsage(update);
		if (context) { this.compacted ||= this.context !== undefined && context.usedTokens < this.context.usedTokens; this.context = context; this.emit(); return; }
		if (importing || (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk")) { return; }
		const content = update.content as { type?: unknown; text?: unknown } | undefined;
		if (content?.type !== "text" || typeof content.text !== "string") { return; }
		this.firstToken ??= Date.now() - this.started;
		if (update.sessionUpdate === "agent_thought_chunk") { this.thinkingChars += content.text.length; }
		else { this.outputChars += content.text.length; }
		this.emittedParts++;
		if (Date.now() - this.lastPublished >= 250) { this.emit(); }
	}
	tool(): void { this.toolCalls++; this.emit(); }
	result(value: unknown): void {
		const usage = parseCocoTokenUsage(value);
		if (usage) { this.usage.push(usage); } else { this.missingUsage = true; }
		this.emit();
	}
	finish(error?: Error): CocoRecordedUsage | undefined {
		this.phase = error ? error.name === "Canceled" || error.name === "CancellationError" ? "interrupted" : "failed" : "completed";
		this.terminalDetail = error?.message;
		this.emit();
		const usage = sumCocoUsage(this.usage);
		return usage ? { ...usage, cachedInputTokens: this.missingUsage ? undefined : usage.cachedInputTokens,
			cacheWriteInputTokens: this.missingUsage ? undefined : usage.cacheWriteInputTokens, estimated: this.missingUsage || undefined,
			modelId: this.modelId, durationMs: Date.now() - this.started, modelTurns: this.usage.length } : undefined;
	}
	private emit(): void {
		this.lastPublished = Date.now();
		const usage = sumCocoUsage(this.usage), context = this.context;
		const cached = this.missingUsage ? undefined : usage?.cachedInputTokens;
		const written = this.missingUsage ? undefined : usage?.cacheWriteInputTokens;
		const percent = cached === undefined || !usage?.inputTokens ? undefined : cached / usage.inputTokens * 100;
		const reason = cached === undefined ? "usage_not_reported" : percent !== undefined && percent >= 90 ? "healthy"
			: this.mode === "new" || this.mode === "resume-fallback" ? "session_not_reused" : this.mode === "restored" ? "session_restored" : "unknown";
		const durationMs = Date.now() - this.started;
		const turn: LlamaChatTurnMetrics = {
			requestId: this.requestId, modelId: this.modelId, providerKind: "coco", lifecyclePhase: this.phase,
			sessionMode: this.mode, conversationKey: this.conversationKey, inputMode: this.mode === "new" || this.mode === "resume-fallback" ? "full" : "user-turn",
			terminalDetail: this.terminalDetail, startedAtMs: this.started, durationMs, queueWaitMs: 0, messageCount: this.messageCount,
			firstTokenLatencyMs: this.firstToken, emittedParts: this.emittedParts, outputChars: this.outputChars, thinkingChars: this.thinkingChars,
			estimatedOutputTokens: usage?.outputTokens ?? Math.ceil((this.outputChars + this.thinkingChars) / 4), outputTokens: usage?.outputTokens,
			promptTokens: usage?.inputTokens ?? 0, cachedPromptTokens: cached, cacheWriteInputTokens: written,
			promptCacheHitPercent: percent, cacheMissReason: reason,
			cacheMissDetail: cached === undefined ? `This Coco ${this.transport} runtime has not reported complete prompt cache counters. Context occupancy is a separate snapshot.`
				: `Coco ${this.transport} native prompt usage; session ${this.mode}${this.reason ? ` (${this.reason})` : ""}. Cache reads are server-reported; a low hit rate does not identify the server's eviction reason.`,
			compacted: this.compacted, modelTurns: this.usage.length, usageEstimated: !usage || this.missingUsage,
			retriedAfterOverflow: false, toolCalls: this.toolCalls, repairedToolCalls: 0, rejectedToolCalls: 0,
			schemaRejectedToolCalls: 0, toolCallRepairRetries: 0, toolLoopDetected: false, metricsSource: "live",
		};
		this.publish({ turn, context: context ? {
			requestId: this.requestId, modelId: this.modelId, attemptNo: 1, contextLength: context.contextWindowTokens,
			inputBudget: context.contextWindowTokens, softInputTarget: context.contextWindowTokens, hardInputTarget: context.contextWindowTokens,
			messageTokensBeforeCompact: context.usedTokens, messageTokensAfterCompact: context.usedTokens,
			messageCountBeforeCompact: this.messageCount, messageCountAfterCompact: this.messageCount, toolTokens: 0, replyReserveTokens: 0,
			cappedTools: 0, autoCompacted: this.compacted, hardCompacted: false, estimatedUsedTokens: context.usedTokens,
			estimatedFreeTokens: Math.max(0, context.contextWindowTokens - context.usedTokens), estimatedUsagePercent: context.usedTokens / context.contextWindowTokens * 100,
			tokenCountSource: "server", rawMaxTokens: context.contextWindowTokens,
		} : undefined, runtime: {
			modelId: this.modelId, phase: this.phase === "running" ? "running" : "completed", estimated: this.missingUsage || undefined,
			inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, cachedInputTokens: cached,
			contextUsedTokens: context?.usedTokens, contextWindowTokens: context?.contextWindowTokens,
			contextUsagePercent: context ? context.usedTokens / context.contextWindowTokens * 100 : undefined,
			contextDetail: `Coco ${this.mode} session${this.compacted ? "; native context compacted" : ""}`, updatedAt: Date.now(),
		} });
	}
}