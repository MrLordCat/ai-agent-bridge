import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { encodeProviderModelId, type ChatModelSource } from "../model-sources/source-routing";
import { CursorApiClient, CursorApiError, type CursorModel, type CursorParameter, type CursorPrompt, type CursorSelection } from "./api-client";
import { CursorSdkTransport } from "./sdk-transport";
import { cursorModelParameters, cursorReasoningOption, cursorReasoningParameter, cursorReasoningSchema } from "./model-configuration";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const positive = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 4096 ? Math.floor(value) : undefined;
const contextValue = (value: string): number | undefined => {
	const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(value);
	return match ? positive(Number(match[1]) * (match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1000 : 1)) : undefined;
};
const contextParameter = (id: string): boolean => /context|window/i.test(id);
function contextSelection(parameter: CursorParameter, target: number): string | undefined {
	const candidates = parameter.values.filter(item => contextValue(item.value)).sort((a, b) => contextValue(a.value)! - contextValue(b.value)!);
	return candidates.find(item => contextValue(item.value)! >= target)?.value ?? candidates.at(-1)?.value;
}

export function cursorContextMaximum(model: CursorModel): number | undefined {
	const candidates = [model.contextWindow, model.context_window, model.context_length].flatMap(value => positive(value) ?? []);
	for (const parameter of model.parameters ?? []) {
		if (contextParameter(parameter.id)) { candidates.push(...parameter.values.flatMap(item => contextValue(item.value) ?? [])); }
	}
	return candidates.length ? Math.max(...candidates) : undefined;
}

interface Catalog { identity: string; fetchedAt: number; models: CursorModel[] }
interface Session { agentId: string; identity: string; hashes: string[] }

/** Per-profile Cloud Agents transport; registration stays in the API provider. */
export class CursorProfileTransport implements vscode.Disposable {
	private readonly catalogs = new Map<string, Catalog>();
	private readonly sessions = new Map<string, Session>();
	private readonly busy = new Set<string>();
	private readonly requests = new Set<AbortController>();
	constructor(
		private readonly clientFactory = (source: ChatModelSource): CursorApiClient => new CursorApiClient(source.apiKey!, source.serverUrl),
		private readonly sdk: CursorSdkTransport | null = new CursorSdkTransport(),
	) {}

	refresh(): void {
		this.sdk?.refresh();
		this.catalogs.clear();
		for (const request of this.requests) { request.abort(); }
	}
	dispose(): void {
		this.sdk?.dispose();
		for (const request of this.requests) { request.abort(); }
		this.catalogs.clear(); this.sessions.clear();
	}

	private identity(source: ChatModelSource): string {
		if (!source.apiKey) { throw new Error("Cursor needs an API key saved in this profile in Providers Manager."); }
		return digest(JSON.stringify([source.key, source.serverUrl, source.apiKey]));
	}

	private async catalog(source: ChatModelSource, token: vscode.CancellationToken): Promise<CursorModel[]> {
		const identity = this.identity(source), cached = this.catalogs.get(source.key);
		if (cached?.identity === identity && Date.now() - cached.fetchedAt < 300_000) { return cached.models; }
		const controller = new AbortController(); this.requests.add(controller);
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
			const models = await this.clientFactory(source).listModels(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
			if (!models.length) { throw new Error("Cursor returned no models for this API key."); }
			this.catalogs.set(source.key, { identity, models, fetchedAt: Date.now() });
			return models;
		} finally { cancellation.dispose(); this.requests.delete(controller); }
	}

