import * as vscode from "vscode";

import type { ProviderState } from "../providers/provider-directory";
import { CONFIG_SECTION, DEFAULT_LOCAL_REASONING_BUDGET, DEFAULT_SERVER_URL } from "../constants";
import {
	DEFAULT_COMPACTION_TARGET_RATIO,
	normalizeCompactionTargetRatio,
} from "../context/context-budget";
import {
	getCopilotPatchStatus,
	findCopilotBundle,
} from "../copilot-patch";
import {
	formatProviderCache,
	formatCompactTokenCount,
	formatProviderContext,
	formatProviderTokens,
	type ProviderRuntimeMetrics,
} from "../provider-metrics";
import { normalizeThinkingMode, resolveReasoningBudget } from "../reasoning";
import {
	formatDeepSeekPeakEffectiveLocal,
	resolveDeepSeekPricingSnapshot,
} from "../deepseek-peak-hours";
import type { SubagentModelProfile } from "../subagent-guidance";
import {
	emptyTokenUsageHistorySummary,
	TOKEN_USAGE_PROVIDERS,
	tokenUsageCacheHitPercent,
	type TokenUsageAggregate,
	type TokenUsageHistorySummary,
	type TokenUsageProvider,
} from "../token-usage-history";
import {
	emptyUsageExperimentSummary,
	type ExperimentRun,
	type ExperimentSummary,
} from "../usage-experiment";

export interface QuickAccessContextUsage {
	summary: string;
	breakdown: string;
}

export interface QuickAccessUsageLimit {
	id: string;
	label: string;
	description: string;
}

export interface QuickAccessApiProviderSummary {
	total: number;
	enabled: number;
}

interface QuickAccessItemOptions {
	description?: string;
	command?: vscode.Command;
	icon?: vscode.ThemeIcon;
	tooltip?: string;
	children?: QuickAccessItem[];
	expanded?: boolean;
}

export class QuickAccessItem extends vscode.TreeItem {
	readonly children?: QuickAccessItem[];

	constructor(id: string, label: string, options: QuickAccessItemOptions = {}) {
		super(
			label,
			options.children
				? options.expanded
					? vscode.TreeItemCollapsibleState.Expanded
					: vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None
		);
		this.id = `llamacpp.quickAccess.${id}`;
		this.description = options.description;
		this.command = options.command;
		this.iconPath = options.icon;
		this.tooltip = options.tooltip;
		this.children = options.children;
		this.contextValue = options.children ? "llamacpp.quickAccessGroup" : "llamacpp.quickAction";
	}
}

function command(command: string, title: string): vscode.Command {
	return { command, title };
}

function toggleIcon(enabled: boolean): vscode.ThemeIcon {
	return new vscode.ThemeIcon(
		enabled ? "pass-filled" : "circle-slash",
		new vscode.ThemeColor(enabled ? "testing.iconPassed" : "disabledForeground")
	);
}

function runtimeMetricItems(
	id: string,
	metrics: ProviderRuntimeMetrics | undefined,
	openCommand: vscode.Command
): QuickAccessItem[] {
	const running = metrics?.phase === "running";
	const precision = metrics?.estimated ? "Estimated live values; replaced by exact app-server usage at the next segment boundary" : "Exact provider-reported values";
	const items = [
		new QuickAccessItem(`${id}.tokens`, running ? "Tokens (live)" : "Tokens (last)", {
			description: formatProviderTokens(metrics),
			tooltip: running ? `Input and output tokens for the active request. ${precision}` : "Input and output tokens for the last completed request",
			icon: new vscode.ThemeIcon("symbol-numeric"),
			command: openCommand,
		}),
		new QuickAccessItem(`${id}.cache`, "Prompt Cache", {
			description: formatProviderCache(metrics),
			tooltip: running ? `Cache-read tokens for the active request. ${precision}` : "Cache-read tokens divided by input tokens for the last completed request",
			icon: new vscode.ThemeIcon("database"),
			command: openCommand,
		}),
		new QuickAccessItem(`${id}.context`, "Context", {
			description: formatProviderContext(metrics),
			tooltip: [metrics?.contextDetail, running ? precision : undefined]
				.filter((value): value is string => Boolean(value))
				.join(". ") || "Current context usage and the provider-reported model window",
			icon: new vscode.ThemeIcon("pie-chart"),
			command: openCommand,
		}),
	];
	if (metrics?.throughputTokensPerSecond !== undefined) {
		items.push(new QuickAccessItem(`${id}.throughput`, "Throughput", {
			description: `${metrics.throughputTokensPerSecond.toFixed(1)} tok/s`,
			icon: new vscode.ThemeIcon("dashboard"),
			command: openCommand,
		}));
	}
	return items;
}

function formatUsageDuration(durationMs: number): string {
	if (durationMs < 1_000) {
		return `${durationMs} ms`;
	}
	if (durationMs < 60_000) {
		return `${(durationMs / 1_000).toFixed(1)} s`;
	}
	return `${(durationMs / 60_000).toFixed(1)} min`;
}

function formatUsageHeadline(usage: TokenUsageAggregate): string {
	if (usage.requests === 0) {
		return "No data yet";
	}
	const cacheHit = tokenUsageCacheHitPercent(usage);
	const uncached = Math.max(0, usage.cacheEligibleInputTokens - usage.cachedInputTokens);
	return `${formatCompactTokenCount(usage.inputTokens)} in · ${formatCompactTokenCount(usage.outputTokens)} out · cache ${cacheHit === undefined ? "n/a" : `${cacheHit.toFixed(1)}%`}${cacheHit === undefined ? "" : ` · ${formatCompactTokenCount(uncached)} uncached`}`;
}

