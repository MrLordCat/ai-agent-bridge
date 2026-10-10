import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";

type JsonObject = Record<string, unknown>;

export type CocoPromptContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface CocoInitializeResult {
	agentCapabilities?: { promptCapabilities?: { image?: boolean } };
}

export interface CocoPermissionOption {
	optionId: string;
	name?: string;
	kind?: string;
}

export interface CocoPermissionRequest {
	toolCall?: { title?: string; rawInput?: unknown };
	options?: CocoPermissionOption[];
}

export interface CocoAcpHandlers {
	onUpdate?: (update: JsonObject) => void;
	onPermission?: (request: CocoPermissionRequest) => Promise<string | undefined>;
	onClientTool?: (name: string, input: unknown) => Promise<JsonObject>;
}

/** A small newline-delimited JSON-RPC client for `cortex acp serve`. */
export class CocoAcpClient {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<number, {
		resolve: (value: JsonObject) => void;
		reject: (error: Error) => void;
		timer?: NodeJS.Timeout;
	}>();
	private nextId = 1;
	private buffer = "";
	private closed = false;

	constructor(
		executable: string,
		cwd: string,
		connection: string | undefined,
		model: string | undefined,
		private readonly handlers: CocoAcpHandlers = {},
		spawnProcess: typeof spawn = spawn
	) {
		const args = ["acp", "serve", "-w", cwd];
		if (connection) {
			args.push("-c", connection);
		}
		if (model) {
			args.push("-m", model);
		}
		// Match Snowflake's launch environment: VS Code's Node hooks must not reach CLI helpers.
		const env = { ...process.env };
		delete env.NODE_OPTIONS;
		if (path.isAbsolute(executable)) {
			const pathKey = Object.keys(env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
			env[pathKey] = `${path.dirname(executable)}${path.delimiter}${env[pathKey] ?? ""}`;
		}
		this.child = spawnProcess(executable, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.accept(chunk));
		this.child.stderr.resume();
		this.child.stdin.on("error", error => this.failAll(new Error(`Coco IPC failed: ${error.message}`)));
		this.child.on("error", error => { this.closed = true; this.failAll(new Error(`Cannot start Coco CLI: ${error.message}`)); });
		// stdout may still contain the final reply when exit fires; close follows its drain.
		this.child.on("close", code => { this.closed = true; this.failAll(new Error(`Coco CLI exited (code ${code ?? "unknown"}). Check your Snowflake connection or Azure sign-in.`)); });
	}

	async initialize(): Promise<CocoInitializeResult> {
		return this.request("initialize", {
			protocolVersion: 1,
			clientInfo: { name: "ai-agent-bridge", version: "1" },
			clientCapabilities: {},
		}, 20_000);
	}

	newSession(cwd: string, clientTools: JsonObject[] = []): Promise<JsonObject> {
		return this.request("session/new", {
			cwd,
			mcpServers: [],
			...(clientTools.length > 0 ? { _meta: { clientTools } } : {}),
		}, 120_000);
	}

	prompt(sessionId: string, prompt: string | readonly CocoPromptContent[]): Promise<JsonObject> {
		return this.request("session/prompt", {
			sessionId, prompt: typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt,
		});
	}

	setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<JsonObject> {
		return this.request("session/set_config_option", { sessionId, configId, value }, 20_000);
	}

	cancel(sessionId: string): void {
		this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
	}

	dispose(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.failAll(new Error("Coco session closed."));
		if (process.platform === "win32" && this.child.pid) {
			// Stop this owned CLI and its helpers, so a cancelled probe cannot retain credential locks.
			execFile("taskkill.exe", ["/pid", String(this.child.pid), "/t", "/f"], { windowsHide: true }, error => {
				if (error) { this.child.kill(); }
			});
		} else { this.child.kill(); }
	}

	private request(method: string, params: JsonObject, timeoutMs?: number): Promise<JsonObject> {
		if (this.closed) {
			return Promise.reject(new Error("Coco session closed."));
		}
		const id = this.nextId++;
		return new Promise<JsonObject>((resolve, reject) => {
			const entry: (typeof this.pending extends Map<number, infer V> ? V : never) = { resolve, reject };
			if (timeoutMs) {
				entry.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`Coco ${method} timed out. Check the Azure sign-in for your Snowflake connection.`));
				}, timeoutMs);
			}
			this.pending.set(id, entry);
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	private send(message: JsonObject): void {
		if (!this.closed && this.child.stdin.writable) {
			this.child.stdin.write(`${JSON.stringify(message)}\n`);
		}
	}

	private accept(chunk: string): void {
		this.buffer += chunk;
		if (this.buffer.length > 4_000_000) {
			this.failAll(new Error("Coco sent an oversized ACP message."));
			this.dispose();
			return;
		}
		let end: number;
		while ((end = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, end).trim();
			this.buffer = this.buffer.slice(end + 1);
			if (!line) {
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				this.handle(parsed as JsonObject);
			}
		}
	}

	private handle(message: JsonObject): void {
		if (typeof message.id === "number" && !message.method) {
			const entry = this.pending.get(message.id);
			if (!entry) {
				return;
			}
			this.pending.delete(message.id);
			clearTimeout(entry.timer);
			const error = message.error as { message?: unknown } | undefined;
			if (error) {
				entry.reject(new Error(typeof error.message === "string" ? error.message : "Coco ACP request failed."));
			} else {
				entry.resolve((message.result ?? {}) as JsonObject);
			}
			return;
		}
		if (message.method === "session/update") {
			const update = (message.params as JsonObject | undefined)?.update;
			if (update && typeof update === "object" && !Array.isArray(update)) {
				try {
					this.handlers.onUpdate?.(update as JsonObject);
				} catch {
					this.failAll(new Error("Coco session update handler failed."));
					this.dispose();
				}
			}
			return;
		}
		const requestId = typeof message.id === "number" || typeof message.id === "string";
		if (message.method === "session/request_permission" && requestId) {
			void Promise.resolve().then(() => this.handlers.onPermission?.(message.params as CocoPermissionRequest))
				.then(optionId => this.send({ jsonrpc: "2.0", id: message.id,
					result: optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } } }))
				.catch(() => this.send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } }));
			return;
		}
		if (requestId && typeof message.method === "string") {
			if (this.handlers.onClientTool) {
				const method = message.method;
				void Promise.resolve().then(() => this.handlers.onClientTool!(method, message.params))
					.then(result => this.send({ jsonrpc: "2.0", id: message.id, result }))
					.catch(error => this.send({ jsonrpc: "2.0", id: message.id, error: {
						code: -32603,
						message: error instanceof Error ? error.message : "Client tool failed",
					} }));
			} else {
				this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported client method" } });
			}
		}
	}

	private failAll(error: Error): void {
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
	}
}