import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentOptions, SendOptions, SDKUserMessage } from "@cursor/sdk";
import type { ChatModelSource } from "../model-sources/source-routing";
import type { CursorSelection, CursorPrompt } from "./api-client";
import { CursorToolBridge } from "./tool-bridge";

export interface CursorLocalRun { wait(): Promise<{ status: string; result?: string; error?: { message: string; code?: string } }>; cancel(): Promise<void> }
export interface CursorLocalAgent { send(message: SDKUserMessage, options: SendOptions): Promise<CursorLocalRun>; close(): void }
export interface CursorSdkDependencies {
	createAgent?: (options: AgentOptions) => Promise<CursorLocalAgent>;
	available?: () => boolean;
	storageRoot?: string;
	cwd?: () => string;
}
interface Turn { identity: string; bridge: CursorToolBridge; agent?: CursorLocalAgent; run?: CursorLocalRun; ended?: boolean }

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
	constructor(private readonly dependencies: CursorSdkDependencies = {}) {}
	get available(): boolean { return this.dependencies.available?.() ?? cursorSdkRuntimeAvailable(); }
	refresh(): void { for (const turn of [...this.turns]) { turn.bridge.dispose(); } }
	dispose(): void { this.refresh(); }

	async respond(source: ChatModelSource, selection: CursorSelection, prompt: CursorPrompt | (() => CursorPrompt),
		messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
		if (!this.available) { throw new Error("Cursor tools require Node.js 22.13 or newer in the VS Code extension host."); }
		if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
		const identity = createHash("sha256").update(JSON.stringify([source.key, source.serverUrl, source.apiKey, selection, options.modelOptions?._copilotConversationId])).digest("hex");
		const results = trailingCursorToolResults(messages);
		const continuations = [...this.turns].filter(turn => results.some(result => turn.bridge.pendingCallIds.has(result.callId)));
		if (continuations.length > 1) { for (const turn of continuations) { turn.bridge.dispose(); } throw new Error("Cursor received results from different tool sessions."); }
		const existing = continuations[0];
		if (existing) {
			if (existing.identity !== identity) { existing.bridge.dispose(); throw new Error("The Cursor profile, key or model changed during tool execution. Retry the request."); }
			existing.bridge.updateTools(options.tools ?? []);
			await existing.bridge.resume(results, progress, token);
			return;
		}
		if (results.some(result => result.callId.startsWith("cursor-"))) { throw new Error("Cursor tool session is no longer active. Retry the request."); }
		const bridge = new CursorToolBridge(options.tools ?? [], () => {
			this.turns.delete(turn);
			if (!turn.ended) { void turn.run?.cancel().catch(() => { /* The SDK may already have stopped. */ }); }
			turn.agent?.close();
		}, options.toolMode === vscode.LanguageModelChatToolMode.Required);
		const turn: Turn = { identity, bridge }; this.turns.add(turn);
		await bridge.start(async () => {
			const input = typeof prompt === "function" ? prompt() : prompt;
			const cwd = this.dependencies.cwd?.() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
			const createOptions: AgentOptions = {
				apiKey: source.apiKey, model: selection, tools: options.tools?.length ? ["mcp"] : [],
				mcpServers: {}, agents: {}, mode: "agent",
				local: { cwd, settingSources: [], customTools: bridge.customTools, autoReview: false, enableAgentRetries: false },
			};
			if (this.dependencies.createAgent) { turn.agent = await this.dependencies.createAgent(createOptions); }
			else {
				// Lazy load: providers other than Cursor remain usable on Node 20.
				const sdk = await import("@cursor/sdk");
				createOptions.local!.store = new sdk.JsonlLocalAgentStore(this.dependencies.storageRoot ?? path.join(os.tmpdir(), "ai-agent-bridge-cursor", String(process.pid)));
				turn.agent = await sdk.Agent.create(createOptions);
			}
			if (bridge.isTerminal) { turn.agent.close(); return; }
			let streamedText = "";
			// Cursor runtimes can reject SDK systemPrompt as an unknown CLI option.
			// Tool restrictions remain enforced by tools/settingSources above.
			const message = { ...input, text: `${CURSOR_NATIVE_TOOL_POLICY}\n\nVS Code conversation:\n${input.text}` };
			turn.run = await turn.agent.send(message, {
				local: { customTools: bridge.customTools },
				onDelta: ({ update }) => {
					const delta = update as unknown as { type: string; text?: string };
					if (delta.type === "text-delta" && typeof delta.text === "string") { streamedText += delta.text; bridge.report(delta.text); }
					else if (delta.type === "thinking-delta" && typeof delta.text === "string") { bridge.report(delta.text, true); }
				},
			});
			if (bridge.isTerminal) { await turn.run.cancel(); return; }
			const result = await turn.run.wait();
			turn.ended = true;
			if (result.status !== "finished") { throw cursorRunFailure(result, source.apiKey); }
			if (result.result && !streamedText.endsWith(result.result)) { bridge.report((streamedText ? "\n\n" : "") + result.result); }
		}, progress, token);
	}
}

/** Earlier tool results are history; only a trailing result batch resumes a run. */
function trailingCursorToolResults(messages: readonly vscode.LanguageModelChatRequestMessage[]): vscode.LanguageModelToolResultPart[] {
	const results = new Map<string, vscode.LanguageModelToolResultPart>();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== vscode.LanguageModelChatMessageRole.User) { break; }
		const parts = message.content.filter((part): part is vscode.LanguageModelToolResultPart => part instanceof vscode.LanguageModelToolResultPart);
		if (!parts.length || message.content.some(part => part instanceof vscode.LanguageModelTextPart && part.value.trim())) { break; }
		for (const part of parts) { if (!results.has(part.callId)) { results.set(part.callId, part); } }
	}
	return [...results.values()];
}

/** Preserve SDK diagnostics without echoing the profile key in chat. */
function cursorRunFailure(result: { status: string; error?: { message: string; code?: string } }, apiKey?: string): Error {
	let detail = result.error?.message ?? "";
	if (apiKey) { detail = detail.split(apiKey).join("[redacted]"); }
	detail = detail.replace(/Bearer\s+\S+|\b(?:crsr_|sk-)[A-Za-z0-9_-]+/gi, "[redacted]")
		.replace(/(["']?(?:api[_-]?key|authorization|access[_-]?token)["']?\s*[:=]\s*)["']?[^\s,}"']+/gi, "$1[redacted]")
		.trim().slice(0, 1200);
	const code = result.error?.code?.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80);
	return new Error(`Cursor SDK run ended with status ${result.status}${code ? ` [${code}]` : ""}${detail ? `: ${detail}` : ". No diagnostic details were returned by Cursor."}`);
}