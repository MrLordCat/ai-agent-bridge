import type * as vscode from "vscode";
import type { ChatModelSource } from "../model-sources/source-routing";
import { isCursorCloudAgentBase } from "../transport/openai-http";
import { CursorProfileTransport } from "../cursor/profile-transport";

export interface SourceDiscovery {
	token: vscode.CancellationToken;
	version: string;
	report(models: vscode.LanguageModelChatInformation[]): void;
	recordMaximum?: (key: string, maximum: number, reported: boolean) => void;
}
export interface SourceResponse {
	modelId: string; model: vscode.LanguageModelChatInformation;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	options: vscode.ProvideLanguageModelChatResponseOptions;
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	token: vscode.CancellationToken;
}
export interface ApiSourceAdapter extends vscode.Disposable {
	id: string;
	matches(source: ChatModelSource): boolean;
	discover(source: ChatModelSource, request: SourceDiscovery, fallback: () => Promise<void>): Promise<void>;
	respond(source: ChatModelSource, request: SourceResponse, fallback: () => Promise<void>): Promise<void>;
	countTokens(model: vscode.LanguageModelChatInformation, fallback: () => Promise<number>): Promise<number>;
	refresh(): void;
}

/** Runtime selection is independent of the source's saved identity and HTTP policies. */
export class ApiSourceRouter implements vscode.Disposable {
	private readonly modelOwners = new Map<string, ApiSourceAdapter>();
	constructor(private readonly adapters: readonly ApiSourceAdapter[] = [new CursorSourceAdapter()]) {}
	private adapter(source: ChatModelSource): ApiSourceAdapter | undefined {
		const matches = this.adapters.filter(adapter => adapter.matches(source));
		if (matches.length > 1) { throw new Error(`Ambiguous API transport for ${source.key}`); }
		return matches[0];
	}
	async discover(source: ChatModelSource, request: SourceDiscovery, http: () => Promise<void>): Promise<void> {
		const adapter = this.adapter(source);
		if (adapter) { await adapter.discover(source, { ...request, report: models => {
			for (const model of models) { this.modelOwners.set(model.id, adapter); }
			request.report(models);
		} }, http); } else { await http(); }
	}
	async respond(source: ChatModelSource, request: SourceResponse, http: () => Promise<void>): Promise<void> {
		const adapter = this.adapter(source);
		if (adapter) { await adapter.respond(source, request, http); } else { await http(); }
	}
	countTokens(model: vscode.LanguageModelChatInformation, fallback: () => Promise<number>): Promise<number> {
		const adapter = this.modelOwners.get(model.id);
		return adapter ? adapter.countTokens(model, fallback) : fallback();
	}
	refresh(): void { this.modelOwners.clear(); for (const adapter of this.adapters) { adapter.refresh(); } }
	dispose(): void { this.modelOwners.clear(); for (const adapter of this.adapters) { adapter.dispose(); } }
}

export class CursorSourceAdapter implements ApiSourceAdapter {
	readonly id = "cursor";
	constructor(private readonly transport = new CursorProfileTransport()) {}
	matches(source: ChatModelSource): boolean { return source.protocol === "cursor" || isCursorCloudAgentBase(source.serverUrl); }
	async discover(source: ChatModelSource, request: SourceDiscovery): Promise<void> {
		request.report(await this.transport.models(source, request.token, request.version, request.recordMaximum));
	}
	respond(source: ChatModelSource, request: SourceResponse): Promise<void> {
		return this.transport.respond(source, request.modelId, request.model, request.messages, request.options, request.progress, request.token);
	}
	countTokens(_model: vscode.LanguageModelChatInformation, fallback: () => Promise<number>): Promise<number> { return fallback(); }
	refresh(): void { this.transport.refresh(); }
	dispose(): void { this.transport.dispose(); }
}