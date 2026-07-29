import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { z, type ZodType } from "zod";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
	Options as ClaudeAgentOptions,
	Query,
	SDKControlGetContextUsageResponse,
	SDKControlGetUsageResponse,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import type { LlamaLogSink } from "../logger";
import { enhanceSubagentToolDescription, withRequiredSubagentModel } from "../subagent-guidance";
import { isCacheControlPart } from "../utils";

const ACTIVE_TURN_TIMEOUT_MS = 90_000;
const TOOL_CARD_SETTLE_MS = 30;
const MAX_TOOL_RESULT_CHARS = 16_000;

const CLAUDE_VSCODE_SYSTEM_PROMPT = [
	"You are Claude running as a language model inside VS Code Copilot Chat.",
	"The host exposes workspace capabilities as MCP tools from the vscode server.",
	"Use those tools for file reads, searches, edits, terminals, web access, and other actions.",
	"Tool execution is performed by VS Code and may require user approval. Call a tool, then wait for its result.",
	"Never invent tool output and never claim that a listed vscode tool is unavailable.",
	"Built-in Claude Code tools are intentionally disabled; do not request Read, Bash, Edit, Glob, Grep, or Write.",
	"Keep user-facing responses concise and continue naturally after each tool result.",
].join("\n");

export function isClaudeVsCodeToolName(toolName: string): boolean {
	return toolName.startsWith("mcp__vscode__");
}

export interface ClaudeAgentUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	durationMs: number;
	numTurns: number;
}

export interface ClaudeNativeUsagePayload {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_tokens_details: {
		cached_tokens: number;
	};
}

export function createClaudeNativeUsage(usage: ClaudeAgentUsage): ClaudeNativeUsagePayload {
	const promptTokens = Math.max(0, usage.inputTokens)
		+ Math.max(0, usage.cacheReadInputTokens)
		+ Math.max(0, usage.cacheCreationInputTokens);
	const completionTokens = Math.max(0, usage.outputTokens);
	return {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: promptTokens + completionTokens,
		prompt_tokens_details: {
			cached_tokens: Math.max(0, usage.cacheReadInputTokens),
		},
	};
}

export function createClaudeNativeContextUsage(
	aggregate: ClaudeAgentUsage,
	segments: readonly ClaudeAgentUsageSegment[]
): ClaudeNativeUsagePayload {
	const finalSegment = [...segments].sort((left, right) => left.index - right.index).at(-1);
	return createClaudeNativeUsage(finalSegment
		? {
			inputTokens: finalSegment.freshInputTokens,
			cacheReadInputTokens: finalSegment.cacheReadInputTokens,
			cacheCreationInputTokens: finalSegment.cacheCreationInputTokens,
			outputTokens: finalSegment.outputTokens,
			durationMs: aggregate.durationMs,
			numTurns: 1,
		}
		: aggregate);
}

export type ClaudeAgentTurnPhase = "running" | "completed" | "failed" | "timed_out" | "cancelled";

export type ClaudeAgentSessionMode = "new" | "warm" | "restored" | "rollover" | "resume-fallback";

export interface ClaudeAgentTurnContext {
	sessionMode: ClaudeAgentSessionMode;
	inputMode: "full" | "user-turn";
	conversationKey?: string;
	messageCount: number;
	toolCount: number;
	toolSchemaTokens: number;
}

export interface ClaudeAgentUsageSegment {
	id: string;
	index: number;
	recordedAt: string;
	freshInputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	inputTokens: number;
	outputTokens: number;
	thinkingTokens: number;
	totalTokens: number;
	cacheHitPercent?: number;
}

export interface ClaudeAgentTurnStep {
	id: string;
	index: number;
	kind: "model" | "tool";
	label: string;
	status: "running" | "completed" | "failed" | "timed_out" | "cancelled";
	startedAt: string;
	completedAt?: string;
	durationMs?: number;
	toolCategory?: "vscode";
	inputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	outputTokens?: number;
	thinkingTokens?: number;
	totalTokens?: number;
	cacheHitPercent?: number;
}

export interface ClaudeAgentTurnUpdate {
	requestId: string;
	phase: ClaudeAgentTurnPhase;
	sessionId?: string;
	startedAt: string;
	durationMs: number;
	firstModelEventLatencyMs?: number;
	firstVisibleMessageLatencyMs?: number;
	outputChars: number;
	thinkingChars: number;
	usage?: ClaudeAgentUsage;
	usageSegments: ClaudeAgentUsageSegment[];
	steps: ClaudeAgentTurnStep[];
	toolCalls: number;
	toolNames: Record<string, number>;
	toolDuration: {
		count: number;
		totalMs: number;
		averageMs: number;
		maximumMs: number;
		p95Ms: number;
	};
	context: ClaudeAgentTurnContext;
	terminalDetail?: string;
}

