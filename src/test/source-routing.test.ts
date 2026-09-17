import * as assert from "node:assert";
import {
	createModelSources,
	encodeProviderModelId,
	isDeepSeekVisionModel,
	isLoopbackServerUrl,
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

	test("marks only DeepSeek Flash-family models as vision-capable", () => {
		// Verified 2026-09-15 against https://api-docs.deepseek.com/quick_start/pricing:
		// deepseek-flash -> Vision, deepseek-v4-pro -> Not supported.
		assert.strictEqual(isDeepSeekVisionModel("deepseek-flash"), true);
		assert.strictEqual(isDeepSeekVisionModel("deepseek-v4-flash"), true);
		assert.strictEqual(isDeepSeekVisionModel("deepseek-v4-flash-vision-exp"), true);
		assert.strictEqual(isDeepSeekVisionModel("deepseek-v4-pro"), false);
		assert.strictEqual(isDeepSeekVisionModel("deepseek-chat"), false);
		assert.strictEqual(isDeepSeekVisionModel("deepseek-reasoner"), false);
		assert.strictEqual(isDeepSeekVisionModel(""), false);
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

	test("hides primary source when local is disabled", () => {
		const sources = createModelSources({
			primaryServerUrl: "http://localhost:8000",
			localEnabled: false,
			localServerUrl: "http://localhost:8000",
			localContextLength: 65536,
			deepSeekEnabled: false,
			deepSeekContextLength: 258400,
		});

		assert.strictEqual(sources.length, 0);
	});

	test("recognises loopback server URLs only", () => {
		assert.strictEqual(isLoopbackServerUrl("http://localhost:8000"), true);
		assert.strictEqual(isLoopbackServerUrl("http://127.0.0.1:8080/v1"), true);
		assert.strictEqual(isLoopbackServerUrl("http://127.1.2.3:9000"), true);
		assert.strictEqual(isLoopbackServerUrl("http://[::1]:8000"), true);
		assert.strictEqual(isLoopbackServerUrl("localhost:8000"), true);
		assert.strictEqual(isLoopbackServerUrl("https://api.nodividin.ee/v1"), false);
		assert.strictEqual(isLoopbackServerUrl("https://api.deepseek.com"), false);
		// Private LAN addresses are treated as remote so a configured server is
		// never silently dropped.
		assert.strictEqual(isLoopbackServerUrl("http://192.168.1.50:8000"), false);
	});

	test("keeps a remote primary while the local source is disabled", () => {
		// Regression: gating the primary on localEnabled alone silently removed
		// explicitly configured remote OpenAI-compatible servers.
		const sources = createModelSources({
			primaryServerUrl: "https://api.nodividin.ee/v1",
			primaryApiKey: "remote-key",
			localEnabled: false,
			localServerUrl: "http://localhost:8000",
			localContextLength: 65536,
			deepSeekEnabled: false,
			deepSeekContextLength: 258400,
		});

		assert.deepStrictEqual(sources.map(source => source.key), ["primary"]);
		assert.strictEqual(sources[0].serverUrl, "https://api.nodividin.ee/v1");
		assert.strictEqual(sources[0].apiKey, "remote-key");
	});

	test("hides a primary that mirrors the disabled local server only when it is loopback", () => {
		// Same URL as the local source but reached over a non-loopback host:
		// the primary is an explicit remote endpoint and must survive.
		const remote = createModelSources({
			primaryServerUrl: "http://192.168.1.50:8000",
			localEnabled: false,
			localServerUrl: "http://192.168.1.50:8000",
			localContextLength: 65536,
			deepSeekEnabled: false,
			deepSeekContextLength: 258400,
		});
		assert.deepStrictEqual(remote.map(source => source.key), ["primary"]);

		// Loopback primary: this is the on-machine server, so it stays hidden.
		const loopback = createModelSources({
			primaryServerUrl: "http://127.0.0.1:8000",
			localEnabled: false,
			localServerUrl: "http://localhost:8000",
			localContextLength: 65536,
			deepSeekEnabled: false,
			deepSeekContextLength: 258400,
		});
		assert.deepStrictEqual(loopback.map(source => source.key), []);
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
			["api-account-a", "api-account-b"]
		);
		assert.strictEqual(sources[1].serverUrl, "https://openrouter.ai/api/v1");
	});
});
