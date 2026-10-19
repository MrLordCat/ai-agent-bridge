import * as assert from "node:assert";
import * as vscode from "vscode";
import { ProviderRegistry, ownsHttpModel, providerSourceId, type ProviderSourceDefinition } from "../providers/provider-registry";
import { CompositeChatModelProvider } from "../composite-provider";
import { ProviderDirectory } from "../providers/provider-directory";
import { groupProviderModels } from "../ui/provider-model-picker";

const token: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined) };
function adapter(id: string, fail = false): vscode.LanguageModelChatProvider {
	return {
		provideLanguageModelChatInformation: async () => { if (fail) { throw new Error("offline"); } return [{ id, name: id, family: "test", version: "1", maxInputTokens: 100, maxOutputTokens: 10, capabilities: {} }]; },
		provideLanguageModelChatResponse: async () => undefined,
		provideTokenCount: async () => 17,
	};
}
const custom: ProviderSourceDefinition = { id: "example", label: "Example", description: "Registered SDK", kind: "api", mode: "subscription", enabledSetting: "enableExample" };

suite("Provider registry contracts", () => {
	test("normalizes native conversation IDs before provider routing and foreign-session cancellation without mutating host options", async () => {
		const seen: unknown[] = [], foreign: unknown[] = [];
		const composite = new CompositeChatModelProvider([
			{ id: "http", ownsModel: () => true, provider: { ...adapter("primary::model"), provideLanguageModelChatResponse: async (_m, _messages, options) => { seen.push(options.modelOptions?._copilotConversationId); } } },
			{ id: "example", ownsModel: () => false, provider: adapter("example::model"), onForeignRequest: async id => { foreign.push(id); } },
		]);
		const cases: Record<string, unknown>[] = [
			{ _conversationId: "native-chat" }, { _conversationId: "native-chat", _copilotConversationId: "legacy-chat" },
			{ _conversationId: "native-chat", _copilotConversationId: " " }, { _conversationId: {} }, { _conversationId: "x".repeat(513) },
		];
		try {
			for (const modelOptions of cases) {
				const snapshot = JSON.stringify(modelOptions);
				await composite.provideLanguageModelChatResponse({ id: "primary::model" } as vscode.LanguageModelChatInformation, [],
					{ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions }, { report: () => undefined }, token);
				assert.strictEqual(JSON.stringify(modelOptions), snapshot);
			}
			assert.deepStrictEqual(seen, ["native-chat", "legacy-chat", "native-chat", undefined, undefined]);
			assert.deepStrictEqual(foreign, seen);
		} finally { composite.dispose(); }
	});
	test("registers a new transport without a branch in Composite or grouping", async () => {
		const composite = new CompositeChatModelProvider([{ id: custom.id, source: custom, provider: adapter("example::model"), ownsModel: id => providerSourceId(id) === custom.id }]);
		try {
			const models = await composite.provideLanguageModelChatInformation({ silent: true }, token);
			assert.strictEqual(await composite.provideTokenCount(models[0], "text", token), 17);
			await composite.provideLanguageModelChatResponse(models[0], [], { toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: () => undefined }, token);
			assert.strictEqual(groupProviderModels(models, [], composite.registry.sources)[0].label, "Example");
		} finally { composite.dispose(); }
	});
	test("keeps failed discovery isolated and rejects unknown or ambiguous routes", async () => {
		const registry = new ProviderRegistry([{ id: "http", provider: adapter("primary::model"), ownsModel: ownsHttpModel }, { id: "example", provider: adapter("example::model", true), ownsModel: id => providerSourceId(id) === "example" }]);
		try {
			assert.deepStrictEqual((await registry.models({ silent: true }, token)).map(model => model.id), ["primary::model"]);
			assert.strictEqual(registry.resolve("api-profile::model").id, "http");
			assert.throws(() => registry.resolve("unknown::model"), /No registered provider/);
			assert.throws(() => new ProviderRegistry([{ id: "same", provider: adapter("one"), ownsModel: () => true }, { id: "same", provider: adapter("two"), ownsModel: () => true }]), /Duplicate provider/);
		} finally { registry.dispose(); }
	});
	test("discovers status for a registered subscription source without provider-specific getters", async () => {
		const directory = new ProviderDirectory({ getSecret: async () => undefined, getApiProfiles: async () => [], getConfigValue: (_key, fallback) => fallback, getProviderSources: () => [custom], getSubscriptionStatuses: () => new Map([[custom.id, { state: "connected", summary: "Connected" }]]), probeIntervalMs: 0 });
		try { await directory.refresh(); assert.strictEqual(directory.stateOf(custom.id), "online"); } finally { directory.dispose(); }
	});
	test("invalidates catalog ownership when an adapter changes and disposes its subscriptions", async () => {
		const changed = new vscode.EventEmitter<void>(), implementation = { ...adapter("example::model"), onDidChangeLanguageModelChatInformation: changed.event };
		const registry = new ProviderRegistry([{ id: "example", provider: implementation, ownsModel: () => false }]);
		let updates = 0; registry.onDidChange(() => updates++);
		await registry.models({ silent: true }, token); assert.strictEqual(registry.resolve("example::model").id, "example");
		changed.fire(); assert.strictEqual(updates, 1); assert.throws(() => registry.resolve("example::model"), /No registered provider/);
		registry.dispose(); changed.fire(); assert.strictEqual(updates, 1); changed.dispose();
	});
});