	async models(source: ChatModelSource, token: vscode.CancellationToken, version: string, recordMaximum?: (key: string, maximum: number, reported: boolean) => void): Promise<vscode.LanguageModelChatInformation[]> {
		const catalog = await this.catalog(source, token);
		const observed = catalog.flatMap(model => cursorContextMaximum(model) ?? []);
		const maximum = observed.length ? Math.max(...observed) : source.contextLengthFallback ?? 131_072;
		recordMaximum?.(source.key, maximum, observed.length > 0);
		return catalog.map(model => {
			const context = Math.min(cursorContextMaximum(model) ?? maximum, source.workingContextLength ?? Number.MAX_SAFE_INTEGER);
			const output = Math.min(32_768, Math.floor(context / 4));
			const defaults = model.variants?.find(variant => variant.isDefault)?.params ?? [];
			const parameters = cursorModelParameters(model);
			const reasoning = cursorReasoningParameter(parameters);
			const properties: Record<string, unknown> = Object.fromEntries(parameters.filter(parameter => parameter.id !== reasoning?.id).map(parameter => [parameter.id, {
				type: "string", title: parameter.displayName ?? parameter.id,
				enum: parameter.values.map(item => item.value),
				default: (contextParameter(parameter.id) ? contextSelection(parameter, context) : undefined) ?? defaults.find(item => item.id === parameter.id)?.value ?? parameter.values[0]?.value,
			}]));
			const info: vscode.LanguageModelChatInformation & { configurationSchema?: unknown; isUserSelectable?: boolean } = {
				id: encodeProviderModelId(source.key, model.id), name: `${model.displayName ?? model.id} (${source.label})`,
				family: "cursor", version, maxInputTokens: context - output, maxOutputTokens: output,
				capabilities: { toolCalling: this.sdk?.available ?? false, imageInput: true }, isUserSelectable: true,
				tooltip: this.sdk?.available ? "Cursor with native VS Code tools through the local SDK bridge. Models run on Cursor's servers." : "Cursor chat. Tools require a supported platform and Node.js 22.13 or newer in VS Code.",
			};
			if (reasoning) { properties.reasoningEffort = cursorReasoningSchema(reasoning, model); }
			if (Object.keys(properties).length) { info.configurationSchema = { type: "object", properties }; }
			return info;
		});
	}

	async respond(source: ChatModelSource, modelId: string, model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
		if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
		const descriptor = (await this.catalog(source, token)).find(item => item.id === modelId);
		if (!descriptor) { throw new Error("This model is absent from the Cursor profile's current catalog. Refresh the models."); }
		const selection: CursorSelection = { id: modelId, params: [...(descriptor.variants?.find(variant => variant.isDefault)?.params ?? [])] };
		const parameters = cursorModelParameters(descriptor);
		const reasoning = cursorReasoningParameter(parameters);
		for (const parameter of parameters) {
			let value = parameter.id === reasoning?.id ? cursorReasoningOption(options.modelOptions, parameter.id) : options.modelOptions?.[parameter.id];
			if (value === undefined && contextParameter(parameter.id)) {
				const target = source.workingContextLength ?? model.maxInputTokens + model.maxOutputTokens;
				value = contextSelection(parameter, target);
			}
			if (value === undefined) { continue; }
			if (typeof value !== "string" || !parameter.values.some(item => item.value === value)) { throw new Error(`Unsupported Cursor parameter: ${parameter.id}. Choose a value from the model settings.`); }
			selection.params = selection.params!.filter(item => item.id !== parameter.id).concat({ id: parameter.id, value });
		}
		if (this.sdk?.available) {
			const windows = selection.params!.filter(item => contextParameter(item.id)).flatMap(item => contextValue(item.value) ?? []);
			const budget = Math.min(model.maxInputTokens, ...windows.map(window => Math.max(1024, window - model.maxOutputTokens)));
			await this.sdk.respond(source, selection, () => cursorPrompt(messages, budget * 3), messages, options, progress, token);
			return;
		}
		if (options.toolMode === vscode.LanguageModelChatToolMode.Required || options.tools?.length) { throw new Error("Cursor tools require Node.js 22.13 or newer and a supported SDK platform in VS Code. Chat remains available in Ask mode."); }
		const conversation = options.modelOptions?._copilotConversationId;
		const sessionKey = typeof conversation === "string" && conversation ? JSON.stringify([source.key, conversation]) : undefined;
		const identity = digest(this.identity(source) + JSON.stringify(selection));
		const hashes = messages.map(message => digest(JSON.stringify(message)));
		const existing = sessionKey ? this.sessions.get(sessionKey) : undefined;
		const reuse = existing?.identity === identity && existing.hashes.length < hashes.length && existing.hashes.every((hash, index) => hash === hashes[index]);
		if (sessionKey && this.busy.has(sessionKey)) { throw new Error("A Cursor run is already active in this conversation."); }
		if (sessionKey) { this.busy.add(sessionKey); }
		const client = this.clientFactory(source), controller = new AbortController();
		this.requests.add(controller);
		const cancellation = token.onCancellationRequested(() => controller.abort());
		let agentId: string | undefined, runId: string | undefined, finished = false, text = "";
		try {
			const incoming = reuse ? messages.slice(existing!.hashes.length).filter(message => message.role === vscode.LanguageModelChatMessageRole.User) : messages;
			const selectedWindows = selection.params!.filter(item => contextParameter(item.id)).flatMap(item => contextValue(item.value) ?? []);
			const inputBudget = Math.min(model.maxInputTokens, ...selectedWindows.map(window => Math.max(1024, window - model.maxOutputTokens)));
			const prompt = cursorPrompt(incoming, inputBudget * 3);
			if (reuse) {
				agentId = existing!.agentId;
				runId = (await client.createRun(agentId, prompt, controller.signal)).id;
			} else {
				const created = await client.createAgent(prompt, selection, controller.signal);
				agentId = created.agent.id; runId = created.run.id;
			}
			const complete = (status: unknown, result: unknown): void => {
				if (status !== "FINISHED") { throw new Error(`Cursor run ended with status ${String(status)}.`); }
				if (typeof result === "string" && result && !text.endsWith(result)) { progress.report(new vscode.LanguageModelTextPart((text ? "\n\n" : "") + result)); text += result; }
				finished = true;
			};
			try {
				for await (const event of client.streamRun(agentId, runId, controller.signal)) {
					if (event.type === "assistant" && typeof event.data.text === "string") { text += event.data.text; progress.report(new vscode.LanguageModelTextPart(event.data.text)); }
					if (event.type === "thinking" && typeof event.data.text === "string") { cursorThinking(progress, event.data.text, runId); }
					if (event.type === "tool_call") { cursorThinking(progress, `Cursor: ${String(event.data.name)} (${String(event.data.status)})\n`, runId); }
					if (event.type === "result") { complete(event.data.status, event.data.text); }
					if (event.type === "error") { throw new Error("Cursor reported a stream error."); }
				}
			} catch (error) {
				if (!(error instanceof CursorApiError && error.status === 410)) { throw error; }
			}
			if (!finished) { const run = await client.getRun(agentId, runId, controller.signal); complete(run.status, run.result); }
			if (!text) { throw new Error("Cursor completed without an answer."); }
			if (sessionKey) {
				this.sessions.delete(sessionKey); this.sessions.set(sessionKey, { agentId, identity, hashes });
				while (this.sessions.size > 32) { this.sessions.delete(this.sessions.keys().next().value!); }
			}
		} catch (error) {
			if (sessionKey) { this.sessions.delete(sessionKey); }
			if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
			throw error;
		} finally {
			cancellation.dispose(); this.requests.delete(controller);
			if (sessionKey) { this.busy.delete(sessionKey); }
			if (agentId && runId && !finished) { await client.cancelRun(agentId, runId).catch(() => { /* Best effort after a failed or cancelled stream. */ }); }
		}
	}
}

