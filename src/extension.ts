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
} from "./constants";
import { LlamaLogService } from "./logger";
import { SessionQualityTracker } from "./diagnostics/session-report";
import { SubscriptionUsageLedger, type SubscriptionProvider } from "./diagnostics/subscription-usage";
import { getCurrentWorkspaceScopeId, filterEntriesVisibleInWorkspace } from "./memory/scope";
import { SharedMemoryService } from "./memory/shared-memory-service";
import { registerContextControlCommand } from "./ui/context-control";
import { getFollowedCodexContext, onDidChangeFollowedCodexContext } from "./context/provider-handoff";
import { registerModelBehaviorCommands } from "./ui/model-behavior-commands";
import { LlamaQuickActionsProvider } from "./ui/quick-access";
import { SessionQualityPanel } from "./ui/session-quality-panel";
import { MemoryManagerPanel, estimateMemoryTokens } from "./ui/memory-manager";
import { ApiProviderManagerPanel } from "./ui/api-provider-manager";
import { ApiProviderService } from "./api-providers/api-provider-service";
import { ProviderDirectory } from "./providers/provider-directory";
import { CodexChatModelProvider, type CodexUsageRecord } from "./codex/codex-provider";
import { codexCliStorage, resolveCodexCliPath, setCodexCliStorage } from "./codex/app-server-client";
import { installCodexCli, installedCodexCliPath, installedCodexCliVersion, latestCodexCliVersion } from "./codex/cli-installer";
import {
	CODEX_DEFAULT_ACCOUNT_ID,
	decodeCodexAccountModelId,
	findCodexAccount,
	resolveActiveCodexAccountId,
	codexProviderLabel,
	resolveCodexAccounts,
} from "./codex/accounts";
import { ClaudeChatModelProvider, clearPersistedClaudeSessionState, type ClaudeLiveTurnUpdate } from "./claude/claude-provider";
import {
	claudeRuntimeStorage,
	invalidateClaudeCodeBinaryCache,
	resolveClaudeCodeBinary,
	resolvePreferredClaudeCodeBinary,
	setClaudeRuntimeStorage,
} from "./claude/app-server-client";
import {
	CLAUDE_RUNTIME_DOWNLOAD_ESTIMATE,
	claudeRuntimeTarget,
	downloadedClaudeRuntimeVersionForPath,
	installClaudeRuntime,
	installedClaudeRuntimePath,
	installedClaudeSdkVersion,
	latestInstalledClaudeRuntime,
	shouldAutoInstallClaudeRuntime,
} from "./claude/runtime-installer";
import {
	CLAUDE_DEFAULT_ACCOUNT_ID,
	decodeClaudeAccountModelId,
	findClaudeAccount,
	hasClaudeLogin,
	resolveActiveClaudeAccountId,
	claudeProviderLabel,
	resolveClaudeAccounts,
} from "./claude/accounts";
import { CocoChatModelProvider } from "./coco/coco-provider";
import { BUILTIN_PROVIDER_SOURCES, ownsHttpModel, providerSourceId, type ChatProviderRegistration } from "./providers/provider-registry";
import { providerSnapshots } from "./providers/provider-snapshot";
import { usageProviderForSource } from "./token-usage-history";
import { registerCocoCommands } from "./coco/commands";
import { classifyCodexTurnCache } from "./context/cache-diagnostics";
import { CompositeChatModelProvider } from "./composite-provider";
import { ConversationHistory, resolveHistoryImageLimit } from "./providers/conversation-history";
import { scheduleCursorStoreRetention } from "./cursor/retention";
import { AUTO_UPDATE_MODES, ExtensionUpdater, resolveAutoUpdateMode, type AutoUpdateMode } from "./update/extension-updater";
import type { ProviderRuntimeMetrics } from "./provider-metrics";
import { getSubagentModelProfiles } from "./subagent-guidance";
import { coalesce } from "./utils";
import { TokenUsageHistory, type TokenUsageSample } from "./token-usage-history";
import {
	renderUsageExperimentMarkdown,
	UsageExperimentTracker,
	type ExperimentVariant,
} from "./usage-experiment";
import { registerChatWindow } from "./chat";
import { balanceQuota, subscriptionQuota } from "./chat/quota";

interface ContextUsageDisplay {
	summary: string;
	breakdown: string;
	statusBarText: string;
	tooltip: string;
	tooltipLines: string[];
}

type RuntimeSource = string;

