import * as assert from "node:assert";
import * as vscode from "vscode";
import { ApiProviderService } from "../api-providers/api-provider-service";
import { CursorApiClient, cursorApiRoot } from "../cursor/api-client";
import { CursorProfileTransport } from "../cursor/profile-transport";
import { LlamaCppChatModelProvider } from "../llama-provider";
import type { ChatModelSource } from "../model-sources/source-routing";
import type { FetchImplementation } from "../transport/openai-http";
import { renderApiProviderManagerHtml } from "../ui/api-provider-manager";

const catalog = { items: [{ id: "composer-test", displayName: "Composer Test", parameters: [{ id: "context_window", values: [{ value: "200k" }, { value: "1m" }] }, { id: "effort", values: [{ value: "low" }, { value: "high" }] }], variants: [{ isDefault: true, params: [{ id: "context_window", value: "200k" }, { id: "effort", value: "low" }] }] }] };
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const user = (text: string): vscode.LanguageModelChatMessage => vscode.LanguageModelChatMessage.User(text);
const none: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined) };
const automatic: vscode.ProvideLanguageModelChatResponseOptions = { toolMode: vscode.LanguageModelChatToolMode.Auto };
const source: ChatModelSource = { key: "api-cursor-test", label: "Cursor", serverUrl: "https://api.cursor.com/v1", apiKey: "test-key", protocol: "cursor", workingContextLength: 500_000 };

