import * as assert from "assert";
import { buildChatCompletionRequest } from "../request/chat-request";
import type { OpenAIFunctionToolDef } from "../types";

const tools: OpenAIFunctionToolDef[] = [{
	type: "function",
	function: {
		name: "read_file",
		parameters: { type: "object" },
	},
}];

suite("chat request profiles", () => {
	test("builds the llama.cpp request profile", () => {
		const request = buildChatCompletionRequest({
			model: "qwen-local",
			family: "qwen",
			maxTokens: 8192,
			temperature: 0.7,
			cachePrompt: true,
			thinkingMode: "balanced",
			reasoningBudget: 2048,
			topP: 0.9,
			topK: 40,
			minP: 0,
			presencePenalty: 0,
			preserveThinking: true,
			tools,
			toolChoice: "auto",
		});

		assert.deepStrictEqual(request, {
			model: "qwen-local",
			messages: [],
			stream: true,
			stream_options: { include_usage: true },
			max_tokens: 8192,
			temperature: 0.7,
			top_p: 0.9,
			top_k: 40,
			min_p: 0,
			presence_penalty: 0,
			cache_prompt: true,
			chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
			thinking_budget_tokens: 2048,
			tools,
			tool_choice: "auto",
		});
	});

	test("disables local thinking explicitly", () => {
		const request = buildChatCompletionRequest({
			model: "qwen-local",
			family: "qwen",
			maxTokens: 4096,
			temperature: 0.7,
			cachePrompt: true,
			thinkingMode: "off",
			reasoningBudget: 0,
		});

		assert.deepStrictEqual(request.chat_template_kwargs, { enable_thinking: false });
		assert.strictEqual(request.thinking_budget_tokens, 0);
	});

	test("omits unsupported sampling and tool choice in DeepSeek thinking mode", () => {
		const request = buildChatCompletionRequest({
			model: "deepseek-v4-pro",
			family: "deepseek",
			maxTokens: 393216,
			temperature: 1,
			cachePrompt: true,
			thinkingMode: "deep",
			reasoningBudget: 8192,
			topP: 0.8,
			topK: 20,
			tools,
			toolChoice: "auto",
		});

		assert.deepStrictEqual(request, {
			model: "deepseek-v4-pro",
			messages: [],
			stream: true,
			stream_options: { include_usage: true },
			max_tokens: 393216,
			thinking: { type: "enabled" },
			reasoning_effort: "max",
			tools,
		});
	});

	test("keeps sampling when DeepSeek thinking is disabled", () => {
		const request = buildChatCompletionRequest({
			model: "deepseek-chat",
			family: "deepseek",
			maxTokens: 4096,
			temperature: 1.2,
			cachePrompt: true,
			thinkingMode: "off",
			reasoningBudget: 0,
			topP: 0.95,
		});

		assert.strictEqual(request.temperature, 1.2);
		assert.strictEqual(request.top_p, 0.95);
		assert.deepStrictEqual(request.thinking, { type: "disabled" });
		assert.ok(!("cache_prompt" in request));
		assert.ok(!("reasoning_effort" in request));
	});

	test("builds a clean standard OpenAI-compatible request profile", () => {
		const request = buildChatCompletionRequest({
			model: "gpt-5",
			family: "openai",
			protocol: "openai",
			maxTokens: 8192,
			temperature: 0.7,
			cachePrompt: true,
			thinkingMode: "deep",
			reasoningBudget: 8192,
			tools,
			toolChoice: "auto",
		});

		assert.strictEqual(request.temperature, 0.7);
		assert.strictEqual(request.tool_choice, "auto");
		assert.ok(!("cache_prompt" in request));
		assert.ok(!("chat_template_kwargs" in request));
		assert.ok(!("thinking_budget_tokens" in request));
		assert.ok(!("thinking" in request));
		assert.ok(!("reasoning_effort" in request));
	});
});
