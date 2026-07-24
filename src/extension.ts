
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
import { renderProviderHealthMarkdown } from "./diagnostics/provider-health";
import { SessionQualityTracker } from "./diagnostics/session-report";
import { SharedMemoryService } from "./memory/shared-memory-service";
import { registerMemoryTools } from "./memory/tools";
import { registerModelBehaviorCommands } from "./ui/model-behavior-commands";
import { LlamaQuickActionsProvider } from "./ui/quick-access";
import { CodexChatModelProvider } from "./codex/codex-provider";
import { ClaudeChatModelProvider } from "./claude/claude-provider";
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

	// Llama.cpp Provider
	const llamaProvider = new LlamaCppChatModelProvider(context.secrets, ua, logService, memoryService);
	const codexProvider = new CodexChatModelProvider(extVersion, logService);
	const claudeProvider = new ClaudeChatModelProvider(extVersion, logService);
	context.subscriptions.push(codexProvider);
	context.subscriptions.push(claudeProvider);
	const compositeProvider = new CompositeChatModelProvider(llamaProvider, codexProvider, claudeProvider);
	context.subscriptions.push(compositeProvider);
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(PROVIDER_VENDOR, compositeProvider));
	let lastThroughput: string | undefined;
	let lastPromptCache: string | undefined;
	let lastContextUsage: ContextUsageDisplay | undefined;
	let lastHealthStatus: string | undefined;
	const runtimeMetrics = new Map<RuntimeSource, ProviderRuntimeMetrics>();
	const quickActionsProvider = new LlamaQuickActionsProvider(
		() => lastThroughput,
		() => lastContextUsage,
		() => memoryService.count,
		() => lastPromptCache,
		() => sessionQuality.count === 0 ? "No turns" : `${sessionQuality.count} turns / cache ${sessionQuality.summary.cacheHitPercent ?? "n/a"}%`,
		() => lastHealthStatus,
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
		() => usageExperiments.summary
	);
	context.subscriptions.push(vscode.window.registerTreeDataProvider("llamacpp-quick-actions", quickActionsProvider));
	context.subscriptions.push(memoryService.onDidChange(() => quickActionsProvider.refresh()));
	context.subscriptions.push(tokenUsageHistory.onDidChange(() => quickActionsProvider.refresh()));
	context.subscriptions.push(usageExperiments.onDidChange(() => quickActionsProvider.refresh()));
	context.subscriptions.push(codexProvider.onDidChangeStatus(() => quickActionsProvider.refresh()));
	context.subscriptions.push(claudeProvider.onDidChangeStatus(() => quickActionsProvider.refresh()));
	context.subscriptions.push(codexProvider.onDidRecordUsage(usage => {
		recordUsage({
			provider: "codex",
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cachedInputTokens: usage.cachedInputTokens,
			reasoningOutputTokens: usage.reasoningOutputTokens,
		}, usage.modelId);
	}));
	context.subscriptions.push(claudeProvider.onDidRecordUsage(usage => {
		recordUsage({
			provider: "claude",
			inputTokens: usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
			outputTokens: usage.outputTokens,
			cachedInputTokens: usage.cacheReadInputTokens,
			cacheWriteInputTokens: usage.cacheCreationInputTokens,
			modelTurns: usage.modelTurns,
			durationMs: usage.durationMs,
		}, usage.modelId);
	}));
	context.subscriptions.push(...registerModelBehaviorCommands(() => quickActionsProvider.refresh()));
	llamaProvider.refreshLanguageModelChatInformation();
	codexProvider.refreshLanguageModelChatInformation();
	claudeProvider.refreshLanguageModelChatInformation();
	void codexProvider.refreshStatus().catch(error => logService.logError("codex.initial_status.failed", error));
	void claudeProvider.refreshStatus().catch(error => logService.logError("claude.initial_status.failed", error));

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

	const writeReport = async (baseName: string, markdown: string, json: unknown): Promise<string> => {
		const reportDirectory = path.join(context.globalStorageUri.fsPath, "reports");
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
				lastHealthStatus = report.overallStatus.toUpperCase();
				await writeReport("provider-health", renderProviderHealthMarkdown(report), report);
				quickActionsProvider.refresh();
				vscode.window.showInformationMessage(`Local LLM health check: ${lastHealthStatus}`);
			} finally {
				cancellation.dispose();
			}
		}),
		vscode.commands.registerCommand("llamacpp.openSessionReport", async () => {
			const payload = sessionQuality.toJSON();
			await writeReport(
				"session-quality",
				sessionQuality.renderMarkdown(extVersion, vscodeVersion),
				payload
			);
		}),
		vscode.commands.registerCommand("llamacpp.resetSessionReport", async () => {
			sessionQuality.clear();
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
			await config.update("deepSeekDefaultMaxOutputTokens", 65536, vscode.ConfigurationTarget.Global);
			await config.update("toolResultMode", "auto", vscode.ConfigurationTarget.Global);
			await config.update("autoCompact", true, vscode.ConfigurationTarget.Global);
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
		vscode.commands.registerCommand("llamacpp.openMemory", async () => {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(memoryService.filePath));
			await vscode.window.showTextDocument(document, { preview: false });
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
