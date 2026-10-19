import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentOptions, SendOptions, SDKCustomToolResult } from "@cursor/sdk";
import { CursorApiClient } from "../cursor/api-client";
import { CursorProfileTransport } from "../cursor/profile-transport";
import { CURSOR_NATIVE_TOOL_POLICY, CursorSdkTransport, cursorSdkRuntimeAvailable, type CursorLocalAgent } from "../cursor/sdk-transport";
import { CursorToolBridge } from "../cursor/tool-bridge";
import { CursorNativeStore } from "../cursor/native-store";
import type { ChatModelSource } from "../model-sources/source-routing";

const none: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined) };
const tool: vscode.LanguageModelChatTool = { name: "read_file", description: "Read a workspace file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
const options: vscode.ProvideLanguageModelChatResponseOptions = { tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _copilotConversationId: "chat-one" } };
const source: ChatModelSource = { key: "api-cursor-test", label: "Cursor", serverUrl: "https://api.cursor.com/v1", apiKey: "saved-test-key", protocol: "cursor" };
const user = () => vscode.LanguageModelChatMessage.User("Read the file through VS Code");
const resultMessage = (callId: string, text: string) => new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart(text)])]);

function sdkFixture() {
	const created: AgentOptions[] = [], returned: SDKCustomToolResult[] = [];
	let closed = 0, cancelled = 0;
	const sdk = new CursorSdkTransport({ available: () => true, createAgent: async config => {
		created.push(config);
		const agent: CursorLocalAgent = {
			close: () => { closed++; },
			send: async (_prompt, send: SendOptions) => {
				const completion = Promise.resolve().then(async () => {
					await send.onDelta?.({ update: { type: "text-delta", text: "Reading through VS Code.\n" } });
					const callback = Object.values(send.local!.customTools!)[0];
					const value = await callback.execute({ path: "test.txt" }, {});
					returned.push(value);
					await send.onDelta?.({ update: { type: "text-delta", text: "Read complete." } });
					return { status: "finished", result: "Read complete." };
				});
				return { wait: () => completion, cancel: async () => { cancelled++; } };
			},
		};
		return agent;
	} });
	return { sdk, created, returned, closed: () => closed, cancelled: () => cancelled };
}

