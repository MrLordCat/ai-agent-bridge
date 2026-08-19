import * as assert from "node:assert";
import {
	getChatCompletionsEndpoint,
	getModelsEndpoint,
	isCloudflareWorkersAiBase,
	pickModelCatalogId,
	normalizeProviderBaseUrl,
	isTransientHttpStatus,
	OpenAIHttpTransport,
	parseRetryAfterMs,
} from "../transport/openai-http";

	test("pickModelCatalogId prefers the canonical name for Cloudflare items", () => {
		const cloudflare = "https://api.cloudflare.com/client/v4/accounts/abc/ai/v1";
		assert.strictEqual(
				pickModelCatalogId({ id: "fe8904cf-e20e-4884-b829-ed7cec0a01cb", name: "@cf/pipecat-ai/smart-turn-v2" }, cloudflare),
				"@cf/pipecat-ai/smart-turn-v2"
		);
		assert.strictEqual(pickModelCatalogId({ id: "fe8904cf-...", name: "  " }, cloudflare), undefined);
		assert.strictEqual(
				pickModelCatalogId({ id: "deepseek-chat" }, "https://api.deepseek.com"),
				"deepseek-chat"
		);
		assert.strictEqual(
				pickModelCatalogId({ model: "gpt-4o", name: "GPT-4o" }, "https://api.openai.com/v1"),
				"gpt-4o"
		);
	});

	test("normalizes user-supplied provider base URLs", () => {
		assert.strictEqual(normalizeProviderBaseUrl("https://openrouter.ai/api/v1/chat/completions"), "https://openrouter.ai/api/v1");
		assert.strictEqual(normalizeProviderBaseUrl("https://openrouter.ai/api/v1/chat/completions/"), "https://openrouter.ai/api/v1");
		assert.strictEqual(normalizeProviderBaseUrl("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1");
		assert.strictEqual(normalizeProviderBaseUrl("https://api.deepseek.com/v1/chat/completions"), "https://api.deepseek.com/v1");
		assert.strictEqual(normalizeProviderBaseUrl("https://api.deepseek.com"), "https://api.deepseek.com");
		assert.strictEqual(normalizeProviderBaseUrl("http://localhost:8000/chat/completions"), "http://localhost:8000");
		assert.strictEqual(normalizeProviderBaseUrl("  https://host/api/v1/chat/completions  "), "https://host/api/v1");
	});

suite("OpenAI HTTP transport", () => {
	test("resolves Cloudflare AI Gateway and Workers AI endpoints", () => {
		const gateway = "https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/openai";
		assert.strictEqual(getChatCompletionsEndpoint(gateway), "https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/openai/chat/completions");
		assert.strictEqual(getModelsEndpoint(gateway), "https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/openai/models");
		const workersAi = "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1";
		assert.strictEqual(getChatCompletionsEndpoint(workersAi), "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1/chat/completions");
		// Cloudflare Workers AI has no OpenAI-style GET /models: the catalog
		// endpoint /ai/models/search is used for probing and listing instead.
		assert.strictEqual(
				getModelsEndpoint(workersAi),
				"https://api.cloudflare.com/client/v4/accounts/abc123/ai/models/search?per_page=100"
		);
		assert.strictEqual(isCloudflareWorkersAiBase(workersAi), true);
		assert.strictEqual(isCloudflareWorkersAiBase("https://gateway.ai.cloudflare.com/v1/abc/my-gateway/openai"), false);
		// The full chat URL normalizes to the base.
		assert.strictEqual(
				normalizeProviderBaseUrl("https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/openai/chat/completions"),
				"https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/openai"
		);
	});

	test("resolves local and DeepSeek endpoints", () => {
		assert.strictEqual(getChatCompletionsEndpoint("http://localhost:8000"), "http://localhost:8000/v1/chat/completions");
		assert.strictEqual(getModelsEndpoint("http://localhost:8000"), "http://localhost:8000/v1/models");
		assert.strictEqual(getChatCompletionsEndpoint("https://api.deepseek.com"), "https://api.deepseek.com/chat/completions");
		assert.strictEqual(getModelsEndpoint("https://api.deepseek.com"), "https://api.deepseek.com/models");
		assert.strictEqual(getChatCompletionsEndpoint("https://api.openai.com/v1/"), "https://api.openai.com/v1/chat/completions");
		assert.strictEqual(getModelsEndpoint("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1/models");
	});

	test("posts serialized chat requests through the injected fetch implementation", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		const transport = new OpenAIHttpTransport(async (input, init) => {
			capturedUrl = String(input);
			capturedInit = init;
			return new Response(null, { status: 200 });
		});
		const cancellation = {
			isCancellationRequested: false,
			onCancellationRequested: (_listener: () => void) => ({ dispose() {} }),
		};

		await transport.postChatCompletion(
			"http://localhost:8000",
			{ "Content-Type": "application/json" },
			{ model: "qwen" },
			1000,
			cancellation
		);

		assert.strictEqual(capturedUrl, "http://localhost:8000/v1/chat/completions");
		assert.strictEqual(capturedInit?.method, "POST");
		assert.strictEqual(capturedInit?.body, JSON.stringify({ model: "qwen" }));
	});

	test("classifies retryable statuses and parses Retry-After", () => {
		assert.strictEqual(isTransientHttpStatus(429), true);
		assert.strictEqual(isTransientHttpStatus(503), true);
		assert.strictEqual(isTransientHttpStatus(500), false);
		assert.strictEqual(isTransientHttpStatus(400), false);
		assert.strictEqual(parseRetryAfterMs("1.5", 0), 1500);
		assert.strictEqual(parseRetryAfterMs("Thu, 01 Jan 1970 00:00:02 GMT", 1000), 1000);
		assert.strictEqual(parseRetryAfterMs("invalid", 0), undefined);
	});
});