export function parseClaudeAssistantUsage(
	message: unknown,
	fallbackId: string,
	index: number,
	recordedAt = new Date().toISOString()
): ClaudeAgentUsageSegment | undefined {
	const messageRecord = asRecord(message);
	const usage = asRecord(messageRecord.usage);
	if (Object.keys(usage).length === 0) {
		return undefined;
	}
	const freshInputTokens = readNumber(usage.input_tokens);
	const cacheReadInputTokens = readNumber(usage.cache_read_input_tokens);
	const cacheCreationInputTokens = readNumber(usage.cache_creation_input_tokens);
	const inputTokens = freshInputTokens + cacheReadInputTokens + cacheCreationInputTokens;
	const outputTokens = readNumber(usage.output_tokens);
	const thinkingTokens = readNumber(asRecord(usage.output_tokens_details).thinking_tokens);
	return {
		id: typeof messageRecord.id === "string" ? messageRecord.id : fallbackId,
		index,
		recordedAt,
		freshInputTokens,
		cacheReadInputTokens,
		cacheCreationInputTokens,
		inputTokens,
		outputTokens,
		thinkingTokens,
		totalTokens: inputTokens + outputTokens,
		cacheHitPercent: inputTokens > 0
			? Number((cacheReadInputTokens / inputTokens * 100).toFixed(1))
			: undefined,
	};
}

export interface ClaudeRateLimitInfo {
	status: "allowed" | "allowed_warning" | "rejected";
	resetsAt?: number;
	utilization?: number;
}

export type ClaudeSubscriptionUsageSnapshot = SDKControlGetUsageResponse;
export type ClaudeContextUsageSnapshot = SDKControlGetContextUsageResponse;

export interface ClaudeAgentSessionCallbacks {
	onUsage(usage: ClaudeAgentUsage): void;
	onRateLimit(info: ClaudeRateLimitInfo): void;
	onTurnUpdate?(update: ClaudeAgentTurnUpdate): void;
	onUsageSnapshot?(snapshot: ClaudeSubscriptionUsageSnapshot): void;
	onContextUsage?(snapshot: ClaudeContextUsageSnapshot): void;
	onSessionId?(sessionId: string): void;
}

export interface ClaudeAgentSessionOptions {
	model: string;
	cwd: string;
	executable: string;
	extensionVersion: string;
	tools: readonly vscode.LanguageModelChatTool[];
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	persistSession?: boolean;
	resumeSessionId?: string;
	logSink?: LlamaLogSink;
	callbacks: ClaudeAgentSessionCallbacks;
}

export async function hasPersistedClaudeSession(sessionId: string, cwd: string): Promise<boolean> {
	try {
		const sdk = await import("@anthropic-ai/claude-agent-sdk");
		const messages = await sdk.getSessionMessages(sessionId, { dir: cwd, limit: 1 });
		return messages.length > 0;
	} catch {
		return false;
	}
}

interface ActiveTurn {
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	resolve: () => void;
	reject: (error: Error) => void;
	cancellation: vscode.Disposable;
	timeout: NodeJS.Timeout;
	toolSettleTimer?: NodeJS.Timeout;
	settled: boolean;
	partialTextSeen: boolean;
	partialThinkingSeen: boolean;
	reportedTextChars: number;
}

interface PendingToolCall {
	callId: string;
	name: string;
	input: Record<string, unknown>;
	startedAt: number;
	resolve: (result: CallToolResult) => void;
	reject: (error: Error) => void;
}

interface ClaudeLogicalTurn {
	requestId: string;
	startedAt: number;
	context: ClaudeAgentTurnContext;
	firstModelEventAt?: number;
	firstVisibleMessageAt?: number;
	outputChars: number;
	thinkingChars: number;
	usage?: ClaudeAgentUsage;
	usageSegments: Map<string, ClaudeAgentUsageSegment>;
	steps: Map<string, ClaudeAgentTurnStep>;
	currentModelStepId?: string;
	terminal: boolean;
}

class AsyncMessageQueue implements AsyncIterable<SDKUserMessage> {
	private readonly buffered: SDKUserMessage[] = [];
	private readonly waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
	private closed = false;

	push(message: SDKUserMessage): void {
		if (this.closed) {
			throw new Error("Claude input queue is closed");
		}
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ done: false, value: message });
			return;
		}
		this.buffered.push(message);
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) {
			waiter({ done: true, value: undefined });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return {
			next: async (): Promise<IteratorResult<SDKUserMessage>> => {
				const message = this.buffered.shift();
				if (message) {
					return { done: false, value: message };
				}
				if (this.closed) {
					return { done: true, value: undefined };
				}
				return new Promise(resolve => this.waiters.push(resolve));
			},
		};
	}
}

