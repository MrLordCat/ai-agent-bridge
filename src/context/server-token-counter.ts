import { createHash } from "node:crypto";
import type { RequestCancellation } from "../transport/openai-http";
import type { OpenAIChatMessage, OpenAIFunctionToolDef } from "../types";

interface ServerTokenCountInput {
	serverUrl: string;
	model: string;
	headers: Record<string, string>;
	messages: OpenAIChatMessage[];
	tools?: OpenAIFunctionToolDef[];
	chatTemplateKwargs?: Record<string, unknown>;
	timeoutMs: number;
	cancellation: RequestCancellation;
}

type TokenCounterRequest = (
	url: string,
	init: RequestInit,
	timeoutMs: number,
	cancellation: RequestCancellation
) => Promise<Response>;

interface CachedTokenCount {
	count: number;
	expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 128;

export class ServerTokenCounter {
	private readonly cache = new Map<string, CachedTokenCount>();

	constructor(private readonly request: TokenCounterRequest) {}

	async countChatPrompt(input: ServerTokenCountInput): Promise<number | undefined> {
		const templateBody: Record<string, unknown> = {
			messages: input.messages,
			add_generation_prompt: true,
		};
		if (input.tools && input.tools.length > 0) {
			templateBody.tools = input.tools;
		}
		if (input.chatTemplateKwargs) {
			templateBody.chat_template_kwargs = input.chatTemplateKwargs;
		}

		const cacheKey = createHash("sha256")
			.update(input.serverUrl)
			.update("\0")
			.update(input.model)
			.update("\0")
			.update(JSON.stringify(templateBody))
			.digest("hex");
		const cached = this.cache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.count;
		}

		try {
			const baseUrl = input.serverUrl.replace(/\/+$/, "");
			const templateResponse = await this.request(
				`${baseUrl}/apply-template`,
				{
					method: "POST",
					headers: input.headers,
					body: JSON.stringify(templateBody),
				},
				input.timeoutMs,
				input.cancellation
			);
			if (!templateResponse.ok) {
				return undefined;
			}

			const templatePayload = await templateResponse.json() as { prompt?: unknown };
			if (typeof templatePayload.prompt !== "string") {
				return undefined;
			}

			const tokenizeResponse = await this.request(
				`${baseUrl}/tokenize`,
				{
					method: "POST",
					headers: input.headers,
					body: JSON.stringify({
						content: templatePayload.prompt,
						add_special: false,
						parse_special: true,
					}),
				},
				input.timeoutMs,
				input.cancellation
			);
			if (!tokenizeResponse.ok) {
				return undefined;
			}

			const tokenizePayload = await tokenizeResponse.json() as { tokens?: unknown };
			if (!Array.isArray(tokenizePayload.tokens)) {
				return undefined;
			}

			const count = tokenizePayload.tokens.length;
			this.cache.set(cacheKey, { count, expiresAt: Date.now() + CACHE_TTL_MS });
			this.trimCache();
			return count;
		} catch {
			return undefined;
		}
	}

	clear(): void {
		this.cache.clear();
	}

	private trimCache(): void {
		while (this.cache.size > MAX_CACHE_ENTRIES) {
			const oldestKey = this.cache.keys().next().value as string | undefined;
			if (!oldestKey) {
				return;
			}
			this.cache.delete(oldestKey);
		}
	}
}
