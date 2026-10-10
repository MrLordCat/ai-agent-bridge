import * as vscode from "vscode";

import { decodeCodexModelId } from "./codex/model-adapter";
import type { ClaudeChatModelProvider } from "./claude/claude-provider";
import { decodeClaudeModelId } from "./claude/message-adapter";
import { decodeCocoModelId } from "./coco/model-adapter";
import type { CocoChatModelProvider } from "./coco/coco-provider";

/** Combines independent transports under the existing picker-compatible vendor. */
export class CompositeChatModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
	private readonly modelChanges = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.modelChanges.event;
	private readonly subscriptions: vscode.Disposable[];

	constructor(
		private readonly defaultProvider: vscode.LanguageModelChatProvider,
		private readonly codexProvider: vscode.LanguageModelChatProvider,
		private readonly claudeProvider?: ClaudeChatModelProvider,
		private readonly cocoProvider?: CocoChatModelProvider
	) {
		this.subscriptions = [
			defaultProvider.onDidChangeLanguageModelChatInformation?.(() => this.modelChanges.fire()),
			codexProvider.onDidChangeLanguageModelChatInformation?.(() => this.modelChanges.fire()),
			claudeProvider?.onDidChangeLanguageModelChatInformation?.(() => this.modelChanges.fire()),
			cocoProvider?.onDidChangeLanguageModelChatInformation?.(() => this.modelChanges.fire()),
		].filter((value): value is vscode.Disposable => value !== undefined);
	}

	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		const results = await Promise.allSettled([
			this.defaultProvider.provideLanguageModelChatInformation(options, token),
			this.codexProvider.provideLanguageModelChatInformation(options, token),
			...(this.claudeProvider
				? [this.claudeProvider.provideLanguageModelChatInformation(options, token)]
				: []),
			...(this.cocoProvider
				? [this.cocoProvider.provideLanguageModelChatInformation(options, token)]
				: []),
		]);
		const all: vscode.LanguageModelChatInformation[] = [];
		for (const result of results) {
			if (result.status === "fulfilled") {
				all.push(...(await result.value ?? []));
			}
		}
		return all.sort((left, right) => left.name.localeCompare(right.name));
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const provider = this.selectProvider(model.id);
		if (this.claudeProvider && provider !== this.claudeProvider && !token.isCancellationRequested) {
			void this.claudeProvider.refreshSubscriptionUsage().catch(() => {
				// Keep other providers independent; Claude remains UNKNOWN until a live probe succeeds.
			});
		}
		await provider.provideLanguageModelChatResponse(
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
		return this.selectProvider(model.id).provideTokenCount(model, value, token);
	}

	dispose(): void {
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.modelChanges.dispose();
	}

	private selectProvider(modelId: string): vscode.LanguageModelChatProvider {
		if (decodeCodexModelId(modelId) !== undefined) {
			return this.codexProvider;
		}
		if (this.claudeProvider && decodeClaudeModelId(modelId) !== undefined) {
			return this.claudeProvider;
		}
		if (this.cocoProvider && decodeCocoModelId(modelId) !== undefined) {
			return this.cocoProvider;
		}
		return this.defaultProvider;
	}
}