export function resolveClaudeCodeBinary(): string | undefined {
	const configuredPath = vscode.workspace.getConfiguration("llamacpp")
		.get<string>("claudeCliPath", "")
		.trim();
	if (configuredPath && existsSync(configuredPath)) {
		return configuredPath;
	}

	const extension = vscode.extensions.getExtension("anthropic.claude-code");
	if (!extension) {
		return undefined;
	}
	const executable = process.platform === "win32" ? "claude.exe" : "claude";
	const bundled = path.join(extension.extensionPath, "resources", "native-binary", executable);
	return existsSync(bundled) ? bundled : undefined;
}

export class ClaudeAgentSession implements vscode.Disposable {
	private readonly input = new AsyncMessageQueue();
	private readonly pendingTools = new Map<string, PendingToolCall>();
	private readonly queuedToolCalls: PendingToolCall[] = [];
	private query: Query | undefined;
	private pump: Promise<void> | undefined;
	private activeTurn: ActiveTurn | undefined;
	private logicalTurn: ClaudeLogicalTurn | undefined;
	private sessionId: string | undefined;
	private lastTurnProducedOutput = false;
	private disposed = false;

	constructor(private readonly options: ClaudeAgentSessionOptions) {}

	get pendingCallIds(): ReadonlySet<string> {
		return new Set(this.pendingTools.keys());
	}

	get canRetryLastTurn(): boolean {
		return !this.lastTurnProducedOutput && this.pendingTools.size === 0;
	}

	hasPendingCall(callId: string): boolean {
		return this.pendingTools.has(callId);
	}

