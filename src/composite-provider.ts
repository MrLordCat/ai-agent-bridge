import * as vscode from "vscode";

import type { ClaudeChatModelProvider } from "./claude/claude-provider";
import type { CocoChatModelProvider } from "./coco/coco-provider";
import { ProviderRegistry, ownsHttpModel, providerSourceId, type ChatProviderRegistration } from "./providers/provider-registry";

/** Combines independent transports under the existing picker-compatible vendor. */
export class CompositeChatModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
	readonly registry: ProviderRegistry;
	readonly onDidChangeLanguageModelChatInformation: vscode.Event<void>;

	constructor(
		providers: vscode.LanguageModelChatProvider | readonly ChatProviderRegistration[],
		codexProvider?: vscode.LanguageModelChatProvider,
		claudeProvider?: ClaudeChatModelProvider,
		cocoProvider?: CocoChatModelProvider,
	) {
		const registrations: readonly ChatProviderRegistration[] = Array.isArray(providers) ? providers : [
			{ id: "http", provider: providers as vscode.LanguageModelChatProvider, ownsModel: ownsHttpModel },
			...(codexProvider ? [{ id: "codex", provider: codexProvider, ownsModel: (id: string) => providerSourceId(id) === "codex" }] : []),
			...(claudeProvider ? [{ id: "claude", provider: claudeProvider, ownsModel: (id: string) => providerSourceId(id) === "claude", onForeignRequest: () => claudeProvider.refreshSubscriptionUsage() }] : []),
			...(cocoProvider ? [{ id: "coco", provider: cocoProvider, ownsModel: (id: string) => providerSourceId(id) === "coco" }] : []),
		];
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
		this.registry.observeRequest(selected, token);
		await selected.provider.provideLanguageModelChatResponse(
			model,
			messages,
			options,
			progress,
			token
		);
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
