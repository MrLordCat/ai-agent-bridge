
import * as vscode from "vscode";
import {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    LanguageModelChatRequestMessage,
    LanguageModelChatProvider,
    ProvideLanguageModelChatResponseOptions,
    LanguageModelResponsePart,
    Progress,
} from "vscode";
import { normalizeChatTokenUsage, type ChatTokenUsage } from "./context/usage";
import {
    ToolCallReliabilityGuard,
    ToolCallValidationError,
    type ToolCallReliabilityMetrics,
    type ToolCallReliabilityOptions,
} from "./tools/tool-call-reliability";
import type { OpenAIFunctionToolDef } from "./types";

export const DEFAULT_MAX_OUTPUT_TOKENS = 131072;
export const DEFAULT_CONTEXT_LENGTH = 65536;
const STREAM_TEXT_FLUSH_INTERVAL_MS = 50;
const STREAM_TEXT_MEDIUM_FLUSH_INTERVAL_MS = 150;
const STREAM_TEXT_LONG_FLUSH_INTERVAL_MS = 350;
const STREAM_TEXT_MEDIUM_THRESHOLD_CHARS = 1000;
const STREAM_TEXT_LONG_THRESHOLD_CHARS = 4000;
const STREAM_TEXT_FLUSH_CHARS = 1024;

/**
 * Base class for OpenAI-compatible chat providers.
 * Provides common functionality for handling streaming responses, tool calls, and token estimation.
 * Subclasses must implement the abstract methods to integrate with specific APIs.
 *
 */
export abstract class BaseChatModelProvider implements LanguageModelChatProvider {
    /** Buffer for assembling streamed tool calls by index. */
    private _toolCallBuffers: Map<number, { id?: string; name?: string; args: string }> = new Map<
        number,
        { id?: string; name?: string; args: string }
    >();

    /** Indices for which a tool call has been fully emitted. */
    private _completedToolCallIndices = new Set<number>();

    /** Track if we emitted any assistant text before seeing tool calls (SSE-like begin-tool-calls hint). */
    private _hasEmittedAssistantText = false;

    /** Track if we emitted the begin-tool-calls whitespace flush. */
    private _emittedBeginToolCallsHint = false;

    /** Track whether we already emitted a max-length hint in the current response stream. */
    private _emittedLengthFinishHint = false;

    /** Which setting actually raises the sent max_tokens; DeepSeek differs from the local default. */
    protected outputLimitHintSetting = "llamacpp.maxOutputTokensCap";

    // Lightweight tokenizer state for tool calls embedded in text
    private _textToolParserBuffer = "";
    private _textToolActive:
        | undefined
        | {
              name?: string;
              index?: number;
              argBuffer: string;
              emitted?: boolean;
          };
    private _emittedTextToolCallKeys = new Set<string>();
    private _emittedTextToolCallIds = new Set<string>();
    private _thinkingTagBuffer = "";
    /** Open thinking marker family ("<think>", "|thinking|>", "thinking>") or "" when outside a section. */
    private _thinkingMarker: { open: string; close: string } | "" = "";
    private _emittedThinkingParts = new WeakMap<object, string>();
    private _currentTurnReasoningContent = "";
    private _reasoningScope = "";
    private readonly _reasoningByScope = new Map<string, Map<string, string>>();

    /** Number of recent conversations that keep their reasoning entries. */
    private static readonly MAX_REASONING_SCOPES = 12;
    /** Per-conversation character budget for retained reasoning. */
    private static readonly MAX_REASONING_SCOPE_CHARS = 2_000_000;

    /** Thinking markers recognised inside delta.content, with their closing marker. */
    private static readonly THINKING_MARKERS: ReadonlyArray<{ open: string; close: string }> = [
        { open: "<think>", close: "</think>" },
        { open: "|thinking|>", close: "<|/thinking|>" },
        { open: "thinking>", close: "</thinking>" },
    ];

    /**
     * Binds reasoning storage to a single conversation.
     *
     * Evicting one historical entry silently removes `reasoning_content` from an
     * assistant message that was already sent, which changes the outgoing prompt
     * prefix and invalidates the whole upstream cache. Scoping stops a second
     * busy chat from evicting the entries of the first one.
     */
    protected setReasoningScope(scope: string | undefined): void {
        this._reasoningScope = typeof scope === "string" ? scope : "";
    }

    private reasoningMapFor(scope: string, create: boolean): Map<string, string> | undefined {
        const existing = this._reasoningByScope.get(scope);
        if (existing) {
            // Refresh the LRU position of the scope that is still in use.
            this._reasoningByScope.delete(scope);
            this._reasoningByScope.set(scope, existing);
            return existing;
        }
        if (!create) {
            return undefined;
        }
        const created = new Map<string, string>();
        this._reasoningByScope.set(scope, created);
        while (this._reasoningByScope.size > BaseChatModelProvider.MAX_REASONING_SCOPES) {
            const oldest = this._reasoningByScope.keys().next().value as string | undefined;
            if (oldest === undefined || oldest === scope) {
                break;
            }
            this._reasoningByScope.delete(oldest);
        }
        return created;
    }

