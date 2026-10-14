import * as assert from "node:assert";
import { getChatCompletionsEndpoint, getModelCatalogEntries, isCursorCloudAgentBase } from "../transport/openai-http";
import { ProviderDirectory } from "../providers/provider-directory";

suite("Provider catalog compatibility", () => {
	test("reads items catalogs without losing existing data, models and result envelopes", () => {
		const models = [{ id: "test-model", context_window: 1_000_000 }];
		for (const key of ["data", "models", "result", "items"]) {
			assert.deepStrictEqual(getModelCatalogEntries({ [key]: models }), models);
		}
		assert.deepStrictEqual(getModelCatalogEntries({ data: [], items: models }), models);
		assert.deepStrictEqual(getModelCatalogEntries({ error: "not a model catalog" }), []);
	});

	test("keeps official Cursor Cloud Agents separate from ordinary compatible gateways", () => {
		assert.ok(isCursorCloudAgentBase("https://api.cursor.com/v1"));
		assert.throws(() => getChatCompletionsEndpoint("https://api.cursor.com/v1"), /Cloud Agents/);
		assert.ok(!isCursorCloudAgentBase("https://gateway.example/cursor/v1"));
		assert.strictEqual(getChatCompletionsEndpoint("https://gateway.example/cursor/v1"), "https://gateway.example/cursor/v1/chat/completions");
	});

	 test("probes Cursor through the saved profile without a separate builtin entry", async () => {
		const directory = new ProviderDirectory({
			getSecret: async () => undefined,
			getConfigValue: (_key, fallback) => fallback,
			getApiProfiles: async () => [{ id: "cursor-test", name: "Cursor", baseUrl: "https://api.cursor.com/v1", enabled: true, hasApiKey: true }],
			getApiProfileKey: async () => "test-key",
			probeHttp: async () => ({ ok: true }), probeIntervalMs: 0,
		});
		try {
			await directory.recheck();
			const entry = directory.list().find(item => item.key === "api-cursor-test");
			assert.strictEqual(entry?.state, "online");
			assert.ok(!directory.list().some(item => item.key === "cursor"));
		} finally { directory.dispose(); }
	});
});