function backend() {
	const calls: Array<{ url: string; method?: string; auth: string | null; body?: Record<string, unknown> }> = [];
	let agentCount = 0;
	const fetchImpl: FetchImplementation = async (input, init) => {
		const url = String(input);
		calls.push({ url, method: init?.method, auth: new Headers(init?.headers).get("Authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
		if (url.endsWith("/models")) { return json(catalog); }
		if (url.endsWith("/agents")) { agentCount++; return json({ agent: { id: `agent-${agentCount}` }, run: { id: `run-${calls.length}`, agentId: `agent-${agentCount}`, status: "CREATING" } }); }
		if (url.endsWith("/runs")) { return json({ run: { id: `run-${calls.length}`, agentId: "agent-1", status: "CREATING" } }); }
		if (url.endsWith("/stream")) { return new Response('event: result\ndata: {"status":"FINISHED","text":"answer"}\n\nevent: done\ndata: {}\n\n'); }
		if (url.endsWith("/cancel")) { return json({}); }
		throw new Error("Unexpected API path: " + url);
	};
	return { calls, fetchImpl, transport: new CursorProfileTransport(profile => new CursorApiClient(profile.apiKey!, profile.serverUrl, fetchImpl), null) };
}

suite("Cursor API profiles", () => {
	test("uses the existing profile and saved key, renders Cursor format, and honours disabling", async () => {
		const values = new Map<string, unknown>(), keys = new Map<string, string>();
		const changed = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
		const state = { get: (key: string, fallback?: unknown) => values.has(key) ? values.get(key) : fallback, update: async (key: string, value: unknown) => { values.set(key, value); }, keys: () => [...values.keys()] } as vscode.Memento;
		const secrets: vscode.SecretStorage = { get: async key => keys.get(key), store: async (key, value) => { keys.set(key, value); }, delete: async key => { keys.delete(key); }, keys: async () => [...keys.keys()], onDidChange: changed.event };
		const service = new ApiProviderService(state, secrets), b = backend();
		const provider = new LlamaCppChatModelProvider(secrets, "test", undefined, undefined, undefined, undefined, () => service.getModelSources());
		(provider as unknown as { cursorTransport: CursorProfileTransport }).cursorTransport = b.transport;
		(provider as unknown as { getModelSources: () => Promise<readonly ChatModelSource[]> }).getModelSources = () => service.getModelSources();
		try {
			const profile = await service.upsert({ name: "Cursor", baseUrl: source.serverUrl, protocol: "openai" }, { apiKey: "saved-key" });
			assert.strictEqual(profile.protocol, "cursor");
			const models = await provider.provideLanguageModelChatInformation({ silent: true }, none);
			assert.ok(models.some(model => model.id === `api-${profile.id}::composer-test`));
			const selected = models.find(model => model.id === `api-${profile.id}::composer-test`)!;
			const output: vscode.LanguageModelResponsePart[] = [];
			await provider.provideLanguageModelChatResponse(selected, [user("hello")], automatic, { report: part => output.push(part) }, none);
			assert.ok(output.some(part => part instanceof vscode.LanguageModelTextPart && part.value === "answer"));
			assert.ok(b.calls.every(call => call.auth === "Bearer saved-key"));
			assert.ok(b.calls.some(call => call.url.endsWith("/agents")));
			assert.ok(!b.calls.some(call => call.url.includes("chat/completions") || call.url.includes("/v1/v1")));
			const html = renderApiProviderManagerHtml({ profiles: await service.listSummaries(), providers: [], editingId: profile.id });
			assert.match(html, /value="cursor"[^>]*selected/);
			assert.ok(!html.includes('class="status unsupported"'));
			await service.upsert({ ...profile, name: "Renamed Cursor" });
			assert.strictEqual(await service.getApiKey(profile.id), "saved-key");
			await service.setEnabled(profile.id, false);
			assert.ok(!(await service.getModelSources()).some(item => item.key === `api-${profile.id}`));
			await assert.rejects(provider.provideLanguageModelChatResponse(selected, [user("hi")], automatic, { report: () => undefined }, none), /disabled or removed/);
		} finally { b.transport.dispose(); service.dispose(); changed.dispose(); }
	});

	test("discovers maximum and parameters without replacing the chosen working context", async () => {
		const b = backend(), reported: number[] = [];
		try {
			const [model] = await b.transport.models(source, none, "test", (_key, maximum, actual) => { assert.ok(actual); reported.push(maximum); });
			assert.deepStrictEqual(reported, [1_000_000]);
			assert.strictEqual(model.maxInputTokens + model.maxOutputTokens, 500_000);
			assert.strictEqual(model.capabilities.toolCalling, false);
			assert.strictEqual((model as unknown as { configurationSchema: { properties: { context_window: { default: string } } } }).configurationSchema.properties.context_window.default, "1m");
			const thinking = (model as unknown as { configurationSchema: { properties: { reasoningEffort: { enum: string[]; group: string; default: string } } } }).configurationSchema.properties.reasoningEffort;
			assert.deepStrictEqual(thinking.enum, ["low", "high"]);
			assert.strictEqual(thinking.group, "navigation"); assert.strictEqual(thinking.default, "low");
		} finally { b.transport.dispose(); }
	});

	test("continues with /runs and sends only new user content; chats, profiles and keys stay isolated", async () => {
		const b = backend();
		try {
			const [model] = await b.transport.models(source, none, "test");
			const send = (profile: ChatModelSource, messages: vscode.LanguageModelChatRequestMessage[], conversation?: string) => b.transport.respond(profile, "composer-test", model, messages, { ...automatic, modelOptions: { ...(conversation ? { _copilotConversationId: conversation } : {}), effort: "high" } }, { report: () => undefined }, none);
			await send(source, [user("first")], "chat-one");
			await send(source, [user("first"), vscode.LanguageModelChatMessage.Assistant("answer"), user("second")], "chat-one");
			const followup = b.calls.find(call => call.url.endsWith("/agent-1/runs"));
			assert.deepStrictEqual(followup?.body, { prompt: { text: "User:\nsecond" } });
			const creation = b.calls.find(call => call.url.endsWith("/agents"))!;
			assert.deepStrictEqual(creation.body?.model, { id: "composer-test", params: [{ id: "context_window", value: "1m" }, { id: "effort", value: "high" }] });
			await send(source, [user("first")], "chat-two");
			await send({ ...source, key: "api-another-profile" }, [user("first")], "chat-one");
			await send({ ...source, apiKey: "replacement-key" }, [user("first"), user("third")], "chat-one");
			await send(source, [user("first")]); await send(source, [user("first"), user("another")]);
			assert.strictEqual(b.calls.filter(call => call.url.endsWith("/agents")).length, 6);
		} finally { b.transport.dispose(); }
	});

	test("parses fragmented UTF-8, CRLF and multiline SSE, and closes at done", async () => {
		const encoded = new TextEncoder().encode(': heartbeat\r\nevent:assistant\r\ndata:{"text":\r\ndata: "Привет"}\r\n\r\nevent:done\r\ndata:{}\r\n\r\n');
		let cancelled = false;
		const client = new CursorApiClient("key", source.serverUrl, async () => new Response(new ReadableStream({ start(controller) { for (let i = 0; i < encoded.length; i += 2) { controller.enqueue(encoded.slice(i, i + 2)); } }, cancel() { cancelled = true; } })));
		const events = []; for await (const event of client.streamRun("agent", "run")) { events.push(event); }
		assert.deepStrictEqual(events.map(event => event.type), ["assistant", "done"]);
		assert.strictEqual(events[0].data.text, "Привет"); assert.ok(cancelled);
		assert.strictEqual(cursorApiRoot("https://api.cursor.com"), "https://api.cursor.com/v1");
		assert.strictEqual(cursorApiRoot(source.serverUrl + "/"), source.serverUrl);
	});

	test("automatic context selects the reported maximum and changed settings start a fresh agent", async () => {
		const b = backend(), automaticSource = { ...source, workingContextLength: undefined };
		try {
			const [model] = await b.transport.models(automaticSource, none, "test");
			await b.transport.respond(automaticSource, "composer-test", model, [user("first")], { ...automatic, modelOptions: { _copilotConversationId: "same-chat" } }, { report: () => undefined }, none);
			const selection = b.calls.find(call => call.url.endsWith("/agents"))!.body!.model as { params: Array<{ id: string; value: string }> };
			assert.ok(selection.params.some(item => item.id === "context_window" && item.value === "1m"));
			await b.transport.respond(automaticSource, "composer-test", model, [user("first"), user("next")], { ...automatic, modelOptions: { _copilotConversationId: "same-chat", effort: "high" } }, { report: () => undefined }, none);
			assert.strictEqual(b.calls.filter(call => call.url.endsWith("/agents")).length, 2);
			await assert.rejects(b.transport.respond(automaticSource, "composer-test", model, [user("x")], { ...automatic, modelOptions: { effort: "invented" } }, { report: () => undefined }, none), /Unsupported Cursor parameter/);
		} finally { b.transport.dispose(); }
	});

	test("reads a finished run after stream expiry and rejects malformed SSE", async () => {
		const b = backend();
		const fetchImpl: FetchImplementation = async (input, init) => {
			const url = String(input);
			if (url.endsWith("/stream")) { return new Response("expired", { status: 410 }); }
			if (/\/runs\/run-[^/]+$/.test(url)) { return json({ id: "run", agentId: "agent", status: "FINISHED", result: "recovered answer" }); }
			return b.fetchImpl(input, init);
		};
		const transport = new CursorProfileTransport(profile => new CursorApiClient(profile.apiKey!, profile.serverUrl, fetchImpl), null);
		try {
			const [model] = await transport.models(source, none, "test");
			const output: vscode.LanguageModelResponsePart[] = [];
			await transport.respond(source, "composer-test", model, [user("hi")], automatic, { report: part => output.push(part) }, none);
			assert.ok(output.some(part => part instanceof vscode.LanguageModelTextPart && part.value === "recovered answer"));
			assert.ok(!b.calls.some(call => call.url.endsWith("/cancel")));
			const client = new CursorApiClient("key", source.serverUrl, async () => new Response('event:assistant\ndata: invalid-json\n\n'));
			await assert.rejects(async () => { for await (const event of client.streamRun("agent", "run")) { void event; } }, SyntaxError);
		} finally { b.transport.dispose(); transport.dispose(); }
	});

	test("surfaces failed runs, missing catalogs and authentication errors", async () => {
		const b = backend();
		const failedFetch: FetchImplementation = (input, init) => String(input).endsWith("/stream") ? Promise.resolve(new Response('event: result\ndata: {"status":"ERROR","text":"failed"}\n\n')) : b.fetchImpl(input, init);
		const transport = new CursorProfileTransport(profile => new CursorApiClient(profile.apiKey!, profile.serverUrl, failedFetch), null);
		try {
			const [model] = await transport.models(source, none, "test");
			await assert.rejects(transport.respond(source, "composer-test", model, [user("hi")], automatic, { report: () => undefined }, none), /status ERROR/);
			assert.ok(b.calls.some(call => call.url.endsWith("/cancel")));
			await assert.rejects(new CursorApiClient("key", source.serverUrl, async () => json({ data: [] })).listModels(), /invalid model catalog/);
			await assert.rejects(new CursorApiClient("key", source.serverUrl, async () => new Response("echo-key", { status: 401 })).listModels(), error => { assert.match(String(error), /HTTP 401/); return !String(error).includes("echo-key"); });
		} finally { b.transport.dispose(); transport.dispose(); }
	});

	test("cancels the remote run when VS Code aborts a blocked stream", async () => {
		const b = backend(), cancellation = new vscode.CancellationTokenSource();
		const fetchImpl: FetchImplementation = async (input, init) => {
			if (!String(input).endsWith("/stream")) { return b.fetchImpl(input, init); }
			return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true }); queueMicrotask(() => cancellation.cancel()); } }));
		};
		const transport = new CursorProfileTransport(profile => new CursorApiClient(profile.apiKey!, profile.serverUrl, fetchImpl), null);
		try {
			const [model] = await transport.models(source, none, "test");
			await assert.rejects(transport.respond(source, "composer-test", model, [user("hi")], automatic, { report: () => undefined }, cancellation.token), error => error instanceof vscode.CancellationError);
			assert.ok(b.calls.some(call => call.url.endsWith("/cancel")));
		} finally { b.transport.dispose(); transport.dispose(); cancellation.dispose(); }
	});
});