suite("Cursor native tools", () => {
	test("runs against a runtime that rejects systemPrompt while preserving tool restrictions and images", async () => {
		const configured: AgentOptions[] = [], sent: Array<{ text: string; images?: Array<{ data: string; mimeType: string }> }> = [];
		let closed = 0;
		const sdk = new CursorSdkTransport({ available: () => true, createAgent: async config => {
			configured.push(config);
			return { close: () => { closed++; }, send: async message => {
				sent.push(message as { text: string; images?: Array<{ data: string; mimeType: string }> });
				return { cancel: async () => undefined, wait: async () => config.systemPrompt === undefined
					? { status: "finished", result: "OK" }
					: { status: "error", error: { message: "[invalid_argument] unknown option '--system-prompt'" } } };
			} };
		} });
		try {
			const prompt = { text: "Read this image", images: [{ data: "AQID", mimeType: "image/png" }] };
			const selection = { id: "test-model", params: [{ id: "reasoning_effort", value: "high" }] };
			const output: vscode.LanguageModelResponsePart[] = [];
			await sdk.respond(source, selection, prompt, [user()], options, { report: part => output.push(part) }, none);
			assert.ok(!Object.hasOwn(configured[0], "systemPrompt"));
			assert.deepStrictEqual(configured[0].model, selection);
			assert.deepStrictEqual(configured[0].tools, ["mcp"]);
			assert.deepStrictEqual(configured[0].local?.settingSources, []);
			assert.deepStrictEqual(configured[0].mcpServers, {});
			assert.deepStrictEqual(configured[0].agents, {});
			assert.deepStrictEqual(sent[0], { ...prompt, text: `${CURSOR_NATIVE_TOOL_POLICY}\n\nVS Code conversation:\n${prompt.text}` });
			assert.strictEqual(prompt.text, "Read this image"); assert.strictEqual(closed, 1);
			assert.ok(output.some(part => part instanceof vscode.LanguageModelTextPart && part.value === "OK"));
		} finally { sdk.dispose(); }
	});

	test("reports the original SDK failure code and message instead of losing them behind status error", async () => {
		for (const diagnostic of [{ message: "unknown option '--system-prompt'", code: "invalid_argument" }, undefined]) {
			let closed = 0;
			const sdk = new CursorSdkTransport({ available: () => true, createAgent: async () => ({ close: () => { closed++; }, send: async () => ({ cancel: async () => undefined, wait: async () => ({ status: "error", error: diagnostic }) }) }) });
			try {
				await assert.rejects(sdk.respond(source, { id: "test" }, { text: "test" }, [user()], options, { report: () => undefined }, none), error => {
					assert.match(String(error), /status error/);
					if (diagnostic) { assert.match(String(error), /invalid_argument/); assert.match(String(error), /unknown option '--system-prompt'/); }
					else { assert.match(String(error), /No diagnostic details/); }
					return true;
				});
				assert.strictEqual(closed, 1);
			} finally { sdk.dispose(); }
		}
	});

	test("redacts profile keys and authentication tokens in SDK diagnostic messages", async () => {
		const sdk = new CursorSdkTransport({ available: () => true, createAgent: async () => ({ close: () => undefined, send: async () => ({ cancel: async () => undefined, wait: async () => ({ status: "error", error: { code: "unauthenticated", message: `Rejected ${source.apiKey}; Bearer arbitrary-token; apiKey=other-secret; crsr_private-key` } }) }) }) });
		try {
			await assert.rejects(sdk.respond(source, { id: "test" }, { text: "test" }, [user()], options, { report: () => undefined }, none), error => {
				const message = String(error);
				assert.match(message, /unauthenticated/); assert.match(message, /\[redacted\]/);
				for (const secret of [source.apiKey!, "arbitrary-token", "other-secret", "crsr_private-key"]) { assert.ok(!message.includes(secret)); }
				return true;
			});
		} finally { sdk.dispose(); }
	});

	test("creates and restores the installed SDK with callback-only configuration without inference", async function () {
		if (!cursorSdkRuntimeAvailable()) { this.skip(); }
		const sdk = await import("@cursor/sdk");
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sdk-host-test-"));
		try {
			const other = { ...tool, name: "search_repo" };
			const bridge = new CursorToolBridge([tool, other], () => undefined);
			const prefix = JSON.stringify(bridge.customTools);
			bridge.updateTools([other, tool]);
			assert.strictEqual(JSON.stringify(bridge.customTools), prefix, "Callback declaration order must survive a reloaded catalog");
			const config: AgentOptions = {
				apiKey: "offline-test-key", tools: ["mcp"], mcpServers: {}, agents: {},
				local: { cwd: root, store: new CursorNativeStore(new sdk.JsonlLocalAgentStore(root)).store, settingSources: [], customTools: bridge.customTools, autoReview: false },
			};
			const agent = await sdk.Agent.create(config);
			assert.ok(agent.agentId);
			agent.close();
			const restored = await sdk.Agent.resume(agent.agentId, { ...config, local: { ...config.local, store: new CursorNativeStore(new sdk.JsonlLocalAgentStore(root)).store } });
			assert.strictEqual(restored.agentId, agent.agentId); restored.close(); bridge.dispose();
		} finally { await fs.rm(root, { recursive: true, force: true }); }
	});

	test("starts a new request after historical Cursor results without reviving old tool sessions", async () => {
		const f = sdkFixture(), first: vscode.LanguageModelResponsePart[] = [], next: vscode.LanguageModelResponsePart[] = [];
		try {
			await f.sdk.respond(source, { id: "test" }, { text: "read" }, [user()], options, { report: part => first.push(part) }, none);
			const call = first.find(part => part instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart;
			const history = [user(), resultMessage(call.callId, "output")];
			await f.sdk.respond(source, { id: "test" }, { text: "unused" }, history, options, { report: () => undefined }, none);
			await f.sdk.respond(source, { id: "test" }, { text: "new request" }, [...history, vscode.LanguageModelChatMessage.Assistant("Done"), user()], options, { report: part => next.push(part) }, none);
			assert.strictEqual(f.created.length, 2);
			assert.ok(next.some(part => part instanceof vscode.LanguageModelToolCallPart));
		} finally { f.sdk.dispose(); }
	});

	test("denies a stale SDK callback after that tool disappears from the Copilot catalog", async () => {
		const bridge = new CursorToolBridge([tool], () => undefined);
		try {
			const stale = Object.values(bridge.customTools)[0];
			bridge.updateTools([]);
			assert.strictEqual(Object.keys(bridge.customTools).length, 0);
			await assert.rejects(async () => await stale.execute({ path: "old" }, {}), /no longer available/);
			assert.strictEqual(bridge.pendingCallIds.size, 0);
		} finally { bridge.dispose(); }
	});

	test("returns JSON attachments as text and preserves image bytes in callback results", async () => {
		const bridge = new CursorToolBridge([tool], () => undefined), parts: vscode.LanguageModelResponsePart[] = [], results: SDKCustomToolResult[] = [];
		try {
			await bridge.start(async () => { results.push(await Object.values(bridge.customTools)[0].execute({ path: "file" }, {})); }, { report: part => parts.push(part) }, none);
			const call = parts.find(part => part instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart;
			await bridge.resume([new vscode.LanguageModelToolResultPart(call.callId, [vscode.LanguageModelDataPart.text('{"ok":true}', "application/json"), vscode.LanguageModelDataPart.image(new Uint8Array([1, 2, 3]), "image/png")])], { report: () => undefined }, none);
			assert.deepStrictEqual(results, [{ content: [{ type: "text", text: '{"ok":true}' }, { type: "image", data: "AQID", mimeType: "image/png" }] }]);
		} finally { bridge.dispose(); }
	});
	test("advertises Tools and Vision, delegates to Copilot and resumes the same SDK run", async () => {
		const f = sdkFixture();
		const profile = new CursorProfileTransport(s => new CursorApiClient(s.apiKey!, s.serverUrl, async () => new Response(JSON.stringify({ items: [{ id: "test-model", displayName: "Test", parameters: [{ id: "reasoning_effort", values: [{ value: "low" }, { value: "high" }] }] }] }))), f.sdk);
		const thinkingOptions = { ...options, modelOptions: { ...options.modelOptions, reasoningEffort: "high" } };
		try {
			const [model] = await profile.models(source, none, "test");
			assert.strictEqual(model.capabilities.toolCalling, true); assert.strictEqual(model.capabilities.imageInput, true);
			const first: vscode.LanguageModelResponsePart[] = [];
			await profile.respond(source, "test-model", model, [user()], thinkingOptions, { report: part => first.push(part) }, none);
			const calls = first.filter((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart);
			assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0].name, "read_file"); assert.deepStrictEqual(calls[0].input, { path: "test.txt" });
			assert.deepStrictEqual(f.returned, []); assert.strictEqual(f.closed(), 0);
			assert.strictEqual(f.created[0].apiKey, source.apiKey);
			assert.deepStrictEqual(f.created[0].model?.params, [{ id: "reasoning_effort", value: "high" }]);
			assert.deepStrictEqual(f.created[0].tools, ["mcp"]); assert.deepStrictEqual(f.created[0].local?.settingSources, []);
			assert.deepStrictEqual(f.created[0].mcpServers, {}); assert.deepStrictEqual(f.created[0].agents, {});
			const second: vscode.LanguageModelResponsePart[] = [];
			await profile.respond(source, "test-model", model, [user(), resultMessage(calls[0].callId, "file contents")], thinkingOptions, { report: part => second.push(part) }, none);
			assert.strictEqual(f.created.length, 1); assert.strictEqual(f.closed(), 1); assert.strictEqual(f.cancelled(), 0);
			assert.deepStrictEqual(f.returned, [{ content: [{ type: "text", text: "file contents" }] }]);
			assert.strictEqual(second.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => (part as vscode.LanguageModelTextPart).value).join(""), "Read complete.");
		} finally { profile.dispose(); }
	});

	test("rejects continuation after the profile, key or conversation changes", async () => {
		for (const change of ["key", "profile", "conversation"]) {
			const f = sdkFixture(), parts: vscode.LanguageModelResponsePart[] = [];
			try {
				await f.sdk.respond(source, { id: "test" }, { text: "read" }, [user()], options, { report: part => parts.push(part) }, none);
				const call = parts.find(part => part instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart;
				const changedSource = change === "key" ? { ...source, apiKey: "different-key" } : change === "profile" ? { ...source, key: "api-other-profile" } : source;
				const changedOptions = change === "conversation" ? { ...options, modelOptions: { _copilotConversationId: "chat-two" } } : options;
				await assert.rejects(f.sdk.respond(changedSource, { id: "test" }, { text: "" }, [resultMessage(call.callId, "output")], changedOptions, { report: () => undefined }, none), /changed during tool execution/);
				assert.strictEqual(f.created.length, 1); assert.strictEqual(f.closed(), 1); assert.deepStrictEqual(f.returned, []);
			} finally { f.sdk.dispose(); }
		}
	});

	test("cancelled waiting tool calls stop the SDK run and reject stale results", async () => {
		const f = sdkFixture(), cancellation = new vscode.CancellationTokenSource(), parts: vscode.LanguageModelResponsePart[] = [];
		try {
			await f.sdk.respond(source, { id: "test" }, { text: "read" }, [user()], options, { report: part => parts.push(part) }, cancellation.token);
			const call = parts.find(part => part instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart;
			cancellation.cancel();
			assert.strictEqual(f.closed(), 1); assert.strictEqual(f.cancelled(), 1);
			await assert.rejects(f.sdk.respond(source, { id: "test" }, { text: "" }, [resultMessage(call.callId, "stale")], options, { report: () => undefined }, none), /no longer active/);
			assert.deepStrictEqual(f.returned, []);
		} finally { cancellation.dispose(); f.sdk.dispose(); }
	});

	test("parallel callbacks are reported once and wait for every native result", async () => {
		const stop = { count: 0 }, bridge = new CursorToolBridge([tool], () => { stop.count++; });
		const parts: vscode.LanguageModelResponsePart[] = [], callback = Object.values(bridge.customTools)[0];
		const batches: SDKCustomToolResult[][] = [];
		try {
			await bridge.start(async () => { batches.push(await Promise.all([callback.execute({ path: "one" }, {}), callback.execute({ path: "two" }, {})])); }, { report: part => parts.push(part) }, none);
			const calls = parts.filter((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart);
			assert.strictEqual(calls.length, 2); assert.notStrictEqual(calls[0].callId, calls[1].callId); assert.strictEqual(batches.length, 0);
			await bridge.resume(calls.map(call => new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(String((call.input as { path: string }).path))])), { report: part => parts.push(part) }, none);
			assert.strictEqual(batches[0].length, 2); assert.strictEqual(parts.filter(part => part instanceof vscode.LanguageModelToolCallPart).length, 2); assert.strictEqual(stop.count, 1);
		} finally { bridge.dispose(); }
	});

	test("partial tool batches fail without delivering any result to the SDK", async () => {
		const bridge = new CursorToolBridge([tool], () => undefined), parts: vscode.LanguageModelResponsePart[] = [];
		let delivered = false;
		try {
			const callback = Object.values(bridge.customTools)[0];
			await bridge.start(async () => { await Promise.all([callback.execute({ path: "one" }, {}), callback.execute({ path: "two" }, {})]); delivered = true; }, { report: part => parts.push(part) }, none);
			const call = parts.find(part => part instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart;
			await assert.rejects(bridge.resume([new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart("one")])], { report: () => undefined }, none), /every tool result/);
			assert.strictEqual(delivered, false); assert.ok(bridge.isTerminal);
		} finally { bridge.dispose(); }
	});

	test("refresh closes pending SDK sessions and required mode cannot succeed without a tool", async () => {
		const f = sdkFixture(), parts: vscode.LanguageModelResponsePart[] = [];
		try {
			await f.sdk.respond(source, { id: "test" }, { text: "read" }, [user()], options, { report: part => parts.push(part) }, none);
			f.sdk.refresh(); assert.strictEqual(f.closed(), 1);
		} finally { f.sdk.dispose(); }
		const bridge = new CursorToolBridge([tool], () => undefined, true);
		await assert.rejects(bridge.start(async () => undefined, { report: () => undefined }, none), /no required tool call/);
	});
});