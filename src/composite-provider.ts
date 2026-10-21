import * as vscode from "vscode";

import type { ClaudeChatModelProvider } from "./claude/claude-provider";
import type { CocoChatModelProvider } from "./coco/coco-provider";
import { ProviderRegistry, ownsHttpModel, providerSourceId, type ChatProviderRegistration } from "./providers/provider-registry";
import type { ConversationHistory } from "./providers/conversation-history";

interface CompositeProviderOptions { providers: readonly ChatProviderRegistration[]; history: ConversationHistory }

/** Combines independent transports under the existing picker-compatible vendor. */
export class CompositeChatModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
	readonly registry: ProviderRegistry;
	readonly onDidChangeLanguageModelChatInformation: vscode.Event<void>;
	private readonly history?: ConversationHistory;
	private historyWarningShown = false;
	private warnHistory(): void {
				if (!this.historyWarningShown) { console.warn("AI Agent Bridge: local handoff journal is unavailable; providers without native handoff continue with Chat-supplied messages."); this.historyWarningShown = true; }
	}

	constructor(
		providers: vscode.LanguageModelChatProvider | readonly ChatProviderRegistration[] | CompositeProviderOptions,
		codexProvider?: vscode.LanguageModelChatProvider,
		claudeProvider?: ClaudeChatModelProvider,
		cocoProvider?: CocoChatModelProvider,
	) {
		const configured = !Array.isArray(providers) && "providers" in providers ? providers as CompositeProviderOptions : undefined;
		this.history = configured?.history;
		const registrations: readonly ChatProviderRegistration[] = configured?.providers ?? (Array.isArray(providers) ? providers : [
			{ id: "http", provider: providers as vscode.LanguageModelChatProvider, ownsModel: ownsHttpModel },
			...(codexProvider ? [{ id: "codex", provider: codexProvider, ownsModel: (id: string) => providerSourceId(id) === "codex" }] : []),
			...(claudeProvider ? [{ id: "claude", provider: claudeProvider, ownsModel: (id: string) => providerSourceId(id) === "claude", onForeignRequest: () => claudeProvider.refreshSubscriptionUsage() }] : []),
			...(cocoProvider ? [{ id: "coco", provider: cocoProvider, ownsModel: (id: string) => providerSourceId(id) === "coco", onForeignRequest: (id?: unknown) => cocoProvider.onForeignRequest(id) }] : []),
		]);
		this.registry = new ProviderRegistry(registrations);
		this.onDidChangeLanguageModelChatInformation = this.registry.onDidChange;
	}

	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		return this.registry.models(options, token);
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		// Current hosts send the native _conversationId; older Copilot patches use
		// _copilotConversationId. Normalize once before journaling and routing so
		// all providers keep the same durable keys across a host update.
		const usableId = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= 512;
		// A subagent runs under the parent chat's conversation id. Sharing it would
		// cancel the parent's pending tool turn, take over its native session and
		// overwrite its journal, so a subagent run stays ephemeral.
		if (usableId(options.modelOptions?._copilotSubagentInvocationId)) {
			options = { ...options, modelOptions: Object.fromEntries(Object.entries(options.modelOptions!)
				.filter(([key]) => key !== "_copilotConversationId" && key !== "_conversationId")) };
		}
		if (!usableId(options.modelOptions?._copilotConversationId) && usableId(options.modelOptions?._conversationId)) {
			options = { ...options, modelOptions: { ...options.modelOptions, _copilotConversationId: options.modelOptions!._conversationId } };
		}
		const selected = this.registry.resolve(model.id);
		this.registry.observeRequest(selected, token, options.modelOptions?._copilotConversationId);
		// Every adapter receives the same authoritative semantic history. Native
		// providers select their own continuation boundary AFTER this restoration.
		const usesHistory = Boolean(this.history);
		let history: Awaited<ReturnType<ConversationHistory["begin"]>> | undefined;
		try { history = await this.history?.begin(options.modelOptions?._copilotConversationId, messages); }
		catch (error) { if (usesHistory) { throw error; } this.warnHistory(); }
		const emitted: vscode.LanguageModelResponsePart[] = [];
		let failed = false;
		let providerError: unknown;
		const responseOptions = usesHistory && history?.transcriptPath
			? { ...options, modelOptions: { ...options.modelOptions, _aabCocoTranscriptPath: history.transcriptPath, _aabTranscriptPath: history.transcriptPath } } : options;
		try { await selected.provider.provideLanguageModelChatResponse(
			model,
			usesHistory ? history?.messages ?? messages : messages,
			responseOptions,
			history ? { report: part => { emitted.push(part); progress.report(part); } } : progress,
			token
		); } catch (error) { failed = true; providerError = error; }
		try { await history?.complete(emitted); }
		catch (error) { if (usesHistory && !failed) { throw new Error("Cannot save the local handoff transcript. Check workspace storage before reloading.", { cause: error }); } this.warnHistory(); }
		if (failed) { throw providerError; }
	}

	provideTokenCount(
		model: vscode.LanguageModelChatInformation,
		value: string | vscode.LanguageModelChatRequestMessage,
		token: vscode.CancellationToken
	): Thenable<number> {
		return this.registry.resolve(model.id).provider.provideTokenCount(model, value, token);
	}

	dispose(): void {
		this.registry.dispose();
	}
}
