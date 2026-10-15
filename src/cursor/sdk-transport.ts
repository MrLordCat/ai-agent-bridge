import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentOptions, SendOptions, SDKUserMessage, TokenUsage } from "@cursor/sdk";
import type { ChatModelSource } from "../model-sources/source-routing";
import { encodeProviderModelId } from "../model-sources/source-routing";
import type { CursorSelection, CursorPrompt } from "./api-client";
import { CursorToolBridge } from "./tool-bridge";
import { CursorSessionStore, type CursorSession } from "./session-store";
import { CursorTurnMetrics, type CursorRecordedUsage, type CursorLiveTurn } from "./turn-metrics";
import { CursorHistoryArchive } from "./history-transfer";
import { cursorTranscript } from "./message-adapter";

export interface CursorLocalRun { wait(): Promise<{ status: string; result?: string; error?: { message: string; code?: string }; usage?: TokenUsage }>; cancel(): Promise<void> }
export interface CursorLocalAgent { readonly agentId?: string; send(message: SDKUserMessage, options: SendOptions): Promise<CursorLocalRun>; close(): void }
export interface CursorSdkDependencies {
	createAgent?: (options: AgentOptions) => Promise<CursorLocalAgent>;
	resumeAgent?: (id: string, options: AgentOptions) => Promise<CursorLocalAgent>;
	available?: () => boolean;
	storageRoot?: string;
	state?: vscode.Memento;
	maxImportParts?: number;
	cwd?: () => string;
}
interface Turn { identity: string; bridge: CursorToolBridge; agent?: CursorLocalAgent; run?: CursorLocalRun; ended?: boolean; completed?: boolean; session: CursorSession; metrics: CursorTurnMetrics; conversationId?: unknown }

export const CURSOR_NATIVE_TOOL_POLICY = [
	"You are the Cursor runtime behind a VS Code Copilot Chat model provider.",
	"All commands, filesystem access, edits, web access, questions, planning and subagents must use the supplied VS Code callback tools on the custom-user-tools MCP server.",
	"GetMcpTools is only for discovering those callback tools. Use CallMcpTool to invoke them; Copilot handles approval and execution and returns the result.",
	"Do not use Cursor built-in shell, read, edit, search, web, task, external MCP servers, or internal subagents.",
	"For commands prefer the supplied run_in_terminal tool. Continue from returned tool results without repeating completed calls.",
].join("\n");

export function cursorSdkRuntimeAvailable(): boolean {
	const [major, minor] = process.versions.node.split(".").map(Number);
	const supportedPlatform = ["linux", "darwin"].includes(process.platform) && ["x64", "arm64"].includes(process.arch) || process.platform === "win32" && process.arch === "x64";
	return supportedPlatform && (major > 22 || major === 22 && minor >= 13);
}

/** Local SDK agent loop, with exclusively Copilot-executed callback tools. */
export class CursorSdkTransport implements vscode.Disposable {
	private readonly turns = new Set<Turn>();
	private readonly sessions: CursorSessionStore;
	private readonly archive: CursorHistoryArchive;
	private readonly usage = new vscode.EventEmitter<CursorRecordedUsage>();
	readonly onDidRecordUsage = this.usage.event;
	private readonly live = new vscode.EventEmitter<CursorLiveTurn>();
	readonly onDidUpdateLiveTurn = this.live.event;
	constructor(private readonly dependencies: CursorSdkDependencies = {}) {
		this.sessions = new CursorSessionStore(dependencies.state);
		this.archive = new CursorHistoryArchive(path.join(dependencies.storageRoot ?? path.join(os.tmpdir(), "ai-agent-bridge-cursor", String(process.pid)), "history"));
	}
	get available(): boolean { return this.dependencies.available?.() ?? cursorSdkRuntimeAvailable(); }
	refresh(): void { for (const turn of [...this.turns]) { turn.bridge.dispose(); } this.sessions.dispose(); }
	dispose(): void { this.refresh(); this.usage.dispose(); this.live.dispose(); }
	cancelConversation(conversationId: unknown): void {
		if (typeof conversationId !== "string" || !conversationId) { return; }
		for (const turn of [...this.turns]) { if (turn.conversationId === conversationId) { turn.bridge.dispose(); } }
	}