function runtimeSourceForModel(modelId: string): RuntimeSource {
	const source = providerSourceId(modelId);
	return source === "primary" ? "local" : source;
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
	// A Codex CLI downloaded by "Install Codex CLI" lives here; set before any app-server starts.
	setCodexCliStorage(path.join(context.globalStorageUri.fsPath, "codex-cli"));
	// The Claude runtime downloaded on first use lives here; set before any Claude session starts.
	setClaudeRuntimeStorage(path.join(context.globalStorageUri.fsPath, "claude-runtime"));

	// Production-grade crash logging: VS Code keeps the extension host alive on
	// uncaught exceptions, but without these handlers the failure is silent to
	// users. Log the error to the extension journal and show a one-time notice
	// pointing at the log location. Never re-throw: a crash in the handler must
	// not take the host down.
	process.on("uncaughtException", (error) => {
		try {
			const stack = error instanceof Error ? (error.stack ?? "") : "";
			const ours = stack.includes("mrlordcat.llama-vscode-chat") || stack.includes("AI Agent Bridge");
			logService.logError(ours ? "extension.uncaught_exception" : "extension.uncaught_exception_foreign", error);
			// Extensions share one extension-host process: uncaught exceptions from
			// other extensions (e.g. Copilot's git service) must not surface as a
			// scary "SubHarness" dialog. Only our own crashes get a notice.
			if (ours) {
				vscode.window.showWarningMessage(`SubHarness hit an unexpected error: ${error instanceof Error ? error.message : String(error)}. Details are in the extension log (SubHarness: Open Latest Log).`);
			}
		} catch {
			// Nothing else we can do here.
		}
	});
	process.on("unhandledRejection", (reason) => {
		try {
			logService.logError("extension.unhandled_rejection", reason instanceof Error ? reason : new Error(String(reason)));
		} catch {
			// Nothing else we can do here.
		}
	});

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
	// API provider profiles (multi-endpoint manager) share the model-source path.
	const apiProviderService = new ApiProviderService(context.globalState, context.secrets);
	context.subscriptions.push(apiProviderService);

	// Unified provider directory: one status model for every source.
	const subscriptionStatuses = new Map<string, { state: string; summary: string }>();
	const providerDirectory = new ProviderDirectory({
		getSecret: key => Promise.resolve(context.secrets.get(key)),
		getConfigValue: (key, fallback) => vscode.workspace.getConfiguration(CONFIG_SECTION).get(key, fallback),
		getApiProfiles: async () => apiProviderService.listSummaries(),
		getApiProfileKey: id => apiProviderService.getApiKey(id),
		getSubscriptionStatuses: () => subscriptionStatuses,
		getProviderSources: () => compositeProvider.registry.sources,
		getCatalogLoadedAt: key => apiProviderService.catalogLoadedAt(key),
		log: (event, data) => logService.log(event, data),
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
		() => apiProviderService.getModelSources(),
		(sourceKey, maximum, reported) => apiProviderService.recordContextMaximum(sourceKey, maximum, reported),
		{ state: context.workspaceState, storageRoot: path.join(context.storageUri?.fsPath ?? context.globalStorageUri.fsPath, "cursor-sdk") }
	);
	const codexAccounts = resolveCodexAccounts(
		vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>("codexAccounts", [])
	);
	const codexProviders = new Map<string, CodexChatModelProvider>();
	for (const account of codexAccounts) {
		codexProviders.set(account.id, new CodexChatModelProvider(extVersion, logService, context.workspaceState, context.globalState, account));
	}
	const activeCodexAccountId = (): string => resolveActiveCodexAccountId(
		codexAccounts,
		vscode.workspace.getConfiguration(CONFIG_SECTION).get("codexActiveAccount", "")
	);
	const activeCodex = (): CodexChatModelProvider =>
		codexProviders.get(activeCodexAccountId()) ?? codexProviders.get(CODEX_DEFAULT_ACCOUNT_ID)!;
	const codexAccountStatusKey = (accountId: string): string => accountId ? `codex:${accountId}` : "codex";
	const allCodexProviders = (): Array<[string, CodexChatModelProvider]> => [...codexProviders.entries()];
	/** Set by "Add Account": the sign-in flow starts on its own after the reload. */
	const CODEX_PENDING_SIGN_IN_KEY = "llamacpp.codexPendingSignIn.v1";
	const pendingCodexSignIn = (): string | undefined => {
		const stored = context.globalState.get<unknown>(CODEX_PENDING_SIGN_IN_KEY);
		return typeof stored === "string" && codexProviders.has(stored) ? stored : undefined;
	};
	context.subscriptions.push({ dispose: () => llamaProvider.disposeCursorTransport() });
	const claudeAccounts = resolveClaudeAccounts(
		vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>("claudeAccounts", [])
	);
	const claudeProviders = new Map<string, ClaudeChatModelProvider>();
	for (const account of claudeAccounts) {
		claudeProviders.set(account.id, new ClaudeChatModelProvider(extVersion, logService, context.workspaceState, {}, account));
	}
	const activeClaudeAccountId = (): string => resolveActiveClaudeAccountId(
		claudeAccounts,
		vscode.workspace.getConfiguration(CONFIG_SECTION).get("claudeActiveAccount", "")
	);
	const activeClaude = (): ClaudeChatModelProvider =>
		claudeProviders.get(activeClaudeAccountId()) ?? claudeProviders.get(CLAUDE_DEFAULT_ACCOUNT_ID)!;
	const claudeAccountStatusKey = (accountId: string): string => accountId ? `claude:${accountId}` : "claude";
	const allClaudeProviders = (): Array<[string, ClaudeChatModelProvider]> => [...claudeProviders.entries()];
	/** Set by "Add Claude Account": the sign-in flow starts on its own after the reload. */
	const CLAUDE_PENDING_SIGN_IN_KEY = "llamacpp.claudePendingSignIn.v1";
	const pendingClaudeSignIn = (): string | undefined => {
		const stored = context.globalState.get<unknown>(CLAUDE_PENDING_SIGN_IN_KEY);
		return typeof stored === "string" && claudeProviders.has(stored) ? stored : undefined;
	};
	const cocoProvider = new CocoChatModelProvider({ state: context.workspaceState, catalogState: context.globalState, storageRoot: path.join(context.storageUri?.fsPath ?? context.globalStorageUri.fsPath, "coco-history"), log: (event,data) => logService.log(event,data) });
	context.subscriptions.push(cocoProvider);
	for (const provider of codexProviders.values()) {
		context.subscriptions.push(provider);
	}
	for (const provider of claudeProviders.values()) {
		context.subscriptions.push(provider);
	}
	const codexRegistrations: ChatProviderRegistration[] = allCodexProviders().map(([accountId, provider]) => ({
		id: codexAccountStatusKey(accountId),
		provider,
		abandonConversation: (id: string) => provider.abandonConversation(id),
		...(accountId ? {} : { source: BUILTIN_PROVIDER_SOURCES.find(source => source.id === "codex") }),
		ownsModel: (modelId: string) => decodeCodexAccountModelId(modelId, accountId) !== undefined,
	}));
	const claudeRegistrations: ChatProviderRegistration[] = allClaudeProviders().map(([accountId, provider]) => ({
		id: claudeAccountStatusKey(accountId),
		provider,
		onForeignRequest: () => provider.refreshSubscriptionUsage(),
		abandonConversation: (id: string) => provider.abandonConversation(id),
		...(accountId ? {} : { source: BUILTIN_PROVIDER_SOURCES.find(source => source.id === "claude") }),
		ownsModel: (modelId: string) => decodeClaudeAccountModelId(modelId, accountId) !== undefined,
	}));
	const subscriptionProviders = [
		...codexRegistrations,
		...claudeRegistrations,
		{ id: "coco", provider: cocoProvider, onForeignRequest: (id?: unknown) => cocoProvider.onForeignRequest(id),
			abandonConversation: (id: string) => cocoProvider.onForeignRequest(id) },
	];
	const conversationHistory = new ConversationHistory(
		path.join(context.storageUri?.fsPath ?? context.globalStorageUri.fsPath, "chat-history"),
		// Read live: a changed limit applies to the next save without a reload.
		() => resolveHistoryImageLimit(vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>("journalImageRetention"))
	);
	// Token and limit-window history per subscription, shared by every window of this profile.
	const subscriptionUsage = new SubscriptionUsageLedger(path.join(context.globalStorageUri.fsPath, "subscription-usage"));
	void subscriptionUsage.initialize().catch(error => logService.logError("subscription_usage.initialize_failed", error));
	context.subscriptions.push({ dispose: () => subscriptionUsage.dispose() });
	// Old transcripts and their images are cleaned after startup, never on a chat turn.
	const historyRetention = setTimeout(() => {
		const started = Date.now();
		void conversationHistory.pruneHistory()
			.then(result => logService.log("storage.retention.done", {
				store: "chat-history",
				removedFiles: result.removedFiles,
				removedBytes: result.removedBytes,
				durationMs: Date.now() - started,
				removedConversations: result.removedConversations,
			}))
			.catch(error => logService.logError("storage.retention.failed", error, { store: "chat-history" }));
	}, 8_000);
	historyRetention.unref?.();
	context.subscriptions.push({ dispose: () => clearTimeout(historyRetention) });
	const cursorRetention = scheduleCursorStoreRetention({
		root: path.join(context.storageUri?.fsPath ?? context.globalStorageUri.fsPath, "cursor-sdk"),
		log: (event, data) => logService.log(event, data),
	});
	context.subscriptions.push(cursorRetention);
	const compositeProvider = new CompositeChatModelProvider({ providers: [
		{ id: "http", provider: llamaProvider, ownsModel: ownsHttpModel,
			usesConversationHistory: model => llamaProvider.usesConversationHistory(model),
			onForeignRequest: async id => llamaProvider.cancelCursorConversation(id),
			abandonConversation: id => llamaProvider.cancelCursorConversation(id) },
		...subscriptionProviders.map(registration => {
			const explicit = "ownsModel" in registration ? registration.ownsModel : undefined;
			const source = "source" in registration ? registration.source : undefined;
			return { ...registration,
				source: source ?? BUILTIN_PROVIDER_SOURCES.find(entry => entry.id === registration.id),
				ownsModel: explicit ?? ((id: string) => providerSourceId(id) === registration.id),
			};
		}),
	], history: conversationHistory });
	context.subscriptions.push(compositeProvider);
	const quotaChanges = new vscode.EventEmitter<void>();
	context.subscriptions.push(
		quotaChanges,
		...[...claudeProviders.values()].map(provider => provider.onDidChangeStatus(() => quotaChanges.fire())),
		...[...codexProviders.values()].map(provider => provider.onDidChangeStatus(() => quotaChanges.fire())),
	);
	registerChatWindow(context, {
		composite: compositeProvider,
		getCompactionDeepSeekApiKey: () => llamaProvider.getCompactionDeepSeekApiKey(),
		log: (event, data) => logService.log(event, data),
		userAgent: ua,
		memory: memoryService,
		sessionQuality,
		quota: {
			snapshot: () => [
				...codexAccounts.map(account => subscriptionQuota(codexProviderLabel(account), codexProviders.get(account.id)!.subscriptionWindows)),
				...claudeAccounts.map(account => subscriptionQuota(claudeProviderLabel(account), claudeProviders.get(account.id)!.subscriptionWindows)),
				balanceQuota("DeepSeek", llamaProvider.deepSeekBalanceSummary),
			].filter(quota => quota !== undefined),
			refresh: async () => {
				await Promise.allSettled([...codexAccounts.map(account => codexProviders.get(account.id)!.refreshStatus()), ...claudeAccounts.map(account => claudeProviders.get(account.id)!.refreshSubscriptionUsage(true)), llamaProvider.refreshDeepSeekBalance(true)]);
			},
			onDidChange: quotaChanges.event,
		},
		accounts: {
			offers: () => [
				...codexAccounts.flatMap(account => {
					const provider = codexProviders.get(account.id)!;
					return provider.needsSignIn ? [{ provider: codexAccountStatusKey(account.id), label: `Sign in to ${codexProviderLabel(account)}`, detail: provider.cliAvailable ? "ChatGPT subscription" : "ChatGPT subscription; downloads the Codex CLI first" }] : [];
				}),
				...(claudeAccounts.flatMap(account => {
					const provider = claudeProviders.get(account.id)!;
					return provider.needsSignIn ? [{ provider: claudeAccountStatusKey(account.id), label: `Sign in to ${claudeProviderLabel(account)}`, detail: "Claude subscription, through the bundled Claude Code" }] : [];
				})),
			],
			signIn: async provider => {
				if (provider === "codex" || provider.startsWith("codex:")) {
					await vscode.commands.executeCommand("llamacpp.codexAccountSignIn", provider === "codex" ? "" : provider.slice(6));
				} else if (provider === "claude" || provider.startsWith("claude:")) {
					await vscode.commands.executeCommand("llamacpp.claudeAccountSignIn", provider === "claude" ? "" : provider.slice(7));
				}
			},
			onDidChange: quotaChanges.event,
		},
	});

	let lastThroughput: string | undefined;
	let lastPromptCache: string | undefined;
	let lastContextUsage: ContextUsageDisplay | undefined;
	let lastHealthStatus: string | undefined;
	let lastHealthEnriched: unknown | undefined;
	const runtimeMetrics = new Map<RuntimeSource, ProviderRuntimeMetrics>();
	const updater = new ExtensionUpdater({ state: context.globalState, storageDir: context.globalStorageUri.fsPath,
		currentVersion: String(context.extension.packageJSON.version), log: (event, data) => logService.log(event, data) });
	context.subscriptions.push(updater,
		vscode.commands.registerCommand("llamacpp.checkForUpdates", () => updater.check(true)),
		vscode.commands.registerCommand("llamacpp.installUpdate", () => updater.install(true)),
		vscode.commands.registerCommand("llamacpp.chooseAutoUpdateMode", async () => {
			const current = resolveAutoUpdateMode();
			const labels: Record<AutoUpdateMode, string> = { notify: "Notify", install: "Install automatically", off: "Off" };
			const details: Record<AutoUpdateMode, string> = { notify: "Check every 5 hours and offer new releases", install: "Download, verify and install new releases, then offer a reload", off: "Only manual checks from Quick Access" };
			const picked = await vscode.window.showQuickPick(AUTO_UPDATE_MODES.map(mode => ({ label: labels[mode], description: mode === current ? "current" : undefined, detail: details[mode], mode })), { title: "SubHarness: Automatic Updates" });
			if (picked && picked.mode !== current) { await vscode.workspace.getConfiguration(CONFIG_SECTION).update("autoUpdate", picked.mode, vscode.ConfigurationTarget.Global); }
		}));
	// Development and test hosts never contact GitHub on their own.
	if (context.extensionMode === vscode.ExtensionMode.Production) { updater.start(); }
	const quickActionsProvider = new LlamaQuickActionsProvider({
		getLastThroughput: () => lastThroughput,
		getLastContextUsage: () => lastContextUsage,
		getMemoryCount: () => filterEntriesVisibleInWorkspace(memoryService.list(), getCurrentWorkspaceScopeId()).length,
		getLastPromptCache: () => lastPromptCache,
		getSessionSummary: () => sessionQuality.count === 0 ? "No turns" : `${sessionQuality.count} turns / cache ${sessionQuality.summary.cacheHitPercent ?? "n/a"}%`,
		getExpiredMemoryCount: () => memoryService.expiredCount,
		getClaudeUsage: () => activeClaude().usageSummary,
		getClaudeLastRequest: () => activeClaude().lastRequestUsage,
		getClaudeUsageLimits: () => activeClaude().subscriptionUsageLimits,
		getCodexSubscriptionUsage: () => activeCodex().subscriptionUsageSummary,
		getSubagentProfiles: () => getSubagentModelProfiles(),
		getTokenUsageHistory: () => tokenUsageHistory.summary,
		getUsageExperiments: () => usageExperiments.summary,
		getDeepSeekBalance: () => llamaProvider.deepSeekBalanceSummary,
		getCodexUsageLimitPercent: () => activeCodex().codexUsageLimitPercent,
		getCodexUsageLimitReset: () => activeCodex().codexUsageLimitResetLabel,
		getCodexUsageLimitWindow: () => activeCodex().codexUsageLimitWindowLabel,
		getClaudeUsageLimitPercent: () => activeClaude().claudeUsageLimitPercent,
		getClaudeUsageLimitReset: () => activeClaude().claudeUsageLimitResetLabel,
		getMemoryContextTokens: () => estimateMemoryTokens(filterEntriesVisibleInWorkspace(memoryService.list(), getCurrentWorkspaceScopeId())),
		getApiProviderSummary: () => ({ total: apiProviderService.count, enabled: apiProviderService.enabledCount }),
		getTotalMemoryCount: () => memoryService.count,
		getApiProviders: () => apiProviderService.quickAccessApiProviders(false),
		getCodexUsageLimits: () => activeCodex().codexUsageLimitSummaries,
		getCodexAccounts: () => { const active = activeCodexAccountId(); return codexAccounts.map(account => {
			const provider = codexProviders.get(account.id)!;
			return { id: account.id, label: account.label, active: account.id === active,
				state: provider.providerStatus.state, summary: provider.accountSummary };
		}); },
		getClaudeAccounts: () => { const active = activeClaudeAccountId(); return claudeAccounts.map(account => {
			const provider = claudeProviders.get(account.id)!;
			return { id: account.id, label: account.label, active: account.id === active,
				state: provider.accountSummary.startsWith("Connected") ? "connected" : "signedOut", summary: provider.accountSummary };
		}); },
		getCocoStatus: () => ({ ...cocoProvider.providerStatus, thinkingLevels: cocoProvider.thinkingLevels }),
		getProviderSnapshots: () => providerSnapshots(providerDirectory.list(),
			new Map([...runtimeMetrics, ["codex", activeCodex().runtimeMetrics ?? {}], ["claude", activeClaude().runtimeMetrics ?? {}], ["coco", cocoProvider.runtimeMetrics ?? {}]]),
			new Map([["codex", activeCodex().accountSummary], ["claude", activeClaude().accountSummary]])),
		getUpdateStatus: () => updater.status,
	});
	context.subscriptions.push(updater.onDidChange(() => quickActionsProvider.refresh()));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration(`${CONFIG_SECTION}.autoUpdate`)) { quickActionsProvider.refresh(); } }));
	const quickActionsView = vscode.window.createTreeView("llamacpp-quick-actions", { treeDataProvider: quickActionsProvider });
	context.subscriptions.push(quickActionsView);
	context.subscriptions.push(quickActionsProvider);
	context.subscriptions.push(apiProviderService.onDidChangeContext(() => {
		// A loaded catalog is also availability evidence (Cursor's probe can lag).
		void providerDirectory.refresh().catch(error => logService.logError("providers.catalog_refresh.failed", error));
		quickActionsProvider.refresh();
	}));
	context.subscriptions.push(apiProviderService.onDidChangeBalance(() => quickActionsProvider.refresh()));
	context.subscriptions.push(memoryService.onDidChange(() => quickActionsProvider.refresh()));
	context.subscriptions.push(memoryService.onDidChange(() => MemoryManagerPanel.refreshIfOpen()));
	context.subscriptions.push(tokenUsageHistory.onDidChange(() => quickActionsProvider.refresh()));
	context.subscriptions.push(usageExperiments.onDidChange(() => quickActionsProvider.refresh()));
	// Subscription providers re-announce an unchanged state with every runtime
	// tick (Codex: every 200 ms while a turn streams). The directory only reads
	// state and summary, so it is refreshed when those move; the open manager
	// panel picks up the live numbers at most once a second.
	const refreshManagerPanel = coalesce(() => ApiProviderManagerPanel.refreshIfOpen(), 1_000);
	context.subscriptions.push(refreshManagerPanel);
	const statusProviders: Array<{ id: string; provider: { onDidChangeStatus: vscode.Event<{ state: string; summary: string }> } }> = [
		...allCodexProviders().map(([accountId, provider]) => ({ id: codexAccountStatusKey(accountId), provider })),
		...allClaudeProviders().map(([accountId, provider]) => ({ id: claudeAccountStatusKey(accountId), provider })),
		{ id: "coco", provider: cocoProvider },
	];
	for (const { id, provider } of statusProviders) {
		const onStatus = provider.onDidChangeStatus;
		context.subscriptions.push(onStatus(status => {
			const previous = subscriptionStatuses.get(id);
			subscriptionStatuses.set(id, { state: status.state, summary: status.summary });
			quickActionsProvider.refresh();
			if (previous?.state !== status.state || previous?.summary !== status.summary) {
				void providerDirectory.refresh();
				ApiProviderManagerPanel.refreshIfOpen();
			} else {
				refreshManagerPanel();
			}
		}));
	}
	context.subscriptions.push(cocoProvider.onDidChangeLanguageModelChatInformation(() => quickActionsProvider.refresh()));
	registerCocoCommands(context, cocoProvider, () => quickActionsProvider.refresh());
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration("snowflake.connectionsConfigFile")) {
			cocoProvider.refreshLanguageModelChatInformation();
			void cocoProvider.refreshStatus();
		}
	}));
	context.subscriptions.push(apiProviderService.onDidChange(() => {
		llamaProvider.refreshLanguageModelChatInformation();
		// Probe newly saved/edited profiles right away; a plain refresh()
		// would leave them stuck on "Checking" until the 5-minute timer.
		void providerDirectory.recheck().catch(error =>
			logService.logError("providers.profile_change_recheck.failed", error)
		);
		quickActionsProvider.refresh();
	}));
	context.subscriptions.push(providerDirectory.onDidChange(() => {
		quickActionsProvider.refresh();
		ApiProviderManagerPanel.refreshIfOpen();
	}));
	for (const provider of claudeProviders.values()) {
		context.subscriptions.push(provider.onDidChangeCacheKeepAliveStatus(() => {
			quickActionsProvider.refresh();
			SessionQualityPanel.refreshIfOpen();
		}));
	}
	for (const [accountId, provider] of allCodexProviders()) {
		// Each subscription keeps its own window history: mixing two accounts in one
		// ledger would hide how many tokens each plan actually provides.
		const ledgerProvider: SubscriptionProvider = accountId ? `codex:${accountId}` : "codex";
		const accountLabel = provider.accountLabel;
		context.subscriptions.push(provider.onDidRecordUsage(usage => {
			recordUsage({
				provider: "codex",
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cachedInputTokens: usage.cachedInputTokens,
				reasoningOutputTokens: usage.reasoningOutputTokens,
			}, usage.modelId);
			subscriptionUsage.record({
				provider: ledgerProvider,
				modelId: accountId ? `${accountLabel} / ${usage.modelId}` : usage.modelId,
				freshInputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
				cachedInputTokens: usage.cachedInputTokens,
				outputTokens: usage.outputTokens,
			});
			updateCodexSessionQuality(sessionQuality, usage, true);
			SessionQualityPanel.refreshIfOpen();
		}));
		context.subscriptions.push(provider.onDidUpdateLiveTurn(usage => {
			updateCodexSessionQuality(sessionQuality, usage, usage.phase !== "running");
		}));
	}
	for (const [accountId, provider] of allClaudeProviders()) {
		// Each subscription keeps its own window history: mixing two accounts in one
		// ledger would hide how many tokens each plan actually provides.
		const ledgerProvider: SubscriptionProvider = accountId ? `claude:${accountId}` : "claude";
		const accountLabel = claudeProviderLabel(provider.account);
		context.subscriptions.push(provider.onDidRecordUsage(usage => {
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
			subscriptionUsage.record({
				provider: ledgerProvider,
				modelId: accountId ? `${accountLabel} / ${usage.modelId}` : usage.modelId,
				freshInputTokens: usage.inputTokens,
				cachedInputTokens: usage.cacheReadInputTokens,
				cacheWriteInputTokens: usage.cacheCreationInputTokens,
				outputTokens: usage.outputTokens,
			});
			SessionQualityPanel.refreshIfOpen();
		}));
		context.subscriptions.push(provider.onDidUpdateLiveTurn(update => {
			updateClaudeSessionQuality(sessionQuality, update);
		}));
	}
	context.subscriptions.push(cocoProvider.onDidRecordUsage(usage => {
		recordUsage({ provider: "coco", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
			cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens,
			modelTurns: usage.modelTurns, durationMs: usage.durationMs, estimated: usage.estimated }, usage.modelId);
	}));
	context.subscriptions.push(cocoProvider.onDidUpdateLiveTurn(update => {
		if (update.context) { sessionQuality.recordContext(update.context); }
		if (update.turn.lifecyclePhase === "running") { sessionQuality.updateTurn(update.turn); }
		else { sessionQuality.recordTurn(update.turn); }
		quickActionsProvider.refresh();
	}));
	context.subscriptions.push(llamaProvider.onDidRecordCursorUsage(usage => {
		recordUsage({ provider: "api", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
			cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens,
			modelTurns: usage.modelTurns, durationMs: usage.durationMs, estimated: usage.estimated }, usage.modelId);
	}));
	context.subscriptions.push(llamaProvider.onDidUpdateCursorTurn(update => {
		runtimeMetrics.set(update.sourceKey, update.runtime);
		if (update.turn.lifecyclePhase === "running") { sessionQuality.updateTurn(update.turn); }
		else { sessionQuality.recordTurn(update.turn); }
		quickActionsProvider.refresh();
	}));
	context.subscriptions.push(registerContextControlCommand(
		() => activeCodex().runtimeMetrics,
		() => quickActionsProvider.refresh(),
		() => ({ models: activeCodex().contextWindows, followTarget: activeCodex().followTarget })
	));
	context.subscriptions.push(onDidChangeFollowedCodexContext(() => {
		if (vscode.workspace.getConfiguration("llamacpp").get<boolean>("sharedContextFollowCodex", false) !== true) {
			return;
		}
		const followed = getFollowedCodexContext();
		logService.log("shared_context.follow_codex", { model: followed?.modelId, window: followed?.window });
		// May fire inside a Codex request: re-advertise without dropping the Codex model catalog.
		llamaProvider.notifyModelLimitsChanged();
		for (const provider of codexProviders.values()) {
			provider.notifyModelLimitsChanged();
		}
		for (const provider of claudeProviders.values()) {
			provider.refreshLanguageModelChatInformation();
		}
		cocoProvider.refreshLanguageModelChatInformation();
		quickActionsProvider.refresh();
	}));
	context.subscriptions.push(...registerModelBehaviorCommands(() => quickActionsProvider.refresh()));
	llamaProvider.refreshLanguageModelChatInformation();
	for (const provider of codexProviders.values()) {
		provider.refreshLanguageModelChatInformation();
	}
	for (const provider of claudeProviders.values()) {
		provider.refreshLanguageModelChatInformation();
	}
	cocoProvider.refreshLanguageModelChatInformation();
	void cocoProvider.refreshStatus();
	for (const [accountId, provider] of allCodexProviders()) {
		void provider.refreshStatus().then(status => {
			subscriptionStatuses.set(codexAccountStatusKey(accountId), { state: status.state, summary: status.summary });
			subscriptionUsage.observe(accountId ? `codex:${accountId}` : "codex", provider.subscriptionWindows);
		}).catch(error => logService.logError("codex.initial_status.failed", error));
	}
	for (const [accountId, provider] of allClaudeProviders()) {
		void provider.refreshStatus().then(status => {
			subscriptionStatuses.set(claudeAccountStatusKey(accountId), { state: status.state, summary: status.summary });
			subscriptionUsage.observe(accountId ? `claude:${accountId}` : "claude", provider.subscriptionWindows);
		}).catch(error => logService.logError("claude.initial_status.failed", error));
	}
	// A freshly added account signs in right after the reload that created it.
	const pendingSignInAccount = pendingCodexSignIn();
	if (pendingSignInAccount) {
		void context.globalState.update(CODEX_PENDING_SIGN_IN_KEY, undefined);
		logService.log("codex.account.pending_sign_in", { account: pendingSignInAccount });
		const timer = setTimeout(() => {
			void codexProviders.get(pendingSignInAccount)?.signIn()
				.then(() => quickActionsProvider.refresh())
				.catch(error => {
					logService.logError("codex.account.pending_sign_in_failed", error);
					const message = error instanceof Error ? error.message : String(error);
					void vscode.window.showErrorMessage(
						`Codex account sign-in did not finish: ${message}. Open Quick Access → Codex → ChatGPT Accounts to retry.`
					);
				});
		}, 3_000);
		timer.unref?.();
	}
	// A freshly added Claude account signs in right after the reload that created it.
	const pendingClaudeAccount = pendingClaudeSignIn();
	if (pendingClaudeAccount) {
		void context.globalState.update(CLAUDE_PENDING_SIGN_IN_KEY, undefined);
		logService.log("claude.account.pending_sign_in", { account: pendingClaudeAccount });
		const timer = setTimeout(() => {
			void (async () => {
				if (!await ensureClaudeRuntime()) {
					return;
				}
				await claudeProviders.get(pendingClaudeAccount)?.signIn();
				quickActionsProvider.refresh();
			})().catch(error => {
				logService.logError("claude.account.pending_sign_in_failed", error);
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(
					`Claude account sign-in did not finish: ${message}. Open Quick Access → Claude → Claude Accounts to retry.`
				);
			});
		}, 3_000);
		timer.unref?.();
	}
	void providerDirectory.recheck().catch(error => logService.logError("providers.initial_recheck.failed", error));
	// The DeepSeek balance endpoint is skipped by the provider when no DeepSeek key is saved.
	void llamaProvider.refreshDeepSeekBalance().catch(error => logService.logError("deepseek.balance.initial_failed", error));

	/**
	 * Provider usage windows and balances (DeepSeek balance, Codex status, Claude
	 * usage) cost a network or IPC request each. They are refreshed at startup
	 * (above), when Quick Access becomes visible, from the manual refresh, and by
	 * the idle 15-minute timer below: never from the cheap 60-second UI timer.
	 */
	let providerUsageRefresh: Promise<void> | undefined;
	const refreshProviderUsage = (force = false): Promise<void> => {
		if (providerUsageRefresh) {
			return providerUsageRefresh;
		}
		const deepSeekEnabled = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("enableDeepSeek", true) !== false;
		const tasks: Array<Promise<unknown>> = [];
		if (deepSeekEnabled) {
			tasks.push(llamaProvider.refreshDeepSeekBalance(force).catch(error => logService.logError("deepseek.periodic_balance.failed", error)));
		}
		for (const [accountId, provider] of allCodexProviders()) {
			subscriptionUsage.observe(accountId ? `codex:${accountId}` : "codex", provider.subscriptionWindows);
			tasks.push(provider.refreshStatus().catch(error => logService.logError("codex.periodic_status.failed", error)));
		}
		for (const [accountId, provider] of allClaudeProviders()) {
			const ledgerProvider: SubscriptionProvider = accountId ? `claude:${accountId}` : "claude";
			subscriptionUsage.observe(ledgerProvider, provider.subscriptionWindows);
			// Forcing skips the idle grace that otherwise keeps the Claude CLI
			// probe off; only an account that can answer is worth probing.
			tasks.push(provider.refreshSubscriptionUsage(force && !provider.needsSignIn)
				.catch(error => logService.logError("claude.periodic_usage.failed", error)));
		}
		tasks.push(subscriptionUsage.refresh().catch(error => logService.logError("subscription_usage.refresh_failed", error)));
		providerUsageRefresh = Promise.allSettled(tasks).then(() => {
			providerUsageRefresh = undefined;
		});
		return providerUsageRefresh;
	};

	// A known window reset that has already passed: refresh that provider once
	// so the chat and Quick Access do not keep showing a used-up window.
	const refreshedExpiredResets = new Set<string>();
	const refreshAfterExpiredWindows = (): void => {
		const now = Date.now();
		const expiredReset = (windows: { fiveHour?: { utilization: number; resetsAt?: string }; weekly?: { utilization: number; resetsAt?: string } }): string | undefined => {
			for (const window of [windows.fiveHour, windows.weekly]) {
				if (window && window.utilization >= 100 && window.resetsAt !== undefined) {
					const resetAt = Date.parse(window.resetsAt);
					if (Number.isFinite(resetAt) && resetAt <= now) {
						return window.resetsAt;
					}
				}
			}
			return undefined;
		};
		for (const [accountId, provider] of allCodexProviders()) {
			const resetsAt = expiredReset(provider.subscriptionWindows);
			const key = `codex:${accountId}:${resetsAt}`;
			if (resetsAt === undefined || refreshedExpiredResets.has(key)) {
				continue;
			}
			refreshedExpiredResets.add(key);
			void provider.refreshStatus().catch(error => logService.logError("codex.reset_refresh.failed", error));
		}
		for (const [accountId, provider] of allClaudeProviders()) {
			const resetsAt = expiredReset(provider.subscriptionWindows);
			const key = `claude:${accountId}:${resetsAt}`;
			if (resetsAt === undefined || refreshedExpiredResets.has(key)) {
				continue;
			}
			refreshedExpiredResets.add(key);
			if (!provider.needsSignIn) {
				void provider.refreshSubscriptionUsage(true).catch(error => logService.logError("claude.reset_refresh.failed", error));
			}
		}
	};

	// Cheap local re-render only: labels such as "resets in N min" stay fresh
	// while the view is visible, and nothing is redrawn while it is hidden.
	const usageLimitRefreshTimer = setInterval(() => {
		if (quickActionsView.visible) {
			quickActionsProvider.refresh();
		}
		ApiProviderManagerPanel.refreshIfOpen();
		SessionQualityPanel.refreshIfOpen();
		refreshAfterExpiredWindows();
	}, 60_000);
	const providerUsageRefreshTimer = setInterval(() => {
		void refreshProviderUsage();
	}, 15 * 60_000);
	context.subscriptions.push(
		new vscode.Disposable(() => clearInterval(usageLimitRefreshTimer)),
		new vscode.Disposable(() => clearInterval(providerUsageRefreshTimer))
	);

	// Opening Quick Access is the user asking to see the current limits. At most
	// one full (network/IPC) refresh per 5 minutes; re-opening sooner only
	// re-renders the already updated data.
	const VISIBILITY_USAGE_REFRESH_MS = 5 * 60_000;
	// Startup already refreshed everything; opening the view right after must not double it.
	let lastVisibilityUsageRefreshAt = Date.now();
	context.subscriptions.push(quickActionsView.onDidChangeVisibility(event => {
		if (!event.visible) {
			return;
		}
		if (Date.now() - lastVisibilityUsageRefreshAt >= VISIBILITY_USAGE_REFRESH_MS) {
			lastVisibilityUsageRefreshAt = Date.now();
			void refreshProviderUsage(true);
		}
		quickActionsProvider.refresh();
	}));

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
			const sourceLabel = providerDirectory.list().find(entry => entry.key === source)?.label ?? source;
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
						const sourceLabel = providerDirectory.list().find(entry => entry.key === source)?.label ?? source;
			recordUsage({
				provider: usageProviderForSource(source),
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
	// from any provider (Llama, Codex, Claude). Running turns update the tracker
	// several times a second: the panel follows at most twice a second and the
	// file at most every two seconds, one write at a time.
	const refreshSessionQualityPanel = coalesce(() => SessionQualityPanel.refreshIfOpen(), 500);
	const scheduleLiveSessionReport = coalesce(writeLiveSessionReport, 2_000);
	context.subscriptions.push(refreshSessionQualityPanel, {
		dispose: () => {
			scheduleLiveSessionReport.flush();
			scheduleLiveSessionReport.dispose();
		},
	});
	context.subscriptions.push(
		sessionQuality.onDidChange(() => {
			refreshSessionQualityPanel();
			scheduleLiveSessionReport();
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
				// The explicit health check also refreshes provider status polling.
				providerDirectory.resetLocalProbeBackoff();
				void providerDirectory.recheck().catch(error =>
					logService.logError("providers.health_check_recheck.failed", error)
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
						status: activeClaude().statusSummary.startsWith("Connected") ? "connected" : activeClaude().statusSummary.startsWith("Paused") ? "paused_usage_limit" : "warning",
						summary: activeClaude().statusSummary,
						usagePercent: activeClaude().claudeUsageLimitPercent,
						resetLabel: activeClaude().claudeUsageLimitResetLabel,
						keepAlive: activeClaude().cacheKeepAliveStatus,
					},
					codex: {
						status: activeCodex().accountSummary === "Connected" ? "connected" : "warning",
						summary: activeCodex().accountSummary,
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
					() => activeClaude().cacheKeepAliveStatus,
					() => lastHealthEnriched,
					() => subscriptionUsage.summary()
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
					() => activeClaude().cacheKeepAliveStatus,
					() => lastHealthEnriched,
					() => subscriptionUsage.summary()
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
						   summary: subscriptionStatuses.get("codex")?.summary ?? activeCodex().accountSummary,
						usagePercent: activeCodex().codexUsageLimitPercent,
						usageReset: activeCodex().codexUsageLimitResetLabel,
					},
					claude: {
						   summary: subscriptionStatuses.get(claudeAccountStatusKey(activeClaudeAccountId()))?.summary ?? activeClaude().accountSummary,
						limits: activeClaude().subscriptionUsageLimits.map(limit => ({
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

	const codexProviderFor = (accountId: unknown): CodexChatModelProvider => {
		const account = findCodexAccount(codexAccounts, accountId);
		return (account && codexProviders.get(account.id)) || activeCodex();
	};
	const refreshAllCodexCatalogs = (): void => {
		for (const provider of codexProviders.values()) {
			provider.refreshLanguageModelChatInformation();
		}
	};
	const setActiveCodexAccount = async (accountId: unknown): Promise<void> => {
		const account = findCodexAccount(codexAccounts, accountId);
		if (!account) {
			return;
		}
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		await config.update("codexActiveAccount", account.id, vscode.ConfigurationTarget.Global);
		// Re-announce catalogs so subagents try the active account first.
		refreshAllCodexCatalogs();
		quickActionsProvider.refresh();
		const provider = codexProviders.get(account.id);
		await provider?.refreshStatus().catch(error => logService.logError("codex.switch_status.failed", error));
		vscode.window.showInformationMessage(`Codex account: ${account.label}. Subagents try it first, and Quick Access shows its usage.`);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.selectCodexAccount", async (arg?: { accountId?: string } | string) => {
			const requested = typeof arg === "string" ? arg : arg?.accountId;
			if (requested !== undefined) {
				await setActiveCodexAccount(requested);
				return;
			}
			const active = activeCodexAccountId();
			const picked = await vscode.window.showQuickPick(codexAccounts.map(account => ({
				label: `${account.id === active ? "$(check) " : ""}${account.label}`,
				description: account.id || "~/.codex",
				detail: codexProviders.get(account.id)?.accountSummary,
				accountId: account.id,
			})), { title: "SubHarness: Codex Account", placeHolder: "Choose the ChatGPT subscription used by the model picker" });
			if (picked) {
				await setActiveCodexAccount(picked.accountId);
			}
		})
	);

	/** Raw entries stay in the stored order; the resolved list only feeds the runtime. */
	const rawCodexAccounts = (): Array<Record<string, unknown>> => {
		const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>("codexAccounts", []);
		return Array.isArray(raw)
			? raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
			: [];
	};
	const offerReload = async (question: string): Promise<void> => {
		const reload = await vscode.window.showInformationMessage(question, "Reload Window", "Later");
		if (reload === "Reload Window") {
			await vscode.commands.executeCommand("workbench.action.reloadWindow");
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.addCodexAccount", async () => {
			const used = new Set(codexAccounts.map(account => account.id).filter(id => id !== CODEX_DEFAULT_ACCOUNT_ID));
			const id = await vscode.window.showInputBox({
				title: "SubHarness: Add Codex Account",
				prompt: "Short id for the second ChatGPT subscription. It names the Codex home (~/.codex-<id>) and its models.",
				placeHolder: "work",
				ignoreFocusOut: true,
				validateInput: value => {
					const normalized = value.trim().toLowerCase();
					if (!normalized) {
						return "Enter an id, for example work";
					}
					if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalized)) {
						return "Use lowercase letters, digits, - or _ (up to 32 characters), starting with a letter or digit";
					}
					if (used.has(normalized)) {
						return `An account with the id "${normalized}" already exists`;
					}
					return undefined;
				},
			});
			if (!id?.trim()) {
				return;
			}
			const accountId = id.trim().toLowerCase();
			const label = await vscode.window.showInputBox({
				title: "SubHarness: Add Codex Account",
				prompt: "Name shown in Quick Access and in the model picker",
				value: accountId,
				ignoreFocusOut: true,
			});
			if (label === undefined) {
				return;
			}
			const entries = rawCodexAccounts();
			entries.push({ id: accountId, label: label.trim() || accountId });
			await vscode.workspace.getConfiguration(CONFIG_SECTION)
				.update("codexAccounts", entries, vscode.ConfigurationTarget.Global);
			// The new subscription becomes the active one: subagents try it first, status commands use it.
			await vscode.workspace.getConfiguration(CONFIG_SECTION)
				.update("codexActiveAccount", accountId, vscode.ConfigurationTarget.Global);
			// Providers are created at activation, so the sign-in runs after the reload.
			await context.globalState.update(CODEX_PENDING_SIGN_IN_KEY, accountId);
			logService.log("codex.account.added", { account: accountId });
			await offerReload(
				`Codex account "${label.trim() || accountId}" added and selected. Reload the window to finish; the ChatGPT sign-in page opens by itself.`
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.removeCodexAccount", async (arg?: { accountId?: string } | string) => {
			const requested = typeof arg === "string" ? arg : arg?.accountId;
			const account = findCodexAccount(codexAccounts, requested);
			if (!account || !account.id) {
				vscode.window.showInformationMessage("The built-in Codex account cannot be removed.");
				return;
			}
			const confirmed = await vscode.window.showWarningMessage(
				`Remove the Codex account "${account.label}"? Its folder and login stay on disk; adding the same id again restores them.`,
				{ modal: true },
				"Remove"
			);
			if (confirmed !== "Remove") {
				return;
			}
			const entries = rawCodexAccounts().filter(entry => String(entry.id ?? "").trim().toLowerCase() !== account.id);
			await vscode.workspace.getConfiguration(CONFIG_SECTION)
				.update("codexAccounts", entries, vscode.ConfigurationTarget.Global);
			if (activeCodexAccountId() === account.id) {
				// Never leave the active account pointing at an account that no longer exists.
				await vscode.workspace.getConfiguration(CONFIG_SECTION)
					.update("codexActiveAccount", CODEX_DEFAULT_ACCOUNT_ID, vscode.ConfigurationTarget.Global);
			}
			logService.log("codex.account.removed", { account: account.id });
			await offerReload(`Codex account "${account.label}" removed. Reload the window to finish.`);
		})
	);

	const claudeProviderFor = (accountId: unknown): ClaudeChatModelProvider => {
		const account = findClaudeAccount(claudeAccounts, accountId);
		return (account && claudeProviders.get(account.id)) || activeClaude();
	};
	const refreshAllClaudeCatalogs = (): void => {
		for (const provider of claudeProviders.values()) {
			provider.refreshLanguageModelChatInformation();
		}
	};
	const setActiveClaudeAccount = async (accountId: unknown): Promise<void> => {
		const account = findClaudeAccount(claudeAccounts, accountId);
		if (!account) {
			return;
		}
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		await config.update("claudeActiveAccount", account.id, vscode.ConfigurationTarget.Global);
		// Re-announce catalogs so subagents try the active account first.
		refreshAllClaudeCatalogs();
		quickActionsProvider.refresh();
		const provider = claudeProviders.get(account.id);
		await provider?.refreshStatus().catch(error => logService.logError("claude.switch_status.failed", error));
		vscode.window.showInformationMessage(`Claude account: ${account.label}. Subagents try it first, and Quick Access shows its usage.`);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.selectClaudeAccount", async (arg?: { accountId?: string } | string) => {
			const requested = typeof arg === "string" ? arg : arg?.accountId;
			if (requested !== undefined) {
				await setActiveClaudeAccount(requested);
				return;
			}
			const active = activeClaudeAccountId();
			const picked = await vscode.window.showQuickPick(claudeAccounts.map(account => ({
				label: `${account.id === active ? "$(check) " : ""}${account.label}`,
				description: account.configDir ?? "~/.claude",
				detail: claudeProviders.get(account.id)?.accountSummary,
				accountId: account.id,
			})), { title: "SubHarness: Claude Account", placeHolder: "Choose the Claude subscription used by the model picker" });
			if (picked) {
				await setActiveClaudeAccount(picked.accountId);
			}
		})
	);

	/** Raw entries stay in the stored order; the resolved list only feeds the runtime. */
	const rawClaudeAccounts = (): Array<Record<string, unknown>> => {
		const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>("claudeAccounts", []);
		return Array.isArray(raw)
			? raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
			: [];
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.addClaudeAccount", async () => {
			const used = new Set(claudeAccounts.map(account => account.id).filter(id => id !== CLAUDE_DEFAULT_ACCOUNT_ID));
			const id = await vscode.window.showInputBox({
				title: "SubHarness: Add Claude Account",
				prompt: "Short id for the second Claude subscription. It names the Claude config folder (~/.claude-<id>) and its models.",
				placeHolder: "work",
				ignoreFocusOut: true,
				validateInput: value => {
					const normalized = value.trim().toLowerCase();
					if (!normalized) {
						return "Enter an id, for example work";
					}
					if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalized)) {
						return "Use lowercase letters, digits, - or _ (up to 32 characters), starting with a letter or digit";
					}
					if (used.has(normalized)) {
						return `An account with the id "${normalized}" already exists`;
					}
					return undefined;
				},
			});
			if (!id?.trim()) {
				return;
			}
			const accountId = id.trim().toLowerCase();
			const label = await vscode.window.showInputBox({
				title: "SubHarness: Add Claude Account",
				prompt: "Name shown in Quick Access and in the model picker",
				value: accountId,
				ignoreFocusOut: true,
			});
			if (label === undefined) {
				return;
			}
			const entries = rawClaudeAccounts();
			entries.push({ id: accountId, label: label.trim() || accountId });
			await vscode.workspace.getConfiguration(CONFIG_SECTION)
				.update("claudeAccounts", entries, vscode.ConfigurationTarget.Global);
			// The new subscription becomes the active one: subagents try it first, status commands use it.
			await vscode.workspace.getConfiguration(CONFIG_SECTION)
				.update("claudeActiveAccount", accountId, vscode.ConfigurationTarget.Global);
			// Providers are created at activation, so the sign-in runs after the reload.
			await context.globalState.update(CLAUDE_PENDING_SIGN_IN_KEY, accountId);
			logService.log("claude.account.added", { account: accountId });
			await offerReload(
				`Claude account "${label.trim() || accountId}" added and selected. Reload the window to finish; the Claude sign-in page opens by itself.`
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.removeClaudeAccount", async (arg?: { accountId?: string } | string) => {
			const requested = typeof arg === "string" ? arg : arg?.accountId;
			const account = findClaudeAccount(claudeAccounts, requested);
			if (!account || !account.id) {
				vscode.window.showInformationMessage("The built-in Claude account cannot be removed.");
				return;
			}
			const confirmed = await vscode.window.showWarningMessage(
				`Remove the Claude account "${account.label}"? Its config folder and login stay on disk; adding the same id again restores them. Its stored chat sessions are cleared.`,
				{ modal: true },
				"Remove"
			);
			if (confirmed !== "Remove") {
				return;
			}
			const entries = rawClaudeAccounts().filter(entry => String(entry.id ?? "").trim().toLowerCase() !== account.id);
			await vscode.workspace.getConfiguration(CONFIG_SECTION)
				.update("claudeAccounts", entries, vscode.ConfigurationTarget.Global);
			if (activeClaudeAccountId() === account.id) {
				// Never leave the active account pointing at an account that no longer exists.
				await vscode.workspace.getConfiguration(CONFIG_SECTION)
					.update("claudeActiveAccount", CLAUDE_DEFAULT_ACCOUNT_ID, vscode.ConfigurationTarget.Global);
			}
			// The config directory (and with it the login) is never deleted; only the stored chat sessions go.
			await clearPersistedClaudeSessionState(context.workspaceState, logService, account.id);
			logService.log("claude.account.removed", { account: account.id });
			await offerReload(`Claude account "${account.label}" removed. Reload the window to finish.`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.claudeAccountSignIn", async (arg?: { accountId?: string } | string) => {
			const requested = typeof arg === "string" ? arg : arg?.accountId;
			const account = findClaudeAccount(claudeAccounts, requested);
			if (!account) {
				await vscode.commands.executeCommand("llamacpp.claudeSignIn");
				return;
			}
			try {
				if (!await ensureClaudeRuntime()) {
					return;
				}
				await claudeProviderFor(account.id).signIn();
				quickActionsProvider.refresh();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to sign in to Claude (${account.label}): ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.claudeAccountSignOut", async (arg?: { accountId?: string } | string) => {
			const requested = typeof arg === "string" ? arg : arg?.accountId;
			const account = findClaudeAccount(claudeAccounts, requested);
			if (!account) {
				await vscode.commands.executeCommand("llamacpp.claudeSignOut");
				return;
			}
			const confirmed = await vscode.window.showWarningMessage(
				account.id
					? `Sign out of the Claude account "${account.label}"? The other accounts stay signed in.`
					: "Sign out of the built-in Claude account? This signs Claude Code out on this computer, the Claude Code extension included.",
				{ modal: true },
				"Sign Out"
			);
			if (confirmed !== "Sign Out") {
				return;
			}
			try {
				await claudeProviderFor(account.id).signOut();
				quickActionsProvider.refresh();
				vscode.window.showInformationMessage(`Claude account ${account.label} signed out.`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to sign out of Claude (${account.label}): ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleCodexSubscription", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const next = config.get<boolean>("enableCodexSubscription", true) === false;
			await config.update("enableCodexSubscription", next, vscode.ConfigurationTarget.Global);
			refreshAllCodexCatalogs();
			for (const provider of codexProviders.values()) {
				await provider.refreshStatus();
			}
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
			for (const provider of codexProviders.values()) {
				provider.refreshCodexCacheKeepAliveStatus();
			}
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
			for (const provider of codexProviders.values()) {
				provider.refreshCodexCacheKeepAliveStatus();
			}
			vscode.window.showInformationMessage(
				`Codex cache keep-alive usage-limit pause ${next ? "ignored" : "respected"}.`
			);
		})
	);

	/** Downloads the Codex CLI from npm with a cancellable progress notification; true when one is ready. */
	const installCodexCliWithProgress = async (): Promise<boolean> => {
		const root = codexCliStorage();
		if (!root) {
			return false;
		}
		const previous = installedCodexCliPath(root);
		const wasInUse = previous !== undefined && resolveCodexCliPath() === previous;
		const controller = new AbortController();
		try {
			const outcome = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "Codex CLI",
				cancellable: true,
			}, async (progress, token) => {
				token.onCancellationRequested(() => controller.abort());
				progress.report({ message: "Looking up the latest version…" });
				const latest = await latestCodexCliVersion({ signal: controller.signal });
				if (previous && installedCodexCliVersion(root) === latest) {
					return { version: latest, upToDate: true };
				}
				let shown = 0;
				const result = await installCodexCli({
					root,
					version: latest,
					signal: controller.signal,
					log: (event, data) => logService.log(event, data),
					onProgress: (received, total) => {
						if (!total) {
							return;
						}
						const percent = Math.floor(received / total * 100);
						if (percent > shown) {
							progress.report({ increment: percent - shown, message: percent < 100 ? `Downloading ${latest}… ${percent}%` : "Unpacking…" });
							shown = percent;
						}
					},
				});
				return { version: result.version, upToDate: false };
			});
			if (outcome.upToDate) {
				vscode.window.showInformationMessage(`Codex CLI ${outcome.version} is up to date.`);
				return true;
			}
			vscode.window.showInformationMessage(wasInUse
				? `Codex CLI ${outcome.version} installed. Reload the window to switch to it.`
				: `Codex CLI ${outcome.version} installed.`);
			for (const provider of codexProviders.values()) {
				void provider.refreshStatus();
			}
			refreshAllCodexCatalogs();
			quickActionsProvider.refresh();
			return true;
		} catch (error) {
			if (controller.signal.aborted) {
				return false;
			}
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Unable to install the Codex CLI: ${message}`);
			return false;
		}
	};
	/** Without a CLI nothing can sign in: offer the download first. */
	const ensureCodexCli = async (provider: CodexChatModelProvider): Promise<boolean> => {
		if (provider.cliAvailable) {
			return true;
		}
		const choice = await vscode.window.showWarningMessage(
			"The Codex CLI was not found. Download it from npm? About 185 MB to download and 530 MB on disk, kept in the extension's storage.",
			{ modal: true },
			"Download"
		);
		return choice === "Download" && await installCodexCliWithProgress();
	};
	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.codexInstallCli", () => installCodexCliWithProgress())
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.codexSignIn", async () => {
			try {
				if (!await ensureCodexCli(activeCodex())) {
					return;
				}
				await activeCodex().signIn();
				quickActionsProvider.refresh();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to sign in to Codex: ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.codexAccountSignIn", async (arg?: { accountId?: string } | string) => {
			const requested = typeof arg === "string" ? arg : arg?.accountId;
			const account = findCodexAccount(codexAccounts, requested);
			if (!account) {
				await vscode.commands.executeCommand("llamacpp.codexSignIn");
				return;
			}
			try {
				if (!await ensureCodexCli(codexProviderFor(account.id))) {
					return;
				}
				await codexProviderFor(account.id).signIn();
				quickActionsProvider.refresh();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to sign in to Codex (${account.label}): ${message}`);
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
				await activeCodex().signOut();
				quickActionsProvider.refresh();
				vscode.window.showInformationMessage("Codex signed out.");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to sign out of Codex: ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.codexAccountSignOut", async (arg?: { accountId?: string } | string) => {
			const requested = typeof arg === "string" ? arg : arg?.accountId;
			const account = findCodexAccount(codexAccounts, requested);
			if (!account) {
				await vscode.commands.executeCommand("llamacpp.codexSignOut");
				return;
			}
			const confirmed = await vscode.window.showWarningMessage(
				account.id
					? `Sign out of the Codex account "${account.label}"? The other accounts stay signed in.`
					: "Sign out of the built-in Codex account? This also signs out the shared local Codex CLI session.",
				{ modal: true },
				"Sign Out"
			);
			if (confirmed !== "Sign Out") {
				return;
			}
			try {
				await codexProviderFor(account.id).signOut();
				quickActionsProvider.refresh();
				vscode.window.showInformationMessage(`Codex account ${account.label} signed out.`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to sign out of Codex (${account.label}): ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.codexShowStatus", async () => {
			try {
				await activeCodex().showStatus();
				quickActionsProvider.refresh();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to read Codex status: ${message}`);
			}
		})
	);

	let claudeRuntimeInstall: Promise<boolean> | undefined;
	/** Downloads the runtime for the exact installed Agent SDK version; true when one is ready. */
	const installClaudeRuntimeWithProgress = (): Promise<boolean> => {
		if (claudeRuntimeInstall) {
			return claudeRuntimeInstall;
		}
		const attempt = async (): Promise<boolean> => {
			const root = claudeRuntimeStorage();
			const version = installedClaudeSdkVersion();
			const target = claudeRuntimeTarget();
			if (!root || !version || !target) {
				const error = new Error("The Claude runtime is not available for this platform.");
				logService.logError("claude.runtime_install.failed", error);
				vscode.window.showErrorMessage(`Unable to install the Claude runtime: ${error.message}`);
				return false;
			}
			if (installedClaudeRuntimePath(root, version)) {
				vscode.window.showInformationMessage(`Claude runtime ${version} is already installed.`);
				return true;
			}
			const previous = resolveClaudeCodeBinary();
			const keepVersions = [...new Set([
				downloadedClaudeRuntimeVersionForPath(root, previous),
				latestInstalledClaudeRuntime(root)?.version,
			].filter((value): value is string => Boolean(value)))].filter(value => value !== version);
			const controller = new AbortController();
			try {
				await vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: "Claude runtime",
					cancellable: true,
				}, async (progress, token) => {
					token.onCancellationRequested(() => controller.abort());
					progress.report({ message: `Downloading ${version}…` });
					let shown = 0;
					await installClaudeRuntime({
						root,
						version,
						target,
						keepVersions,
						signal: controller.signal,
						log: (event, data) => logService.log(event, data),
						onProgress: (received, total) => {
							if (total) {
								const percent = Math.floor(received / total * 100);
								if (percent > shown) {
									progress.report({ increment: percent - shown, message: percent < 100 ? `Downloading ${version}… ${percent}%` : "Unpacking…" });
									shown = percent;
								}
								return;
							}
							progress.report({ message: `Downloading ${version}… ${Math.round(received / 1_000_000)} MB` });
						},
					});
				});
				invalidateClaudeCodeBinaryCache();
				refreshAllClaudeCatalogs();
				for (const provider of claudeProviders.values()) {
					void provider.refreshStatus();
				}
				quickActionsProvider.refresh();
				vscode.window.showInformationMessage(previous && resolveClaudeCodeBinary() !== previous
					? `Claude runtime ${version} installed. The next Claude request uses it.`
					: `Claude runtime ${version} installed.`);
				return true;
			} catch (error) {
				if (controller.signal.aborted) {
					return false;
				}
				logService.logError("claude.runtime_install.failed", error);
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to install the Claude runtime: ${message}`);
				return false;
			}
		};
		claudeRuntimeInstall = attempt().finally(() => {
			claudeRuntimeInstall = undefined;
		});
		return claudeRuntimeInstall;
	};
	/** Without a runtime nothing can sign in: offer the download first. */
	const ensureClaudeRuntime = async (): Promise<boolean> => {
		if (resolveClaudeCodeBinary()) {
			return true;
		}
		const choice = await vscode.window.showWarningMessage(
			`The Claude runtime was not found. Download it from npm? ${CLAUDE_RUNTIME_DOWNLOAD_ESTIMATE}, kept in the extension's storage.`,
			{ modal: true },
			"Download"
		);
		return choice === "Download" && await installClaudeRuntimeWithProgress();
	};
	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.claudeInstallRuntime", () => installClaudeRuntimeWithProgress())
	);

	// Existing Claude users get the runtime right after an update, without a prompt. It runs in
	// the background, after activation, and only once per window; a failure is not retried here.
	let claudeRuntimeAutoInstallAttempted = false;
	const claudeRuntimeTimer = setTimeout(() => {
		const root = claudeRuntimeStorage();
		const sdkVersion = installedClaudeSdkVersion();
		const enabled = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("enableClaudeSubscription", true) !== false;
		if (!shouldAutoInstallClaudeRuntime({
			enabled,
			signedIn: claudeAccounts.some(account => hasClaudeLogin(account)),
			sdkVersion,
			target: claudeRuntimeTarget(),
			root,
			preferredBinary: resolvePreferredClaudeCodeBinary(),
			exactRuntime: installedClaudeRuntimePath(root, sdkVersion),
			attempted: claudeRuntimeAutoInstallAttempted,
		})) {
			return;
		}
		claudeRuntimeAutoInstallAttempted = true;
		void installClaudeRuntimeWithProgress();
	}, 5_000);
	claudeRuntimeTimer.unref?.();
	context.subscriptions.push({ dispose: () => clearTimeout(claudeRuntimeTimer) });

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleClaudeSubscription", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const next = config.get<boolean>("enableClaudeSubscription", true) === false;
			await config.update("enableClaudeSubscription", next, vscode.ConfigurationTarget.Global);
			refreshAllClaudeCatalogs();
			for (const provider of claudeProviders.values()) {
				await provider.refreshStatus();
			}
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
			for (const provider of claudeProviders.values()) {
				provider.refreshCacheKeepAliveStatus();
			}
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
			for (const provider of claudeProviders.values()) {
				provider.refreshCacheKeepAliveStatus();
			}
			vscode.window.showInformationMessage(
				`Claude cache keep-alive usage-limit pause ${next ? "ignored" : "respected"}.`
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.claudeSignIn", async () => {
			try {
				if (!await ensureClaudeRuntime()) {
					return;
				}
				await activeClaude().signIn();
				quickActionsProvider.refresh();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to sign in to Claude: ${message}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.claudeSignOut", async () => {
			const account = activeClaude().account;
			const confirmed = await vscode.window.showWarningMessage(
				account.id
					? `Sign out of the Claude account "${account.label}"? The other accounts stay signed in.`
					: "Sign out of Claude? This signs Claude Code out on this computer, the Claude Code extension included.",
				{ modal: true },
				"Sign Out"
			);
			if (confirmed !== "Sign Out") {
				return;
			}
			try {
				await activeClaude().signOut();
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
				await activeClaude().showStatus();
				quickActionsProvider.refresh();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Unable to read Claude status: ${message}`);
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
						vscode.window.showErrorMessage(
							`DeepSeek key check failed (${response.status} ${response.statusText})`
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
		vscode.commands.registerCommand("llamacpp.memoryHealth", async () => {
			const report = memoryService.healthReport();
			const summary = (
				`Memory health: ${report.total} entries (${report.pinned} pinned, ${report.expired} expired), ` +
				`~${report.totalTokens} tokens, avg ${report.averageChars} chars/entry.`
			);
			const details: string[] = [];
			if (report.longest.length > 0) {
				details.push(
					"Longest: " + report.longest
						.map(entry => `${entry.id} "${entry.title}" (${entry.chars} chars)`)
						.join("; ")
				);
			}
			if (report.duplicates.length > 0) {
				details.push(
					`Duplicate candidates (${report.duplicates.length}): ` + report.duplicates
						.map(pair => `${pair.a} ↔ ${pair.b} (${(pair.similarity * 100).toFixed(0)}%)`)
						.join("; ")
				);
			}
			const action = await vscode.window.showWarningMessage(
				[summary, ...details].join("\n"),
				"Open Memory"
			);
			if (action === "Open Memory") {
				MemoryManagerPanel.createOrShow(context.extensionUri, memoryService);
			}
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
			providerDirectory.resetLocalProbeBackoff();
			void providerDirectory.recheck().catch(error =>
				logService.logError("providers.refresh_models_recheck.failed", error)
			);
			refreshAllCodexCatalogs();
			refreshAllClaudeCatalogs();
			cocoProvider.refreshLanguageModelChatInformation();
			// Also refreshes the DeepSeek balance and the usage windows Quick Access shows.
			void refreshProviderUsage(true);
			quickActionsProvider.refresh();
			vscode.window.showInformationMessage("Local, DeepSeek, Codex, Claude, and Coco models refreshed.");
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
					refreshAllCodexCatalogs();
					for (const provider of codexProviders.values()) {
						void provider.refreshStatus();
					}
				}
				if (event.affectsConfiguration("llamacpp.codexAccounts")) {
					// Provider instances and their registry entries are created at activation.
					void vscode.window.showInformationMessage("Reload the window to apply the updated Codex account list.");
				}
				if (event.affectsConfiguration("llamacpp.codexActiveAccount")) {
					refreshAllCodexCatalogs();
					quickActionsProvider.refresh();
				}
				if (event.affectsConfiguration("llamacpp.claudeAccounts")) {
					// Provider instances and their registry entries are created at activation.
					void vscode.window.showInformationMessage("Reload the window to apply the updated Claude account list.");
				}
				if (event.affectsConfiguration("llamacpp.claudeActiveAccount")) {
					refreshAllClaudeCatalogs();
					quickActionsProvider.refresh();
				}
				if (
					event.affectsConfiguration("llamacpp.enableClaudeSubscription") ||
					event.affectsConfiguration("llamacpp.claudeContextLength") ||
					event.affectsConfiguration("llamacpp.claudeMaxOutputTokens") ||
					event.affectsConfiguration("llamacpp.claudeReasoningEffort")
				) {
					refreshAllClaudeCatalogs();
					for (const provider of claudeProviders.values()) {
						void provider.refreshStatus();
					}
				}
				if (
					event.affectsConfiguration("llamacpp.enableCoco") ||
					event.affectsConfiguration("llamacpp.cocoCliPath") ||
					event.affectsConfiguration("llamacpp.cocoConnection") ||
					event.affectsConfiguration("llamacpp.cocoTransport") ||
					event.affectsConfiguration("llamacpp.cocoContextLength")
				) {
					cocoProvider.refreshLanguageModelChatInformation();
					void cocoProvider.refreshStatus();
				}
				if (
					event.affectsConfiguration("llamacpp.sharedContextLength") ||
					event.affectsConfiguration("llamacpp.sharedContextFollowCodex") ||
					event.affectsConfiguration("llamacpp.codexWorkingContextTarget")
				) {
					// One working context for Codex, Claude, Coco and Cursor.
					llamaProvider.notifyModelLimitsChanged();
					refreshAllCodexCatalogs();
					for (const provider of claudeProviders.values()) {
						provider.refreshLanguageModelChatInformation();
					}
					cocoProvider.refreshLanguageModelChatInformation();
				}
				if (
					event.affectsConfiguration("llamacpp.claudeCacheKeepAliveEnabled") ||
					event.affectsConfiguration("llamacpp.claudeCacheKeepAliveMs") ||
					event.affectsConfiguration("llamacpp.claudeCacheKeepAliveMaxIdleMs") ||
					event.affectsConfiguration("llamacpp.claudeCacheKeepAliveIgnoreUsageLimit")
				) {
					quickActionsProvider.refresh();
					for (const provider of claudeProviders.values()) {
						provider.refreshCacheKeepAliveStatus();
					}
				}
				if (
					event.affectsConfiguration("llamacpp.enableLocalServer") ||
					event.affectsConfiguration("llamacpp.localServerUrl") ||
					event.affectsConfiguration("llamacpp.enableDeepSeek") ||
					event.affectsConfiguration("llamacpp.serverUrl") ||
					event.affectsConfiguration("llamacpp.enableCodexSubscription") ||
					event.affectsConfiguration("llamacpp.enableClaudeSubscription")
				) {
					if (
						event.affectsConfiguration("llamacpp.enableLocalServer") ||
						event.affectsConfiguration("llamacpp.localServerUrl")
					) {
						providerDirectory.resetLocalProbeBackoff();
					}
					void providerDirectory.recheck();
				}
				if (
					event.affectsConfiguration("llamacpp.codexCacheKeepAliveEnabled") ||
					event.affectsConfiguration("llamacpp.codexCacheKeepAliveMs") ||
					event.affectsConfiguration("llamacpp.codexCacheKeepAliveIgnoreUsageLimit")
				) {
					quickActionsProvider.refresh();
					for (const provider of codexProviders.values()) {
						provider.refreshCodexCacheKeepAliveStatus();
					}
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
