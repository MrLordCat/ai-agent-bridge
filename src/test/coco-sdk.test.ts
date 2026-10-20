import * as assert from "node:assert";
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CocoSessionStore } from "../coco/session-store";
import { createHash } from "node:crypto";
import { CocoTurnBridge } from "../coco/turn-bridge";
import { CocoChatModelProvider, resolveCocoCli, resolveCocoConnection } from "../coco/coco-provider";
import { mapCocoModel } from "../coco/model-adapter";
import { CocoSdkClient, cocoSdkAvailable, cocoSdkError, type CocoSdkDependencies, type CocoSdkSession } from "../coco/sdk-client";
import type { CocoAcpHandlers } from "../coco/acp-client";
import { parseCocoTokenUsage } from "../coco/usage-adapter";

type Options = Parameters<NonNullable<CocoSdkDependencies["createSession"]>>[0];
class Events {
	private values: unknown[] = [];
	private wake?: () => void;
	private ended = false;
	push(value: unknown) { this.values.push(value); this.wake?.(); }
	end() { this.ended = true; this.wake?.(); }
	async *stream() { while (!this.ended || this.values.length) { if (this.values.length) { yield this.values.shift(); } else { await new Promise<void>(resolve => { this.wake = resolve; }); this.wake = undefined; } } }
}
function fixture(handlers: CocoAcpHandlers = {}) {
	const starts: Options[] = [], inputs: Array<Record<string, unknown>> = [], updates: Record<string, unknown>[] = [];
	let onSend: ((config: Options, queue: Events) => Promise<void>) | undefined, failStart = false, closes = 0;
	const dependencies: CocoSdkDependencies = { createSession: async config => {
		starts.push(config); if (failStart) { throw new Error("fixture initialization failed"); }
		const queue = new Events(); let count = 0;
		const session: CocoSdkSession = { stream: () => queue.stream(), interrupt: async () => { queue.end(); }, close: async () => { closes++; queue.end(); },
			send: async message => {
				inputs.push(message as unknown as Record<string, unknown>);
				void Promise.resolve().then(async () => {
					await onSend?.(config, queue); count++;
					queue.push({ type: "stream_event", event: { delta: { type: "text_delta", text: "ANSWER" } } });
					queue.push({ type: "assistant", message: { content: [{ type: "text", text: "ANSWER" }] } });
					queue.push({ type: "result", subtype: "success", usage: { input_tokens: 10 * count, output_tokens: 2 * count, cache_read_input_tokens: 90 * count, cache_creation_input_tokens: 5 * count } });
				}).catch(error => queue.push({ type: "result", subtype: "error_during_execution", errors: [error.message] }));
			} };
		return session;
	} };
	const make = () => new CocoSdkClient("fixture-cli", "/workspace", "fixture-connection", "claude-opus-5-5", { ...handlers, onUpdate: update => { updates.push(update); handlers.onUpdate?.(update); } }, dependencies);
	return { starts, inputs, updates, make, dependencies, onSend: (callback: NonNullable<typeof onSend>) => { onSend = callback; }, fail: () => { failStart = true; }, closes: () => closes };
}
const tool = { name: "vscode_chat_read_test", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } } } };

suite("Coco native SDK", () => {
	test("live Chat callback survives a 35-second tool wait on the selected native transport", async function () {
		if (process.env.AAB_COCO_LIVE_CALLBACKS !== "1") { this.skip(); return; }
		this.timeout(180000);
		const cli = process.env.AAB_COCO_LIVE_CLI ?? resolveCocoCli(); assert.ok(cli);
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "coco-live-callback-"));
		const provider = new CocoChatModelProvider({ storageRoot: root, isEnabled: () => true, resolveCli: () => cli, resolveConnection: resolveCocoConnection });
		const cancellation = new vscode.CancellationTokenSource(), marker = `VS_CODE_MARKER_${createHash("sha256").update(root).digest("hex")}`;
		const messages = [vscode.LanguageModelChatMessage.User("Diagnostic only. Call the supplied diagnostic_probe tool exactly once. Wait for its result and reply only with its returned marker. Use no other tools; do not repeat or invent results.")];
		const model = mapCocoModel({ id: "claude-opus-5-5", name: "Opus" }, 1000000);
		const options = { toolMode: vscode.LanguageModelChatToolMode.Auto, tools: [{ name: "diagnostic_probe", description: "Return an inert diagnostic marker. No side effects.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }], modelOptions: { _copilotConversationId: "live-slow-native-callback" } };
		const first: vscode.LanguageModelResponsePart[] = [], second: vscode.LanguageModelResponsePart[] = [];
		const timer = setTimeout(() => cancellation.cancel(), 150000);
		try {
			await provider.provideLanguageModelChatResponse(model, messages, options, { report: part => first.push(part) }, cancellation.token);
			const calls = first.filter((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart);
			assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0].name, "diagnostic_probe");
			await new Promise<void>(resolve => setTimeout(resolve, 35000));
			await provider.provideLanguageModelChatResponse(model, [...messages, vscode.LanguageModelChatMessage.Assistant([calls[0]]), vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(calls[0].callId, [new vscode.LanguageModelTextPart(marker)])])], options, { report: part => second.push(part) }, cancellation.token);
			const answer = second.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart).map(part => part.value).join("");
			assert.ok(answer.includes(marker)); assert.ok(!second.some(part => part instanceof vscode.LanguageModelToolCallPart));
			console.log(JSON.stringify({ liveCocoChatCallback: true, toolWaitMs: 35000, markerReceived: true, nativeTurnCompleted: true }));
		} finally { clearTimeout(timer); cancellation.cancel(); provider.dispose(); cancellation.dispose(); await fs.rm(root, { recursive: true, force: true }); }
	});
	test("rebinds a completed SDK session to ACP tools without replaying its history", async () => {
		const store = new CocoSessionStore(), loaded: string[] = [];
		let closed = 0, exited = 0;
		const identity = CocoSessionStore.identity("cli", "/workspace", "connection", "model");
		const anchors = [{ key: createHash("sha256").update("first").digest("hex"), index: 0 }];
		const sdk = { transport: "sdk" as const, initialize: async () => ({ agentCapabilities: { loadSession: true } }),
			newSession: async () => ({ sessionId: "same-native-id" }), loadSession: async () => ({}),
			setSessionConfigOption: async () => ({}), prompt: async () => ({}), cancel: () => undefined,
			dispose: () => { closed++; }, waitForExit: async () => { exited++; } };
		const acp = { ...sdk, transport: "acp" as const, dispose: () => undefined,
			loadSession: async (id: string) => { loaded.push(id); return { sessionId: id }; } };
		try {
			const first = await store.acquire(identity, "chat", anchors, () => sdk, {});
			await store.prepare(first, "/workspace", []); await store.checkpoint(first, anchors); store.finish(first);
			const nextAnchors = [...anchors, { key: createHash("sha256").update("second").digest("hex"), index: 2 }];
			const next = await store.acquire(identity, "chat", nextAnchors, () => acp, {}, [], true);
			await store.prepare(next, "/workspace", [tool]);
			assert.deepStrictEqual(loaded, ["same-native-id"]); assert.strictEqual(next.fresh, false);
			assert.strictEqual(next.deltaStart, 2); assert.strictEqual(next.client.transport, "acp");
			assert.strictEqual(closed, 1); assert.strictEqual(exited, 1);
		} finally { store.dispose(); }
	});
	test("logs request bounds without the private prompt",async () => {
		const f = fixture(), events: unknown[] = [];
		const provider = new CocoChatModelProvider({isEnabled:() => true,resolveCli:() => "fixture-cli",log:(event,data) => events.push({event,data}),
			createSessionClient:(exe,cwd,connection,model,handlers) => new CocoSdkClient(exe,cwd,connection,model,handlers,f.dependencies)});
		const source = new vscode.CancellationTokenSource();
		try {
			await provider.provideLanguageModelChatResponse(mapCocoModel({id:"claude-opus-5-5",name:"Opus"},1_000_000),[vscode.LanguageModelChatMessage.User("PRIVATE_DIAGNOSTIC_PROMPT")],
				{toolMode:vscode.LanguageModelChatToolMode.Auto,tools:[{name:"configure_python_environment",description:"Python",inputSchema:{type:"object"}}]}, {report:() => undefined},source.token);
			const recorded = events as Array<{event:string;data:Record<string,unknown>}>;
			assert.strictEqual(recorded[0].event,"coco.request.prepared"); assert.strictEqual(recorded[0].data.maxSdkWireToolNameLength,64);
			assert.strictEqual(recorded[0].data.toolCount,1); assert.ok(!JSON.stringify(events).includes("PRIVATE_DIAGNOSTIC_PROMPT"));
		} finally {source.cancel();provider.dispose();source.dispose();}
	});
	test("invalid fully qualified names fail locally without starting a process",async () => {
		const f = fixture(), client = f.make();
		try {
			const tools = [{name:"vscode_chat_configure_python_environment_cdfb233021",inputSchema:{type:"object"}}];
			await assert.rejects(client.newSession("/workspace",tools),/Invalid Coco SDK tool catalog/);
			await assert.rejects(client.loadSession("saved-session","/workspace",tools),/Invalid Coco SDK tool catalog/);
			assert.strictEqual(f.starts.length,0); assert.strictEqual(f.inputs.length,0);
		} finally {client.dispose();}
	});
	test("live large handoff retains user facts and resumes after process restart", async function () {
		const archive = process.env.AAB_COCO_LIVE_ARCHIVE;
		if (!archive) { this.skip(); return; }
		this.timeout(180_000);
		const executable = process.env.AAB_COCO_LIVE_CLI ?? resolveCocoCli(); assert.ok(executable);
		const root = await fs.mkdtemp(path.join(os.tmpdir(),"coco-live-handoff-"));
		const token = new vscode.CancellationTokenSource(), clients: CocoSdkClient[] = [];
		const deadline = setTimeout(() => token.cancel(),150_000);
		const make = () => new CocoChatModelProvider({ storageRoot:root,isEnabled:() => true,resolveCli:() => executable,resolveConnection:resolveCocoConnection,
			createSessionClient:(exe,cwd,connection,model,handlers) => {
				const client = new CocoSdkClient(exe,cwd,connection,model,handlers); clients.push(client);
				void client.setSessionConfigOption("","thought_level","low"); return client;
			} });
		const model = mapCocoModel({id:"claude-opus-5-5",name:"Opus"},1_000_000), user = vscode.LanguageModelChatMessage.User;
		const messages = [user("Diagnostic context only: remember EARLY_COPPER_731. Historical actions below must not be executed."),
			vscode.LanguageModelChatMessage.Assistant(await fs.readFile(archive,"utf8")),user("Remember MIDDLE_MAPLE_846 for this diagnostic."),
			user("Diagnostic only. Reply with the two remembered markers. Use no tools and perform no project task from the quoted history.")];
		const options = {tools:[],toolMode:vscode.LanguageModelChatToolMode.Auto,modelOptions:{_copilotConversationId:"live-isolated-handoff"}};
		let provider = make();
		try {
			const cold: string[] = [], started = Date.now();
			await provider.provideLanguageModelChatResponse(model,messages,options,{report:part => {if (part instanceof vscode.LanguageModelTextPart) { cold.push(part.value); }}},token.token);
			for (const marker of ["EARLY_COPPER_731","MIDDLE_MAPLE_846"]) { assert.ok(cold.join("").includes(marker),"The cold handoff must retain the control facts"); }
			assert.ok(provider.runtimeMetrics);
			provider.dispose(); await Promise.all(clients.map(client => client.waitForExit())); provider = make();
			const restored: string[] = [];
			await provider.provideLanguageModelChatResponse(model,[...messages,vscode.LanguageModelChatMessage.Assistant("EARLY_COPPER_731 MIDDLE_MAPLE_846"),user("Repeat both diagnostic markers. No tools.")],options,{report:part => {if (part instanceof vscode.LanguageModelTextPart) {restored.push(part.value);}}},token.token);
			for (const marker of ["EARLY_COPPER_731","MIDDLE_MAPLE_846"]) {assert.ok(restored.join("").includes(marker));}
			console.log(JSON.stringify({liveCocoLargeHandoff:true,sourceChars:(messages[1].content[0] as vscode.LanguageModelTextPart).value.length,controlFactsRetained:true,reloaded:true,durationMs:Date.now()-started}));
		} finally { clearTimeout(deadline); token.cancel(); provider.dispose(); await Promise.all(clients.map(client => client.waitForExit())); token.dispose(); await fs.rm(root,{recursive:true,force:true}); }
	});
	test("a large handoff reaches SDK once and reload sends only the next native turn", async () => {
		const f = fixture(), values = new Map<string, unknown>();
		const state = { keys: () => [...values.keys()], get: (key: string, fallback?: unknown) => values.get(key) ?? fallback,
			update: async (key: string, value: unknown) => { values.set(key, value); } } as vscode.Memento;
		const make = () => new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "fixture-cli", resolveConnection: () => "fixture-connection", state,
			createSessionClient: (exe, cwd, connection, model, handlers) => new CocoSdkClient(exe, cwd, connection, model, handlers, f.dependencies) });
		const model = mapCocoModel({ id: "claude-opus-5-5", name: "Opus" }, 1_000_000), user = vscode.LanguageModelChatMessage.User;
		const history = "BEGIN_FINDING" + "x".repeat(3_045_543) + "END_FINDING";
		const messages = [user("FIRST_RULE"), vscode.LanguageModelChatMessage.Assistant(history), user("CURRENT_TASK")];
		const config = { toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _copilotConversationId: "large-sdk-handoff" } };
		const token: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined) };
		let provider = make();
		try {
			await provider.provideLanguageModelChatResponse(model, messages, config, { report: () => undefined }, token);
			const content = (f.inputs[0].message as { content: Array<{ text: string }> }).content.map(part => part.text).join("");
			assert.strictEqual(f.inputs.length, 1); assert.ok(content.length < 1_000_000); assert.match(content,/BEGIN_FINDING/); assert.match(content, /CURRENT_TASK/);
			provider.dispose(); provider = make();
			await provider.provideLanguageModelChatResponse(model, [...messages, vscode.LanguageModelChatMessage.Assistant("ANSWER"), user("NEXT_TASK")], config, { report: () => undefined }, token);
			assert.strictEqual(f.inputs.length, 2); assert.strictEqual(f.starts[1].resume, f.starts[0].sessionId);
			const next = JSON.stringify(f.inputs[1]); assert.match(next, /NEXT_TASK/); assert.ok(!next.includes("BEGIN_FINDING")); assert.ok(next.length < 10_000);
		} finally { provider.dispose(); }
	});
	test("an unconfirmed historical native call cannot silently execute again", async () => {
		const tool = { name:"fixture_read", description:"Read",inputSchema:{type:"object"} };
		const bridge = new CocoTurnBridge([tool],() => undefined), nativeId = "UNCONFIRMED_NATIVE_ID";
		const id = `coco-${createHash("sha256").update(nativeId).digest("hex")}`;
		bridge.rememberResults([vscode.LanguageModelChatMessage.Assistant([new vscode.LanguageModelToolCallPart(id,tool.name,{})])]);
		try { await assert.rejects(bridge.delegate(String(bridge.clientTools[0].name),{},nativeId),/completion is unknown/); }
		finally { bridge.dispose(); }
	});
	test("loads lazily and separates fixed policy from the new user message", async () => {
		const f = fixture(), client = f.make();
		try {
			const { sessionId } = await client.newSession("/workspace", [tool]); assert.strictEqual(f.starts.length, 0);
			await client.setSessionConfigOption(String(sessionId), "thinking", "high");
			await client.prompt(String(sessionId), "LATEST_REQUEST");
			assert.strictEqual(f.starts.length, 1); assert.strictEqual(f.starts[0].sessionId, sessionId); assert.strictEqual(f.starts[0].effort, "high");
			assert.match(f.starts[0].appendSystemPrompt!, /VS Code Chat/); assert.ok(!JSON.stringify(f.inputs[0]).includes("All actions"));
			assert.deepStrictEqual(f.updates.filter(update => update.sessionUpdate === "agent_message_chunk").map(update => (update.content as { text: string }).text), ["ANSWER"]);
		} finally { client.dispose(); }
	});
	test("reuses a process and reports each increment of cumulative native usage once", async () => {
		const f = fixture(), client = f.make();
		try {
			const id = String((await client.newSession("/workspace")).sessionId);
			const first = await client.prompt(id, "FIRST"), second = await client.prompt(id, "SECOND");
			assert.strictEqual(f.starts.length, 1); assert.deepStrictEqual(parseCocoTokenUsage(first), parseCocoTokenUsage(second));
			assert.strictEqual(parseCocoTokenUsage(second)?.inputTokens, 105);
		} finally { client.dispose(); }
	});
	test("restores the exact native session and refreshes tools without sending historical prompts", async () => {
		const f = fixture(), first = f.make(); const id = String((await first.newSession("/workspace", [tool])).sessionId);
		await first.prompt(id, "FIRST"); first.dispose();
		const restored = f.make();
		try {
			await restored.loadSession(id, "/workspace", [{ ...tool, description: "Updated catalog" }]); await restored.prompt(id, "NEXT");
			assert.strictEqual(f.starts[1].resume, id); assert.strictEqual(f.inputs.length, 2); assert.ok(!JSON.stringify(f.inputs[1]).includes("FIRST"));
		} finally { restored.dispose(); }
	});
	test("routes callback tools with native identities and blocks internal operations", async () => {
		const calls: unknown[] = [], f = fixture({ onClientTool: async (name, input, id) => { calls.push({ name, input, id }); return { output: "FILE" }; } }), client = f.make();
		f.onSend(async config => {
			const callback = config.hooks!.PreToolUse![0].hooks[0];
			const base = { session_id: config.sessionId!, transcript_path: "fixture", cwd: "/workspace", permission_mode: "default" };
			const denied = await callback({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "unsafe" } }, "native-block", {});
			assert.strictEqual((denied as { decision: string }).decision, "block");
			assert.strictEqual((await config.canUseTool!("Bash", {}, { signal: new AbortController().signal, toolUseID: "native-block", suggestions: [] })).behavior, "deny");
			const permission = { signal: new AbortController().signal, toolUseID: "permission-request", suggestions: [] };
			assert.strictEqual((await config.canUseTool!("MCP", { action: "execute_command", resource: `mcp__vscode_chat__${tool.name}\nInput: {}` }, permission)).behavior, "allow");
			assert.strictEqual((await config.canUseTool!("MCP", { action: "execute_command", resource: `mcp__other__${tool.name}` }, permission)).behavior, "deny");
			await callback({ ...base, hook_event_name: "PreToolUse", tool_name: `mcp__vscode_chat__${tool.name}`, tool_input: { path: "test" }, tool_use_id: "native-call" }, "native-call", {});
			const server = config.mcpServers!.vscode_chat as unknown as { _toolDefinitions: Array<{ handler(input: unknown): Promise<unknown> }> };
			await server._toolDefinitions[0].handler({ path: "test" });
		});
		try { const id = String((await client.newSession("/workspace", [tool])).sessionId); await client.prompt(id, "Read"); assert.deepStrictEqual(calls, [{ name: tool.name, input: { path: "test" }, id: "native-call" }]); }
		finally { client.dispose(); }
	});
	test("keeps image bytes in native content blocks", async () => {
		const f = fixture(); let received: unknown, loaded: string | undefined;
		const updates: unknown[] = [];
		const client = new CocoSdkClient("fixture-cli","/workspace",undefined,undefined,{ onUpdate: update => updates.push(update) }, { ...f.dependencies, createVisionClient: handlers => ({
			initialize: async () => ({ agentCapabilities: { loadSession:true,promptCapabilities:{image:true} } }),
			newSession: async () => { throw new Error("A warm image must load its existing session"); }, loadSession: async id => { loaded=id; handlers.onUpdate?.({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"OLD_REPLAY"}}); return {}; },
			setSessionConfigOption: async () => ({}), prompt: async (_id,prompt) => { received=prompt; return {stopReason:"end_turn"}; }, cancel: () => undefined, dispose: () => undefined,
		}) });
		try {
			const id = String((await client.newSession("/workspace")).sessionId); await client.prompt(id,"FIRST");
			await client.prompt(id, [{ type: "text", text: "Image" }, { type: "image", data: "AQID", mimeType: "image/png" }]);
			assert.strictEqual(loaded,id); assert.ok(JSON.stringify(received).includes('"data":"AQID"'));
			assert.ok(!JSON.stringify(updates).includes("OLD_REPLAY"));
			await client.prompt(id,"AFTER_IMAGE"); assert.strictEqual(f.starts[1].resume,id);
		} finally { client.dispose(); }
	});
	test("initialization failure sends no model input and never falls back to a fresh session", async () => {
		const f = fixture(), client = f.make(); f.fail();
		try {
			await client.loadSession("native-saved-id", "/workspace"); await assert.rejects(client.prompt("native-saved-id", "NEXT"), /initialization failed/);
			assert.strictEqual(client.lastPromptSent, false); assert.strictEqual(f.inputs.length, 0); assert.strictEqual(f.starts[0].resume, "native-saved-id");
		} finally { client.dispose(); }
	});
	test("guards SDK loading on older extension hosts", () => {
		assert.strictEqual(cocoSdkAvailable("20.19.0"), false); assert.strictEqual(cocoSdkAvailable("22.21.0"), false);
		assert.strictEqual(cocoSdkAvailable("22.22.0"), true); assert.strictEqual(cocoSdkAvailable("24.0.0"), true);
	});
	test("does not let partial thinking suppress a completed text response", async () => {
		const f = fixture(), client = f.make();
		f.onSend(async (_options, queue) => {
			queue.push({ type: "stream_event", event: { delta: { type: "thinking_delta", thinking: "THOUGHT" } } });
			queue.push({ type: "assistant", message: { content: [{ type: "thinking", thinking: "THOUGHT" }, { type: "text", text: "FINAL_TEXT" }] } });
		});
		try { const id = String((await client.newSession("/workspace")).sessionId); await client.prompt(id, "Task");
			assert.strictEqual(f.updates.filter(u => u.sessionUpdate === "agent_thought_chunk").length, 1);
			assert.ok(JSON.stringify(f.updates).includes("FINAL_TEXT"));
		} finally { client.dispose(); }
	});
	test("redacts startup and execution secrets without exposing credential-bearing causes", () => {
		const error = cocoSdkError(new Error('authorization: Bearer hidden-token api_key="private-key" access_token=private-token'));
		assert.ok(!/hidden-token|private-key|private-token/.test(error.message)); assert.strictEqual(error.cause, undefined);
	});
	for (const interrupted of [false, true]) {
		test(interrupted ? "an interrupted callback resumes on a new user turn without replaying its request" : "SDK callbacks traverse native Chat once and keep the same process on the next turn", async () => {
			const f = fixture(), values = new Map<string, unknown>();
			const state = { keys: () => [...values.keys()], get: (key: string, fallback?: unknown) => values.get(key) ?? fallback, update: async (key: string, value: unknown) => { values.set(key,value); } } as vscode.Memento;
			const make = () => new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "fixture-cli", state,
				createSessionClient: (exe,cwd,connection,model,handlers) => new CocoSdkClient(exe,cwd,connection,model,handlers,f.dependencies) });
			const model = mapCocoModel({ id: "claude-opus-5-5", name: "Opus" },1_000_000), user = vscode.LanguageModelChatMessage.User;
			const first = user("FIRST_NATIVE_TASK"), tools = [{ name: "fixture_read", description: "Read", inputSchema: { type: "object" } }];
			const config = { tools, toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _copilotConversationId: `sdk-chat-${interrupted}` } };
			const token: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined) };
			const requestTool = async (config: Options) => {
				const server = config.mcpServers!.vscode_chat as unknown as { _toolDefinitions: Array<{ name: string; handler(input: unknown): Promise<unknown> }> };
				const tool = server._toolDefinitions.find(tool => tool.name.includes("fixture_read"))!;
				await config.hooks!.PreToolUse![0].hooks[0]({ session_id: config.sessionId!, transcript_path: "fixture", cwd: config.cwd!, permission_mode: "default", hook_event_name: "PreToolUse", tool_name: tool.name, tool_input: {}, tool_use_id: "NATIVE_ONCE" },"NATIVE_ONCE",{});
				await tool.handler({});
			}; f.onSend(requestTool);
			let provider = make(); const emitted: vscode.LanguageModelResponsePart[] = [];
			try {
				await provider.provideLanguageModelChatResponse(model,[first],config,{ report: part => emitted.push(part) },token);
				const call = emitted.find(part => part instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart;
				assert.ok(call); assert.match(call.callId,/^coco-[a-f0-9]{64}$/); assert.strictEqual(f.inputs.length,1);
				if (interrupted) { provider.dispose(); provider = make(); }
				else {
					await provider.provideLanguageModelChatResponse(model,[first,user([new vscode.LanguageModelToolResultPart(call.callId,[new vscode.LanguageModelTextPart("FILE")])])],config,{ report: part => emitted.push(part) },token);
					assert.strictEqual(f.inputs.length,1); assert.ok(emitted.some(part => part instanceof vscode.LanguageModelTextPart && part.value === "ANSWER"));
				}
				f.onSend(requestTool); const later: vscode.LanguageModelResponsePart[] = [];
				await provider.provideLanguageModelChatResponse(model,[first,user([new vscode.LanguageModelToolResultPart(call.callId,[new vscode.LanguageModelTextPart("FILE")])]),vscode.LanguageModelChatMessage.Assistant("Previous turn"),user("NEXT_NATIVE_TASK")],config,{ report: part => later.push(part) },token);
				assert.ok(!later.some(part => part instanceof vscode.LanguageModelToolCallPart),"A completed native callback must not be executed twice");
				assert.strictEqual(f.inputs.length,2); assert.ok(!JSON.stringify(f.inputs[1]).includes("FIRST_NATIVE_TASK"));
				assert.strictEqual(f.starts.length,interrupted ? 2 : 1);
				if (interrupted) { assert.strictEqual(f.starts[1].resume,f.starts[0].sessionId); }
			} finally { provider.dispose(); }
		});
	}
});