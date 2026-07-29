import * as vscode from "vscode";
import type { LlamaChatContextUsageMetrics, LlamaChatTurnMetrics } from "../llama-provider";

export interface SessionTurnRecord {
	turn: LlamaChatTurnMetrics;
	context?: LlamaChatContextUsageMetrics;
}

export interface CacheMissBreakdownEntry {
	reason: string;
	count: number;
	percent: number;
}

export interface PerModelCacheStats {
	modelLabel: string;
	turns: number;
	modelSegments: number;
	/** Turns with a classified cache reason (server-reported usage only). */
	reportedTurns: number;
	promptTokens: number;
	cachedTokens: number;
	hitPercent?: number;
	healthyTurns: number;
	missTurns: number;
	subagentTurns: number;
}

export interface SessionQualitySummary {
	turns: number;
	totalModelTurns: number;
	promptTokens: number;
	cachedPromptTokens: number;
	cacheHitPercent?: number;
	/** Total server-reported turns (excludes estimated/fallback usage). */
	turnsWithCacheReport: number;
	/** Turns where the upstream cache served ≥90% of the prompt. */
	cacheHealthyTurns: number;
	/** New Codex threads whose first model segment served less than 90% from cache. */
	cacheStartupMissTurns: number;
	/** Number of distinct miss reasons recorded. */
	cacheMissReasonCount: number;
	/** Detailed breakdown of every non-healthy reason observed. */
	cacheMissBreakdown: CacheMissBreakdownEntry[];
	/** Lowest cache hit percentage across all server-reported turns. */
	cacheWorstHitPercent?: number;
	/** Average of per-turn cached / prompt ratio (excludes estimated turns). */
	cacheAverageHitPercent?: number;
	/** Per-model cache statistics (grouped by model family/provider prefix). */
	cacheByModel: PerModelCacheStats[];
	averageFirstTokenLatencyMs?: number;
	averageTokensPerSecond?: number;
	totalToolCalls: number;
	repairedToolCalls: number;
	rejectedToolCalls: number;
	toolCallRepairRetries: number;
	toolLoopsDetected: number;
	compactedTurns: number;
	overflowRetries: number;
}

function formatPercent(value: number): string {
	return value.toFixed(1);
}

function extractModelLabel(modelId: string): string {
	// "deepseek::deepseek-v4-pro" → "deepseek (v4-pro)"
	// "local::Qwen3.6-27B-Q4_K_M.gguf" → "local (Qwen3.6-27B)"
	// "codex::gpt-5.6-luna" → "codex (gpt-5.6-luna)"
	// "claude::claude-opus-5" → "claude (claude-opus-5)"
	const colon = modelId.indexOf("::");
	if (colon < 0) {
		return modelId;
	}
	const provider = modelId.slice(0, colon);
	const model = modelId.slice(colon + 2);
	// Shorten common model name prefixes
	const short = model
		.replace(/^deepseek-/, "")
		.replace(/^Qwen(3\.\d)-/, "Qwen$1 ")
		.replace(/-Q\d_K_[ML]/g, "")
		.replace(/\.gguf$/, "");
	return `${provider} (${short.length > 30 ? short.slice(0, 27) + "..." : short})`;
}

export class SessionQualityTracker {
	private readonly contexts = new Map<string, LlamaChatContextUsageMetrics>();
	private readonly _records: SessionTurnRecord[] = [];
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	/** Read-only view of recorded turns (most recent last). */
	get records(): readonly SessionTurnRecord[] { return this._records; }

	recordContext(context: LlamaChatContextUsageMetrics): void {
		this.contexts.set(context.requestId, { ...context });
		if (this.contexts.size > 500) {
			const oldestRequestId = this.contexts.keys().next().value as string | undefined;
			if (oldestRequestId) {
				this.contexts.delete(oldestRequestId);
			}
		}
	}

	recordTurn(turn: LlamaChatTurnMetrics): void {
		this.storeTurn(turn, true);
	}

