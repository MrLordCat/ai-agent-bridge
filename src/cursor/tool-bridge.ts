import { createHash, randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { DelegatedTurnState } from "../tools/delegated-turn-state";
import type { SDKCustomTool, SDKCustomToolResult } from "@cursor/sdk";
import { enhanceSubagentToolDescription, withRequiredSubagentModel } from "../subagent-guidance";

interface PendingTool {
	part: vscode.LanguageModelToolCallPart;
	reported: boolean;
	resolve(value: SDKCustomToolResult): void;
	reject(error: Error): void;
}

/** Callbacks wait here; Copilot, rather than the SDK, executes each advertised tool. */
export class CursorToolBridge implements vscode.Disposable {
	readonly customTools: Record<string, SDKCustomTool> = {};
	private readonly state = new DelegatedTurnState<PendingTool, vscode.LanguageModelResponsePart>();
	private get pending() { return this.state.pending; }
	private progress?: vscode.Progress<vscode.LanguageModelResponsePart>;
	private cancellation?: vscode.Disposable;
	private timer?: ReturnType<typeof setTimeout>;
	private get terminal() { return this.state.terminal; }
	private scheduled = false;
	private usedTool = false;
	private allowedTools = new Set<string>();
	private readonly thinkingId = `cursor-thinking-${randomUUID()}`;
	constructor(tools: readonly vscode.LanguageModelChatTool[], private readonly onStop: () => void, private readonly required = false) { this.updateTools(tools); }
	get pendingCallIds(): ReadonlySet<string> { return new Set(this.pending.keys()); }
	get isTerminal(): boolean { return this.terminal; }

	updateTools(tools: readonly vscode.LanguageModelChatTool[]): void {
		this.allowedTools = new Set(tools.map(tool => tool.name));
		for (const alias of Object.keys(this.customTools)) { delete this.customTools[alias]; }
		for (const original of tools) {
			const tool = withRequiredSubagentModel(original);
			const alias = `vscode_${tool.name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 70)}_${createHash("sha256").update(tool.name).digest("hex").slice(0, 10)}`;
			this.customTools[alias] = {
				description: enhanceSubagentToolDescription(tool.name, `VS Code tool ${tool.name}. ${tool.description}`).slice(0, 8000),
				inputSchema: tool.inputSchema as SDKCustomTool["inputSchema"] ?? { type: "object", properties: {} },
				execute: args => {
					if (this.terminal) { return Promise.reject(new vscode.CancellationError()); }
					if (!this.allowedTools.has(tool.name)) { return Promise.reject(new Error(`VS Code tool is no longer available: ${tool.name}`)); }
					if (!args || typeof args !== "object" || Array.isArray(args)) { return Promise.reject(new Error("Cursor tool arguments must be an object.")); }
					this.usedTool = true;
					const callId = `cursor-${randomUUID()}`;
					const result = new Promise<SDKCustomToolResult>((resolve, reject) => this.pending.set(callId, { part: new vscode.LanguageModelToolCallPart(callId, tool.name, args), resolve, reject, reported: false }));
					this.scheduleCalls();
					return result;
				},
			};
		}
	}

	start(operation: () => Promise<void>, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
		const completion = this.attach(progress, token);
		void Promise.resolve().then(() => { if (this.terminal) { throw new vscode.CancellationError(); } return operation(); })
			.then(() => this.finish(this.required && !this.usedTool ? new Error("Cursor returned no required tool call.") : undefined), error => this.finish(error instanceof Error ? error : new Error(String(error))));
		return completion;
	}

	resume(results: readonly vscode.LanguageModelToolResultPart[], progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
		const completion = this.attach(progress, token);
		if (this.terminal) { return completion; }
		const returned = new Set(results.map(result => result.callId));
		if (this.pending.missing(returned, call => call.reported).length) { this.finish(new Error("Cursor needs every tool result in the batch before continuing.")); return completion; }
		this.pending.accept(results, result => result.callId, (call, result) => call.resolve(cursorToolResult(result)), call => call.reported);
		this.scheduleCalls();
		return completion;
	}

	report(text: string, thinking = false): void {
		if (!text || this.terminal) { return; }
		let part: vscode.LanguageModelResponsePart;
		if (thinking) {
			const Ctor = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as (new (text: string, id?: string) => vscode.LanguageModelResponsePart) | undefined;
			if (!Ctor) { return; }
			part = new Ctor(text, this.thinkingId);
		} else { part = new vscode.LanguageModelTextPart(text); }
		if (this.progress) { this.progress.report(part); }
		else {
			try { this.state.enqueue(part, text.length); }
			catch (error) { this.finish(error instanceof Error ? error : new Error(String(error))); }
		}
	}

	private attach(progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
		if (this.terminal) { return Promise.reject(new Error("Cursor tool session is no longer active.")); }
		const completion = this.state.attach();
		this.cancellation?.dispose(); clearTimeout(this.timer);
		this.progress = progress;
		this.cancellation = token.onCancellationRequested(() => this.finish(new vscode.CancellationError()));
		this.timer = setTimeout(() => this.finish(new Error("Cursor tool session timed out.")), 30 * 60_000);
		if (token.isCancellationRequested) { this.finish(new vscode.CancellationError()); return completion; }
		for (const part of this.state.takeOutput()) { progress.report(part); }
		this.scheduleCalls();
		return completion;
	}

	private scheduleCalls(): void {
		if (this.scheduled) { return; }
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			if (!this.progress || !this.state.attached || this.terminal) { return; }
			const calls = [...this.pending.values()].filter(call => !call.reported);
			if (!calls.length) { return; }
			for (const call of calls) { call.reported = true; this.progress.report(call.part); }
			this.progress = undefined;
			this.state.release();
		});
	}

	finish(error?: Error): void {
		if (!this.state.finish(error, call => call.reject(error ?? new vscode.CancellationError()))) { return; }
		clearTimeout(this.timer); this.cancellation?.dispose();
		this.progress = undefined;
		this.onStop();
	}
	dispose(): void { this.finish(new vscode.CancellationError()); }
}

function cursorToolResult(result: vscode.LanguageModelToolResultPart): SDKCustomToolResult {
	const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
	for (const part of result.content) {
		if (part instanceof vscode.LanguageModelTextPart) { content.push({ type: "text", text: part.value }); }
		else if (part instanceof vscode.LanguageModelDataPart && (part.mimeType.startsWith("text/") || part.mimeType === "application/json")) { content.push({ type: "text", text: Buffer.from(part.data).toString("utf8") }); }
		else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) { content.push({ type: "image", data: Buffer.from(part.data).toString("base64"), mimeType: part.mimeType }); }
		else { content.push({ type: "text", text: JSON.stringify(part) ?? String(part) }); }
	}
	return { content };
}