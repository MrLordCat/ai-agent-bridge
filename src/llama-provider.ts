
import * as vscode from "vscode";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    ProvideLanguageModelChatResponseOptions,
    LanguageModelResponsePart,
    Progress,
} from "vscode";
import { BaseChatModelProvider, DEFAULT_CONTEXT_LENGTH, DEFAULT_MAX_OUTPUT_TOKENS } from "./base-provider";
import {
    CONFIG_SECTION,
    DEFAULT_LOCAL_REASONING_BUDGET,
    DEEPSEEK_CONTEXT_LENGTH,
    DEFAULT_DEEPSEEK_CONTEXT_LIMIT,
    DEEPSEEK_MAX_OUTPUT_TOKENS,
    DEFAULT_SERVER_URL,
} from "./constants";
import { calculateContextBudget, estimateContextUsage, selectContextCompaction } from "./context/context-budget";
import { compactMessages } from "./context/message-compaction";
import { resolveOutputTokenBudget } from "./context/output-budget";
import { ServerTokenCounter } from "./context/server-token-counter";
import {
    buildKnowledgeSystemPrompt,
    formatLocalDate,
    injectKnowledgeSystemPrompt,
    normalizeKnowledgeMode,
} from "./context/system-prompt";
import { summarizeToolResultContent } from "./context/tool-result-summary";
import { calculatePromptCacheUsage, estimateChatTokenUsage, mergeChatTokenUsage, type ChatTokenUsage } from "./context/usage";
import { buildCacheDiagnostics, type CachePrefixTelemetry } from "./context/cache-diagnostics";
import {
    calculateOverallHealth,
    type HealthCheckItem,
    type ProviderHealthReport,
    type ProviderHealthSourceReport,
} from "./diagnostics/provider-health";
import { BoundedMap, convertMessages, convertTools, stableJsonStringify, validateRequest, type ToolCallingMode, type ToolResultMode } from "./utils";
import { LlamaLogSink } from "./logger";
import { buildMemoryQuery, injectSharedMemoryContext } from "./memory/prompt";
import { getCurrentWorkspaceScopeId } from "./memory/scope";
import type { SharedMemoryContextProvider, SharedMemoryPromptContext } from "./memory/types";
import { setSubagentModelProfiles } from "./subagent-guidance";
import {
    createModelSources,
    encodeProviderModelId,
    normalizeServerUrl,
    parseProviderModelId,
    resolveModelFamily,
    type ChatModelSource,
    type LlamaCppModelInfo,
} from "./model-sources/source-routing";
import {
    createReasoningConfigurationSchema,
    resolveReasoningBudget,
    resolveRequestThinkingMode,
} from "./reasoning";
import { buildChatCompletionRequest } from "./request/chat-request";
import { SerialRequestQueue, type ChatRequestSlotLease } from "./transport/request-queue";
import {
    detectRepeatedToolCallLoop,
    injectToolLoopGuard,
    ToolCallValidationError,
    type ToolCallReliabilityMetrics,
} from "./tools/tool-call-reliability";
import {
    getChatCompletionsEndpoint,
    getModelsEndpoint,
    isDeepSeekEndpoint,
    isTransientHttpStatus,
    OpenAIHttpTransport,
    parseRetryAfterMs,
} from "./transport/openai-http";
import type { OpenAIChatMessage } from "./types";

type ToolResultModeConfig = "auto" | "tool" | "user";
type ToolCallingModeConfig = "classic" | "apiDirect";

const MAX_CONTEXT_LENGTH = 1048576;
interface ModelListCacheEntry {
    serverUrl: string;
    apiKeyPresent: boolean;
    fetchedAt: number;
    models: LlamaCppModelInfo[];
}

interface ModelListInflightEntry {
    serverUrl: string;
    apiKeyPresent: boolean;
    promise: Promise<LlamaCppModelInfo[]>;
}

interface RuntimeContextCacheEntry {
    serverUrl: string;
    apiKeyPresent: boolean;
    fetchedAt: number;
    contextLength: number;
}

export interface LlamaChatUsageSegmentMetrics {
    index: number;
    recordedAt: string;
    inputTokens: number;
    cachedInputTokens: number;
    freshInputTokens?: number;
    cacheCreationInputTokens?: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
    cacheHitPercent?: number;
}

export interface LlamaChatTurnStepMetrics {
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
    cacheCreationInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
    totalTokens?: number;
    cacheHitPercent?: number;
}

export interface LlamaChatTurnMetrics {
    requestId: string;
    modelId: string;
    providerKind?: "local" | "deepseek" | "codex" | "claude";
    lifecyclePhase?: "running" | "completed" | "timed_out" | "interrupted" | "abandoned" | "failed";
    terminalDetail?: string;
    threadMode?: "new" | "reused" | "tool-resume" | "interrupted-resume" | "rollover";
    sessionMode?: "new" | "warm" | "restored" | "rollover" | "resume-fallback";
    threadReuseMissReason?: string;
    conversationKey?: string;
    durationMs: number;
    queueWaitMs: number;
    firstTokenLatencyMs?: number;
    /** Time until the first user-visible assistant text, when distinct from first model activity. */
    firstVisibleLatencyMs?: number;
    emittedParts: number;
    outputChars: number;
    thinkingChars: number;
    estimatedOutputTokens: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
    tokensPerSecond?: number;
    promptTokens: number;
    cachedPromptTokens?: number;
    cacheWriteInputTokens?: number;
    promptCacheHitPercent?: number;
    initialSegmentCacheHitPercent?: number;
    continuationCacheHitPercent?: number;
    finalSegmentInputTokens?: number;
    finalSegmentCachedInputTokens?: number;
    /** Classified reason when upstream prompt cache missed most of the prefix. */
    cacheMissReason?: string;
    /** Human-readable explanation for the cache miss. */
    cacheMissDetail?: string;
    /** Classified original error from a rejected Claude durable resume. */
    resumeFailureReason?: string;
    /** Lifecycle stage at which Claude durable resume failed. */
    resumeFailureStage?: string;
    /** Original truncated SDK error before Claude switched to full-input fallback. */
    resumeFailureDetail?: string;
    /** Policy decision made before a Claude full-input resume fallback. */
    resumeFallbackDecision?: string;
    /** Estimated cold replay size, including the advertised tool schema. */
    resumeFallbackEstimatedInputTokens?: number;
    /** Configured maximum estimated replay size for automatic fallback. */
    resumeFallbackMaxInputTokens?: number;
    /** Configured Agent SDK model-segment limit for this outer turn. */
    turnMaxModelSegments?: number;
    /** Configured cumulative processed-input limit for this outer turn. */
    turnMaxCumulativeInputTokens?: number;
    /** Safety guard that stopped an expensive Claude turn. */
    safetyStopReason?: string;
    /** Human-readable safety stop explanation. */
    safetyStopDetail?: string;
    /** Number of leading messages that matched the previous request byte-for-byte. */
    prefixIdenticalMessageCount?: number;
    /** Total message count in the previous request, for comparison. */
    prefixPreviousMessageCount?: number;
    /** Percentage of previous message characters that reappeared in the current prefix. */
    prefixReusableMessagePercent?: number;
    /** Whether static request fields (temperature, model, etc.) matched the previous turn. */
    prefixStaticFieldsMatch?: boolean;
    /** Whether the tool catalog was unchanged from the previous turn. */
    prefixToolsMatch?: boolean;
    /** True when this turn was executed by a subagent rather than the main conversation. */
    isSubagent?: boolean;
    /** Codex input mode for this turn: full / user-turn / tool-result. */
    inputMode?: string;
    /** True when auto-compaction reduced the message count this turn. */
    compacted?: boolean;
    parentRequestId?: string;
    parentToolCallId?: string;
    /** CloudFront/ELB `Via` header — identifies the backend edge node. */
    backendVia?: string;
    /** CloudFront `X-Amz-Cf-Pop` header — geographic edge location. */
    backendCfPop?: string;
    /** DeepSeek `x-ds-trace-id` header — internal request trace. */
    backendTraceId?: string;
    modelTurns: number;
    usageEstimated: boolean;
    retriedAfterOverflow: boolean;
    toolCalls: number;
    delegatedToolCalls?: number;
    catalogToolCalls?: number;
    toolDurationTotalMs?: number;
    averageToolDurationMs?: number;
    maximumToolDurationMs?: number;
    p95ToolDurationMs?: number;
    toolCallBreakdown?: Record<string, number>;
    usageSegments?: LlamaChatUsageSegmentMetrics[];
    usageSegmentsTruncated?: boolean;
    steps?: LlamaChatTurnStepMetrics[];
    metricsSource?: "rollout" | "live";
    repairedToolCalls: number;
    rejectedToolCalls: number;
    schemaRejectedToolCalls: number;
    toolCallRepairRetries: number;
    toolLoopDetected: boolean;
}

export interface LlamaChatContextUsageMetrics {
    requestId: string;
    modelId: string;
    attemptNo: number;
    contextLength: number;
    inputBudget: number;
    softInputTarget: number;
    hardInputTarget: number;
    messageTokensBeforeCompact: number;
    messageTokensAfterCompact: number;
    messageCountBeforeCompact: number;
    messageCountAfterCompact: number;
    toolTokens: number;
    /** Context tokens not attributed to compacted messages or tool schemas. */
    otherTokens?: number;
    replyReserveTokens: number;
    cappedTools: number;
    autoCompacted: boolean;
    hardCompacted: boolean;
    estimatedUsedTokens: number;
    estimatedFreeTokens: number;
    estimatedUsagePercent: number;
    tokenCountSource: "server" | "heuristic";
    rawMaxTokens?: number;
    usableMaxTokens?: number;
    categories?: Array<{ name: string; tokens: number }>;
}

interface PreparedMessagesForBudget {
    messages: OpenAIChatMessage[];
    initialTokenEstimate: number;
    finalTokenEstimate: number;
    initialMessageCount: number;
    finalMessageCount: number;
    autoCompacted: boolean;
    hardCompacted: boolean;
    hardTarget: number;
    tokenCountSource: "server" | "heuristic";
}

interface CachePrefixSnapshot {
    requestId: string;
    staticFieldsHash: string;
    toolsHash: string;
    toolsCount: number;
    systemHash?: string;
    messageParts: string[];
    messageChars: number;
}

interface StableToolCatalogSnapshot {
    tools: NonNullable<ReturnType<typeof convertTools>["tools"]>;
    toolChoice: ReturnType<typeof convertTools>["tool_choice"];
    fingerprint: string;
    updatedAt: number;
}

interface ConversationMessageSnapshot {
    messages: OpenAIChatMessage[];
    tokenCount: number;
    updatedAt: number;
    migratedFromPrefix?: boolean;
}

const CACHE_CONTROL_MARKER = /"mimeType"\s*:\s*"cache_control"/g;
const CACHE_CONTROL_TEXT_MARKER = /\[data cache_control(?:,[^\]\n]*)?\]/g;

/** Spans of every balanced JSON object in the text, string literals respected. */
function collectJsonObjectSpans(text: string): Array<{ start: number; end: number }> {
    const spans: Array<{ start: number; end: number }> = [];
    const stack: number[] = [];
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (code === 92 /* \ */) {
                escaped = true;
            } else if (code === 34 /* " */) {
                inString = false;
            }
            continue;
        }
        if (code === 34 /* " */) {
            inString = true;
        } else if (code === 123 /* { */) {
            stack.push(index);
        } else if (code === 125 /* } */) {
            const start = stack.pop();
            if (start !== undefined) {
                spans.push({ start, end: index + 1 });
            }
        }
    }
    return spans;
}

/**
 * Removes VS Code cache-breakpoint markers from tool result text.
 *
 * VS Code renders these markers in more than one shape (`{"$mid":N,...,"data":"..."}`
 * and `{"type":"data",...,"bytes":N}`) and moves them between messages as the
 * conversation grows. Any marker left behind rewrites historical tool output on
 * a later turn and destroys the upstream prompt-cache prefix, so every shape has
 * to be stripped by locating the innermost object that carries the mime type.
 */
export function stripCacheControlArtifacts(text: string): string {
    if (!text.includes("cache_control")) {
        return text;
    }

    const markers: number[] = [];
    CACHE_CONTROL_MARKER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CACHE_CONTROL_MARKER.exec(text)) !== null) {
        markers.push(match.index);
    }

    let result = text;
    if (markers.length > 0) {
        const spans = collectJsonObjectSpans(text);
        const chosen: Array<{ start: number; end: number }> = [];
        for (const position of markers) {
            let innermost: { start: number; end: number } | undefined;
            for (const span of spans) {
                if (span.start > position || position >= span.end) {
                    continue;
                }
                if (!innermost || span.end - span.start < innermost.end - innermost.start) {
                    innermost = span;
                }
            }
            if (innermost) {
                chosen.push(innermost);
            }
        }

        if (chosen.length > 0) {
            chosen.sort((left, right) => left.start - right.start);
            const merged: Array<{ start: number; end: number }> = [];
            for (const span of chosen) {
                const last = merged[merged.length - 1];
                if (last && span.start <= last.end) {
                    last.end = Math.max(last.end, span.end);
                } else {
                    merged.push({ ...span });
                }
            }
            let rebuilt = "";
            let cursor = 0;
            for (const span of merged) {
                rebuilt += text.slice(cursor, span.start);
                cursor = span.end;
            }
            result = rebuilt + text.slice(cursor);
        }
    }

    return result.replace(CACHE_CONTROL_TEXT_MARKER, "");
}

/**
 * Chat model provider for Llama.cpp servers.
 * Implements the VS Code language model chat provider interface for Llama.cpp compatible APIs.
 * Handles model discovery, chat responses, and streaming from local Llama.cpp instances.
 *
 */
export class LlamaCppChatModelProvider extends BaseChatModelProvider {
    private readonly _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;
    private readonly _onDidUpdateContextUsage = new vscode.EventEmitter<LlamaChatContextUsageMetrics>();
    readonly onDidUpdateContextUsage = this._onDidUpdateContextUsage.event;
    private readonly _onDidCompleteChatTurn = new vscode.EventEmitter<LlamaChatTurnMetrics>();
    readonly onDidCompleteChatTurn = this._onDidCompleteChatTurn.event;
    private readonly modelListCache = new Map<string, ModelListCacheEntry>();
    private readonly modelListInflight = new Map<string, ModelListInflightEntry>();
    private readonly runtimeContextCache = new Map<string, RuntimeContextCacheEntry>();
    private readonly cachePrefixSnapshots = new BoundedMap<string, CachePrefixSnapshot>(32);
    private readonly stableToolCatalogs = new BoundedMap<string, StableToolCatalogSnapshot>(32);
    private readonly conversationMessageSnapshots = new BoundedMap<string, ConversationMessageSnapshot>(4);
    private readonly chatRequestQueue: SerialRequestQueue;
    private reasoningMapLoaded = false;
    private readonly httpTransport = new OpenAIHttpTransport();
    private readonly serverTokenCounter = new ServerTokenCounter(
        (url, init, timeoutMs, cancellation) => this.httpTransport.request(url, init, timeoutMs, cancellation)
    );
    /**
     * Running calibration factor for the heuristic token counter.
     * Updated after every turn with server-reported prompt_tokens so the
     * heuristic converges toward the actual tokenizer even for tool-heavy
     * conversations where chars/4 is inaccurate.
     * 1.0 = no correction; <1.0 = heuristic over-estimates; >1.0 = under-estimates.
     */
    private heuristicCalibration = 1.0;

    /**
     * When a turn was sent with a compacted history, records when that request
     * left this extension. DeepSeek materializes the new disk-cache prefix
     * asynchronously, so the immediately following tool-result round may miss
     * even with an identical prefix. The grace wait lets the write land first.
     */
    private readonly lastCompactionSentAtByScope = new Map<string, number>();
    private readonly lastTurnCompactedByScope = new Map<string, boolean>();
    private readonly lastResponseEndedAtByScope = new Map<string, number>();
    private deepSeekBalance: { summary: string; fetchedAt: number } | undefined;
    private deepSeekBalanceInflight: Promise<string | undefined> | undefined;

    /**
     * Creates a new Llama.cpp chat model provider.
     * Initializes the provider with secret storage and user agent for API requests.
     *
     * @param secrets - VS Code secret storage for storing server URL and API key.
     * @param userAgent - User agent string to include in HTTP requests.
     */
    constructor(
        secrets: vscode.SecretStorage,
        private readonly userAgent: string,
        private readonly logger?: LlamaLogSink,
        private readonly sharedMemory?: SharedMemoryContextProvider,
        private readonly globalState?: vscode.Memento
    ) {
        super(secrets);
        this.chatRequestQueue = new SerialRequestQueue(event => {
            const { type, ...data } = event;
            this.log(`chat.queue.${type}`, data);
        });
        this.loadPersistedPrefixSnapshots();
        this.loadPersistedContinuationState();
    }

    refreshLanguageModelChatInformation(): void {
        this.modelListCache.clear();
        this.runtimeContextCache.clear();
        this.serverTokenCounter.clear();
        this.log("models.refresh.requested");
        this._onDidChangeLanguageModelChatInformation.fire();
    }

