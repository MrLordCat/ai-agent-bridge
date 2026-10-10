import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { CocoAcpClient } from "./acp-client";
import {
	decodeCocoModelId, mapCocoModel, parseCocoModels, parseCocoThinkingConfiguration,
	resolveCocoReasoningEffort, type CocoModel, type CocoThinkingConfiguration,
} from "./model-adapter";
import { CocoTurnBridge, collectCocoToolResults, COCO_CHAT_TOOL_POLICY } from "./turn-bridge";
import { serializeCocoMessages, estimateCocoTokens } from "./message-adapter";
import { parseCocoContextUsage } from "./usage-adapter";

const DISCOVERY_RETRY_MS = 60_000;
export const COCO_DISCOVERY_TIMEOUT_MS = 45_000;
const AUTO_MODEL: CocoModel = { id: "auto", name: "Auto", description: "Snowflake selects an available model" };

export interface CocoProviderStatus {
	state: "checking" | "connected" | "disabled" | "unconfigured" | "unavailable";
	summary: string;
	modelCount: number;
	connection?: string;
	checkedAt?: number;
}

export interface CocoProviderDependencies {
	isEnabled?: () => boolean;
	resolveCli?: () => string | undefined;
	resolveConnection?: () => string | undefined;
	createClient?: (...args: ConstructorParameters<typeof CocoAcpClient>) => CocoAcpClient;
	discoveryTimeoutMs?: number;
}

interface CocoActiveTurn {
	modelId: string;
	executable: string;
	connection?: string;
	bridge: CocoTurnBridge;
	client: CocoAcpClient;
	sessionId?: string;
}

export function resolveCocoCli(): string | undefined {
	const configured = vscode.workspace.getConfiguration("llamacpp").get<string>("cocoCliPath", "").trim();
	if (configured) {
		return fs.existsSync(configured) ? configured : undefined;
	}
	const snowflake = vscode.extensions.getExtension("snowflake.snowflake-vsc");
	if (!snowflake) {
		return undefined;
	}
	const binary = path.join(snowflake.extensionPath, "bin", process.platform === "win32" ? "cortex.exe" : "cortex");
	return fs.existsSync(binary) ? binary : undefined;
}

/** The CLI uses its own credential cache; we only read connection names, never credentials. */
export function resolveCocoConnection(): string | undefined {
	const selected = vscode.workspace.getConfiguration("llamacpp").get<string>("cocoConnection", "").trim();
	if (selected) {
		return selected;
	}
	const names = listCocoConnections();
	return names.length === 1 ? names[0] : undefined;
}

