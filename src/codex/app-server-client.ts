import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import type { LlamaLogSink } from "../logger";

type JsonRpcId = number | string;

interface JsonRpcErrorPayload {
	code: number;
	message: string;
	data?: unknown;
}

interface JsonRpcMessage {
	id?: JsonRpcId;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: JsonRpcErrorPayload;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface CodexServerRequest {
	id: JsonRpcId;
	method: string;
	params: unknown;
}

export interface CodexServerNotification {
	method: string;
	params: unknown;
}

export type CodexServerRequestHandler = (request: CodexServerRequest) => Promise<unknown>;

export class CodexAppServerError extends Error {
	constructor(
		message: string,
		readonly code?: number,
		readonly data?: unknown
	) {
		super(message);
		this.name = "CodexAppServerError";
	}
}

/** Buffers newline-delimited JSON without assuming process chunk boundaries. */
export class JsonLineBuffer {
	private buffer = "";

	push(chunk: string): string[] {
		this.buffer += chunk;
		const lines: string[] = [];
		let newlineIndex = this.buffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (line.length > 0) {
				lines.push(line);
			}
			newlineIndex = this.buffer.indexOf("\n");
		}
		return lines;
	}

	reset(): void {
		this.buffer = "";
	}
}

export function resolveBundledCodexCliPath(): string | undefined {
	const extension = vscode.extensions.getExtension("openai.chatgpt");
	if (!extension) {
		return undefined;
	}

	const platformDirectory = (() => {
		if (process.platform === "win32") {
			return process.arch === "arm64" ? "windows-aarch64" : "windows-x86_64";
		}
		if (process.platform === "darwin") {
			return process.arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64";
		}
		if (process.platform === "linux") {
			return process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64";
		}
		return undefined;
	})();
	if (!platformDirectory) {
		return undefined;
	}

	const executable = process.platform === "win32" ? "codex.exe" : "codex";
	const candidate = path.join(extension.extensionPath, "bin", platformDirectory, executable);
	return existsSync(candidate) ? candidate : undefined;
}

export class CodexAppServerClient implements vscode.Disposable {
	private readonly notifications = new vscode.EventEmitter<CodexServerNotification>();
	readonly onNotification = this.notifications.event;
	private readonly stops = new vscode.EventEmitter<Error>();
	readonly onDidStop = this.stops.event;

	private readonly lineBuffer = new JsonLineBuffer();
	private readonly pending = new Map<JsonRpcId, PendingRequest>();
	private process: ChildProcessWithoutNullStreams | undefined;
	private startPromise: Promise<void> | undefined;
	private nextRequestId = 1;
	private processGeneration = 0;
	private disposed = false;
	private requestHandler: CodexServerRequestHandler | undefined;

	constructor(
		private readonly clientVersion: string,
		private readonly logSink?: LlamaLogSink
	) {}

	setServerRequestHandler(handler: CodexServerRequestHandler): void {
		this.requestHandler = handler;
	}

	get generation(): number {
		return this.processGeneration;
	}