    async runHealthCheck(extensionVersion: string, token: CancellationToken): Promise<ProviderHealthReport> {
        const cfg = this.getConfig();
        const configurationChecks: HealthCheckItem[] = [
            {
                id: "tool-call-repair",
                label: "Tool-call repair",
                status: cfg.get<boolean>("toolCallRepairEnabled", true) !== false ? "pass" : "warning",
                detail: cfg.get<boolean>("toolCallRepairEnabled", true) !== false
                    ? "Bounded deterministic repair and one correction retry are enabled."
                    : "Disabled; malformed model tool calls can fail the turn.",
            },
            {
                id: "tool-schema-validation",
                label: "Tool schema validation",
                status: cfg.get<boolean>("validateToolCallSchema", true) !== false ? "pass" : "warning",
                detail: cfg.get<boolean>("validateToolCallSchema", true) !== false
                    ? "Tool arguments are checked against the advertised schema before execution."
                    : "Disabled; extra or missing arguments may reach VS Code tools.",
            },
            {
                id: "tool-loop-protection",
                label: "Tool loop protection",
                status: cfg.get<boolean>("toolLoopProtection", true) !== false ? "pass" : "warning",
                detail: cfg.get<boolean>("toolLoopProtection", true) !== false
                    ? "Repeated identical calls are detected from conversation history."
                    : "Disabled.",
            },
            {
                id: "api-direct",
                label: "API Direct",
                status: String(cfg.get("toolCallingMode", "apiDirect")) === "apiDirect" ? "pass" : "warning",
                detail: `Mode: ${String(cfg.get("toolCallingMode", "apiDirect"))}.`,
            },
            {
                id: "knowledge-policy",
                label: "Knowledge verification",
                status: String(cfg.get("knowledgeMode", "adaptive")) === "off" ? "warning" : "pass",
                detail: `Mode: ${String(cfg.get("knowledgeMode", "adaptive"))}.`,
            },
            {
                id: "memory",
                label: "Scoped shared memory",
                status: cfg.get<boolean>("memoryEnabled", true) !== false ? "pass" : "info",
                detail: cfg.get<boolean>("memoryEnabled", true) !== false
                    ? "Enabled with scope, provenance, expiry, and hybrid retrieval."
                    : "Disabled by configuration.",
            },
        ];

        const sources = await this.getModelSources();
        const sourceReports = await Promise.all(sources.map(async source => {
            const checks: HealthCheckItem[] = [];
            let models: LlamaCppModelInfo[] = [];
            try {
                models = await this.fetchModels(source.serverUrl, source.apiKey);
                checks.push({
                    id: "model-discovery",
                    label: "Model discovery",
                    status: models.length > 0 ? "pass" : "fail",
                    detail: models.length > 0 ? `${models.length} model(s) returned.` : "The endpoint returned no models.",
                });
            } catch (error) {
                checks.push({
                    id: "model-discovery",
                    label: "Model discovery",
                    status: "fail",
                    detail: error instanceof Error ? error.message : String(error),
                });
            }

            const deprecatedAliases = models
                .map(model => model.id)
                .filter(id => id === "deepseek-chat" || id === "deepseek-reasoner");
            if (deprecatedAliases.length > 0) {
                checks.push({
                    id: "deprecated-model-alias",
                    label: "DeepSeek model aliases",
                    status: "warning",
                    detail: `${deprecatedAliases.join(", ")} are deprecated; select deepseek-v4-flash or deepseek-v4-pro.`,
                });
            }

            if (isDeepSeekEndpoint(source.serverUrl)) {
                checks.push(
                    {
                        id: "deepseek-cache",
                        label: "Prompt cache",
                        status: "info",
                        detail: "DeepSeek disk context caching is automatic; hit/miss tokens are read from usage.",
                    },
                    {
                        id: "deepseek-tokenizer",
                        label: "Exact preflight tokenizer",
                        status: "info",
                        detail: "DeepSeek does not expose llama.cpp /apply-template and /tokenize; conservative preflight estimation is expected.",
                    }
                );
            } else if (models.length > 0) {
                const runtimeContext = await this.fetchRuntimeContextLength(source.serverUrl, source.apiKey);
                checks.push({
                    id: "runtime-context",
                    label: "Runtime context",
                    status: runtimeContext === undefined ? "warning" : "pass",
                    detail: runtimeContext === undefined
                        ? "The /slots runtime context probe is unavailable; configured/model fallback will be used."
                        : `${runtimeContext} tokens reported by /slots.`,
                });

                const headers: Record<string, string> = {
                    "User-Agent": this.userAgent,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                };
                if (source.apiKey) {
                    headers.Authorization = `Bearer ${source.apiKey}`;
                }
                const tokenCount = await this.serverTokenCounter.countChatPrompt({
                    serverUrl: source.serverUrl,
                    model: models[0].id,
                    headers,
                    messages: [{ role: "user", content: "health check" }],
                    timeoutMs: this.clampInt(cfg.get("tokenizerTimeoutMs", 10000), 1000, 30000, 10000),
                    cancellation: token,
                });
                checks.push({
                    id: "exact-tokenizer",
                    label: "Exact prompt tokenizer",
                    status: tokenCount === undefined ? "warning" : "pass",
                    detail: tokenCount === undefined
                        ? "/apply-template or /tokenize is unavailable; heuristic fallback will be used."
                        : `Template and tokenizer probe succeeded (${tokenCount} tokens).`,
                });
                checks.push({
                    id: "local-prompt-cache",
                    label: "Local prompt cache",
                    status: cfg.get<boolean>("cachePrompt", true) !== false ? "pass" : "warning",
                    detail: cfg.get<boolean>("cachePrompt", true) !== false
                        ? "cache_prompt is enabled for local chat requests."
                        : "cache_prompt is disabled.",
                });
            }

            return {
                key: source.key,
                label: source.label,
                serverUrl: source.serverUrl,
                modelIds: models.map(model => model.id),
                checks,
            } satisfies ProviderHealthSourceReport;
        }));

        const allChecks = [...configurationChecks, ...sourceReports.flatMap(source => source.checks)];
        const report: ProviderHealthReport = {
            generatedAt: new Date().toISOString(),
            extensionVersion,
            vscodeVersion: vscode.version,
            overallStatus: calculateOverallHealth(allChecks),
            configurationChecks,
            sources: sourceReports,
        };
        this.log("diagnostics.health.complete", {
            overallStatus: report.overallStatus,
            sourceCount: report.sources.length,
            checks: allChecks.map(check => ({ id: check.id, status: check.status })),
        });
        return report;
    }

    private getConfig(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration(CONFIG_SECTION);
    }

    private log(event: string, data?: unknown): void {
        this.logger?.log(event, data);
    }

    private logError(event: string, error: unknown, data?: unknown): void {
        this.logger?.logError(event, error, data);
    }

