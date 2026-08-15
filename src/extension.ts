
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
	LlamaCppChatModelProvider,
	type LlamaChatContextUsageMetrics,
	type LlamaChatTurnMetrics,
} from "./llama-provider";
import {
	CONFIG_SECTION,
	DEEPSEEK_DISCOVERY_TIMEOUT_MS,
	DEEPSEEK_MAX_OUTPUT_TOKENS,
	DEEPSEEK_SERVER_URL,
	DEFAULT_SERVER_URL,
	EXTENSION_ID,
	EXTENSION_NAME,
	PROVIDER_VENDOR,
} from "./constants";
import { LlamaLogService } from "./logger";
import { SessionQualityTracker } from "./diagnostics/session-report";
import { SharedMemoryService } from "./memory/shared-memory-service";
import { registerMemoryTools } from "./memory/tools";
import { registerContextControlCommand } from "./ui/context-control";
import { registerModelBehaviorCommands } from "./ui/model-behavior-commands";
import { LlamaQuickActionsProvider } from "./ui/quick-access";
import { SessionQualityPanel } from "./ui/session-quality-panel";
import { MemoryManagerPanel, estimateMemoryTokens } from "./ui/memory-manager";
import { ApiProviderManagerPanel } from "./ui/api-provider-manager";
import { ApiProviderService } from "./api-providers/api-provider-service";
import { ProviderDirectory } from "./providers/provider-directory";
import { applyAgentHostThinkingPatch, findAgentHostBundle, getAgentHostThinkingPatchStatus, restoreAgentHostThinkingPatch } from "./byok/agent-host-thinking-patch";
import { CodexChatModelProvider, type CodexUsageRecord } from "./codex/codex-provider";
import { ClaudeChatModelProvider, type ClaudeLiveTurnUpdate } from "./claude/claude-provider";
import { classifyCodexTurnCache } from "./context/cache-diagnostics";
import { CompositeChatModelProvider } from "./composite-provider";
import type { ProviderRuntimeMetrics } from "./provider-metrics";
import { parseProviderModelId } from "./model-sources/source-routing";
import { getSubagentModelProfiles } from "./subagent-guidance";
import { TokenUsageHistory, type TokenUsageSample } from "./token-usage-history";
import {
	renderUsageExperimentMarkdown,
	UsageExperimentTracker,
	type ExperimentVariant,
} from "./usage-experiment";
import { registerCopilotPatchIntegration } from "./copilot-patch-runtime";

interface ContextUsageDisplay {
	summary: string;
	breakdown: string;
	statusBarText: string;
	tooltip: string;
	tooltipLines: string[];
}

type RuntimeSource = "local" | "deepseek";

function runtimeSourceForModel(modelId: string): RuntimeSource {
	const parsed = parseProviderModelId(modelId);
	return parsed.sourceKey === "deepseek" || parsed.modelId.toLowerCase().includes("deepseek")
		? "deepseek"
		: "local";
}