	async runUserTurn(
		message: SDKUserMessage,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
		context: ClaudeAgentTurnContext
	): Promise<void> {
		if (this.logicalTurn && !this.logicalTurn.terminal) {
			throw new Error("Claude session already has an active logical turn");
		}
		this.logicalTurn = {
			requestId: randomUUID(),
			startedAt: Date.now(),
			context: { ...context },
			outputChars: 0,
			thinkingChars: 0,
			usageSegments: new Map(),
			steps: new Map(),
			terminal: false,
		};
		this.emitTurnUpdate("running");
		try {
			await this.ensureStarted();
			const completion = this.attachTurn(progress, token);
			this.input.push(message);
			return completion;
		} catch (error) {
			this.finishLogicalTurn("failed", error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	async resumeToolResults(
		results: readonly vscode.LanguageModelToolResultPart[],
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		if (!this.logicalTurn || this.logicalTurn.terminal) {
			throw new Error("Claude tool continuation has no active logical turn");
		}
		await this.ensureStarted();
		const completion = this.attachTurn(progress, token);
		let resolved = 0;
		for (const result of results) {
			const pending = this.pendingTools.get(result.callId);
			if (!pending) {
				continue;
			}
			this.pendingTools.delete(result.callId);
			this.finishToolStep(pending, "completed");
			pending.resolve(convertToolResult(result));
			resolved++;
		}
		if (resolved === 0) {
			this.failActiveTurn(new Error("Claude tool continuation no longer exists"), "failed");
		} else {
			this.emitTurnUpdate("running");
		}
		return completion;
	}

	async interrupt(): Promise<void> {
		try {
			await this.query?.interrupt();
		} catch (error) {
			this.options.logSink?.logError("claude.sdk.interrupt_failed", error);
		}
	}

	async refreshUsageSnapshot(): Promise<ClaudeSubscriptionUsageSnapshot | undefined> {
		if (!this.options.callbacks.onUsageSnapshot) {
			return undefined;
		}
		await this.ensureStarted();
		const query = this.query;
		if (!query) {
			return undefined;
		}
		await query.initializationResult();
		const snapshot = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
		this.options.callbacks.onUsageSnapshot(snapshot);
		return snapshot;
	}

	async refreshContextUsage(): Promise<ClaudeContextUsageSnapshot | undefined> {
		if (!this.options.callbacks.onContextUsage) {
			return undefined;
		}
		await this.ensureStarted();
		const query = this.query;
		if (!query) {
			return undefined;
		}
		await query.initializationResult();
		const snapshot = await query.getContextUsage();
		this.options.callbacks.onContextUsage(snapshot);
		return snapshot;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.input.close();
		this.query?.close();
		for (const pending of this.pendingTools.values()) {
			this.finishToolStep(pending, "cancelled");
			pending.reject(new Error("Claude session closed before the VS Code tool returned"));
		}
		this.pendingTools.clear();
		this.queuedToolCalls.length = 0;
		this.failActiveTurn(new Error("Claude session closed"), "cancelled");
	}

	private async ensureStarted(): Promise<void> {
		if (this.disposed) {
			throw new Error("Claude session is closed");
		}
		if (this.query) {
			return;
		}

		const sdk = await import("@anthropic-ai/claude-agent-sdk");
		const mcpTools = this.options.tools.map((definition, index) => {
			const routedDefinition = withRequiredSubagentModel(definition);
			const mcpName = createMcpToolName(routedDefinition.name, index);
			const schema = createZodShape(routedDefinition.inputSchema);
			return sdk.tool(
				mcpName,
				createToolDescription(routedDefinition),
				schema,
				async args => this.delegateTool(routedDefinition.name, asRecord(args)),
				{ alwaysLoad: isCoreTool(routedDefinition.name) }
			);
		});
		const vscodeServer = sdk.createSdkMcpServer({
			name: "vscode",
			version: this.options.extensionVersion,
			instructions: "These tools are executed by VS Code. Call them normally and wait for the returned result.",
			tools: mcpTools,
			alwaysLoad: false,
		});

		const agentOptions: ClaudeAgentOptions = {
			model: this.options.model,
			cwd: this.options.cwd,
			pathToClaudeCodeExecutable: this.options.executable,
			systemPrompt: CLAUDE_VSCODE_SYSTEM_PROMPT,
			tools: [],
			mcpServers: { vscode: vscodeServer },
			strictMcpConfig: true,
			settingSources: [],
			skills: [],
			plugins: [],
			persistSession: this.options.persistSession === true,
			includePartialMessages: true,
			permissionMode: "default",
			canUseTool: async (toolName, input) => isClaudeVsCodeToolName(toolName)
				? { behavior: "allow", updatedInput: input }
				: { behavior: "deny", message: `Only VS Code-hosted tools are available; denied ${toolName}.` },
			...(this.options.effort ? { effort: this.options.effort } : {}),
			env: {
				...process.env,
				CLAUDE_AGENT_SDK_CLIENT_APP: `llama-vscode-chat/${this.options.extensionVersion}`,
			},
			stderr: data => {
				const message = data.trim();
				if (message) {
					this.options.logSink?.log("claude.sdk.stderr", { message: message.slice(0, 4000) }, "debug");
				}
			},
			...(this.options.resumeSessionId
				? { resume: this.options.resumeSessionId, forkSession: true }
				: {}),
		};

		this.query = sdk.query({ prompt: this.input, options: agentOptions });
		this.pump = this.pumpMessages(this.query);
		this.pump.catch(error => this.handlePumpFailure(error));
		this.options.logSink?.log("claude.sdk.started", {
			model: this.options.model,
			toolCount: this.options.tools.length,
			executable: this.options.executable,
			persistent: this.options.persistSession === true,
			resumed: this.options.resumeSessionId !== undefined,
		});
	}

	private attachTurn(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		if (this.activeTurn) {
			throw new Error("Claude session already has an active VS Code turn");
		}
		this.lastTurnProducedOutput = false;
		return new Promise<void>((resolve, reject) => {
			const cancellation = token.onCancellationRequested(() => {
				this.failActiveTurn(new vscode.CancellationError(), "cancelled");
				void this.interrupt();
			});
			const timeout = setTimeout(() => {
				this.failActiveTurn(new Error("Claude produced no completed response for 90 seconds"), "timed_out");
				void this.interrupt();
			}, ACTIVE_TURN_TIMEOUT_MS);
			this.activeTurn = {
				progress,
				resolve,
				reject,
				cancellation,
				timeout,
				settled: false,
				partialTextSeen: false,
				partialThinkingSeen: false,
				reportedTextChars: 0,
			};
			const queuedCalls = this.queuedToolCalls.splice(0);
			for (const call of queuedCalls) {
				this.reportToolCall(call);
			}
			if (queuedCalls.length > 0) {
				this.scheduleToolTurnCompletion();
			}
		});
	}

	private async pumpMessages(query: Query): Promise<void> {
		for await (const message of query) {
			this.touchActiveTurn();
			this.handleMessage(message);
		}
		if (!this.disposed) {
			throw new Error("Claude Agent SDK stream closed unexpectedly");
		}
	}

	private handleMessage(message: SDKMessage): void {
		if (message.type === "stream_event") {
			this.recordModelEvent(message.event);
			this.handleStreamEvent(message.event);
			return;
		}
		if (message.type === "assistant") {
			this.recordModelEvent();
			if (message.error) {
				this.failActiveTurn(new Error(`Claude API error: ${message.error}`), "failed");
				return;
			}
			this.handleAssistantMessage(message.message, message.uuid);
			return;
		}
		if (message.type === "result") {
			this.handleResult(message);
			return;
		}
		if (message.type === "rate_limit_event") {
			this.options.callbacks.onRateLimit({
				status: message.rate_limit_info.status,
				resetsAt: message.rate_limit_info.resetsAt,
				utilization: message.rate_limit_info.utilization,
			});
			return;
		}
		if (message.type === "system" && message.subtype === "init") {
			this.sessionId = message.session_id;
			this.options.callbacks.onSessionId?.(message.session_id);
			this.options.logSink?.log("claude.sdk.initialized", { sessionId: message.session_id });
		}
	}

	private handleStreamEvent(event: unknown): void {
		const active = this.activeTurn;
		if (!active) {
			return;
		}
		const record = asRecord(event);
		if (record.type !== "content_block_delta") {
			return;
		}
		const delta = asRecord(record.delta);
		if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
			const firstVisible = this.recordVisibleMessage();
			active.partialTextSeen = true;
			active.reportedTextChars += delta.text.length;
			if (this.logicalTurn) {
				this.logicalTurn.outputChars += delta.text.length;
			}
			active.progress.report(new vscode.LanguageModelTextPart(delta.text));
			if (firstVisible) {
				this.emitTurnUpdate("running");
			}
			return;
		}
		if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
			active.partialThinkingSeen = true;
			if (this.logicalTurn) {
				this.logicalTurn.thinkingChars += delta.thinking.length;
			}
			emitThinking(delta.thinking, active.progress);
		}
	}

	private handleAssistantMessage(message: unknown, fallbackId: string): void {
		const active = this.activeTurn;
		if (!active) {
			return;
		}
		const content = asArray(asRecord(message).content);
		for (const rawBlock of content) {
			const block = asRecord(rawBlock);
			if (!active.partialTextSeen && block.type === "text" && typeof block.text === "string" && block.text) {
				this.recordVisibleMessage();
				active.reportedTextChars += block.text.length;
				if (this.logicalTurn) {
					this.logicalTurn.outputChars += block.text.length;
				}
				active.progress.report(new vscode.LanguageModelTextPart(block.text));
			}
			if (!active.partialThinkingSeen && block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
				if (this.logicalTurn) {
					this.logicalTurn.thinkingChars += block.thinking.length;
				}
				emitThinking(block.thinking, active.progress);
			}
		}
		this.recordAssistantUsage(message, fallbackId);
		this.emitTurnUpdate("running");
	}

	private handleResult(message: Extract<SDKMessage, { type: "result" }>): void {
		const usage = asRecord(message.usage);
		const aggregateUsage: ClaudeAgentUsage = {
			inputTokens: readNumber(usage.input_tokens),
			outputTokens: readNumber(usage.output_tokens),
			cacheReadInputTokens: readNumber(usage.cache_read_input_tokens),
			cacheCreationInputTokens: readNumber(usage.cache_creation_input_tokens),
			durationMs: message.duration_ms,
			numTurns: message.num_turns,
		};
		if (this.logicalTurn) {
			this.logicalTurn.usage = aggregateUsage;
		}
		this.options.callbacks.onUsage(aggregateUsage);
		const active = this.activeTurn;
		const finalSegment = this.logicalTurn
			? [...this.logicalTurn.usageSegments.values()].sort((left, right) => left.index - right.index).at(-1)
			: undefined;
		const nativeUsage = createClaudeNativeContextUsage(
			aggregateUsage,
			this.logicalTurn ? [...this.logicalTurn.usageSegments.values()] : []
		);
		active?.progress.report(vscode.LanguageModelDataPart.text(
			JSON.stringify(nativeUsage),
			"usage"
		));
		this.options.logSink?.log("chat.response.usage", {
			provider: "claude",
			source: finalSegment ? "agent-sdk-final-segment" : "agent-sdk-aggregate-fallback",
			emittedToNativeChat: active !== undefined,
			usage: nativeUsage,
		});
		void Promise.allSettled([
			this.refreshUsageSnapshot(),
			this.refreshContextUsage(),
		]).then(results => {
			for (const result of results) {
				if (result.status === "rejected") {
					this.options.logSink?.logError("claude.runtime_snapshot.failed", result.reason);
				}
			}
		});
		if (message.subtype !== "success" || message.is_error) {
			const errors = "errors" in message ? message.errors.join("; ") : "";
			this.failActiveTurn(new Error(errors || `Claude request failed: ${message.subtype}`), "failed");
			return;
		}
		if (active && active.reportedTextChars === 0 && message.result) {
			this.recordVisibleMessage();
			if (this.logicalTurn) {
				this.logicalTurn.outputChars += message.result.length;
			}
			active.progress.report(new vscode.LanguageModelTextPart(message.result));
		}
		this.finishLogicalTurn("completed");
		this.completeActiveTurn();
	}

	private delegateTool(name: string, input: Record<string, unknown>): Promise<CallToolResult> {
		if (this.disposed) {
			return Promise.reject(new Error("Claude session closed"));
		}
		const callId = randomUUID();
		return new Promise<CallToolResult>((resolve, reject) => {
			const call: PendingToolCall = { callId, name, input, startedAt: Date.now(), resolve, reject };
			this.pendingTools.set(callId, call);
			this.startToolStep(call);
			if (this.activeTurn) {
				this.reportToolCall(call);
				this.scheduleToolTurnCompletion();
			} else {
				this.queuedToolCalls.push(call);
			}
		});
	}

	private reportToolCall(call: PendingToolCall): void {
		this.activeTurn?.progress.report(new vscode.LanguageModelToolCallPart(
			call.callId,
			call.name,
			call.input
		));
	}

	private scheduleToolTurnCompletion(): void {
		const active = this.activeTurn;
		if (!active || active.toolSettleTimer) {
			return;
		}
		active.toolSettleTimer = setTimeout(() => this.completeActiveTurn(), TOOL_CARD_SETTLE_MS);
	}

	private recordModelEvent(event?: unknown): void {
		const turn = this.logicalTurn;
		if (!turn || turn.terminal) {
			return;
		}
		const firstEvent = turn.firstModelEventAt === undefined;
		turn.firstModelEventAt ??= Date.now();
		const record = asRecord(event);
		if (record.type === "message_start") {
			const message = asRecord(record.message);
			const id = typeof message.id === "string" ? message.id : `segment-${turn.usageSegments.size + 1}`;
			this.beginModelStep(id);
		}
		if (firstEvent) {
			this.emitTurnUpdate("running");
		}
	}

	private beginModelStep(modelMessageId: string): ClaudeAgentTurnStep | undefined {
		const turn = this.logicalTurn;
		if (!turn || turn.terminal) {
			return undefined;
		}
		const stepId = `model-${modelMessageId}`;
		let step = turn.steps.get(stepId);
		if (!step) {
			step = {
				id: stepId,
				index: turn.steps.size + 1,
				kind: "model",
				label: `Model segment ${turn.usageSegments.size + 1}`,
				status: "running",
				startedAt: new Date().toISOString(),
			};
			turn.steps.set(stepId, step);
			this.emitTurnUpdate("running");
		}
		turn.currentModelStepId = stepId;
		return step;
	}

	private recordAssistantUsage(message: unknown, fallbackId: string): void {
		const turn = this.logicalTurn;
		if (!turn || turn.terminal) {
			return;
		}
		const provisionalId = typeof asRecord(message).id === "string"
			? String(asRecord(message).id)
			: fallbackId;
		const existing = turn.usageSegments.get(provisionalId);
		const segment = parseClaudeAssistantUsage(
			message,
			fallbackId,
			existing?.index ?? turn.usageSegments.size + 1
		);
		if (!segment) {
			return;
		}
		const step = this.beginModelStep(segment.id);
		turn.usageSegments.set(segment.id, segment);
		if (step) {
			const completedAt = new Date();
			Object.assign(step, {
				status: "completed",
				completedAt: completedAt.toISOString(),
				durationMs: Math.max(0, completedAt.getTime() - Date.parse(step.startedAt)),
				inputTokens: segment.inputTokens,
				cacheReadInputTokens: segment.cacheReadInputTokens,
				cacheCreationInputTokens: segment.cacheCreationInputTokens,
				outputTokens: segment.outputTokens,
				thinkingTokens: segment.thinkingTokens,
				totalTokens: segment.totalTokens,
				cacheHitPercent: segment.cacheHitPercent,
			});
		}
		if (turn.currentModelStepId === step?.id) {
			turn.currentModelStepId = undefined;
		}
	}

	private recordVisibleMessage(): boolean {
		const turn = this.logicalTurn;
		if (!turn || turn.terminal || turn.firstVisibleMessageAt !== undefined) {
			return false;
		}
		turn.firstVisibleMessageAt = Date.now();
		return true;
	}

	private startToolStep(call: PendingToolCall): void {
		const turn = this.logicalTurn;
		if (!turn || turn.terminal) {
			return;
		}
		turn.steps.set(`tool-${call.callId}`, {
			id: `tool-${call.callId}`,
			index: turn.steps.size + 1,
			kind: "tool",
			label: call.name,
			status: "running",
			startedAt: new Date(call.startedAt).toISOString(),
			toolCategory: "vscode",
		});
		this.emitTurnUpdate("running");
	}

	private finishToolStep(
		call: PendingToolCall,
		status: Extract<ClaudeAgentTurnStep["status"], "completed" | "failed" | "timed_out" | "cancelled">
	): void {
		const step = this.logicalTurn?.steps.get(`tool-${call.callId}`);
		if (!step || step.status !== "running") {
			return;
		}
		const completedAt = Date.now();
		step.status = status;
		step.completedAt = new Date(completedAt).toISOString();
		step.durationMs = Math.max(0, completedAt - call.startedAt);
	}

	private finishLogicalTurn(
		phase: Exclude<ClaudeAgentTurnPhase, "running">,
		terminalDetail?: string
	): void {
		const turn = this.logicalTurn;
		if (!turn || turn.terminal) {
			return;
		}
		turn.terminal = true;
		for (const step of turn.steps.values()) {
			if (step.status !== "running") {
				continue;
			}
			const completedAt = Date.now();
			step.status = phase === "timed_out" ? "timed_out" : phase === "cancelled" ? "cancelled" : phase === "completed" ? "completed" : "failed";
			step.completedAt = new Date(completedAt).toISOString();
			step.durationMs = Math.max(0, completedAt - Date.parse(step.startedAt));
		}
		this.emitTurnUpdate(phase, terminalDetail);
	}

	private emitTurnUpdate(phase: ClaudeAgentTurnPhase, terminalDetail?: string): void {
		const turn = this.logicalTurn;
		if (!turn || !this.options.callbacks.onTurnUpdate) {
			return;
		}
		const steps = [...turn.steps.values()]
			.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
			.map((step, index) => ({ ...step, index: index + 1 }));
		const usageSegments = [...turn.usageSegments.values()]
			.sort((left, right) => left.index - right.index)
			.map((segment, index) => ({ ...segment, index: index + 1 }));
		const toolSteps = steps.filter(step => step.kind === "tool");
		const toolNames = new Map<string, number>();
		const durations: number[] = [];
		for (const step of toolSteps) {
			toolNames.set(step.label, (toolNames.get(step.label) ?? 0) + 1);
			if (step.durationMs !== undefined) {
				durations.push(step.durationMs);
			}
		}
		durations.sort((left, right) => left - right);
		const totalDuration = durations.reduce((sum, value) => sum + value, 0);
		const p95Index = durations.length > 0 ? Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1) : 0;
		this.options.callbacks.onTurnUpdate({
			requestId: turn.requestId,
			phase,
			sessionId: this.sessionId,
			startedAt: new Date(turn.startedAt).toISOString(),
			durationMs: turn.usage?.durationMs ?? Math.max(0, Date.now() - turn.startedAt),
			firstModelEventLatencyMs: turn.firstModelEventAt === undefined ? undefined : turn.firstModelEventAt - turn.startedAt,
			firstVisibleMessageLatencyMs: turn.firstVisibleMessageAt === undefined ? undefined : turn.firstVisibleMessageAt - turn.startedAt,
			outputChars: turn.outputChars,
			thinkingChars: turn.thinkingChars,
			usage: turn.usage ? { ...turn.usage } : undefined,
			usageSegments,
			steps,
			toolCalls: toolSteps.length,
			toolNames: Object.fromEntries([...toolNames.entries()].sort(([left], [right]) => left.localeCompare(right))),
			toolDuration: {
				count: durations.length,
				totalMs: totalDuration,
				averageMs: durations.length > 0 ? Math.round(totalDuration / durations.length) : 0,
				maximumMs: durations.at(-1) ?? 0,
				p95Ms: durations[p95Index] ?? 0,
			},
			context: { ...turn.context },
			terminalDetail,
		});
	}