    private cloneForLog(value: unknown): unknown {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return String(value);
        }
    }

    private summarizeContentForLog(content: OpenAIChatMessage["content"]): {
        kind: "empty" | "text" | "parts";
        textChars: number;
        partCount?: number;
        imageParts?: number;
    } {
        if (typeof content === "string") {
            return { kind: "text", textChars: content.length };
        }

        if (Array.isArray(content)) {
            let textChars = 0;
            let imageParts = 0;
            for (const part of content) {
                if (part.type === "text" && typeof part.text === "string") {
                    textChars += part.text.length;
                } else if (part.type === "image_url") {
                    imageParts += 1;
                }
            }
            return {
                kind: "parts",
                textChars,
                partCount: content.length,
                imageParts,
            };
        }

        return { kind: "empty", textChars: 0 };
    }

    private summarizeMessagesForLog(messages: unknown): Record<string, unknown> {
        if (!Array.isArray(messages)) {
            return { count: 0 };
        }

        const roles: Record<string, number> = {};
        let textChars = 0;
        let contentParts = 0;
        let imageParts = 0;
        let toolCallCount = 0;
        let toolResultCount = 0;
        const tailRoles: string[] = [];

        for (const item of messages) {
            if (!item || typeof item !== "object") {
                continue;
            }
            const msg = item as OpenAIChatMessage;
            const role = typeof msg.role === "string" ? msg.role : "unknown";
            roles[role] = (roles[role] ?? 0) + 1;
            tailRoles.push(role);
            if (tailRoles.length > 8) {
                tailRoles.shift();
            }

            const contentSummary = this.summarizeContentForLog(msg.content);
            textChars += contentSummary.textChars;
            contentParts += contentSummary.partCount ?? 0;
            imageParts += contentSummary.imageParts ?? 0;

            if (Array.isArray(msg.tool_calls)) {
                toolCallCount += msg.tool_calls.length;
            }
            if (role === "tool" || typeof msg.tool_call_id === "string") {
                toolResultCount += 1;
            }
        }

        return {
            count: messages.length,
            roles,
            tailRoles,
            textChars,
            contentParts,
            imageParts,
            toolCallCount,
            toolResultCount,
        };
    }

    private summarizeToolsForLog(tools: unknown): Record<string, unknown> {
        if (!Array.isArray(tools)) {
            return { count: 0 };
        }

        const names = tools
            .map(tool => {
                if (!tool || typeof tool !== "object") {
                    return undefined;
                }
                const fn = (tool as Record<string, unknown>)["function"];
                if (!fn || typeof fn !== "object") {
                    return undefined;
                }
                const name = (fn as Record<string, unknown>)["name"];
                return typeof name === "string" ? name : undefined;
            })
            .filter((name): name is string => typeof name === "string");

        return {
            count: tools.length,
            names: names.slice(0, 32),
            omittedNames: Math.max(0, names.length - 32),
            fingerprint: this.shortHash(stableJsonStringify(tools)),
        };
    }

    private shortHash(value: string): string {
        return createHash("sha256").update(value).digest("hex").slice(0, 16);
    }

    private cachePrefixScope(
        modelId: string,
        options: ProvideLanguageModelChatResponseOptions
    ): string | undefined {
        const modelOptions = options.modelOptions as Record<string, unknown> | undefined;
        const conversationId = typeof modelOptions?._copilotConversationId === "string"
            ? modelOptions._copilotConversationId.trim()
            : "";
        if (conversationId) {
            return [modelId, conversationId].join("\0");
        }
        const trace = modelOptions?._otelTraceContext;
        const traceRecord = trace && typeof trace === "object"
            ? trace as Record<string, unknown>
            : undefined;
        const traceId = typeof traceRecord?.traceId === "string" ? traceRecord.traceId : "";
        const spanId = typeof traceRecord?.spanId === "string" ? traceRecord.spanId : "";
        if (!traceId && !spanId) {
            return undefined;
        }
        return [modelId, traceId, spanId].join("\0");
    }

    private stabilizeToolCatalog(
        modelId: string,
        options: ProvideLanguageModelChatResponseOptions,
        config: ReturnType<typeof convertTools>,
        messages: readonly OpenAIChatMessage[],
        requestId: string
    ): ReturnType<typeof convertTools> {
        const scope = this.cachePrefixScope(modelId, options);
        if (
            !scope
            || options.toolMode === vscode.LanguageModelChatToolMode.Required
            || !Array.isArray(config.tools)
        ) {
            return config;
        }

        const availableNames = new Set((options.tools ?? []).map(tool => tool.name));
        // Sort tools by name for stable fingerprinting — VS Code can change
        // enumeration order between restarts.
        const sortedTools = Array.isArray(config.tools)
            ? [...config.tools].sort((a, b) => {
                const na = a.function?.name ?? "";
                const nb = b.function?.name ?? "";
                return na < nb ? -1 : na > nb ? 1 : 0;
            })
            : config.tools;
        const currentFingerprint = this.shortHash(stableJsonStringify(sortedTools));
        const previous = this.stableToolCatalogs.get(scope);
        const recentActivation = messages.slice(-8).some(message =>
            message.role === "assistant"
            && message.tool_calls?.some(call => call.function.name.startsWith("activate_"))
        );
        const previousStillAvailable = previous?.tools.every(tool =>
            availableNames.has(tool.function.name)
        ) === true;

        if (previous && previousStillAvailable && !recentActivation) {
            this.stableToolCatalogs.delete(scope);
            this.stableToolCatalogs.set(scope, previous);
            if (previous.fingerprint !== currentFingerprint) {
                this.log("chat.tools.catalog_stabilized", {
                    requestId,
                    modelId,
                    retainedToolCount: previous.tools.length,
                    currentToolCount: config.tools.length,
                    retainedFingerprint: previous.fingerprint,
                    currentFingerprint,
                });
            }
            return {
                ...config,
                tools: previous.tools,
                tool_choice: previous.toolChoice,
            };
        }

        const next: StableToolCatalogSnapshot = {
            tools: (sortedTools ?? []) as NonNullable<ReturnType<typeof convertTools>["tools"]>,
            toolChoice: config.tool_choice,
            fingerprint: currentFingerprint,
            updatedAt: Date.now(),
        };
        this.stableToolCatalogs.set(scope, next);
        if (previous) {
            const previousNames = new Set(previous.tools.map(tool => tool.function.name));
            const currentNames = new Set(sortedTools.map(tool => tool.function.name));
            this.log("chat.tools.catalog_refreshed", {
                requestId,
                modelId,
                reason: recentActivation ? "activation" : "tool-unavailable",
                previousToolCount: previous.tools.length,
                currentToolCount: sortedTools.length,
                removedTools: [...previousNames].filter(name => !currentNames.has(name)).sort(),
                addedTools: [...currentNames].filter(name => !previousNames.has(name)).sort(),
                previousFingerprint: previous.fingerprint,
                currentFingerprint,
            });
        } else {
            this.log("chat.tools.catalog_snapshot", {
                requestId,
                modelId,
                toolCount: sortedTools.length,
                fingerprint: currentFingerprint,
            });
        }
        return config;
    }

    /**
     * Pins the common prefix of consecutive requests so the upstream prompt cache
     * stays warm even when VS Code rewrites historical message content between
     * turns.
     *
     * Two strategies:
     *
     * 1. **Byte-level match (fast path).**  If the first N messages match the
     *    previous snapshot byte-for-byte, N cached copies replace the current
     *    prefix and only the tail is taken fresh.
     *
     * 2. **Aggressive fallback (VS Code rewrite).**  When VS Code rewrites the
     *    entire history while keeping the message count and tool catalog
     *    unchanged, every byte-level comparison after index 1 fails.  In that
     *    case the *entire* previous snapshot is reused as the prefix (truncated
     *    to `min(prev.length, cur.length)` so we never exceed the budget VS Code
     *    already approved).  The previous messages were already sent to the API
     *    and are guaranteed to be in the upstream disk cache, so reusing them
     *    keeps the prefix warm without changing the conversation semantics.
     *
     * Also stores the current snapshot so the next turn can compare against it,
     * and returns prefix telemetry for cache diagnostics.
     */
    private stabilizeMessagePrefix(
        requestId: string,
        modelId: string,
        scope: string | undefined,
        messages: OpenAIChatMessage[],
        staticFieldsHash: string,
        toolsHash: string,
        toolsCount: number,
    ): { messages: OpenAIChatMessage[]; stabilized: boolean; prefix: Record<string, unknown> } {
        if (!scope) {
            return { messages, stabilized: false, prefix: { scope: "unavailable" } };
        }

        const messageParts = messages.map(message => stableJsonStringify(message));
        const messageChars = messageParts.reduce((total, part) => total + part.length, 0);
        const systemHash = messages[0]?.role === "system" ? this.shortHash(messageParts[0] ?? "") : undefined;

        // --- Store current snapshot for next turn's comparison ---
        const current: CachePrefixSnapshot = {
            requestId,
            staticFieldsHash,
            toolsHash,
            toolsCount,
            systemHash,
            messageParts,
            messageChars,
        };
        const previous = this.cachePrefixSnapshots.get(scope);
        this.cachePrefixSnapshots.set(scope, current);
        this.persistPrefixSnapshots();

        // --- Compute prefix telemetry (for cache diagnostics) ---
        let identicalMessagePrefix = 0;
        let sharedMessagePrefixChars = 0;
        if (previous) {
            const comparable = Math.min(previous.messageParts.length, messageParts.length);
            while (
                identicalMessagePrefix < comparable
                && previous.messageParts[identicalMessagePrefix] === messageParts[identicalMessagePrefix]
            ) {
                sharedMessagePrefixChars += messageParts[identicalMessagePrefix].length;
                identicalMessagePrefix += 1;
            }
            if (identicalMessagePrefix < comparable) {
                const left = previous.messageParts[identicalMessagePrefix];
                const right = messageParts[identicalMessagePrefix];
                const partialLimit = Math.min(left.length, right.length);
                let partialChars = 0;
                while (partialChars < partialLimit && left.charCodeAt(partialChars) === right.charCodeAt(partialChars)) {
                    partialChars += 1;
                }
                sharedMessagePrefixChars += partialChars;
            }
        }

        const staticFieldsMatch = previous?.staticFieldsHash === staticFieldsHash;
        const toolsMatch = previous?.toolsHash === toolsHash;
        const reusableMessagePercent = previous && staticFieldsMatch && toolsMatch && previous.messageChars > 0
            ? Number(((sharedMessagePrefixChars / previous.messageChars) * 100).toFixed(1))
            : previous ? 0 : undefined;
        const prefix = {
            scope: this.shortHash(scope),
            staticFieldsHash,
            toolsHash,
            toolsCount,
            previousToolsCount: previous?.toolsCount,
            systemHash: messages[0]?.role === "system" ? this.shortHash(messageParts[0] ?? "") : undefined,
            systemChanged: previous !== undefined
                && (previous.systemHash ?? undefined) !== systemHash,
            messageCount: messageParts.length,
            messageChars,
            previousRequestId: previous?.requestId,
            previousMessageCount: previous?.messageParts.length,
            previousMessageChars: previous?.messageChars,
            staticFieldsMatch,
            toolsMatch,
            identicalMessagePrefix,
            sharedMessagePrefixChars,
            reusableMessagePercent,
        };

        // --- Stabilization: reuse previous snapshot when possible ---
        if (!previous || previous.staticFieldsHash !== staticFieldsHash || previous.toolsHash !== toolsHash) {
            if (previous && (previous.staticFieldsHash !== staticFieldsHash || previous.toolsHash !== toolsHash)) {
                this.log("chat.cache.prefix_hash_mismatch", {
                    scope: this.shortHash(scope),
                    staticFieldsMatch: previous.staticFieldsHash === staticFieldsHash,
                    toolsMatch: previous.toolsHash === toolsHash,
                });
            }
            return { messages, stabilized: false, prefix };
        }

        const comparable = Math.min(previous.messageParts.length, messageParts.length);
        let match = 0;
        while (
            match < comparable
            && previous.messageParts[match] === messageParts[match]
        ) {
            match += 1;
        }

        const strategy: "bytes" | "aggressive" | "none" =
            match >= 3
                ? "bytes"
                : match >= 2 && previous.messageParts.length > 2 && comparable > 2
                    ? "aggressive"
                    : match >= 2
                        ? "bytes"
                        : "none";

        if (strategy === "none") {
            return { messages, stabilized: false, prefix };
        }

        const reuseCount = strategy === "bytes"
            ? match
            : Math.min(previous.messageParts.length, messages.length);

        const stabilized: OpenAIChatMessage[] = [];
        for (let index = 0; index < reuseCount; index += 1) {
            try {
                stabilized.push(JSON.parse(previous.messageParts[index]) as OpenAIChatMessage);
            } catch {
                stabilized.push(messages[index] ?? previous.messageParts[index] as unknown as OpenAIChatMessage);
            }
        }
        for (let index = reuseCount; index < messages.length; index += 1) {
            stabilized.push(messages[index]);
        }

        this.log("chat.cache.prefix_stabilized", {
            scope: this.shortHash(scope),
            strategy,
            match,
            reuseCount,
            previousMessageCount: previous.messageParts.length,
            currentMessageCount: messages.length,
            stabilizedMessageCount: stabilized.length,
        });
        return { messages: stabilized, stabilized: true, prefix };
    }

    private summarizeRequestBodyForLog(requestBody: Record<string, unknown>): Record<string, unknown> {
        return {
            model: requestBody.model,
            stream: requestBody.stream,
            max_tokens: requestBody.max_tokens,
            temperature: requestBody.temperature,
            top_p: requestBody.top_p,
            top_k: requestBody.top_k,
            cache_prompt: requestBody.cache_prompt,
            tool_choice: requestBody.tool_choice,
            thinking: requestBody.thinking,
            reasoning_effort: requestBody.reasoning_effort,
            reasoning_budget: requestBody.reasoning_budget,
            reasoning: requestBody.reasoning,
            thinking_budget_tokens: requestBody.thinking_budget_tokens,
            chat_template_kwargs: this.cloneForLog(requestBody.chat_template_kwargs),
            min_p: requestBody.min_p,
            presence_penalty: requestBody.presence_penalty,
            messages: this.summarizeMessagesForLog(requestBody.messages),
            tools: this.summarizeToolsForLog(requestBody.tools),
        };
    }

    private redactHeaders(headers: Record<string, string>): Record<string, string> {
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) {
            if (key.toLowerCase() === "authorization") {
                next[key] = "[redacted]";
            } else {
                next[key] = value;
            }
        }
        return next;
    }

    private clampNumber(value: unknown, min: number, max: number, fallback: number): number {
        const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
        return Math.min(max, Math.max(min, n));
    }

    private clampInt(value: unknown, min: number, max: number, fallback: number): number {
        const n = Number.isInteger(value) ? (value as number) : fallback;
        return Math.min(max, Math.max(min, n));
    }

    private normalizeServerUrl(url: string): string {
        return normalizeServerUrl(url);
    }

    private getExplicitConfiguredServerUrl(): string | undefined {
        const inspected = this.getConfig().inspect<string>("serverUrl");
        const candidates = [
            inspected?.workspaceFolderValue,
            inspected?.workspaceValue,
            inspected?.globalValue,
        ];

        for (const candidate of candidates) {
            if (typeof candidate === "string" && candidate.trim().length > 0) {
                return this.normalizeServerUrl(candidate);
            }
        }

        return undefined;
    }

    private getExplicitConfiguredContextLength(): number | undefined {
        const inspected = this.getConfig().inspect<number>("contextLength");
        const candidates = [
            inspected?.workspaceFolderValue,
            inspected?.workspaceValue,
            inspected?.globalValue,
        ];

        for (const candidate of candidates) {
            if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
                continue;
            }
            return this.clampInt(candidate, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
        }

        return undefined;
    }

    private getConfiguredLocalServerUrl(): string {
        return this.normalizeServerUrl(
            String(this.getConfig().get("localServerUrl", DEFAULT_SERVER_URL) || DEFAULT_SERVER_URL)
        );
    }

    private getConfiguredLocalContextLength(): number {
        return this.clampInt(
            this.getConfig().get("localContextLength", DEFAULT_CONTEXT_LENGTH),
            4096,
            MAX_CONTEXT_LENGTH,
            DEFAULT_CONTEXT_LENGTH
        );
    }

    private getConfiguredDeepSeekContextLength(): number {
        return this.clampInt(
            this.getConfig().get("deepSeekContextLength", DEFAULT_DEEPSEEK_CONTEXT_LIMIT),
            32768,
            DEEPSEEK_CONTEXT_LENGTH,
            DEFAULT_DEEPSEEK_CONTEXT_LIMIT
        );
    }

    private getSourceCacheKey(serverUrl: string, apiKeyPresent: boolean): string {
        return `${this.normalizeServerUrl(serverUrl)}|key=${apiKeyPresent ? "1" : "0"}`;
    }

    private parsePositiveInt(value: unknown): number | undefined {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            return Math.floor(value);
        }
        if (typeof value === "string") {
            const parsed = Number(value.trim());
            if (Number.isFinite(parsed) && parsed > 0) {
                return Math.floor(parsed);
            }
        }
        return undefined;
    }

    private getServerReportedModelContextLength(model: LlamaCppModelInfo): number | undefined {
        const meta = model.meta;
        const candidates: unknown[] = [
            model.contextLength,
            meta?.["n_ctx_runtime"],
            meta?.["n_ctx"],
            meta?.["num_ctx"],
            meta?.["context_length"],
            meta?.["max_context_length"],
            meta?.n_ctx_train,
        ];

        for (const candidate of candidates) {
            const parsed = this.parsePositiveInt(candidate);
            if (parsed !== undefined) {
                return this.clampInt(parsed, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
            }
        }

        return undefined;
    }

    private resolveModelContextLength(
        model: LlamaCppModelInfo,
        runtimeContextLength?: number,
        source?: ChatModelSource
    ): number {
        if (source?.contextLengthOverride !== undefined) {
            return this.clampInt(source.contextLengthOverride, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
        }

        if (!source) {
            const explicitConfigured = this.getExplicitConfiguredContextLength();
            if (explicitConfigured !== undefined) {
                return explicitConfigured;
            }
        }

        const family = this.resolveModelFamily(model.id, source?.familyOverride);

        if (family === "deepseek") {
            const deepseekCandidates: number[] = [];

            if (runtimeContextLength !== undefined) {
                deepseekCandidates.push(runtimeContextLength);
            }

            const serverReported = this.getServerReportedModelContextLength(model);
            if (serverReported !== undefined) {
                deepseekCandidates.push(serverReported);
            }

            // DeepSeek V4 models expose 1M context in official docs; keep a 1M floor
            // when endpoint metadata is missing or reports a lower compatibility value.
            deepseekCandidates.push(DEEPSEEK_CONTEXT_LENGTH);

            return this.clampInt(
                Math.max(...deepseekCandidates),
                4096,
                MAX_CONTEXT_LENGTH,
                DEFAULT_CONTEXT_LENGTH
            );
        }

        if (runtimeContextLength !== undefined) {
            return this.clampInt(runtimeContextLength, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
        }

        const serverReported = this.getServerReportedModelContextLength(model);
        if (serverReported !== undefined) {
            return serverReported;
        }

        if (source?.contextLengthFallback !== undefined) {
            return this.clampInt(source.contextLengthFallback, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
        }

        return this.getConfiguredContextLength();
    }

    private resolveRuntimeContextLengthForRequest(
        model: LanguageModelChatInformation,
        runtimeContextLength?: number,
        source?: ChatModelSource
    ): number {
        if (source?.contextLengthOverride !== undefined) {
            return this.clampInt(source.contextLengthOverride, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
        }

        if (!source) {
            const explicitConfigured = this.getExplicitConfiguredContextLength();
            if (explicitConfigured !== undefined) {
                return explicitConfigured;
            }
        }

        if (runtimeContextLength !== undefined) {
            return this.clampInt(runtimeContextLength, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
        }

        const advertisedContext = this.parsePositiveInt(model.maxInputTokens + model.maxOutputTokens);
        if (advertisedContext !== undefined) {
            return this.clampInt(advertisedContext, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
        }

        if (source?.contextLengthFallback !== undefined) {
            return this.clampInt(source.contextLengthFallback, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
        }

        return this.getConfiguredContextLength();
    }

    private getConfiguredContextLength(): number {
        return this.clampInt(this.getConfig().get("contextLength", DEFAULT_CONTEXT_LENGTH), 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
    }

    private getConfiguredMaxOutputTokens(): number {
        return this.clampInt(
            this.getConfig().get("maxOutputTokensCap", DEFAULT_MAX_OUTPUT_TOKENS),
            128,
            393216,
            DEFAULT_MAX_OUTPUT_TOKENS
        );
    }

    private resolveAdvertisedMaxOutputTokens(
        family: string,
        contextLength: number,
        configuredOutputCap: number
    ): number {
        const contextBound = Math.max(128, contextLength - 1024);

        if (family === "deepseek") {
            // The configured hard cap (maxOutputTokensCap) can be as high as
            // 393216 — advertising that value makes Copilot Chat reserve 75%+
            // of the context window for output and aggressively truncate input
            // history, destroying the upstream prompt-cache prefix every turn.
            // Use deepSeekDefaultMaxOutputTokens (65 536 by default) for the
            // model picker so Copilot Chat sees a 12.5% output reservation
            // while the full hard cap still applies to actual API requests.
            const advertisedCap = this.clampInt(
                this.getConfig().get("deepSeekDefaultMaxOutputTokens", 65536),
                1024,
                393216,
                65536
            );
            return Math.min(advertisedCap, configuredOutputCap, contextBound);
        }

        const localContextShareCap = Math.max(2048, Math.floor(contextLength * 0.25));
        const localDefaultCap = Math.min(32768, localContextShareCap);
        return Math.min(configuredOutputCap, contextBound, localDefaultCap);
    }

    private getModelListCacheTtlMs(): number {
        return this.clampInt(this.getConfig().get("modelListCacheTtlMs", 30000), 0, 600000, 30000);
    }

    private getModelDiscoveryTimeoutMs(): number {
        return this.clampInt(this.getConfig().get("modelDiscoveryTimeoutMs", 20000), 3000, 120000, 20000);
    }

    private getCachePromptEnabled(): boolean {
        return this.getConfig().get<boolean>("cachePrompt", true) !== false;
    }

    private getRequestQueueTimeoutMs(): number {
        return this.clampInt(this.getConfig().get("requestQueueTimeoutMs", 1200000), 0, 1200000, 1200000);
    }

    private getMaxToolResultChars(): number {
        return this.clampInt(this.getConfig().get("maxToolResultChars", 24000), 0, 1000000, 24000);
    }

    private getSummarizeLargeToolResults(): boolean {
        return this.getConfig().get<boolean>("summarizeLargeToolResults", true) !== false;
    }

    private getSanitizeToolResultArtifacts(): boolean {
        return this.getConfig().get<boolean>("sanitizeToolResultArtifacts", true) !== false;
    }

    private getMaxLoggedStreamChunkChars(): number {
        return this.clampInt(this.getConfig().get("maxLoggedStreamChunkChars", 4096), 0, 100000, 4096);
    }

    private resolveModelFamily(modelId: string, familyOverride?: string): string {
        const configured = String(this.getConfig().get("modelFamily", "llama") ?? "llama").trim().toLowerCase();
        return resolveModelFamily(modelId, familyOverride, configured);
    }

    private normalizeToolResultMode(value: unknown): ToolResultModeConfig {
        const mode = typeof value === "string" ? value.toLowerCase().trim() : "auto";
        if (mode === "auto" || mode === "tool" || mode === "user") {
            return mode;
        }
        return "auto";
    }

    private normalizeToolCallingMode(value: unknown): ToolCallingModeConfig {
        const mode = typeof value === "string" ? value.toLowerCase().trim() : "classic";
        if (mode === "classic" || mode === "apidirect") {
            return mode === "apidirect" ? "apiDirect" : "classic";
        }
        return "classic";
    }

    private isDeepSeekServer(serverUrl: string): boolean {
        return isDeepSeekEndpoint(serverUrl);
    }

    private getChatCompletionsEndpoint(serverUrl: string): string {
        return getChatCompletionsEndpoint(serverUrl);
    }

    private getModelsEndpoint(serverUrl: string): string {
        return getModelsEndpoint(serverUrl);
    }

    private isThinkingResponsePart(part: unknown): boolean {
        if (!part || typeof part !== "object") {
            return false;
        }
        const ctorName = (part as { constructor?: { name?: string } }).constructor?.name;
        if (ctorName === "LanguageModelThinkingPart") {
            return true;
        }

        const candidate = part as Record<string, unknown>;
        if (typeof candidate["thinking"] === "string") {
            return true;
        }
        if (typeof candidate["text"] === "string" && candidate["metadata"] !== undefined && candidate["mimeType"] === undefined) {
            return true;
        }
        return false;
    }

    private getThinkingPartText(part: unknown): string {
        if (!part || typeof part !== "object") {
            return "";
        }
        const candidate = part as Record<string, unknown>;
        if (typeof candidate["text"] === "string") {
            return candidate["text"];
        }
        if (typeof candidate["thinking"] === "string") {
            return candidate["thinking"];
        }
        if (typeof candidate["value"] === "string" && this.isThinkingResponsePart(part)) {
            return candidate["value"];
        }
        return "";
    }

    private isToolRoleCompatibilityError(status: number, text: string): boolean {
        if (status !== 400 && status !== 422) {
            return false;
        }

        const lower = (text || "").toLowerCase();
        return (
            lower.includes("jinja") ||
            lower.includes("chat template") ||
            lower.includes("must alternate") ||
            (lower.includes("unsupported") && lower.includes("tool")) ||
            (lower.includes("role") && lower.includes("tool")) ||
            (lower.includes("invalid") && lower.includes("tool_call_id"))
        );
    }

    /**
     * Rough token estimation for OpenAI-format messages.
     * Handles multimodal (image_url) content with a capped per-image estimate
     * instead of raw base64 length, which would be wildly inflated.
     */
    private estimateOpenAiMessageTokens(messages: OpenAIChatMessage[]): number {
        try {
            let charCount = 0;
            for (const msg of messages) {
                charCount += (msg.role?.length || 0) + (msg.name?.length || 0) + (msg.tool_call_id?.length || 0);
                if (typeof msg.content === "string") {
                    charCount += msg.content.length;
                } else if (Array.isArray(msg.content)) {
                    for (const part of msg.content) {
                        if (part.type === "text" && typeof part.text === "string") {
                            charCount += part.text.length;
                        } else if (part.type === "image_url" && part.image_url?.url) {
                            // Conservative per-image token estimate.
                            // For "auto" detail OpenAI charges ~85 base + resize cost;
                            // DeepSeek converts to visual tokens in a similar range.
                            // We estimate 255 tokens (≈1020 chars) as a safe upper bound.
                            charCount += 1020;
                        }
                    }
                }
                if (typeof msg.reasoning_content === "string") {
                    charCount += msg.reasoning_content.length;
                }
                if (Array.isArray(msg.tool_calls)) {
                    try {
                        charCount += JSON.stringify(msg.tool_calls).length;
                    } catch {
                        // Ignore serialization errors.
                    }
                }
            }
            return Math.max(1, Math.ceil(charCount / 4));
        } catch {
            return 0;
        }
    }

    /**
     * Save user-attached images to temporary files and return modified messages
     * with text instructions pointing to the saved files.
     * Used when the model provider doesn't support inline image_url content blocks.
     */
    private saveUserImagesToTemp(
        messages: readonly LanguageModelChatMessage[],
        requestId: string
    ): LanguageModelChatMessage[] {
        const tempDir = path.join(os.tmpdir(), "llama-vscode-chat", requestId);
        fs.mkdirSync(tempDir, { recursive: true });

        let imageIndex = 0;
        return messages.map(msg => {
            if (msg.role !== vscode.LanguageModelChatMessageRole.User) {
                return msg;
            }

            let hasImages = false;
            const newContent: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelToolResultPart | vscode.LanguageModelDataPart)[] = [];

            for (const part of msg.content ?? []) {
                if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) {
                    hasImages = true;
                    const ext = part.mimeType.split("/")[1] || "png";
                    imageIndex += 1;
                    const filename = `attached-image-${String(imageIndex).padStart(3, "0")}.${ext}`;
                    const filePath = path.join(tempDir, filename);
                    try {
                        fs.writeFileSync(filePath, part.data);
                        this.log("chat.image.saved_to_temp", {
                            requestId,
                            filePath,
                            mimeType: part.mimeType,
                            byteLength: part.data.byteLength,
                        });
                        newContent.push(new vscode.LanguageModelTextPart(
                            `[Attached image #${imageIndex} saved to: ${filePath} — use the view_image tool to examine this image]`
                        ));
                    } catch (err) {
                        this.logError("chat.image.save_failed", err, {
                            requestId,
                            filePath,
                            mimeType: part.mimeType,
                        });
                        newContent.push(new vscode.LanguageModelTextPart(
                            `[Attached image #${imageIndex} (${part.mimeType}, ${(part.data.byteLength / 1024).toFixed(1)} KB) — could not save to temp, use view_image tool if available]`
                        ));
                    }
                } else {
                    newContent.push(part);
                }
            }

            if (hasImages) {
                return {
                    ...msg,
                    content: newContent,
                } as LanguageModelChatMessage;
            }
            return msg;
        });
    }

    private truncateToolResultContent(content: string, maxChars: number): { content: string; truncatedChars: number } {
        if (maxChars <= 0 || content.length <= maxChars) {
            return { content, truncatedChars: 0 };
        }

        const truncatedChars = content.length - maxChars;
        if (this.getSummarizeLargeToolResults()) {
            return {
                content: summarizeToolResultContent(content, Math.min(maxChars, 1600)),
                truncatedChars,
            };
        }

        return {
            content: `${content.slice(0, maxChars)}\n\n[tool result truncated: ${truncatedChars} chars omitted]`,
            truncatedChars,
        };
    }

    private truncateToolResultMessages(
        messages: OpenAIChatMessage[],
        maxChars: number,
        requestId: string
    ): OpenAIChatMessage[] {
        if (maxChars <= 0) {
            return messages;
        }

        let sanitizedMessages = 0;
        let truncatedMessages = 0;
        let omittedChars = 0;
        const nextMessages = messages.map(message => {
            const content = message.content;
            if (typeof content !== "string") {
                return message;
            }

            const isToolResult = message.role === "tool" || (message.role === "user" && content.includes("[tool_result"));
            if (!isToolResult) {
                return message;
            }

            let nextContent = content;
            if (this.getSanitizeToolResultArtifacts()) {
                // Remove transient transport metadata sometimes appended to tool output text.
                const cleaned = stripCacheControlArtifacts(nextContent)
                    .replace(/\n{3,}/g, "\n\n")
                    .trimEnd();
                if (cleaned !== nextContent) {
                    nextContent = cleaned;
                    sanitizedMessages += 1;
                }
            }

            if (maxChars <= 0 || nextContent.length <= maxChars) {
                if (nextContent !== content) {
                    return { ...message, content: nextContent };
                }
                return message;
            }

            const truncated = this.truncateToolResultContent(nextContent, maxChars);
            truncatedMessages += 1;
            omittedChars += truncated.truncatedChars;
            return { ...message, content: truncated.content };
        });

        if (sanitizedMessages > 0) {
            this.log("chat.tool_results.sanitized", {
                requestId,
                sanitizedMessages,
            });
        }

        if (truncatedMessages > 0) {
            this.log("chat.tool_results.truncated", {
                requestId,
                maxChars,
                truncatedMessages,
                omittedChars,
            });
        }

        return nextMessages;
    }

    private static readonly REASONING_MAP_STATE_KEY = "llamacpp.deepseek_reasoning_map";
    private static readonly PREFIX_STATE_KEY = "llamacpp.prefix_snapshots";
    private static readonly PREFIX_STATE_VERSION_KEY = "llamacpp.prefix_snapshots.version";
    private static readonly CONTINUATION_STATE_KEY = "llamacpp.continuation_snapshots.v1";

    private loadPersistedReasoningMap(): void {
        if (this.reasoningMapLoaded || !this.globalState) {
            return;
        }
        this.reasoningMapLoaded = true;
        try {
            const stored = this.globalState.get<Record<string, unknown>>(
                LlamaCppChatModelProvider.REASONING_MAP_STATE_KEY
            );
            if (!stored || typeof stored !== "object") {
                return;
            }
            let restored = 0;
            for (const [key, value] of Object.entries(stored)) {
                if (typeof value === "string") {
                    // Legacy flat shape written before conversation scoping: { callId: reasoning }.
                    if (key && value) {
                        this.restoreReasoningEntry(key, value);
                        restored += 1;
                    }
                    continue;
                }
                if (!value || typeof value !== "object") {
                    continue;
                }
                for (const [callId, reasoning] of Object.entries(value as Record<string, unknown>)) {
                    if (typeof reasoning === "string" && callId && reasoning) {
                        this.restoreReasoningEntry(callId, reasoning, key);
                        restored += 1;
                    }
                }
            }
            if (restored > 0) {
                this.log("chat.reasoning.map_restored", { restoredEntries: restored });
            }
        } catch (error) {
            this.logError("chat.reasoning.map_restore_failed", error);
            this.reasoningMapLoaded = false; // retry next turn
        }
    }

    private persistReasoningMap(): void {
        if (!this.globalState) {
            return;
        }
        try {
            const serializable: Record<string, Record<string, string>> = {};
            for (const [scope, entries] of this.exportReasoningScopes()) {
                const bucket: Record<string, string> = {};
                for (const [callId, reasoning] of entries) {
                    bucket[callId] = reasoning;
                }
                serializable[scope] = bucket;
            }
            void this.globalState.update(
                LlamaCppChatModelProvider.REASONING_MAP_STATE_KEY,
                serializable
            );
        } catch (error) {
            this.logError("chat.reasoning.map_persist_failed", error);
        }
    }

    private loadPersistedPrefixSnapshots(): void {
        if (!this.globalState) {
            return;
        }
        try {
            // Clear stale snapshots saved by an older extension version whose
            // tool ordering or hash computation may have differed.
            // Only clear on MAJOR or MINOR version bumps — patch upgrades
            // (1.8.27 → 1.8.28) keep the snapshots intact.
            const savedVersion = this.globalState.get<string>(
                LlamaCppChatModelProvider.PREFIX_STATE_VERSION_KEY
            );
            const extVersion = vscode.extensions.getExtension("mrlordcat.llama-vscode-chat")
                ?.packageJSON?.version;
            const savedMinor = savedVersion?.split(".").slice(0, 2).join(".") ?? "";
            const extMinor = extVersion?.split(".").slice(0, 2).join(".") ?? "";
            if (savedMinor !== extMinor) {
                const reason = !savedVersion ? "first_install" : "minor_version_changed";
                this.log("chat.cache.prefix_snapshots_version_changed", {
                    reason,
                    savedVersion: savedVersion ?? "none",
                    currentVersion: extVersion ?? "unknown",
                });
                void this.globalState.update(LlamaCppChatModelProvider.PREFIX_STATE_KEY, undefined);
                void this.globalState.update(
                    LlamaCppChatModelProvider.PREFIX_STATE_VERSION_KEY,
                    extVersion
                );
                return;
            }
            const stored = this.globalState.get<Record<string, CachePrefixSnapshot>>(
                LlamaCppChatModelProvider.PREFIX_STATE_KEY
            );
            if (!stored || typeof stored !== "object") {
                return;
            }
            let loaded = 0;
            for (const [scope, snapshot] of Object.entries(stored)) {
                if (snapshot && typeof snapshot.staticFieldsHash === "string") {
                    this.cachePrefixSnapshots.set(scope, snapshot);
                    loaded += 1;
                }
            }
            if (loaded > 0) {
                this.log("chat.cache.prefix_snapshots_loaded", { loadedEntries: loaded });
            }
        } catch (error) {
            this.logError("chat.cache.prefix_snapshots_load_failed", error);
        }
    }

    private async persistPrefixSnapshots(): Promise<void> {
        if (!this.globalState) {
            return;
        }
        try {
            const serializable: Record<string, CachePrefixSnapshot> = {};
            for (const [scope, snapshot] of this.cachePrefixSnapshots) {
                serializable[scope] = snapshot;
            }
            await this.globalState.update(
                LlamaCppChatModelProvider.PREFIX_STATE_KEY,
                serializable
            );
            const extVersion = vscode.extensions.getExtension("mrlordcat.llama-vscode-chat")
                ?.packageJSON?.version;
            if (extVersion) {
                void this.globalState.update(
                    LlamaCppChatModelProvider.PREFIX_STATE_VERSION_KEY,
                    extVersion
                );
            }
        } catch (error) {
            this.logError("chat.cache.prefix_snapshots_persist_failed", error);
        }
    }

    private isOpenAIChatMessage(value: unknown): value is OpenAIChatMessage {
        if (!value || typeof value !== "object") {
            return false;
        }
        const role = (value as { role?: unknown }).role;
        return role === "system" || role === "user" || role === "assistant" || role === "tool";
    }

    private getConversationMessageSnapshot(scope: string | undefined): ConversationMessageSnapshot | undefined {
        if (!scope) {
            return undefined;
        }
        const snapshot = this.conversationMessageSnapshots.get(scope);
        if (snapshot) {
            this.conversationMessageSnapshots.delete(scope);
            this.conversationMessageSnapshots.set(scope, snapshot);
        }
        return snapshot;
    }

    private setConversationMessageSnapshot(
        scope: string | undefined,
        messages: OpenAIChatMessage[],
        tokenCount: number
    ): void {
        if (!scope || messages.length === 0) {
            return;
        }
        this.conversationMessageSnapshots.set(scope, {
            messages: [...messages],
            tokenCount: Math.max(0, Math.floor(tokenCount)),
            updatedAt: Date.now(),
        });
    }

    private deleteConversationMessageSnapshot(scope: string | undefined): void {
        if (scope) {
            this.conversationMessageSnapshots.delete(scope);
        }
    }

    private loadPersistedContinuationState(): void {
        if (!this.globalState) {
            return;
        }
        try {
            const stored = this.globalState.get<{
                conversations?: Record<string, ConversationMessageSnapshot>;
                toolCatalogs?: Record<string, StableToolCatalogSnapshot>;
            }>(LlamaCppChatModelProvider.CONTINUATION_STATE_KEY);
            let loadedConversations = 0;
            let loadedToolCatalogs = 0;
            for (const [scope, snapshot] of Object.entries(stored?.conversations ?? {})) {
                if (
                    scope
                    && snapshot
                    && Array.isArray(snapshot.messages)
                    && snapshot.messages.length > 0
                    && snapshot.messages.every(message => this.isOpenAIChatMessage(message))
                ) {
                    this.conversationMessageSnapshots.set(scope, {
                        messages: snapshot.messages,
                        tokenCount: Number.isFinite(snapshot.tokenCount) ? Math.max(0, snapshot.tokenCount) : 0,
                        updatedAt: Number.isFinite(snapshot.updatedAt) ? snapshot.updatedAt : Date.now(),
                    });
                    loadedConversations += 1;
                }
            }
            for (const [scope, snapshot] of Object.entries(stored?.toolCatalogs ?? {})) {
                if (
                    scope
                    && snapshot
                    && Array.isArray(snapshot.tools)
                    && snapshot.tools.every(tool => typeof tool?.function?.name === "string")
                    && typeof snapshot.fingerprint === "string"
                ) {
                    this.stableToolCatalogs.set(scope, {
                        ...snapshot,
                        updatedAt: Number.isFinite(snapshot.updatedAt) ? snapshot.updatedAt : Date.now(),
                    });
                    loadedToolCatalogs += 1;
                }
            }

            // First upgrade from the in-memory implementation: the persisted
            // prefix snapshot already contains the exact messages sent on the
            // previous successful request, so use it as the continuation base.
            if (loadedConversations === 0) {
                for (const [scope, prefix] of this.cachePrefixSnapshots) {
                    try {
                        const messages = prefix.messageParts.map(part => JSON.parse(part) as unknown);
                        if (messages.length > 0 && messages.every(message => this.isOpenAIChatMessage(message))) {
                            const typedMessages = messages as OpenAIChatMessage[];
                            this.conversationMessageSnapshots.set(scope, {
                                messages: typedMessages,
                                tokenCount: this.estimateOpenAiMessageTokens(typedMessages),
                                updatedAt: Date.now(),
                                migratedFromPrefix: true,
                            });
                            loadedConversations += 1;
                        }
                    } catch {
                        // Ignore one malformed legacy prefix and continue loading others.
                    }
                }
                if (loadedConversations > 0) {
                    this.log("chat.messages.snapshot_migrated", { loadedEntries: loadedConversations });
                }
            }
            if (loadedConversations > 0 || loadedToolCatalogs > 0) {
                this.log("chat.continuation.state_loaded", {
                    conversationEntries: loadedConversations,
                    toolCatalogEntries: loadedToolCatalogs,
                });
            }
        } catch (error) {
            this.logError("chat.continuation.state_load_failed", error);
        }
    }

    private async persistContinuationState(): Promise<void> {
        if (!this.globalState) {
            return;
        }
        try {
            const conversations: Record<string, ConversationMessageSnapshot> = {};
            const toolCatalogs: Record<string, StableToolCatalogSnapshot> = {};
            for (const [scope, snapshot] of this.conversationMessageSnapshots) {
                conversations[scope] = snapshot;
            }
            for (const [scope, snapshot] of this.stableToolCatalogs) {
                toolCatalogs[scope] = snapshot;
            }
            await this.globalState.update(
                LlamaCppChatModelProvider.CONTINUATION_STATE_KEY,
                { conversations, toolCatalogs }
            );
        } catch (error) {
            this.logError("chat.continuation.state_persist_failed", error);
        }
    }

    protected async processStreamingResponse(
        responseBody: ReadableStream<Uint8Array>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<ChatTokenUsage | undefined> {
        // Restore persisted reasoning entries before streaming adds new ones,
        // so persistReasoningMap writes a merged set rather than overwriting.
        this.loadPersistedReasoningMap();
        const result = await super.processStreamingResponse(responseBody, progress, token);
        this.persistReasoningMap();
        // Persist both the exact sent-message continuation and tool catalog.
        // A fresh Extension Host can then resume the same prompt instead of
        // compacting VS Code's much larger raw history on its first request.
        await Promise.all([
            this.persistPrefixSnapshots(),
            this.persistContinuationState(),
        ]);
        return result;
    }

    /**
     * Injects accumulated reasoning content from the previous turn into assistant
     * messages that carry tool calls but lack a reasoning_content field.
     *
     * DeepSeek (and other thinking-mode APIs) require reasoning_content to be
     * passed back on follow-up requests when tool calls were involved.  Without it,
     * the API returns a 400 error.
     *
    * VS Code may render LanguageModelThinkingPart while omitting it from the next
    * provider history. During streaming the same reasoning text is therefore also
    * retained in BaseProvider._currentTurnReasoningContent; this method restores
    * the provider-specific field before the next request is sent.
     */
    private injectStoredReasoningContent(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
        this.loadPersistedReasoningMap();
        let fallbackIndex = -1;
        const currentReasoning = this.getCurrentTurnReasoningContent();
        for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index];
            if (
                message.role === "assistant"
                && message.tool_calls?.length
                && !message.reasoning_content
            ) {
                fallbackIndex = index;
                break;
            }
        }

        // Bind reasoning to the call ids emitted with that response.
        return messages.map((message, index) => {
            if (
                message.role !== "assistant"
                || !message.tool_calls?.length
                || message.reasoning_content
            ) {
                return message;
            }
            const exactReasoning = message.tool_calls
                .map(call => this.getReasoningForToolCall(call.id))
                .find((value): value is string => Boolean(value));
            if (exactReasoning) {
                return { ...message, reasoning_content: exactReasoning };
            }
            if (index !== fallbackIndex || !currentReasoning) {
                return message;
            }
            // Bind the positional fallback to the actual call ids so the next turn
            // resolves this message by identity. Without it the fallback target
            // moves forward every turn and the previous target silently loses
            // reasoning_content, which breaks the cached prompt prefix.
            for (const call of message.tool_calls) {
                this.rememberReasoningValueForToolCall(call.id, currentReasoning);
            }
            return { ...message, reasoning_content: currentReasoning };
        });
    }

    /**
     * Find messages in `source` that were added after `snapshot` was taken.
     * Uses the last non-system message of the snapshot as a pivot to locate
     * the cut point in the source.  If the pivot cannot be found the snapshot
     * is considered stale and the entire source is returned.
     */
    private findNewMessagesAfterSnapshot(
        source: OpenAIChatMessage[],
        snapshot: OpenAIChatMessage[]
    ): OpenAIChatMessage[] {
        // Walk backwards through the snapshot to find a non-system pivot
        let pivotIdx = snapshot.length - 1;
        while (pivotIdx >= 0 && snapshot[pivotIdx].role === "system") {
            pivotIdx--;
        }
        if (pivotIdx < 0) {
            return [...source];
        }

        const pivot = snapshot[pivotIdx];
        for (let srcIdx = source.length - 1; srcIdx >= 0; srcIdx--) {
            if (source[srcIdx].role === pivot.role && this.messagesContentEqual(source[srcIdx], pivot)) {
                return source.slice(srcIdx + 1);
            }
        }

        // Snapshot pivot not found in source — snapshot is stale
        return [...source];
    }

    private messagesContentEqual(a: OpenAIChatMessage, b: OpenAIChatMessage): boolean {
        if (a.role !== b.role) {
            return false;
        }
        const aContent = typeof a.content === "string" ? a.content : JSON.stringify(a.content);
        const bContent = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        return aContent === bContent;
    }

    private compactOpenAiMessages(
        messages: OpenAIChatMessage[],
        tokenBudget: number,
        keepLastCount: number,
        label: string
    ): OpenAIChatMessage[] {
        return compactMessages(messages, {
            tokenBudget,
            keepLastCount,
            label,
            // Use the same calibrated estimate as the compaction trigger and the
            // context-usage metrics. Without calibration the raw heuristic often
            // stays under the budget while the calibrated count is already over
            // it, so the fast path returns the messages unchanged and records a
            // no-op "micro-compaction" on every turn.
            estimateTokens: candidate => Math.max(
                1,
                Math.round(this.estimateOpenAiMessageTokens(candidate) * this.heuristicCalibration)
            ),
        });
    }

    private isContextOverflowError(status: number, text: string): boolean {
        if (status !== 400 && status !== 413) {
            return false;
        }

        const lower = (text || "").toLowerCase();
        return (
            lower.includes("context") ||
            lower.includes("token") ||
            lower.includes("too long") ||
            lower.includes("exceed")
        );
    }

    private async sendChatCompletion(
        serverUrl: string,
        headers: Record<string, string>,
        requestBody: Record<string, unknown>,
        timeoutMs: number,
        token: CancellationToken
    ): Promise<Response> {
        return this.httpTransport.postChatCompletion(serverUrl, headers, requestBody, timeoutMs, token);
    }

    private acquireChatRequestSlot(
        requestId: string,
        queueTimeoutMs: number,
        token: CancellationToken
    ): Promise<ChatRequestSlotLease> {
        return this.chatRequestQueue.acquire(
            requestId,
            queueTimeoutMs,
            token,
            () => new vscode.CancellationError()
        );
    }

    private async captureRawStream(
        stream: ReadableStream<Uint8Array>,
        requestId: string,
        token: CancellationToken
    ): Promise<void> {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let chunkIndex = 0;
        const maxLoggedStreamChunkChars = this.getMaxLoggedStreamChunkChars();

        try {
            while (!token.isCancellationRequested) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                const text = decoder.decode(value, { stream: true });
                const truncated = maxLoggedStreamChunkChars > 0 && text.length > maxLoggedStreamChunkChars;
                this.log("chat.stream.chunk", {
                    requestId,
                    chunkIndex,
                    byteLength: value.byteLength,
                    textLength: text.length,
                    truncated,
                    text: maxLoggedStreamChunkChars > 0
                        ? text.slice(0, maxLoggedStreamChunkChars)
                        : undefined,
                });
                chunkIndex += 1;
            }

            const tail = decoder.decode();
            if (tail) {
                const truncated = maxLoggedStreamChunkChars > 0 && tail.length > maxLoggedStreamChunkChars;
                this.log("chat.stream.chunk", {
                    requestId,
                    chunkIndex,
                    byteLength: 0,
                    textLength: tail.length,
                    truncated,
                    text: maxLoggedStreamChunkChars > 0
                        ? tail.slice(0, maxLoggedStreamChunkChars)
                        : undefined,
                    tail: true,
                });
            }

            this.log("chat.stream.end", {
                requestId,
                chunkCount: chunkIndex,
                cancelled: token.isCancellationRequested,
            });
        } catch (error) {
            this.logError("chat.stream.capture_failed", error, { requestId, chunkIndex });
        } finally {
            reader.releaseLock();
        }
    }

    private isCacheStillValid(
        cached: { serverUrl: string; apiKeyPresent: boolean },
        serverUrl: string,
        apiKeyPresent: boolean
    ): boolean {
        return cached.serverUrl === serverUrl && cached.apiKeyPresent === apiKeyPresent;
    }

    private getFreshCachedModels(serverUrl: string, apiKeyPresent: boolean, ttlMs: number): LlamaCppModelInfo[] | undefined {
        const cached = this.modelListCache.get(this.getSourceCacheKey(serverUrl, apiKeyPresent));
        if (ttlMs <= 0 || !cached || !this.isCacheStillValid(cached, serverUrl, apiKeyPresent)) {
            return undefined;
        }

        if (Date.now() - cached.fetchedAt > ttlMs) {
            return undefined;
        }

        return cached.models;
    }

    private getAnyCachedModels(serverUrl: string, apiKeyPresent: boolean): LlamaCppModelInfo[] | undefined {
        const cached = this.modelListCache.get(this.getSourceCacheKey(serverUrl, apiKeyPresent));
        if (!cached || !this.isCacheStillValid(cached, serverUrl, apiKeyPresent)) {
            return undefined;
        }

        return cached.models;
    }

    private cacheModels(serverUrl: string, apiKeyPresent: boolean, models: LlamaCppModelInfo[]): void {
        this.modelListCache.set(this.getSourceCacheKey(serverUrl, apiKeyPresent), {
            serverUrl,
            apiKeyPresent,
            fetchedAt: Date.now(),
            models,
        });
    }

    private getFreshCachedRuntimeContextLength(
        serverUrl: string,
        apiKeyPresent: boolean,
        ttlMs: number
    ): number | undefined {
        const cached = this.runtimeContextCache.get(this.getSourceCacheKey(serverUrl, apiKeyPresent));
        if (ttlMs <= 0 || !cached || !this.isCacheStillValid(cached, serverUrl, apiKeyPresent)) {
            return undefined;
        }

        if (Date.now() - cached.fetchedAt > ttlMs) {
            return undefined;
        }

        return cached.contextLength;
    }

    private cacheRuntimeContextLength(serverUrl: string, apiKeyPresent: boolean, contextLength: number): void {
        this.runtimeContextCache.set(this.getSourceCacheKey(serverUrl, apiKeyPresent), {
            serverUrl,
            apiKeyPresent,
            fetchedAt: Date.now(),
            contextLength: this.clampInt(contextLength, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH),
        });
    }

    private async fetchRuntimeContextLength(serverUrl: string, apiKey?: string): Promise<number | undefined> {
        if (!this.shouldProbeRuntimeSlots(serverUrl)) {
            this.log("models.runtime_context.slots_skipped", {
                endpoint: `${serverUrl}/slots`,
                reason: "provider_not_llamacpp",
            });
            return undefined;
        }

        const headers: Record<string, string> = {
            "User-Agent": this.userAgent,
        };
        if (apiKey) {
            headers["Authorization"] = `Bearer ${apiKey}`;
        }

        try {
            const response = await this.fetchWithTimeout(
                `${serverUrl}/slots`,
                {
                method: "GET",
                headers,
                },
                this.getModelDiscoveryTimeoutMs()
            );

            if (!response.ok) {
                this.log("models.runtime_context.slots_unavailable", {
                    endpoint: `${serverUrl}/slots`,
                    status: response.status,
                    statusText: response.statusText,
                });
                return undefined;
            }

            const body = (await response.json()) as unknown;
            const slotCandidates: number[] = [];

            if (Array.isArray(body)) {
                for (const slot of body) {
                    if (!slot || typeof slot !== "object") {
                        continue;
                    }
                    const slotObj = slot as Record<string, unknown>;
                    const direct = this.parsePositiveInt(slotObj["n_ctx"]);
                    if (direct !== undefined) {
                        slotCandidates.push(direct);
                    }
                    const params = slotObj["params"];
                    if (params && typeof params === "object") {
                        const nested = this.parsePositiveInt((params as Record<string, unknown>)["n_ctx"]);
                        if (nested !== undefined) {
                            slotCandidates.push(nested);
                        }
                    }
                }
            } else if (body && typeof body === "object") {
                const obj = body as Record<string, unknown>;
                const direct = this.parsePositiveInt(obj["n_ctx"]);
                if (direct !== undefined) {
                    slotCandidates.push(direct);
                }
            }

            if (slotCandidates.length === 0) {
                return undefined;
            }

            const runtimeContextLength = this.clampInt(
                Math.max(...slotCandidates),
                4096,
                MAX_CONTEXT_LENGTH,
                DEFAULT_CONTEXT_LENGTH
            );
            this.log("models.runtime_context.detected", {
                source: "slots",
                contextLength: runtimeContextLength,
            });
            return runtimeContextLength;
        } catch (error) {
            this.logError("models.runtime_context.failed", error, {
                endpoint: `${serverUrl}/slots`,
            });
            return undefined;
        }
    }

    private async getRuntimeContextLengthWithCache(
        serverUrl: string,
        apiKey: string | undefined,
        apiKeyPresent: boolean,
        ttlMs: number
    ): Promise<number | undefined> {
        const cached = this.getFreshCachedRuntimeContextLength(serverUrl, apiKeyPresent, ttlMs);
        if (cached !== undefined) {
            return cached;
        }

        const runtimeContextLength = await this.fetchRuntimeContextLength(serverUrl, apiKey);
        if (runtimeContextLength !== undefined) {
            this.cacheRuntimeContextLength(serverUrl, apiKeyPresent, runtimeContextLength);
        }
        return runtimeContextLength;
    }

    private async fetchModelsWithInflightCache(
        serverUrl: string,
        apiKey: string | undefined,
        apiKeyPresent: boolean
    ): Promise<LlamaCppModelInfo[]> {
        const cacheKey = this.getSourceCacheKey(serverUrl, apiKeyPresent);
        const currentInflight = this.modelListInflight.get(cacheKey);
        if (currentInflight && currentInflight.serverUrl === serverUrl && currentInflight.apiKeyPresent === apiKeyPresent) {
            this.log("models.request.inflight_join", { serverUrl, apiKeyPresent });
            return currentInflight.promise;
        }

        const fetchPromise = this.fetchModels(serverUrl, apiKey).finally(() => {
            if (this.modelListInflight.get(cacheKey)?.promise === fetchPromise) {
                this.modelListInflight.delete(cacheKey);
            }
        });
        this.modelListInflight.set(cacheKey, {
            serverUrl,
            apiKeyPresent,
            promise: fetchPromise,
        });
        return fetchPromise;
    }

    private async getModelSources(): Promise<ChatModelSource[]> {
        const cfg = this.getConfig();
        const configuredServerUrl = await this.getServerUrl();
        const apiKey = await this.getApiKey();
        const deepSeekApiKey = await this.getDeepSeekApiKey();
        return createModelSources({
            primaryServerUrl: configuredServerUrl,
            primaryApiKey: apiKey,
            deepSeekApiKey,
            localEnabled: cfg.get<boolean>("enableLocalServer", true) !== false,
            localServerUrl: this.getConfiguredLocalServerUrl(),
            localContextLength: this.getConfiguredLocalContextLength(),
            deepSeekEnabled: cfg.get<boolean>("enableDeepSeek", true) !== false,
            deepSeekContextLength: this.getConfiguredDeepSeekContextLength(),
        });
    }

    private async resolveSourceForModel(model: LanguageModelChatInformation): Promise<{
        source: ChatModelSource;
        modelId: string;
    }> {
        const parsed = parseProviderModelId(model.id);
        const sources = await this.getModelSources();
        const source = parsed.sourceKey
            ? sources.find(candidate => candidate.key === parsed.sourceKey)
            : undefined;

        if (source) {
            return { source, modelId: parsed.modelId };
        }

        const legacyServerUrl = await this.getServerUrl();
        return {
            source: {
                key: this.isDeepSeekServer(legacyServerUrl) ? "deepseek" : "primary",
                label: this.isDeepSeekServer(legacyServerUrl) ? "DeepSeek" : "Primary",
                serverUrl: legacyServerUrl,
                apiKey: this.isDeepSeekServer(legacyServerUrl)
                    ? await this.getDeepSeekApiKey()
                    : await this.getApiKey(),
                familyOverride: this.isDeepSeekServer(legacyServerUrl) ? "deepseek" : undefined,
                contextLengthOverride: this.isDeepSeekServer(legacyServerUrl)
                    ? this.getConfiguredDeepSeekContextLength()
                    : undefined,
            },
            modelId: parsed.modelId,
        };
    }

    private mapModelInfo(
        model: LlamaCppModelInfo,
        source: ChatModelSource,
        runtimeContextLength?: number
    ): LanguageModelChatInformation {
        const contextLength = this.resolveModelContextLength(model, runtimeContextLength, source);
        const family = this.resolveModelFamily(model.id, source.familyOverride);
        const configuredOutputCap = this.getConfiguredMaxOutputTokens();
        const maxOutputTokens = this.resolveAdvertisedMaxOutputTokens(
            family,
            contextLength,
            configuredOutputCap
        );
        const maxInputTokens = Math.max(1, contextLength - maxOutputTokens);
        const maxTools = this.clampInt(this.getConfig().get("maxToolsPerRequest", 128), 0, 128, 128);

        // Detect vision (image input) support from model metadata.
        // The API itself decides whether to accept image content blocks;
        // if the model (e.g. DeepSeek) supports vision it may use tools
        // like view_image to inspect attached images.
        // NOTE: DeepSeek API currently does NOT accept image_url content
        // blocks (returns 400 Bad Request), so vision is disabled for
        // DeepSeek models even if the model family supports it.
        const archMeta = model.meta as Record<string, unknown> | undefined;
        const inputModalities = (archMeta?.architecture as Record<string, unknown> | undefined)
            ?.input_modalities as string[] | undefined;
        const metaModalities = archMeta?.modalities as Record<string, unknown> | undefined;
        const metaCapabilities = Array.isArray(archMeta?.capabilities)
            ? archMeta.capabilities.filter((value): value is string => typeof value === "string")
            : [];
        const capabilities = [...(model.capabilities ?? []), ...metaCapabilities]
            .map(value => value.toLowerCase());
        const imageInput =
            model.modalities?.vision === true ||
            metaModalities?.vision === true ||
            (Array.isArray(inputModalities) && inputModalities.includes("image")) ||
            capabilities.includes("vision") ||
            capabilities.includes("multimodal");

        const info: LanguageModelChatInformation & Record<string, unknown> = {
            id: encodeProviderModelId(source.key, model.id),
            name: `${model.id} (${source.label})`,
            tooltip: `Model: ${model.id}\nSource: ${source.label}\nServer: ${source.serverUrl}\nContext: ${contextLength} tokens`,
            detail: `${source.label} / ${family} / ctx ${contextLength}`,
            family,
            version: "1.0.0",
            maxInputTokens,
            maxOutputTokens,
            capabilities: {
                toolCalling: maxTools > 0,
                imageInput,
            },
        };

        // Some model pickers (for example Copilot's BYOK picker pipeline) check these non-typed flags.
        info.isUserSelectable = true;
        info.multiplierNumeric = 0;
        info.model_picker_enabled = true;
        info.configurationSchema = createReasoningConfigurationSchema(family);

        return info;
    }

    /**
     * Provides information about available Llama.cpp models.
     * Fetches model list from the configured server and returns model information.
     *
     * @param options - Options for the request, including error suppression.
     * @param token - Cancellation token to abort the operation.
     * @returns Promise resolving to an array of available models.
     */
    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        const sources = await this.getModelSources();
        const modelListCacheTtlMs = this.getModelListCacheTtlMs();
        const allEntries: LanguageModelChatInformation[] = [];

        await Promise.all(sources.map(async source => {
            const apiKeyPresent = Boolean(source.apiKey);
            const runtimeContextLength = await this.getRuntimeContextLengthWithCache(
                source.serverUrl,
                source.apiKey,
                apiKeyPresent,
                modelListCacheTtlMs
            );

            const cachedModels = this.getFreshCachedModels(source.serverUrl, apiKeyPresent, modelListCacheTtlMs);
            if (cachedModels) {
                const entries = cachedModels.map(model => this.mapModelInfo(model, source, runtimeContextLength));
                allEntries.push(...entries);
                this.log("models.request.cache_hit", {
                    source: source.key,
                    serverUrl: source.serverUrl,
                    count: entries.length,
                    modelListCacheTtlMs,
                    runtimeContextLength,
                    models: entries.map(model => ({
                        id: model.id,
                        family: model.family,
                        maxInputTokens: model.maxInputTokens,
                        maxOutputTokens: model.maxOutputTokens,
                    })),
                });
                return;
            }

            this.log("models.request.start", {
                source: source.key,
                serverUrl: source.serverUrl,
                hasApiKey: apiKeyPresent,
                silent: options.silent,
                cancelled: token.isCancellationRequested,
                modelListCacheTtlMs,
            });

            try {
                const models = await this.fetchModelsWithInflightCache(source.serverUrl, source.apiKey, apiKeyPresent);
                this.cacheModels(source.serverUrl, apiKeyPresent, models);
                const entries = models.map(model => this.mapModelInfo(model, source, runtimeContextLength));
                allEntries.push(...entries);
                this.log("models.request.success", {
                    source: source.key,
                    serverUrl: source.serverUrl,
                    count: models.length,
                    runtimeContextLength,
                    models: entries.map(model => ({
                        id: model.id,
                        family: model.family,
                        maxInputTokens: model.maxInputTokens,
                        maxOutputTokens: model.maxOutputTokens,
                        capabilities: model.capabilities,
                    })),
                });
            } catch (err) {
                this.logError("models.request.failed", err, {
                    source: source.key,
                    serverUrl: source.serverUrl,
                    silent: options.silent,
                });
                const staleModels = this.getAnyCachedModels(source.serverUrl, apiKeyPresent);
                if (staleModels) {
                    const entries = staleModels.map(model => this.mapModelInfo(model, source, runtimeContextLength));
                    allEntries.push(...entries);
                    this.log("models.request.stale_cache_fallback", {
                        source: source.key,
                        serverUrl: source.serverUrl,
                        count: entries.length,
                    });
                    return;
                }
                if (!options.silent) {
                    console.error(`[Llama.cpp Provider] Failed to fetch models from ${source.label}`, err);
                }
            }
        }));

        const sortedEntries = allEntries.sort((a, b) => a.name.localeCompare(b.name));
        const localProfiles = sortedEntries
            .map(entry => ({ entry, parsed: parseProviderModelId(entry.id) }))
            .filter(({ parsed }) => parsed.sourceKey !== "deepseek" && !parsed.modelId.toLowerCase().includes("deepseek"))
            .map(({ entry, parsed }) => ({
                id: entry.id,
                label: entry.name,
                provider: "local" as const,
                availability: "available" as const,
                availabilityReason: "Model was discovered from the configured local endpoint",
                availabilityCheckedAt: Date.now(),
                useWhen: parsed.modelId.toLowerCase().includes("qwen")
                    ? "Prefer for narrow, inexpensive, independently verifiable tasks"
                    : "Use for focused local work when subscription budget should be preserved",
            }));
        const deepSeekProfiles = sortedEntries
            .map(entry => ({ entry, parsed: parseProviderModelId(entry.id) }))
            .filter(({ parsed }) => parsed.sourceKey === "deepseek" || parsed.modelId.toLowerCase().includes("deepseek"))
            .map(({ entry }) => ({
                id: entry.id,
                label: entry.name,
                provider: "deepseek" as const,
                defaultEffort: "high",
                availability: "available" as const,
                availabilityReason: "Model was discovered from the configured DeepSeek endpoint",
                availabilityCheckedAt: Date.now(),
                useWhen: entry.id.toLowerCase().includes("v4")
                    ? "Preferred DeepSeek V4 Pro profile for focused complex tasks"
                    : "Use for focused complex tasks that need more reasoning than Qwen",
            }));
        setSubagentModelProfiles("local", localProfiles);
        setSubagentModelProfiles("deepseek", deepSeekProfiles);
        return sortedEntries;
    }

    /**
     * Provides a chat response from the Llama.cpp model.
     * Sends a chat completion request to the server and processes the streaming response.
     *
     * @param model - Information about the selected model.
     * @param messages - Array of chat messages for the conversation.
     * @param options - Options for the response generation.
     * @param progress - Progress callback to report response parts.
     * @param token - Cancellation token to abort the operation.
     * @returns Promise that resolves when the response is complete.
     */
    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: readonly LanguageModelChatMessage[],
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        const { source, modelId: requestModelId } = await this.resolveSourceForModel(model);
        const serverUrl = source.serverUrl;
        const apiKey = source.apiKey;
        const apiKeyPresent = Boolean(apiKey);
        const cfg = this.getConfig();
        const requestId = randomUUID();
        const turnStartedAt = Date.now();
        const resolvedFamily = this.resolveModelFamily(requestModelId, source.familyOverride);
        // Reasoning must be looked up and stored per conversation so a parallel chat
        // cannot evict entries that this conversation's cached prefix depends on.
        const conversationScope = this.cachePrefixScope(requestModelId, options);
        this.setReasoningScope(conversationScope);
        // Large chats hand the provider hundreds of messages per request. The gap
        // since this conversation's last completed response measures how much
        // time VS Code (chat view rendering + request plumbing) adds between
        // model steps — the usual suspect behind "each step gets slower".
        const lastResponseEndedAt = conversationScope
            ? this.lastResponseEndedAtByScope.get(conversationScope)
            : undefined;
        if (lastResponseEndedAt !== undefined) {
            this.log("chat.request.arrived", {
                requestId,
                messageCount: messages.length,
                gapSinceLastResponseMs: Date.now() - lastResponseEndedAt,
                toolResultRound: messages.length > 0
                    && messages[messages.length - 1].content.some(
                        part => part instanceof vscode.LanguageModelToolResultPart
                    ),
            });
        }
        const imageInputSupported = model.capabilities?.imageInput === true;
        const processedMessages = imageInputSupported
            ? messages
            : this.saveUserImagesToTemp(messages, requestId);

        validateRequest(processedMessages);
        const inspectionMessages = convertMessages(processedMessages, {
            toolResultMode: "user",
            supportsImageInput: imageInputSupported,
        });

        let firstOutputAt: number | undefined;
        let emittedParts = 0;
        let outputChars = 0;
        let thinkingChars = 0;
        let emittedToolCallParts = 0;

        const runtimeContextLength = await this.getRuntimeContextLengthWithCache(
            serverUrl,
            apiKey,
            apiKeyPresent,
            this.getModelListCacheTtlMs()
        );
        const contextLength = this.resolveRuntimeContextLengthForRequest(model, runtimeContextLength, source);
        const contextUtil = this.clampNumber(cfg.get("contextUtilization", 0.85), 0.5, 0.95, 0.85);
        const hardContextUtil = this.clampNumber(cfg.get("hardContextUtilization", 0.72), 0.4, 0.9, 0.72);
        const keepLastTurns = this.clampInt(cfg.get("compactKeepLastTurns", 12), 2, 64, 12);
        const hardKeepLastTurns = this.clampInt(cfg.get("hardCompactKeepLastTurns", 6), 1, 32, 6);
        const maxOutputCap = this.getConfiguredMaxOutputTokens();
        const minReplyReserve = this.clampInt(cfg.get("minReplyReserveTokens", 1536), 256, 32768, 1536);
        const replyReservePercent = this.clampNumber(cfg.get("replyReservePercent", 0.07), 0.03, 0.25, 0.07);
        const maxTools = this.clampInt(cfg.get("maxToolsPerRequest", 128), 0, 128, 128);
        const requestTimeoutMs = this.clampInt(cfg.get("requestTimeoutMs", 1200000), 10000, 1200000, 1200000);
        const requestQueueTimeoutMs = this.getRequestQueueTimeoutMs();
        const transientRetryMaxAttempts = this.clampInt(cfg.get("transientRetryMaxAttempts", 2), 0, 3, 2);
        const transientRetryBaseDelayMs = this.clampInt(cfg.get("transientRetryBaseDelayMs", 500), 100, 10000, 500);
        const cacheWriteGraceMs = this.clampInt(
            cfg.get("deepSeekCacheWriteGraceMs", 60_000),
            0,
            600_000,
            60_000
        );
        const cachePrompt = this.getCachePromptEnabled();
        const maxToolResultChars = this.getMaxToolResultChars();
        const autoCompact = cfg.get<boolean>("autoCompact", true) !== false;
        const accurateTokenCounting = cfg.get<boolean>("accurateTokenCounting", true) !== false;
        const tokenizerTimeoutMs = this.clampInt(cfg.get("tokenizerTimeoutMs", 10000), 1000, 30000, 10000);
        const retryOnOverflow = cfg.get<boolean>("retryOnContextOverflow", true) !== false;
        const emptyResponseAutoRetry = cfg.get<boolean>("emptyResponseAutoRetry", true) !== false;
        const emptyResponseAutoRetryMaxAttempts = this.clampInt(
            cfg.get("emptyResponseAutoRetryMaxAttempts", 1),
            0,
            3,
            1
        );
        const toolCallOnlyAutoretry = cfg.get<boolean>("toolCallOnlyAutoretry", true) !== false;
        const toolCallOnlyAutoretryThreshold = this.clampInt(
            cfg.get("toolCallOnlyAutoretryThreshold", 3),
            2,
            10,
            3
        );
        const toolCallRepairEnabled = cfg.get<boolean>("toolCallRepairEnabled", true) !== false;
        const validateToolCallSchema = cfg.get<boolean>("validateToolCallSchema", true) !== false;
        const toolCallRepairMaxAttempts = this.clampInt(cfg.get("toolCallRepairMaxAttempts", 1), 0, 2, 1);
        const toolLoopProtection = cfg.get<boolean>("toolLoopProtection", true) !== false;
        const toolLoopDetectionThreshold = this.clampInt(cfg.get("toolLoopDetectionThreshold", 3), 2, 10, 3);
        const configuredContinuationPrompt = String(
            cfg.get(
                "emptyResponseContinuationPrompt",
                "Continue from your previous response and complete the answer. Do not repeat already completed parts."
            ) ?? ""
        ).trim();
        const emptyResponseContinuationPrompt =
            configuredContinuationPrompt.length > 0
                ? configuredContinuationPrompt
                : "Continue from your previous response and complete the answer. Do not repeat already completed parts.";
        const requestedThinkingMode = resolveRequestThinkingMode(
            cfg.get("thinkingMode", "auto"),
            options.modelOptions
        );
        const thinkingMode = requestedThinkingMode;
        const configuredReasoningBudget = this.clampInt(
            cfg.get("reasoningBudget", DEFAULT_LOCAL_REASONING_BUDGET),
            256,
            65536,
            DEFAULT_LOCAL_REASONING_BUDGET
        );
        const reasoningBudget = resolveReasoningBudget(thinkingMode, configuredReasoningBudget);
        const preserveThinking = resolvedFamily === "qwen"
            && /qwen3[._-]?6/i.test(requestModelId)
            && cfg.get<boolean>("preserveThinking", true) !== false;
        const toolResultModeConfig = this.normalizeToolResultMode(cfg.get("toolResultMode", "auto"));
        const toolCallingModeConfig = this.normalizeToolCallingMode(cfg.get("toolCallingMode", "apiDirect"));
        const apiDirectMaxTools = this.clampInt(cfg.get("apiDirectMaxTools", 70), 1, 128, 70);
        const apiDirectIncludeAllTools = cfg.get<boolean>("apiDirectIncludeAllTools", false) === true;
        const apiDirectToolTokenBudget = this.clampInt(cfg.get("apiDirectToolTokenBudget", 12000), 256, 65536, 12000);
        const knowledgeMode = normalizeKnowledgeMode(cfg.get("knowledgeMode", "adaptive"));
        const customSystemPrompt = String(cfg.get("customSystemPrompt", "") ?? "").trim().slice(0, 12000);
        const knowledgeSystemPrompt = buildKnowledgeSystemPrompt({
            mode: knowledgeMode,
            currentDate: formatLocalDate(new Date()),
            customPrompt: customSystemPrompt,
        });
        const sharedMemoryEnabled = cfg.get<boolean>("memoryEnabled", true) !== false;
        const sharedMemoryAutoInject = cfg.get<boolean>("memoryAutoInject", true) !== false;
        const sharedMemoryMaxTokens = this.clampInt(cfg.get("memoryMaxTokens", 4096), 128, 32768, 4096);

        this.log("chat.turn.start", {
            requestId,
            modelId: requestModelId,
            providerModelId: model.id,
            source: source.key,
            serverUrl,
            messageCount: messages.length,
            requestedModelOptions: this.cloneForLog(options.modelOptions),
            settings: {
                contextLength,
                contextUtil,
                hardContextUtil,
                keepLastTurns,
                hardKeepLastTurns,
                maxOutputCap,
                minReplyReserve,
                maxTools,
                requestTimeoutMs,
                requestQueueTimeoutMs,
                transientRetryMaxAttempts,
                transientRetryBaseDelayMs,
                cachePrompt,
                cacheWriteGraceMs,
                maxToolResultChars,
                runtimeContextLength,
                autoCompact,
                accurateTokenCounting,
                tokenizerTimeoutMs,
                retryOnOverflow,
                emptyResponseAutoRetry,
                emptyResponseAutoRetryMaxAttempts,
                toolCallOnlyAutoretry,
                toolCallOnlyAutoretryThreshold,
                toolCallRepairEnabled,
                validateToolCallSchema,
                toolCallRepairMaxAttempts,
                toolLoopProtection,
                toolLoopDetectionThreshold,
                emptyResponseContinuationPrompt,
                requestedThinkingMode,
                thinkingMode,
                configuredReasoningBudget,
                reasoningBudget,
                preserveThinking,
                toolResultModeConfig,
                toolCallingModeConfig,
                apiDirectMaxTools,
                apiDirectIncludeAllTools,
                apiDirectToolTokenBudget,
                knowledgeMode,
                knowledgeSystemPromptChars: knowledgeSystemPrompt?.length ?? 0,
                customSystemPromptChars: customSystemPrompt.length,
                sharedMemoryEnabled,
                sharedMemoryAutoInject,
                sharedMemoryMaxTokens,
            },
        });
        const convertedToolConfig = convertTools(options, {
            mode: toolCallingModeConfig as ToolCallingMode,
            apiDirectMaxTools,
            apiDirectIncludeAllTools,
            apiDirectToolTokenBudget,
        });
        const toolConfig = this.stabilizeToolCatalog(
            requestModelId,
            options,
            convertedToolConfig,
            inspectionMessages,
            requestId
        );
        const toolLoopDetection = toolLoopProtection
            ? detectRepeatedToolCallLoop(inspectionMessages, toolLoopDetectionThreshold)
            : undefined;
        if (toolLoopDetection) {
            this.log("chat.tools.loop_detected", { requestId, ...toolLoopDetection });
        }

        let sharedMemoryContext: SharedMemoryPromptContext | undefined;
        if (sharedMemoryEnabled && sharedMemoryAutoInject && this.sharedMemory) {
            try {
                sharedMemoryContext = await this.sharedMemory.buildPromptContext(
                    buildMemoryQuery(inspectionMessages),
                    sharedMemoryMaxTokens,
                    {
                        workspaceId: getCurrentWorkspaceScopeId(),
                        modelId: requestModelId,
                    }
                );
                this.log("chat.memory.context", {
                    requestId,
                    enabled: true,
                    entryCount: sharedMemoryContext?.entryCount ?? 0,
                    entryIds: sharedMemoryContext?.entryIds ?? [],
                    estimatedTokens: sharedMemoryContext?.estimatedTokens ?? 0,
                    expiredEntryCount: sharedMemoryContext?.expiredEntryCount ?? 0,
                });
            } catch (error) {
                this.logError("chat.memory.context_error", error, { requestId });
            }
        }

        const convertForMode = (mode: ToolResultMode): OpenAIChatMessage[] => {
            const converted = convertMessages(processedMessages, {
                toolResultMode: mode,
                supportsImageInput: imageInputSupported,
            });
            const withReasoning = this.injectStoredReasoningContent(converted);
            const withKnowledge = injectKnowledgeSystemPrompt(withReasoning, knowledgeSystemPrompt);
            const withMemory = injectSharedMemoryContext(withKnowledge, sharedMemoryContext?.text);
            const withLoopGuard = injectToolLoopGuard(withMemory, toolLoopDetection);
            return this.truncateToolResultMessages(
                withLoopGuard,
                maxToolResultChars,
                requestId
            );
        };

        const initialToolResultMode: ToolResultMode = toolResultModeConfig === "user" ? "user" : "tool";
        let activeToolResultMode: ToolResultMode = initialToolResultMode;

        // apiDirect mode already caps tools inside convertTools via apiDirectMaxTools.
        // Classic mode applies the request-level maxToolsPerRequest cap here.
        const cappedToolConfig: ReturnType<typeof convertTools> = {
            ...toolConfig,
            tools: toolCallingModeConfig === "apiDirect"
                ? toolConfig.tools
                : Array.isArray(toolConfig.tools) && maxTools > 0
                    ? toolConfig.tools.slice(0, maxTools)
                    : toolConfig.tools,
        };

        if (
            Array.isArray(toolConfig.tools) &&
            toolCallingModeConfig !== "apiDirect" &&
            toolConfig.tools.length > maxTools
        ) {
            console.warn(`[Llama.cpp Provider] Truncating tools from ${toolConfig.tools.length} to ${maxTools}`);
            this.log("chat.tools.truncated", {
                requestId,
                originalTools: toolConfig.tools.length,
                allowedTools: maxTools,
            });
        }

        const outputBudget = resolveOutputTokenBudget({
            family: resolvedFamily,
            requestedMaxTokens: typeof options.modelOptions?.max_tokens === "number"
                ? options.modelOptions.max_tokens
                : undefined,
            modelMaxOutputTokens: model.maxOutputTokens,
            hardCap: maxOutputCap,
            localDefault: this.clampInt(cfg.get("localDefaultMaxOutputTokens", 32768), 1024, 131072, 32768),
            deepSeekDefault: this.clampInt(cfg.get("deepSeekDefaultMaxOutputTokens", 65536), 1024, 393216, 65536),
            deepSeekMaximum: DEEPSEEK_MAX_OUTPUT_TOKENS,
        });
        const { defaultMaxTokens: defaultMaxOutputTokens, requestedMaxTokens } = outputBudget;
        const maxTokens = outputBudget.maxTokens;
        const temperatureDefault = resolvedFamily === "deepseek" ? 1.0 : resolvedFamily === "qwen" ? 0.6 : 0.7;
        const temperature = this.clampNumber(options.modelOptions?.temperature ?? temperatureDefault, 0, 2, temperatureDefault);
        const rawModelOptions = options.modelOptions as Record<string, unknown> | undefined;
        const qwenTopP = resolvedFamily === "qwen" ? 0.95 : undefined;
        const qwenTopK = resolvedFamily === "qwen" ? 20 : undefined;
        const qwenMinP = resolvedFamily === "qwen" ? 0 : undefined;
        const toolTokenCount = this.estimateToolTokens(cappedToolConfig.tools);
        const contextBudget = calculateContextBudget({
            contextLength,
            contextUtilization: contextUtil,
            hardContextUtilization: hardContextUtil,
            maxOutputTokens: maxTokens,
            minReplyReserveTokens: minReplyReserve,
            replyReservePercent,
            toolTokens: toolTokenCount,
        });
        const {
            modelInputLimit,
            inputBudget,
            replyReserveTokens: replyReserve,
            softInputTarget,
            hardInputTarget,
        } = contextBudget;

        this.log("chat.turn.budget", {
            requestId,
            modelInputLimit,
            inputBudget,
            toolTokenCount,
            replyReserve,
            softInputTarget,
            maxTokens,
            requestedMaxTokens,
            defaultMaxOutputTokens,
            requestProvidedOutputLimit: outputBudget.requestProvidedLimit,
            requestKind: "chat",
            cappedTools: Array.isArray(cappedToolConfig.tools) ? cappedToolConfig.tools.length : 0,
        });

        const requestBody = buildChatCompletionRequest({
            model: requestModelId,
            family: resolvedFamily,
            maxTokens,
            temperature,
            cachePrompt,
            thinkingMode,
            reasoningBudget,
            topP: typeof options.modelOptions?.top_p === "number"
                ? this.clampNumber(options.modelOptions.top_p, 0, 1, 1)
                : qwenTopP,
            topK: typeof options.modelOptions?.top_k === "number"
                ? this.clampInt(options.modelOptions.top_k, 0, 1000, 40)
                : qwenTopK,
            minP: typeof rawModelOptions?.min_p === "number"
                ? this.clampNumber(rawModelOptions.min_p, 0, 1, qwenMinP ?? 0)
                : qwenMinP,
            presencePenalty: typeof rawModelOptions?.presence_penalty === "number"
                ? this.clampNumber(rawModelOptions.presence_penalty, -2, 2, 0)
                : resolvedFamily === "qwen" ? 0 : undefined,
            preserveThinking,
            tools: cappedToolConfig.tools,
            toolChoice: cappedToolConfig.tool_choice,
        });

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "User-Agent": this.userAgent,
        };
        if (apiKey) {
            headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const waitForRetry = (delayMs: number): Promise<void> => new Promise((resolve, reject) => {
            if (token.isCancellationRequested) {
                reject(new vscode.CancellationError());
                return;
            }
            const retryState: { timeoutHandle?: ReturnType<typeof setTimeout> } = {};
            const cancellationSubscription = token.onCancellationRequested(() => {
                if (retryState.timeoutHandle) {
                    clearTimeout(retryState.timeoutHandle);
                }
                reject(new vscode.CancellationError());
            });
            retryState.timeoutHandle = setTimeout(() => {
                cancellationSubscription.dispose();
                resolve();
            }, delayMs);
        });

        const sendWithTransientRetry = async (stage: string): Promise<Response> => {
            const totalAttempts = transientRetryMaxAttempts + 1;
            for (let transportAttempt = 1; transportAttempt <= totalAttempts; transportAttempt += 1) {
                try {
                    const response = await this.sendChatCompletion(serverUrl, headers, requestBody, requestTimeoutMs, token);
                    if (!isTransientHttpStatus(response.status) || transportAttempt >= totalAttempts) {
                        return response;
                    }

                    const errorText = await response.text();
                    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
                    const exponentialDelay = transientRetryBaseDelayMs * (2 ** (transportAttempt - 1));
                    const delayMs = Math.min(30_000, retryAfterMs ?? Math.round(exponentialDelay + Math.random() * transientRetryBaseDelayMs * 0.25));
                    this.log("chat.request.transient_retry", {
                        requestId,
                        stage,
                        transportAttempt,
                        status: response.status,
                        statusText: response.statusText,
                        delayMs,
                        errorText: errorText.slice(0, 1000),
                    });
                    await waitForRetry(delayMs);
                } catch (error) {
                    const errorName = error instanceof Error ? error.name : "";
                    if (
                        token.isCancellationRequested
                        || errorName === "AbortError"
                        || errorName === "CancellationError"
                        || transportAttempt >= totalAttempts
                    ) {
                        throw error;
                    }

                    const exponentialDelay = transientRetryBaseDelayMs * (2 ** (transportAttempt - 1));
                    const delayMs = Math.min(30_000, Math.round(exponentialDelay + Math.random() * transientRetryBaseDelayMs * 0.25));
                    this.logError("chat.request.transient_transport_retry", error, {
                        requestId,
                        stage,
                        transportAttempt,
                        delayMs,
                    });
                    await waitForRetry(delayMs);
                }
            }
            throw new Error("Transient retry loop exhausted unexpectedly");
        };

        const countMessages = async (
            candidate: OpenAIChatMessage[]
        ): Promise<{ tokens: number; source: "server" | "heuristic"; promptTokens?: number }> => {
            const rawHeuristicTokens = this.estimateOpenAiMessageTokens(candidate);
            const heuristicTokens = Math.max(1, Math.round(rawHeuristicTokens * this.heuristicCalibration));
            if (!accurateTokenCounting || this.isDeepSeekServer(serverUrl)) {
                return { tokens: heuristicTokens, source: "heuristic" };
            }

            const startedAt = Date.now();
            const promptTokens = await this.serverTokenCounter.countChatPrompt({
                serverUrl,
                model: requestModelId,
                headers,
                messages: candidate,
                tools: cappedToolConfig.tools,
                chatTemplateKwargs: requestBody.chat_template_kwargs as Record<string, unknown> | undefined,
                timeoutMs: tokenizerTimeoutMs,
                cancellation: token,
            });
            const source = promptTokens === undefined ? "heuristic" : "server";
            this.log("chat.tokens.count", {
                requestId,
                source,
                messageCount: candidate.length,
                promptTokens,
                heuristicMessageTokens: heuristicTokens,
                toolTokenEstimate: toolTokenCount,
                durationMs: Date.now() - startedAt,
            });
            if (promptTokens === undefined) {
                return { tokens: heuristicTokens, source };
            }

            return {
                tokens: Math.max(1, promptTokens - toolTokenCount),
                source,
                promptTokens,
            };
        };

        const prepareMessagesForBudget = async (sourceMessages: OpenAIChatMessage[]): Promise<PreparedMessagesForBudget> => {
            let autoCompacted = false;
            const hardCompacted = false;
            const hardTarget = hardInputTarget;

            // Build the effective message set for token counting.
            // Instead of counting the full VS Code source (which always grows
            // and forces unnecessary re-compaction), we chain new messages onto
            // the last successful compaction snapshot.  This means auto-compact
            // only fires when the *actual* context usage approaches the limit,
            // not when the raw source history is large.
            let effectiveMessages: OpenAIChatMessage[];
            let snapshotStale = false;
            const conversationSnapshot = this.getConversationMessageSnapshot(conversationScope);
            const snapshotMessages = conversationSnapshot?.messages;
            const rebuildOverCompactedMigration = Boolean(
                conversationSnapshot?.migratedFromPrefix
                && snapshotMessages
                && sourceMessages.length > snapshotMessages.length * 2
                && conversationSnapshot.tokenCount < softInputTarget * 0.6
            );
            if (rebuildOverCompactedMigration) {
                this.deleteConversationMessageSnapshot(conversationScope);
                effectiveMessages = sourceMessages;
                this.log("chat.messages.snapshot_migration_rebuild", {
                    requestId,
                    migratedMessages: snapshotMessages?.length ?? 0,
                    migratedTokenEstimate: conversationSnapshot?.tokenCount ?? 0,
                    sourceMessages: sourceMessages.length,
                    softInputTarget,
                });
            } else if (snapshotMessages && snapshotMessages.length > 0) {
                const newMessages = this.findNewMessagesAfterSnapshot(sourceMessages, snapshotMessages);
                // When findNewMessagesAfterSnapshot returns all source messages
                // (pivot not found), the snapshot is stale — for example a
                // subagent injected tool messages between turns and reshuffled
                // the history.  Discard the snapshot so we avoid double-counting
                // messages and triggering an unnecessary compaction.
                if (newMessages.length >= sourceMessages.length) {
                    this.log("chat.messages.snapshot_stale", {
                        requestId,
                        reason: "pivot_not_found_after_subagent_or_injection",
                        snapshotMessages: snapshotMessages.length,
                        sourceMessages: sourceMessages.length,
                    });
                    this.deleteConversationMessageSnapshot(conversationScope);
                    effectiveMessages = sourceMessages;
                    // When the snapshot is stale we cannot trust the heuristic
                    // token count — counting all source messages always
                    // over-estimates.  Defer compaction until the server
                    // actually reports an overflow.
                    snapshotStale = true;
                } else {
                    effectiveMessages = [...snapshotMessages, ...newMessages];
                }
            } else {
                effectiveMessages = sourceMessages;
            }

            let preparedMessages = effectiveMessages;
            let counted = await countMessages(preparedMessages);
            let messageTokenCount = counted.tokens;
            const initialMessageCount = sourceMessages.length;
            const initialTokenEstimate = messageTokenCount;

            this.log("chat.messages.initial", {
                requestId,
                tokenEstimate: messageTokenCount,
                tokenCountSource: counted.source,
                promptTokens: counted.promptTokens,
                messageCount: preparedMessages.length,
                sourceMessageCount: sourceMessages.length,
            });

            const compactionDecision = selectContextCompaction({
                messageTokens: messageTokenCount,
                autoCompact: autoCompact && !snapshotStale,
                softInputTarget,
                hardInputTarget,
                overflowRetry: false,
            });
            if (compactionDecision.kind === "auto") {
                const compactStartedAt = Date.now();
                preparedMessages = this.compactOpenAiMessages(
                    preparedMessages,
                    compactionDecision.target,
                    keepLastTurns,
                    "Conversation summary (auto-compact)"
                );
                counted = await countMessages(preparedMessages);
                messageTokenCount = counted.tokens;
                autoCompacted = true;
                this.log("chat.messages.auto_compact", {
                    requestId,
                    tokenEstimate: messageTokenCount,
                    tokenCountSource: counted.source,
                    promptTokens: counted.promptTokens,
                    messageCount: preparedMessages.length,
                    target: compactionDecision.target,
                    compactDurationMs: Date.now() - compactStartedAt,
                });
            } else if (snapshotStale) {
                // Snapshot was stale — rebuild it from the current messages so
                // the next turn can use incremental counting instead of falling
                // back to the full source again.
                this.log("chat.messages.snapshot_rebuilt", {
                    requestId,
                    messageCount: preparedMessages.length,
                    tokenEstimate: messageTokenCount,
                });
            }

            return {
                messages: preparedMessages,
                initialTokenEstimate,
                finalTokenEstimate: messageTokenCount,
                initialMessageCount,
                finalMessageCount: preparedMessages.length,
                autoCompacted,
                hardCompacted,
                hardTarget,
                tokenCountSource: counted.source,
            };
        };

        type AttemptResult =
            | { ok: true; response: Response; retriedAfterOverflow: boolean; attemptNo: number }
            | {
                  ok: false;
                  status: number;
                  statusText: string;
                  errorText: string;
                  retriedAfterOverflow: boolean;
                  attemptNo: number;
              };

        let attemptCounter = 0;
        let latestContextUsage: LlamaChatContextUsageMetrics | undefined;
        let latestCachePrefix: CachePrefixTelemetry | undefined;
        let latestAutoCompacted = false;
        let latestBackendVia: string | undefined;
        let latestBackendCfPop: string | undefined;
        let latestBackendTraceId: string | undefined;
        const attemptRequest = async (sourceMessages: OpenAIChatMessage[]): Promise<AttemptResult> => {
            attemptCounter += 1;
            const attemptNo = attemptCounter;
            const prepared = await prepareMessagesForBudget(sourceMessages);
            latestAutoCompacted = prepared.autoCompacted;

            // Stabilise the prefix against the previous request of the same
            // conversation so DeepSeek can serve it from its disk cache.  Without
            // this VS Code's own history trimming (which drops varying numbers of
            // middle messages between turns) would rewrite the prompt body and
            // invalidate the entire upstream prefix every time.
            const staticFields = Object.fromEntries(
                Object.entries(requestBody).filter(([key]) => key !== "messages" && key !== "tools")
            );
            const staticFieldsHash = this.shortHash(stableJsonStringify(staticFields));
            // Sort tools by name so the hash is order-independent — VS Code may
            // change tool enumeration order between restarts, which would
            // otherwise break the toolsHash match and skip prefix stabilization.
            const toolsForHash = Array.isArray(requestBody.tools)
                ? [...(requestBody.tools as Array<{ function?: { name?: string } }>)].sort(
                    (a, b) => {
                        const na = a.function?.name ?? "";
                        const nb = b.function?.name ?? "";
                        return na < nb ? -1 : na > nb ? 1 : 0;
                    }
                )
                : (requestBody.tools ?? []);
            const toolsHash = this.shortHash(stableJsonStringify(toolsForHash));
            const stabilized = this.stabilizeMessagePrefix(
                requestId, requestModelId, conversationScope, prepared.messages, staticFieldsHash, toolsHash,
                Array.isArray(cappedToolConfig.tools) ? cappedToolConfig.tools.length : 0
            );
            requestBody.messages = stabilized.messages;
            this.setConversationMessageSnapshot(
                conversationScope,
                stabilized.messages,
                prepared.finalTokenEstimate
            );
            latestCachePrefix = stabilized.prefix as CachePrefixTelemetry;

            const cappedTools = Array.isArray(cappedToolConfig.tools) ? cappedToolConfig.tools.length : 0;
            const {
                estimatedUsedTokens,
                estimatedFreeTokens,
                estimatedUsagePercent,
            } = estimateContextUsage(
                modelInputLimit,
                prepared.finalTokenEstimate,
                toolTokenCount,
                replyReserve
            );

            latestContextUsage = {
                requestId,
                modelId: model.id,
                attemptNo,
                contextLength: modelInputLimit,
                inputBudget,
                softInputTarget,
                hardInputTarget: prepared.hardTarget,
                messageTokensBeforeCompact: prepared.initialTokenEstimate,
                messageTokensAfterCompact: prepared.finalTokenEstimate,
                messageCountBeforeCompact: prepared.initialMessageCount,
                messageCountAfterCompact: prepared.finalMessageCount,
                toolTokens: toolTokenCount,
                replyReserveTokens: replyReserve,
                cappedTools,
                autoCompacted: prepared.autoCompacted,
                hardCompacted: prepared.hardCompacted,
                estimatedUsedTokens,
                estimatedFreeTokens,
                estimatedUsagePercent,
                tokenCountSource: prepared.tokenCountSource,
            };
            this.log("chat.context.usage", latestContextUsage);
            this._onDidUpdateContextUsage.fire(latestContextUsage);

            this.log("chat.request.send", {
                requestId,
                attemptNo,
                endpoint: this.getChatCompletionsEndpoint(serverUrl),
                timeoutMs: requestTimeoutMs,
                toolResultMode: activeToolResultMode,
                headers: this.redactHeaders(headers),
                requestBody: this.summarizeRequestBodyForLog(requestBody),
                cachePrefix: latestCachePrefix,
            });

            let response: Response;
            const requestStartedAt = Date.now();
            if ((prepared.autoCompacted || prepared.hardCompacted) && conversationScope) {
                // The upstream disk-cache write for a freshly compacted prefix is
                // asynchronous. Remember when this request left so the next round
                // can wait for the write to become readable.
                this.lastCompactionSentAtByScope.set(conversationScope, requestStartedAt);
            }
            try {
                response = await sendWithTransientRetry("initial");
            } catch (error) {
                this.logError("chat.request.transport_error", error, {
                    requestId,
                    attemptNo,
                    timeoutMs: requestTimeoutMs,
                    cancelled: token.isCancellationRequested,
                });
                throw error;
            }

            this.log("chat.request.response", {
                requestId,
                attemptNo,
                status: response.status,
                statusText: response.statusText,
                durationMs: Date.now() - requestStartedAt,
                backendVia: response.headers.get("via") ?? undefined,
                backendCfPop: response.headers.get("x-amz-cf-pop") ?? undefined,
                backendTraceId: response.headers.get("x-ds-trace-id") ?? undefined,
            });

            // Capture backend-identifying headers for session-quality diagnostics.
            latestBackendVia = response.headers.get("via") ?? undefined;
            latestBackendCfPop = response.headers.get("x-amz-cf-pop") ?? undefined;
            latestBackendTraceId = response.headers.get("x-ds-trace-id") ?? undefined;

            let retriedAfterOverflow = false;

            if (!response.ok && retryOnOverflow) {
                const errText = await response.text();
                this.log("chat.request.error", {
                    requestId,
                    attemptNo,
                    status: response.status,
                    statusText: response.statusText,
                    errorText: errText,
                });
                if (this.isContextOverflowError(response.status, errText)) {
                    const overflowCompaction = selectContextCompaction({
                        messageTokens: prepared.finalTokenEstimate,
                        autoCompact,
                        softInputTarget,
                        hardInputTarget,
                        overflowRetry: true,
                    });
                    const hardTarget = overflowCompaction.kind === "hard"
                        ? overflowCompaction.target
                        : hardInputTarget;
                    const compactStartedAt = Date.now();
                    const overflowMessages = this.compactOpenAiMessages(
                        prepared.messages,
                        hardTarget,
                        hardKeepLastTurns,
                        "Conversation summary (overflow retry)"
                    );
                    requestBody.messages = overflowMessages;

                    const overflowCount = await countMessages(overflowMessages);
                    const overflowMessageTokens = overflowCount.tokens;
                    this.setConversationMessageSnapshot(
                        conversationScope,
                        overflowMessages,
                        overflowMessageTokens
                    );
                    const {
                        estimatedUsedTokens: overflowEstimatedUsedTokens,
                        estimatedFreeTokens: overflowEstimatedFreeTokens,
                        estimatedUsagePercent: overflowEstimatedUsagePercent,
                    } = estimateContextUsage(
                        modelInputLimit,
                        overflowMessageTokens,
                        toolTokenCount,
                        replyReserve
                    );

                    if (latestContextUsage) {
                        latestContextUsage = {
                            ...latestContextUsage,
                            messageTokensAfterCompact: overflowMessageTokens,
                            messageCountAfterCompact: overflowMessages.length,
                            hardInputTarget: hardTarget,
                            hardCompacted: true,
                            estimatedUsedTokens: overflowEstimatedUsedTokens,
                            estimatedFreeTokens: overflowEstimatedFreeTokens,
                            estimatedUsagePercent: overflowEstimatedUsagePercent,
                            tokenCountSource: overflowCount.source,
                        };
                        this.log("chat.context.usage", latestContextUsage);
                        this._onDidUpdateContextUsage.fire(latestContextUsage);
                    }

                    this.log("chat.request.overflow_retry", {
                        requestId,
                        attemptNo,
                        hardTarget,
                        compactDurationMs: Date.now() - compactStartedAt,
                        retryMessageCount: Array.isArray(requestBody.messages)
                            ? requestBody.messages.length
                            : undefined,
                        requestBody: this.summarizeRequestBodyForLog(requestBody),
                    });

                    const retryStartedAt = Date.now();
                    try {
                        response = await sendWithTransientRetry("overflow");
                    } catch (error) {
                        this.logError("chat.request.overflow_retry_transport_error", error, {
                            requestId,
                            attemptNo,
                            timeoutMs: requestTimeoutMs,
                            cancelled: token.isCancellationRequested,
                        });
                        throw error;
                    }

                    this.log("chat.request.overflow_retry_response", {
                        requestId,
                        attemptNo,
                        status: response.status,
                        statusText: response.statusText,
                        durationMs: Date.now() - retryStartedAt,
                    });
                    retriedAfterOverflow = true;
                } else {
                    return {
                        ok: false,
                        status: response.status,
                        statusText: response.statusText,
                        errorText: errText,
                        retriedAfterOverflow,
                        attemptNo,
                    };
                }
            }

            if (!response.ok) {
                const errorText = await response.text();
                this.log("chat.request.final_error", {
                    requestId,
                    attemptNo,
                    status: response.status,
                    statusText: response.statusText,
                    errorText,
                    retriedAfterOverflow,
                });
                return {
                    ok: false,
                    status: response.status,
                    statusText: response.statusText,
                    errorText,
                    retriedAfterOverflow,
                    attemptNo,
                };
            }

            this.log("chat.request.success", {
                requestId,
                attemptNo,
                retriedAfterOverflow,
            });

            return { ok: true, response, retriedAfterOverflow, attemptNo };
        };

        let chatSlot: ChatRequestSlotLease | undefined;
        try {
            chatSlot = await this.acquireChatRequestSlot(requestId, requestQueueTimeoutMs, token);
        } catch (error) {
            const cancelled = token.isCancellationRequested || error instanceof vscode.CancellationError;
            if (cancelled) {
                this.log("chat.queue.cancelled", {
                    requestId,
                    requestQueueTimeoutMs,
                });
            } else {
                this.logError("chat.queue.failed", error, { requestId, requestQueueTimeoutMs });
            }
            throw error;
        }
        try {
            // DeepSeek materializes a compacted prefix's disk-cache asynchronously.
            // The first continuation round after a compaction would otherwise miss
            // twice (history rewrite + write not yet readable). Wait out the
            // remaining grace window so the tool-result round reuses the prefix.
            const isToolResultRound = processedMessages.length > 0
                && processedMessages[processedMessages.length - 1].content.some(
                    part => part instanceof vscode.LanguageModelToolResultPart
                );
            if (
                cacheWriteGraceMs > 0
                && cachePrompt
                && isDeepSeekEndpoint(serverUrl)
                && isToolResultRound
                && conversationScope
            ) {
                const compactionSentAt = this.lastCompactionSentAtByScope.get(conversationScope);
                if (compactionSentAt !== undefined) {
                    this.lastCompactionSentAtByScope.delete(conversationScope);
                    const remaining = cacheWriteGraceMs - (Date.now() - compactionSentAt);
                    if (remaining > 0) {
                        this.log("chat.request.cache_write_grace", {
                            requestId,
                            waitMs: remaining,
                            compactionAgeMs: Date.now() - compactionSentAt,
                        });
                        await waitForRetry(remaining);
                    }
                }
            }

            const runAttemptWithToolCompatibility = async (
                sourceMessages: OpenAIChatMessage[]
            ): Promise<{ attempt: Extract<AttemptResult, { ok: true }>; usedMessages: OpenAIChatMessage[] }> => {
                let attempt = await attemptRequest(sourceMessages);
                let usedMessages = sourceMessages;

                if (
                    !attempt.ok &&
                    toolResultModeConfig === "auto" &&
                    activeToolResultMode === "tool" &&
                    this.isToolRoleCompatibilityError(attempt.status, attempt.errorText)
                ) {
                    console.warn("[Llama.cpp Provider] Falling back to user-style tool results for compatibility");
                    this.log("chat.tool_result_mode.fallback", {
                        requestId,
                        from: "tool",
                        to: "user",
                        status: attempt.status,
                        statusText: attempt.statusText,
                        errorText: attempt.errorText,
                    });
                    activeToolResultMode = "user";
                    usedMessages = convertForMode(activeToolResultMode);
                    attempt = await attemptRequest(usedMessages);
                }

                if (!attempt.ok) {
                    const retryHint = attempt.retriedAfterOverflow
                        ? "\nRetry after automatic compaction did not fit context."
                        : "";
                    throw new Error(`Llama.cpp API error: ${attempt.status} ${attempt.statusText}\n${attempt.errorText}${retryHint}`);
                }

                return { attempt, usedMessages };
            };

            let continuationRetryCount = 0;
            let consecutiveToolCallOnlyTurns = 0;
            let toolCallRepairRetryCount = 0;
            const reliabilityMetrics: ToolCallReliabilityMetrics = {
                accepted: 0,
                repaired: 0,
                rejected: 0,
                unknownTool: 0,
                schemaRejected: 0,
                loopDetected: Boolean(toolLoopDetection),
            };
            const mergeReliabilityMetrics = (metrics: ToolCallReliabilityMetrics): void => {
                reliabilityMetrics.accepted += metrics.accepted;
                reliabilityMetrics.repaired += metrics.repaired;
                reliabilityMetrics.rejected += metrics.rejected;
                reliabilityMetrics.unknownTool += metrics.unknownTool;
                reliabilityMetrics.schemaRejected += metrics.schemaRejected;
                reliabilityMetrics.loopDetected ||= metrics.loopDetected;
            };
            let sourceMessages = convertForMode(activeToolResultMode);
            let finalAttempt: Extract<AttemptResult, { ok: true }> | undefined;
            let accumulatedServerUsage: ChatTokenUsage | undefined;
            let modelTurns = 0;

            while (true) {
                const { attempt, usedMessages } = await runAttemptWithToolCompatibility(sourceMessages);
                modelTurns += 1;
                sourceMessages = usedMessages;

                if (!attempt.response.body) {
                    throw new Error("No response body from Llama.cpp API");
                }

                let roundOutputChars = 0;
                let roundThinkingChars = 0;
                let roundToolCallParts = 0;

                let responseBody = attempt.response.body;
                let streamLogTask: Promise<void> | undefined;
                if (this.logger?.shouldLogStreamChunks()) {
                    const [processingStream, loggingStream] = responseBody.tee();
                    responseBody = processingStream;
                    streamLogTask = this.captureRawStream(loggingStream, requestId, token);
                    this.log("chat.stream.capture_started", {
                        requestId,
                        attemptNo: attempt.attemptNo,
                    });
                }

                const measuredProgress: Progress<LanguageModelResponsePart> = {
                    report: part => {
                        emittedParts += 1;
                        const emittedThinkingText = this.getEmittedThinkingText(part);
                        if (emittedThinkingText !== undefined) {
                            thinkingChars += emittedThinkingText.length;
                            roundThinkingChars += emittedThinkingText.length;
                            if (emittedThinkingText.length > 0 && firstOutputAt === undefined) {
                                firstOutputAt = Date.now();
                            }
                        } else if (part instanceof vscode.LanguageModelTextPart) {
                            outputChars += part.value.length;
                            roundOutputChars += part.value.length;
                            if (part.value.length > 0 && firstOutputAt === undefined) {
                                firstOutputAt = Date.now();
                            }
                        } else if (part instanceof vscode.LanguageModelToolCallPart) {
                            emittedToolCallParts += 1;
                            roundToolCallParts += 1;
                        } else if (this.isThinkingResponsePart(part)) {
                            const thinkingText = this.getThinkingPartText(part);
                            thinkingChars += thinkingText.length;
                            roundThinkingChars += thinkingText.length;
                            if (thinkingText.length > 0 && firstOutputAt === undefined) {
                                firstOutputAt = Date.now();
                            }
                        }
                        progress.report(part);
                    },
                };

                this.configureToolCallReliability(cappedToolConfig.tools, {
                    repairEnabled: toolCallRepairEnabled,
                    validateSchema: validateToolCallSchema,
                });
                let roundServerUsage: ChatTokenUsage | undefined;
                try {
                    roundServerUsage = await this.processStreamingResponse(responseBody, measuredProgress, token);
                    await streamLogTask;
                    mergeReliabilityMetrics(this.consumeToolCallReliabilityMetrics());
                } catch (error) {
                    await streamLogTask;
                    mergeReliabilityMetrics(this.consumeToolCallReliabilityMetrics());
                    const canRetryToolCall =
                        error instanceof ToolCallValidationError &&
                        toolCallRepairEnabled &&
                        toolCallRepairRetryCount < toolCallRepairMaxAttempts &&
                        roundOutputChars === 0 &&
                        roundToolCallParts === 0 &&
                        !token.isCancellationRequested;
                    if (!canRetryToolCall) {
                        throw error;
                    }

                    toolCallRepairRetryCount += 1;
                    const allowedNames = (cappedToolConfig.tools ?? [])
                        .map(tool => tool.function.name)
                        .slice(0, 32)
                        .join(", ");
                    this.log("chat.tools.validation_retry", {
                        requestId,
                        attemptNo: attempt.attemptNo,
                        retry: toolCallRepairRetryCount,
                        kind: error.kind,
                        toolName: error.toolName,
                        reason: error.message,
                    });
                    sourceMessages = [
                        ...sourceMessages,
                        {
                            role: "user",
                            content: [
                                "Your previous tool call was rejected before execution.",
                                `Reason: ${error.message}`,
                                `Available tools: ${allowedNames || "none"}.`,
                                "Retry once with an exact available tool name and a valid JSON object that follows its schema. Do not repeat the malformed call.",
                            ].join("\n"),
                        },
                    ];
                    continue;
                }

                if (roundServerUsage) {
                    accumulatedServerUsage = accumulatedServerUsage
                        ? mergeChatTokenUsage(accumulatedServerUsage, roundServerUsage)
                        : roundServerUsage;
                }

                if (
                    roundOutputChars === 0 &&
                    roundToolCallParts === 0 &&
                    !token.isCancellationRequested &&
                    emptyResponseAutoRetry &&
                    continuationRetryCount < emptyResponseAutoRetryMaxAttempts
                ) {
                    continuationRetryCount += 1;
                    this.log("chat.response.empty_output_autoretry", {
                        requestId,
                        attemptNo: attempt.attemptNo,
                        toolResultMode: activeToolResultMode,
                        continuationRetryCount,
                        emptyResponseAutoRetryMaxAttempts,
                        emittedParts,
                        emittedToolCallParts,
                        thinkingChars,
                    });

                    sourceMessages = [
                        ...sourceMessages,
                        {
                            role: "user",
                            content: emptyResponseContinuationPrompt,
                        },
                    ];
                    continue;
                }

                if (roundOutputChars === 0 && roundToolCallParts === 0 && !token.isCancellationRequested) {
                    const fallbackText =
                        "No text response was produced by the model for this turn. See the latest log for details.";
                    measuredProgress.report(new vscode.LanguageModelTextPart(fallbackText));
                    this.log("chat.response.empty_output_fallback", {
                        requestId,
                        attemptNo: attempt.attemptNo,
                        toolResultMode: activeToolResultMode,
                        continuationRetryCount,
                        emittedParts,
                        emittedToolCallParts,
                        thinkingChars,
                    });
                } else if (roundOutputChars === 0 && roundToolCallParts > 0) {
                    consecutiveToolCallOnlyTurns += 1;
                    const shouldNudge =
                        toolCallOnlyAutoretry &&
                        consecutiveToolCallOnlyTurns >= toolCallOnlyAutoretryThreshold &&
                        !token.isCancellationRequested;

                    this.log("chat.response.empty_output_with_tool_calls", {
                        requestId,
                        attemptNo: attempt.attemptNo,
                        toolResultMode: activeToolResultMode,
                        continuationRetryCount,
                        emittedParts,
                        emittedToolCallParts,
                        thinkingChars,
                        roundThinkingChars,
                        consecutiveToolCallOnlyTurns,
                        toolCallOnlyNudge: shouldNudge,
                    });

                    if (shouldNudge) {
                        consecutiveToolCallOnlyTurns = 0;
                        this.log("chat.response.tool_call_only_nudge", {
                            requestId,
                            attemptNo: attempt.attemptNo,
                            toolResultMode: activeToolResultMode,
                            emittedParts,
                            emittedToolCallParts,
                        });
                        sourceMessages = [
                            ...sourceMessages,
                            {
                                role: "user",
                                content:
                                    "You have been making tool calls without any text response for several turns. " +
                                    "Please pause, summarize what you have accomplished so far, and state your next plan clearly before making more tool calls.",
                            },
                        ];
                        continue;
                    }
                } else {
                    // Text was produced; reset the tool-call-only counter.
                    consecutiveToolCallOnlyTurns = 0;
                }

                finalAttempt = attempt;
                break;
            }

            if (!finalAttempt) {
                throw new Error("No final chat attempt result available");
            }

            const finishedAt = Date.now();
            const firstTokenLatencyMs = firstOutputAt === undefined ? undefined : firstOutputAt - turnStartedAt;
            const generationMs = firstOutputAt === undefined ? 0 : Math.max(1, finishedAt - firstOutputAt);
            const estimatedOutputTokens = Math.ceil(Math.max(0, outputChars) / 4);
            const tokensPerSecond = generationMs > 0 ? Number((estimatedOutputTokens / (generationMs / 1000)).toFixed(2)) : undefined;
            const queueWaitMs = chatSlot.waitMs;
            const estimatedPromptTokens = (latestContextUsage?.messageTokensAfterCompact ?? 0) +
                (latestContextUsage?.toolTokens ?? 0);
            const reportedUsage = accumulatedServerUsage ?? estimateChatTokenUsage(
                estimatedPromptTokens,
                outputChars + thinkingChars
            );
            const usageSource = accumulatedServerUsage ? "server" : "estimate";
            const promptCacheUsage = calculatePromptCacheUsage(reportedUsage);

            // Self-calibrate the heuristic token counter using server-reported
            // prompt_tokens.  An exponential moving average (α=0.3) keeps the
            // factor stable across turns while adapting to conversation drift.
            if (accumulatedServerUsage && reportedUsage.prompt_tokens > 0) {
                const messageTokens = latestContextUsage?.messageTokensAfterCompact ?? 0;
                if (messageTokens > 0) {
                    const toolTokens = latestContextUsage?.toolTokens ?? 0;
                    const serverMessageTokens = Math.max(1, reportedUsage.prompt_tokens - toolTokens);
                    const ratio = serverMessageTokens / Math.max(1, messageTokens);
                    const clamped = Math.max(0.2, Math.min(3.0, ratio));
                    const previousFactor = this.heuristicCalibration;
                    this.heuristicCalibration = previousFactor * 0.7 + clamped * 0.3;
                    this.log("chat.heuristic.calibrate", {
                        requestId,
                        previousFactor: +previousFactor.toFixed(3),
                        newFactor: +this.heuristicCalibration.toFixed(3),
                        ratio: +ratio.toFixed(3),
                        serverTokens: reportedUsage.prompt_tokens,
                        messageEstimate: messageTokens,
                    });
                }
            }

            progress.report(vscode.LanguageModelDataPart.text(JSON.stringify(reportedUsage), "usage"));
            this.log("chat.response.usage", {
                requestId,
                attemptNo: finalAttempt.attemptNo,
                source: usageSource,
                usage: reportedUsage,
                promptCache: promptCacheUsage,
            });

            const previousTurnCompacted = conversationScope
                ? this.lastTurnCompactedByScope.get(conversationScope) ?? false
                : false;
            if (conversationScope) {
                this.lastTurnCompactedByScope.set(conversationScope, latestAutoCompacted);
            }
            const cacheDiagnostics = usageSource === "server"
                ? buildCacheDiagnostics({
                    provider: isDeepSeekEndpoint(serverUrl) ? "deepseek" : "local",
                    modelId: requestModelId,
                    requestId,
                    usage: promptCacheUsage,
                    prefix: latestCachePrefix,
                    autoCompacted: latestAutoCompacted,
                    previousTurnCompacted,
                })
                : undefined;

            if (cacheDiagnostics) {
                this.log("chat.cache.report", cacheDiagnostics);
            }

            const metrics: LlamaChatTurnMetrics = {
                requestId,
                modelId: model.id,
                providerKind: isDeepSeekEndpoint(serverUrl) ? "deepseek" : "local",
                lifecyclePhase: "completed",
                conversationKey: typeof options.modelOptions?._copilotConversationId === "string"
                    ? this.shortHash(options.modelOptions._copilotConversationId)
                    : undefined,
                durationMs: finishedAt - turnStartedAt,
                queueWaitMs,
                firstTokenLatencyMs,
                emittedParts,
                outputChars,
                thinkingChars,
                estimatedOutputTokens,
                outputTokens: reportedUsage.completion_tokens,
                tokensPerSecond,
                promptTokens: reportedUsage.prompt_tokens,
                cachedPromptTokens: promptCacheUsage?.cachedTokens,
                promptCacheHitPercent: promptCacheUsage?.hitPercent,
                cacheMissReason: cacheDiagnostics?.reason,
                cacheMissDetail: cacheDiagnostics?.detail,
                prefixIdenticalMessageCount: latestCachePrefix?.identicalMessagePrefix,
                prefixPreviousMessageCount: latestCachePrefix?.previousMessageCount,
                prefixReusableMessagePercent: latestCachePrefix?.reusableMessagePercent,
                prefixStaticFieldsMatch: latestCachePrefix?.staticFieldsMatch,
                prefixToolsMatch: latestCachePrefix?.toolsMatch,
                backendVia: latestBackendVia ?? undefined,
                backendCfPop: latestBackendCfPop ?? undefined,
                backendTraceId: latestBackendTraceId ?? undefined,
                modelTurns,
                usageEstimated: !accumulatedServerUsage,
                retriedAfterOverflow: finalAttempt.retriedAfterOverflow,
                toolCalls: emittedToolCallParts,
                repairedToolCalls: reliabilityMetrics.repaired,
                rejectedToolCalls: reliabilityMetrics.rejected,
                schemaRejectedToolCalls: reliabilityMetrics.schemaRejected,
                toolCallRepairRetries: toolCallRepairRetryCount,
                toolLoopDetected: reliabilityMetrics.loopDetected,
            };

            this.log("chat.turn.complete", {
                requestId,
                attemptNo: finalAttempt.attemptNo,
                retriedAfterOverflow: finalAttempt.retriedAfterOverflow,
                continuationRetryCount,
                toolCallReliability: reliabilityMetrics,
                toolCallRepairRetryCount,
                toolResultMode: activeToolResultMode,
                contextUsage: latestContextUsage,
                metrics,
            });

            this._onDidCompleteChatTurn.fire(metrics);
            if (conversationScope) {
                this.lastResponseEndedAtByScope.set(conversationScope, Date.now());
            }
        } catch (err) {
            const cancelled = token.isCancellationRequested || err instanceof vscode.CancellationError;
            if (cancelled) {
                this.log("chat.turn.cancelled", {
                    requestId,
                    durationMs: Date.now() - turnStartedAt,
                    emittedParts,
                    outputChars,
                    thinkingChars,
                });
            } else {
                this.logError("chat.turn.failed", err, { requestId });
                console.error("[Llama.cpp Provider] Chat request failed", err);
            }
            throw err;
        } finally {
            chatSlot?.release();
        }
    }

    /**
     * Retrieves the configured server URL from secrets.
     * Falls back to default localhost URL if not configured.
     *
     * @returns Promise resolving to the server URL.
     */
    private async getServerUrl(): Promise<string> {
        const configuredUrl = this.getExplicitConfiguredServerUrl();
        if (configuredUrl) {
            return configuredUrl;
        }

        const secretUrl = (await this.secrets.get("llamacpp.serverUrl")) || "";
        return this.normalizeServerUrl(secretUrl || DEFAULT_SERVER_URL);
    }

    /**
     * Retrieves the optional API key from secrets.
     * Returns undefined if no API key is configured.
     *
     * @returns Promise resolving to the API key or undefined.
     */
    private async getApiKey(): Promise<string | undefined> {
        return await this.secrets.get("llamacpp.apiKey");
    }

    private async getDeepSeekApiKey(): Promise<string | undefined> {
        return (await this.secrets.get("llamacpp.deepSeekApiKey")) ?? (await this.getApiKey());
    }

    /**
     * Live DeepSeek account balance from the official `GET /user/balance`
     * endpoint. Cached for 60 seconds; fails silently when no API key is
     * configured or the endpoint is unreachable.
     */
    get deepSeekBalanceSummary(): string | undefined {
        return this.deepSeekBalance?.summary;
    }

    async refreshDeepSeekBalance(force = false): Promise<string | undefined> {
        if (
            !force
            && this.deepSeekBalance
            && Date.now() - this.deepSeekBalance.fetchedAt < 60_000
        ) {
            return this.deepSeekBalance.summary;
        }
        if (this.deepSeekBalanceInflight) {
            return this.deepSeekBalanceInflight;
        }
        this.deepSeekBalanceInflight = (async () => {
            const apiKey = await this.getDeepSeekApiKey();
            if (!apiKey) {
                return undefined;
            }
            try {
                const config = this.getConfig();
                const serverUrl = String(config.get("serverUrl", DEFAULT_SERVER_URL) || DEFAULT_SERVER_URL);
                const endpoint = isDeepSeekEndpoint(serverUrl)
                    ? `${serverUrl}/user/balance`
                    : `${serverUrl}/user/balance`;
                const response = await this.httpTransport.request(endpoint, {
                    method: "GET",
                    headers: {
                        "User-Agent": this.userAgent,
                        "Accept": "application/json",
                        "Authorization": `Bearer ${apiKey}`,
                    },
                }, 10_000);
                if (!response.ok) {
                    return undefined;
                }
                const body = await response.json() as {
                    is_available?: boolean;
                    balance_infos?: Array<{
                        currency?: string;
                        total_balance?: string;
                        granted_balance?: string;
                        topped_up_balance?: string;
                    }>;
                };
                const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
                if (infos.length === 0) {
                    return undefined;
                }
                const summary = infos
                    .map(info => `${info.total_balance ?? "0"} ${info.currency ?? ""}`.trim())
                    .filter(Boolean)
                    .join(" · ");
                this.deepSeekBalance = { summary, fetchedAt: Date.now() };
                this.log("deepseek.balance.refreshed", { summary });
                return summary;
            } catch (error) {
                this.log("deepseek.balance.failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
                return undefined;
            } finally {
                this.deepSeekBalanceInflight = undefined;
            }
        })();
        return this.deepSeekBalanceInflight;
    }

    /**
     * Fetches the list of available models from the Llama.cpp server.
      * Makes a GET request to the provider model-list endpoint.
     *
     * @param serverUrl - The base URL of the Llama.cpp server.
     * @param apiKey - Optional API key for authentication.
     * @returns Promise resolving to an array of model objects.
     */
    private async fetchModels(serverUrl: string, apiKey?: string): Promise<LlamaCppModelInfo[]> {
        const headers: Record<string, string> = {
              "User-Agent": this.userAgent,
              "Accept": "application/json",
        };
        if (apiKey) {
            headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const endpoint = this.getModelsEndpoint(serverUrl);

        this.log("models.http.send", {
            endpoint,
            headers: this.redactHeaders(headers),
        });

        const response = await this.fetchWithTimeout(
            endpoint,
            {
                method: "GET",
                headers,
            },
            this.getModelDiscoveryTimeoutMs()
        );

        this.log("models.http.response", {
            status: response.status,
            statusText: response.statusText,
        });

        if (!response.ok) {
            let bodySnippet = "";
            try {
                const bodyText = await response.text();
                bodySnippet = bodyText.trim().slice(0, 300);
            } catch {
                bodySnippet = "";
            }
            const details = bodySnippet ? `\n${bodySnippet}` : "";
            throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}${details}`);
        }

        const data = (await response.json()) as { data?: unknown[]; models?: unknown[] };
        const descriptors = Array.isArray(data.models)
            ? data.models.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
            : [];
        const serverModalities = await this.fetchServerModalities(serverUrl, headers);
        const rawModels = Array.isArray(data.data) && data.data.length > 0 ? data.data : data.models ?? [];

        return rawModels.flatMap(item => {
            if (!item || typeof item !== "object") {
                return [];
            }

            const obj = item as Record<string, unknown>;
            const modelMeta = obj.meta && typeof obj.meta === "object" ? (obj.meta as Record<string, unknown>) : undefined;
            const id =
                typeof obj.id === "string"
                    ? obj.id
                    : typeof obj.model === "string"
                      ? obj.model
                      : typeof obj.name === "string"
                        ? obj.name
                        : undefined;

            if (!id || id.trim().length === 0) {
                return [];
            }

            const normalizedId = id.trim();
            const descriptor = descriptors.find(candidate => {
                const candidateId =
                    typeof candidate.id === "string"
                        ? candidate.id
                        : typeof candidate.model === "string"
                          ? candidate.model
                          : typeof candidate.name === "string"
                            ? candidate.name
                            : undefined;
                return candidateId?.trim() === normalizedId;
            });

            const aliases = Array.isArray(obj.aliases)
                ? obj.aliases.filter((alias): alias is string => typeof alias === "string")
                : undefined;
            const contextLengthCandidates: unknown[] = [
                obj["n_ctx_runtime"],
                obj["n_ctx"],
                obj["num_ctx"],
                obj["context_length"],
                obj["max_context_length"],
                obj["n_ctx_train"],
                modelMeta?.["n_ctx_runtime"],
                modelMeta?.["n_ctx"],
                modelMeta?.["num_ctx"],
                modelMeta?.["context_length"],
                modelMeta?.["max_context_length"],
                modelMeta?.["n_ctx_train"],
            ];

            let contextLength: number | undefined;
            for (const candidate of contextLengthCandidates) {
                const parsed = this.parsePositiveInt(candidate);
                if (parsed !== undefined) {
                    contextLength = this.clampInt(parsed, 4096, MAX_CONTEXT_LENGTH, DEFAULT_CONTEXT_LENGTH);
                    break;
                }
            }

            const meta = modelMeta as LlamaCppModelInfo["meta"] | undefined;

            const rawCapabilities = Array.isArray(obj.capabilities)
                ? obj.capabilities
                : Array.isArray(descriptor?.capabilities)
                  ? descriptor.capabilities
                  : [];
            const capabilities = rawCapabilities.filter((value): value is string => typeof value === "string");
            const rawModalities =
                obj.modalities && typeof obj.modalities === "object"
                    ? obj.modalities as Record<string, unknown>
                    : descriptor?.modalities && typeof descriptor.modalities === "object"
                      ? descriptor.modalities as Record<string, unknown>
                      : undefined;
            const modalities = {
                vision: rawModalities?.vision === true || serverModalities?.vision === true,
                audio: rawModalities?.audio === true || serverModalities?.audio === true,
            };

            return [{ id: normalizedId, aliases, contextLength, capabilities, modalities, meta }];
        });
    }

    private async fetchServerModalities(
        serverUrl: string,
        headers: Record<string, string>
    ): Promise<LlamaCppModelInfo["modalities"] | undefined> {
        if (this.isDeepSeekServer(serverUrl)) {
            return undefined;
        }

        const endpoint = `${serverUrl}/props`;
        try {
            const response = await this.fetchWithTimeout(
                endpoint,
                { method: "GET", headers },
                this.getModelDiscoveryTimeoutMs()
            );
            if (!response.ok) {
                this.log("models.modalities.props_unavailable", {
                    endpoint,
                    status: response.status,
                    statusText: response.statusText,
                });
                return undefined;
            }

            const body = await response.json() as Record<string, unknown>;
            const rawModalities = body.modalities;
            if (!rawModalities || typeof rawModalities !== "object") {
                return undefined;
            }

            const modalities = rawModalities as Record<string, unknown>;
            const result = {
                vision: modalities.vision === true,
                audio: modalities.audio === true,
            };
            this.log("models.modalities.detected", { endpoint, ...result });
            return result;
        } catch (error) {
            this.logError("models.modalities.props_failed", error, { endpoint });
            return undefined;
        }
    }

    private shouldProbeRuntimeSlots(serverUrl: string): boolean {
        return !this.isDeepSeekServer(serverUrl);
    }

    private async fetchWithTimeout(
        url: string,
        init: RequestInit,
        timeoutMs: number
    ): Promise<Response> {
        return this.httpTransport.request(url, init, timeoutMs);
    }
}