export function listCocoConnections(): string[] {
	const configuredPath = vscode.workspace.getConfiguration("snowflake").get<string>("connectionsConfigFile", "").trim();
	const filePath = configuredPath
		? configuredPath.replace(/^~(?=[\\/])/, os.homedir())
		: path.join(os.homedir(), ".snowflake", "connections.toml");
	try {
		const names = [...fs.readFileSync(filePath, "utf8").matchAll(/^\s*\[([^\]\r\n]+)\]\s*(?:#.*)?$/gm)]
			.map(match => match[1].trim().replace(/^(["'])(.*)\1$/, "$2"));
		return [...new Set(names)];
	} catch {
		return [];
	}
}

export class CocoChatModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
	private readonly changes = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changes.event;
	private readonly statusChanges = new vscode.EventEmitter<CocoProviderStatus>();
	readonly onDidChangeStatus = this.statusChanges.event;
	private status: CocoProviderStatus = { state: "checking", summary: "Checking...", modelCount: 0 };
	private disposed = false;
	private models: CocoModel[] = [AUTO_MODEL];
	private thinking?: CocoThinkingConfiguration;
	private imageInput = false;
	private readonly observedContextWindows = new Map<string, number>();
	private discovery?: Promise<void>;
	private discoveryGeneration = 0;
	private lastDiscoveryAt = 0;
	private readonly clients = new Set<CocoAcpClient>();
	private readonly activeTurns = new Set<CocoActiveTurn>();
	private discoveryClient?: CocoAcpClient;
	private stopDiscovery?: () => void;
	private acceptDiscovery?: (modelCount: number) => void;
	private catalogSource?: string;

	constructor(private readonly dependencies: CocoProviderDependencies = {}) {}

	get providerStatus(): CocoProviderStatus {
		return { ...this.status };
	}

	get thinkingLevels(): readonly string[] {
		return this.thinking?.options.map(option => option.label) ?? [];
	}

	async refreshStatus(force = false, token?: vscode.CancellationToken): Promise<CocoProviderStatus> {
		if (token?.isCancellationRequested) { return this.providerStatus; }
		if (force) {
			this.lastDiscoveryAt = 0;
		}
		const check = this.discover();
		// Capture this check's stop function: a late cancellation must not stop a replacement check.
		const stop = this.stopDiscovery;
		const cancellation = token?.onCancellationRequested(() => stop?.());
		try { await check; } finally { cancellation?.dispose(); }
		return this.providerStatus;
	}

	private resolveCli(): string | undefined {
		return (this.dependencies.resolveCli ?? resolveCocoCli)();
	}

	private resolveConnection(): string | undefined {
		return (this.dependencies.resolveConnection ?? resolveCocoConnection)();
	}

	private createClient(...args: ConstructorParameters<typeof CocoAcpClient>): CocoAcpClient {
		return this.dependencies.createClient?.(...args) ?? new CocoAcpClient(...args);
	}

	private get enabled(): boolean {
		return this.dependencies.isEnabled?.()
			?? vscode.workspace.getConfiguration("llamacpp").get<boolean>("enableCoco", true);
	}

	refreshLanguageModelChatInformation(): void {
		const source = JSON.stringify([this.enabled, this.resolveCli(), this.resolveConnection()]);
		const changed = this.catalogSource !== source;
		if (changed) {
			this.discoveryGeneration++;
			this.stopDiscovery?.();
			this.catalogSource = source;
			this.models = [AUTO_MODEL];
			this.thinking = undefined;
			this.imageInput = false;
			this.observedContextWindows.clear();
			this.setStatus(this.enabled ? "checking" : "disabled", this.enabled ? "Checking..." : "Off", this.resolveConnection());
		}
		for (const turn of this.activeTurns) {
			if (!this.enabled || turn.connection !== this.resolveConnection() || turn.executable !== this.resolveCli()) {
				turn.bridge.dispose();
			}
		}
		if (!this.discovery) { this.lastDiscoveryAt = 0; }
		this.changes.fire();
	}

	async provideLanguageModelChatInformation(
		_options: { silent: boolean },
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (token.isCancellationRequested || this.disposed) {
			return [];
		}
		void this.discover();
		if (!this.enabled || !this.resolveCli()) {
			return [];
		}
		const context = vscode.workspace.getConfiguration("llamacpp").get<number>("cocoContextLength", 128_000);
		return this.models.map(model => mapCocoModel(model,
			this.observedContextWindows.get(model.id) ?? Math.max(4_096, context), this.thinking, this.imageInput));
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		if (!this.enabled || this.disposed) {
			throw new Error("Coco is disabled. Enable its source in Quick Access before sending a request.");
		}
		const modelId = decodeCocoModelId(model.id);
		if (!modelId) {
			throw new Error(`Invalid Coco model: ${model.id}`);
		}
		if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
			throw new Error("Coco cannot force a VS Code tool call. Use automatic tool mode.");
		}
		const executable = this.resolveCli();
		if (!executable) {
			throw new Error("Coco CLI not found. Install the Snowflake VS Code extension or set llamacpp.cocoCliPath.");
		}
		if (token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
		const results = collectCocoToolResults(messages);
		const continuations = [...this.activeTurns].filter(turn => results.some(result => turn.bridge.pendingCallIds.has(result.callId)));
		if (continuations.length > 1) {
			throw new Error("Coco received tool results from different Chat conversations.");
		}
		const continuation = continuations[0];
		if (continuation) {
			if (continuation.modelId !== model.id || continuation.connection !== this.resolveConnection() || continuation.executable !== executable) {
				continuation.bridge.dispose();
				throw new Error("The Coco model or Snowflake connection changed during tool execution. Start a new request.");
			}
			await continuation.bridge.resume(results, progress, token);
			return;
		}
		if (results.some(result => result.callId.startsWith("coco-"))) {
			throw new Error("The Coco tool session is no longer active. Retry the request in Chat.");
		}
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const connection = this.resolveConnection();
		const generation = this.discoveryGeneration;
		const bridge = new CocoTurnBridge(options.tools ?? [], error => {
			if (error && turn.sessionId) { client.cancel(turn.sessionId); }
			client.dispose();
			this.clients.delete(client);
			this.activeTurns.delete(turn);
		});
		const client = this.createClient(executable, cwd, connection, modelId, {
			onUpdate: update => {
				const usage = parseCocoContextUsage(update);
				if (usage && generation === this.discoveryGeneration
					&& this.observedContextWindows.get(modelId) !== usage.contextWindowTokens) {
					this.observedContextWindows.set(modelId, usage.contextWindowTokens);
					this.changes.fire();
				}
				bridge.accept(update);
				if (generation === this.discoveryGeneration && update.sessionUpdate === "config_option_update") {
					this.updateThinking(parseCocoThinkingConfiguration(update));
				}
			},
			onPermission: async request => {
				bridge.blockInternalAction(request.toolCall?.title ?? "permission request");
				return undefined;
			},
			onClientTool: (name, input) => bridge.delegate(name, input),
		});
		const turn: CocoActiveTurn = { modelId: model.id, executable, connection, bridge, client };
		this.activeTurns.add(turn);
		this.clients.add(client);
		let sessionReady = false;
		try {
			await bridge.start(async () => {
				const initialized = await client.initialize();
				const imageInput = initialized?.agentCapabilities?.promptCapabilities?.image === true;
				const session = await client.newSession(cwd, bridge.clientTools);
				const sessionId = typeof session.sessionId === "string" ? session.sessionId : undefined;
				if (!sessionId) {
					throw new Error("Coco did not return a session ID. Check the Snowflake connection and Azure sign-in.");
				}
				turn.sessionId = sessionId;
				const discovered = parseCocoModels(session);
				const thinking = parseCocoThinkingConfiguration(session);
				sessionReady = true;
				if (generation === this.discoveryGeneration) {
					this.updateModels(discovered);
					this.updateThinking(thinking);
					this.updateImageInput(imageInput);
					this.setStatus("connected", "Connected", connection, discovered.length);
					this.acceptDiscovery?.(discovered.length);
				}
				const effort = resolveCocoReasoningEffort(
					options.modelOptions?.reasoningEffort ?? options.modelOptions?.reasoning_effort ?? options.modelOptions?.thinkingLevel,
					thinking
				);
				if (effort !== undefined && thinking) {
					await client.setSessionConfigOption(sessionId, thinking.configId, effort);
				}
				const prompt = serializeCocoMessages(messages);
				if (prompt.length === 0) { throw new Error("Coco received an empty conversation."); }
				if (!imageInput && prompt.some(part => part.type === "image")) {
					throw new Error("This Coco ACP runtime does not support image input. Update the Snowflake extension and refresh Coco models.");
				}
				const prefix = `${COCO_CHAT_TOOL_POLICY}\n\nVS Code conversation:\n`;
				await client.prompt(sessionId, prompt.some(part => part.type === "image")
					? [{ type: "text", text: prefix }, ...prompt]
					: prefix + prompt.map(part => part.type === "text" ? part.text : "").join(""));
			}, progress, token);
		} catch (error) {
			if (!sessionReady && !token.isCancellationRequested && generation === this.discoveryGeneration) {
				this.setStatus("unavailable", "Connection failed — check Snowflake / Azure sign-in", connection);
			}
			throw error;
		}
	}

	provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		value: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken
	): Thenable<number> {
		return Promise.resolve(estimateCocoTokens(value));
	}

	dispose(): void {
		this.disposed = true;
		this.discoveryGeneration++;
		this.stopDiscovery?.();
		for (const turn of this.activeTurns) { turn.bridge.dispose(); }
		for (const client of this.clients) {
			client.dispose();
		}
		this.clients.clear();
		this.changes.dispose();
		this.statusChanges.dispose();
	}

	private discover(): Promise<void> {
		if (this.disposed) {
			return Promise.resolve();
		}
		if (!this.enabled) {
			this.setStatus("disabled", "Off", this.resolveConnection());
			return Promise.resolve();
		}
		const executable = this.resolveCli();
		if (!executable) {
			this.setStatus("unconfigured", "Install Snowflake or configure the Coco CLI", this.resolveConnection());
			return Promise.resolve();
		}
		if (this.discovery) {
			return this.discovery;
		}
		const cacheMs = this.status.state === "connected" ? 10 * DISCOVERY_RETRY_MS : DISCOVERY_RETRY_MS;
		if (Date.now() - this.lastDiscoveryAt < cacheMs) {
			return Promise.resolve();
		}
		this.lastDiscoveryAt = Date.now();
		const generation = this.discoveryGeneration;
		const connection = this.resolveConnection();
		this.catalogSource = JSON.stringify([this.enabled, executable, connection]);
		const modelCount = this.status.modelCount;
		const timeoutMs = Math.max(1, this.dependencies.discoveryTimeoutMs ?? COCO_DISCOVERY_TIMEOUT_MS);
		let client: CocoAcpClient | undefined;
		let finished = false;
		let resolve!: () => void;
		const check = new Promise<void>(done => { resolve = done; });
		const finish = (state: "connected" | "unavailable", summary: string, count = modelCount): void => {
			if (finished) { return; }
			finished = true;
			clearTimeout(timer);
			if (generation === this.discoveryGeneration) {
				this.lastDiscoveryAt = Date.now();
				this.setStatus(state, summary, connection, count);
			}
			try { client?.dispose(); } catch { /* A cleanup failure must not keep the status check pending. */ }
			if (client) { this.clients.delete(client); }
			if (this.discoveryClient === client) { this.discoveryClient = undefined; }
			if (this.discovery === check) { this.discovery = undefined; this.stopDiscovery = undefined; this.acceptDiscovery = undefined; }
			resolve();
		};
		const timer = setTimeout(() => finish("unavailable",
			`Connection check timed out after ${Math.ceil(timeoutMs / 1_000)}s — retry or sign in to Snowflake`), timeoutMs);
		this.discovery = check;
		this.stopDiscovery = () => finish("unavailable", "Connection check cancelled — retry from Quick Access");
		this.acceptDiscovery = count => finish("connected", "Connected", count);
		this.setStatus("checking", "Starting Coco...", connection, modelCount);
		void (async () => {
			try {
				const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
				client = this.createClient(executable, cwd, connection, undefined);
				this.discoveryClient = client;
				this.clients.add(client);
				const initialized = await client.initialize();
				if (finished || generation !== this.discoveryGeneration) { return; }
				this.setStatus("checking", "Loading models from Snowflake...", connection, modelCount);
				const session = await client.newSession(cwd);
				if (finished || generation !== this.discoveryGeneration) { return; }
				if (typeof session.sessionId !== "string" || !session.sessionId) {
					throw new Error("Coco did not return an ACP session ID.");
				}
				const models = parseCocoModels(session);
				this.updateModels(models);
				this.updateThinking(parseCocoThinkingConfiguration(session));
				this.updateImageInput(initialized?.agentCapabilities?.promptCapabilities?.image === true);
				finish("connected", "Connected", models.length);
			} catch {
				finish("unavailable", "Connection failed — check Snowflake / Azure sign-in");
			}
		})();
		return check;
	}

	private setStatus(
		state: CocoProviderStatus["state"], summary: string,
		connection?: string, modelCount = 0
	): void {
		if (this.disposed) {
			return;
		}
		const next: CocoProviderStatus = {
			state, summary, connection, modelCount,
			checkedAt: state === "connected" || state === "unavailable" ? Date.now() : undefined,
		};
		if (JSON.stringify(next) !== JSON.stringify(this.status)) {
			this.status = next;
			this.statusChanges.fire(this.providerStatus);
		}
	}

	private updateModels(discovered: CocoModel[]): void {
		if (discovered.length === 0) {
			return;
		}
		const unique = new Map<string, CocoModel>([[AUTO_MODEL.id, AUTO_MODEL]]);
		for (const model of discovered) {
			unique.set(model.id, model);
		}
		const next = [...unique.values()];
		if (JSON.stringify(next) !== JSON.stringify(this.models)) {
			this.models = next;
			this.changes.fire();
		}
	}

	private updateThinking(thinking: CocoThinkingConfiguration | undefined): void {
		if (JSON.stringify(thinking) !== JSON.stringify(this.thinking)) {
			this.thinking = thinking;
			this.changes.fire();
		}
	}

	private updateImageInput(imageInput: boolean): void {
		if (imageInput !== this.imageInput) {
			this.imageInput = imageInput;
			this.changes.fire();
		}
	}

}