function formatNumber(value: number): string {
	if (!Number.isFinite(value)) {
		return "0";
	}
	return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function formatPercent(value: number): string {
	if (!Number.isFinite(value)) {
		return "0.0";
	}
	return value.toFixed(1);
}

function formatContextUsage(metrics: LlamaChatContextUsageMetrics): ContextUsageDisplay {
	const usedTokens = Math.max(0, metrics.estimatedUsedTokens);
	const freeTokens = Math.max(0, metrics.estimatedFreeTokens);
	const usagePercent = Math.min(100, Math.max(0, metrics.estimatedUsagePercent));
	const compaction = [metrics.autoCompacted ? "auto" : undefined, metrics.hardCompacted ? "hard" : undefined]
		.filter((value): value is string => typeof value === "string")
		.join("+") || "none";

	const summary = `${formatPercent(usagePercent)}% (${formatNumber(usedTokens)}/${formatNumber(metrics.contextLength)})`;
	const breakdown = `msg ${formatNumber(metrics.messageTokensAfterCompact)} + tools ${formatNumber(metrics.toolTokens)} + reserved ${formatNumber(metrics.replyReserveTokens)}`;
	const tooltipLines = [
		`Model: ${metrics.modelId}`,
		`Usage: ${summary}`,
		`Messages: ${formatNumber(metrics.messageTokensAfterCompact)} (before ${formatNumber(metrics.messageTokensBeforeCompact)})`,
		`Tools: ${formatNumber(metrics.toolTokens)} (count ${metrics.cappedTools})`,
		`Reserved reply: ${formatNumber(metrics.replyReserveTokens)}`,
		`Input budget: ${formatNumber(metrics.inputBudget)}`,
		`Soft target: ${formatNumber(metrics.softInputTarget)}`,
		`Hard target: ${formatNumber(metrics.hardInputTarget)}`,
		`Free headroom: ${formatNumber(freeTokens)}`,
		`Token count: ${metrics.tokenCountSource === "server" ? "exact server tokenizer" : "heuristic fallback"}`,
		`Compaction: ${compaction}`,
		`Attempt: #${metrics.attemptNo}`,
	];

	return {
		summary,
		breakdown,
		statusBarText: `$(pie-chart) local LLM ctx ${usagePercent.toFixed(0)}%`,
		tooltip: tooltipLines.join("\n"),
		tooltipLines,
	};
}

function updateCodexSessionQuality(
	tracker: SessionQualityTracker,
	usage: CodexUsageRecord,
	finalized: boolean
): void {
	const diag = usage.turnDiagnostics;
	const segments = diag?.usageSegments ?? [];
	const processedInputTokens = segments.length > 0
		? segments.reduce((sum, segment) => sum + segment.inputTokens, 0)
		: usage.inputTokens;
	const processedCachedInputTokens = segments.length > 0
		? segments.reduce((sum, segment) => sum + segment.cachedInputTokens, 0)
		: usage.cachedInputTokens;
	const processedOutputTokens = segments.length > 0
		? segments.reduce((sum, segment) => sum + segment.outputTokens, 0)
		: usage.outputTokens;
	const processedReasoningTokens = segments.length > 0
		? segments.reduce((sum, segment) => sum + segment.reasoningOutputTokens, 0)
		: usage.reasoningOutputTokens;
	const firstSegment = segments[0];
	const finalSegment = segments.at(-1);
	const hitPercent = processedInputTokens > 0
		? Number(((processedCachedInputTokens / processedInputTokens) * 100).toFixed(1))
		: undefined;
	const requestId = diag?.requestId ?? `codex-${Date.now()}`;
	if (diag?.contextWindow && diag.contextWindow > 0) {
		const messageTokensAfterCompact = Math.max(
			0,
			diag.tokenEstimateAfterCompact ?? diag.contextUsedTokens - diag.toolSchemaTokens
		);
		const messageTokensBeforeCompact = Math.max(
			messageTokensAfterCompact,
			diag.tokenEstimateBeforeCompact ?? messageTokensAfterCompact
		);
		const otherTokens = Math.max(
			0,
			diag.contextUsedTokens - messageTokensAfterCompact - diag.toolSchemaTokens
		);
		tracker.recordContext({
			requestId,
			modelId: usage.modelId,
			attemptNo: 1,
			contextLength: diag.contextWindow,
			inputBudget: diag.contextWindow,
			softInputTarget: diag.compactionTokenBudget ?? diag.hardInputTargetTokens,
			hardInputTarget: diag.hardInputTargetTokens,
			messageTokensBeforeCompact,
			messageTokensAfterCompact,
			messageCountBeforeCompact: diag.messageCountBeforeCompact ?? diag.messageCount,
			messageCountAfterCompact: diag.messageCountAfterCompact ?? diag.messageCount,
			toolTokens: diag.toolSchemaTokens,
			otherTokens,
			replyReserveTokens: 0,
			cappedTools: diag.toolCount,
			autoCompacted: diag.compacted,
			hardCompacted: false,
			estimatedUsedTokens: diag.contextUsedTokens,
			estimatedFreeTokens: Math.max(0, diag.contextWindow - diag.contextUsedTokens),
			estimatedUsagePercent: Number((diag.contextUsedTokens / diag.contextWindow * 100).toFixed(1)),
			tokenCountSource: segments.length > 0 ? "server" : "heuristic",
		});
	}
	const finalSegmentHit = finalSegment?.cacheHitPercent;
	const cacheClassification = classifyCodexTurnCache({
		threadMode: diag?.threadMode,
		threadReuseMissReason: diag?.threadReuseMissReason,
		initialSegmentHitPercent: firstSegment?.cacheHitPercent,
		finalSegmentHitPercent: finalSegmentHit,
		processedHitPercent: hitPercent,
		idleGapSeconds: diag?.idleGapSeconds,
	});
	const cacheMissReason = cacheClassification.reason;
	const lifecyclePhase = diag?.lifecyclePhase ?? (finalized ? "completed" : "running");
	const catalogToolCalls = Object.entries(diag?.toolNames ?? {})
		.filter(([name]) => name === "tool_search_call" || name === "tool_search")
		.reduce((sum, [, count]) => sum + count, 0);
	const delegatedToolCalls = new Set(
		(diag?.steps ?? [])
			.filter(step => step.kind === "tool" && step.toolCategory !== "catalog")
			.map(step => step.id)
	).size;
	const turn: LlamaChatTurnMetrics = {
		requestId,
		modelId: usage.modelId,
		providerKind: "codex",
		lifecyclePhase,
		terminalDetail: diag?.terminalDetail,
		threadMode: diag?.threadMode,
		inputMode: diag?.inputMode,
		compacted: diag?.compacted,
		threadReuseMissReason: diag?.threadReuseMissReason,
		conversationKey: diag?.conversationKey,
		durationMs: diag?.durationMs ?? 0,
		queueWaitMs: 0,
		firstTokenLatencyMs: diag?.firstModelEventLatencyMs,
		firstVisibleLatencyMs: diag?.firstVisibleMessageLatencyMs,
		emittedParts: 0,
		outputChars: diag?.outputChars ?? 0,
		thinkingChars: 0,
		estimatedOutputTokens: processedOutputTokens,
		outputTokens: processedOutputTokens,
		reasoningOutputTokens: processedReasoningTokens,
		promptTokens: processedInputTokens,
		cachedPromptTokens: processedCachedInputTokens,
		promptCacheHitPercent: hitPercent,
		initialSegmentCacheHitPercent: firstSegment?.cacheHitPercent,
		continuationCacheHitPercent: segments.length > 1 ? finalSegmentHit : undefined,
		finalSegmentInputTokens: finalSegment?.inputTokens ?? usage.inputTokens,
		finalSegmentCachedInputTokens: finalSegment?.cachedInputTokens ?? usage.cachedInputTokens,
		cacheMissReason,
		cacheMissDetail: cacheClassification.detail,
		modelTurns: Math.max(1, diag?.modelSegments ?? 1),
		usageEstimated: segments.length === 0,
		retriedAfterOverflow: false,
		toolCalls: diag?.toolCalls ?? 0,
		delegatedToolCalls,
		catalogToolCalls,
		toolDurationTotalMs: diag?.toolDuration?.totalMs,
		averageToolDurationMs: diag?.toolDuration?.averageMs,
		maximumToolDurationMs: diag?.toolDuration?.maximumMs,
		p95ToolDurationMs: diag?.toolDuration?.p95Ms,
		toolCallBreakdown: diag?.toolNames,
		usageSegments: diag?.usageSegments,
		usageSegmentsTruncated: diag?.usageSegmentsTruncated,
		steps: diag?.steps,
		metricsSource: diag?.metricsSource,
		repairedToolCalls: 0,
		rejectedToolCalls: 0,
		schemaRejectedToolCalls: 0,
		toolCallRepairRetries: 0,
		toolLoopDetected: false,
	};
	if (finalized) {
		tracker.recordTurn(turn);
	} else {
		tracker.updateTurn(turn);
	}
}

export function updateClaudeSessionQuality(
	tracker: SessionQualityTracker,
	update: ClaudeLiveTurnUpdate
): void {
	const segments = update.usageSegments;
	const aggregate = update.usage;
	const freshInputTokens = aggregate?.inputTokens
		?? segments.reduce((sum, segment) => sum + segment.freshInputTokens, 0);
	const cachedInputTokens = aggregate?.cacheReadInputTokens
		?? segments.reduce((sum, segment) => sum + segment.cacheReadInputTokens, 0);
	const cacheWriteInputTokens = aggregate?.cacheCreationInputTokens
		?? segments.reduce((sum, segment) => sum + segment.cacheCreationInputTokens, 0);
	const promptTokens = freshInputTokens + cachedInputTokens + cacheWriteInputTokens;
	const outputTokens = aggregate?.outputTokens
		?? segments.reduce((sum, segment) => sum + segment.outputTokens, 0);
	const reasoningOutputTokens = segments.reduce((sum, segment) => sum + segment.thinkingTokens, 0);
	const cacheHitPercent = promptTokens > 0
		? Number((cachedInputTokens / promptTokens * 100).toFixed(1))
		: undefined;
	const fallbackSession = update.context.sessionMode === "resume-fallback";
	const coldSession = update.context.sessionMode === "new" || fallbackSession;
	const restoredSession = update.context.sessionMode === "restored"
		|| update.context.sessionMode === "rollover";
	const cacheMissReason = fallbackSession
		? `resume_${update.context.resumeFailureReason ?? "failed"}`
		: cacheHitPercent === undefined
		? undefined
		: restoredSession && cacheHitPercent < 90
			? update.context.sessionMode === "rollover"
				? "session_rollover"
				: "session_restored"
			: coldSession
				? "session_not_reused"
				: cacheHitPercent >= 90
					? "healthy"
					: "unknown";
	const cacheMissDetail = fallbackSession
		? `Durable Claude resume failed at ${update.context.resumeFailureStage ?? "unknown stage"}: `
			+ `${update.context.resumeFailureDetail ?? "original SDK error unavailable"}. `
			+ "The provider then retried with full input."
		: coldSession
		? "No compatible warm Claude session was available; this turn started a new Agent SDK session."
		: restoredSession
			? update.context.runtimeChanged
				? "The session was restored from disk after a reload, but the runtime fingerprint changed "
					+ "(model, context target, effort, or the advertised tool catalog), so the cached prefix "
					+ "was rewritten instead of read."
				: "The session was restored from disk after a reload/restart; the upstream prompt cache was "
					+ "cold for the new process and the prefix was rewritten once."
			: cacheMissReason === "unknown"
				? "The Claude cache-read share was below 90%; cache creation is reported separately."
				: undefined;
	const context = update.contextUsage;
	const contextWindow = update.contextWindowTokens ?? context?.rawMaxTokens;
	if (context && contextWindow && contextWindow > 0) {
		const toolTokens = Math.min(context.totalTokens, update.context.toolSchemaTokens);
		const messageTokens = Math.max(0, context.totalTokens - toolTokens);
		tracker.recordContext({
			requestId: update.requestId,
			modelId: update.modelId,
			attemptNo: 1,
			contextLength: contextWindow,
			inputBudget: context.maxTokens,
			softInputTarget: context.maxTokens,
			hardInputTarget: context.maxTokens,
			messageTokensBeforeCompact: messageTokens,
			messageTokensAfterCompact: messageTokens,
			messageCountBeforeCompact: update.context.messageCount,
			messageCountAfterCompact: update.context.messageCount,
			toolTokens,
			otherTokens: 0,
			replyReserveTokens: Math.max(0, contextWindow - context.maxTokens),
			cappedTools: update.context.toolCount,
			autoCompacted: false,
			hardCompacted: false,
			estimatedUsedTokens: context.totalTokens,
			estimatedFreeTokens: Math.max(0, context.maxTokens - context.totalTokens),
			estimatedUsagePercent: Number((context.totalTokens / contextWindow * 100).toFixed(1)),
			tokenCountSource: "server",
			rawMaxTokens: context.rawMaxTokens,
			usableMaxTokens: context.maxTokens,
			categories: context.categories.map(category => ({
				name: category.name,
				tokens: category.tokens,
			})),
		});
	}
	const lifecyclePhase: LlamaChatTurnMetrics["lifecyclePhase"] = update.phase === "cancelled"
		? "interrupted"
		: update.phase;
	const parsedStartedAtMs = Date.parse(update.startedAt);
	// Claude segments report cache read/write from the Anthropic API, but never
	// explain WHY a cold segment happened. Derive the reason from the session
	// lifecycle: a fresh SDK session (or a restored one) is the only way to
	// cold-start 200-500K tokens between turns.
	const claudeSessionReason = update.context.sessionMissReason;
	const claudeColdReason = cacheMissReason
		?? ((cacheHitPercent ?? 100) < 90
			? update.context.sessionMode === "warm" || update.context.sessionMode === "rollover"
				? "claude_cold_segment"
				: update.context.sessionMode === "restored"
					? "claude_resume_rebuild"
					: "claude_new_session"
			: undefined);
	const turn: LlamaChatTurnMetrics = {
		requestId: update.requestId,
		modelId: update.modelId,
		providerKind: "claude",
		lifecyclePhase,
		startedAtMs: Number.isFinite(parsedStartedAtMs) ? parsedStartedAtMs : undefined,
		terminalDetail: update.terminalDetail,
		sessionMode: update.context.sessionMode,
		conversationKey: update.context.conversationKey,
		durationMs: update.durationMs,
		queueWaitMs: 0,
		firstTokenLatencyMs: update.firstModelEventLatencyMs,
		firstVisibleLatencyMs: update.firstVisibleMessageLatencyMs,
		emittedParts: 0,
		outputChars: update.outputChars,
		thinkingChars: update.thinkingChars,
		estimatedOutputTokens: outputTokens,
		outputTokens,
		reasoningOutputTokens,
		promptTokens,
		cachedPromptTokens: cachedInputTokens,
		cacheWriteInputTokens,
		promptCacheHitPercent: cacheHitPercent,
		initialSegmentCacheHitPercent: segments[0]?.cacheHitPercent,
		continuationCacheHitPercent: segments.length > 1 ? segments.at(-1)?.cacheHitPercent : undefined,
		finalSegmentInputTokens: segments.at(-1)?.inputTokens,
		finalSegmentCachedInputTokens: segments.at(-1)?.cacheReadInputTokens,
		cacheMissReason: claudeColdReason,
		cacheMissDetail: claudeSessionReason
			? `Session cause: ${claudeSessionReason}${update.context.runtimeChanged ? " · runtime changed" : ""}`
			: cacheMissDetail,
		resumeFailureReason: update.context.resumeFailureReason,
		resumeFailureStage: update.context.resumeFailureStage,
		resumeFailureDetail: update.context.resumeFailureDetail,
		resumeFallbackDecision: update.context.resumeFallbackDecision,
		resumeFallbackEstimatedInputTokens: update.context.resumeFallbackEstimatedInputTokens,
		resumeFallbackMaxInputTokens: update.context.resumeFallbackMaxInputTokens,
		turnMaxModelSegments: update.context.turnMaxModelSegments,
		turnMaxCumulativeInputTokens: update.context.turnMaxCumulativeInputTokens,
		safetyStopReason: update.context.safetyStopReason,
		safetyStopDetail: update.context.safetyStopDetail,
		modelTurns: Math.max(segments.length, aggregate?.numTurns ?? 0, 1),
		usageEstimated: !aggregate && segments.length === 0,
		retriedAfterOverflow: false,
		toolCalls: update.toolCalls,
		delegatedToolCalls: update.toolCalls,
		catalogToolCalls: 0,
		toolDurationTotalMs: update.toolDuration.totalMs,
		averageToolDurationMs: update.toolDuration.averageMs,
		maximumToolDurationMs: update.toolDuration.maximumMs,
		p95ToolDurationMs: update.toolDuration.p95Ms,
		toolCallBreakdown: update.toolNames,
		usageSegments: segments.map(segment => ({
			index: segment.index,
			recordedAt: segment.recordedAt,
			inputTokens: segment.inputTokens,
			cachedInputTokens: segment.cacheReadInputTokens,
			freshInputTokens: segment.freshInputTokens,
			cacheCreationInputTokens: segment.cacheCreationInputTokens,
			outputTokens: segment.outputTokens,
			reasoningOutputTokens: segment.thinkingTokens,
			totalTokens: segment.totalTokens,
			cacheHitPercent: segment.cacheHitPercent,
		})),
		usageSegmentsTruncated: false,
		steps: update.steps.map(step => ({
			id: step.id,
			index: step.index,
			kind: step.kind,
			label: step.label,
			status: step.status,
			toolCategory: step.toolCategory,
			startedAt: step.startedAt,
			completedAt: step.completedAt,
			durationMs: step.durationMs,
			inputTokens: step.inputTokens,
			cachedInputTokens: step.cacheReadInputTokens,
			cacheCreationInputTokens: step.cacheCreationInputTokens,
			outputTokens: step.outputTokens,
			reasoningOutputTokens: step.thinkingTokens,
			totalTokens: step.totalTokens,
			cacheHitPercent: step.cacheHitPercent,
		})),
		metricsSource: "live",
		repairedToolCalls: 0,
		rejectedToolCalls: 0,
		schemaRejectedToolCalls: 0,
		toolCallRepairRetries: 0,
		toolLoopDetected: false,
	};
	if (update.phase === "running") {
		tracker.updateTurn(turn);
	} else {
		tracker.recordTurn(turn);
	}
}

function getExplicitConfiguredServerUrl(config: vscode.WorkspaceConfiguration): string | undefined {
	const inspected = config.inspect<string>("serverUrl");
	const candidates = [inspected?.workspaceFolderValue, inspected?.workspaceValue, inspected?.globalValue];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim().length > 0) {
			return candidate.trim();
		}
	}
	return undefined;
}

