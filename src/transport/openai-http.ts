import { stableJsonStringify } from "../utils";

export interface RequestCancellation {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

export type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function isDeepSeekEndpoint(serverUrl: string): boolean {
	try {
		return new URL(serverUrl).hostname.toLowerCase().endsWith("deepseek.com");
	} catch {
		return false;
	}
}

export function getChatCompletionsEndpoint(serverUrl: string): string {
	return `${getOpenAiApiRoot(serverUrl)}/chat/completions`;
}

export function getModelsEndpoint(serverUrl: string): string {
	const root = getOpenAiApiRoot(serverUrl);
	// Cloudflare Workers AI REST API has no OpenAI-style GET /models route
	// (it answers HTTP 405 even with a valid token). The model catalog lives
	// at /ai/models/search; use it for both probing and model listing.
	if (isCloudflareWorkersAiBase(root)) {
		return `${root.replace(/\/ai\/v\d+$/, "/ai/models/search")}?per_page=100`;
	}
	return `${root}/models`;
}

/** True for https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1 bases. */
/**
 * Value for the Cloudflare Workers AI x-session-affinity header: pins a
 * conversation to the same model instance so prefix caching can hit
 * (docs: developers.cloudflare.com/workers-ai/features/prompt-caching/).
 */
export function cloudflareSessionAffinity(conversationId: string | undefined): string | undefined {
	if (!conversationId) {
		return undefined;
	}
	return `llama-vscode-chat-${conversationId}`;
}

export function isCloudflareWorkersAiBase(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.hostname === "api.cloudflare.com" && /\/ai\/v\d+/.test(url.pathname);
	} catch {
		return false;
	}
}

/**
 * Picks the catalog id for a model item. Cloudflare Workers AI
 * models/search items carry a uuid in `id` and the canonical model name in
 * `name` — the uuid is useless for chat requests and unreadable in the picker.
 */
export function pickModelCatalogId(item: Record<string, unknown>, baseUrl: string): string | undefined {
	if (isCloudflareWorkersAiBase(baseUrl)) {
		const name = typeof item.name === "string" ? item.name.trim() : "";
		return name.length > 0 ? name : undefined;
	}
	const id = typeof item.id === "string"
		? item.id
		: typeof item.model === "string"
			? item.model
			: typeof item.name === "string"
				? item.name
				: undefined;
	return id && id.trim().length > 0 ? id.trim() : undefined;
}

/**
 * Normalizes a user-supplied provider base URL. Users often paste the full
 * OpenAI chat endpoint (https://host/v1/chat/completions); the provider
 * machinery appends /v1/models and /chat/completions itself, so the suffix
 * must be stripped first.
 */
export function normalizeProviderBaseUrl(serverUrl: string): string {
        let normalized = serverUrl.trim().replace(/\/+$/, "");
        if (/\/chat\/completions$/i.test(normalized)) {
                normalized = normalized.replace(/\/chat\/completions$/i, "");
                normalized = normalized.replace(/\/+$/, "");
        }
        return normalized;
}

export function getOpenAiApiRoot(serverUrl: string): string {
	const normalized = serverUrl.trim().replace(/\/+$/, "");
	// Cloudflare AI Gateway exposes OpenAI-compatible paths under
	// /v1/{account_id}/{gateway_slug}/openai — the trailing /openai is the
	// root, /v1 must NOT be appended (verified against the official docs).
	if (
		isDeepSeekEndpoint(normalized)
		|| /\/v\d+(?:\.\d+)?$/i.test(normalized)
		|| /\/openai$/i.test(normalized)
	) {
		return normalized;
	}
	return `${normalized}/v1`;
}

export function isTransientHttpStatus(status: number): boolean {
	return status === 429 || status === 502 || status === 503 || status === 504;
}

export function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
	if (!value) {
		return undefined;
	}
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.round(seconds * 1000);
	}
	const date = Date.parse(value);
	if (!Number.isFinite(date)) {
		return undefined;
	}
	return Math.max(0, date - now);
}

export class OpenAIHttpTransport {
	constructor(private readonly fetchImplementation?: FetchImplementation) {}

	async request(
		url: string,
		init: RequestInit,
		timeoutMs: number,
		cancellation?: RequestCancellation
	): Promise<Response> {
		const controller = new AbortController();
		const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
		const cancellationSubscription = cancellation?.onCancellationRequested(() => controller.abort());

		if (cancellation?.isCancellationRequested) {
			controller.abort();
		}

		try {
			const fetchRequest = this.fetchImplementation ?? fetch;
			return await fetchRequest(url, {
				...init,
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeoutHandle);
			cancellationSubscription?.dispose();
		}
	}

	postChatCompletion(
		serverUrl: string,
		headers: Record<string, string>,
		requestBody: Record<string, unknown>,
		timeoutMs: number,
		cancellation: RequestCancellation
	): Promise<Response> {
		return this.request(
			getChatCompletionsEndpoint(serverUrl),
			{
				method: "POST",
				headers,
				body: stableJsonStringify(requestBody),
			},
			timeoutMs,
			cancellation
		);
	}
}
