import * as assert from "node:assert";
import {
	getChatCompletionsEndpoint,
	getModelsEndpoint,
	isTransientHttpStatus,
	OpenAIHttpTransport,
	parseRetryAfterMs,
} from "../transport/openai-http";

suite("OpenAI HTTP transport", () => {
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