function usagePeriodItem(id: string, label: string, usage: TokenUsageAggregate): QuickAccessItem {
	const children = [
		new QuickAccessItem(`${id}.requests`, "Requests", {
			description: `${usage.requests}${usage.estimatedRequests > 0 ? ` · ${usage.estimatedRequests} estimated` : ""}`,
			tooltip: "Completed provider requests recorded by this extension",
			icon: new vscode.ThemeIcon("list-numbered"),
		}),
		new QuickAccessItem(`${id}.input`, "Input Tokens", {
			description: formatCompactTokenCount(usage.inputTokens),
			icon: new vscode.ThemeIcon("arrow-right"),
		}),
		new QuickAccessItem(`${id}.output`, "Output Tokens", {
			description: formatCompactTokenCount(usage.outputTokens),
			icon: new vscode.ThemeIcon("arrow-left"),
		}),
		new QuickAccessItem(`${id}.cache`, "Cache Hit", {
			description: usage.cacheReportedRequests > 0
				? `${tokenUsageCacheHitPercent(usage)?.toFixed(1) ?? "0.0"}% · ${formatCompactTokenCount(usage.cachedInputTokens)}/${formatCompactTokenCount(usage.cacheEligibleInputTokens)}`
				: "Not reported",
			tooltip: "Cache-read tokens divided by input tokens for requests where the provider reported cache telemetry",
			icon: new vscode.ThemeIcon("database"),
		}),
		new QuickAccessItem(`${id}.uncached`, "Uncached Input", {
			description: usage.cacheReportedRequests > 0
				? formatCompactTokenCount(Math.max(0, usage.cacheEligibleInputTokens - usage.cachedInputTokens))
				: "Not reported",
			tooltip: "Input tokens not served from the provider prompt cache",
			icon: new vscode.ThemeIcon("circle-outline"),
		}),
		new QuickAccessItem(`${id}.zeroCacheReads`, "Zero Cache Reads", {
			description: usage.cacheReportedRequests > 0
				? `${usage.zeroCacheReadRequests}/${usage.cacheReportedRequests}`
				: "Not reported",
			tooltip: "Completed requests where cache telemetry was reported but cached input was zero",
			icon: new vscode.ThemeIcon(usage.zeroCacheReadRequests > 0 ? "warning" : "pass"),
		}),
	];
	if (usage.cacheWriteInputTokens > 0) {
		children.push(new QuickAccessItem(`${id}.cacheWrites`, "Cache Writes", {
			description: formatCompactTokenCount(usage.cacheWriteInputTokens),
			tooltip: "Input tokens written to the provider prompt cache (reported by Claude)",
			icon: new vscode.ThemeIcon("save"),
		}));
	}
	if (usage.reasoningOutputTokens > 0) {
		children.push(new QuickAccessItem(`${id}.reasoning`, "Reasoning Output", {
			description: formatCompactTokenCount(usage.reasoningOutputTokens),
			icon: new vscode.ThemeIcon("lightbulb"),
		}));
	}
	if (usage.modelTurns > 0) {
		children.push(new QuickAccessItem(`${id}.turns`, "Model Turns", {
			description: String(usage.modelTurns),
			icon: new vscode.ThemeIcon("git-pull-request-go-to-changes"),
		}));
	}
	if (usage.durationMs > 0) {
		children.push(new QuickAccessItem(`${id}.duration`, "Provider Time", {
			description: formatUsageDuration(usage.durationMs),
			icon: new vscode.ThemeIcon("clock"),
		}));
	}
	return new QuickAccessItem(id, label, {
		description: formatUsageHeadline(usage),
		icon: new vscode.ThemeIcon(label === "Today" ? "calendar" : "history"),
		children,
	});
}

function usageProviderItem(
	provider: TokenUsageProvider,
	label: string,
	usage: TokenUsageHistorySummary,
	metrics: ProviderRuntimeMetrics | undefined,
	openCommand: vscode.Command,
	sessionSummary?: string,
	lastRequest?: string
): QuickAccessItem {
	const children = [
		usagePeriodItem(`usage.${provider}.today`, "Today", usage.today.providers[provider]),
		usagePeriodItem(`usage.${provider}.week`, "Last 7 Days", usage.week.providers[provider]),
		new QuickAccessItem(`usage.${provider}.current`, metrics?.phase === "running" ? "Current Request" : "Last Request", {
			description: formatProviderTokens(metrics),
			icon: new vscode.ThemeIcon("pulse"),
			children: runtimeMetricItems(`usage.${provider}.current`, metrics, openCommand),
		}),
	];
	if (sessionSummary) {
		children.push(new QuickAccessItem(`usage.${provider}.session`, "Current VS Code Session", {
			description: sessionSummary,
			tooltip: lastRequest ? `Last request: ${lastRequest}` : undefined,
			icon: new vscode.ThemeIcon("graph"),
		}));
	}
	return new QuickAccessItem(`usage.${provider}`, label, {
		description: formatUsageHeadline(usage.today.providers[provider]),
		icon: new vscode.ThemeIcon(provider === "local" ? "vm" : provider === "codex" ? "hubot" : provider === "claude" ? "sparkle" : "cloud"),
		children,
	});
}

const usageProviderLabels: Record<TokenUsageProvider, string> = {
	local: "Local / Qwen",
	deepseek: "DeepSeek",
	codex: "Codex",
	claude: "Claude",
};

function formatExperimentSavings(value: number | undefined): string {
	if (value === undefined) {
		return "n/a";
	}
	return value >= 0 ? `${value.toFixed(1)}% saved` : `${Math.abs(value).toFixed(1)}% more`;
}

function experimentRunItem(id: string, label: string, run: ExperimentRun): QuickAccessItem {
	const codex = run.providers.codex;
	const providerItems = TOKEN_USAGE_PROVIDERS
		.filter(provider => run.providers[provider]?.requests > 0)
		.map(provider => usagePeriodItem(`${id}.${provider}`, usageProviderLabels[provider], run.providers[provider]));
	const modelItems = Object.entries(run.models)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([model, usage]) => new QuickAccessItem(`${id}.model.${model}`, model, {
			description: formatUsageHeadline(usage),
			tooltip: `${usage.requests} completed requests`,
			icon: new vscode.ThemeIcon("symbol-method"),
		}));
	return new QuickAccessItem(id, label, {
		description: codex ? `Codex ${formatCompactTokenCount(codex.inputTokens)} in · ${formatCompactTokenCount(codex.outputTokens)} out` : `${run.variant} · no Codex requests`,
		tooltip: `${run.label}\nStarted: ${new Date(run.startedAt).toLocaleString()}${run.stoppedAt ? `\nStopped: ${new Date(run.stoppedAt).toLocaleString()}` : ""}`,
		icon: new vscode.ThemeIcon(run.variant === "baseline" ? "beaker" : "organization"),
		children: [
			...providerItems,
			new QuickAccessItem(`${id}.models`, "Models", {
				description: `${modelItems.length} recorded`,
				icon: new vscode.ThemeIcon("list-tree"),
				children: modelItems.length > 0
					? modelItems
					: [new QuickAccessItem(`${id}.models.none`, "No model samples", { icon: new vscode.ThemeIcon("info") })],
			}),
		],
	});
}

export function formatEndpointLabel(value: string): string {
	try {
		const url = new URL(value);
		const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
		return `${url.host}${path}`;
	} catch {
		return value.length > 36 ? `${value.slice(0, 33)}...` : value;
	}
}

/**
 * One-line provider status with the live usage limit, e.g.
 * `Connected (Plus): 70% R:2.08 17:25`. The `R` is the window reset time in
 * `D.MM HH:MM` form so reset moments are visible without expanding the group.
 */
export function formatProviderUsageLine(
	status: string,
	percent: number | undefined,
	resetLabel: string | undefined
): string {
	if (percent === undefined) {
		return status;
	}
	return resetLabel
		? `${status}: ${percent}% R:${resetLabel}`
		: `${status}: ${percent}%`;
}

