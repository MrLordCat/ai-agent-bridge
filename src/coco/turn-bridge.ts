import { createHash, randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { DelegatedTurnState } from "../tools/delegated-turn-state";
import { enhanceSubagentToolDescription, withRequiredSubagentModel } from "../subagent-guidance";
import { CocoResponseStream } from "./response-stream";
import { selectCocoChatTools } from "./terminal-tools";
import { parseCocoContextUsage } from "./usage-adapter";
import { cocoClientToolName } from "./tool-names";

type JsonObject = Record<string, unknown>;
interface PendingCall {
	part: vscode.LanguageModelToolCallPart;
	resolve: (result: JsonObject) => void;
	reported: boolean;
}

export { COCO_CHAT_TOOL_POLICY } from "./tool-policy";

/** Keep native Chat call IDs and their ACP promises alive across model-provider requests. */
export class CocoTurnBridge implements vscode.Disposable {
	private readonly tools = new Map<string, vscode.LanguageModelChatTool>();
	private readonly completed = new Map<string, JsonObject>();
	private readonly historicalResults = new Map<string, vscode.LanguageModelToolResultPart>();
	private readonly historicalCalls = new Set<string>();
	private readonly state = new DelegatedTurnState<PendingCall, JsonObject>();
	private get pending() { return this.state.pending; }
	private stream?: CocoResponseStream;
	private latestUsage?: JsonObject;
	private progress?: vscode.Progress<vscode.LanguageModelResponsePart>;
	private cancellation?: vscode.Disposable;
	private idleTimer?: NodeJS.Timeout;
	private delegationScheduled = false;
	private get terminal() { return this.state.terminal; }
	private get error() { return this.state.error; }

	constructor(
		advertisedTools: readonly vscode.LanguageModelChatTool[],
		private readonly onStop: (error?: Error) => void,
		private readonly idleTimeoutMs = 30 * 60_000,
		private readonly preserveResult?: (result: vscode.LanguageModelToolResultPart) => Promise<{ output: string }>
	) {
		const seen = new Set<string>();
		for (const original of selectCocoChatTools(advertisedTools).sort((a, b) => a.name.localeCompare(b.name))) {
			if (seen.has(original.name)) { continue; }
			seen.add(original.name);
			const tool = withRequiredSubagentModel(original);
			const alias = cocoClientToolName(tool.name);
			this.tools.set(alias, tool);
		}
	}

	get clientTools(): JsonObject[] {
		return [...this.tools].map(([alias, tool]) => ({
			name: alias,
			description: enhanceSubagentToolDescription(tool.name,
				`VS Code Chat tool ${tool.name}. ${tool.description}`).slice(0, 8_000),
			inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
		}));
	}

	get isTerminal(): boolean { return this.terminal; }
	get pendingCallIds(): ReadonlySet<string> { return new Set(this.pending.keys()); }
	rememberResults(messages: readonly vscode.LanguageModelChatRequestMessage[]): void {
		for (const message of messages) { for (const part of message.content) {
			if (part instanceof vscode.LanguageModelToolResultPart && part.callId.startsWith("coco-")) { this.historicalResults.set(part.callId, part); }
			else if (part instanceof vscode.LanguageModelToolCallPart && part.callId.startsWith("coco-")) { this.historicalCalls.add(part.callId); }
		} }
	}

	start(
		operation: () => Promise<unknown>, progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const completion = this.attach(progress, token);
		void Promise.resolve().then(() => {
			if (this.terminal) { throw this.error ?? new vscode.CancellationError(); }
			return operation();
		}).then(() => this.finish(), error => this.finish(error instanceof Error ? error : new Error(String(error))));
		return completion;
	}

	resume(
		results: readonly vscode.LanguageModelToolResultPart[], progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const completion = this.attach(progress, token);
		const returnedIds = new Set(results.map(result => result.callId));
		if (this.pending.missing(returnedIds, call => call.reported).length) {
			this.finish(new Error("Coco needs the results of every Chat tool call in the batch before continuing."));
			return completion;
		}
		void Promise.all(results.map(async result => ({ result, converted: this.preserveResult ? await this.preserveResult(result) : convertCocoToolResult(result) })))
			.then(converted => {
				if (this.terminal) { return; }
				this.pending.accept(converted, item => item.result.callId, (call, item) => { this.completed.set(item.result.callId,item.converted); call.resolve(item.converted); }, call => call.reported);
				this.reportCalls();
			}, error => this.finish(error instanceof Error ? error : new Error(String(error))));
		return completion;
	}

	accept(update: JsonObject): void {
		if (this.terminal) { return; }
		if (update.sessionUpdate === "usage_update") {
			const usage = parseCocoContextUsage(update);
			if (usage) {
				this.latestUsage = { sessionUpdate: "usage_update", used: usage.usedTokens, size: usage.contextWindowTokens };
				this.stream?.accept(this.latestUsage);
			}
			return;
		}
		if (update.sessionUpdate === "tool_call") {
			// Client tools emit an ACP event too; Chat renders their delegated call, once.
			if (typeof update.title !== "string" || !this.tools.has(update.title)) {
				this.blockInternalAction(typeof update.title === "string" ? update.title : "unknown tool");
			}
			return;
		}
		if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") { return; }
		if (this.stream) { this.stream.accept(update); return; }
		try { this.state.enqueue(update, JSON.stringify(update).length); }
		catch (error) { this.finish(error instanceof Error ? error : new Error(String(error))); }
	}

	delegate(alias: string, input: unknown, nativeCallId?: string): Promise<JsonObject> {
		const tool = this.tools.get(alias);
		if (this.terminal || !tool) {
			return Promise.reject(new Error(`Unavailable Coco client tool: ${alias}`));
		}
		if (!input || typeof input !== "object" || Array.isArray(input)) {
			return Promise.reject(new Error("Coco client tool arguments must be a JSON object."));
		}
		const callId = nativeCallId ? `coco-${createHash("sha256").update(nativeCallId).digest("hex")}` : `coco-${randomUUID()}`;
		if (this.completed.has(callId)) { return Promise.resolve(this.completed.get(callId)!); }
		const historical = this.historicalResults.get(callId);
		if (historical) { return this.preserveResult ? this.preserveResult(historical) : Promise.resolve(convertCocoToolResult(historical)); }
		if (this.historicalCalls.has(callId)) { return Promise.reject(new Error("The earlier Coco tool completion is unknown. Verify its outcome before retrying; no action was repeated.")); }
		if (this.pending.has(callId)) { return Promise.reject(new Error("Duplicate pending Coco callback; no action was repeated.")); }
		const response = new Promise<JsonObject>(resolve => this.pending.set(callId, {
			part: new vscode.LanguageModelToolCallPart(callId, tool.name, input), resolve, reported: false,
		}));
		this.reportCalls();
		return response;
	}

	blockInternalAction(title: string): void {
		this.finish(new Error(`Coco attempted an internal action (${title.slice(0, 160)}). It was stopped. `
			+ "Retry using the supplied VS Code Chat tools so permissions and execution appear in the chat."));
	}

	dispose(): void { this.finish(new vscode.CancellationError()); }

	private attach(progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
		if (this.state.attached) { return Promise.reject(new Error("Coco already has an active Chat response.")); }
		if (this.terminal) { return this.error ? Promise.reject(this.error) : Promise.resolve(); }
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		this.progress = progress;
		this.stream = new CocoResponseStream(progress, token);
		if (this.latestUsage) { this.stream.accept(this.latestUsage); }
		const completion = this.state.attach();
		this.cancellation = token.onCancellationRequested(() => this.finish(new vscode.CancellationError()));
		if (token.isCancellationRequested) { this.finish(new vscode.CancellationError()); return completion; }
		for (const update of this.state.takeOutput()) { this.stream.accept(update); }
		return completion;
	}

	private reportCalls(): void {
		if (!this.progress || this.terminal) { return; }
		let reported = false;
		for (const call of this.pending.values()) {
			if (call.reported) { continue; }
			this.progress.report(call.part);
			call.reported = true;
			reported = true;
		}
		if (!reported || this.delegationScheduled) { return; }
		this.delegationScheduled = true;
		setImmediate(() => {
			this.delegationScheduled = false;
			if (!this.state.attached || this.terminal) { return; }
			this.detach();
			// A stopped chat may never return results. Retire that CLI rather than leak it.
			this.idleTimer = setTimeout(() => this.finish(new Error("Coco Chat tool continuation expired.")), this.idleTimeoutMs);
			this.idleTimer.unref();
		});
	}

	private detach(error?: Error): void {
		this.progress = undefined;
		this.stream = undefined;
		this.cancellation?.dispose();
		this.cancellation = undefined;
		this.state.release(error);
	}

	private finish(error?: Error): void {
		if (!this.state.finish(error, call => call.resolve({ error: "Chat tool delegation stopped." }))) { return; }
		clearTimeout(this.idleTimer);
		this.detach(error);
		this.onStop(error);
	}
}

export function convertCocoToolResult(result: vscode.LanguageModelToolResultPart, limit = 100_000): { output: string } {
	const output = result.content.map(part => {
		if (part instanceof vscode.LanguageModelTextPart) { return part.value; }
		if (part instanceof vscode.LanguageModelDataPart && (part.mimeType.startsWith("text/") || part.mimeType === "application/json")) {
			return new TextDecoder().decode(part.data);
		}
		return "[Non-text tool result: this Coco bridge accepts text only]";
	}).join("\n");
	const marker = "\n[Tool result truncated]\n";
	const keep = Math.floor((limit - marker.length) / 2);
	return { output: output.length > limit ? output.slice(0, keep) + marker + output.slice(-keep) : output };
}

/** Only trailing tool-result messages can resume a suspended prompt, never historical results. */
export function collectCocoToolResults(messages: readonly vscode.LanguageModelChatRequestMessage[]): vscode.LanguageModelToolResultPart[] {
	const results = new Map<string, vscode.LanguageModelToolResultPart>();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== vscode.LanguageModelChatMessageRole.User) { break; }
		const parts = message.content.filter((part): part is vscode.LanguageModelToolResultPart => part instanceof vscode.LanguageModelToolResultPart);
		if (parts.length === 0) { break; }
		for (const part of parts) { if (!results.has(part.callId)) { results.set(part.callId, part); } }
	}
	return [...results.values()];
}