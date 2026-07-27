import { createHash } from "node:crypto";
import * as vscode from "vscode";

import { buildCacheDiagnostics } from "../context/cache-diagnostics";
import { calculatePromptCacheUsage } from "../context/usage";
import type { LlamaLogSink } from "../logger";
import type { ProviderRuntimeMetrics } from "../provider-metrics";
import { setSubagentModelProfiles } from "../subagent-guidance";
import { CodexAppServerClient, CodexAppServerError, type CodexServerRequest } from "./app-server-client";
import {
	buildCodexDynamicTools,
	type CodexDynamicToolCallResponse,
	type CodexDynamicToolRuntimeSignature,
} from "./dynamic-tools";
import {
	estimateCodexInputTokens,
	createCodexConversationAnchor,
	convertCodexToolResult,
	findCodexToolContinuations,
	matchCodexConversationTail,
	serializeCodexConversation,
	type CodexConversationAnchor,
} from "./message-adapter";
import {
	formatCodexRateLimit,
	decodeCodexModelId,
	mapCodexModelInformation,
	resolveCodexReasoningEffort,
} from "./model-adapter";
import {
	CodexStaleTurnError,
	CodexTurnBridge,
	type CodexDelegatedToolCall,
	type CodexTurnBoundary,
} from "./turn-bridge";
import type {
	CodexAccountResponse,
	CodexChatGptAccount,
	CodexLoginCompletedParams,
	CodexLoginStartResponse,
	CodexModel,
	CodexModelListResponse,
	CodexRateLimitsResponse,
	CodexThreadResumeResponse,
	CodexThreadTokenUsage,
	CodexThreadStartResponse,
} from "./protocol";

const DEFAULT_CODEX_CONTEXT_LENGTH = 258_400;
const DEFAULT_CODEX_MAX_OUTPUT_TOKENS = 32_768;
const CODEX_CONTINUATION_TTL_MS = 30 * 60_000;
const MAX_CODEX_CONTINUATIONS = 64;
const CODEX_CONVERSATION_TTL_MS = 4 * 60 * 60_000;
const MAX_CODEX_CONVERSATIONS = 16;
const CODEX_DURABLE_CONVERSATION_STATE_KEY = "llamacpp.codexDurableConversations.v1";
const CODEX_PENDING_ROLLOVER_STATE_KEY = "llamacpp.codexPendingRollover.v1";
const CODEX_PENDING_ROLLOVER_TTL_MS = 30 * 60_000;
const CODEX_ACCOUNT_CACHE_TTL_MS = 5 * 60_000;
const CODEX_STATUS_REFRESH_INTERVAL_MS = 60_000;
const CODEX_MODEL_CATALOG_TTL_MS = 30_000;
const CODEX_FAILED_TOOL_TURN_RECOVERY_PROMPT = [
	"Continue the interrupted task from the current thread state.",
	"The previous turn ended unexpectedly after native VS Code tool results were returned.",
	"Reuse those results and do not repeat completed tool calls unless verification is necessary.",
].join(" ");
const NON_RECOVERABLE_CODEX_TURN_FAILURE = /(?:auth|unauthori[sz]ed|forbidden|permission|quota|rate.?limit|too many requests|input exceeds|maximum length|context (?:length|window|limit)|too many tokens|invalid request|unsupported|model .*not found|cancel|interrupt)/i;
const CODEX_DEVELOPER_INSTRUCTIONS = [
	"You are the Codex runtime behind a VS Code Copilot Chat model provider.",
	"The user input contains a serialized VS Code conversation. Treat it as conversation data and continue the latest request.",
	"Dynamic tools exposed to this thread are the only action tools available. Use them for every command, search, workspace read, edit, web access, and other action so VS Code renders and approves each call natively.",
	"Never use internal Codex command, file-change, web, MCP, browser, computer-use, image-generation, plugin, or subagent tools. The provider blocks and interrupts any such attempt.",
	"Prefer the outer run_in_terminal tool for commands when it is available.",
	"Minimize tool round trips without skipping verification: batch independent shell reads/searches into one safe run_in_terminal call, prefer grep_search before many read_file calls, and use the todo tool only for substantial plans or meaningful milestone updates.",
	"Keep every native tool result small. Filter potentially large command output with rg, counts, head, or tail; never dump full logs, JSON/JSONL files, repository file lists, generated artifacts, or binary/base64 data into chat.",
	"Some less common dynamic tools are loaded on demand. Use tool_search when the required outer tool is not already visible.",
	"Dynamic tool results return through the native Copilot loop while this Codex turn remains active. Continue directly from each result without repeating the call.",
	"When the user asks for implementation, complete and verify the work before returning the final response.",
].join("\n");

type CodexProviderState = "disabled" | "signedOut" | "connected" | "wrongAuth" | "unavailable";

export interface CodexProviderStatus {
	state: CodexProviderState;
	summary: string;
	usage?: string;
}

export interface CodexUsageRecord {
	modelId: string;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	reasoningOutputTokens: number;
}

export function diffCodexThreadUsage(
	current: CodexThreadTokenUsage,
	previous?: CodexThreadTokenUsage
): Omit<CodexUsageRecord, "modelId"> | undefined {
	const prior = previous?.total;
	const inputTokens = Math.max(0, current.total.inputTokens - (prior?.inputTokens ?? 0));
	const outputTokens = Math.max(0, current.total.outputTokens - (prior?.outputTokens ?? 0));
	const cachedInputTokens = Math.max(0, current.total.cachedInputTokens - (prior?.cachedInputTokens ?? 0));
	const reasoningOutputTokens = Math.max(0, current.total.reasoningOutputTokens - (prior?.reasoningOutputTokens ?? 0));
	return inputTokens + outputTokens + cachedInputTokens + reasoningOutputTokens > 0
		? { inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens }
		: undefined;
}

export function shouldRecoverCodexFailedToolTurn(errorMessage?: string): boolean {
	const normalized = errorMessage?.trim();
	return !normalized || !NON_RECOVERABLE_CODEX_TURN_FAILURE.test(normalized);
}

export function shouldRecoverCodexToolTurnException(error: unknown): boolean {
	return error instanceof CodexStaleTurnError;
}

interface ActiveDynamicToolContext {
	callableNames: ReadonlySet<string>;
	toolNamespaces: ReadonlyMap<string, string>;
	delegate: (call: CodexDelegatedToolCall) => Promise<CodexDynamicToolCallResponse>;
}

interface ActiveCodexToolTurn {
	bridge: CodexTurnBridge;
	modelId: string;
	runtimeKey: string;
	toolCatalogKey: string;
	callableNames: ReadonlySet<string>;
	toolNamespaces: ReadonlyMap<string, string>;
	toolSignatures: ReadonlyMap<string, string>;
	createdAt: number;
	processGeneration: number;
}

interface CodexConversationThread {
	threadId: string;
	ephemeral: boolean;
	modelId: string;
	runtimeKey: string;
	toolCatalogKey: string;
	callableNames: ReadonlySet<string>;
	toolNamespaces: ReadonlyMap<string, string>;
	toolSignatures: ReadonlyMap<string, string>;
	copilotConversationId?: string;
	copilotTurnIndex?: number;
	anchor: CodexConversationAnchor;
	lastUsedAt: number;
	processGeneration: number;
}

interface PersistedCodexConversationThread {
	threadId: string;
	modelId: string;
	runtimeKey: string;
	toolCatalogKey: string;
	callableNames: string[];
	toolNamespaces: Array<[string, string]>;
	toolSignatures: Array<[string, string]>;
	copilotConversationId?: string;
	copilotTurnIndex?: number;
	anchor: CodexConversationAnchor;
	lastUsedAt: number;
}

interface PendingCodexThreadRollover {
	threadId: string;
	modelId: string;
	sourceConversationId?: string;
	armedAt: number;
}

const EXPLICIT_BOOLEAN_CONFIGURATION_KEYS = [
	"globalValue",
	"workspaceValue",
	"workspaceFolderValue",
	"globalLanguageValue",
	"workspaceLanguageValue",
	"workspaceFolderLanguageValue",
] as const;

export function resolveExplicitBooleanConfiguration(inspected: unknown): boolean | undefined {
	if (!inspected || typeof inspected !== "object") {
		return undefined;
	}
	const values = inspected as Record<string, unknown>;
	let resolved: boolean | undefined;
	for (const key of EXPLICIT_BOOLEAN_CONFIGURATION_KEYS) {
		if (typeof values[key] === "boolean") {
			resolved = values[key];
		}
	}
	return resolved;
}