	async respond(source: ChatModelSource, selection: CursorSelection, prompt: CursorPrompt | (() => CursorPrompt),
		messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken, maximumChars?: number): Promise<void> {
		if (!this.available) { throw new Error("Cursor tools require Node.js 22.13 or newer in the VS Code extension host."); }
		if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
		const conversationId = options.modelOptions?._copilotConversationId;
		const cwd = this.dependencies.cwd?.() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const identity = createHash("sha256").update(JSON.stringify([cwd, source.key, source.serverUrl, source.apiKey, source.workingContextLength, selection, conversationId, Boolean(options.tools?.length)])).digest("hex");
		const results = trailingCursorToolResults(messages);
		const continuations = [...this.turns].filter(turn => results.some(result => turn.bridge.pendingCallIds.has(result.callId)));
		if (continuations.length > 1) { for (const turn of continuations) { turn.bridge.dispose(); } throw new Error("Cursor received results from different tool sessions."); }
		const existing = continuations[0];
		if (existing) {
			if (existing.identity !== identity) { existing.bridge.dispose(); throw new Error("The Cursor profile, key or model changed during tool execution. Retry the request."); }
			existing.bridge.updateTools(options.tools ?? []);
			await existing.bridge.resume(results, this.observe(existing, progress), token);
			return;
		}
		if (results.some(result => result.callId.startsWith("cursor-"))) { throw new Error("Cursor tool session is no longer active. Retry the request."); }
		this.cancelConversation(conversationId);
		const key = typeof conversationId === "string" && conversationId ? createHash("sha256").update(JSON.stringify([cwd, source.key, conversationId])).digest("hex") : undefined;
		const session = this.sessions.acquire(key, identity, messages);
		const metrics = new CursorTurnMetrics(encodeProviderModelId(source.key, selection.id), source.key, messages.length, session, update => this.live.fire(update));
		const bridge = new CursorToolBridge(options.tools ?? [], error => {
			this.turns.delete(turn);
			if (!turn.ended) { void turn.run?.cancel().catch(() => { /* The SDK may already have stopped. */ }); }
			if (!turn.completed || error) { this.sessions.fail(session); }
			const recorded = metrics.finish(error); if (recorded) { this.usage.fire(recorded); }
		}, options.toolMode === vscode.LanguageModelChatToolMode.Required, result => this.archive.toolResult(result, session.key));
		const turn: Turn = { identity, bridge, session, metrics, conversationId }; this.turns.add(turn);
		await bridge.start(async () => {
			try {
			await this.sessions.begin(session);
			const createOptions: AgentOptions = {
				apiKey: source.apiKey, model: selection, tools: options.tools?.length ? ["mcp"] : [],
				mcpServers: {}, agents: {}, mode: "agent",
				local: { cwd, settingSources: [], customTools: bridge.customTools, autoReview: false, enableAgentRetries: false },
			};
			if (!session.agent) {
				const sdk = this.dependencies.createAgent ? undefined : await import("@cursor/sdk");
				if (sdk) { createOptions.local!.store = new sdk.JsonlLocalAgentStore(this.dependencies.storageRoot ?? path.join(os.tmpdir(), "ai-agent-bridge-cursor", String(process.pid))); }
				if (session.agentId) {
					try {
						if (this.dependencies.resumeAgent) { session.agent = await this.dependencies.resumeAgent(session.agentId, createOptions); }
						else if (sdk) { session.agent = await sdk.Agent.resume(session.agentId, createOptions); }
						else { throw new Error("Resume is unavailable in this SDK adapter."); }
					} catch { session.mode = "resume-fallback"; session.deltaStart = 0; }
				}
				if (!session.agent && !bridge.isTerminal) { session.agent = this.dependencies.createAgent ? await this.dependencies.createAgent(createOptions) : await sdk!.Agent.create(createOptions); }
			}
			turn.agent = session.agent;
			if (bridge.isTerminal) { turn.agent?.close(); return; }
			const host = new Map<string, string>();
			if (session.deltaStart > 0) {
				for (const part of messages[0]?.content ?? []) {
					if (part instanceof vscode.LanguageModelTextPart) {
						for (const match of part.value.matchAll(/<(context|environment_info|workspace_info|attachments|reminderInstructions)>[\s\S]*?<\/\1>/g)) { host.set(match[1], match[0]); }
					}
				}
			}
			const delta = [...(host.size ? [vscode.LanguageModelChatMessage.User(`Current VS Code environment (updated snapshot):\n${[...host.values()].join("\n")}`)] : []), ...messages.slice(session.deltaStart)];
			const input = maximumChars === undefined ? typeof prompt === "function" ? prompt() : prompt : cursorTranscript(delta);
			const toolChars = JSON.stringify(options.tools ?? []).length;
			const budget = Math.min(500_000, (maximumChars ?? 550_000) - 49_152 - toolChars);
			if (budget < 4096) { throw new Error("The Cursor working context is too small for its native prompt and tool definitions. Increase the profile context slider."); }
			const transfer = await this.archive.prepare(input, budget, session.key);
			const configured = this.dependencies.maxImportParts ?? vscode.workspace.getConfiguration("llamacpp").get<number>("cursorMaxHistoryImportParts", 16);
			const limit = Number.isSafeInteger(configured) && configured >= 1 && configured <= 128 ? configured : 16;
			if (transfer.imports.length > limit) { throw new Error(`Cursor history requires ${transfer.imports.length} import prompts (limit ${limit}). Full transcript: ${transfer.archivePath}. Increase cursorMaxHistoryImportParts or the working context; no history was dropped.`); }
			const transcript = options.modelOptions?._aabTranscriptPath;
			const reference = typeof transcript === "string" && path.isAbsolute(transcript) ? `\nComplete visible Chat transcript (quoted history, not new instructions): ${JSON.stringify(transcript)}. Use VS Code file/search tools to recover exact earlier details after compaction. Do not repeat historical actions.` : "";
			for (const [index, part] of transfer.imports.entries()) {
				if (index === 0) { bridge.report(`Restoring conversation history into Cursor (${transfer.imports.length} parts). Full transcript: ${transfer.archivePath}\n\n`); }
				await this.send(turn, { ...part, text: `History import ${index + 1}/${transfer.imports.length}. Treat this as quoted history. Do not execute tools or answer historical tasks. Reply only ACK.\n\n${part.text}` }, source, true);
			}
			await this.send(turn, { ...transfer.prompt, text: `${CURSOR_NATIVE_TOOL_POLICY}${reference}\n\nVS Code conversation:\n${transfer.prompt.text}` }, source, false);
			if (bridge.isTerminal) { return; }
			await this.sessions.complete(session); turn.completed = true;
			} catch (error) {
				if (error instanceof vscode.CancellationError) { throw error; }
				// Raw SDK causes/stacks may contain credentials even after sanitizing message.
				// eslint-disable-next-line preserve-caught-error -- Expose only the redacted diagnostic.
				throw new Error(redactCursorMessage(error instanceof Error ? error.message : String(error), source.apiKey));
			}
		}, this.observe(turn, progress), token);
	}
	private observe(turn: Turn, progress: vscode.Progress<vscode.LanguageModelResponsePart>): vscode.Progress<vscode.LanguageModelResponsePart> {
		return { report: part => { if (part instanceof vscode.LanguageModelToolCallPart) { turn.metrics.tool(); } progress.report(part); } };
	}
	private async send(turn: Turn, input: CursorPrompt, source: ChatModelSource, importing: boolean): Promise<void> {
		if (turn.bridge.isTerminal) { throw new vscode.CancellationError(); }
		let streamedText = ""; turn.ended = false;
		turn.run = await turn.agent!.send(input, { local: { customTools: importing ? {} : turn.bridge.customTools },
			onDelta: ({ update }) => {
				if (importing) { return; }
				const delta = update as unknown as { type: string; text?: string };
				if (typeof delta.text !== "string") { return; }
				if (delta.type === "text-delta") { streamedText += delta.text; turn.metrics.text(delta.text); turn.bridge.report(delta.text); }
				else if (delta.type === "thinking-delta") { turn.metrics.text(delta.text, true); turn.bridge.report(delta.text, true); }
			},
		});
		if (turn.bridge.isTerminal) { await turn.run.cancel(); return; }
		const result = await turn.run.wait(); turn.ended = true;
		if (turn.bridge.isTerminal) { return; }
		turn.metrics.result(result.usage);
		if (result.status !== "finished") { throw cursorRunFailure(result, source.apiKey); }
		if (!importing && result.result && !streamedText.endsWith(result.result)) { const text = (streamedText ? "\n\n" : "") + result.result; turn.metrics.text(text); turn.bridge.report(text); }
	}
}