	updateTurn(turn: LlamaChatTurnMetrics): void {
		this.storeTurn(turn, false);
	}

	private storeTurn(turn: LlamaChatTurnMetrics, finalized: boolean): void {
		const correlatedTurn = this.correlateSubagentTurn(turn);
		const existingIndex = this._records.findIndex(record => record.turn.requestId === correlatedTurn.requestId);
		const existing = existingIndex >= 0 ? this._records[existingIndex] : undefined;
		const record = {
			turn: { ...correlatedTurn },
			context: this.contexts.get(correlatedTurn.requestId) ?? existing?.context,
		};
		if (existingIndex >= 0) {
			this._records[existingIndex] = record;
		} else {
			this._records.push(record);
		}
		if (this._records.length > 500) {
			this._records.shift();
		}
		if (finalized) {
			this.contexts.delete(correlatedTurn.requestId);
		}
		this._onDidChange.fire();
	}

	private correlateSubagentTurn(turn: LlamaChatTurnMetrics): LlamaChatTurnMetrics {
		if (
			turn.isSubagent
			|| (turn.providerKind !== "local" && turn.providerKind !== "deepseek")
		) {
			return turn;
		}
		const candidates = [...this._records]
			.reverse()
			.filter(record =>
				(record.turn.providerKind === "codex" || record.turn.providerKind === "claude")
				&& record.turn.lifecyclePhase === "running"
				&& record.turn.steps?.some(step =>
					step.kind === "tool"
					&& step.label === "runSubagent"
					&& step.status === "running"
				)
			);
		const exactParent = turn.conversationKey
			? candidates.find(record => record.turn.conversationKey === turn.conversationKey)
			: undefined;
		const parent = exactParent ?? (candidates.length === 1 ? candidates[0] : undefined);
		const parentStep = parent?.turn.steps?.find(step =>
			step.kind === "tool"
			&& step.label === "runSubagent"
			&& step.status === "running"
		);
		return parent && parentStep
			? {
				...turn,
				isSubagent: true,
				parentRequestId: parent.turn.requestId,
				parentToolCallId: parentStep.id.replace(/^tool-/, ""),
			}
			: turn;
	}

	clear(): void {
		this.contexts.clear();
		this._records.length = 0;
		this._onDidChange.fire();
	}

	get count(): number {
		return this._records.length;
	}