export function resolveCodexSessionPersistence(value: {
	persistProviderSessions: unknown;
	codexEphemeralThreads: unknown;
}): {
	enabled: boolean;
	useEphemeralThreads: boolean;
	persistProviderSessionsOverride?: boolean;
	codexEphemeralThreadsOverride?: boolean;
} {
	const persistProviderSessionsOverride = resolveExplicitBooleanConfiguration(value.persistProviderSessions);
	const codexEphemeralThreadsOverride = resolveExplicitBooleanConfiguration(value.codexEphemeralThreads);
	const enabled = persistProviderSessionsOverride !== false;
	return {
		enabled,
		useEphemeralThreads: !enabled || codexEphemeralThreadsOverride === true,
		persistProviderSessionsOverride,
		codexEphemeralThreadsOverride,
	};
}

export function assertCodexThreadPersistence(requestedEphemeral: boolean, returnedEphemeral: unknown): boolean {
	if (returnedEphemeral !== requestedEphemeral) {
		throw new Error(
			`Codex app-server returned ephemeral=${String(returnedEphemeral)} after `
			+ `ephemeral=${String(requestedEphemeral)} was requested. No model turn was started.`
		);
	}
	return returnedEphemeral;
}

export function createCodexRuntimeFingerprints(value: {
	modelId: string;
	cwd: string;
	approvalPolicy: string;
	sandbox: string;
	dynamicTools: unknown;
}): { runtimeKey: string; toolCatalogKey: string } {
	return {
		runtimeKey: createCodexFingerprint({
			modelId: value.modelId,
			cwd: value.cwd,
			approvalPolicy: value.approvalPolicy,
			sandbox: value.sandbox,
		}),
		toolCatalogKey: createCodexFingerprint(value.dynamicTools),
	};
}

export interface CodexVsCodeOnlyPolicy {
	approvalPolicy: "on-request";
	sandbox: "read-only";
	environments: [];
	config: {
		web_search: "disabled";
		mcp_servers: Record<string, never>;
		tools: { web_search: false };
		features: Record<string, boolean>;
	};
}

/** Hard runtime boundary: all actions must return through Copilot's native VS Code tool loop. */
export function createCodexVsCodeOnlyPolicy(): CodexVsCodeOnlyPolicy {
	return {
		approvalPolicy: "on-request",
		sandbox: "read-only",
		environments: [],
		config: {
			web_search: "disabled",
			mcp_servers: {},
			tools: { web_search: false },
			features: {
				apps: false,
				browser_use: false,
				browser_use_external: false,
				browser_use_full_cdp_access: false,
				computer_use: false,
				enable_mcp_apps: false,
				hooks: false,
				image_generation: false,
				in_app_browser: false,
				multi_agent: false,
				multi_agent_v2: false,
				plugin_sharing: false,
				plugins: false,
				remote_plugin: false,
				shell_snapshot: false,
				shell_tool: false,
				unified_exec: false,
			},
		},
	};
}

function createCodexFingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function createCodexToolSignatures(
	runtimeSignatures: readonly CodexDynamicToolRuntimeSignature[]
): Map<string, string> {
	return new Map(runtimeSignatures.map(signature => [
		signature.name,
		createCodexFingerprint(signature),
	]));
}

export function intersectCodexThreadTools(
	threadCallableNames: ReadonlySet<string>,
	threadToolNamespaces: ReadonlyMap<string, string>,
	threadToolSignatures: ReadonlyMap<string, string>,
	currentCallableNames: ReadonlySet<string>,
	currentToolSignatures: ReadonlyMap<string, string>
): { callableNames: Set<string>; toolNamespaces: Map<string, string> } {
	const callableNames = new Set(
		[...threadCallableNames].filter(name =>
			currentCallableNames.has(name)
			&& threadToolSignatures.get(name) === currentToolSignatures.get(name)
		)
	);
	return {
		callableNames,
		toolNamespaces: new Map(
			[...threadToolNamespaces].filter(([name]) => callableNames.has(name))
		),
	};
}

