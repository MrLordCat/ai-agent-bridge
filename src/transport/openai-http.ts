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
	return isDeepSeekEndpoint(serverUrl)
		? `${serverUrl}/chat/completions`
		: `${serverUrl}/v1/chat/completions`;
}

export function getModelsEndpoint(serverUrl: string): string {
	return isDeepSeekEndpoint(serverUrl)
		? `${serverUrl}/models`
		: `${serverUrl}/v1/models`;
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
