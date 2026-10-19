import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as path from "node:path";
import type { SessionOptions, SDKUserMessage } from "@snowflake/cortex-agent-sdk/code" with { "resolution-mode": "import" };
import { CocoAcpClient, type CocoAcpHandlers, type CocoPromptContent, type CocoSessionClient } from "./acp-client";
import { COCO_CHAT_TOOL_POLICY } from "./tool-policy";

type Json = Record<string, unknown>;
export function cocoSdkError(error: unknown): Error {
	const raw = error instanceof Error ? error.message : String(error);
	const message = raw.replace(/Bearer\s+\S+|\b(?:crsr_|sk-)[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, "[redacted]")
		.replace(/(["']?(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)["']?\s*[:=]\s*)["']?[^\s,}"']+/gi, "$1[redacted]").slice(0, 1200);
	return new Error(message);
}
export interface CocoSdkSession {
	readonly pid?: number;
	send(message: string | SDKUserMessage): Promise<void>;
	stream(): AsyncIterable<unknown>;
	interrupt(): Promise<void>;
	close(): Promise<void>;
}
export interface CocoSdkDependencies {
	createSession?: (options: SessionOptions) => Promise<CocoSdkSession>;
	createVisionClient?: (handlers: CocoAcpHandlers) => CocoSessionClient;
}
export function cocoSdkAvailable(version = process.versions.node): boolean {
	const [major, minor] = version.split(".").map(Number);
	return major > 22 || major === 22 && minor >= 22;
}
function fingerprint(value: unknown): string {
	const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === "object"
		? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : item;
	return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** SDK owns the native transcript. The adapter only maps events and callback tools. */
export class CocoSdkClient implements CocoSessionClient {
	readonly transport = "sdk" as const;
	private session?: CocoSdkSession;
	private sessionId?: string;
	private closed = false;
	private pump?: Promise<void>;
	private toolNames = new Set<string>();
	private readonly calls = new Map<string, { alias: string; key: string }>();
	private pending?: { resolve(value: Json): void; reject(error: Error): void; partial: boolean; thinkingPartial: boolean; visible: boolean };
	private previousUsage?: number[];
	private effort?: string;
	private effortConfig?: string;
	private visionClient?: CocoSessionClient;
	private visionBusy = false;
	private tools: Json[] = [];
	private resume = false;
	private appliedEffort?: string;
	private failure?: Error;
	private exit = Promise.resolve();
	lastPromptSent = false;
	constructor(private readonly executable: string, private readonly cwd: string, private readonly connection: string | undefined,
		private readonly model: string | undefined, private readonly handlers: CocoAcpHandlers = {}, private readonly dependencies: CocoSdkDependencies = {}) {}

	async initialize() { return { agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } }; }
	async newSession(cwd: string, tools: Json[] = []): Promise<Json> {
		if (cwd !== this.cwd || this.closed) { throw new Error("Invalid Coco workspace or closed session."); }
		const id = randomUUID(); this.sessionId = id; this.tools = tools; this.resume = false; return { sessionId: id };
	}
	async loadSession(id: string, cwd: string, tools: Json[] = []): Promise<Json> {
		if (cwd !== this.cwd || this.closed) { throw new Error("Invalid Coco workspace or closed session."); }
		this.sessionId = id; this.tools = tools; this.resume = true;
		if (this.session) { await this.open(id, cwd, tools, true); }
		return { sessionId: id };
	}
	private async open(id: string, cwd: string, tools: Json[], resume: boolean): Promise<void> {
		if (this.closed) { throw new Error("Coco SDK client is closed."); }
		if (!this.dependencies.createSession && !cocoSdkAvailable()) { throw new Error("Coco SDK requires Node.js 22.22 or newer. Select the ACP transport on older extension hosts."); }
		if (!/^[\w-]{1,160}$/.test(id) || cwd !== this.cwd) { throw new Error("Invalid Coco session identity."); }
		if (this.pending) { throw new Error("Cannot replace tools during an active Coco prompt."); }
		const old = this.session; this.session = undefined;
		if (old) { await old.close(); await this.pump; }
		this.sessionId = id; this.calls.clear(); this.previousUsage = undefined; this.failure = undefined;
		this.toolNames = new Set(tools.map(tool => String(tool.name)));
		const configs = tools.map(tool => ({ name: String(tool.name), description: String(tool.description ?? "VS Code tool"), inputSchema: tool.inputSchema,
			handler: async (input: unknown) => {
				if (this.closed || !this.pending) { throw new Error("Coco tool request is outside an active VS Code turn."); }
				const matches = [...this.calls].filter(([, call]) => call.alias === tool.name && call.key === fingerprint(input));
				if (matches.length > 1) { throw new Error("Ambiguous Coco tool correlation; no action was executed."); }
				const nativeId = matches[0]?.[0]; if (nativeId) { this.calls.delete(nativeId); }
				const result = await this.handlers.onClientTool?.(String(tool.name), input, nativeId);
				return { content: [{ type: "text", text: JSON.stringify(result ?? { error: "VS Code callback unavailable" }) }] };
			} }));
		const alias = (name: string) => name.startsWith("mcp__vscode_chat__") ? name.slice("mcp__vscode_chat__".length) : name;
		const options: SessionOptions = {
			cliPath: this.executable, cwd, connection: this.connection, model: this.model === "auto" ? undefined : this.model,
			...(resume ? { resume: id } : { sessionId: id }), includePartialMessages: true,
			appendSystemPrompt: COCO_CHAT_TOOL_POLICY,
			onlyExplicitMcpServers: true,
			// Avoid ambient profile/plugin MCP servers; project instructions remain enabled.
			extraArgs: { "only-explicit-profiles": null, "only-explicit-plugins": null },
			mcpServers: { vscode_chat: { type: "sdk", name: "vscode_chat", _toolDefinitions: configs } as NonNullable<SessionOptions["mcpServers"]>[string] },
			canUseTool: async (name, input) => {
				// 0.YY.MMDD CLI sends a permission category plus a resource, not the tool's raw arguments.
				const target = name === "MCP" && input.action === "execute_command" && typeof input.resource === "string"
					? alias(input.resource.split("\n", 1)[0]) : alias(name);
				if (this.toolNames.has(target)) { return { behavior: "allow", updatedInput: input }; }
				this.handlers.onUpdate?.({ sessionUpdate: "tool_blocked", title: name, inputKeys: Object.keys(input) });
				return { behavior: "deny", message: "Use the supplied VS Code callback tools." };
			},
			hooks: { PreToolUse: [{ hooks: [async (input, toolUseId) => {
				const name = alias(input.tool_name ?? "");
				if (!this.toolNames.has(name)) { this.handlers.onUpdate?.({ sessionUpdate: "tool_blocked", title: input.tool_name, inputKeys: Object.keys(input.tool_input ?? {}) }); return { decision: "block", reason: "Internal actions are disabled; use VS Code tools.", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Use VS Code tools." } }; }
				const nativeId = input.tool_use_id ?? toolUseId;
				if (nativeId) { this.calls.set(nativeId, { alias: name, key: fingerprint(input.tool_input ?? {}) }); }
				return { continue: true };
			}] }] },
			env: { NODE_OPTIONS: undefined, ...(this.connection ? { COCO_CLI_CONNECTION_OVERRIDES_INFERENCE: "1" } : {}),
				PATH: `${path.dirname(this.executable)}${path.delimiter}${process.env.PATH ?? ""}` },
		};
		if (this.effort) { options.effort = this.effort; }
		const create = this.dependencies.createSession ?? (await import("@snowflake/cortex-agent-sdk/code")).createSession;
		const session = await create(options).catch(error => { throw cocoSdkError(error); });
		if (this.closed) { void session.close().catch(() => undefined); throw new Error("Coco session closed during initialization."); }
		this.session = session;
		this.appliedEffort = this.effort;
		this.pump = this.read(session).catch(error => { this.failure = cocoSdkError(error); this.pending?.reject(this.failure); this.pending = undefined; });
	}
	async setSessionConfigOption(_id: string, _config: string, value: string): Promise<Json> {
		// SDK effort is a process option: rebind the same native session before inference.
		this.effort = value; this.effortConfig = _config;
		return {};
	}
	async prompt(id: string, prompt: string | readonly CocoPromptContent[]): Promise<Json> {
		this.lastPromptSent = false;
		if (this.closed || id !== this.sessionId) { throw new Error("Coco native session is unavailable."); }
		if (this.pending || this.visionBusy) { throw new Error("A Coco prompt is already active."); }
		if (typeof prompt !== "string" && prompt.some(part => part.type === "image")) { return this.promptWithImages(id,prompt); }
		if (!this.session || this.appliedEffort !== this.effort) { await this.open(id, this.cwd, this.tools, this.resume); }
		if (this.failure) { throw this.failure; }
		const content = typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt.map(part => part.type === "text" ? part
			: { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } });
		const session = this.session!;
		return new Promise<Json>((resolve, reject) => {
			const pending = { resolve, reject, partial: false, thinkingPartial: false, visible: false }; this.pending = pending;
			this.lastPromptSent = true; this.resume = true;
			void session.send({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid: randomUUID(), session_id: id } as SDKUserMessage)
				.catch(error => { if (this.pending === pending) { this.pending = undefined; reject(cocoSdkError(error)); } });
		});
	}
	private async promptWithImages(id: string, prompt: readonly CocoPromptContent[]): Promise<Json> {
		this.visionBusy = true;
		const old = this.session; this.session = undefined;
		let client: CocoSessionClient | undefined;
		let live = false;
		const handlers: CocoAcpHandlers = {
			onUpdate: update => { if (live) { this.handlers.onUpdate?.(update); } },
			onPermission: async request => live ? this.handlers.onPermission?.(request) : undefined,
			onClientTool: async (name,input,nativeId) => {
				if (!live || !this.handlers.onClientTool) { throw new Error("Tools are disabled during native history replay."); }
				return this.handlers.onClientTool(name,input,nativeId);
			},
		};
		try {
			if (old) { await old.close(); await this.pump; }
			client = this.dependencies.createVisionClient?.(handlers) ?? new CocoAcpClient(this.executable,this.cwd,this.connection,this.model,handlers);
			this.visionClient = client;
			const capabilities = await client.initialize();
			if (!capabilities.agentCapabilities?.promptCapabilities?.image) { throw new Error("This Coco runtime cannot receive image input."); }
			if (this.resume) { await client.loadSession(id,this.cwd,this.tools); }
			else {
				const created = client instanceof CocoAcpClient ? await client.newSession(this.cwd,this.tools,id) : await client.newSession(this.cwd,this.tools);
				if (created.sessionId !== id) { throw new Error("Coco did not preserve the image session ID. Select the ACP transport; no inference was started."); }
			}
			if (this.effort && this.effortConfig) { await client.setSessionConfigOption(id,this.effortConfig,this.effort); }
			if (this.closed) { throw new Error("Coco image request was cancelled before inference."); }
			this.lastPromptSent = true; this.resume = true; live = true;
			return await client.prompt(id,[{type:"text",text:COCO_CHAT_TOOL_POLICY+"\n\n"},...prompt]);
		} finally {
			live = false; client?.dispose();
			if (client instanceof CocoAcpClient) { this.exit = client.waitForExit(); await this.exit; }
			this.visionClient = undefined; this.visionBusy = false; this.previousUsage = undefined;
		}
	}
	private emit(text: string, thinking = false): void {
		if (text) { this.handlers.onUpdate?.({ sessionUpdate: thinking ? "agent_thought_chunk" : "agent_message_chunk", content: { type: "text", text } }); }
	}
	private async read(session: CocoSdkSession): Promise<void> {
		for await (const value of session.stream()) {
			if (this.session !== session || this.closed) { return; }
			if (!value || typeof value !== "object") { continue; }
			const event = value as Json;
			if (event.type === "parse_error") { throw new Error("Coco SDK returned invalid protocol output. No automatic replay was started."); }
			if (event.type === "system" && event.subtype === "init" && event.session_id !== this.sessionId) { throw new Error("Coco resumed an unexpected native session."); }
			const pending = this.pending; if (!pending) { continue; }
			if (event.type === "stream_event") {
				const stream = event.event as { delta?: { type?: string; text?: string; thinking?: string } } | undefined;
				if (stream?.delta?.type === "text_delta") { pending.partial = true; pending.visible = true; this.emit(stream.delta.text ?? ""); }
				if (stream?.delta?.type === "thinking_delta") { pending.thinkingPartial = true; this.emit(stream.delta.thinking ?? "", true); }
			} else if (event.type === "assistant") {
				const message = event.message as { content?: Array<{ type: string; text?: string; thinking?: string }> } | undefined;
				for (const part of message?.content ?? []) { if (part.type === "text" && !pending.partial) { pending.visible = true; this.emit(part.text ?? ""); } else if (part.type === "thinking" && !pending.thinkingPartial) { this.emit(part.thinking ?? "", true); } }
				pending.partial = false; pending.thinkingPartial = false;
			} else if (event.type === "system" && event.subtype === "compact_boundary") {
				this.handlers.onUpdate?.({ sessionUpdate: "compaction" });
			} else if (event.type === "result") {
				this.pending = undefined;
				if (event.is_error || event.subtype !== "success") { pending.reject(cocoSdkError(`Coco SDK run failed: ${Array.isArray(event.errors) ? event.errors.join("; ").slice(0,1000) : "native execution failed"}`)); continue; }
				if (!pending.visible && typeof event.result === "string") { this.emit(event.result); }
				const usage = event.usage as Json | undefined;
				const values = usage ? [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens] : [];
				let normalized: Json | undefined;
				if (values.length === 4 && values.every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) {
					const totals = values as number[];
					const delta = this.previousUsage && totals.every((n,i) => n >= this.previousUsage![i]) ? totals.map((n,i) => n - this.previousUsage![i]) : totals;
					this.previousUsage = totals;
					normalized = { inputTokens: delta[0], outputTokens: delta[1], cachedReadTokens: delta[2], cachedWriteTokens: delta[3] };
				}
				pending.resolve({ stopReason: "end_turn", ...(normalized ? { usage: normalized } : {}) });
			}
		}
		if (this.session === session && !this.closed) { throw new Error("Coco SDK stream closed before the session was released."); }
	}
	cancel(id: string): void { this.visionClient?.cancel(id); void this.session?.interrupt().catch(() => undefined); }
	async waitForExit(): Promise<void> { await this.exit; }
	dispose(): void {
		if (this.closed) { return; } this.closed = true;
		this.visionClient?.dispose(); this.visionClient = undefined;
		this.pending?.reject(new Error("Coco session closed.")); this.pending = undefined;
		const session = this.session; this.session = undefined;
		if (session) {
			let ended = false;
			this.exit = session.close().catch(() => undefined).finally(() => { ended = true; });
			const timer = setTimeout(() => { if (!ended && session.pid) { if (process.platform === "win32") { execFile("taskkill.exe", ["/pid", String(session.pid), "/t", "/f"], { windowsHide: true }, () => undefined); } else { try { process.kill(session.pid); } catch { /* Already closed. */ } } } }, 1000); timer.unref();
		}
	}
}