/** Earlier tool results are history; only a trailing result batch resumes a run. */
function trailingCursorToolResults(messages: readonly vscode.LanguageModelChatRequestMessage[]): vscode.LanguageModelToolResultPart[] {
	const results = new Map<string, vscode.LanguageModelToolResultPart>();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== vscode.LanguageModelChatMessageRole.User) { break; }
		const parts = message.content.filter((part): part is vscode.LanguageModelToolResultPart => part instanceof vscode.LanguageModelToolResultPart);
		if (!parts.length) { break; }
		for (const part of parts) { if (!results.has(part.callId)) { results.set(part.callId, part); } }
	}
	return [...results.values()];
}

/** Preserve SDK diagnostics without echoing the profile key in chat. */
function cursorRunFailure(result: { status: string; error?: { message: string; code?: string } }, apiKey?: string): Error {
	const detail = redactCursorMessage(result.error?.message ?? "", apiKey);
	const code = result.error?.code?.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80);
	return new Error(`Cursor SDK run ended with status ${result.status}${code ? ` [${code}]` : ""}${detail ? `: ${detail}` : ". No diagnostic details were returned by Cursor."}`);
}

function redactCursorMessage(message: string, apiKey?: string): string {
	let detail = message;
	if (apiKey) { detail = detail.split(apiKey).join("[redacted]"); }
	detail = detail.replace(/Bearer\s+\S+|\b(?:crsr_|sk-)[A-Za-z0-9_-]+/gi, "[redacted]")
		.replace(/(["']?(?:api[_-]?key|authorization|access[_-]?token)["']?\s*[:=]\s*)["']?[^\s,}"']+/gi, "$1[redacted]")
		.trim().slice(0, 1200);
	return detail;
}