async function openLlamaSidebar(): Promise<boolean> {
	try {
		await vscode.commands.executeCommand("llamacpp-quick-actions.focus");
		return true;
	} catch {
		// Continue with generic view opening commands.
	}

	const viewIds = ["llamacpp-quick-actions"];
	for (const viewId of viewIds) {
		try {
			await vscode.commands.executeCommand("workbench.action.openView", viewId, true);
			return true;
		} catch {
			// Fall through to other strategies.
		}
	}

	const staticCandidates = ["workbench.view.extension.llamacpp-sidebar"];
	const allCommands = await vscode.commands.getCommands(true);
	const dynamicCandidates = allCommands.filter(
		command =>
			command.startsWith("workbench.view.extension.") &&
			(command.includes("llamacpp") || command.includes("llama-vscode-chat"))
	);

	const candidates = Array.from(new Set([...staticCandidates, ...dynamicCandidates]));
	for (const command of candidates) {
		try {
			await vscode.commands.executeCommand(command);
			return true;
		} catch {
			// Keep trying candidate ids.
		}
	}

	console.warn("[Local LLM] Failed to open sidebar", { candidates });
	return false;
}

/**
 * Activates the VS Code extension.
 * Registers the Llama.cpp chat model provider and management commands.
 * Called when the extension is activated by VS Code.
 *
 * @param context - The extension context provided by VS Code.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// Build a descriptive User-Agent to help quantify API usage
	const ext = vscode.extensions.getExtension(EXTENSION_ID);
	const extVersion = ext?.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	// Keep UA minimal: only extension version and VS Code version
	const ua = `${EXTENSION_NAME}/${extVersion} VSCode/${vscodeVersion}`;
	const logService = new LlamaLogService(context);
	const memoryService = new SharedMemoryService(context.globalStorageUri.fsPath);
	const sessionQuality = new SessionQualityTracker();
	const tokenUsageHistory = new TokenUsageHistory(
		context.globalState,
		error => logService.logError("token_usage.persist_failed", error)
	);
	const usageExperiments = new UsageExperimentTracker(
		context.globalState,
		error => logService.logError("usage_experiment.persist_failed", error)
	);
	const recordUsage = (sample: TokenUsageSample, modelId?: string): void => {
		tokenUsageHistory.record(sample);
		usageExperiments.record(sample, modelId);
	};
	context.subscriptions.push(logService);
	context.subscriptions.push(tokenUsageHistory);
	context.subscriptions.push(usageExperiments);
	await Promise.all([logService.initialize(), memoryService.initialize()]);
	registerMemoryTools(context, memoryService);
	registerCopilotPatchIntegration(context);

	// Expose agent history caps to the prompt-tsx patch via globalThis.
	// The prompt-tsx configurationService does not expose getValue(), so the
	// injected code reads these globals instead of calling configurationService.
	const updateAgentHistoryCaps = () => {
		const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
		(globalThis as Record<string, unknown>).__llamaAgentHistoryRounds = cfg.get<number>("agentHistoryRounds", 400);
		(globalThis as Record<string, unknown>).__llamaAgentHistoryTurns = cfg.get<number>("agentHistoryTurns", 80);
	};
	updateAgentHistoryCaps();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration(`${CONFIG_SECTION}.agentHistoryRounds`)
				|| e.affectsConfiguration(`${CONFIG_SECTION}.agentHistoryTurns`)
			) {
				updateAgentHistoryCaps();
			}
		})
	);

	// API provider profiles (multi-endpoint manager) share the model-source path.
	const apiProviderService = new ApiProviderService(context.globalState, context.secrets);
	context.subscriptions.push(apiProviderService);

	// Unified provider directory: one status model for every source.
	let lastCodexStatus: { state: string; summary: string } | undefined;
	let lastClaudeStatus: { state: string; summary: string } | undefined;
	const providerDirectory = new ProviderDirectory({
		getSecret: key => Promise.resolve(context.secrets.get(key)),
		getConfigValue: (key, fallback) => vscode.workspace.getConfiguration(CONFIG_SECTION).get(key, fallback),
		getApiProfiles: async () => apiProviderService.listSummaries(),
		getCodexStatus: () => lastCodexStatus,
		getClaudeStatus: () => lastClaudeStatus,
	});
	context.subscriptions.push(providerDirectory);

	// Llama.cpp Provider
	const llamaProvider = new LlamaCppChatModelProvider(
		context.secrets,
		ua,
		logService,
		memoryService,
		context.globalState,
		context.globalStorageUri.fsPath,
		() => apiProviderService.getModelSources()
	);
	const codexProvider = new CodexChatModelProvider(extVersion, logService, context.workspaceState);
	const claudeProvider = new ClaudeChatModelProvider(extVersion, logService, context.workspaceState);
	context.subscriptions.push(codexProvider);
	context.subscriptions.push(claudeProvider);
	const compositeProvider = new CompositeChatModelProvider(llamaProvider, codexProvider, claudeProvider);
	context.subscriptions.push(compositeProvider);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(PROVIDER_VENDOR, compositeProvider));

	let lastThroughput: string | undefined;
	let lastPromptCache: string | undefined;
	let lastContextUsage: ContextUsageDisplay | undefined;
	let lastHealthStatus: string | undefined;
	let lastHealthEnriched: unknown | undefined;
	const runtimeMetrics = new Map<RuntimeSource, ProviderRuntimeMetrics>();
	const quickActionsProvider = new LlamaQuickActionsProvider(
		() => lastThroughput,
		() => lastContextUsage,
		() => memoryService.count,
		() => lastPromptCache,
		() => sessionQuality.count === 0 ? "No turns" : `${sessionQuality.count} turns / cache ${sessionQuality.summary.cacheHitPercent ?? "n/a"}%`,
		() => memoryService.expiredCount,
		() => codexProvider.accountSummary,
		() => claudeProvider.accountSummary,
		() => claudeProvider.usageSummary,
		() => claudeProvider.lastRequestUsage,
		() => claudeProvider.subscriptionUsageLimits,
		() => runtimeMetrics.get("local"),
		() => runtimeMetrics.get("deepseek"),
		() => codexProvider.runtimeMetrics,
		() => claudeProvider.runtimeMetrics,
		() => codexProvider.subscriptionUsageSummary,
		() => getSubagentModelProfiles(),
		() => tokenUsageHistory.summary,
		() => usageExperiments.summary,
		() => llamaProvider.deepSeekBalanceSummary,
		() => codexProvider.codexUsageLimitPercent,
		() => codexProvider.codexUsageLimitResetLabel,
		() => claudeProvider.claudeUsageLimitPercent,
		() => claudeProvider.claudeUsageLimitResetLabel,
		() => estimateMemoryTokens(memoryService.list()),
		() => ({
			total: apiProviderService.count,
			enabled: apiProviderService.enabledCount,
		}),
		key => providerDirectory.stateOf(key)
	);
	context.subscriptions.push(vscode.window.registerTreeDataProvider("llamacpp-quick-actions", quickActionsProvider));
	context.subscriptions.push(memoryService.onDidChange(() => quickActionsProvider.refresh()));
	context.subscriptions.push(memoryService.onDidChange(() => MemoryManagerPanel.refreshIfOpen()));
	context.subscriptions.push(tokenUsageHistory.onDidChange(() => quickActionsProvider.refresh()));
	context.subscriptions.push(usageExperiments.onDidChange(() => quickActionsProvider.refresh()));
	context.subscriptions.push(codexProvider.onDidChangeStatus(status => {
		lastCodexStatus = { state: status.state, summary: status.summary };
		void providerDirectory.refresh();
		quickActionsProvider.refresh();
		ApiProviderManagerPanel.refreshIfOpen();
	}));
	context.subscriptions.push(claudeProvider.onDidChangeStatus(status => {
		lastClaudeStatus = { state: status.state, summary: status.summary };
		void providerDirectory.refresh();
		quickActionsProvider.refresh();
		ApiProviderManagerPanel.refreshIfOpen();
	}));
	context.subscriptions.push(apiProviderService.onDidChange(() => {
		void providerDirectory.refresh();
		quickActionsProvider.refresh();
	}));
	context.subscriptions.push(providerDirectory.onDidChange(() => {
		quickActionsProvider.refresh();
		ApiProviderManagerPanel.refreshIfOpen();
	}));
	context.subscriptions.push(claudeProvider.onDidChangeCacheKeepAliveStatus(() => {
		quickActionsProvider.refresh();
		SessionQualityPanel.refreshIfOpen();
	}));
	context.subscriptions.push(codexProvider.onDidRecordUsage(usage => {
		recordUsage({
			provider: "codex",
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cachedInputTokens: usage.cachedInputTokens,
			reasoningOutputTokens: usage.reasoningOutputTokens,
		}, usage.modelId);
		updateCodexSessionQuality(sessionQuality, usage, true);
	}));
	context.subscriptions.push(codexProvider.onDidUpdateLiveTurn(usage => {
		updateCodexSessionQuality(sessionQuality, usage, usage.phase !== "running");
	}));
	context.subscriptions.push(claudeProvider.onDidRecordUsage(usage => {
		const totalInput = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
		recordUsage({
			provider: "claude",
			inputTokens: totalInput,
			outputTokens: usage.outputTokens,
			cachedInputTokens: usage.cacheReadInputTokens,
			cacheWriteInputTokens: usage.cacheCreationInputTokens,
			modelTurns: usage.modelTurns,
			durationMs: usage.durationMs,
		}, usage.modelId);
	}));
	context.subscriptions.push(claudeProvider.onDidUpdateLiveTurn(update => {
		updateClaudeSessionQuality(sessionQuality, update);
	}));
	context.subscriptions.push(registerContextControlCommand(
		() => codexProvider.runtimeMetrics,
		() => quickActionsProvider.refresh()
	));
	context.subscriptions.push(...registerModelBehaviorCommands(() => quickActionsProvider.refresh()));
	llamaProvider.refreshLanguageModelChatInformation();
	codexProvider.refreshLanguageModelChatInformation();
	claudeProvider.refreshLanguageModelChatInformation();
	void codexProvider.refreshStatus().then(status => {
		lastCodexStatus = { state: status.state, summary: status.summary };
	}).catch(error => logService.logError("codex.initial_status.failed", error));
	void claudeProvider.refreshStatus().then(status => {
		lastClaudeStatus = { state: status.state, summary: status.summary };
	}).catch(error => logService.logError("claude.initial_status.failed", error));
	void providerDirectory.recheck().catch(error => logService.logError("providers.initial_recheck.failed", error));
	void llamaProvider.refreshDeepSeekBalance().catch(error => logService.logError("deepseek.balance.initial_failed", error));

	// Auto-refresh provider usage limits and balances so Quick Access shows when
	// a subscription window resets without requiring a manual refresh. Every
	// provider refresh is internally TTL-guarded, so this stays lightweight.
	const usageLimitRefreshTimer = setInterval(() => {
		quickActionsProvider.refresh();
		ApiProviderManagerPanel.refreshIfOpen();
		void codexProvider.refreshStatus().catch(error => logService.logError("codex.periodic_status.failed", error));
		void claudeProvider.refreshSubscriptionUsage().catch(error => logService.logError("claude.periodic_usage.failed", error));
		void llamaProvider.refreshDeepSeekBalance().catch(error => logService.logError("deepseek.periodic_balance.failed", error));
	}, 60_000);
	context.subscriptions.push(new vscode.Disposable(() => clearInterval(usageLimitRefreshTimer)));

	// VS Code hides BYOK models in the Agents Window model picker until
	// `chat.agentHost.byokModels.enabled` is true (experimental flag, read at
	// window startup). The extension sets it itself so the bridge works
	// out of the box; a user-provided value is never overwritten.
	const ensureAgentsByokFlag = (): void => {
		const chatConfig = vscode.workspace.getConfiguration("chat");
		const inspected = chatConfig.inspect<boolean>("agentHost.byokModels.enabled");
		if (inspected?.globalValue === undefined && inspected?.workspaceValue === undefined) {
			void chatConfig.update("agentHost.byokModels.enabled", true, vscode.ConfigurationTarget.Global);
			logService.log("byok.bridge.byok_flag_enabled");
		}
	};

	// Never touch workspace settings in the test runner: the test instance
	// shares the VS Code host lifecycle and a chat.* write can restart the
	// agent host mid-run (tests abort with a clean extension-host exit).
	if (context.extensionMode !== vscode.ExtensionMode.Test) {
		ensureAgentsByokFlag();
	}

	// Thinking-level picker for BYOK models in the Agents Window. VS Code
	// 1.131 omits the configSchema from BYOK snapshot models, so the UI has no
	// reasoning-effort switch; this patch adds it to the agent-host bundle.
	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleAgentHostThinkingPatch", async () => {
			try {
				const target = findAgentHostBundle();
				const status = getAgentHostThinkingPatchStatus(target.bundlePath);
				if (status.applied) {
					const result = restoreAgentHostThinkingPatch(target.bundlePath);
					logService.log("byok.bridge.thinking_patch_restored", { sha256: result.status.sha256 });
					vscode.window.showInformationMessage(result.message);
					return;
				}
				const result = applyAgentHostThinkingPatch(target.bundlePath);
				logService.log("byok.bridge.thinking_patch_applied", { sha256: result.status.sha256 });
				vscode.window.showInformationMessage(result.message);
			} catch (error) {
				logService.logError("byok.bridge.thinking_patch_failed", error);
				vscode.window.showErrorMessage(`Agent-host thinking patch failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}),
	);

const performanceStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
	performanceStatusBar.name = "Local LLM Throughput";
	performanceStatusBar.command = "llamacpp.openLatestLog";
	performanceStatusBar.text = "$(dashboard) local LLM TPS: n/a";

	const contextUsageStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 94);
	contextUsageStatusBar.name = "Local LLM Context Usage";
	contextUsageStatusBar.command = "llamacpp.openLatestLog";
	contextUsageStatusBar.text = "$(pie-chart) local LLM ctx: n/a";

	const updatePerformanceStatusBarVisibility = (): void => {
		const enabled = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("showPerformanceStatusBar", true) !== false;
		if (enabled) {
			performanceStatusBar.show();
		} else {
			performanceStatusBar.hide();
		}
	};

	const updateContextUsageStatusBarVisibility = (): void => {
		const enabled = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("showContextUsageStatusBar", true) !== false;
		if (enabled) {
			contextUsageStatusBar.show();
		} else {
			contextUsageStatusBar.hide();
		}
	};

	updatePerformanceStatusBarVisibility();
	updateContextUsageStatusBarVisibility();
	context.subscriptions.push(performanceStatusBar);
	context.subscriptions.push(contextUsageStatusBar);

	context.subscriptions.push(
		llamaProvider.onDidUpdateContextUsage((usage: LlamaChatContextUsageMetrics) => {
			sessionQuality.recordContext(usage);
			lastContextUsage = formatContextUsage(usage);
			const source = runtimeSourceForModel(usage.modelId);
			const sourceLabel = source === "deepseek" ? "DeepSeek" : "Local";
			runtimeMetrics.set(source, {
				...runtimeMetrics.get(source),
				modelId: usage.modelId,
				contextUsedTokens: usage.estimatedUsedTokens,
				contextWindowTokens: usage.contextLength,
				contextUsagePercent: usage.estimatedUsagePercent,
				contextDetail: lastContextUsage.breakdown,
				updatedAt: Date.now(),
			});
			contextUsageStatusBar.text = `$(pie-chart) ${sourceLabel} ctx ${Math.round(usage.estimatedUsagePercent)}%`;
			contextUsageStatusBar.tooltip = lastContextUsage.tooltip;
			quickActionsProvider.refresh();
		})
	);

	context.subscriptions.push(
		llamaProvider.onDidCompleteChatTurn((metrics: LlamaChatTurnMetrics) => {
			sessionQuality.recordTurn(metrics);
			const tpsText = metrics.tokensPerSecond === undefined ? "n/a" : `${metrics.tokensPerSecond.toFixed(1)} tok/s`;
			const latencyText = metrics.firstTokenLatencyMs === undefined ? "n/a" : `${metrics.firstTokenLatencyMs} ms`;
			const queueText = `${metrics.queueWaitMs} ms`;
			const cacheText = metrics.cachedPromptTokens === undefined
				? "n/a"
				: `${metrics.promptCacheHitPercent?.toFixed(1) ?? "0.0"}% (${formatNumber(metrics.cachedPromptTokens)}/${formatNumber(metrics.promptTokens)})`;
			const performanceTooltipLines = [
				`Model: ${metrics.modelId}`,
				`TPS: ${tpsText}`,
				`Estimated output tokens: ${metrics.estimatedOutputTokens}`,
				`Thinking chars: ${metrics.thinkingChars}`,
				`First token latency: ${latencyText}`,
				`Queue wait: ${queueText}`,
				`Prompt cache: ${cacheText}`,
				`Turn duration: ${metrics.durationMs} ms`,
			];
			if (lastContextUsage) {
				performanceTooltipLines.push("", ...lastContextUsage.tooltipLines);
			}

			lastThroughput = tpsText;
			lastPromptCache = cacheText;
			const source = runtimeSourceForModel(metrics.modelId);
			const sourceLabel = source === "deepseek" ? "DeepSeek" : "Local";
			recordUsage({
				provider: source,
				inputTokens: metrics.promptTokens,
				outputTokens: metrics.outputTokens ?? metrics.estimatedOutputTokens,
				cachedInputTokens: metrics.cachedPromptTokens,
				modelTurns: metrics.modelTurns,
				durationMs: metrics.durationMs,
				estimated: metrics.usageEstimated,
			}, metrics.modelId);
			runtimeMetrics.set(source, {
				...runtimeMetrics.get(source),
				modelId: metrics.modelId,
				inputTokens: metrics.promptTokens,
				outputTokens: metrics.outputTokens ?? metrics.estimatedOutputTokens,
				cachedInputTokens: metrics.cachedPromptTokens,
				throughputTokensPerSecond: metrics.tokensPerSecond,
				updatedAt: Date.now(),
			});
			performanceStatusBar.text = `$(dashboard) ${sourceLabel} ${tpsText}`;
			performanceStatusBar.tooltip = performanceTooltipLines.join("\n");
			quickActionsProvider.refresh();
		})
	);

	const reportDirectory = path.join(context.globalStorageUri.fsPath, "reports");

	const writeReport = async (baseName: string, markdown: string, json: unknown): Promise<string> => {
		await fs.mkdir(reportDirectory, { recursive: true });
		const stamp = new Date().toISOString().replace(/[.:]/g, "-");
		const markdownPath = path.join(reportDirectory, `${baseName}-${stamp}.md`);
		const jsonPath = path.join(reportDirectory, `${baseName}-${stamp}.json`);
		await Promise.all([
			fs.writeFile(markdownPath, markdown, "utf8"),
			fs.writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf8"),
		]);
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(markdownPath));
		await vscode.window.showTextDocument(document, { preview: false });
		return markdownPath;
	};

	// Live-updating session quality JSON — single file, no timestamp spam.
	// The markdown file was removed: the Live Report webview superseded it.
	const liveReportJsonPath = path.join(reportDirectory, "session-quality-live.json");

	const writeLiveSessionReport = async (): Promise<void> => {
		await fs.mkdir(reportDirectory, { recursive: true });
		const json = sessionQuality.toJSON();
		await fs.writeFile(liveReportJsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
	};

	// Auto-refresh the live report and webview panel after every completed turn
	// from any provider (Llama, Codex, Claude).
	context.subscriptions.push(
		sessionQuality.onDidChange(async () => {
			SessionQualityPanel.refreshIfOpen();
			try {
				await writeLiveSessionReport();
			} catch {
				// Don't block the turn pipeline on a file write.
			}
		})
	);

	const startUsageExperiment = async (variant: ExperimentVariant): Promise<void> => {
		const summary = usageExperiments.summary;
		if (summary.active) {
			vscode.window.showWarningMessage(`Usage experiment "${summary.active.label}" is already active.`);
			return;
		}
		const matchingLabel = variant === "baseline"
			? summary.latestDelegated?.label
			: summary.latestBaseline?.label;
		const label = await vscode.window.showInputBox({
			title: variant === "baseline" ? "Start Baseline Usage Experiment" : "Start Delegated Usage Experiment",
			prompt: "Use the exact same task label for both variants",
			placeHolder: "e.g. bundle-vsix",
			value: matchingLabel ?? "",
			validateInput: value => value.trim().length === 0 ? "Task label is required." : undefined,
		});
		if (label === undefined) {
			return;
		}
		const run = usageExperiments.start(label, variant);
		await usageExperiments.flush();
		vscode.window.showInformationMessage(`Started ${variant} usage experiment: ${run.label}`);
	};

	const exportUsageExperiment = async (): Promise<void> => {
		const summary = usageExperiments.summary;
		if (!summary.latestBaseline && !summary.latestDelegated) {
			vscode.window.showWarningMessage("No completed usage experiment to export.");
			return;
		}
		await writeReport(
			"usage-experiment",
			renderUsageExperimentMarkdown(summary),
			summary
		);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.runHealthCheck", async () => {
			const cancellation = new vscode.CancellationTokenSource();
			try {
				const report = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Checking Local LLM providers",
						cancellable: false,
					},
					() => llamaProvider.runHealthCheck(extVersion, cancellation.token)
				);
				// Enrich the provider snapshot with session metrics and the
				// subscription providers so the health panel is a full picture.
				const summary = sessionQuality.summary;
				const records = sessionQuality.records;
				const errorCount = records.reduce((total, record) => {
					const turn = record.turn;
					if (turn.lifecyclePhase === "failed" || turn.lifecyclePhase === "timed_out") {
						total += 1;
					}
					if (turn.rejectedToolCalls) {total += turn.rejectedToolCalls;}
					if (turn.toolLoopDetected) {total += 1;}
					return total;
				}, 0);
				const enriched = {
					...report,
					sessionSummary: {
						turns: summary.turns,
						totalModelTurns: summary.totalModelTurns,
						cacheHitPercent: summary.cacheHitPercent,
						promptTokens: summary.promptTokens,
						cachedPromptTokens: summary.cachedPromptTokens,
						rejectedToolCalls: summary.rejectedToolCalls,
						repairedToolCalls: summary.repairedToolCalls,
						toolLoopsDetected: summary.toolLoopsDetected,
						errorCount,
					},
					claude: {
						status: claudeProvider.statusSummary.startsWith("Connected") ? "connected" : claudeProvider.statusSummary.startsWith("Paused") ? "paused_usage_limit" : "warning",
						summary: claudeProvider.statusSummary,
						usagePercent: claudeProvider.claudeUsageLimitPercent,
						resetLabel: claudeProvider.claudeUsageLimitResetLabel,
						keepAlive: claudeProvider.cacheKeepAliveStatus,
					},
					codex: {
						status: codexProvider.accountSummary === "Connected" ? "connected" : "warning",
						summary: codexProvider.accountSummary,
					},
				};
				lastHealthStatus = report.overallStatus.toUpperCase();
				lastHealthEnriched = enriched;
				quickActionsProvider.refresh();
				// The health report now lives in the Live Report webview (Health
				// tab) — no standalone panel and no markdown file anymore.
				SessionQualityPanel.createOrShow(
					context.extensionUri,
					sessionQuality,
					extVersion,
					vscodeVersion,
					() => claudeProvider.cacheKeepAliveStatus,
					() => lastHealthEnriched
				);
				vscode.window.showInformationMessage(`Local LLM health check: ${lastHealthStatus}`);
			} finally {
				cancellation.dispose();
			}
		}),
		vscode.commands.registerCommand("llamacpp.openSessionReport", async () => {
			try {
				SessionQualityPanel.createOrShow(
					context.extensionUri,
					sessionQuality,
					extVersion,
					vscodeVersion,
					() => claudeProvider.cacheKeepAliveStatus,
					() => lastHealthEnriched
				);
			} catch (err: unknown) {
				void vscode.window.showErrorMessage(
					`Failed to open session quality report: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}),
		vscode.commands.registerCommand("llamacpp.resetSessionReport", async () => {
			sessionQuality.clear();
			await writeLiveSessionReport();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage("Local LLM session metrics reset.");
		}),
		vscode.commands.registerCommand("llamacpp.startBaselineUsageExperiment", () =>
			startUsageExperiment("baseline")
		),
		vscode.commands.registerCommand("llamacpp.startDelegatedUsageExperiment", () =>
			startUsageExperiment("delegated")
		),
		vscode.commands.registerCommand("llamacpp.stopUsageExperiment", async () => {
			const stopped = usageExperiments.stop();
			if (!stopped) {
				vscode.window.showWarningMessage("No active usage experiment to stop.");
				return;
			}
			await usageExperiments.flush();
			await exportUsageExperiment();
			vscode.window.showInformationMessage(`Stopped ${stopped.variant} usage experiment: ${stopped.label}`);
		}),
		vscode.commands.registerCommand("llamacpp.exportUsageExperiment", exportUsageExperiment),
		vscode.commands.registerCommand("llamacpp.clearUsageExperiments", async () => {
			const choice = await vscode.window.showWarningMessage(
				"Delete the active run and all completed usage experiments?",
				{ modal: true },
				"Clear"
			);
			if (choice !== "Clear") {
				return;
			}
			usageExperiments.clear();
			await usageExperiments.flush();
			vscode.window.showInformationMessage("Usage experiments cleared.");
		}),
		vscode.commands.registerCommand("llamacpp.clearTokenUsageHistory", async () => {
			const choice = await vscode.window.showWarningMessage(
				"Delete all locally recorded token usage history?",
				{ modal: true },
				"Clear"
			);
			if (choice !== "Clear") {
				return;
			}
			tokenUsageHistory.clear();
			await tokenUsageHistory.flush();
			vscode.window.showInformationMessage("Token usage history cleared.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.openSidebar", async () => {
			const opened = await openLlamaSidebar();
			if (!opened) {
				vscode.window.showWarningMessage("Unable to open the Local LLM sidebar automatically. Use View: Open View...");
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.openApiProviders", () => {
			ApiProviderManagerPanel.createOrShow(
				apiProviderService,
				providerDirectory,
				() => llamaProvider.refreshLanguageModelChatInformation(),
				() => ({
					deepSeek: { balance: llamaProvider.deepSeekBalanceSummary },
					codex: {
						summary: lastCodexStatus?.summary ?? codexProvider.accountSummary,
						usagePercent: codexProvider.codexUsageLimitPercent,
						usageReset: codexProvider.codexUsageLimitResetLabel,
					},
					claude: {
						summary: lastClaudeStatus?.summary ?? claudeProvider.accountSummary,
						limits: claudeProvider.subscriptionUsageLimits.map(limit => ({
							label: limit.label,
							description: limit.description,
						})),
					},
					
				})
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.manage", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const configuredUrl = getExplicitConfiguredServerUrl(config);
			const existingUrl = configuredUrl || (await context.secrets.get("llamacpp.serverUrl"));
			const serverUrl = await vscode.window.showInputBox({
				title: "Primary OpenAI-Compatible Server URL",
				prompt: "Enter the URL of the primary model server",
				value: existingUrl || DEFAULT_SERVER_URL,
				ignoreFocusOut: true,
			});

			if (serverUrl === undefined) {
				return; // User canceled
			}

			if (serverUrl.trim()) {
				await config.update("serverUrl", serverUrl.trim(), vscode.ConfigurationTarget.Global);
				await context.secrets.delete("llamacpp.serverUrl");
			} else {
				await config.update("serverUrl", undefined, vscode.ConfigurationTarget.Global);
				await context.secrets.delete("llamacpp.serverUrl");
			}

			llamaProvider.refreshLanguageModelChatInformation();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage("Primary model server configuration saved.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.setLocalServerUrl", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = String(config.get("localServerUrl", DEFAULT_SERVER_URL) || DEFAULT_SERVER_URL);
			const serverUrl = await vscode.window.showInputBox({
				title: "Local LLM Server URL",
				prompt: "Enter the URL of your local OpenAI-compatible server",
				value: current,
				ignoreFocusOut: true,
			});

			if (serverUrl === undefined) {
				return;
			}

			const trimmed = serverUrl.trim() || DEFAULT_SERVER_URL;
			await config.update("localServerUrl", trimmed, vscode.ConfigurationTarget.Global);
			await config.update("enableLocalServer", true, vscode.ConfigurationTarget.Global);

			llamaProvider.refreshLanguageModelChatInformation();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Local LLM source enabled: ${trimmed}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleLocalServer", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const next = config.get<boolean>("enableLocalServer", true) === false;
			await config.update("enableLocalServer", next, vscode.ConfigurationTarget.Global);

			llamaProvider.refreshLanguageModelChatInformation();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Local LLM source ${next ? "enabled" : "disabled"}.`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleDeepSeek", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const next = config.get<boolean>("enableDeepSeek", true) === false;
			await config.update("enableDeepSeek", next, vscode.ConfigurationTarget.Global);

			llamaProvider.refreshLanguageModelChatInformation();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`DeepSeek source ${next ? "enabled" : "disabled"}.`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleCodexSubscription", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const next = config.get<boolean>("enableCodexSubscription", true) === false;
			await config.update("enableCodexSubscription", next, vscode.ConfigurationTarget.Global);
			codexProvider.refreshLanguageModelChatInformation();
			await codexProvider.refreshStatus();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Codex subscription source ${next ? "enabled" : "disabled"}.`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleCodexDeferredTools", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const next = config.get<boolean>("codexDeferNonCoreTools", true) === false;
			await config.update("codexDeferNonCoreTools", next, vscode.ConfigurationTarget.Global);
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Codex deferred tools ${next ? "enabled" : "disabled"}.`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleCodexCacheKeepAlive", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const next = config.get<boolean>("codexCacheKeepAliveEnabled", false) === false;
			await config.update("codexCacheKeepAliveEnabled", next, vscode.ConfigurationTarget.Global);
			quickActionsProvider.refresh();
			codexProvider.refreshCodexCacheKeepAliveStatus();
			vscode.window.showInformationMessage(
				`Codex cache keep-alive ${next ? "enabled" : "disabled"}.`
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleCodexCacheKeepAliveIgnoreUsageLimit", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const next = config.get<boolean>("codexCacheKeepAliveIgnoreUsageLimit", false) === false;
			await config.update("codexCacheKeepAliveIgnoreUsageLimit", next, vscode.ConfigurationTarget.Global);
			quickActionsProvider.refresh();
			codexProvider.refreshCodexCacheKeepAliveStatus();
			vscode.window.showInformationMessage(
				`Codex cache keep-alive usage-limit pause ${next ? "ignored" : "respected"}.`
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.codexSignIn", async () => {
			try {
				await codexProvider.signIn();
				quickActionsProvider.refresh();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to sign in to Codex: ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.codexSignOut", async () => {
			const confirmed = await vscode.window.showWarningMessage(
				"Sign out of Codex? This also signs out the shared local Codex CLI session.",
				{ modal: true },
				"Sign Out"
			);
			if (confirmed !== "Sign Out") {
				return;
			}
			try {
				await codexProvider.signOut();
				quickActionsProvider.refresh();
				vscode.window.showInformationMessage("Codex signed out.");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to sign out of Codex: ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.codexShowStatus", async () => {
			try {
				await codexProvider.showStatus();
				quickActionsProvider.refresh();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to read Codex status: ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.codexContinueLatestInNewChat", async () => {
			try {
				const prepared = await codexProvider.prepareLatestDurableThreadRollover();
				await vscode.commands.executeCommand("workbench.action.chat.newChat");
				vscode.window.showInformationMessage(
					`New chat opened. Keep the same Codex model selected and send the next message within 30 minutes `
					+ `to continue the thread saved at ${new Date(prepared.lastUsedAt).toLocaleString()}.`
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to continue the Codex thread: ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleClaudeSubscription", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const next = config.get<boolean>("enableClaudeSubscription", true) === false;
			await config.update("enableClaudeSubscription", next, vscode.ConfigurationTarget.Global);
			claudeProvider.refreshLanguageModelChatInformation();
			await claudeProvider.refreshStatus();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Claude subscription source ${next ? "enabled" : "disabled"}.`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleClaudeCacheKeepAlive", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const next = config.get<boolean>("claudeCacheKeepAliveEnabled", true) === false;
			await config.update("claudeCacheKeepAliveEnabled", next, vscode.ConfigurationTarget.Global);
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(
				`Claude cache keep-alive ${next ? "enabled" : "disabled"}.`
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleClaudeCacheKeepAliveIgnoreUsageLimit", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const next = config.get<boolean>("claudeCacheKeepAliveIgnoreUsageLimit", false) === false;
			await config.update("claudeCacheKeepAliveIgnoreUsageLimit", next, vscode.ConfigurationTarget.Global);
			quickActionsProvider.refresh();
			claudeProvider.refreshCacheKeepAliveStatus();
			vscode.window.showInformationMessage(
				`Claude cache keep-alive usage-limit pause ${next ? "ignored" : "respected"}.`
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.claudeSignIn", async () => {
			try {
				await claudeProvider.signIn();
				quickActionsProvider.refresh();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to sign in to Claude: ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.claudeSignOut", async () => {
			const confirmed = await vscode.window.showWarningMessage(
				"Sign out of Claude? This clears the cached OAuth token.",
				{ modal: true },
				"Sign Out"
			);
			if (confirmed !== "Sign Out") {
				return;
			}
			try {
				await claudeProvider.signOut();
				quickActionsProvider.refresh();
				vscode.window.showInformationMessage("Claude signed out.");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to sign out of Claude: ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.claudeShowStatus", async () => {
			try {
				await claudeProvider.showStatus();
				quickActionsProvider.refresh();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to read Claude status: ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.claudeContinueLatestInNewChat", async () => {
			try {
				const prepared = await claudeProvider.prepareLatestDurableSessionRollover();
				await vscode.commands.executeCommand("workbench.action.chat.newChat");
				vscode.window.showInformationMessage(
					`New chat opened. Keep Claude Opus selected and send the next message within 30 minutes `
					+ `to continue the session saved at ${new Date(prepared.lastUsedAt).toLocaleString()}.`
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to continue the Claude session: ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.setApiKey", async () => {
			const existingApiKey = await context.secrets.get("llamacpp.apiKey");
			const apiKey = await vscode.window.showInputBox({
				title: "Primary OpenAI-Compatible API Key",
				prompt: "Enter API key (leave empty to clear)",
				password: true,
				ignoreFocusOut: true,
				value: existingApiKey ?? "",
			});

			if (apiKey === undefined) {
				return;
			}

			if (apiKey.trim().length > 0) {
				await context.secrets.store("llamacpp.apiKey", apiKey.trim());
				vscode.window.showInformationMessage("Primary server API key saved to Secret Storage.");
			} else {
				await context.secrets.delete("llamacpp.apiKey");
				vscode.window.showInformationMessage("Primary server API key cleared.");
			}

			llamaProvider.refreshLanguageModelChatInformation();
			quickActionsProvider.refresh();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.configureDeepSeek", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const existingApiKey = await context.secrets.get("llamacpp.deepSeekApiKey");
			const apiKey = await vscode.window.showInputBox({
				title: "DeepSeek API Key",
				prompt: "Enter DeepSeek API key (saved in VS Code Secret Storage)",
				password: true,
				ignoreFocusOut: true,
				placeHolder: "sk-...",
				value: existingApiKey ?? "",
			});

			if (apiKey === undefined) {
				return;
			}

			await config.update("enableDeepSeek", true, vscode.ConfigurationTarget.Global);
			await config.update("maxOutputTokensCap", DEEPSEEK_MAX_OUTPUT_TOKENS, vscode.ConfigurationTarget.Global);
			await config.update("thinkingMode", "deep", vscode.ConfigurationTarget.Global);
			await config.update("toolCallingMode", "apiDirect", vscode.ConfigurationTarget.Global);
			await config.update("apiDirectMaxTools", 70, vscode.ConfigurationTarget.Global);
			await config.update("apiDirectIncludeAllTools", false, vscode.ConfigurationTarget.Global);
			await config.update("apiDirectToolTokenBudget", 12000, vscode.ConfigurationTarget.Global);
			await config.update("deepSeekDefaultMaxOutputTokens", 131072, vscode.ConfigurationTarget.Global);
			await config.update("toolResultMode", "auto", vscode.ConfigurationTarget.Global);
			await config.update("autoCompact", false, vscode.ConfigurationTarget.Global);
			await config.update("retryOnContextOverflow", true, vscode.ConfigurationTarget.Global);
			await config.update("modelDiscoveryTimeoutMs", DEEPSEEK_DISCOVERY_TIMEOUT_MS, vscode.ConfigurationTarget.Global);
			await config.update("requestTimeoutMs", 1200000, vscode.ConfigurationTarget.Global);
			await config.update("requestQueueTimeoutMs", 1200000, vscode.ConfigurationTarget.Global);

			if (apiKey.trim().length > 0) {
				await context.secrets.store("llamacpp.deepSeekApiKey", apiKey.trim());

				try {
					const controller = new AbortController();
					const timeoutHandle = setTimeout(() => controller.abort(), DEEPSEEK_DISCOVERY_TIMEOUT_MS);
					let response: Response;
					try {
						response = await fetch(`${DEEPSEEK_SERVER_URL}/models`, {
							method: "GET",
							headers: {
								"User-Agent": ua,
								"Accept": "application/json",
								"Authorization": `Bearer ${apiKey.trim()}`,
							},
							signal: controller.signal,
						});
					} finally {
						clearTimeout(timeoutHandle);
					}

					if (!response.ok) {
						const details = (await response.text()).trim().slice(0, 200);
						const suffix = details.length > 0 ? `: ${details}` : "";
						vscode.window.showErrorMessage(
							`DeepSeek key check failed (${response.status} ${response.statusText})${suffix}`
						);
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					vscode.window.showWarningMessage(`DeepSeek key saved, but model check failed: ${message}`);
				}
			} else {
				await context.secrets.delete("llamacpp.deepSeekApiKey");
			}

			llamaProvider.refreshLanguageModelChatInformation();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage("DeepSeek source enabled alongside local models. Open model picker and select a DeepSeek model.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.openSettings", async () => {
			await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${EXTENSION_ID} llamacpp`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.openMemory", () => {
			MemoryManagerPanel.createOrShow(context.extensionUri, memoryService);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.clearMemory", async () => {
			const confirmed = await vscode.window.showWarningMessage(
				`Delete all ${memoryService.count} shared memory entries?`,
				{ modal: true },
				"Delete All"
			);
			if (confirmed !== "Delete All") {
				return;
			}
			await memoryService.clear();
			vscode.window.showInformationMessage("Shared memory cleared.");
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(async document => {
			if (document.uri.fsPath !== memoryService.filePath) {
				return;
			}
			try {
				await memoryService.reload();
				vscode.window.showInformationMessage(`Shared memory reloaded (${memoryService.count} entries).`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to reload shared memory: ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.refreshModels", async () => {
			llamaProvider.refreshLanguageModelChatInformation();
			codexProvider.refreshLanguageModelChatInformation();
			claudeProvider.refreshLanguageModelChatInformation();
			void codexProvider.refreshStatus();
			void claudeProvider.refreshStatus();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage("Local, DeepSeek, Codex, and Claude models refreshed.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.openCopilotModelPicker", async () => {
			const candidates = [
				"github.copilot.chat.openModelPicker",
				"workbench.action.chat.openModelPicker",
			];

			for (const commandId of candidates) {
				try {
					await vscode.commands.executeCommand(commandId);
					return;
				} catch {
					// Keep trying fallback command ids.
				}
			}

			const allCommands = await vscode.commands.getCommands(true);
			const dynamicCandidate = allCommands.find(
				command => command.toLowerCase().includes("modelpicker") && command.includes("copilot")
			);
			if (dynamicCandidate) {
				try {
					await vscode.commands.executeCommand(dynamicCandidate);
					return;
				} catch {
					// Fall through to warning message.
				}
			}

			vscode.window.showWarningMessage("Unable to open the Copilot model picker automatically.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.openLogsFolder", async () => {
			await logService.openLogsFolder();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.openLatestLog", async () => {
			await logService.openLatestLogFile();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.copyLatestLogPath", async () => {
			await logService.copyLatestLogPath();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleFileLogging", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = config.get<boolean>("enableFileLogging", true) !== false;
			const next = !current;
			await config.update("enableFileLogging", next, vscode.ConfigurationTarget.Global);
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Local LLM file logging: ${next ? "on" : "off"}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleStreamChunkLogging", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = config.get<boolean>("logStreamChunks", false) === true;
			const next = !current;
			await config.update("logStreamChunks", next, vscode.ConfigurationTarget.Global);
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Local LLM stream chunk logging: ${next ? "on" : "off"}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.togglePerformanceStatusBar", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = config.get<boolean>("showPerformanceStatusBar", true) !== false;
			const next = !current;
			await config.update("showPerformanceStatusBar", next, vscode.ConfigurationTarget.Global);
			updatePerformanceStatusBarVisibility();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Local LLM performance status bar: ${next ? "on" : "off"}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleContextUsageStatusBar", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = config.get<boolean>("showContextUsageStatusBar", true) !== false;
			const next = !current;
			await config.update("showContextUsageStatusBar", next, vscode.ConfigurationTarget.Global);
			updateContextUsageStatusBarVisibility();
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage(`Local LLM context usage status bar: ${next ? "on" : "off"}`);
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration("llamacpp")) {
				if (event.affectsConfiguration("llamacpp.showPerformanceStatusBar")) {
					updatePerformanceStatusBarVisibility();
				}
				if (event.affectsConfiguration("llamacpp.showContextUsageStatusBar")) {
					updateContextUsageStatusBarVisibility();
				}
				if (
					event.affectsConfiguration("llamacpp.serverUrl") ||
					event.affectsConfiguration("llamacpp.enableLocalServer") ||
					event.affectsConfiguration("llamacpp.localServerUrl") ||
					event.affectsConfiguration("llamacpp.localContextLength") ||
					event.affectsConfiguration("llamacpp.enableDeepSeek") ||
					event.affectsConfiguration("llamacpp.deepSeekContextLength") ||
					event.affectsConfiguration("llamacpp.contextLength") ||
					event.affectsConfiguration("llamacpp.maxOutputTokensCap") ||
					event.affectsConfiguration("llamacpp.maxToolsPerRequest") ||
					event.affectsConfiguration("llamacpp.modelFamily") ||
					event.affectsConfiguration("llamacpp.modelListCacheTtlMs")
				) {
					llamaProvider.refreshLanguageModelChatInformation();
				}
				if (
					event.affectsConfiguration("llamacpp.enableCodexSubscription") ||
					event.affectsConfiguration("llamacpp.codexCliPath") ||
					event.affectsConfiguration("llamacpp.codexContextLength") ||
					event.affectsConfiguration("llamacpp.codexMaxOutputTokens")
				) {
					codexProvider.refreshLanguageModelChatInformation();
					void codexProvider.refreshStatus();
				}
				if (
					event.affectsConfiguration("llamacpp.enableClaudeSubscription") ||
					event.affectsConfiguration("llamacpp.claudeContextLength") ||
					event.affectsConfiguration("llamacpp.claudeMaxOutputTokens") ||
					event.affectsConfiguration("llamacpp.claudeReasoningEffort")
				) {
					claudeProvider.refreshLanguageModelChatInformation();
					void claudeProvider.refreshStatus();
				}
				if (
					event.affectsConfiguration("llamacpp.claudeCacheKeepAliveEnabled") ||
					event.affectsConfiguration("llamacpp.claudeCacheKeepAliveMs") ||
					event.affectsConfiguration("llamacpp.claudeCacheKeepAliveIgnoreUsageLimit")
				) {
					quickActionsProvider.refresh();
					claudeProvider.refreshCacheKeepAliveStatus();
				}
				if (
					event.affectsConfiguration("llamacpp.enableLocalServer") ||
					event.affectsConfiguration("llamacpp.localServerUrl") ||
					event.affectsConfiguration("llamacpp.enableDeepSeek") ||
					event.affectsConfiguration("llamacpp.serverUrl") ||
					event.affectsConfiguration("llamacpp.enableCodexSubscription") ||
					event.affectsConfiguration("llamacpp.enableClaudeSubscription")
				) {
					void providerDirectory.recheck();
				}
				if (
					event.affectsConfiguration("llamacpp.codexCacheKeepAliveEnabled") ||
					event.affectsConfiguration("llamacpp.codexCacheKeepAliveMs") ||
					event.affectsConfiguration("llamacpp.codexCacheKeepAliveIgnoreUsageLimit")
				) {
					quickActionsProvider.refresh();
					codexProvider.refreshCodexCacheKeepAliveStatus();
				}
				quickActionsProvider.refresh();
			}
		})
	);
}

/**
 * Deactivates the VS Code extension.
 * Performs cleanup when the extension is deactivated.
 */
export function deactivate() {}