	async request<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
		await this.ensureStarted();
		return this.sendRequest<T>(method, params, timeoutMs);
	}

	notify(method: string, params?: unknown): void {
		this.write({ method, ...(params === undefined ? {} : { params }) });
	}

	async restart(): Promise<void> {
		this.stopProcess(new Error("Codex app-server restarted"));
		await this.ensureStarted();
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.stopProcess(new Error("Codex app-server disposed"));
		this.notifications.dispose();
		this.stops.dispose();
	}

	private async ensureStarted(): Promise<void> {
		if (this.disposed) {
			throw new Error("Codex app-server client is disposed");
		}
		if (this.startPromise) {
			await this.startPromise;
			return;
		}
		if (this.process && !this.process.killed) {
			return;
		}
		this.startPromise = this.start().finally(() => {
			this.startPromise = undefined;
		});
		await this.startPromise;
	}

	private async start(): Promise<void> {
		const configuredPath = vscode.workspace.getConfiguration("llamacpp").get<string>("codexCliPath", "").trim();
		const executable = configuredPath || resolveBundledCodexCliPath() || "codex";
		const child = spawn(executable, ["app-server", "--stdio"], {
			cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.lineBuffer.reset();
		this.process = child;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleStdout(chunk, child));
		child.stderr.on("data", (chunk: string) => {
			const message = chunk.trim();
			if (message) {
				this.logSink?.log("codex.app_server.stderr", { message: message.slice(0, 4000) }, "debug");
			}
		});

		await new Promise<void>((resolve, reject) => {
			const onSpawn = (): void => {
				child.off("error", onError);
				resolve();
			};
			const onError = (error: Error): void => {
				child.off("spawn", onSpawn);
				if (this.process === child) {
					this.process = undefined;
				}
				reject(new Error(`Unable to start Codex CLI at ${executable}: ${error.message}`));
			};
			child.once("spawn", onSpawn);
			child.once("error", onError);
		});
		child.on("error", error => {
			if (this.process !== child || this.disposed) {
				return;
			}
			this.logSink?.logError("codex.app_server.process_error", error);
			this.stopProcess(error);
		});

		child.once("exit", (code, signal) => {
			if (this.process !== child) {
				return;
			}
			this.process = undefined;
			this.processGeneration++;
			const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
			const error = new Error(`Codex app-server stopped (${detail})`);
			this.rejectPending(error);
			this.stops.fire(error);
			if (!this.disposed) {
				this.logSink?.logError("codex.app_server.exited", error);
			}
		});

		try {
			await this.sendRequest(
				"initialize",
				{
					clientInfo: {
						name: "llama-vscode-chat",
						title: "AI Agent Bridge",
						version: this.clientVersion,
					},
					capabilities: {
						experimentalApi: true,
						requestAttestation: false,
					},
				},
				15_000
			);
			this.notify("initialized", {});
			this.processGeneration++;
			this.logSink?.log("codex.app_server.started", { executable });
		} catch (error) {
			this.stopProcess(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	private sendRequest<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
		const id = this.nextRequestId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Codex app-server request timed out: ${method}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: value => resolve(value as T),
				reject,
				timer,
			});
			try {
				this.write({ id, method, ...(params === undefined ? {} : { params }) });
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private write(message: JsonRpcMessage): void {
		const child = this.process;
		if (!child || child.killed || !child.stdin.writable) {
			throw new Error("Codex app-server is not running");
		}
		child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private handleStdout(chunk: string, sourceProcess: ChildProcessWithoutNullStreams): void {
		if (this.process !== sourceProcess) {
			return;
		}
		for (const line of this.lineBuffer.push(chunk)) {
			let message: JsonRpcMessage;
			try {
				message = JSON.parse(line) as JsonRpcMessage;
			} catch (error) {
				this.logSink?.logError("codex.app_server.invalid_json", error, { line: line.slice(0, 1000) });
				continue;
			}
			this.handleMessage(message, sourceProcess);
		}
	}

	private handleMessage(message: JsonRpcMessage, sourceProcess: ChildProcessWithoutNullStreams): void {
		if (message.id !== undefined && !message.method) {
			const pending = this.pending.get(message.id);
			if (!pending) {
				return;
			}
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) {
				pending.reject(new CodexAppServerError(message.error.message, message.error.code, message.error.data));
			} else {
				pending.resolve(message.result);
			}
			return;
		}

		if (message.id !== undefined && message.method) {
			void this.handleServerRequest({
				id: message.id,
				method: message.method,
				params: message.params,
			}, sourceProcess);
			return;
		}

		if (message.method) {
			this.notifications.fire({ method: message.method, params: message.params });
		}
	}

	private async handleServerRequest(
		request: CodexServerRequest,
		sourceProcess: ChildProcessWithoutNullStreams
	): Promise<void> {
		try {
			if (!this.requestHandler) {
				throw new CodexAppServerError(`Unsupported Codex server request: ${request.method}`, -32601);
			}
			const result = await this.requestHandler(request);
			if (this.process !== sourceProcess) {
				return;
			}
			this.write({ id: request.id, result });
		} catch (error) {
			if (this.process !== sourceProcess) {
				return;
			}
			const normalized = error instanceof CodexAppServerError
				? error
				: new CodexAppServerError(error instanceof Error ? error.message : String(error), -32603);
			this.write({
				id: request.id,
				error: {
					code: normalized.code ?? -32603,
					message: normalized.message,
					...(normalized.data === undefined ? {} : { data: normalized.data }),
				},
			});
		}
	}

	private stopProcess(error: Error): void {
		const child = this.process;
		this.process = undefined;
		this.rejectPending(error);
		if (child && !child.killed) {
			this.processGeneration++;
			this.stops.fire(error);
			child.kill();
		}
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}
