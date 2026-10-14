import type { FetchImplementation } from "../transport/openai-http";

export interface CursorParameter {
	id: string;
	displayName?: string;
	values: Array<{ value: string; displayName?: string }>;
}
export interface CursorModel {
	id: string;
	displayName?: string;
	contextWindow?: number;
	context_window?: number;
	context_length?: number;
	parameters?: CursorParameter[];
	variants?: Array<{ params: Array<{ id: string; value: string }>; isDefault?: boolean }>;
}
export interface CursorPrompt {
	text: string;
	images?: Array<{ data: string; mimeType: string }>;
}
export interface CursorSelection { id: string; params?: Array<{ id: string; value: string }> }
export interface CursorRun { id: string; agentId: string; status: string; result?: string; error?: unknown }
export interface CursorEvent { type: string; data: Record<string, unknown>; id?: string }

export function cursorApiRoot(baseUrl: string): string {
	const url = new URL(baseUrl);
	url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1";
	return url.toString().replace(/\/$/, "");
}

/** Cloud Agents REST v1. This client never calls chat/completions. */
export class CursorApiClient {
	private readonly root: string;
	constructor(
		private readonly apiKey: string,
		baseUrl = "https://api.cursor.com/v1",
		private readonly fetchImpl: FetchImplementation = fetch,
	) { this.root = cursorApiRoot(baseUrl); }

	private async request(path: string, signal?: AbortSignal, body?: unknown, stream = false): Promise<Response> {
		const response = await this.fetchImpl(this.root + path, {
			method: body === undefined ? "GET" : "POST",
			headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", Accept: stream ? "text/event-stream" : "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: stream ? signal : signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
			redirect: "error",
		});
		if (!response.ok) {
			// Do not surface response bodies: upstream errors may echo prompts or credentials.
			await response.body?.cancel();
			throw new CursorApiError(response.status, `Cursor ${path}: HTTP ${response.status}${response.status === 401 || response.status === 403 ? " — check the API key and account access in Providers Manager" : ""}`);
		}
		return response;
	}

	async listModels(signal?: AbortSignal): Promise<CursorModel[]> {
		const body = await (await this.request("/models", signal)).json() as { items?: unknown[] };
		if (!Array.isArray(body.items)) { throw new Error("Cursor returned an invalid model catalog (expected items)."); }
		return body.items.filter((item): item is CursorModel => !!item && typeof item === "object" && typeof (item as CursorModel).id === "string" && !!(item as CursorModel).id);
	}

	async createAgent(prompt: CursorPrompt, model: CursorSelection, signal?: AbortSignal): Promise<{ agent: { id: string }; run: CursorRun }> {
		const body = await (await this.request("/agents", signal, { prompt, model })).json() as { agent: { id: string }; run: CursorRun };
		if (!body.agent?.id || !body.run?.id) { throw new Error("Cursor returned no agent/run identifier."); }
		return body;
	}

	async createRun(agentId: string, prompt: CursorPrompt, signal?: AbortSignal): Promise<CursorRun> {
		const body = await (await this.request(`/agents/${encodeURIComponent(agentId)}/runs`, signal, { prompt })).json() as { run: CursorRun };
		if (!body.run?.id) { throw new Error("Cursor returned no run identifier."); }
		return body.run;
	}

	async getRun(agentId: string, runId: string, signal?: AbortSignal): Promise<CursorRun> {
		return await (await this.request(`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`, signal)).json() as CursorRun;
	}

	async cancelRun(agentId: string, runId: string): Promise<void> {
		await (await this.request(`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`, AbortSignal.timeout(10_000), {})).body?.cancel();
	}

	async *streamRun(agentId: string, runId: string, signal?: AbortSignal): AsyncGenerator<CursorEvent> {
		const controller = new AbortController();
		const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const connectTimer = setTimeout(() => controller.abort(new Error("Cursor stream connection timed out.")), 60_000);
		let response: Response;
		try { response = await this.request(`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`, combined, undefined, true); }
		finally { clearTimeout(connectTimer); }
		if (!response.body) { throw new Error("Cursor stream returned no body."); }
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "", event = "message", id: string | undefined;
		let data: string[] = [];
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		const parseLine = (line: string): CursorEvent | undefined => {
			if (!line) {
				const type = event, eventId = id, payload = data.join("\n");
				event = "message"; data = []; id = undefined;
				if (!payload) { return undefined; }
				const parsed: unknown = JSON.parse(payload);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { throw new Error("Invalid Cursor stream event."); }
				return { type, data: parsed as Record<string, unknown>, id: eventId };
			}
			if (line.startsWith(":")) { return undefined; }
			const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon);
			const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
			if (field === "event") { event = value; }
			if (field === "id") { id = value; }
			if (field === "data") { data.push(value); }
			if (data.reduce((total, part) => total + part.length, 0) > 2_000_000) { throw new Error("Cursor stream event is too large."); }
			return undefined;
		};
		try {
			while (true) {
				idleTimer = setTimeout(() => controller.abort(new Error("Cursor stream timed out.")), 90_000);
				const chunk = await reader.read();
				clearTimeout(idleTimer);
				buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
				let match: RegExpExecArray | null;
				while ((match = /\r\n|\n|\r/.exec(buffer))) {
					if (!chunk.done && match[0] === "\r" && match.index === buffer.length - 1) { break; }
					const line = buffer.slice(0, match.index);
					buffer = buffer.slice(match.index + match[0].length);
					const parsed = parseLine(line);
					if (parsed) { yield parsed; if (parsed.type === "done") { return; } }
				}
				if (buffer.length > 2_000_000) { throw new Error("Cursor stream line is too large."); }
				if (chunk.done) {
					if (buffer) { parseLine(buffer); }
					const parsed = parseLine("");
					if (parsed) { yield parsed; }
					return;
				}
			}
		} finally {
			clearTimeout(idleTimer);
			controller.abort();
			await reader.cancel().catch(() => { /* The upstream may already be aborted. */ });
			reader.releaseLock();
		}
	}
}

export class CursorApiError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}