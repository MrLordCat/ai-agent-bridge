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
		if (!this.historyWarningShown) { console.warn("AI Agent Bridge: local handoff journal is unavailable; non-Coco providers continue with Chat-supplied messages."); this.historyWarningShown = true; }
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
		const selected = this.registry.resolve(model.id);
		this.registry.observeRequest(selected, token, options.modelOptions?._copilotConversationId);
		let history: Awaited<ReturnType<ConversationHistory["begin"]>> | undefined;
		try { history = await this.history?.begin(options.modelOptions?._copilotConversationId, messages); }
		catch (error) { if (selected.id === "coco") { throw error; } this.warnHistory(); }
		const emitted: vscode.LanguageModelResponsePart[] = [];
		let failed = false;
		let providerError: unknown;
		const responseOptions = selected.id === "coco" && history?.transcriptPath
			? { ...options, modelOptions: { ...options.modelOptions, _aabCocoTranscriptPath: history.transcriptPath } } : options;
		try { await selected.provider.provideLanguageModelChatResponse(
			model,
			selected.id === "coco" ? history?.messages ?? messages : messages,
			responseOptions,
			history ? { report: part => { emitted.push(part); progress.report(part); } } : progress,
			token
		); } catch (error) { failed = true; providerError = error; }
		try { await history?.complete(emitted); }
		catch (error) { if (selected.id === "coco" && !failed) { throw new Error("Cannot save the local Coco handoff transcript. Check workspace storage before reloading.", { cause: error }); } this.warnHistory(); }
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
