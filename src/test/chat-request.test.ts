import * as assert from "assert";
import { buildChatCompletionRequest, toLlamaCppReasoningEffort } from "../request/chat-request";
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
			chat_template_kwargs: { enable_thinking: true, reasoning_effort: "medium", preserve_thinking: true },
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

	test("keeps the plain OpenAI profile free of llama.cpp-only fields", () => {
		// A real OpenAI-compatible endpoint rejects unknown request arguments, so
		// the llama.cpp fields must stay opt-in.
		const request = buildChatCompletionRequest({
			model: "gpt-4.1",
			family: "openai",
			protocol: "openai",
			maxTokens: 4096,
			temperature: 0.7,
			cachePrompt: true,
			thinkingMode: "deep",
			reasoningBudget: 4096,
			tools,
			toolChoice: "auto",
		});

		assert.ok(!("cache_prompt" in request), "cache_prompt must not be sent");
		assert.ok(!("chat_template_kwargs" in request), "chat_template_kwargs must not be sent");
		assert.ok(!("thinking_budget_tokens" in request), "thinking_budget_tokens must not be sent");
		assert.strictEqual(request.temperature, 0.7);
	});

	test("sends the llama.cpp thinking fields for an OpenAI-protocol gateway when opted in", () => {
		// llama.cpp behind an OpenAI-compatible gateway: the protocol stays
		// "openai", but without enable_thinking a Qwen3 template emits no
		// reasoning at all, which looked like the provider losing its thoughts.
		const request = buildChatCompletionRequest({
			model: "Qwen3.8-27B-UD-Q4_K_M.gguf",
			family: "qwen",
			protocol: "openai",
			llamaCppCompat: true,
			maxTokens: 32768,
			temperature: 0.7,
			cachePrompt: true,
			thinkingMode: "deep",
			reasoningBudget: 16384,
			tools,
			toolChoice: "auto",
		});

		assert.strictEqual(request.cache_prompt, true);
		assert.deepStrictEqual(request.chat_template_kwargs, { enable_thinking: true, reasoning_effort: "high" });
		assert.strictEqual(request.thinking_budget_tokens, 16384);
		assert.strictEqual(request.temperature, 0.7, "sampling fields must stay in place");
	});

	test("honours thinkingMode=off for an OpenAI-protocol gateway with llama.cpp fields", () => {
		const request = buildChatCompletionRequest({
			model: "Qwen3.8-27B-UD-Q4_K_M.gguf",
			family: "qwen",
			protocol: "openai",
			llamaCppCompat: true,
			maxTokens: 4096,
			temperature: 0.7,
			cachePrompt: false,
			thinkingMode: "off",
			reasoningBudget: 0,
		});

		assert.deepStrictEqual(request.chat_template_kwargs, { enable_thinking: false });
		assert.strictEqual(request.thinking_budget_tokens, 0);
		assert.strictEqual(request.cache_prompt, false);
	});

	test("maps thinking levels onto the reasoning_effort a llama.cpp template accepts", () => {
		// The template validates this value and raises on anything unexpected, so
		// only the canonical names may be sent.
		assert.strictEqual(toLlamaCppReasoningEffort("light"), "low");
		assert.strictEqual(toLlamaCppReasoningEffort("balanced"), "medium");
		assert.strictEqual(toLlamaCppReasoningEffort("deep"), "high");
		// "auto" must stay undefined so the template keeps its own default, and
		// "off" is expressed through enable_thinking instead.
		assert.strictEqual(toLlamaCppReasoningEffort("auto"), undefined);
		assert.strictEqual(toLlamaCppReasoningEffort("off"), undefined);
	});

	test("omits reasoning_effort in auto mode so the server default applies", () => {
		const request = buildChatCompletionRequest({
			model: "qwen-local",
			family: "qwen",
			protocol: "llamacpp",
			maxTokens: 8192,
			temperature: 0.7,
			cachePrompt: true,
			thinkingMode: "auto",
			reasoningBudget: 16384,
		});

		assert.deepStrictEqual(request.chat_template_kwargs, { enable_thinking: true });
	});

	test("ignores llamaCppCompat when the protocol is DeepSeek-native", () => {
		// DeepSeek has its own thinking shape; the llama.cpp fields must not
		// leak into it even if the flag is set.
		const request = buildChatCompletionRequest({
			model: "deepseek-v4-pro",
			family: "deepseek",
			protocol: "deepseek",
			llamaCppCompat: true,
			maxTokens: 65536,
			temperature: 1,
			cachePrompt: true,
			thinkingMode: "deep",
			reasoningBudget: 4096,
		});

		assert.deepStrictEqual(request.thinking, { type: "enabled" });
		assert.ok(!("chat_template_kwargs" in request), "DeepSeek must keep its own shape");
		assert.ok(!("cache_prompt" in request), "cache_prompt is llama.cpp-only");
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