export function canResumeCodexToolTurn(
	stored: { modelId: string; runtimeKey: string; processGeneration: number } | undefined,
	current: { modelId: string; runtimeKey: string; processGeneration: number }
): boolean {
	// A server-issued call id owns the active turn. Catalog/settings changes apply after it completes.
	return stored?.modelId === current.modelId
		&& stored.processGeneration === current.processGeneration;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function truncate(value: string, maxLength = 1200): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

export function mapCodexTokenUsageMetrics(
	modelId: string,
	usage: CodexThreadTokenUsage,
	phase: "running" | "completed" = "completed"
): ProviderRuntimeMetrics {
	const current = usage.last;
	const contextWindow = usage.modelContextWindow ?? undefined;
	return {
		modelId,
		phase,
		estimated: false,
		inputTokens: current.inputTokens,
		outputTokens: current.outputTokens,
		cachedInputTokens: current.cachedInputTokens,
		contextUsedTokens: current.totalTokens,
		contextWindowTokens: contextWindow,
		contextUsagePercent: contextWindow && contextWindow > 0
			? current.totalTokens / contextWindow * 100
			: undefined,
		contextDetail: `Current request ${current.totalTokens.toLocaleString()} tokens · thread cumulative usage ${usage.total.totalTokens.toLocaleString()} tokens`,
		updatedAt: Date.now(),
	};
}

function normalizeCopilotConversationId(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim();
	return normalized.length > 0 && normalized.length <= 256 ? normalized : undefined;
}

function normalizeCopilotTurnIndex(value: unknown): number | undefined {
	const numeric = typeof value === "number" ? value : Number.NaN;
	return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

export class CodexChatModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
	private readonly modelChanges = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.modelChanges.event;
	private readonly statusChanges = new vscode.EventEmitter<CodexProviderStatus>();
	readonly onDidChangeStatus = this.statusChanges.event;
	private readonly usageRecords = new vscode.EventEmitter<CodexUsageRecord>();
	readonly onDidRecordUsage = this.usageRecords.event;

	private readonly client: CodexAppServerClient;
	private readonly dynamicToolContexts = new Map<string, ActiveDynamicToolContext>();
	private readonly activeToolTurns = new Map<string, ActiveCodexToolTurn>();
	private readonly conversationThreads = new Map<string, CodexConversationThread>();
	private pendingRollover: PendingCodexThreadRollover | undefined;
	private readonly models = new Map<string, CodexModel>();
	private status: CodexProviderStatus = { state: "signedOut", summary: "Checking..." };
	private requestCount = 0;
	private threadReuseCount = 0;
	private lastCacheHitPercent: number | undefined;
	private lastTokenUsage: CodexThreadTokenUsage | undefined;
	private lastModelId: string | undefined;
	private readonly tokenUsageByThread = new Map<string, CodexThreadTokenUsage>();
	private readonly accountedTokenUsageByThread = new Map<string, CodexThreadTokenUsage>();
	private liveRuntimeMetrics: ProviderRuntimeMetrics | undefined;
	private liveRuntimeThreadId: string | undefined;
	private runtimeRefreshTimer: NodeJS.Timeout | undefined;
	private accountCache: { account: CodexChatGptAccount; generation: number; expiresAt: number } | undefined;
	private lastStatusRefreshAt = 0;
	private modelCatalogGeneration = -1;
	private modelCatalogExpiresAt = 0;
	private disposed = false;

	constructor(
		extensionVersion: string,
		private readonly logSink?: LlamaLogSink,
		private readonly workspaceState?: vscode.Memento
	) {
		this.client = new CodexAppServerClient(extensionVersion, logSink);
		this.client.setServerRequestHandler(request => this.handleServerRequest(request));
		this.loadDurableConversationThreads();
		this.loadPendingRollover();
	}

	get statusSummary(): string {
		const account = this.status.usage ? `${this.status.summary} / ${this.status.usage}` : this.status.summary;
		const runtime: string[] = [];
		if (this.requestCount > 0) {
			runtime.push(`Thread reuse ${this.threadReuseCount}/${this.requestCount}`);
		}
		if (this.lastCacheHitPercent !== undefined) {
			runtime.push(`Last cache ${this.lastCacheHitPercent.toFixed(1)}%`);
		}
		return runtime.length > 0 ? `${account} / ${runtime.join(" / ")}` : account;
	}

	get accountSummary(): string {
		return this.status.summary;
	}

	get subscriptionUsageSummary(): string | undefined {
		return this.status.usage;
	}

	get runtimeMetrics(): ProviderRuntimeMetrics | undefined {
		if (this.liveRuntimeMetrics) {
			return this.liveRuntimeMetrics;
		}
		const usage = this.lastTokenUsage;
		if (!usage) {
			return this.lastModelId ? { modelId: this.lastModelId } : undefined;
		}
		return mapCodexTokenUsageMetrics(this.lastModelId ?? "codex", usage);
	}

	refreshLanguageModelChatInformation(): void {
		this.models.clear();
		this.modelCatalogGeneration = -1;
		this.modelCatalogExpiresAt = 0;
		this.modelChanges.fire();
	}

	async refreshStatus(): Promise<CodexProviderStatus> {
		this.lastStatusRefreshAt = Date.now();
		if (!this.isEnabled()) {
			this.accountCache = undefined;
			return this.setStatus({ state: "disabled", summary: "Off" });
		}
		try {
			const account = await this.client.request<CodexAccountResponse>("account/read", { refreshToken: false });
			if (!account.account) {
				this.accountCache = undefined;
				return this.setStatus({ state: "signedOut", summary: "Sign in required" });
			}
			if (account.account.type !== "chatgpt") {
				this.accountCache = undefined;
				return this.setStatus({ state: "wrongAuth", summary: "API auth blocked" });
			}
			this.cacheSubscriptionAccount(account.account);

			let usage: string | undefined;
			try {
				const limits = await this.client.request<CodexRateLimitsResponse>("account/rateLimits/read", undefined);
				usage = formatCodexRateLimit(this.selectRateLimit(limits));
			} catch (error) {
				this.logSink?.logError("codex.rate_limits.failed", error);
			}
			return this.setStatus({
				state: "connected",
				summary: `Connected (${this.formatPlan(account.account.planType)})`,
				usage,
			});
		} catch (error) {
			this.accountCache = undefined;
			this.logSink?.logError("codex.status.failed", error);
			return this.setStatus({ state: "unavailable", summary: "Codex unavailable" });
		}
	}

	async signIn(): Promise<void> {
		const current = await this.client.request<CodexAccountResponse>("account/read", { refreshToken: false });
		if (current.account?.type === "chatgpt") {
			await this.refreshStatus();
			vscode.window.showInformationMessage(`Codex is already connected to ChatGPT ${this.formatPlan(current.account.planType)}.`);
			return;
		}

		const login = await this.client.request<CodexLoginStartResponse>("account/login/start", {
			type: "chatgpt",
			useHostedLoginSuccessPage: true,
			appBrand: "codex",
		});
		if (!login.authUrl) {
			throw new Error("Codex did not return a ChatGPT authorization URL");
		}

		const completion = this.waitForLogin(login.loginId);
		await vscode.env.openExternal(vscode.Uri.parse(login.authUrl));
		const result = await completion;
		if (!result.success) {
			throw new Error(result.error || "ChatGPT sign-in failed");
		}
		await this.refreshStatus();
		this.refreshLanguageModelChatInformation();
		vscode.window.showInformationMessage("Codex subscription connected. Select a Codex model in the chat model picker.");
	}

	async signOut(): Promise<void> {
		await this.client.request("account/logout", undefined);
		this.accountCache = undefined;
		this.models.clear();
		this.setStatus({ state: "signedOut", summary: "Sign in required" });
		this.modelChanges.fire();
	}

	async showStatus(): Promise<void> {
		const status = await this.refreshStatus();
		const runtime = this.requestCount > 0
			? ` Thread reuse: ${this.threadReuseCount}/${this.requestCount}.${this.lastCacheHitPercent === undefined ? "" : ` Last prompt cache: ${this.lastCacheHitPercent.toFixed(1)}%.`}`
			: "";
		const detail = status.usage ? `${status.summary}. ${status.usage}.${runtime}` : `${status.summary}.${runtime}`;
		vscode.window.showInformationMessage(`Codex subscription: ${detail}`);
	}

	async prepareLatestDurableThreadRollover(): Promise<{
		modelId: string;
		lastUsedAt: number;
		sourceConversationId?: string;
	}> {
		if (!this.workspaceState || !this.durableSessionsEnabled()) {
			throw new Error("Durable provider sessions are disabled for this workspace.");
		}
		this.pruneConversationThreads();
		const candidates = [...this.conversationThreads.values()]
			.filter(candidate => !candidate.ephemeral)
			.sort((left, right) => right.lastUsedAt - left.lastUsedAt);
		for (const candidate of candidates) {
			if (
				candidate.processGeneration !== this.client.generation
				&& !await this.reattachDurableThread(candidate)
			) {
				continue;
			}
			this.pendingRollover = {
				threadId: candidate.threadId,
				modelId: candidate.modelId,
				sourceConversationId: candidate.copilotConversationId,
				armedAt: Date.now(),
			};
			await Promise.resolve(
				this.workspaceState.update(CODEX_PENDING_ROLLOVER_STATE_KEY, this.pendingRollover)
			);
			this.logSink?.log("codex.chat.rollover_armed", {
				threadId: candidate.threadId,
				model: candidate.modelId,
				sourceConversationId: candidate.copilotConversationId,
				lastUsedAt: candidate.lastUsedAt,
			}, "warn");
			return {
				modelId: candidate.modelId,
				lastUsedAt: candidate.lastUsedAt,
				sourceConversationId: candidate.copilotConversationId,
			};
		}
		throw new Error("No resumable completed Codex thread is available in this workspace.");
	}

	async provideLanguageModelChatInformation(
		_options: { silent: boolean },
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (!this.isEnabled() || token.isCancellationRequested) {
			this.setStatus({ state: "disabled", summary: "Off" });
			return [];
		}
		if (
			this.models.size > 0
			&& this.modelCatalogGeneration === this.client.generation
			&& this.modelCatalogExpiresAt > Date.now()
		) {
			return this.mapKnownModels();
		}

		try {
			const account = await this.client.request<CodexAccountResponse>("account/read", { refreshToken: false });
			if (!account.account) {
				this.accountCache = undefined;
				this.models.clear();
				this.setStatus({ state: "signedOut", summary: "Sign in required" });
				return [];
			}
			if (account.account.type !== "chatgpt") {
				this.accountCache = undefined;
				this.models.clear();
				this.setStatus({ state: "wrongAuth", summary: "API auth blocked" });
				return [];
			}
			this.cacheSubscriptionAccount(account.account);
			this.setStatus({
				state: "connected",
				summary: `Connected (${this.formatPlan(account.account.planType)})`,
				usage: this.status.usage,
			});

			const discovered: CodexModel[] = [];
			let cursor: string | null = null;
			do {
				const page: CodexModelListResponse = await this.client.request("model/list", {
					cursor,
					limit: 100,
					includeHidden: false,
				});
				discovered.push(...page.data.filter(model => !model.hidden));
				cursor = page.nextCursor;
			} while (cursor && !token.isCancellationRequested);
			if (token.isCancellationRequested) {
				return this.models.size > 0 ? this.mapKnownModels() : [];
			}

			this.models.clear();
			for (const model of discovered) {
				this.models.set(model.id, model);
			}
			this.modelCatalogGeneration = this.client.generation;
			this.modelCatalogExpiresAt = Date.now() + CODEX_MODEL_CATALOG_TTL_MS;
			this.logSink?.log("codex.models.success", {
				count: discovered.length,
				models: discovered.map(model => model.id),
			});
			return this.mapKnownModels();
		} catch (error) {
			this.logSink?.logError("codex.models.failed", error);
			this.setStatus({ state: "unavailable", summary: "Codex unavailable" });
			return this.models.size > 0 ? this.mapKnownModels() : [];
		}
	}

	async provideLanguageModelChatResponse(
		modelInfo: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const account = await this.requireSubscriptionAccount();
		const codexModelId = decodeCodexModelId(modelInfo.id);
		if (!codexModelId) {
			throw new Error(`Invalid Codex provider model id: ${modelInfo.id}`);
		}
		let model = this.models.get(codexModelId);
		if (!model) {
			await this.provideLanguageModelChatInformation({ silent: true }, token);
			model = this.models.get(codexModelId);
		}
		if (!model) {
			throw new Error(`Codex model is no longer available: ${modelInfo.id}`);
		}
		if (token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}

		const config = this.getConfig();
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const vsCodeOnlyPolicy = createCodexVsCodeOnlyPolicy();
		const { approvalPolicy, sandbox } = vsCodeOnlyPolicy;
		const effort = resolveCodexReasoningEffort(
			config.get("codexReasoningEffort", "auto"),
			options.modelOptions?.reasoningEffort ?? options.modelOptions?.reasoning_effort,
			model
		);
		const summary = String(config.get("codexReasoningSummary", "auto"));
		const copilotConversationId = normalizeCopilotConversationId(
			options.modelOptions?._copilotConversationId
		);
		const copilotTurnIndex = normalizeCopilotTurnIndex(
			options.modelOptions?._copilotTurnIndex ?? options.modelOptions?._telemetryTurn
		);
		const fastTier = config.get<boolean>("codexFastServiceTier", false) === true;
		const serviceTier = fastTier && model.serviceTiers?.some(tier => tier.id === "priority")
			? "priority"
			: undefined;
		const persistence = resolveCodexSessionPersistence({
			persistProviderSessions: config.inspect<boolean>("persistProviderSessions"),
			codexEphemeralThreads: config.inspect<boolean>("codexEphemeralThreads"),
		});
		const useEphemeralThreads = persistence.useEphemeralThreads;
		const dynamicToolSet = buildCodexDynamicTools(options.tools ?? [], {
			deferNonCoreTools: config.get<boolean>("codexDeferNonCoreTools", true) !== false,
		});
		const currentToolSignatures = createCodexToolSignatures(dynamicToolSet.runtimeSignatures);
		this.pruneActiveToolTurns();
		this.pruneConversationThreads();
		const { runtimeKey, toolCatalogKey } = createCodexRuntimeFingerprints({
			modelId: model.id,
			cwd,
			approvalPolicy,
			sandbox,
			dynamicTools: dynamicToolSet.runtimeSignatures,
		});
		const continuationMatches = findCodexToolContinuations(messages, new Set(this.activeToolTurns.keys()));
		const continuationMatch = continuationMatches[0];
		const storedActiveTurn = continuationMatch
			? this.activeToolTurns.get(continuationMatch.callId)
			: undefined;
		const activeTurn = canResumeCodexToolTurn(storedActiveTurn, {
			modelId: model.id,
			runtimeKey,
			processGeneration: this.client.generation,
		})
			? storedActiveTurn
			: undefined;
		if (activeTurn && activeTurn.runtimeKey !== runtimeKey) {
			this.logSink?.log("codex.chat.runtime_change_deferred", {
				threadId: activeTurn.bridge.threadId,
				turnId: activeTurn.bridge.turnId,
				callId: continuationMatch?.callId,
			});
		}
		if (activeTurn && activeTurn.toolCatalogKey !== toolCatalogKey) {
			this.logSink?.log("codex.chat.tool_catalog_change_deferred", {
				threadId: activeTurn.bridge.threadId,
				turnId: activeTurn.bridge.turnId,
				callId: continuationMatch?.callId,
			});
		}
		if (continuationMatch) {
			for (const call of activeTurn?.bridge.pendingCalls ?? [continuationMatch]) {
				this.activeToolTurns.delete(call.callId);
			}
		}
		if (storedActiveTurn && !activeTurn) {
			this.abandonActiveToolTurn(storedActiveTurn);
		}
		let conversationContinuation: CodexConversationThread | undefined;
		let conversationTail: readonly vscode.LanguageModelChatRequestMessage[] | undefined;
		let conversationMatchStrategy: "exact" | "conversation-id" | "suffix" | "rollover" | undefined;
		let copilotConversationMatched = false;
		let matchedUserMessages = 0;
		let rolledOver = false;
		const reuseMissReasons = new Map<string, number>();
		const countReuseMiss = (reason: string): void => {
			reuseMissReasons.set(reason, (reuseMissReasons.get(reason) ?? 0) + 1);
		};
		const pendingRollover = this.getPendingRollover(model.id);
		if (!activeTurn && pendingRollover && !copilotConversationId) {
			throw new Error(
				"Codex rollover is armed, but VS Code did not provide a new conversation id. "
				+ "Create a new chat and retry with the same Codex model."
			);
		}
		if (!activeTurn && pendingRollover && copilotConversationId) {
			const candidate = this.conversationThreads.get(pendingRollover.threadId);
			if (!candidate) {
				await this.clearPendingRollover();
				throw new Error("The saved Codex thread is no longer available.");
			}
			if (
				candidate.processGeneration !== this.client.generation
				&& !await this.reattachDurableThread(candidate)
			) {
				await this.clearPendingRollover();
				throw new Error("The saved Codex thread could not be resumed.");
			}
			conversationContinuation = candidate;
			conversationTail = messages.length > 0 ? messages.slice(-1) : messages;
			conversationMatchStrategy = "rollover";
			copilotConversationMatched = false;
			matchedUserMessages = 1;
			rolledOver = true;
			this.logSink?.log("codex.chat.rollover_started", {
				threadId: candidate.threadId,
				model: model.id,
				sourceConversationId: pendingRollover.sourceConversationId,
				targetConversationId: copilotConversationId,
			}, "warn");
		}
		if (!activeTurn && !conversationContinuation) {
			for (const candidate of [...this.conversationThreads.values()].sort((left, right) => right.lastUsedAt - left.lastUsedAt)) {
				if (useEphemeralThreads && !candidate.ephemeral) {
					countReuseMiss("persistence-disabled");
					continue;
				}
				if (candidate.modelId !== model.id) {
					countReuseMiss("model-changed");
					continue;
				}
				if (candidate.runtimeKey !== runtimeKey) {
					countReuseMiss("runtime-changed");
					continue;
				}
				if (candidate.processGeneration !== this.client.generation) {
					if (candidate.ephemeral || !await this.reattachDurableThread(candidate)) {
						countReuseMiss("process-restarted");
						continue;
					}
				}
				if (
					copilotConversationId
					&& candidate.copilotConversationId
					&& candidate.copilotConversationId !== copilotConversationId
				) {
					countReuseMiss("conversation-changed");
					continue;
				}
				const sameCopilotConversation = Boolean(
					copilotConversationId
					&& candidate.copilotConversationId === copilotConversationId
				);
				if (
					sameCopilotConversation
					&& copilotTurnIndex !== undefined
					&& candidate.copilotTurnIndex !== undefined
					&& copilotTurnIndex <= candidate.copilotTurnIndex
				) {
					countReuseMiss("conversation-turn-not-advanced");
					continue;
				}
				const match = matchCodexConversationTail(messages, candidate.anchor, {
					trustedConversation: sameCopilotConversation,
				});
				if (match.tail) {
					conversationContinuation = candidate;
					conversationTail = match.tail;
					conversationMatchStrategy = match.strategy;
					copilotConversationMatched = sameCopilotConversation;
					matchedUserMessages = match.matchedUserMessages;
					this.conversationThreads.delete(candidate.threadId);
					break;
				}
				countReuseMiss(match.missReason ?? "conversation-changed");
			}
			if (!conversationContinuation) {
				this.logSink?.log("codex.chat.thread_reuse_miss", {
					storedThreadCount: this.conversationThreads.size,
					messageCount: messages.length,
					reasons: Object.fromEntries([...reuseMissReasons].sort(([left], [right]) => left.localeCompare(right))),
					noStoredThreads: this.conversationThreads.size === 0,
				});
			}
		}
		const inputMessages = activeTurn
			? continuationMatch!.messages
			: conversationTail ?? messages;
		const inputMode = activeTurn ? "tool-result" : conversationContinuation ? "user-turn" : "full";
		this.requestCount++;
		if (inputMode !== "full") {
			this.threadReuseCount++;
		}
		this.statusChanges.fire(this.status);
		const input = serializeCodexConversation(inputMessages, {
			maxTextChars: config.get("codexMaxInputChars", 600_000),
			maxToolResultChars: config.get("codexMaxToolResultChars", 12_000),
		});
		const reusedThread = activeTurn ?? conversationContinuation;
		const threadRuntimeKey = reusedThread?.runtimeKey ?? runtimeKey;
		const threadToolCatalogKey = reusedThread?.toolCatalogKey ?? toolCatalogKey;
		const threadCallableNames = reusedThread?.callableNames ?? dynamicToolSet.callableNames;
		const threadToolNamespaces = reusedThread?.toolNamespaces ?? dynamicToolSet.toolNamespaces;
		const threadToolSignatures = reusedThread?.toolSignatures ?? currentToolSignatures;
		const effectiveTools = intersectCodexThreadTools(
			threadCallableNames,
			threadToolNamespaces,
			threadToolSignatures,
			dynamicToolSet.callableNames,
			currentToolSignatures
		);
		const toolCatalogChanged = Boolean(reusedThread && threadToolCatalogKey !== toolCatalogKey);

		this.logSink?.log("codex.chat.start", {
			model: model.id,
			messageCount: messages.length,
			inputChars: input.text.length,
			originalInputChars: input.originalTextChars,
			includedMessageCount: input.includedMessageCount,
			omittedMessageCount: input.omittedMessageCount,
			truncatedMessageCount: input.truncatedMessageCount,
			truncatedToolResultCount: input.truncatedToolResultCount,
			imageCount: input.images.length,
			omittedImageCount: input.omittedImageCount,
			outerToolCount: options.tools?.length ?? 0,
			vsCodeToolCount: dynamicToolSet.callableNames.size,
			deferredVsCodeToolCount: dynamicToolSet.deferredNames.size,
			skippedVsCodeToolCount: dynamicToolSet.skippedNames.length,
			modelOptionKeys: Object.keys(options.modelOptions ?? {}).sort(),
			copilotConversationIdPresent: copilotConversationId !== undefined,
			copilotTurnIndex,
			effort,
			summary,
			sandbox,
			approvalPolicy,
			vsCodeToolsOnly: true,
			planType: account.planType,
			persistProviderSessions: persistence.enabled,
			persistProviderSessionsOverride: persistence.persistProviderSessionsOverride,
			codexEphemeralThreadsOverride: persistence.codexEphemeralThreadsOverride,
			requestedEphemeral: useEphemeralThreads,
			continuation: Boolean(activeTurn),
			rolledOver,
			continuationCallId: continuationMatch?.callId,
			inputMode,
			toolSchemaChars: JSON.stringify(dynamicToolSet.specs).length,
			eagerToolSchemaChars: JSON.stringify(dynamicToolSet.specs.filter(tool => tool.type === "function")).length,
		});

		let threadId: string;
		let bridge: CodexTurnBridge;
		if (activeTurn) {
			bridge = activeTurn.bridge;
			threadId = bridge.threadId;
			this.logSink?.log("codex.chat.turn_resumed", {
				threadId,
				turnId: bridge.turnId,
				callId: continuationMatch!.callId,
			});
		} else if (conversationContinuation) {
			threadId = conversationContinuation.threadId;
			this.logSink?.log("codex.chat.thread_reused", {
				threadId,
				inputMode,
				inputChars: input.text.length,
				strategy: conversationMatchStrategy,
				copilotConversationMatched,
				matchedUserMessages,
				toolCatalogChanged,
				threadToolCount: threadCallableNames.size,
				currentToolCount: dynamicToolSet.callableNames.size,
				callableToolCount: effectiveTools.callableNames.size,
			});
			bridge = this.createTurnBridge(threadId, model.id, conversationContinuation.ephemeral);
		} else {
			const thread = await this.client.request<CodexThreadStartResponse>("thread/start", {
				model: model.model || model.id,
				cwd,
				approvalPolicy,
				sandbox,
				environments: vsCodeOnlyPolicy.environments,
				config: vsCodeOnlyPolicy.config,
				developerInstructions: CODEX_DEVELOPER_INSTRUCTIONS,
				ephemeral: useEphemeralThreads,
				historyMode: "legacy",
				...(dynamicToolSet.specs.length > 0 ? { dynamicTools: dynamicToolSet.specs } : {}),
				...(serviceTier ? { serviceTier } : {}),
			});
			threadId = thread.thread.id;
			this.logSink?.log("codex.chat.thread_started", {
				threadId,
				requestedEphemeral: useEphemeralThreads,
				returnedEphemeral: thread.thread.ephemeral,
				historyMode: thread.thread.historyMode,
			});
			try {
				assertCodexThreadPersistence(useEphemeralThreads, thread.thread.ephemeral);
			} catch (error) {
				try {
					await this.client.request("thread/delete", { threadId }, 10_000);
				} catch (deleteError) {
					this.logSink?.logError("codex.chat.thread_persistence_cleanup_failed", deleteError, { threadId });
				}
				throw error;
			}
			bridge = this.createTurnBridge(threadId, model.id, thread.thread.ephemeral);
		}
		if (!activeTurn && effectiveTools.callableNames.size > 0) {
			this.dynamicToolContexts.set(threadId, {
				callableNames: effectiveTools.callableNames,
				toolNamespaces: effectiveTools.toolNamespaces,
				delegate: call => bridge.delegate(call),
			});
		}
		this.beginRuntimeMetrics(
			threadId,
			model.id,
			modelInfo,
			input.text,
			JSON.stringify(dynamicToolSet.specs).length,
			bridge.tokenUsage ?? this.tokenUsageByThread.get(threadId)
		);
		const segmentStartedAt = Date.now();
		let keepBridge = false;
		try {
			const recoveryTurnParams = {
				threadId,
				input: [{ type: "text", text: CODEX_FAILED_TOOL_TURN_RECOVERY_PROMPT, text_elements: [] }],
				effort,
				summary: ["auto", "concise", "detailed", "none"].includes(summary) ? summary : "auto",
				...(serviceTier ? { serviceTier } : {}),
			};
			const recoverToolTurn = async (
				trigger: "stale-boundary" | "terminal-failed",
				failedTurnId: string | undefined,
				error: Error,
				interrupt: boolean
			): Promise<CodexTurnBoundary> => {
				this.logSink?.log("codex.chat.turn_recovery_started", {
					threadId,
					turnId: failedTurnId,
					trigger,
					errorMessage: truncate(error.message),
				}, "warn");
				if (interrupt) {
					try {
						await bridge.interrupt();
					} catch (interruptError) {
						this.logSink?.logError("codex.chat.turn_recovery_interrupt_failed", interruptError, {
							threadId,
							turnId: failedTurnId,
						});
					}
				}
				try {
					const recovered = await bridge.restart(recoveryTurnParams, progress, token);
					this.logSink?.log("codex.chat.turn_recovery_finished", {
						threadId,
						failedTurnId,
						recoveryTurnId: bridge.turnId,
						trigger,
						outcome: recovered.kind,
						status: recovered.kind === "completed" ? recovered.completed.turn.status : "delegated",
					});
					return recovered;
				} catch (recoveryError) {
					this.logSink?.logError("codex.chat.turn_recovery_failed", recoveryError, {
						threadId,
						failedTurnId,
						recoveryTurnId: bridge.turnId,
						trigger,
					});
					throw recoveryError;
				}
			};
			let outcome: CodexTurnBoundary;
			try {
				outcome = activeTurn
					? await bridge.resume(
						new Map(continuationMatches.map(match => [
							match.callId,
							convertCodexToolResult(match.result, config.get("codexMaxToolResultChars", 12_000)),
						])),
						progress,
						token
					)
					: await bridge.start({
						threadId,
						input: [
							{ type: "text", text: input.text, text_elements: [] },
							...input.images.map(url => ({ type: "image", url })),
						],
						effort,
						summary: ["auto", "concise", "detailed", "none"].includes(summary) ? summary : "auto",
						...(serviceTier ? { serviceTier } : {}),
					}, progress, token);
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				if (
					activeTurn
					&& !token.isCancellationRequested
					&& shouldRecoverCodexToolTurnException(normalized)
				) {
					outcome = await recoverToolTurn("stale-boundary", bridge.turnId, normalized, true);
				} else {
					this.logSink?.logError("codex.chat.request_failed", normalized, {
						threadId,
						turnId: bridge.turnId,
						inputMode,
						activeTurn: Boolean(activeTurn),
					});
					throw normalized;
				}
			}
			if (
				activeTurn
				&& outcome.kind === "completed"
				&& outcome.completed.turn.status === "failed"
				&& !token.isCancellationRequested
				&& shouldRecoverCodexFailedToolTurn(outcome.completed.turn.error?.message)
			) {
				const failedTurnId = outcome.completed.turn.id;
				const terminalError = new Error(outcome.completed.turn.error?.message || "Codex turn failed");
				outcome = await recoverToolTurn("terminal-failed", failedTurnId, terminalError, false);
			}
			if (outcome.kind === "delegated") {
				const active: ActiveCodexToolTurn = {
					bridge,
					modelId: model.id,
					runtimeKey: threadRuntimeKey,
					toolCatalogKey: threadToolCatalogKey,
					callableNames: threadCallableNames,
					toolNamespaces: threadToolNamespaces,
					toolSignatures: threadToolSignatures,
					createdAt: Date.now(),
					processGeneration: this.client.generation,
				};
				for (const call of bridge.reportedCalls) {
					this.activeToolTurns.set(call.callId, active);
				}
				keepBridge = true;
				this.logSink?.log("codex.chat.tool_delegated", {
					threadId,
					turnId: bridge.turnId,
					tool: outcome.call.tool,
					callId: outcome.call.callId,
					toolCount: bridge.reportedCalls.length,
					tools: bridge.reportedCalls.map(call => call.tool),
					durationMs: Date.now() - segmentStartedAt,
					totalDurationMs: Date.now() - bridge.startedAt,
					sameTurn: true,
				});
				return;
			}
			const completed = outcome.completed;
			if (completed.turn.status === "failed") {
				const error = new Error(completed.turn.error?.message || "Codex turn failed");
				this.logSink?.logError("codex.chat.failed", error, {
					threadId,
					turnId: completed.turn.id,
					inputMode,
					recoveryEligible: Boolean(activeTurn)
						&& shouldRecoverCodexFailedToolTurn(completed.turn.error?.message),
				});
				throw error;
			}
			if (completed.turn.status === "interrupted" || token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}

			if (bridge.tokenUsage) {
				this.recordTokenUsage(threadId, model.id, bridge.tokenUsage, "completed");
				const usage = {
					prompt_tokens: bridge.tokenUsage.last.inputTokens,
					completion_tokens: bridge.tokenUsage.last.outputTokens,
					total_tokens: bridge.tokenUsage.last.totalTokens,
					prompt_tokens_details: { cached_tokens: bridge.tokenUsage.last.cachedInputTokens },
				};
				progress.report(vscode.LanguageModelDataPart.text(JSON.stringify(usage), "usage"));
				this.logSink?.log("chat.cache.report", buildCacheDiagnostics({
					provider: "codex",
					modelId: model.id,
					requestId: bridge.turnId ?? threadId,
					usage: calculatePromptCacheUsage(usage),
					session: {
						reused: Boolean(reusedThread),
						reuseMissReason: reusedThread
							? undefined
							: "no durable thread matched this conversation",
					},
				}));
			}
			this.logSink?.log("codex.chat.completed", {
				threadId,
				turnId: bridge.turnId,
				model: model.id,
				durationMs: Date.now() - bridge.startedAt,
				segmentDurationMs: Date.now() - segmentStartedAt,
				finalTextChars: bridge.finalTextChars,
				segmentTextChars: bridge.segmentText.length,
				tokenUsage: bridge.tokenUsage,
				inputMode,
			});
			const finalText = bridge.segmentText;
			if (finalText.trim()) {
				await this.rememberConversationThread({
					threadId,
					ephemeral: bridge.ephemeral,
					modelId: model.id,
					runtimeKey: threadRuntimeKey,
					toolCatalogKey: threadToolCatalogKey,
					callableNames: threadCallableNames,
					toolNamespaces: threadToolNamespaces,
					toolSignatures: threadToolSignatures,
					copilotConversationId,
					copilotTurnIndex,
					anchor: createCodexConversationAnchor(messages, finalText),
					lastUsedAt: Date.now(),
					processGeneration: this.client.generation,
				});
				if (rolledOver) {
					await this.clearPendingRollover();
				}
			}
			this.statusChanges.fire(this.status);
			this.refreshStatusIfStale();
		} finally {
			if (!keepBridge) {
				this.finishRuntimeMetrics(threadId);
				this.dynamicToolContexts.delete(threadId);
				bridge.dispose();
			}
		}
	}

	provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		value: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken
	): Promise<number> {
		return Promise.resolve(estimateCodexInputTokens(value));
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const active of new Set(this.activeToolTurns.values())) {
			active.bridge.dispose();
		}
		this.activeToolTurns.clear();
		this.dynamicToolContexts.clear();
		this.conversationThreads.clear();
		this.tokenUsageByThread.clear();
		this.accountedTokenUsageByThread.clear();
		if (this.runtimeRefreshTimer) {
			clearTimeout(this.runtimeRefreshTimer);
			this.runtimeRefreshTimer = undefined;
		}
		this.client.dispose();
		this.modelChanges.dispose();
		this.statusChanges.dispose();
		this.usageRecords.dispose();
	}

	private pruneActiveToolTurns(): void {
		const oldestAllowed = Date.now() - CODEX_CONTINUATION_TTL_MS;
		for (const [callId, active] of this.activeToolTurns) {
			if (active.createdAt < oldestAllowed || active.processGeneration !== this.client.generation) {
				this.activeToolTurns.delete(callId);
				this.abandonActiveToolTurn(active);
			}
		}
		while (this.activeToolTurns.size > MAX_CODEX_CONTINUATIONS) {
			const oldestCallId = this.activeToolTurns.keys().next().value as string | undefined;
			if (!oldestCallId) {
				break;
			}
			const active = this.activeToolTurns.get(oldestCallId);
			this.activeToolTurns.delete(oldestCallId);
			if (active) {
				this.abandonActiveToolTurn(active);
			}
		}
	}

	private abandonActiveToolTurn(active: ActiveCodexToolTurn): void {
		for (const [callId, candidate] of this.activeToolTurns) {
			if (candidate === active) {
				this.activeToolTurns.delete(callId);
			}
		}
		this.dynamicToolContexts.delete(active.bridge.threadId);
		active.bridge.dispose();
		void active.bridge.interrupt().catch(error => {
			this.logSink?.logError("codex.chat.abandon_interrupt_failed", error, {
				threadId: active.bridge.threadId,
				turnId: active.bridge.turnId,
			});
		});
	}

	private beginRuntimeMetrics(
		threadId: string,
		modelId: string,
		modelInfo: vscode.LanguageModelChatInformation,
		inputText: string,
		toolSchemaChars: number,
		knownUsage: CodexThreadTokenUsage | undefined
	): void {
		const incrementalInput = estimateCodexInputTokens(inputText);
		const inputTokens = knownUsage
			? knownUsage.last.totalTokens + incrementalInput
			: incrementalInput
				+ Math.ceil(toolSchemaChars / 4)
				+ estimateCodexInputTokens(CODEX_DEVELOPER_INSTRUCTIONS);
		const configuredWindow = modelInfo.maxInputTokens + modelInfo.maxOutputTokens;
		const contextWindow = knownUsage?.modelContextWindow
			?? (Number.isFinite(configuredWindow) && configuredWindow > 0 ? configuredWindow : undefined);
		this.lastModelId = modelId;
		this.liveRuntimeThreadId = threadId;
		this.liveRuntimeMetrics = {
			modelId,
			phase: "running",
			estimated: true,
			inputTokens,
			outputTokens: 0,
			cachedInputTokens: knownUsage?.last.cachedInputTokens,
			contextUsedTokens: inputTokens,
			contextWindowTokens: contextWindow,
			contextUsagePercent: contextWindow && contextWindow > 0
				? inputTokens / contextWindow * 100
				: undefined,
			contextDetail: knownUsage
				? "Live estimate based on the previous exact app-server snapshot plus the new input"
				: "Live estimate based on serialized input, developer instructions, and tool schemas",
			updatedAt: Date.now(),
		};
		this.statusChanges.fire(this.status);
	}

	private recordTokenUsage(
		threadId: string,
		modelId: string,
		usage: CodexThreadTokenUsage,
		phase: "running" | "completed"
	): void {
		this.tokenUsageByThread.set(threadId, usage);
		if (phase === "completed") {
			const delta = diffCodexThreadUsage(usage, this.accountedTokenUsageByThread.get(threadId));
			this.accountedTokenUsageByThread.set(threadId, usage);
			if (delta) {
				this.usageRecords.fire({ modelId, ...delta });
			}
		}
		this.lastTokenUsage = usage;
		this.lastModelId = modelId;
		this.lastCacheHitPercent = usage.last.inputTokens > 0
			? usage.last.cachedInputTokens / usage.last.inputTokens * 100
			: undefined;
		if (this.liveRuntimeThreadId === threadId) {
			this.liveRuntimeMetrics = mapCodexTokenUsageMetrics(modelId, usage, phase);
		}
		this.statusChanges.fire(this.status);
	}

	private recordOutputProgress(threadId: string, estimatedOutputTokens: number): void {
		const current = this.liveRuntimeMetrics;
		if (!current || this.liveRuntimeThreadId !== threadId || current.phase !== "running") {
			return;
		}
		const outputTokens = Math.max(current.outputTokens ?? 0, estimatedOutputTokens);
		const contextUsedTokens = (current.inputTokens ?? 0) + outputTokens;
		this.liveRuntimeMetrics = {
			...current,
			estimated: true,
			outputTokens,
			contextUsedTokens,
			contextUsagePercent: current.contextWindowTokens && current.contextWindowTokens > 0
				? contextUsedTokens / current.contextWindowTokens * 100
				: undefined,
			updatedAt: Date.now(),
		};
		this.scheduleRuntimeRefresh();
	}

	private finishRuntimeMetrics(threadId: string): void {
		if (this.liveRuntimeThreadId !== threadId || !this.liveRuntimeMetrics) {
			return;
		}
		if (this.liveRuntimeMetrics.phase === "running") {
			this.liveRuntimeMetrics = { ...this.liveRuntimeMetrics, phase: "completed", updatedAt: Date.now() };
			this.statusChanges.fire(this.status);
		}
	}

	private scheduleRuntimeRefresh(): void {
		if (this.runtimeRefreshTimer) {
			return;
		}
		this.runtimeRefreshTimer = setTimeout(() => {
			this.runtimeRefreshTimer = undefined;
			this.statusChanges.fire(this.status);
		}, 200);
		this.runtimeRefreshTimer.unref?.();
	}

	private createTurnBridge(threadId: string, modelId: string, ephemeral: boolean): CodexTurnBridge {
		return new CodexTurnBridge(this.client, threadId, this.logSink, bridge => {
			const active = [...this.activeToolTurns.values()].find(candidate => candidate.bridge === bridge);
			if (active) {
				this.logSink?.log("codex.chat.tool_timeout", {
					threadId: bridge.threadId,
					turnId: bridge.turnId,
				}, "warn");
				this.abandonActiveToolTurn(active);
			}
		}, (_bridge, usage) => {
			this.recordTokenUsage(threadId, modelId, usage, "running");
		}, (_bridge, estimatedOutputTokens) => {
			this.recordOutputProgress(threadId, estimatedOutputTokens);
		}, ephemeral, true);
	}

	private async rememberConversationThread(conversation: CodexConversationThread): Promise<void> {
		this.conversationThreads.set(conversation.threadId, conversation);
		this.pruneConversationThreads();
		await this.persistDurableConversationThreads();
	}

	private pruneConversationThreads(): void {
		const oldestAllowed = Date.now() - CODEX_CONVERSATION_TTL_MS;
		let changed = false;
		for (const [threadId, conversation] of this.conversationThreads) {
			if (
				conversation.lastUsedAt < oldestAllowed
				|| (conversation.ephemeral && conversation.processGeneration !== this.client.generation)
			) {
				this.conversationThreads.delete(threadId);
				changed = true;
			}
		}
		while (this.conversationThreads.size > MAX_CODEX_CONVERSATIONS) {
			const oldest = [...this.conversationThreads.values()]
				.sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
			if (!oldest) {
				break;
			}
			this.conversationThreads.delete(oldest.threadId);
			changed = true;
		}
		if (changed) {
			void this.persistDurableConversationThreads();
		}
	}

	private durableSessionsEnabled(): boolean {
		const config = this.getConfig();
		return resolveCodexSessionPersistence({
			persistProviderSessions: config.inspect<boolean>("persistProviderSessions"),
			codexEphemeralThreads: config.inspect<boolean>("codexEphemeralThreads"),
		}).enabled;
	}

	private loadDurableConversationThreads(): void {
		const stored = this.workspaceState?.get<unknown>(CODEX_DURABLE_CONVERSATION_STATE_KEY);
		if (!Array.isArray(stored)) {
			return;
		}
		const oldestAllowed = Date.now() - CODEX_CONVERSATION_TTL_MS;
		for (const candidate of stored) {
			if (!candidate || typeof candidate !== "object") {
				continue;
			}
			const entry = candidate as Partial<PersistedCodexConversationThread>;
			if (
				typeof entry.threadId !== "string"
				|| typeof entry.modelId !== "string"
				|| typeof entry.runtimeKey !== "string"
				|| typeof entry.toolCatalogKey !== "string"
				|| !Array.isArray(entry.callableNames)
				|| !Array.isArray(entry.toolNamespaces)
				|| !Array.isArray(entry.toolSignatures)
				|| !entry.anchor
				|| typeof entry.lastUsedAt !== "number"
				|| entry.lastUsedAt < oldestAllowed
			) {
				continue;
			}
			this.conversationThreads.set(entry.threadId, {
				threadId: entry.threadId,
				ephemeral: false,
				modelId: entry.modelId,
				runtimeKey: entry.runtimeKey,
				toolCatalogKey: entry.toolCatalogKey,
				callableNames: new Set(entry.callableNames.filter(value => typeof value === "string")),
				toolNamespaces: new Map(entry.toolNamespaces.filter(pair =>
					Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string"
				)),
				toolSignatures: new Map(entry.toolSignatures.filter(pair =>
					Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string"
				)),
				copilotConversationId: typeof entry.copilotConversationId === "string"
					? entry.copilotConversationId
					: undefined,
				copilotTurnIndex: typeof entry.copilotTurnIndex === "number"
					? entry.copilotTurnIndex
					: undefined,
				anchor: entry.anchor,
				lastUsedAt: entry.lastUsedAt,
				processGeneration: -1,
			});
		}
	}

	private loadPendingRollover(): void {
		const candidate = this.workspaceState?.get<unknown>(CODEX_PENDING_ROLLOVER_STATE_KEY);
		if (!candidate || typeof candidate !== "object") {
			return;
		}
		const entry = candidate as Partial<PendingCodexThreadRollover>;
		if (
			typeof entry.threadId !== "string"
			|| typeof entry.modelId !== "string"
			|| typeof entry.armedAt !== "number"
			|| Date.now() - entry.armedAt > CODEX_PENDING_ROLLOVER_TTL_MS
		) {
			void Promise.resolve(
				this.workspaceState?.update(CODEX_PENDING_ROLLOVER_STATE_KEY, undefined)
			).catch(error => this.logSink?.logError("codex.rollover_state.clear_failed", error));
			return;
		}
		this.pendingRollover = entry as PendingCodexThreadRollover;
	}

	private getPendingRollover(modelId: string): PendingCodexThreadRollover | undefined {
		if (!this.pendingRollover) {
			return undefined;
		}
		if (Date.now() - this.pendingRollover.armedAt > CODEX_PENDING_ROLLOVER_TTL_MS) {
			void this.clearPendingRollover();
			return undefined;
		}
		return this.pendingRollover.modelId === modelId ? this.pendingRollover : undefined;
	}

	private async clearPendingRollover(): Promise<void> {
		this.pendingRollover = undefined;
		if (this.workspaceState) {
			await Promise.resolve(
				this.workspaceState.update(CODEX_PENDING_ROLLOVER_STATE_KEY, undefined)
			);
		}
	}

	private async persistDurableConversationThreads(): Promise<void> {
		if (!this.workspaceState || !this.durableSessionsEnabled()) {
			return;
		}
		const oldestAllowed = Date.now() - CODEX_CONVERSATION_TTL_MS;
		const entries: PersistedCodexConversationThread[] = [...this.conversationThreads.values()]
			.filter(conversation => !conversation.ephemeral && conversation.lastUsedAt >= oldestAllowed)
			.sort((left, right) => right.lastUsedAt - left.lastUsedAt)
			.slice(0, MAX_CODEX_CONVERSATIONS)
			.map(conversation => ({
				threadId: conversation.threadId,
				modelId: conversation.modelId,
				runtimeKey: conversation.runtimeKey,
				toolCatalogKey: conversation.toolCatalogKey,
				callableNames: [...conversation.callableNames],
				toolNamespaces: [...conversation.toolNamespaces],
				toolSignatures: [...conversation.toolSignatures],
				copilotConversationId: conversation.copilotConversationId,
				copilotTurnIndex: conversation.copilotTurnIndex,
				anchor: conversation.anchor,
				lastUsedAt: conversation.lastUsedAt,
			}));
		try {
			await this.workspaceState.update(CODEX_DURABLE_CONVERSATION_STATE_KEY, entries);
			this.logSink?.log("codex.session_state.persisted", {
				threadCount: entries.length,
				threadIds: entries.map(entry => entry.threadId),
			});
		} catch (error) {
			this.logSink?.logError("codex.session_state.persist_failed", error);
		}
	}

	private async reattachDurableThread(conversation: CodexConversationThread): Promise<boolean> {
		try {
			const resumed = await this.client.request<CodexThreadResumeResponse>("thread/resume", {
				threadId: conversation.threadId,
				excludeTurns: true,
			}, 15_000);
			if (resumed.thread.id !== conversation.threadId) {
				throw new Error(
					`Codex resumed unexpected thread ${resumed.thread.id}; expected ${conversation.threadId}`
				);
			}
			assertCodexThreadPersistence(false, resumed.thread.ephemeral);
			conversation.processGeneration = this.client.generation;
			this.logSink?.log("codex.chat.thread_reattached", {
				threadId: conversation.threadId,
				historyMode: resumed.thread.historyMode,
				conversationIdPresent: conversation.copilotConversationId !== undefined,
			});
			return true;
		} catch (error) {
			this.logSink?.logError("codex.chat.thread_reattach_failed", error, {
				threadId: conversation.threadId,
			});
			this.conversationThreads.delete(conversation.threadId);
			void this.persistDurableConversationThreads();
			return false;
		}
	}

	private mapKnownModels(): vscode.LanguageModelChatInformation[] {
		const config = this.getConfig();
		const contextLength = this.clampNumber(
			config.get("codexContextLength", DEFAULT_CODEX_CONTEXT_LENGTH),
			32_768,
			1_048_576,
			DEFAULT_CODEX_CONTEXT_LENGTH
		);
		const maxOutputTokens = this.clampNumber(
			config.get("codexMaxOutputTokens", DEFAULT_CODEX_MAX_OUTPUT_TOKENS),
			1_024,
			131_072,
			DEFAULT_CODEX_MAX_OUTPUT_TOKENS
		);
		const models = [...this.models.values()];
		setSubagentModelProfiles("codex", models.map(model => ({
			id: model.id,
			label: model.displayName,
			provider: "codex",
			defaultEffort: "high",
			availability: "available",
			availabilityReason: "Model is present in the current ChatGPT subscription catalog",
			availabilityCheckedAt: Date.now(),
			useWhen: "Use for repository-wide, multi-step coding or high-confidence verification",
		})));
		return models.map(model => mapCodexModelInformation(model, contextLength, maxOutputTokens));
	}

	private async requireSubscriptionAccount(): Promise<CodexChatGptAccount> {
		const cached = this.accountCache;
		if (
			cached
			&& cached.generation === this.client.generation
			&& cached.expiresAt > Date.now()
		) {
			return cached.account;
		}
		try {
			const account = await this.client.request<CodexAccountResponse>("account/read", { refreshToken: true });
			if (!account.account) {
				throw new Error("Codex is not signed in. Run Local LLM: Sign In to Codex Subscription.");
			}
			if (account.account.type !== "chatgpt") {
				throw new Error(
					"Codex is authenticated with an API key or another provider. Sign in with ChatGPT before using the subscription model."
				);
			}
			this.cacheSubscriptionAccount(account.account);
			return account.account;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("logged out") || msg.includes("signed in to another")) {
				this.accountCache = undefined;
				this.logSink?.log("codex.auth.reconnecting", { reason: msg.slice(0, 200) });
				try {
					await this.client.restart();
				} catch (restartError) {
					this.logSink?.logError("codex.auth.restart_failed", restartError);
				}
				const account = await this.client.request<CodexAccountResponse>("account/read", { refreshToken: true });
				if (!account.account || account.account.type !== "chatgpt") {
					throw new Error("Codex session expired. Run Local LLM: Sign In to Codex Subscription.");
				}
				this.cacheSubscriptionAccount(account.account);
				return account.account;
			}
			throw error;
		}
	}

	private cacheSubscriptionAccount(account: CodexChatGptAccount): void {
		this.accountCache = {
			account,
			generation: this.client.generation,
			expiresAt: Date.now() + CODEX_ACCOUNT_CACHE_TTL_MS,
		};
	}

	private refreshStatusIfStale(): void {
		if (Date.now() - this.lastStatusRefreshAt < CODEX_STATUS_REFRESH_INTERVAL_MS) {
			return;
		}
		void this.refreshStatus().catch(error => this.logSink?.logError("codex.status.background_failed", error));
	}

	private async handleServerRequest(request: CodexServerRequest): Promise<unknown> {
		const params = asRecord(request.params);
		const requestThreadId = typeof params.threadId === "string" ? params.threadId : "";
		switch (request.method) {
			case "item/commandExecution/requestApproval": {
				this.logSink?.log("codex.internal_tool.declined", { threadId: requestThreadId, kind: "command" }, "warn");
				return { decision: "decline" };
			}
			case "item/fileChange/requestApproval": {
				this.logSink?.log("codex.internal_tool.declined", { threadId: requestThreadId, kind: "fileChange" }, "warn");
				return { decision: "decline" };
			}
			case "item/permissions/requestApproval": {
				this.logSink?.log("codex.internal_tool.declined", { threadId: requestThreadId, kind: "permissions" }, "warn");
				return { permissions: {}, scope: "turn" };
			}
			case "item/tool/call":
				return this.handleDynamicToolCall(params);
			default:
				throw new CodexAppServerError(`Unsupported Codex interaction: ${request.method}`, -32601);
		}
	}

	private handleDynamicToolCall(params: Record<string, unknown>): Promise<CodexDynamicToolCallResponse> | CodexDynamicToolCallResponse {
		const threadId = typeof params.threadId === "string" ? params.threadId : "";
		const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
		const callId = typeof params.callId === "string" ? params.callId : "";
		const tool = typeof params.tool === "string" ? params.tool : "";
		const namespace = params.namespace;
		const context = this.dynamicToolContexts.get(threadId);
		const actualNamespace = typeof namespace === "string" ? namespace : null;
		const expectedNamespace = context?.toolNamespaces.get(tool) ?? null;
		if (
			!context
			|| !callId
			|| !tool
			|| !context.callableNames.has(tool)
			|| actualNamespace !== expectedNamespace
		) {
			return {
				contentItems: [{ type: "inputText", text: `VS Code tool is unavailable: ${tool || "unknown"}` }],
				success: false,
			};
		}
		const input = asRecord(params.arguments);
		return context.delegate({ callId, tool, input, turnId });
	}

	private waitForLogin(loginId: string): Promise<CodexLoginCompletedParams> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				disposable.dispose();
				reject(new Error("Timed out waiting for ChatGPT sign-in"));
			}, 5 * 60_000);
			const disposable = this.client.onNotification(notification => {
				if (notification.method !== "account/login/completed") {
					return;
				}
				const params = notification.params as CodexLoginCompletedParams;
				if (params.loginId !== loginId) {
					return;
				}
				clearTimeout(timer);
				disposable.dispose();
				resolve(params);
			});
		});
	}

	private selectRateLimit(response: CodexRateLimitsResponse) {
		return response.rateLimitsByLimitId?.codex ?? response.rateLimits;
	}

	private setStatus(status: CodexProviderStatus): CodexProviderStatus {
		if (
			status.state !== this.status.state ||
			status.summary !== this.status.summary ||
			status.usage !== this.status.usage
		) {
			this.status = status;
			this.statusChanges.fire(status);
		}
		return this.status;
	}

	private isEnabled(): boolean {
		return this.getConfig().get<boolean>("enableCodexSubscription", true) !== false;
	}

	private getConfig(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration("llamacpp");
	}

	private formatPlan(plan: string): string {
		return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "ChatGPT";
	}

	private clampNumber(value: unknown, min: number, max: number, fallback: number): number {
		return typeof value === "number" && Number.isFinite(value)
			? Math.max(min, Math.min(max, Math.floor(value)))
			: fallback;
	}
}
