import * as vscode from "vscode";

import type { ClaudeChatModelProvider } from "./claude/claude-provider";
import type { CocoChatModelProvider } from "./coco/coco-provider";
import { ProviderRegistry, ownsHttpModel, providerSourceId, type ChatProviderRegistration } from "./providers/provider-registry";
import type { ConversationHistory } from "./providers/conversation-history";
import { detectLimitError, formatLimitNotice, type LimitProvider, type LimitMatch } from "./providers/limit-errors";
import { detectBalanceError, formatBalanceNotice } from "./providers/balance-errors";
import { PROVIDER_SWITCH_OPTION } from "./providers/provider-switch";

interface CompositeProviderOptions { providers: readonly ChatProviderRegistration[]; history: ConversationHistory }
/** Maps an escaped provider error to a subscription limit, using the model id as the provider hint. */
function resolveLimit(modelId: string, error: unknown): LimitMatch | undefined {
	const hint: LimitProvider | undefined = modelId.startsWith("claude::") ? "claude" : modelId.startsWith("codex::") ? "codex" : undefined;
	return detectLimitError(error, hint);
}

function providerLabelForModel(modelId: string): string {
	const prefix = modelId.includes("::") ? modelId.slice(0, modelId.indexOf("::")) : "";
	return prefix === "deepseek" ? "DeepSeek"
		: prefix === "claude" ? "Claude"
			: prefix === "codex" ? "Codex"
				: prefix === "coco" ? "Coco"
					: prefix === "api" ? "Provider"
						: prefix && prefix !== "local" ? prefix.charAt(0).toUpperCase() + prefix.slice(1) : "Provider";
}
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
		// Native sessions predate another model's turns and compactions, so a switch always starts cold.
		const switchedFrom = history?.servedBy && history.servedBy !== model.id ? { [PROVIDER_SWITCH_OPTION]: history.servedBy } : {};
		const responseOptions = usesHistory && history?.transcriptPath
			? { ...options, modelOptions: { ...options.modelOptions, ...switchedFrom, _aabCocoTranscriptPath: history.transcriptPath, _aabTranscriptPath: history.transcriptPath } } : options;
		try { await selected.provider.provideLanguageModelChatResponse(
			model,
			usesHistory ? history?.messages ?? messages : messages,
			responseOptions,
			history ? { report: part => { emitted.push(part); progress.report(part); } } : progress,
			token
		); } catch (error) { failed = true; providerError = error; }
			if (failed) {
				// A subscription limit or an empty balance escapes as an error only when a provider
				// could not answer itself; the short notice keeps the host from retrying.
				const balance = detectBalanceError(providerError, providerLabelForModel(model.id));
				if (balance) {
					const notice = new vscode.LanguageModelTextPart(formatBalanceNotice(balance));
					emitted.push(notice); progress.report(notice);
					failed = false;
				}
				const limit = resolveLimit(model.id, providerError);
				if (limit) {
					const notice = new vscode.LanguageModelTextPart(formatLimitNotice(limit.provider, limit));
					emitted.push(notice); progress.report(notice);
					failed = false;
				}
			}
			// A request that failed before any output (an exhausted limit) did not take the chat over.
		try { await history?.complete(emitted, emitted.length > 0 || !failed ? model.id : undefined); }
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
