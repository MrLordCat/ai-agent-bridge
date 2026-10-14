import * as assert from "node:assert";
import * as vscode from "vscode";
import { ApiProviderService } from "../api-providers/api-provider-service";
import { LlamaCppChatModelProvider } from "../llama-provider";
import type { ChatModelSource } from "../model-sources/source-routing";
import { renderApiProviderManagerHtml } from "../ui/api-provider-manager";

function fixture() {
	const values = new Map<string, unknown>(), keys = new Map<string, string>();
	const changed = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
	const state = { get: (key: string, fallback?: unknown) => values.has(key) ? values.get(key) : fallback,
		update: async (key: string, value: unknown) => { values.set(key, value); }, keys: () => [...values.keys()] } as vscode.Memento;
	const secrets: vscode.SecretStorage = { get: async key => keys.get(key),
		store: async (key, value) => { keys.set(key, value); }, delete: async key => { keys.delete(key); },
		keys: async () => [...keys.keys()], onDidChange: changed.event };
	const service = new ApiProviderService(state, secrets);
	return { service, secrets, dispose: () => { service.dispose(); changed.dispose(); } };
}

suite("Provider automatic and working context", () => {
	test("discovers a maximum independently of the working cap and retains credentials on slider changes", async () => {
		const f = fixture();
		try {
			const profile = await f.service.upsert({ name: "Gateway", baseUrl: "https://gateway.example/v1" }, { apiKey: "test-key" });
			assert.strictEqual(profile.contextLength, undefined);
			assert.strictEqual((await f.service.getModelSources())[0].contextLengthOverride, undefined);
			f.service.recordContextMaximum(`api-${profile.id}`, 1_000_000, true);
			await f.service.setWorkingContextLength(profile.id, 500_000);
			assert.strictEqual((await f.service.getModelSources())[0].workingContextLength, 500_000);
			assert.strictEqual((await f.service.listSummaries())[0].maximumContextLength, 1_000_000);
			await f.service.upsert({ id: profile.id, name: "Renamed", baseUrl: profile.baseUrl });
			assert.strictEqual(f.service.get(profile.id)?.contextLength, 500_000, "editing the provider must keep the slider choice");
			await f.service.setWorkingContextLength(profile.id, 2_000_000);
			assert.strictEqual(f.service.get(profile.id)?.contextLength, 1_000_000);
			await f.service.setWorkingContextLength(profile.id, null);
			assert.strictEqual(f.service.get(profile.id)?.contextLength, undefined);
			assert.strictEqual(await f.service.getApiKey(profile.id), "test-key");
			f.service.recordContextMaximum(`api-${profile.id}`, 2_000_000, true);
			await f.service.setWorkingContextLength(profile.id, 1_500_000);
			assert.strictEqual(f.service.get(profile.id)?.contextLength, 1_500_000);
			assert.strictEqual((await f.service.listSummaries())[0].maximumContextLength, 2_000_000);
		} finally { f.dispose(); }
	});

	test("caps each model without overwriting its reported maximum or exceeding a smaller model window", () => {
		const f = fixture();
		const reported: number[] = [];
		const provider = new LlamaCppChatModelProvider(f.secrets, "test", undefined, undefined, undefined, undefined, undefined,
			(_source, maximum) => reported.push(maximum));
		const methods = provider as unknown as {
			resolveModelContextLength: (model: { id: string; contextLength: number }, runtime: number | undefined, source: ChatModelSource) => number;
			publishApiContextMaximum: (models: Array<{ id: string; contextLength: number }>, source: ChatModelSource) => void;
		};
		const source: ChatModelSource = { key: "api-test", label: "Gateway", serverUrl: "https://gateway.example/v1", workingContextLength: 500_000 };
		try {
			const model = { id: "test-model", contextLength: 1_000_000 };
			assert.strictEqual(methods.resolveModelContextLength(model, undefined, source), 500_000);
			methods.publishApiContextMaximum([model], source);
			assert.deepStrictEqual(reported, [1_000_000]);
			assert.strictEqual(methods.resolveModelContextLength({ id: "large-model", contextLength: 2_000_000 }, undefined,
				{ ...source, workingContextLength: 1_500_000 }), 1_500_000);
			assert.strictEqual(methods.resolveModelContextLength({ id: "smaller-model", contextLength: 128_000 }, undefined, source), 128_000);
			assert.strictEqual(methods.resolveModelContextLength({ id: "deepseek-model", contextLength: 32_768 }, undefined, { ...source, familyOverride: "deepseek" }), 32_768);
		} finally { f.dispose(); }
	});

	test("offers the working slider after creation while the add form asks for no maximum", async () => {
		const f = fixture();
		try {
			const profile = await f.service.upsert({ name: "Gateway", baseUrl: "https://gateway.example/v1" });
			f.service.recordContextMaximum(`api-${profile.id}`, 1_000_000, true);
			await f.service.setWorkingContextLength(profile.id, 500_000);
			const html = renderApiProviderManagerHtml({ profiles: await f.service.listSummaries(), providers: [], editingId: "new" });
			assert.ok(!html.includes("provider-context"));
			assert.match(html, /type="range" min="4096" max="1000000" step="1" value="500000"/);
			assert.match(html, /Use automatic context/);
		} finally { f.dispose(); }
	});
});