	private touchActiveTurn(): void {
		const active = this.activeTurn;
		if (!active) {
			return;
		}
		clearTimeout(active.timeout);
		active.timeout = setTimeout(() => {
			this.failActiveTurn(new Error("Claude produced no activity for 90 seconds"), "timed_out");
			void this.interrupt();
		}, ACTIVE_TURN_TIMEOUT_MS);
	}

	private completeActiveTurn(): void {
		const active = this.detachActiveTurn();
		active?.resolve();
	}

	private failActiveTurn(error: Error, phase: Exclude<ClaudeAgentTurnPhase, "running" | "completed">): void {
		const active = this.detachActiveTurn();
		this.finishLogicalTurn(phase, error.message);
		active?.reject(error);
	}

	private detachActiveTurn(): ActiveTurn | undefined {
		const active = this.activeTurn;
		if (!active || active.settled) {
			return undefined;
		}
		active.settled = true;
		clearTimeout(active.timeout);
		clearTimeout(active.toolSettleTimer);
		active.cancellation.dispose();
		this.lastTurnProducedOutput = active.reportedTextChars > 0
			|| active.partialThinkingSeen
			|| this.pendingTools.size > 0;
		this.activeTurn = undefined;
		return active;
	}

	private handlePumpFailure(error: unknown): void {
		if (this.disposed) {
			return;
		}
		const failure = error instanceof Error ? error : new Error(String(error));
		this.options.logSink?.logError("claude.sdk.failed", failure);
		for (const pending of this.pendingTools.values()) {
			this.finishToolStep(pending, "failed");
			pending.reject(failure);
		}
		this.pendingTools.clear();
		this.failActiveTurn(failure, "failed");
	}
}

