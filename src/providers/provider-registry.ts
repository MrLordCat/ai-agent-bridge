import * as vscode from "vscode";
import { parseProviderModelId } from "../model-sources/source-routing";

export interface ProviderSourceDefinition {
	id: string;
	label: string;
	description: string;
	kind: "local" | "deepseek" | "codex" | "claude" | "coco" | "api";
	mode: "http" | "subscription";
	enabledSetting: string;
}

export const BUILTIN_PROVIDER_SOURCES: readonly ProviderSourceDefinition[] = [
	{ id: "primary", label: "Local LLM", description: "Local model server", kind: "local", mode: "http", enabledSetting: "enableLocalServer" },
	{ id: "deepseek", label: "DeepSeek", description: "DeepSeek API", kind: "deepseek", mode: "http", enabledSetting: "enableDeepSeek" },
	{ id: "codex", label: "Codex", description: "ChatGPT subscription", kind: "codex", mode: "subscription", enabledSetting: "enableCodexSubscription" },
	{ id: "claude", label: "Claude", description: "Claude subscription", kind: "claude", mode: "subscription", enabledSetting: "enableClaudeSubscription" },
	{ id: "coco", label: "Coco", description: "Snowflake Cortex Code", kind: "coco", mode: "subscription", enabledSetting: "enableCoco" },
];

export const SUBSCRIPTION_PROVIDER_SOURCES = BUILTIN_PROVIDER_SOURCES.filter(source => source.mode === "subscription");

/** Persisted identifiers retain their format; all consumers use source identity. */
export function providerSourceId(modelId: string): string {
	return parseProviderModelId(modelId).sourceKey ?? "primary";
}

export function ownsHttpModel(modelId: string): boolean {
	const id = providerSourceId(modelId);
	return ["primary", "local", "deepseek"].includes(id) || id.startsWith("api-");
}

export interface ChatProviderRegistration {
	id: string;
	source?: ProviderSourceDefinition;
	provider: vscode.LanguageModelChatProvider;
	ownsModel(modelId: string): boolean;
	usesConversationHistory?: (model: vscode.LanguageModelChatInformation) => Promise<boolean>;
	/** Optional background observation of requests to another adapter. */
	onForeignRequest?: (conversationId?: unknown) => Promise<unknown>;
}

/** Routing, catalog ownership and change propagation share one registration list. */
export class ProviderRegistry implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly owners = new Map<string, ChatProviderRegistration>();
	private readonly subscriptions: vscode.Disposable[];
	readonly registrations: readonly ChatProviderRegistration[];
	get sources(): readonly ProviderSourceDefinition[] {
		return [
			...BUILTIN_PROVIDER_SOURCES.filter(source => source.mode === "http"),
			...this.registrations.flatMap(registration => {
				const source = registration.source ?? BUILTIN_PROVIDER_SOURCES.find(item => item.id === registration.id);
				return source ? [source] : [];
			}),
		];
	}

	constructor(registrations: readonly ChatProviderRegistration[]) {
		const ids = new Set<string>();
		for (const registration of registrations) {
			if (ids.has(registration.id)) { throw new Error(`Duplicate provider registration: ${registration.id}`); }
			ids.add(registration.id);
		}
		this.registrations = [...registrations];
		this.subscriptions = registrations.flatMap(registration => {
			const listener = registration.provider.onDidChangeLanguageModelChatInformation?.(() => {
				for (const [id, owner] of this.owners) { if (owner === registration) { this.owners.delete(id); } }
				this.changed.fire();
			});
			return listener ? [listener] : [];
		});
	}

	async models(options: { silent: boolean }, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
		const results = await Promise.allSettled(this.registrations.map(async registration => ({
			registration, models: await registration.provider.provideLanguageModelChatInformation(options, token) ?? [],
		})));
		const models = new Map<string, vscode.LanguageModelChatInformation>();
		const owners = new Map<string, ChatProviderRegistration>();
		for (const result of results) {
			if (result.status !== "fulfilled") { continue; }
			const { registration, models: catalog } = result.value;
			for (const model of catalog) {
				if (owners.has(model.id) && owners.get(model.id) !== registration) { throw new Error(`Model has multiple provider owners: ${model.id}`); }
				owners.set(model.id, registration); models.set(model.id, model);
			}
		}
		if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
		this.owners.clear(); for (const [id, owner] of owners) { this.owners.set(id, owner); }
		return [...models.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	resolve(modelId: string): ChatProviderRegistration {
		const known = this.owners.get(modelId);
		if (known) { return known; }
		const matches = this.registrations.filter(registration => registration.ownsModel(modelId));
		if (matches.length !== 1) { throw new Error(matches.length ? `Ambiguous model provider: ${modelId}` : `No registered provider owns model: ${modelId}`); }
		return matches[0];
	}

	observeRequest(selected: ChatProviderRegistration, token: vscode.CancellationToken, conversationId?: unknown): void {
		if (token.isCancellationRequested) { return; }
		for (const registration of this.registrations) {
			if (registration !== selected) { void registration.onForeignRequest?.(conversationId).catch(() => undefined); }
		}
	}

	dispose(): void { for (const subscription of this.subscriptions) { subscription.dispose(); } this.owners.clear(); this.changed.dispose(); }
}