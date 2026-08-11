import * as assert from "node:assert";
import {
	createModelSources,
	encodeProviderModelId,
	parseProviderModelId,
	resolveModelFamily,
} from "../model-sources/source-routing";

suite("model source routing", () => {
	test("round-trips provider model ids and resolves model families", () => {
		const id = encodeProviderModelId("local", "Qwen3-Coder.gguf");
		assert.strictEqual(id, "local::Qwen3-Coder.gguf");
		assert.deepStrictEqual(parseProviderModelId(id), { sourceKey: "local", modelId: "Qwen3-Coder.gguf" });
		assert.strictEqual(resolveModelFamily("Qwen3-Coder.gguf", "auto", "llama"), "qwen");
		assert.strictEqual(resolveModelFamily("anything", "deepseek", "auto"), "deepseek");
		assert.strictEqual(resolveModelFamily("gpt-5", "auto", "llama"), "openai");
	});

	test("keeps local and DeepSeek sources available without duplicate endpoints", () => {
		const sources = createModelSources({
			primaryServerUrl: "http://localhost:9000/",
			primaryApiKey: "primary",
			deepSeekApiKey: "deepseek",
			localEnabled: true,
			localServerUrl: "http://localhost:8000/",
			localContextLength: 131072,
			deepSeekEnabled: true,
			deepSeekContextLength: 258400,
		});

		assert.deepStrictEqual(sources.map(source => source.key), ["primary", "local", "deepseek"]);
		assert.strictEqual(sources[1].serverUrl, "http://localhost:8000");
		assert.strictEqual(sources[1].contextLengthFallback, 131072);
		assert.strictEqual(sources[2].contextLengthOverride, 258400);
		assert.strictEqual(sources[2].protocol, "deepseek");
	});

	test("does not advertise one URL twice", () => {
		const sources = createModelSources({
			primaryServerUrl: "http://localhost:8000",
			localEnabled: true,
			localServerUrl: "http://localhost:8000/",
			localContextLength: 65536,
			deepSeekEnabled: false,
			deepSeekContextLength: 258400,
		});

		assert.strictEqual(sources.length, 1);
		assert.strictEqual(sources[0].key, "primary");
	});

	test("keeps multiple API profiles on one endpoint isolated by source key", () => {
		const sources = createModelSources({
			primaryServerUrl: "http://localhost:8000",
			localEnabled: false,
			localServerUrl: "http://localhost:8000",
			localContextLength: 65536,
			deepSeekEnabled: false,
			deepSeekContextLength: 258400,
			apiSources: [
				{
					key: "api-account-a",
					label: "Account A",
					serverUrl: "https://openrouter.ai/api/v1/",
					apiKey: "a",
					protocol: "openai",
				},
				{
					key: "api-account-b",
					label: "Account B",
					serverUrl: "https://openrouter.ai/api/v1",
					apiKey: "b",
					protocol: "openai",
				},
			],
		});

		assert.deepStrictEqual(
			sources.map(source => source.key),
			["primary", "api-account-a", "api-account-b"]
		);
		assert.strictEqual(sources[2].serverUrl, "https://openrouter.ai/api/v1");
	});
});