function createMcpToolName(name: string, index: number): string {
	const normalized = name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96);
	return normalized || `vscode_tool_${index}`;
}

function createToolDescription(tool: vscode.LanguageModelChatTool): string {
	const schema = tool.inputSchema && typeof tool.inputSchema === "object"
		? `\nInput schema: ${JSON.stringify(tool.inputSchema)}`
		: "";
	return `${enhanceSubagentToolDescription(tool.name, tool.description || `VS Code tool ${tool.name}`)}${schema}`;
}

function createZodShape(schema: object | undefined): Record<string, ZodType> {
	const record = asRecord(schema);
	const properties = asRecord(record.properties);
	const required = new Set(asArray(record.required).filter((value): value is string => typeof value === "string"));
	const shape: Record<string, ZodType> = {};
	for (const [name, propertySchema] of Object.entries(properties)) {
		const validator = zodForSchema(asRecord(propertySchema));
		shape[name] = required.has(name) ? validator : validator.optional();
	}
	return shape;
}

function zodForSchema(schema: Record<string, unknown>): ZodType {
	let validator: ZodType;
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		const enumValues = schema.enum;
		validator = z.unknown().refine(value => enumValues.includes(value), {
			message: `Expected one of: ${enumValues.map(value => JSON.stringify(value)).join(", ")}`,
		});
	} else if (schema.type === "string") {
		validator = z.string();
	} else if (schema.type === "number") {
		validator = z.number();
	} else if (schema.type === "integer") {
		validator = z.number().int();
	} else if (schema.type === "boolean") {
		validator = z.boolean();
	} else if (schema.type === "array") {
		validator = z.array(zodForSchema(asRecord(schema.items)));
	} else if (schema.type === "object" || schema.properties) {
		validator = z.object(createZodShape(schema));
	} else {
		validator = z.unknown();
	}
	return typeof schema.description === "string" ? validator.describe(schema.description) : validator;
}