    /** Exposed for subclass persistence (survives Extension Host restarts). */
    protected exportReasoningScopes(): Array<[string, Array<[string, string]>]> {
        return [...this._reasoningByScope].map(([scope, entries]) => [scope, [...entries]]);
    }

    protected restoreReasoningEntry(callId: string, reasoning: string, scope = ""): void {
        if (!callId || !reasoning) {
            return;
        }
        this.reasoningMapFor(scope, true)?.set(callId, reasoning);
    }
    private readonly _toolCallReliability = new ToolCallReliabilityGuard();

    protected configureToolCallReliability(
        tools: readonly OpenAIFunctionToolDef[] | undefined,
        options: ToolCallReliabilityOptions
    ): void {
        this._toolCallReliability.configure(tools, options);
    }

    protected consumeToolCallReliabilityMetrics(): ToolCallReliabilityMetrics {
        return this._toolCallReliability.consumeMetrics();
    }

    /**
     * Creates a new instance of the base chat model provider.
     * Initializes internal state for handling streaming responses and tool calls.
     *
     * @param secrets - VS Code secret storage for storing sensitive data like API keys.
     */
    constructor(protected readonly secrets: vscode.SecretStorage) {}

    /**
     * Provides information about available language models.
     * Subclasses must implement this to return model details from their API.
     *
     * @param options - Options for the request, including whether to suppress errors.
     * @param token - Cancellation token to abort the operation.
     * @returns Promise resolving to an array of language model information.
     */
    abstract provideLanguageModelChatInformation(
        options: { silent: boolean },
        token: CancellationToken
    ): Promise<LanguageModelChatInformation[]>;

    /**
     * Provides a chat response from the language model.
     * Subclasses must implement this to send requests to their API and handle responses.
     *
     * @param model - Information about the selected language model.
     * @param messages - Array of chat messages for the conversation.
     * @param options - Options for the response generation.
     * @param progress - Progress callback to report response parts.
     * @param token - Cancellation token to abort the operation.
     * @returns Promise that resolves when the response is complete.
     */
    abstract provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: readonly LanguageModelChatMessage[],
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void>;

    /**
     * Roughly estimate tokens for VS Code chat messages (text only).
     * Uses a simple heuristic of 1 token per 4 characters.
     *
     * @param msgs - Array of chat messages to estimate tokens for.
     * @returns Estimated number of tokens.
     */
    protected estimateMessagesTokens(msgs: readonly vscode.LanguageModelChatMessage[]): number {
        let total = 0;
        for (const m of msgs) {
            total += this.estimateMessageContentTokens(m.content);
        }
        return total;
    }

    /**
     * Rough token estimate for tool definitions by JSON size.
     * Serializes the tools to JSON and estimates tokens based on length.
     *
     * @param tools - Array of tool definitions to estimate tokens for.
     * @returns Estimated number of tokens for the tools.
     */
    protected estimateToolTokens(
        tools: { type: string; function: { name: string; description?: string; parameters?: object } }[] | undefined
    ): number {
        if (!tools || tools.length === 0) {
            return 0;
        }
        try {
            const json = JSON.stringify(tools);
            return Math.ceil(json.length / 4);
        } catch {
            return 0;
        }
    }

    /**
     * Estimate tokens for plain text using a lightweight heuristic.
     */
    private estimateTextTokens(text: string): number {
        return text.length > 0 ? Math.ceil(text.length / 4) : 0;
    }

    /**
     * Estimate tokens for a single unknown message part.
     * Uses structural checks so it works even when parts are proxied/plain objects.
     */
    private estimateUnknownPartTokens(part: unknown): number {
        if (part === undefined || part === null) {
            return 0;
        }

        if (typeof part === "string") {
            return this.estimateTextTokens(part);
        }

        if (part instanceof vscode.LanguageModelTextPart) {
            return this.estimateTextTokens(part.value);
        }

        if (part instanceof vscode.LanguageModelToolCallPart) {
            let total = this.estimateTextTokens(part.callId) + this.estimateTextTokens(part.name);
            try {
                total += Math.ceil(JSON.stringify(part.input ?? {}).length / 4);
            } catch {
                // Ignore serialization errors for rough estimation.
            }
            return total;
        }

        if (part instanceof vscode.LanguageModelToolResultPart) {
            return this.estimateTextTokens(part.callId) + this.estimateMessageContentTokens(part.content);
        }

        if (part instanceof vscode.LanguageModelDataPart) {
            const mime = this.estimateTextTokens(part.mimeType);
            return mime + Math.max(1, Math.ceil(part.data.byteLength / 4));
        }

        if (typeof part === "object") {
            const obj = part as Record<string, unknown>;

            if (typeof obj.value === "string") {
                return this.estimateTextTokens(obj.value);
            }

            if (obj.data instanceof Uint8Array) {
                const mime = typeof obj.mimeType === "string" ? this.estimateTextTokens(obj.mimeType) : 0;
                return mime + Math.max(1, Math.ceil(obj.data.byteLength / 4));
            }

            if (typeof obj.name === "string" && "input" in obj) {
                let total = this.estimateTextTokens(obj.name);
                if (typeof obj.callId === "string") {
                    total += this.estimateTextTokens(obj.callId);
                }
                try {
                    total += Math.ceil(JSON.stringify(obj.input ?? {}).length / 4);
                } catch {
                    // Ignore serialization errors for rough estimation.
                }
                return total;
            }

            if (Array.isArray(obj.content)) {
                const callId = typeof obj.callId === "string" ? this.estimateTextTokens(obj.callId) : 0;
                return callId + this.estimateMessageContentTokens(obj.content);
            }

            try {
                return Math.ceil(JSON.stringify(obj).length / 4);
            } catch {
                return 0;
            }
        }

        return 0;
    }