	get summary(): SessionQualitySummary {
		const promptTokens = this._records.reduce((sum, record) => sum + record.turn.promptTokens, 0);
		const cachedPromptTokens = this._records.reduce((sum, record) => sum + (record.turn.cachedPromptTokens ?? 0), 0);

		// Cache analysis: only turns with a server-reported usage payload have a
		// classified reason — estimated turns (no usage from the API) are skipped.
		const turnsWithReport = this._records.filter(
			record => record.turn.cacheMissReason !== undefined
		);
		const turnsWithCacheReport = turnsWithReport.length;
		const cacheStartupMissTurns = turnsWithReport.filter(record =>
			record.turn.providerKind === "codex"
			&& record.turn.threadMode === "new"
			&& typeof record.turn.initialSegmentCacheHitPercent === "number"
			&& record.turn.initialSegmentCacheHitPercent < 90
		).length;

		// Count per reason, excluding "healthy" which we track separately.
		const reasonCounts = new Map<string, number>();
		let cacheHealthyTurns = 0;
		let cacheWorstHit: number | undefined;
		let cacheHitTotal = 0;
		let cacheReportedTurns = 0;
		for (const record of turnsWithReport) {
			const hit = record.turn.continuationCacheHitPercent
				?? record.turn.promptCacheHitPercent;
			if (hit !== undefined) {
				cacheHitTotal += hit;
				cacheReportedTurns += 1;
				if (cacheWorstHit === undefined || hit < cacheWorstHit) {
					cacheWorstHit = hit;
				}
			}
			const reason = record.turn.cacheMissReason!;
			if (reason === "healthy") {
				cacheHealthyTurns += 1;
				continue;
			}
			reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
		}

		const missTotal = turnsWithCacheReport - cacheHealthyTurns;
		const cacheMissBreakdown: CacheMissBreakdownEntry[] = Array.from(reasonCounts.entries())
			.map(([reason, count]) => ({
				reason,
				count,
				percent: missTotal > 0 ? Number(((count / missTotal) * 100).toFixed(1)) : 0,
			}))
			.sort((a, b) => b.count - a.count);

		// Per-model cache breakdown
		const modelBuckets = new Map<string, {
			label: string;
			turns: number;
			modelSegments: number;
			reportedTurns: number;
			promptTokens: number;
			cachedTokens: number;
			healthyTurns: number;
			missTurns: number;
			subagentTurns: number;
		}>();
		for (const record of this.records) {
			const label = extractModelLabel(record.turn.modelId);
			let bucket = modelBuckets.get(label);
			if (!bucket) {
				bucket = { label, turns: 0, modelSegments: 0, reportedTurns: 0, promptTokens: 0, cachedTokens: 0, healthyTurns: 0, missTurns: 0, subagentTurns: 0 };
				modelBuckets.set(label, bucket);
			}
			bucket.turns += 1;
			bucket.modelSegments += Math.max(1, record.turn.modelTurns);
			bucket.promptTokens += record.turn.promptTokens;
			bucket.cachedTokens += record.turn.cachedPromptTokens ?? 0;
			if (record.turn.isSubagent) {
				bucket.subagentTurns += 1;
			}
			if (record.turn.cacheMissReason !== undefined) {
				bucket.reportedTurns += 1;
				if (record.turn.cacheMissReason === "healthy") {
					bucket.healthyTurns += 1;
				} else {
					bucket.missTurns += 1;
				}
			}
		}
		const cacheByModel: PerModelCacheStats[] = Array.from(modelBuckets.values())
			.map(b => ({
				modelLabel: b.label,
				turns: b.turns,
				modelSegments: b.modelSegments,
				reportedTurns: b.reportedTurns,
				promptTokens: b.promptTokens,
				cachedTokens: b.cachedTokens,
				hitPercent: b.promptTokens > 0 ? Number((b.cachedTokens / b.promptTokens * 100).toFixed(1)) : undefined,
				healthyTurns: b.healthyTurns,
				missTurns: b.missTurns,
				subagentTurns: b.subagentTurns,
			}))
			.sort((a, b) => b.turns - a.turns);

		const firstTokenValues = this.records
			.map(record => record.turn.firstTokenLatencyMs)
			.filter((value): value is number => value !== undefined);
		const tpsValues = this.records
			.map(record => record.turn.tokensPerSecond)
			.filter((value): value is number => value !== undefined);
		return {
			turns: this._records.length,
			totalModelTurns: this._records.reduce((sum, record) => sum + Math.max(1, record.turn.modelTurns), 0),
			promptTokens,
			cachedPromptTokens,
			cacheHitPercent: promptTokens > 0 ? Number((cachedPromptTokens / promptTokens * 100).toFixed(1)) : undefined,
			turnsWithCacheReport,
			cacheHealthyTurns,
			cacheStartupMissTurns,
			cacheMissReasonCount: reasonCounts.size,
			cacheMissBreakdown,
			cacheWorstHitPercent: cacheWorstHit,
			cacheAverageHitPercent: cacheReportedTurns > 0
				? Number((cacheHitTotal / cacheReportedTurns).toFixed(1))
				: undefined,
			cacheByModel,
			averageFirstTokenLatencyMs: firstTokenValues.length > 0
				? Math.round(firstTokenValues.reduce((sum, value) => sum + value, 0) / firstTokenValues.length)
				: undefined,
			averageTokensPerSecond: tpsValues.length > 0
				? Number((tpsValues.reduce((sum, value) => sum + value, 0) / tpsValues.length).toFixed(2))
				: undefined,
			totalToolCalls: this._records.reduce((sum, record) => sum + record.turn.toolCalls, 0),
			repairedToolCalls: this._records.reduce((sum, record) => sum + record.turn.repairedToolCalls, 0),
			rejectedToolCalls: this._records.reduce((sum, record) => sum + record.turn.rejectedToolCalls, 0),
			toolCallRepairRetries: this._records.reduce((sum, record) => sum + record.turn.toolCallRepairRetries, 0),
			toolLoopsDetected: this._records.filter(record => record.turn.toolLoopDetected).length,
			compactedTurns: this._records.filter(record => record.context?.autoCompacted || record.context?.hardCompacted).length,
			overflowRetries: this._records.filter(record => record.turn.retriedAfterOverflow).length,
		};
	}