export function cursorPrompt(messages: readonly vscode.LanguageModelChatRequestMessage[], maximumChars: number): CursorPrompt {
	const blocks: string[] = [], images: NonNullable<CursorPrompt["images"]> = [];
	for (const message of messages) {
		const parts: string[] = [];
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) { parts.push(part.value); }
			else if (part instanceof vscode.LanguageModelToolCallPart) { parts.push(`[Previous tool call: ${part.name}] ${JSON.stringify(part.input)}`); }
			else if (part instanceof vscode.LanguageModelToolResultPart) { parts.push(`[Previous tool result: ${part.callId}] ` + part.content.filter(item => item instanceof vscode.LanguageModelTextPart).map(item => (item as vscode.LanguageModelTextPart).value).join("\n")); }
			else if (part instanceof vscode.LanguageModelDataPart) {
				if (!/^image\/(png|jpeg|gif|webp)$/.test(part.mimeType)) { throw new Error(`Cursor does not support attachment type ${part.mimeType}.`); }
				if (part.data.byteLength > 15 * 1024 * 1024) { throw new Error("Cursor accepts images up to 15 MB each."); }
				images.push({ data: Buffer.from(part.data).toString("base64"), mimeType: part.mimeType });
			}
		}
		if (parts.length) { blocks.push(`${message.role === vscode.LanguageModelChatMessageRole.User ? "User" : "Assistant"}:\n${parts.join("\n")}`); }
	}
	if (images.length > 5) { throw new Error("Cursor accepts at most five images per prompt."); }
	if (!blocks.length) { blocks.push("Please respond to the attached images."); }
	const latest = blocks.at(-1)!;
	if (latest.length > maximumChars) { throw new Error("The latest message exceeds the Cursor working context. Increase the profile's context slider or shorten the message."); }
	while (blocks.length > 1 && blocks.join("\n\n").length > maximumChars) { blocks.shift(); }
	return { text: blocks.join("\n\n"), ...(images.length ? { images } : {}) };
}

function cursorThinking(progress: vscode.Progress<vscode.LanguageModelResponsePart>, text: string, id: string): void {
	const ThinkingCtor = (vscode as unknown as Record<string, unknown>)["LanguageModelThinkingPart"] as (new (value: string, id?: string) => vscode.LanguageModelResponsePart) | undefined;
	if (ThinkingCtor) { progress.report(new ThinkingCtor(text, id)); }
}