    /**
     * Estimate tokens for heterogeneous message content parts.
     */
    private estimateMessageContentTokens(content: ReadonlyArray<unknown>): number {
        let total = 0;
        for (const part of content) {
            total += this.estimateUnknownPartTokens(part);
        }
        return total;
    }

    /**
     * Returns the number of tokens for a given text using the model specific tokenizer logic.
     * Uses a simple heuristic for estimation since actual tokenization requires model-specific logic.
     *
     * @param model - Information about the language model.
     * @param text - The text or message to count tokens for.
     * @param _token - Cancellation token (unused in this implementation).
     * @returns Promise resolving to the estimated token count.
     */
    async provideTokenCount(
        _model: LanguageModelChatInformation,
        text: string | LanguageModelChatRequestMessage,
        _token: CancellationToken
    ): Promise<number> {
        if (typeof text === "string") {
            return this.estimateTextTokens(text);
        }

        const messageLike = text as { content?: ReadonlyArray<unknown> };
        if (Array.isArray(messageLike.content)) {
            return this.estimateMessageContentTokens(messageLike.content);
        }

        return 0;
    }

    /**
     * Read and parse the stream (SSE-like) response and report parts.
     * Handles Server-Sent Events from the API, processing deltas and emitting progress.
     *
     * @param responseBody - The readable stream from the API response.
     * @param progress - Progress callback to report response parts.
     * @param token - Cancellation token to abort processing.
     * @returns Token usage reported by the server, when available.
     */
    protected async processStreamingResponse(
        responseBody: ReadableStream<Uint8Array>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<ChatTokenUsage | undefined> {
        // The previous turn's reasoning has already been injected into the outgoing
        // request by this point. Start a fresh buffer for the response that follows.
        this.clearCurrentTurnReasoningContent();
        this._toolCallBuffers.clear();
        this._completedToolCallIndices.clear();
        this._hasEmittedAssistantText = false;
        this._emittedBeginToolCallsHint = false;
        this._emittedLengthFinishHint = false;
        this._textToolParserBuffer = "";
        this._textToolActive = undefined;
        this._emittedTextToolCallKeys.clear();
        this._emittedTextToolCallIds.clear();
        this._thinkingTagBuffer = "";
        this._thinkingMarker = "";
        this._emittedThinkingParts = new WeakMap<object, string>();

        const reader = responseBody.getReader();
        const decoder = new TextDecoder();
        const coalescedProgress = this.createTextCoalescingProgress(progress);
        let buffer = "";
        let latestUsage: ChatTokenUsage | undefined;
        let cancellationSubscription: vscode.Disposable | undefined;
        const cancellationSignal = new Promise<"cancelled">(resolve => {
            cancellationSubscription = token.onCancellationRequested(() => resolve("cancelled"));
            if (token.isCancellationRequested) {
                resolve("cancelled");
            }
        });

        try {
            while (true) {
                const outcome = await Promise.race([
                    reader.read().then(result => ({ type: "read" as const, result })),
                    cancellationSignal.then(() => ({ type: "cancelled" as const })),
                ]);
                if (outcome.type === "cancelled") {
                    await reader.cancel("VS Code chat request cancelled").catch(() => undefined);
                    throw new vscode.CancellationError();
                }

                const { done, value } = outcome.result;
                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    latestUsage = (await this.processSseLine(line, coalescedProgress.progress)) ?? latestUsage;
                }
            }

            buffer += decoder.decode();
            if (buffer.length > 0) {
                for (const line of buffer.split("\n")) {
                    const trimmedLine = line.trim();
                    if (!trimmedLine) {
                        continue;
                    }
                    latestUsage = (await this.processSseLine(trimmedLine, coalescedProgress.progress)) ?? latestUsage;
                }
            }

            await this.flushToolCallBuffers(coalescedProgress.progress, /*throwOnInvalid*/ true);
            await this.flushActiveTextToolCall(coalescedProgress.progress);
            this.flushThinkingBuffers(coalescedProgress.progress);
            coalescedProgress.flush();
        } finally {
            cancellationSubscription?.dispose();
            if (token.isCancellationRequested) {
                await reader.cancel("VS Code chat request cancelled").catch(() => undefined);
            }
            coalescedProgress.flush();
            reader.releaseLock();
            // Clean up any leftover tool call state
            this._toolCallBuffers.clear();
            this._completedToolCallIndices.clear();
            this._hasEmittedAssistantText = false;
            this._emittedBeginToolCallsHint = false;
            this._emittedLengthFinishHint = false;
            this._textToolParserBuffer = "";
            this._textToolActive = undefined;
            this._emittedTextToolCallKeys.clear();
            this._thinkingTagBuffer = "";
            this._thinkingMarker = "";
        }

        return latestUsage;
    }

