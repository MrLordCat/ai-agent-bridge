import { toDeepSeekReasoningEffort, type ThinkingMode } from "../reasoning";
import type { OpenAIChatMessage, OpenAIFunctionToolDef } from "../types";
import type { ApiRequestProtocol } from "../model-sources/source-routing";

export type OpenAIToolChoice = "auto" | {
	type: "function";
	function: { name: string };
};

export interface BuildChatCompletionRequestInput {
	model: string;
	family: string;
	protocol?: ApiRequestProtocol;
	maxTokens: number;
	temperature: number;
	cachePrompt: boolean;
	thinkingMode: ThinkingMode;
	reasoningBudget: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	preserveThinking?: boolean;
	tools?: OpenAIFunctionToolDef[];
	toolChoice?: OpenAIToolChoice;
}

export type ChatCompletionRequestBody = Record<string, unknown> & {
	model: string;
	messages: OpenAIChatMessage[];
	stream: true;
	stream_options: { include_usage: true };
	max_tokens: number;
};

export function buildChatCompletionRequest(
	input: BuildChatCompletionRequestInput
): ChatCompletionRequestBody {
	const isDeepSeek = input.protocol === "deepseek"
		|| (input.protocol === undefined && input.family === "deepseek");
	const isLlamaCpp = input.protocol === "llamacpp"
		|| (input.protocol === undefined && !isDeepSeek);
	const isDeepSeekThinkingRequest = isDeepSeek && input.thinkingMode !== "off";
	const request: ChatCompletionRequestBody = {
		model: input.model,
		messages: [],
		stream: true,
		stream_options: {
			include_usage: true,
		},
		max_tokens: input.maxTokens,
	};

	if (!isDeepSeekThinkingRequest) {
		request.temperature = input.temperature;
		if (input.topP !== undefined) {
			request.top_p = input.topP;
		}
		if (input.topK !== undefined) {
			request.top_k = input.topK;
		}
		if (input.minP !== undefined) {
			request.min_p = input.minP;
		}
		if (input.presencePenalty !== undefined) {
			request.presence_penalty = input.presencePenalty;
		}
	}

	if (isDeepSeek) {
		request.thinking = {
			type: input.thinkingMode === "off" ? "disabled" : "enabled",
		};
		const reasoningEffort = toDeepSeekReasoningEffort(input.thinkingMode);
		if (reasoningEffort) {
			request.reasoning_effort = reasoningEffort;
		}
	} else if (isLlamaCpp) {
		request.cache_prompt = input.cachePrompt;
		request.chat_template_kwargs = {
			enable_thinking: input.thinkingMode !== "off",
			...(input.preserveThinking ? { preserve_thinking: true } : {}),
		};
		request.thinking_budget_tokens = input.reasoningBudget;
	}

	if (input.tools) {
		request.tools = input.tools;
	}
	if (input.toolChoice && !isDeepSeek) {
		request.tool_choice = input.toolChoice;
	}

	return request;
}
