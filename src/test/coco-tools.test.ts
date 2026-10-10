import * as assert from "node:assert";
import * as vscode from "vscode";
import { CocoAcpClient } from "../coco/acp-client";
import { CocoChatModelProvider } from "../coco/coco-provider";
import { mapCocoModel } from "../coco/model-adapter";
import { CocoTurnBridge, collectCocoToolResults, convertCocoToolResult } from "../coco/turn-bridge";

suite("Coco native Chat tools", () => {
	const model = mapCocoModel({ id: "auto", name: "Auto" });
	const tool: vscode.LanguageModelChatTool = {
		name: "private_command", description: "Execute a command in the caller's Chat context.",
		inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
	};
	const options = { toolMode: vscode.LanguageModelChatToolMode.Auto, tools: [tool] };
	const result = (call: vscode.LanguageModelToolCallPart, text: string) => new vscode.LanguageModelToolResultPart(
		call.callId, [new vscode.LanguageModelTextPart(text)]
	);
	const continuation = (call: vscode.LanguageModelToolCallPart, text: string) => [
		vscode.LanguageModelChatMessage.Assistant([call]), vscode.LanguageModelChatMessage.User([result(call, text)]),
	];
	const callFrom = (parts: vscode.LanguageModelResponsePart[]) => {
		const call = parts.find((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart);
		assert.ok(call, "Chat must receive a native tool-call part");
		return call;
	};

	test("delegates private tools and resumes two steps in the same ACP prompt", async () => {
		let clients = 0, prompts = 0, sessions = 0, disposed = false;
		const received: unknown[] = [];
		const provider = new CocoChatModelProvider({
			isEnabled: () => true, resolveCli: () => "mock-cli",
			createClient: (_exe, _cwd, _connection, _model, handlers) => {
				clients++;
				let alias = "";
				return {
					initialize: async () => undefined,
					newSession: async (_cwd: string, tools: Array<Record<string, unknown>>) => {
						sessions++;
						assert.strictEqual(tools.length, 1, "private tools must survive catalog filtering");
						alias = String(tools[0].name);
						return { sessionId: "session" };
					},
					prompt: async (_sessionId: string, prompt: string) => {
						prompts++;
						assert.match(prompt, /All actions must use the supplied vscode_chat_/);
						for (const command of ["first", "second"]) {
							handlers?.onUpdate?.({ sessionUpdate: "tool_call", title: alias, kind: "other" });
							received.push(await handlers?.onClientTool?.(alias, { command }));
						}
						handlers?.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } });
						return { stopReason: "end_turn" };
					},
					cancel: () => undefined, dispose: () => { disposed = true; },
				} as unknown as CocoAcpClient;
			},
		});
		const firstToken = new vscode.CancellationTokenSource();
		const laterToken = new vscode.CancellationTokenSource();
		try {
			const first: vscode.LanguageModelResponsePart[] = [];
			await provider.provideLanguageModelChatResponse(model, [vscode.LanguageModelChatMessage.User("Run two commands")], options,
				{ report: part => first.push(part) }, firstToken.token);
			const firstCall = callFrom(first);
			assert.strictEqual(firstCall.name, tool.name);
			assert.deepStrictEqual(firstCall.input, { command: "first" });
			assert.strictEqual(disposed, false, "the prompt must remain suspended while Chat runs the tool");
			firstToken.cancel(); // Ending a response segment must not cancel its suspended prompt.
			const second: vscode.LanguageModelResponsePart[] = [];
			await provider.provideLanguageModelChatResponse(model, continuation(firstCall, "Denied by Chat"), options,
				{ report: part => second.push(part) }, laterToken.token);
			const secondCall = callFrom(second);
			assert.notStrictEqual(secondCall.callId, firstCall.callId);
			assert.deepStrictEqual(secondCall.input, { command: "second" });
			const final: vscode.LanguageModelResponsePart[] = [];
			await provider.provideLanguageModelChatResponse(model, continuation(secondCall, "Output from Chat"), options,
				{ report: part => final.push(part) }, laterToken.token);
			assert.deepStrictEqual(received, [{ output: "Denied by Chat" }, { output: "Output from Chat" }]);
			assert.strictEqual((final[0] as vscode.LanguageModelTextPart).value, "Done");
			assert.strictEqual(clients, 1); assert.strictEqual(sessions, 1); assert.strictEqual(prompts, 1);
			assert.strictEqual(disposed, true);
		} finally { firstToken.dispose(); laterToken.dispose(); provider.dispose(); }
	});

	test("queues late parallel calls and text until the next Chat segment without duplicates", async () => {
		let stopped = false;
		const bridge = new CocoTurnBridge([tool], () => { stopped = true; });
		const token = new vscode.CancellationTokenSource();
		let finish!: () => void;
		const operation = new Promise<void>(resolve => { finish = resolve; });
		try {
			const first: vscode.LanguageModelResponsePart[] = [];
			const segment = bridge.start(() => operation, { report: part => first.push(part) }, token.token);
			const firstResponse = bridge.delegate(String(bridge.clientTools[0].name), { command: "first" });
			await segment;
			bridge.accept({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Queued text" } });
			const secondResponse = bridge.delegate(String(bridge.clientTools[0].name), { command: "parallel" });
			const next: vscode.LanguageModelResponsePart[] = [];
			await bridge.resume([result(callFrom(first), "First output")], { report: part => next.push(part) }, token.token);
			assert.deepStrictEqual(await firstResponse, { output: "First output" });
			assert.strictEqual(next.filter(part => part instanceof vscode.LanguageModelToolCallPart).length, 1);
			assert.strictEqual((next[0] as vscode.LanguageModelTextPart).value, "Queued text");
			const last = bridge.resume([result(callFrom(next), "Second output")], { report: () => undefined }, token.token);
			assert.deepStrictEqual(await secondResponse, { output: "Second output" });
			finish(); await last;
			assert.ok(stopped);
		} finally { bridge.dispose(); token.dispose(); finish(); }
	});

	test("fails an incomplete batch instead of waiting indefinitely or executing a tool twice", async () => {
		const bridge = new CocoTurnBridge([tool], () => undefined);
		const token = new vscode.CancellationTokenSource();
		try {
			const parts: vscode.LanguageModelResponsePart[] = [];
			const segment = bridge.start(() => new Promise(() => undefined), { report: part => parts.push(part) }, token.token);
			const alias = String(bridge.clientTools[0].name);
			const replies = [bridge.delegate(alias, { command: "one" }), bridge.delegate(alias, { command: "two" })];
			await segment;
			await assert.rejects(bridge.resume([result(callFrom(parts), "Only one result")], { report: () => undefined }, token.token), /every Chat tool call/);
			assert.ok((await Promise.all(replies)).every(reply => reply.error));
		} finally { bridge.dispose(); token.dispose(); }
	});

	test("stops built-in tool events instead of allowing invisible execution", async () => {
		let stopped = 0;
		const bridge = new CocoTurnBridge([tool], () => { stopped++; });
		const token = new vscode.CancellationTokenSource();
		try {
			const segment = bridge.start(async () => {
				bridge.accept({ sessionUpdate: "tool_call", title: "bash", kind: "execute", rawInput: { command: "hidden" } });
			}, { report: () => undefined }, token.token);
			await assert.rejects(segment, /internal action.*bash/);
			assert.strictEqual(stopped, 1);
		} finally { bridge.dispose(); token.dispose(); }
	});

	test("stops ACP permission requests and closes the CLI without opening a separate approval flow", async () => {
		let disposed = false;
		const provider = new CocoChatModelProvider({
			isEnabled: () => true, resolveCli: () => "mock-cli",
			createClient: (_exe, _cwd, _connection, _model, handlers) => ({
				initialize: async () => undefined, newSession: async () => ({ sessionId: "session" }),
				prompt: async () => { await handlers?.onPermission?.({ toolCall: { title: "Internal command" }, options: [{ optionId: "yes", kind: "allow_always" }] }); },
				cancel: () => undefined, dispose: () => { disposed = true; },
			}) as unknown as CocoAcpClient,
		});
		const token = new vscode.CancellationTokenSource();
		try {
			await assert.rejects(provider.provideLanguageModelChatResponse(model, [vscode.LanguageModelChatMessage.User("Command")],
				options, { report: () => undefined }, token.token), /internal action.*Internal command/);
			assert.ok(disposed);
		} finally { provider.dispose(); token.dispose(); }
	});

	test("cancels an attached response and retires abandoned tool continuations", async () => {
		let stops = 0;
		const token = new vscode.CancellationTokenSource();
		const bridge = new CocoTurnBridge([tool], () => { stops++; });
		const abandoned = new CocoTurnBridge([tool], () => { stops++; }, 10);
		try {
			const segment = bridge.start(() => new Promise(() => undefined), { report: () => undefined }, token.token);
			token.cancel();
			await assert.rejects(segment, vscode.CancellationError);
			const nextToken = new vscode.CancellationTokenSource();
			try {
				const abandonedSegment = abandoned.start(() => new Promise(() => undefined), { report: () => undefined }, nextToken.token);
				const response = abandoned.delegate(String(abandoned.clientTools[0].name), { command: "abandoned" });
				await abandonedSegment;
				assert.deepStrictEqual(await response, { error: "Chat tool delegation stopped." });
				assert.ok(abandoned.isTerminal);
				assert.strictEqual(stops, 2);
			} finally { nextToken.dispose(); }
		} finally { bridge.dispose(); abandoned.dispose(); token.dispose(); }
	});

	test("matches trailing results only and bounds text without turning binary data into text", () => {
		const call = new vscode.LanguageModelToolCallPart("coco-historical", tool.name, {});
		assert.strictEqual(collectCocoToolResults([...continuation(call, "old"), vscode.LanguageModelChatMessage.User("A new question")]).length, 0);
		assert.strictEqual(collectCocoToolResults(continuation(call, "latest"))[0].callId, call.callId);
		const binary = vscode.LanguageModelDataPart.image(new Uint8Array([1, 2]), "image/png");
		const encoded = convertCocoToolResult(new vscode.LanguageModelToolResultPart(call.callId, [binary, new vscode.LanguageModelTextPart("x".repeat(120_000))]));
		assert.match(String(encoded.output), /Non-text tool result/);
		assert.match(String(encoded.output), /Tool result truncated/);
		assert.ok(String(encoded.output).length < 101_000);
	});

	test("isolates parallel conversations and rejects stale results after prompt completion", async () => {
		let spawns = 0;
		const provider = new CocoChatModelProvider({
			isEnabled: () => true, resolveCli: () => "mock-cli",
			createClient: (_exe, _cwd, _connection, _model, handlers) => {
				spawns++; let alias = "";
				return {
					initialize: async () => undefined,
					newSession: async (_cwd: string, tools: Array<Record<string, unknown>>) => { alias = String(tools[0].name); return { sessionId: `session-${spawns}` }; },
					prompt: async () => { await handlers?.onClientTool?.(alias, { command: "wait" }); },
					cancel: () => undefined, dispose: () => undefined,
				} as unknown as CocoAcpClient;
			},
		});
		const token = new vscode.CancellationTokenSource();
		try {
			const parts: vscode.LanguageModelResponsePart[][] = [[], []];
			await Promise.all(parts.map((output, index) => provider.provideLanguageModelChatResponse(model,
				[vscode.LanguageModelChatMessage.User(`Conversation ${index}`)], options, { report: part => output.push(part) }, token.token)));
			await assert.rejects(provider.provideLanguageModelChatResponse(model,
				[vscode.LanguageModelChatMessage.User(parts.map(output => result(callFrom(output), "mixed")))],
				options, { report: () => undefined }, token.token), /different Chat conversations/);
			await provider.provideLanguageModelChatResponse(model, continuation(callFrom(parts[0]), "one"), options, { report: () => undefined }, token.token);
			await assert.rejects(provider.provideLanguageModelChatResponse(model, continuation(callFrom(parts[0]), "duplicate"),
				options, { report: () => undefined }, token.token), /no longer active/);
			await provider.provideLanguageModelChatResponse(model, continuation(callFrom(parts[1]), "two"), options, { report: () => undefined }, token.token);
			assert.strictEqual(spawns, 2);
		} finally { provider.dispose(); token.dispose(); }
	});
});