    private createTextCoalescingProgress(
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): { progress: vscode.Progress<vscode.LanguageModelResponsePart>; flush: () => void } {
        let bufferedText = "";
        let bufferedKind: "text" | "thinking" = "text";
        let bufferedThinkingTemplate: vscode.LanguageModelResponsePart | undefined;
        let emittedChars = 0;
        let flushTimer: ReturnType<typeof setTimeout> | undefined;

        const clearFlushTimer = (): void => {
            if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = undefined;
            }
        };

        const flush = (): void => {
            clearFlushTimer();
            if (!bufferedText) {
                return;
            }
            const text = bufferedText;
            const kind = bufferedKind;
            const thinkingTemplate = bufferedThinkingTemplate;
            bufferedText = "";
            bufferedThinkingTemplate = undefined;
            emittedChars += text.length;
            if (kind === "thinking") {
                const ThinkingCtor = this.getThinkingConstructor();
                if (ThinkingCtor) {
                    const template = thinkingTemplate as unknown as Record<string, unknown> | undefined;
                    const part = new ThinkingCtor(
                        text,
                        typeof template?.id === "string" ? template.id : undefined,
                        template?.metadata
                    ) as vscode.LanguageModelResponsePart;
                    this.rememberThinkingPart(part, text);
                    progress.report(part);
                }
                // No native ThinkingPart support: reasoning stays hidden. The
                // text is already retained in _currentTurnReasoningContent for
                // follow-up tool requests (see emitThinkingText).
            } else {
                progress.report(new vscode.LanguageModelTextPart(text));
            }
        };

        const getFlushIntervalMs = (): number => {
            if (emittedChars >= STREAM_TEXT_LONG_THRESHOLD_CHARS) {
                return STREAM_TEXT_LONG_FLUSH_INTERVAL_MS;
            }
            if (emittedChars >= STREAM_TEXT_MEDIUM_THRESHOLD_CHARS) {
                return STREAM_TEXT_MEDIUM_FLUSH_INTERVAL_MS;
            }
            return STREAM_TEXT_FLUSH_INTERVAL_MS;
        };

        const scheduleFlush = (): void => {
            if (flushTimer) {
                return;
            }
            flushTimer = setTimeout(flush, getFlushIntervalMs());
        };