function isCoreTool(name: string): boolean {
	return /(?:read_file|grep_search|file_search|apply_patch|run_in_terminal|manage_todo_list|request_user_input)$/i.test(name);
}

function convertToolResult(result: vscode.LanguageModelToolResultPart): CallToolResult {
	const content: CallToolResult["content"] = [];
	const textParts: string[] = [];
	for (const item of result.content) {
		if (item instanceof vscode.LanguageModelTextPart) {
			textParts.push(item.value);
			continue;
		}
		if (isCacheControlPart(item)) {
			// Never render the cache breakpoint marker as text: it moves between
			// turns and would rewrite already-cached tool output.
			continue;
		}
		if (item instanceof vscode.LanguageModelDataPart) {
			if (item.mimeType.startsWith("image/")) {
				content.push({
					type: "image",
					data: Buffer.from(item.data).toString("base64"),
					mimeType: item.mimeType,
				});
			} else {
				textParts.push(`[data ${item.mimeType}, ${item.data.byteLength} bytes]`);
			}
		}
	}
	let text = textParts.join("\n") || "Tool completed.";
	if (text.length > MAX_TOOL_RESULT_CHARS) {
		const half = Math.floor(MAX_TOOL_RESULT_CHARS / 2);
		text = `${text.slice(0, half)}\n...[tool result truncated]...\n${text.slice(-half)}`;
	}
	content.unshift({ type: "text", text });
	return { content };
}

function emitThinking(
	text: string,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>
): void {
	const constructor = (vscode as unknown as Record<string, unknown>)["LanguageModelThinkingPart"] as
		| (new (value: string) => unknown)
		| undefined;
	if (constructor) {
		progress.report(new constructor(text) as vscode.LanguageModelResponsePart);
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function readNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