	toJSON(): { generatedAt: string; summary: SessionQualitySummary; turns: SessionTurnRecord[] } {
		return {
			generatedAt: new Date().toISOString(),
			summary: this.summary,
			turns: this._records.map(record => ({
				turn: { ...record.turn },
				context: record.context ? { ...record.context } : undefined,
			})),
		};
	}

	renderMarkdown(extensionVersion: string, vscodeVersion: string): string {
		const summary = this.summary;
		const lines = [
			"# Local LLM Session Quality Report",
			"",
			`Generated: ${new Date().toISOString()}`,
			`Extension: ${extensionVersion}`,
			`VS Code: ${vscodeVersion}`,
			"",
			"## Summary",
			"",
			`- Turns: ${summary.turns}`,
			`- Model segments: ${summary.totalModelTurns}`,
			`- Prompt tokens: ${summary.promptTokens}`,
			`- Cached prompt tokens: ${summary.cachedPromptTokens} (${summary.cacheHitPercent ?? "n/a"}%)`,
			summary.cacheAverageHitPercent !== undefined
				? `- Average per-turn cache hit: ${formatPercent(summary.cacheAverageHitPercent)}%`
				: `- Average per-turn cache hit: n/a`,
			summary.cacheWorstHitPercent !== undefined
				? `- Worst per-turn cache hit: ${formatPercent(summary.cacheWorstHitPercent)}%`
				: `- Worst per-turn cache hit: n/a`,
			`- Average first-token latency: ${summary.averageFirstTokenLatencyMs ?? "n/a"} ms`,
			`- Average generation speed: ${summary.averageTokensPerSecond ?? "n/a"} tok/s`,
			`- Tool calls: ${summary.totalToolCalls}`,
			`- Tool calls repaired/rejected: ${summary.repairedToolCalls}/${summary.rejectedToolCalls}`,
			`- Tool-call correction retries: ${summary.toolCallRepairRetries}`,
			`- Tool loops detected: ${summary.toolLoopsDetected}`,
			`- Compacted turns: ${summary.compactedTurns}`,
			`- Context-overflow retries: ${summary.overflowRetries}`,
			"",
		];

		// --- Per-model cache breakdown ---
		if (summary.cacheByModel.length > 0) {
			lines.push(
				"## Cache by Model",
				"",
				"| Model | Turns | Segments | Prompt | Cached | Hit% | Healthy | Miss | Subagent |",
				"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
			);
			for (const m of summary.cacheByModel) {
				const sub = m.subagentTurns > 0 ? `${m.subagentTurns}` : "—";
				lines.push(
					`| ${m.modelLabel} | ${m.turns} | ${m.modelSegments} | ${m.promptTokens} | ${m.cachedTokens} | ${m.hitPercent !== undefined ? formatPercent(m.hitPercent) + "%" : "n/a"} | ${m.healthyTurns} | ${m.missTurns} | ${sub} |`
				);
			}
			lines.push("");
		}

		// --- Cache Analysis section ---
		if (summary.turnsWithCacheReport > 0) {
			const missCount = summary.turnsWithCacheReport - summary.cacheHealthyTurns;
			lines.push(
				"## Cache Miss Reasons",
				"",
				`- Server-reported turns: ${summary.turnsWithCacheReport} of ${summary.turns} total`,
				`- Healthy cache turns (≥90% hit): ${summary.cacheHealthyTurns}`,
				`- Cache miss turns: ${missCount}`,
				`- Cold Codex startup segments recovered separately: ${summary.cacheStartupMissTurns}`,
				`- Unique miss reasons: ${summary.cacheMissReasonCount}`,
				"",
			);

			if (summary.cacheMissBreakdown.length > 0) {
				lines.push(
					"| Reason | Count | % of misses |",
					"| --- | ---: | ---: |",
				);
				for (const entry of summary.cacheMissBreakdown) {
					lines.push(`| \`${entry.reason}\` | ${entry.count} | ${formatPercent(entry.percent)}% |`);
				}
				lines.push("");
			}
		}

		// --- Turns table (enhanced with cache diagnostic columns) ---
		const hasAnyPrefixData = this._records.some(
			record => record.turn.cacheMissReason !== undefined || record.turn.prefixIdenticalMessageCount !== undefined
		);

		lines.push(
			"## Turns",
			"",
		);

		if (hasAnyPrefixData) {
			lines.push(
				"| # | Model | Prompt | Cache | Hit% | Reason | Match Msg | Detail | TTFT ms | tok/s | Context | Compact |",
				"| ---: | --- | ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | ---: | --- |",
			);
			for (const [index, record] of this._records.entries()) {
				const turn = record.turn;
				const context = record.context;
				const hitPercent = turn.promptCacheHitPercent !== undefined
					? formatPercent(turn.promptCacheHitPercent)
					: "n/a";
				const reason = turn.cacheMissReason
					?? (turn.cachedPromptTokens !== undefined ? "—" : "n/a");
				const prefixMatch = turn.prefixIdenticalMessageCount !== undefined
					? String(turn.prefixIdenticalMessageCount)
					: "n/a";
				const detailShort = turn.cacheMissDetail
					? turn.cacheMissDetail.length > 80
						? turn.cacheMissDetail.slice(0, 77) + "..."
						: turn.cacheMissDetail
					: "—";
				const subLabel = turn.isSubagent ? " sub" : "";
				lines.push([
					`| ${index + 1}${subLabel}`,
					turn.modelId.replace(/\|/g, "\\|"),
					turn.promptTokens,
					turn.cachedPromptTokens ?? 0,
					hitPercent,
					reason,
					prefixMatch,
					detailShort.replace(/\|/g, "\\|"),
					turn.firstTokenLatencyMs ?? "n/a",
					turn.tokensPerSecond ?? "n/a",
					context ? `${context.estimatedUsagePercent.toFixed(1)}%` : "n/a",
					context?.hardCompacted ? "hard" : context?.autoCompacted ? "auto" : "no",
				].join(" | ") + " |");
			}
		} else {
			lines.push(
				"| # | Model | Prompt | Cache | TTFT ms | tok/s | Tools | Repair | Reject | Context | Compact |",
				"| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
			);
			for (const [index, record] of this._records.entries()) {
				const turn = record.turn;
				const context = record.context;
				lines.push([
					`| ${index + 1}`,
					turn.modelId.replace(/\|/g, "\\|"),
					turn.promptTokens,
					turn.cachedPromptTokens ?? 0,
					turn.firstTokenLatencyMs ?? "n/a",
					turn.tokensPerSecond ?? "n/a",
					turn.toolCalls,
					turn.repairedToolCalls,
					turn.rejectedToolCalls,
					context ? `${context.estimatedUsagePercent.toFixed(1)}%` : "n/a",
					context?.hardCompacted ? "hard" : context?.autoCompacted ? "auto" : "no",
				].join(" | ") + " |");
			}
		}

		lines.push("", "This report contains metrics and model ids only. Message and tool-result bodies are not stored.", "");
		return lines.join("\n");
	}
}