        return {
            progress: {
                report: part => {
                    const thinkingText = this.getEmittedThinkingText(part);
                    if (thinkingText !== undefined) {
                        if (bufferedText && bufferedKind !== "thinking") {
                            flush();
                        }
                        bufferedKind = "thinking";
                        bufferedThinkingTemplate = bufferedThinkingTemplate ?? part;
                        bufferedText += thinkingText;
                        if (bufferedText.length >= STREAM_TEXT_FLUSH_CHARS) {
                            flush();
                        } else {
                            scheduleFlush();
                        }
                        return;
                    }
                    if (part instanceof vscode.LanguageModelTextPart) {
                        if (!part.value) {
                            return;
                        }
                        if (bufferedText && bufferedKind !== "text") {
                            flush();
                        }
                        bufferedKind = "text";
                        bufferedText += part.value;
                        if (bufferedText.length >= STREAM_TEXT_FLUSH_CHARS) {
                            flush();
                        } else {
                            scheduleFlush();
                        }
                        return;
                    }

                    flush();
                    progress.report(part);
                },
            },
            flush,
        };
    }

    private async processSseLine(
        line: string,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): Promise<ChatTokenUsage | undefined> {
        if (!line.startsWith("data: ")) {
            return undefined;
        }

        const data = line.slice(6);
        if (data === "[DONE]") {
            // Final validation runs once after the stream reader drains.
            this.flushThinkingBuffers(progress);
            return undefined;
        }

        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
            // A malformed transport line is not a model tool-call failure.
            return undefined;
        }
        const usage = normalizeChatTokenUsage(parsed.usage);
        await this.processDelta(parsed, progress);
        return usage;
    }

    /**
     * Handle a single streamed delta chunk, emitting text and tool call parts.
     * Processes the delta from the streaming response and reports appropriate parts.
     *
     * @param delta - The delta object from the API response.
     * @param progress - Progress callback to report response parts.
     * @returns Promise resolving to true if something was emitted, false otherwise.
     */
    private async processDelta(
        delta: Record<string, unknown>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): Promise<boolean> {
        let emitted = false;
        const choice = (delta.choices as Record<string, unknown>[] | undefined)?.[0];
        if (!choice) {
            return false;
        }

        const deltaObj = choice.delta as Record<string, unknown> | undefined;

        // report thinking progress if backend provides it and host supports it
        try {
            const thinkingCandidates: unknown[] = [
                (choice as Record<string, unknown> | undefined)?.thinking,
                (choice as Record<string, unknown> | undefined)?.reasoning,
                (choice as Record<string, unknown> | undefined)?.reasoning_content,
                (deltaObj as Record<string, unknown> | undefined)?.thinking,
                (deltaObj as Record<string, unknown> | undefined)?.reasoning,
                (deltaObj as Record<string, unknown> | undefined)?.reasoning_content,
            ];

            for (const candidate of thinkingCandidates) {
                const extracted = this.extractThinkingPayload(candidate);
                if (extracted.text && this.emitThinkingText(progress, extracted.text, extracted.id, extracted.metadata)) {
                    emitted = true;
                }
            }
        } catch {
            // ignore errors here temporarily
        }
        if (deltaObj?.content) {
            const content = String(deltaObj.content);
            const res = this.processTextContent(content, progress);
            if (res.emittedText) {
                this._hasEmittedAssistantText = true;
            }
            if (res.emittedAny) {
                emitted = true;
            }
        }

        if (deltaObj?.tool_calls) {
            const toolCalls = deltaObj.tool_calls as Array<Record<string, unknown>>;

            // SSEProcessor-like: if first tool call appears after text, emit a whitespace
            // to ensure any UI buffers/linkifiers are flushed without adding visible noise.
            if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText && toolCalls.length > 0) {
                progress.report(new vscode.LanguageModelTextPart(" "));
                this._emittedBeginToolCallsHint = true;
            }

            for (const tc of toolCalls) {
                const idx = (tc.index as number) ?? 0;
                // Ignore any further deltas for an index we've already completed
                if (this._completedToolCallIndices.has(idx)) {
                    continue;
                }
                const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
                if (tc.id && typeof tc.id === "string") {
                    buf.id = tc.id as string;
                }
                const func = tc.function as Record<string, unknown> | undefined;
                if (func?.name && typeof func.name === "string") {
                    buf.name = func.name as string;
                }
                if (typeof func?.arguments === "string") {
                    buf.args += func.arguments as string;
                }
                this._toolCallBuffers.set(idx, buf);

                // Emit immediately once arguments become valid JSON to avoid perceived hanging
                await this.tryEmitBufferedToolCall(idx, progress);
            }
        }

        const finish = (choice.finish_reason as string | undefined) ?? undefined;
        if (finish === "tool_calls" || finish === "stop") {
            // On both 'tool_calls' and 'stop', emit any buffered calls and throw on invalid JSON
            await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ true);
        } else if (finish === "length") {
            // Provide an explicit hint for max-token stop, otherwise it looks like a silent hang/stop.
            await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ false);
            if (!this._emittedLengthFinishHint) {
                progress.report(
                    new vscode.LanguageModelTextPart(
                        `\n\n[output stopped: reached max output tokens; increase ${this.outputLimitHintSetting} if needed]`
                    )
                );
                this._emittedLengthFinishHint = true;
            }
            emitted = true;
        }
        return emitted;
    }

    private getThinkingConstructor(): (new (text: string, id?: string, metadata?: unknown) => unknown) | undefined {
        const vsAny = vscode as unknown as Record<string, unknown>;
        return vsAny["LanguageModelThinkingPart"] as
            | (new (text: string, id?: string, metadata?: unknown) => unknown)
            | undefined;
    }

    private emitThinkingText(
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        text: string,
        id?: string,
        metadata?: unknown
    ): boolean {
        if (!text) {
            return false;
        }

        // Always retain reasoning for the next tool-result request. VS Code may render
        // a native ThinkingPart but omit it from the LanguageModelChatRequestMessage
        // history that is passed back to third-party providers.
        this._currentTurnReasoningContent += text;

        const ThinkingCtor = this.getThinkingConstructor();
        if (ThinkingCtor) {
            const part = new (ThinkingCtor as new (text: string, id?: string, metadata?: unknown) => unknown)(
                text,
                id,
                metadata
            ) as unknown as vscode.LanguageModelResponsePart;
            this.rememberThinkingPart(part, text);
            progress.report(part);
            return true;
        }

        // Fallback: LanguageModelThinkingPart is not available. Keep the reasoning
        // hidden from visible text; the buffer above still carries it into a follow-up
        // tool request as reasoning_content.
        return true;
    }

    private rememberThinkingPart(part: vscode.LanguageModelResponsePart, text: string): void {
        if (part && typeof part === "object") {
            this._emittedThinkingParts.set(part, text);
        }
    }

    protected getEmittedThinkingText(part: unknown): string | undefined {
        if (!part || typeof part !== "object") {
            return undefined;
        }
        return this._emittedThinkingParts.get(part);
    }

    /** Returns the accumulated reasoning content from the current turn's stream. */
    protected getCurrentTurnReasoningContent(): string {
        return this._currentTurnReasoningContent;
    }

    protected getReasoningForToolCall(callId: string): string | undefined {
        if (!callId) {
            return undefined;
        }
        const scoped = this.reasoningMapFor(this._reasoningScope, false)?.get(callId);
        if (scoped !== undefined) {
            return scoped;
        }
        // Entries persisted before conversation scoping existed live in the "" bucket.
        const legacy = this.reasoningMapFor("", false)?.get(callId);
        if (legacy !== undefined) {
            return legacy;
        }
        // Cross-scope fallback: subagents may run with a different conversation
        // scope than the main chat, so the exact callId match fails in the
        // scoped lookup.  Searching all scopes ensures historical tool-call
        // messages get their reasoning restored even when Copilot assigns a
        // different conversation id to an inline subagent turn.
        for (const [, entries] of this._reasoningByScope) {
            const found = entries.get(callId);
            if (found !== undefined) {
                return found;
            }
        }
        return undefined;
    }

    /**
     * Stores reasoning against the call ids it was produced with, so later turns
     * rebuild a byte-identical assistant message instead of dropping the field.
     */
    protected rememberReasoningValueForToolCall(callId: string, reasoning: string): void {
        if (!callId || !reasoning) {
            return;
        }
        const map = this.reasoningMapFor(this._reasoningScope, true);
        if (!map) {
            return;
        }
        map.delete(callId);
        map.set(callId, reasoning);

        let retained = 0;
        for (const value of map.values()) {
            retained += value.length;
        }
        while (retained > BaseChatModelProvider.MAX_REASONING_SCOPE_CHARS && map.size > 1) {
            const oldest = map.keys().next().value as string | undefined;
            if (oldest === undefined || oldest === callId) {
                break;
            }
            retained -= map.get(oldest)?.length ?? 0;
            map.delete(oldest);
        }
    }

    private rememberReasoningForToolCall(callId: string): void {
        this.rememberReasoningValueForToolCall(callId, this._currentTurnReasoningContent);
    }

    /** Clears reasoning after it has been injected into the outgoing request and before the next response stream. */
    protected clearCurrentTurnReasoningContent(): void {
        this._currentTurnReasoningContent = "";
    }

    private extractThinkingPayload(value: unknown): { text: string; id?: string; metadata?: unknown } {
        if (typeof value === "string") {
            return { text: value };
        }

        if (Array.isArray(value)) {
            const chunks = value
                .map(item => this.extractThinkingPayload(item).text)
                .filter(text => text.length > 0);
            return { text: chunks.join("") };
        }

        if (!value || typeof value !== "object") {
            return { text: "" };
        }

        const obj = value as Record<string, unknown>;
        const id = typeof obj["id"] === "string" ? (obj["id"] as string) : undefined;
        const metadata = obj["metadata"];
        const candidates = [
            obj["text"],
            obj["thinking"],
            obj["reasoning"],
            obj["reasoning_content"],
            obj["content"],
            obj["delta"],
        ];

        for (const candidate of candidates) {
            const extracted = this.extractThinkingPayload(candidate);
            if (extracted.text) {
                return { text: extracted.text, id: extracted.id ?? id, metadata: extracted.metadata ?? metadata };
            }
        }

        return { text: "", id, metadata };
    }

    private longestPartialSuffix(source: string, target: string): number {
        for (let k = Math.min(target.length - 1, source.length); k > 0; k--) {
            if (source.endsWith(target.slice(0, k))) {
                return k;
            }
        }
        return 0;
    }

    private extractThinkingFromVisibleText(
        input: string,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): { visibleText: string; emittedAny: boolean } {
        let data = this._thinkingTagBuffer + input;
        let visible = "";
        let emittedAny = false;
        this._thinkingTagBuffer = "";

        while (data.length > 0) {
            if (!this._thinkingMarker) {
                // Outside any thinking section: find the earliest open marker.
                let earliest = -1;
                let earliestMarker: { open: string; close: string } | undefined;
                for (const marker of BaseChatModelProvider.THINKING_MARKERS) {
                    const markerIndex = data.indexOf(marker.open);
                    if (markerIndex !== -1 && (earliest === -1 || markerIndex < earliest)) {
                        earliest = markerIndex;
                        earliestMarker = marker;
                    }
                }
                if (earliest === -1) {
                    // No open marker in this chunk; keep the longest partial marker suffix buffered.
                    let keep = 0;
                    for (const marker of BaseChatModelProvider.THINKING_MARKERS) {
                        keep = Math.max(keep, this.longestPartialSuffix(data, marker.open));
                    }
                    const chunk = keep > 0 ? data.slice(0, data.length - keep) : data;
                    if (chunk) {
                        visible += chunk;
                    }
                    this._thinkingTagBuffer = keep > 0 ? data.slice(data.length - keep) : "";
                    data = "";
                    break;
                }

                if (earliest > 0) {
                    visible += data.slice(0, earliest);
                }
                const foundMarker = earliestMarker as { open: string; close: string };
                data = data.slice(earliest + foundMarker.open.length);
                this._thinkingMarker = foundMarker;
                continue;
            }

            // Inside a thinking section: find the matching close marker.
            const closeIndex = data.indexOf(this._thinkingMarker.close);
            if (closeIndex === -1) {
                const keep = this.longestPartialSuffix(data, this._thinkingMarker.close);
                const chunk = keep > 0 ? data.slice(0, data.length - keep) : data;
                if (chunk && this.emitThinkingText(progress, chunk)) {
                    emittedAny = true;
                }
                this._thinkingTagBuffer = keep > 0 ? data.slice(data.length - keep) : "";
                data = "";
                break;
            }

            const chunk = data.slice(0, closeIndex);
            if (chunk && this.emitThinkingText(progress, chunk)) {
                emittedAny = true;
            }
            data = data.slice(closeIndex + this._thinkingMarker.close.length);
            this._thinkingMarker = "";
        }

        return { visibleText: visible, emittedAny };
    }

    private flushThinkingBuffers(progress: vscode.Progress<vscode.LanguageModelResponsePart>): void {
        if (!this._thinkingTagBuffer) {
            return;
        }

        if (this._thinkingMarker) {
            this.emitThinkingText(progress, this._thinkingTagBuffer);
        } else {
            progress.report(new vscode.LanguageModelTextPart(this._thinkingTagBuffer));
        }
        this._thinkingTagBuffer = "";
    }

    private processTextContent(
        input: string,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): { emittedText: boolean; emittedAny: boolean } {
        const BEGIN = "<|tool_call_begin|>";
        const ARG_BEGIN = "<|tool_call_argument_begin|>";
        const END = "<|tool_call_end|>";

        let data = this._textToolParserBuffer + input;
        let emittedText = false;
        let emittedAny = false;
        let visibleOut = "";

        while (data.length > 0) {
            if (!this._textToolActive) {
                const b = data.indexOf(BEGIN);
                if (b === -1) {
                    // No tool-call start: emit visible portion, but keep any partial BEGIN prefix as buffer
                    const longestPartialPrefix = ((): number => {
                        for (let k = Math.min(BEGIN.length - 1, data.length - 1); k > 0; k--) {
                            if (data.endsWith(BEGIN.slice(0, k))) {
                                return k;
                            }
                        }
                        return 0;
                    })();
                    if (longestPartialPrefix > 0) {
                        const visible = data.slice(0, data.length - longestPartialPrefix);
                        if (visible) {
                            visibleOut += this.stripControlTokens(visible);
                        }
                        this._textToolParserBuffer = data.slice(data.length - longestPartialPrefix);
                        data = "";
                        break;
                    } else {
                        // All visible, clean other control tokens
                        visibleOut += this.stripControlTokens(data);
                        data = "";
                        break;
                    }
                }
                // Emit text before the token
                const pre = data.slice(0, b);
                if (pre) {
                    visibleOut += this.stripControlTokens(pre);
                }
                // Advance past BEGIN
                data = data.slice(b + BEGIN.length);

                // Find the delimiter that ends the name/index segment
                const a = data.indexOf(ARG_BEGIN);
                const e = data.indexOf(END);
                let delimIdx = -1;
                let delimKind: "arg" | "end" | undefined = undefined;
                if (a !== -1 && (e === -1 || a < e)) {
                    delimIdx = a;
                    delimKind = "arg";
                } else if (e !== -1) {
                    delimIdx = e;
                    delimKind = "end";
                } else {
                    // Incomplete header; keep for next chunk (re-add BEGIN so we don't lose it)
                    this._textToolParserBuffer = BEGIN + data;
                    data = "";
                    break;
                }

                const header = data.slice(0, delimIdx).trim();
                const m = header.match(/^([A-Za-z0-9_\-.]+)(?::(\d+))?/);
                const name = m?.[1] ?? undefined;
                const index = m?.[2] ? Number(m?.[2]) : undefined;
                this._textToolActive = { name, index, argBuffer: "", emitted: false };
                // Advance past delimiter token
                if (delimKind === "arg") {
                    data = data.slice(delimIdx + ARG_BEGIN.length);
                } else /* end */ {
                    // No args, finalize immediately
                    data = data.slice(delimIdx + END.length);
                    const did = this.emitTextToolCallIfValid(progress, this._textToolActive, "{}", true);
                    if (did) {
                        this._textToolActive.emitted = true;
                        emittedAny = true;
                    }
                    this._textToolActive = undefined;
                }
                continue;
            }

            // We are inside arguments, collect until END and emit as soon as JSON becomes valid
            const e2 = data.indexOf(END);
            if (e2 === -1) {
                // No end marker yet, accumulate and check for early valid JSON
                this._textToolActive.argBuffer += data;
                // Early emit when JSON becomes valid and we haven't emitted yet
                if (!this._textToolActive.emitted) {
                    const did = this.emitTextToolCallIfValid(progress, this._textToolActive, this._textToolActive.argBuffer, false);
                    if (did) {
                        this._textToolActive.emitted = true;
                        emittedAny = true;
                    }
                }
                data = "";
                break;
            } else {
                this._textToolActive.argBuffer += data.slice(0, e2);
                // Consume END
                data = data.slice(e2 + END.length);
                // Final attempt to emit if not already
                if (!this._textToolActive.emitted) {
                    const did = this.emitTextToolCallIfValid(progress, this._textToolActive, this._textToolActive.argBuffer, true);
                    if (did) {
                        emittedAny = true;
                    }
                }
                this._textToolActive = undefined;
                continue;
            }
        }

        const processed = this.extractThinkingFromVisibleText(visibleOut, progress);
        if (processed.emittedAny) {
            emittedAny = true;
        }

        // Emit any visible text
        const textToEmit = processed.visibleText;
        if (textToEmit && textToEmit.length > 0) {
            progress.report(new vscode.LanguageModelTextPart(textToEmit));
            emittedText = true;
            emittedAny = true;
        }

        // Store leftover for next chunk
        this._textToolParserBuffer = data;

        return { emittedText, emittedAny };
    }

    private emitTextToolCallIfValid(
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        call: { name?: string; index?: number; argBuffer: string; emitted?: boolean },
        argText: string,
        final: boolean
    ): boolean {
        const evaluated = this._toolCallReliability.evaluate(call.name, argText, final);
        if (!evaluated.ok) {
            if (!evaluated.pending && final) {
                throw new ToolCallValidationError(evaluated.reason, call.name, evaluated.kind);
            }
            return false;
        }
        const canonical = JSON.stringify(evaluated.arguments);
        const key = `${evaluated.name}:${canonical}`;
        // identity-based dedupe when index is present
        if (typeof call.index === "number") {
            const idKey = `${evaluated.name}:${call.index}`;
            if (this._emittedTextToolCallIds.has(idKey)) {
                return false;
            }
            // Mark identity as emitted
            this._emittedTextToolCallIds.add(idKey);
        } else if (this._emittedTextToolCallKeys.has(key)) {
            return false;
        }
        this._emittedTextToolCallKeys.add(key);
        const id = `tct_${Math.random().toString(36).slice(2, 10)}`;
        this.rememberReasoningForToolCall(id);
        progress.report(new vscode.LanguageModelToolCallPart(id, evaluated.name, evaluated.arguments));
        return true;
    }

    /**
     * Flushes any active text-embedded tool call.
     * Attempts to parse and emit the tool call if arguments are valid JSON.
     *
     * @param progress - Progress callback to report the tool call part.
     * @returns Promise that resolves when flushing is complete.
     */
    private async flushActiveTextToolCall(progress: vscode.Progress<vscode.LanguageModelResponsePart>): Promise<void> {
        if (!this._textToolActive) {
            return;
        }
        const argText = this._textToolActive.argBuffer;
        this.emitTextToolCallIfValid(progress, this._textToolActive, argText, true);
        this._textToolActive = undefined;
    }

    private async tryEmitBufferedToolCall(
        index: number,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): Promise<void> {
        const buf = this._toolCallBuffers.get(index);
        if (!buf) {
            return;
        }
        if (!buf.name) {
            return;
        }
        const evaluated = this._toolCallReliability.evaluate(buf.name, buf.args, false);
        if (!evaluated.ok) {
            return;
        }
        const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
        const parameters = evaluated.arguments;
        try {
            const canonical = JSON.stringify(parameters);
            this._emittedTextToolCallKeys.add(`${evaluated.name}:${canonical}`);
        } catch {
            /* ignore */
        }
        this.rememberReasoningForToolCall(id);
        progress.report(new vscode.LanguageModelToolCallPart(id, evaluated.name, parameters));
        this._toolCallBuffers.delete(index);
        this._completedToolCallIndices.add(index);
    }

    /**
     * Flushes all accumulated tool call buffers.
     * Attempts to parse and emit tool calls, optionally throwing on invalid JSON.
     *
     * @param progress - Progress callback to report tool call parts.
     * @param throwOnInvalid - Whether to throw an error for invalid JSON arguments.
     * @returns Promise that resolves when all buffers are flushed.
     */
    private async flushToolCallBuffers(
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        throwOnInvalid: boolean
    ): Promise<void> {
        if (this._toolCallBuffers.size === 0) {
            return;
        }
        for (const [idx, buf] of Array.from(this._toolCallBuffers.entries())) {
            const evaluated = this._toolCallReliability.evaluate(buf.name, buf.args, true);
            if (!evaluated.ok) {
                if (throwOnInvalid) {
                    const reason = evaluated.pending ? "incomplete tool-call arguments" : evaluated.reason;
                    const kind = evaluated.pending ? "json" : evaluated.kind;
                    throw new ToolCallValidationError(reason, buf.name, kind);
                }
                // Keep the buffer for the final validation pass.
                continue;
            }
            const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
            const name = evaluated.name;
            try {
                const canonical = JSON.stringify(evaluated.arguments);
                this._emittedTextToolCallKeys.add(`${name}:${canonical}`);
            } catch {
                /* ignore */
            }
            this.rememberReasoningForToolCall(id);
            progress.report(new vscode.LanguageModelToolCallPart(id, name, evaluated.arguments));
            this._toolCallBuffers.delete(idx);
            this._completedToolCallIndices.add(idx);
        }
    }

    /**
     * Helper to strip control tokens from text if they leak.
     * Removes special tokens that might appear in the response text.
     *
     * @param text - The text to clean.
     * @returns The text with control tokens removed.
     */
    private stripControlTokens(text: string): string {
		return text.replace(/<\|tool_call_begin\|>|<\|tool_call_argument_begin\|>|<\|tool_call_end\|>/g, "");
    }
}