export class LlamaQuickActionsProvider implements vscode.TreeDataProvider<QuickAccessItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(
		private readonly getLastThroughput: () => string | undefined,
		private readonly getLastContextUsage: () => QuickAccessContextUsage | undefined,
		private readonly getMemoryCount: () => number,
		private readonly getLastPromptCache: () => string | undefined = () => undefined,
		private readonly getSessionSummary: () => string | undefined = () => undefined,

		private readonly getExpiredMemoryCount: () => number = () => 0,
		private readonly getCodexStatus: () => string | undefined = () => undefined,
		private readonly getClaudeStatus: () => string | undefined = () => undefined,
		private readonly getClaudeUsage: () => string | undefined = () => undefined,
		private readonly getClaudeLastRequest: () => string | undefined = () => undefined,
		private readonly getClaudeUsageLimits: () => readonly QuickAccessUsageLimit[] = () => [],
		private readonly getLocalMetrics: () => ProviderRuntimeMetrics | undefined = () => undefined,
		private readonly getDeepSeekMetrics: () => ProviderRuntimeMetrics | undefined = () => undefined,
		private readonly getCodexMetrics: () => ProviderRuntimeMetrics | undefined = () => undefined,
		private readonly getClaudeMetrics: () => ProviderRuntimeMetrics | undefined = () => undefined,
		private readonly getCodexSubscriptionUsage: () => string | undefined = () => undefined,
		private readonly getSubagentProfiles: () => readonly SubagentModelProfile[] = () => [],
		private readonly getTokenUsageHistory: () => TokenUsageHistorySummary = emptyTokenUsageHistorySummary,
		private readonly getUsageExperiments: () => ExperimentSummary = emptyUsageExperimentSummary,
		private readonly getDeepSeekBalance: () => string | undefined = () => undefined,
		private readonly getCodexUsageLimitPercent: () => number | undefined = () => undefined,
		private readonly getCodexUsageLimitReset: () => string | undefined = () => undefined,
		private readonly getClaudeUsageLimitPercent: () => number | undefined = () => undefined,
		private readonly getClaudeUsageLimitReset: () => string | undefined = () => undefined,
		private readonly getMemoryContextTokens: () => number = () => 0,
		private readonly getApiProviderSummary: () => QuickAccessApiProviderSummary = () => ({ total: 0, enabled: 0 }),
		private readonly getProviderState: (key: string) => ProviderState | undefined = () => undefined,
	) {}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: QuickAccessItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: QuickAccessItem): vscode.ProviderResult<QuickAccessItem[]> {
		if (element) {
			return element.children ?? [];
		}
		return this.buildRootItems();
	}

	private buildRootItems(): QuickAccessItem[] {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const serverUrl = String(config.get("serverUrl", DEFAULT_SERVER_URL) || DEFAULT_SERVER_URL);
		const localServerUrl = String(config.get("localServerUrl", DEFAULT_SERVER_URL) || DEFAULT_SERVER_URL);
		const localServerEnabled = config.get<boolean>("enableLocalServer", true) !== false;
		const deepSeekEnabled = config.get<boolean>("enableDeepSeek", true) !== false;
		const deepSeekCompactionSummary = config.get<boolean>("deepSeekCompactionSummary", false) === true;
		const compactionTargetRatio = normalizeCompactionTargetRatio(
			config.get("compactionTargetRatio", DEFAULT_COMPACTION_TARGET_RATIO)
		);
		const deepSeekContextLength = Number(config.get("deepSeekContextLength", 258_400)) || 258_400;
		const deepSeekMaxOutputTokens = Number(config.get("deepSeekDefaultMaxOutputTokens", 70_000)) || 70_000;
		const deepSeekPricing = resolveDeepSeekPricingSnapshot();
		const codexEnabled = config.get<boolean>("enableCodexSubscription", true) !== false;
		const codexDeferredToolsEnabled = config.get<boolean>("codexDeferNonCoreTools", true) !== false;
		const codexCacheKeepAliveEnabled = config.get<boolean>("codexCacheKeepAliveEnabled", false) === true;
		const codexCacheKeepAliveMs = Math.max(
			60_000,
			Math.min(3_600_000, Number(config.get("codexCacheKeepAliveMs", 45 * 60_000)) || 45 * 60_000)
		);
		const codexWorkingContextTarget = Number(config.get("codexWorkingContextTarget", 258_400)) || 258_400;
		const claudeEnabled = config.get<boolean>("enableClaudeSubscription", true) !== false;
		const claudeContextLength = Number(config.get("claudeContextLength", 258_400)) || 258_400;
		const thinkingMode = String(config.get("thinkingMode", "auto"));
		const reasoningBudget = Number(config.get("reasoningBudget", DEFAULT_LOCAL_REASONING_BUDGET));
		const effectiveReasoningBudget = resolveReasoningBudget(
			normalizeThinkingMode(thinkingMode),
			Number.isFinite(reasoningBudget) ? reasoningBudget : DEFAULT_LOCAL_REASONING_BUDGET
		);
		const toolResultMode = String(config.get("toolResultMode", "auto"));
		const toolCallingMode = String(config.get("toolCallingMode", "apiDirect"));
		const knowledgeMode = String(config.get("knowledgeMode", "adaptive"));
		const fileLoggingEnabled = config.get<boolean>("enableFileLogging", true) !== false;
		const streamChunkLoggingEnabled = config.get<boolean>("logStreamChunks", false) === true;
		const performanceStatusBarEnabled = config.get<boolean>("showPerformanceStatusBar", true) !== false;
		const contextUsageStatusBarEnabled = config.get<boolean>("showContextUsageStatusBar", true) !== false;
		const memoryEnabled = config.get<boolean>("memoryEnabled", true) !== false;
		const memoryCount = this.getMemoryCount();
		const expiredMemoryCount = this.getExpiredMemoryCount();
		const memoryContextTokens = this.getMemoryContextTokens();
		const memoryDescription = memoryEnabled
			? `${memoryCount} entries${expiredMemoryCount > 0 ? ` / ${expiredMemoryCount} expired` : ""} · ~${formatCompactTokenCount(memoryContextTokens)} tokens context`
			: "Off";
		const lastThroughput = this.getLastThroughput();
		const lastContextUsage = this.getLastContextUsage();
		const lastPromptCache = this.getLastPromptCache();
		const sessionSummary = this.getSessionSummary();
		const codexStatus = this.getCodexStatus();
		const claudeStatus = this.getClaudeStatus();
		const codexUsageLimitPercent = this.getCodexUsageLimitPercent();
		const codexUsageLimitReset = this.getCodexUsageLimitReset();
		const claudeUsageLimitPercent = this.getClaudeUsageLimitPercent();
		const claudeUsageLimitReset = this.getClaudeUsageLimitReset();
		const claudeCacheKeepAliveEnabled = config.get<boolean>("claudeCacheKeepAliveEnabled", true) !== false;
		const claudeCacheKeepAliveMs = Math.max(
			60_000,
			Math.min(3_600_000, Number(config.get("claudeCacheKeepAliveMs", 45 * 60_000)) || 45 * 60_000)
		);
		const claudeUsage = this.getClaudeUsage();
		const claudeLastRequest = this.getClaudeLastRequest();
		const claudeUsageLimits = this.getClaudeUsageLimits();
		const localMetrics = this.getLocalMetrics();
		const deepSeekMetrics = this.getDeepSeekMetrics();
		const codexMetrics = this.getCodexMetrics();
		const claudeMetrics = this.getClaudeMetrics();
		const codexSubscriptionUsage = this.getCodexSubscriptionUsage();
		const subagentProfiles = this.getSubagentProfiles();
		const tokenUsageHistory = this.getTokenUsageHistory();
		const usageExperiments = this.getUsageExperiments();
		const apiProviderSummary = this.getApiProviderSummary();

		const apiProviders = new QuickAccessItem("apiProviders", "Providers", {
			description: apiProviderSummary.total > 0
				? `${apiProviderSummary.enabled}/${apiProviderSummary.total} active`
				: "Add sources",
			icon: new vscode.ThemeIcon("server-environment"),
			tooltip: "Manage multiple OpenAI-compatible API endpoints and credentials. API keys are stored in VS Code SecretStorage.",
			children: [
				new QuickAccessItem("apiProviders.manage", "Providers Manager", {
					description: apiProviderSummary.total > 0 ? `${apiProviderSummary.total} configured` : "Add, edit or remove",
					icon: new vscode.ThemeIcon("server-process"),
					command: command("llamacpp.openApiProviders", "Manage API Providers"),
				}),
				new QuickAccessItem("apiProviders.refresh", "Refresh Model Catalogs", {
					icon: new vscode.ThemeIcon("refresh"),
					command: command("llamacpp.refreshModels", "Refresh Models"),
				}),
			],
		});

		const local = new QuickAccessItem("local", "Local LLM", {
			description: localServerEnabled ? formatEndpointLabel(localServerUrl) : "Off",
			icon: new vscode.ThemeIcon("vm"),
			children: [
				new QuickAccessItem("local.source", "Source", {
					description: localServerEnabled ? "On" : "Off",
					tooltip: "Enable or disable the dedicated local model source",
					icon: toggleIcon(localServerEnabled),
					command: command("llamacpp.toggleLocalServer", "Toggle Local Server Source"),
				}),
				new QuickAccessItem("local.settings", "Connection", {
					description: formatEndpointLabel(localServerUrl),
					icon: new vscode.ThemeIcon("settings-gear"),
					children: [
						new QuickAccessItem("local.endpoint", "Endpoint", {
							description: formatEndpointLabel(localServerUrl),
							tooltip: localServerUrl,
							icon: new vscode.ThemeIcon("link"),
							command: command("llamacpp.setLocalServerUrl", "Set Local Server URL"),
						}),
					],
				}),
			],
		});

		const deepSeek = new QuickAccessItem("deepseek", "DeepSeek", {
			description: deepSeekEnabled
				? deepSeekPricing.isPeak ? "V4 Pro · PEAK 2×" : "V4 Pro"
				: "Off",
			icon: new vscode.ThemeIcon(
				"cloud",
				deepSeekEnabled && deepSeekPricing.isPeak ? new vscode.ThemeColor("charts.orange") : undefined
			),
			children: [
				new QuickAccessItem("deepseek.source", "Source", {
					description: deepSeekEnabled ? "On" : "Off",
					tooltip: "Enable or disable the dedicated DeepSeek source",
					icon: toggleIcon(deepSeekEnabled),
					command: command("llamacpp.toggleDeepSeek", "Toggle DeepSeek Source"),
				}),
				new QuickAccessItem("deepseek.balance", "Balance", {
					description: this.getDeepSeekBalance() ?? "n/a",
					tooltip: "DeepSeek account balance from the official /user/balance endpoint. Refreshes automatically every minute.",
					icon: new vscode.ThemeIcon("credit-card"),
					command: command("llamacpp.openSettings", "Open Settings"),
				}),
				new QuickAccessItem("deepseek.peakHours", "Peak Hours", {
					description: deepSeekPricing.state === "flat"
						? `Starts ${formatDeepSeekPeakEffectiveLocal()} (local)`
						: deepSeekPricing.isPeak
							? `Peak · 2× price · until ${deepSeekPricing.nextTransitionLocal} (local)`
							: `Off-peak · ½ price · next peak ${deepSeekPricing.nextTransitionLocal} (local)`,
					tooltip: [
						"DeepSeek peak/off-peak billing from 16:00 UTC, Aug 16 2026. Peak: 01:00–04:00 and 06:00–10:00 UTC; off-peak costs half the peak rate.",
						`Local peak windows: ${deepSeekPricing.peakWindowsLocal}.`,
						"v4-pro per 1M tokens (cache miss / output): off-peak $0.66 / $1.98, peak $1.32 / $3.96.",
					].join("\n"),
					icon: new vscode.ThemeIcon(
						deepSeekPricing.state === "flat" ? "calendar" : deepSeekPricing.isPeak ? "flame" : "moon",
						deepSeekPricing.isPeak ? new vscode.ThemeColor("charts.orange") : undefined
					),
					command: command("llamacpp.openSettings", "Open Settings"),
				}),
				new QuickAccessItem("deepseek.contextLimit", "Maximum Context", {
					description: formatCompactTokenCount(deepSeekContextLength),
					tooltip: "Open the DeepSeek sliders to set the context window advertised to VS Code for DeepSeek requests.",
					icon: new vscode.ThemeIcon("symbol-numeric"),
					command: command("llamacpp.openContextControl", "Open DeepSeek Context Slider"),
				}),
				new QuickAccessItem("deepseek.maxOutput", "Max Output", {
					description: formatCompactTokenCount(deepSeekMaxOutputTokens),
					tooltip: "Open the DeepSeek sliders to set max output tokens per request. Reasoning counts toward the budget.",
					icon: new vscode.ThemeIcon("output"),
					command: command("llamacpp.openContextControl", "Open DeepSeek Max Output Slider"),
				}),
				new QuickAccessItem("deepseek.compactionSummary", "AI Compaction Summaries", {
					description: deepSeekCompactionSummary ? "On (paid)" : "Off",
					tooltip: "Use deepseek-v4-flash for semantic summaries when local or DeepSeek HTTP history is compacted. Each compaction makes a separate paid API request; failures use the local fallback. Claude and Codex keep their native compaction paths.",
					icon: toggleIcon(deepSeekCompactionSummary),
					command: command("llamacpp.toggleDeepSeekCompactionSummary", "Toggle DeepSeek Compaction Summaries"),
				}),
				new QuickAccessItem("deepseek.settings", "Connection", {
					description: formatEndpointLabel(serverUrl),
					icon: new vscode.ThemeIcon("settings-gear"),
					children: [
						new QuickAccessItem("deepseek.endpoint", "Primary Endpoint", {
							description: formatEndpointLabel(serverUrl),
							tooltip: serverUrl,
							icon: new vscode.ThemeIcon("link"),
							command: command("llamacpp.manage", "Manage Primary Server"),
						}),
						new QuickAccessItem("deepseek.setup", "API Key & Profile", {
							icon: new vscode.ThemeIcon("key"),
							command: command("llamacpp.configureDeepSeek", "Configure DeepSeek"),
						}),
					],
				}),
			],
		});

		const codex = new QuickAccessItem("codex", "Codex", {
			description: codexEnabled
				? formatProviderUsageLine(codexStatus ?? "Checking...", codexUsageLimitPercent, codexUsageLimitReset)
				: "Off",
			icon: new vscode.ThemeIcon("hubot"),
			children: [
				new QuickAccessItem("codex.status", "Account", {
					description: codexStatus ?? "Checking...",
					tooltip: "ChatGPT subscription account used by Codex",
					icon: new vscode.ThemeIcon("account"),
					command: command("llamacpp.codexShowStatus", "Show Codex Subscription Status"),
				}),
				new QuickAccessItem("codex.subscription", "Subscription Window", {
					description: codexSubscriptionUsage ?? "Usage unavailable",
					icon: new vscode.ThemeIcon("dashboard"),
					command: command("llamacpp.codexShowStatus", "Show Codex Subscription Status"),
				}),
				new QuickAccessItem("codex.contextTarget", "Working Context", {
					description: `${formatCompactTokenCount(codexWorkingContextTarget)} target${codexMetrics?.contextWindowTokens ? ` / ${formatCompactTokenCount(codexMetrics.contextWindowTokens)} max` : ""}`,
					tooltip: "Open the provider context sliders. Codex is capped to its server-reported model window and reserves output, tool-schema, instruction, and safety tokens.",
					icon: new vscode.ThemeIcon("settings"),
					command: command("llamacpp.openContextControl", "Open Provider Context Control"),
				}),
				new QuickAccessItem("codex.usageLimit", "Usage Limit", {
					description: this.getCodexUsageLimitPercent() !== undefined
						? `${this.getCodexUsageLimitPercent()}% used${this.getCodexUsageLimitReset() ? ` · resets ${this.getCodexUsageLimitReset()}` : ""}`
						: this.getCodexSubscriptionUsage() ?? "Usage unavailable",
					tooltip: "ChatGPT subscription usage window. Refreshes automatically every minute so you can see when the limit resets.",
					icon: new vscode.ThemeIcon("dashboard"),
					command: command("llamacpp.codexShowStatus", "Show Codex Subscription Status"),
				}),
				new QuickAccessItem("codex.settings", "Tools & Account", {
					description: `VS Code-only · deferred ${codexDeferredToolsEnabled ? "on" : "off"}`,
					icon: new vscode.ThemeIcon("settings-gear"),
					children: [
						new QuickAccessItem("codex.source", "Subscription Source", {
							description: codexEnabled ? "On" : "Off",
							icon: toggleIcon(codexEnabled),
							command: command("llamacpp.toggleCodexSubscription", "Toggle Codex Subscription Source"),
						}),
						new QuickAccessItem("codex.vsCodeTools", "VS Code Tools Only", {
							description: "Required",
							tooltip: "Codex built-in command, file, web, MCP, browser, plugin, and subagent actions are blocked; all actions use native VS Code tool cards.",
							icon: toggleIcon(true),
						}),
						new QuickAccessItem("codex.deferredTools", "Deferred Tools", {
							description: codexDeferredToolsEnabled ? "On" : "Off",
							icon: toggleIcon(codexDeferredToolsEnabled),
							command: command("llamacpp.toggleCodexDeferredTools", "Toggle Codex Deferred Tools"),
						}),
						new QuickAccessItem("codex.cacheKeepAlive", "Cache Keep-Alive", {
							description: codexCacheKeepAliveEnabled
								? `On (${Math.round(codexCacheKeepAliveMs / 60_000)} min)`
								: "Off",
							tooltip: "Refreshes the Codex server-side prompt cache while idle so the next turn after a pause stays warm. Billed per token, so disabled by default. Pauses at 90% subscription usage.",
							icon: toggleIcon(codexCacheKeepAliveEnabled),
							command: command("llamacpp.toggleCodexCacheKeepAlive", "Toggle Codex Cache Keep-Alive"),
						}),
						new QuickAccessItem("codex.cacheKeepAliveIgnoreUsage", "Ignore usage-limit pause", {
							description: config.get<boolean>("codexCacheKeepAliveIgnoreUsageLimit", false) === true
								? "On"
								: "Off",
							tooltip: "When on, the Codex keep-alive continues even when the subscription usage limit reaches 90%.",
							icon: toggleIcon(config.get<boolean>("codexCacheKeepAliveIgnoreUsageLimit", false) === true),
							command: command("llamacpp.toggleCodexCacheKeepAliveIgnoreUsageLimit", "Toggle Codex Ignore Usage-Limit Pause"),
						}),
						new QuickAccessItem("codex.signIn", "Sign In", {
							icon: new vscode.ThemeIcon("sign-in"),
							command: command("llamacpp.codexSignIn", "Sign In to Codex Subscription"),
						}),
					],
				}),
			],
		});

		const claude = new QuickAccessItem("claude", "Claude", {
			description: claudeEnabled
				? formatProviderUsageLine(claudeStatus ?? "Checking...", claudeUsageLimitPercent, claudeUsageLimitReset)
				: "Off",
			icon: new vscode.ThemeIcon("sparkle"),
			children: [
				new QuickAccessItem("claude.status", "Account", {
					description: claudeStatus ?? "Checking...",
					tooltip: "Read the Claude subscription status, session usage, and rate-limit state",
					icon: new vscode.ThemeIcon("account"),
					command: command("llamacpp.claudeShowStatus", "Show Claude Subscription Status"),
				}),
				new QuickAccessItem("claude.cacheKeepAlive", "Cache Keep-Alive", {
					description: claudeCacheKeepAliveEnabled
						? `On (${Math.round(claudeCacheKeepAliveMs / 60_000)} min)`
						: "Off",
					tooltip: "Refreshes the Anthropic prompt cache while you are idle so the next turn after a pause stays warm. Runs only when no turn is active and pauses automatically at 90% usage limit.",
					icon: toggleIcon(claudeCacheKeepAliveEnabled),
					command: command("llamacpp.toggleClaudeCacheKeepAlive", "Toggle Claude Cache Keep-Alive"),
				}),
				new QuickAccessItem("claude.cacheKeepAliveIgnoreUsage", "Ignore usage-limit pause", {
					description: config.get<boolean>("claudeCacheKeepAliveIgnoreUsageLimit", false) === true
						? "On"
						: "Off",
					tooltip: "When on, keep-alive continues even when the 5-hour usage limit reaches 90%. Useful when you need the prefix cache to survive across the usage-limit window.",
					icon: toggleIcon(config.get<boolean>("claudeCacheKeepAliveIgnoreUsageLimit", false) === true),
					command: command("llamacpp.toggleClaudeCacheKeepAliveIgnoreUsageLimit", "Toggle Ignore Usage-Limit Pause"),
				}),
				new QuickAccessItem("claude.limits", "Subscription Limits", {
					description: claudeUsageLimits.length > 0
						? claudeUsageLimits.map(limit => `${limit.label.replace("Session Limit (5h)", "5h").replace("Weekly Limit", "7d").replace("Weekly ", "")}: ${limit.description.split(" / ")[0]}`).join(" · ")
						: "No data yet",
					icon: new vscode.ThemeIcon("dashboard"),
					children: claudeUsageLimits.length > 0
						? claudeUsageLimits.map(limit =>
						new QuickAccessItem(`claude.limit.${limit.id}`, limit.label, {
							description: limit.description,
							tooltip: "Claude subscription rate-limit window reported by the Claude Agent SDK",
							icon: new vscode.ThemeIcon("dashboard"),
							command: command("llamacpp.claudeShowStatus", "Show Claude Subscription Status"),
						}))
						: [
						new QuickAccessItem("claude.limit.none", "Usage Limits", {
							description: "No data yet",
							tooltip: "Subscription limits appear after the first Claude request in this session",
							icon: new vscode.ThemeIcon("dashboard"),
							command: command("llamacpp.claudeShowStatus", "Show Claude Subscription Status"),
						}),
						],
				}),
				new QuickAccessItem("claude.contextLimit", "Maximum Context", {
					description: `${formatCompactTokenCount(claudeContextLength)} target / 1M max`,
					tooltip: "Open the provider context sliders. Claude uses the real Opus 5 1M runtime and this value as its auto-compaction threshold.",
					icon: new vscode.ThemeIcon("settings"),
					command: command("llamacpp.openContextControl", "Open Provider Context Control"),
				}),
				new QuickAccessItem("claude.settings", "Account Controls", {
					description: claudeEnabled ? "On" : "Off",
					icon: new vscode.ThemeIcon("settings-gear"),
					children: [
						new QuickAccessItem("claude.source", "Subscription Source", {
							description: claudeEnabled ? "On" : "Off",
							icon: toggleIcon(claudeEnabled),
							command: command("llamacpp.toggleClaudeSubscription", "Toggle Claude Subscription Source"),
						}),
						new QuickAccessItem("claude.signIn", "Sign In", {
							icon: new vscode.ThemeIcon("sign-in"),
							command: command("llamacpp.claudeSignIn", "Sign In to Claude Subscription"),
						}),
					],
				}),
			],
		});

		const tokenUsage = new QuickAccessItem("usage", "Token Usage", {
			description: `${formatCompactTokenCount(tokenUsageHistory.today.total.inputTokens + tokenUsageHistory.today.total.outputTokens)} today · ${formatCompactTokenCount(tokenUsageHistory.week.total.inputTokens + tokenUsageHistory.week.total.outputTokens)} / 7d`,
			tooltip: [
				"Persistent provider token and prompt-cache statistics recorded by this extension. History starts when this version is installed.",
				lastPromptCache ? `Last local cache snapshot: ${lastPromptCache}` : undefined,
			].filter((value): value is string => Boolean(value)).join("\n"),
			icon: new vscode.ThemeIcon("graph-line"),
			children: [
				usageProviderItem("local", "Local / Qwen", tokenUsageHistory, localMetrics, command("llamacpp.openLatestLog", "Open Latest Log")),
				usageProviderItem("deepseek", "DeepSeek", tokenUsageHistory, deepSeekMetrics, command("llamacpp.openLatestLog", "Open Latest Log")),
				usageProviderItem("codex", "Codex", tokenUsageHistory, codexMetrics, command("llamacpp.codexShowStatus", "Show Codex Subscription Status")),
				usageProviderItem("claude", "Claude", tokenUsageHistory, claudeMetrics, command("llamacpp.claudeShowStatus", "Show Claude Subscription Status"), claudeUsage, claudeLastRequest),
				new QuickAccessItem("usage.clear", "Clear Usage History", {
					tooltip: "Delete the locally recorded daily token statistics",
					icon: new vscode.ThemeIcon("trash"),
					command: command("llamacpp.clearTokenUsageHistory", "Clear Token Usage History"),
				}),
			],
		});

		const experimentComparison = usageExperiments.comparison;
		const experimentChildren: QuickAccessItem[] = [];
		if (usageExperiments.active) {
			experimentChildren.push(
				experimentRunItem("experiments.active", "Active Run", usageExperiments.active),
				new QuickAccessItem("experiments.stop", "Stop & Export", {
					icon: new vscode.ThemeIcon("debug-stop"),
					command: command("llamacpp.stopUsageExperiment", "Stop and Export Usage Experiment"),
				})
			);
		} else {
			experimentChildren.push(
				new QuickAccessItem("experiments.startBaseline", "Start Baseline", {
					tooltip: "Record a run where Codex performs the task without delegated model work",
					icon: new vscode.ThemeIcon("beaker"),
					command: command("llamacpp.startBaselineUsageExperiment", "Start Baseline Usage Experiment"),
				}),
				new QuickAccessItem("experiments.startDelegated", "Start Delegated", {
					tooltip: "Record the same task label while work is delegated to other models",
					icon: new vscode.ThemeIcon("organization"),
					command: command("llamacpp.startDelegatedUsageExperiment", "Start Delegated Usage Experiment"),
				})
			);
		}
		if (experimentComparison) {
			experimentChildren.push(new QuickAccessItem("experiments.comparison", "Codex Comparison", {
				description: formatExperimentSavings(experimentComparison.totalSavingsPercent),
				tooltip: "Observed Codex-only difference for matched task labels. Child-provider tokens are excluded and shown separately.",
				icon: new vscode.ThemeIcon(experimentComparison.totalSavingsPercent !== undefined && experimentComparison.totalSavingsPercent >= 0 ? "arrow-down" : "arrow-up"),
				children: [
					new QuickAccessItem("experiments.comparison.total", "Total Tokens", { description: formatExperimentSavings(experimentComparison.totalSavingsPercent) }),
					new QuickAccessItem("experiments.comparison.input", "Input", { description: formatExperimentSavings(experimentComparison.inputSavingsPercent) }),
					new QuickAccessItem("experiments.comparison.uncached", "Uncached Input", { description: formatExperimentSavings(experimentComparison.uncachedInputSavingsPercent) }),
					new QuickAccessItem("experiments.comparison.output", "Output", { description: formatExperimentSavings(experimentComparison.outputSavingsPercent) }),
					...TOKEN_USAGE_PROVIDERS
						.filter(provider => provider !== "codex" && experimentComparison.delegatedChildProviders[provider]?.requests > 0)
						.map(provider => usagePeriodItem(`experiments.comparison.child.${provider}`, `Delegated ${usageProviderLabels[provider]}`, experimentComparison.delegatedChildProviders[provider])),
				],
			}));
		}
		if (usageExperiments.latestBaseline) {
			experimentChildren.push(experimentRunItem("experiments.baseline", "Latest Baseline", usageExperiments.latestBaseline));
		}
		if (usageExperiments.latestDelegated) {
			experimentChildren.push(experimentRunItem("experiments.delegated", "Latest Delegated", usageExperiments.latestDelegated));
		}
		if (usageExperiments.latestBaseline || usageExperiments.latestDelegated) {
			experimentChildren.push(
				new QuickAccessItem("experiments.export", "Export Report", {
					icon: new vscode.ThemeIcon("export"),
					command: command("llamacpp.exportUsageExperiment", "Export Usage Experiment Report"),
				}),
				new QuickAccessItem("experiments.clear", "Clear Experiments", {
					icon: new vscode.ThemeIcon("trash"),
					command: command("llamacpp.clearUsageExperiments", "Clear Usage Experiments"),
				})
			);
		}
		const experiments = new QuickAccessItem("experiments", "Usage Experiments", {
			description: usageExperiments.active
				? `${usageExperiments.active.variant} · ${usageExperiments.active.label}`
				: experimentComparison
					? `Codex ${formatExperimentSavings(experimentComparison.totalSavingsPercent)}`
					: "Ready",
			tooltip: "Controlled baseline/delegated runs. Use the same task label and repository state; Codex savings exclude child-provider tokens.",
			icon: new vscode.ThemeIcon("beaker"),
			children: experimentChildren,
		});

		const profileGroup = (
			provider: SubagentModelProfile["provider"],
			label: string,
			description: string
		): QuickAccessItem => {
			const profiles = subagentProfiles.filter(profile => profile.provider === provider);
			const availableCount = profiles.filter(profile => profile.availability === "available").length;
			const unavailableCount = profiles.filter(profile => profile.availability === "unavailable").length;
			const availabilitySummary = profiles.length > 0
				? `${availableCount} available${unavailableCount > 0 ? ` · ${unavailableCount} unavailable` : ""}`
				: description;
			return new QuickAccessItem(`agents.${provider}`, label, {
				description: profiles.length > 0 ? availabilitySummary : description,
				icon: new vscode.ThemeIcon(provider === "local" ? "vm" : provider === "codex" ? "hubot" : "cloud"),
				children: profiles.length > 0
					? profiles.map(profile => {
						const availability = profile.availability ?? "unknown";
						const availabilityLabel = availability === "available"
							? "Available"
							: availability === "unavailable"
								? "Unavailable"
								: "Availability unknown";
						const reset = profile.unavailableUntil
							? `\nAvailable after: ${new Date(profile.unavailableUntil).toLocaleString()}`
							: "";
						return new QuickAccessItem(`agents.${provider}.${profile.id}`, profile.label, {
							description: `${availabilityLabel}${profile.defaultEffort ? ` · ${profile.defaultEffort} thinking` : ""}`,
							tooltip: `${profile.id}\n${profile.useWhen}\n${profile.availabilityReason ?? "Availability was not checked"}${reset}`,
							icon: new vscode.ThemeIcon(
								availability === "available" ? "pass-filled" : availability === "unavailable" ? "circle-slash" : "question"
							),
						});
					})
					: [new QuickAccessItem(`agents.${provider}.none`, "Catalog not loaded", { icon: new vscode.ThemeIcon("info") })],
			});
		};
		const agents = new QuickAccessItem("agents", "Subagents", {
			description: "Qwen narrow · DeepSeek/Codex high",
			tooltip: "Without runSubagent.model the child inherits the parent model. To switch, pass the exact displayed model-picker label; agentName selects behavior independently.",
			icon: new vscode.ThemeIcon("organization"),
			children: [
				profileGroup("local", "Local / Qwen", "narrow & economical"),
				profileGroup("deepseek", "DeepSeek", "V4 Pro preferred · high"),
				profileGroup("codex", "Codex", "high by default"),
				profileGroup("claude", "Claude", "inherits selected effort"),
			],
		});

		const modelBehavior = new QuickAccessItem("modelBehavior", "Model Behavior", {
			description: `${thinkingMode} / ${toolCallingMode} / ${knowledgeMode}`,
			icon: new vscode.ThemeIcon("settings-gear"),
			children: [
				new QuickAccessItem("modelBehavior.thinking", "Thinking", {
					description: thinkingMode,
					tooltip: "Global default. The native chat-session selector overrides it when available.",
					icon: new vscode.ThemeIcon("lightbulb"),
					command: command("llamacpp.setThinkingMode", "Set Thinking Mode"),
				}),
				new QuickAccessItem("modelBehavior.reasoningBudget", "Local Reasoning Cap", {
					description: `${effectiveReasoningBudget} tokens`,
					tooltip: "Maximum hidden reasoning tokens for local models. Light uses up to 512, Balanced up to 2048, Deep/Auto use this cap. DeepSeek uses High/Max effort instead.",
					icon: new vscode.ThemeIcon("symbol-numeric"),
					command: command("llamacpp.setReasoningBudget", "Set Reasoning Budget"),
				}),
				new QuickAccessItem("modelBehavior.compactionTarget", "Compaction Target", {
					description: `${Math.round(compactionTargetRatio * 100)}% retained`,
					tooltip: "Share of the current message context retained by proactive and overflow compaction. 25% is extreme compression and works best with DeepSeek AI summaries.",
					icon: new vscode.ThemeIcon("fold-down"),
					command: command("llamacpp.setCompactionTargetRatio", "Set Compaction Target"),
				}),
				new QuickAccessItem("modelBehavior.toolCalling", "Tool Calling", {
					description: toolCallingMode,
					icon: new vscode.ThemeIcon("tools"),
					command: command("llamacpp.setToolCallingMode", "Set Tool Calling Mode"),
				}),
				new QuickAccessItem("modelBehavior.toolResults", "Tool Results", {
					description: toolResultMode,
					icon: new vscode.ThemeIcon("output"),
					command: command("llamacpp.setToolResultMode", "Set Tool Result Mode"),
				}),
				new QuickAccessItem("modelBehavior.knowledge", "Knowledge Verification", {
					description: knowledgeMode,
					tooltip: "Controls when the model verifies changing external knowledge with primary sources.",
					icon: new vscode.ThemeIcon("book"),
					command: command("llamacpp.setKnowledgeMode", "Set Knowledge Verification"),
				}),
			],
		});

		const memoryChildren = [
			new QuickAccessItem("memory.open", "Shared Memory", {
				description: memoryDescription,
				icon: new vscode.ThemeIcon("database"),
				command: command("llamacpp.openMemory", "Open Shared Memory"),
			}),
		];
		if (memoryCount > 0) {
			memoryChildren.push(
				new QuickAccessItem("memory.clear", "Clear All Entries", {
					icon: new vscode.ThemeIcon("trash"),
					command: command("llamacpp.clearMemory", "Clear Shared Memory"),
				})
			);
		}
		const memory = new QuickAccessItem("memory", "Memory", {
			description: memoryDescription,
			icon: new vscode.ThemeIcon("database"),
			children: memoryChildren,
		});

		const diagnostics = new QuickAccessItem("diagnostics", "Diagnostics", {
			description: `${lastThroughput ?? "n/a"} · ctx ${lastContextUsage?.summary ?? "n/a"}`,
			icon: new vscode.ThemeIcon("pulse"),
			children: [
				new QuickAccessItem("diagnostics.session", "Live Report", {
					description: sessionSummary ?? "No turns",
					tooltip: "Cache, performance, errors and provider health in one live webview.",
					icon: new vscode.ThemeIcon("graph"),
					command: command("llamacpp.openSessionReport", "Open Live Report"),
				}),
				new QuickAccessItem("diagnostics.resetSession", "Reset Session Metrics", {
					icon: new vscode.ThemeIcon("clear-all"),
					command: command("llamacpp.resetSessionReport", "Reset Session Metrics"),
				}),
				new QuickAccessItem("diagnostics.throughput", "Throughput", {
					description: lastThroughput ?? "n/a",
					icon: new vscode.ThemeIcon("dashboard"),
					command: command("llamacpp.openLatestLog", "Open Latest Log"),
				}),
				new QuickAccessItem("diagnostics.context", "Context Usage", {
					description: lastContextUsage?.summary ?? "n/a",
					tooltip: lastContextUsage?.breakdown,
					icon: new vscode.ThemeIcon("pie-chart"),
					command: command("llamacpp.openLatestLog", "Open Latest Log"),
				}),
				new QuickAccessItem("diagnostics.latestLog", "Latest Log", {
					icon: new vscode.ThemeIcon("file-text"),
					command: command("llamacpp.openLatestLog", "Open Latest Log"),
				}),
				new QuickAccessItem("diagnostics.logsFolder", "Logs Folder", {
					icon: new vscode.ThemeIcon("folder-opened"),
					command: command("llamacpp.openLogsFolder", "Open Logs Folder"),
				}),
				new QuickAccessItem("diagnostics.copyLogPath", "Copy Latest Log Path", {
					icon: new vscode.ThemeIcon("copy"),
					command: command("llamacpp.copyLatestLogPath", "Copy Latest Log Path"),
				}),
				new QuickAccessItem("diagnostics.fileLogging", "File Logging", {
					description: fileLoggingEnabled ? "On" : "Off",
					icon: toggleIcon(fileLoggingEnabled),
					command: command("llamacpp.toggleFileLogging", "Toggle File Logging"),
				}),
				new QuickAccessItem("diagnostics.streamLogging", "Stream Logging", {
					description: streamChunkLoggingEnabled ? "On" : "Off",
					icon: toggleIcon(streamChunkLoggingEnabled),
					command: command("llamacpp.toggleStreamChunkLogging", "Toggle Stream Chunk Logging"),
				}),
				new QuickAccessItem("diagnostics.performanceStatus", "Throughput Status Bar", {
					description: performanceStatusBarEnabled ? "On" : "Off",
					icon: toggleIcon(performanceStatusBarEnabled),
					command: command("llamacpp.togglePerformanceStatusBar", "Toggle Throughput Status Bar"),
				}),
				new QuickAccessItem("diagnostics.contextStatus", "Context Status Bar", {
					description: contextUsageStatusBarEnabled ? "On" : "Off",
					icon: toggleIcon(contextUsageStatusBarEnabled),
					command: command("llamacpp.toggleContextUsageStatusBar", "Toggle Context Status Bar"),
				}),
			],
		});

		const patchStatus = getCopilotPatchStatus(findCopilotBundle(vscode.env.appRoot));
		const patches = new QuickAccessItem("patches", "Copilot Patches", {
			description: `${patchStatus.applied ? "controls \u2713" : "controls \u2717"} \u00b7 ${patchStatus.workbenchApplied ? "bounds \u2713" : "bounds \u2717"}`,
			icon: new vscode.ThemeIcon("pinned"),
			tooltip: `Copilot Chat ${patchStatus.copilotVersion}: native model controls ${patchStatus.applied ? "applied" : "not applied"}, chat-history bounds ${patchStatus.workbenchApplied ? "applied" : "not applied"}. The agent-host thinking patch is toggled below. Click to open the detailed status log.`,
			children: [
				new QuickAccessItem("patches.thinking", "Thinking picker (Agents)", {
					description: "toggle the thinking-level picker for BYOK models",
					tooltip: "Patches the VS Code agent-host bundle so the Agents model picker gets a Thinking level switch (low/medium/high/extra-high) and answers non-streaming SDK requests with JSON.",
					icon: new vscode.ThemeIcon("symbol-boolean"),
					command: command("llamacpp.toggleAgentHostThinkingPatch", "Toggle Thinking Picker Patch"),
				}),
				new QuickAccessItem("patches.status", "Show Patch Status", {
					icon: new vscode.ThemeIcon("info"),
					command: command("llamacpp.copilotPatchStatus", "Show Copilot Patch Status"),
				}),
				new QuickAccessItem("patches.apply", "Apply Patch", {
					icon: new vscode.ThemeIcon("wrench"),
					command: command("llamacpp.applyCopilotPatch", "Apply Copilot Patch"),
				}),
			],
		});

		// Providers that are enabled but unreachable are hidden from Quick
		// Access and reappear as soon as the availability probe reports them
		// online again. The Providers group stays visible so the reason can
		// be inspected in the Providers Manager.
		const providerRoots = [
			{ key: "local", item: local },
			{ key: "deepseek", item: deepSeek },
			{ key: "codex", item: codex },
			{ key: "claude", item: claude },
		];
		const visibleProviders = providerRoots
			.filter(({ key }) => this.getProviderState(key) !== "offline")
			.map(({ item }) => item);
		return [apiProviders, ...visibleProviders, tokenUsage, experiments, agents, modelBehavior, memory, diagnostics, patches];
	}
}
