import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { CocoAcpClient, type CocoAcpHandlers, type CocoPromptContent } from "../coco/acp-client";
import { CocoChatModelProvider } from "../coco/coco-provider";
import { serializeCocoMessages, estimateCocoTokens } from "../coco/message-adapter";
import { collectCocoToolImages, convertCocoToolResult } from "../coco/turn-bridge";
import { mapCocoModel } from "../coco/model-adapter";

suite("Coco vision", () => {
	const image = (data = new Uint8Array([1, 2, 3]), mimeType = "image/png") => vscode.LanguageModelDataPart.image(data, mimeType);
	const init = (imageInput: boolean) => ({ agentCapabilities: { promptCapabilities: { image: imageInput } } });
	const session = { sessionId: "vision-session", configOptions: [{ category: "model", type: "select", options: [{ value: "auto", name: "Auto" }] }] };

	test("preserves image bytes, MIME types and attachment order across roles", () => {
		const bytes = new Uint8Array([99, 1, 2, 3, 99]);
		const blocks = serializeCocoMessages([
			vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart("Compare these"), image(bytes.subarray(1, 4)), new vscode.LanguageModelTextPart("and this"), image(new Uint8Array([4, 5]), "image/jpeg")]),
			vscode.LanguageModelChatMessage.Assistant("Two pictures"),
		]);
		assert.deepStrictEqual(blocks.filter(block => block.type === "image"), [
			{ type: "image", data: "AQID", mimeType: "image/png" }, { type: "image", data: "BAU=", mimeType: "image/jpeg" },
		]);
		assert.deepStrictEqual(blocks.map(block => block.type), ["text", "image", "text", "image", "text"]);
		assert.match((blocks[2] as { text: string }).text, /and this/);
		assert.match((blocks[4] as { text: string }).text, /Assistant:\nTwo pictures/);
		assert.ok(blocks.every(block => block.type !== "text" || !block.text.includes("AQID")));
	});

	test("accepts an image-only message and keeps images from tool history", () => {
		assert.ok(serializeCocoMessages([vscode.LanguageModelChatMessage.User([image()])]).some(block => block.type === "image"));
		const result = new vscode.LanguageModelToolResultPart("screenshot", [new vscode.LanguageModelTextPart("Window capture"), image()]);
		const blocks = serializeCocoMessages([vscode.LanguageModelChatMessage.User([result])]);
		assert.match((blocks[0] as { text: string }).text, /screenshot/);
		assert.strictEqual(blocks[1].type, "image");
	});

	test("preserves text data and rejects empty images or oversized text instead of dropping content", () => {
		const blocks = serializeCocoMessages([vscode.LanguageModelChatMessage.User([vscode.LanguageModelDataPart.text("Attached text", "text/plain")])]);
		assert.match((blocks[0] as { text: string }).text, /Attached text/);
		assert.throws(() => serializeCocoMessages([vscode.LanguageModelChatMessage.User([image(new Uint8Array())])]), /empty image/);
		assert.throws(() => serializeCocoMessages([vscode.LanguageModelChatMessage.User("x".repeat(500_001))]), /too large/);
		assert.deepStrictEqual(serializeCocoMessages([vscode.LanguageModelChatMessage.User("")]), []);
	});

	test("accounts for images in the estimated context usage", () => {
		assert.strictEqual(estimateCocoTokens("hello"), 2);
		assert.ok(estimateCocoTokens(vscode.LanguageModelChatMessage.User([image()])) >= 1_024);
	});

	test("an image from a tool result is named in its text and collected once, within bounds, for attachment", () => {
		const result = new vscode.LanguageModelToolResultPart("call-1", [new vscode.LanguageModelTextPart("Window capture"), image(),
			new vscode.LanguageModelDataPart(new Uint8Array([9]), "application/octet-stream")]);
		const output = convertCocoToolResult(result).output;
		assert.match(output, /Image tool result: image\/png, 3 bytes; it follows as an image attachment/);
		assert.match(output, /end your turn now/, "Coco must end its turn, because the attachment is only sent after it");
		assert.match(output, /accepts text and image results only/);
		const seen = new Set<string>();
		assert.deepStrictEqual(collectCocoToolImages(result, seen), [{ type: "image", mimeType: "image/png", data: "AQID" }]);
		assert.deepStrictEqual(collectCocoToolImages(result, seen), [], "the same image is attached once per turn");
		assert.deepStrictEqual(collectCocoToolImages(new vscode.LanguageModelToolResultPart("c", [image(new Uint8Array())]), new Set()), [], "an empty image is not attached");
		const distinct = new vscode.LanguageModelToolResultPart("c", Array.from({ length: 6 }, (_, index) => image(new Uint8Array([index + 1]))));
		assert.strictEqual(collectCocoToolImages(distinct, new Set()).length, 4, "at most four images per attachment");
		assert.strictEqual(collectCocoToolImages(new vscode.LanguageModelToolResultPart("c", [image(new Uint8Array(4 * 1024 * 1024 + 1))]), new Set()).length, 0,
			"an image over the per-image limit is skipped");
	});

	test("a tool result image reaches Coco as a follow-up image prompt in the same native session", async () => {
		const prompts: (string | readonly CocoPromptContent[])[] = [], answers: string[] = [], returned: unknown[] = [];
		let alias = "";
		const tool: vscode.LanguageModelChatTool = { name: "view_image", description: "View an image", inputSchema: { type: "object" } };
		const provider = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock",
			createClient: (_exe, _cwd, _connection, _model, handlers) => ({
				initialize: async () => init(true),
				newSession: async (_cwd: string, tools: Array<Record<string, unknown>>) => { alias = String(tools[0].name); return session; },
				prompt: async (_id: string, prompt: string | readonly CocoPromptContent[]) => {
					prompts.push(prompt);
					if (prompts.length === 1) { returned.push(await handlers?.onClientTool?.(alias, { filePath: "shot.png" })); }
					handlers?.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: prompts.length === 1 ? "Looking at the capture." : "The capture shows a dark toolbar." } });
					return { stopReason: "end_turn" };
				},
				cancel: () => undefined, dispose: () => undefined }) as unknown as CocoAcpClient });
		const token = new vscode.CancellationTokenSource();
		const chat = { toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _copilotConversationId: "vision-tools" }, tools: [tool] };
		try {
			const first: vscode.LanguageModelResponsePart[] = [];
			const opening = provider.provideLanguageModelChatResponse(mapCocoModel({ id: "auto", name: "Auto" }),
				[vscode.LanguageModelChatMessage.User("What does shot.png show?")], chat, { report: part => first.push(part) }, token.token);
			await opening;
			const call = first.find((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart);
			assert.ok(call, "the tool call is reported while its result is pending");
			const second: vscode.LanguageModelResponsePart[] = [];
			await provider.provideLanguageModelChatResponse(mapCocoModel({ id: "auto", name: "Auto" }),
				[vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart("Window capture"), image()])])],
				chat, { report: part => second.push(part) }, token.token);
			assert.strictEqual(prompts.length, 2, "one follow-up prompt carries the tool image");
			const followUp = prompts[1] as readonly CocoPromptContent[];
			assert.match(followUp[0].type === "text" ? followUp[0].text : "", /previous tool result returned an image/);
			assert.deepStrictEqual(followUp.find(part => part.type === "image"), { type: "image", mimeType: "image/png", data: "AQID" });
			assert.strictEqual(followUp.filter(part => part.type === "image").length, 1);
			const toolResult = returned[0] as { output?: string; images?: unknown; imageFiles?: unknown };
			assert.match(String(toolResult.output), /saved as .*call your built-in read tool/);
			assert.strictEqual(toolResult.images, undefined, "images never ride the client-tool result");
			assert.strictEqual(toolResult.imageFiles, undefined, "the saved-file list stays inside the bridge");
			answers.push(...second.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart).map(part => part.value));
			assert.match(answers.join(""), /dark toolbar/);
		} finally { provider.dispose(); token.dispose(); }
	});

	/** Coco calls view_image, then reads the saved file with its built-in read (or another file) and answers in the same turn. */
	async function sameTurnRead(readTarget: (saved: string) => string) {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "coco-image-read-"));
		const prompts: (string | readonly CocoPromptContent[])[] = [], permissions: (string | undefined)[] = [];
		let alias = "", saved = "";
		const tool: vscode.LanguageModelChatTool = { name: "view_image", description: "View an image", inputSchema: { type: "object" } };
		const provider = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock", storageRoot: root,
			createClient: (_exe, _cwd, _connection, _model, handlers?: CocoAcpHandlers) => ({
				initialize: async () => init(true),
				newSession: async (_cwd: string, tools: Array<Record<string, unknown>>) => { alias = String(tools[0].name); return session; },
				prompt: async (_id: string, prompt: string | readonly CocoPromptContent[]) => {
					prompts.push(prompt);
					const result = await handlers?.onClientTool?.(alias, { filePath: "shot.png" }) as { output: string };
					saved = JSON.parse(/saved as (".*?")\./.exec(result.output)![1]) as string;
					const target = readTarget(saved);
					handlers?.onUpdate?.({ sessionUpdate: "tool_call", toolCallId: "native-read", title: "read", kind: "read", status: "pending", rawInput: { file_path: target } });
					permissions.push(await handlers?.onPermission?.({ toolCall: { title: `read: ${target}` },
						options: [{ kind: "allow_once", optionId: "allow" }, { kind: "allow_always", optionId: "always_0" }] }));
					handlers?.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The capture shows a dark toolbar." } });
					return { stopReason: "end_turn" };
				},
				cancel: () => undefined, dispose: () => undefined }) as unknown as CocoAcpClient });
		const token = new vscode.CancellationTokenSource();
		const chat = { toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _copilotConversationId: "vision-read" }, tools: [tool] };
		const model = mapCocoModel({ id: "auto", name: "Auto" });
		const first: vscode.LanguageModelResponsePart[] = [], second: vscode.LanguageModelResponsePart[] = [];
		try {
			await provider.provideLanguageModelChatResponse(model, [vscode.LanguageModelChatMessage.User("What does shot.png show?")], chat, { report: part => first.push(part) }, token.token);
			const call = first.find((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart)!;
			const outcome = await provider.provideLanguageModelChatResponse(model,
				[vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart("Window capture"), image()])])],
				chat, { report: part => second.push(part) }, token.token).then(() => undefined, (error: Error) => error);
			const bytes = await fs.readFile(saved).catch(() => undefined);
			return { prompts, permissions, saved, bytes, outcome, text: second.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart).map(part => part.value).join("") };
		} finally { provider.dispose(); token.dispose(); await fs.rm(root, { recursive: true, force: true }); }
	}

	test("Coco sees a tool image in the same turn by reading the saved file with its built-in read", async () => {
		const run = await sameTurnRead(saved => saved);
		assert.strictEqual(run.outcome, undefined);
		assert.deepStrictEqual(run.permissions, ["allow"], "only the one-time option, never a standing grant");
		assert.deepStrictEqual([...run.bytes ?? []], [1, 2, 3], "the original image bytes are saved");
		assert.match(path.basename(run.saved), /^[0-9a-f]{64}\.png$/);
		assert.strictEqual(run.prompts.length, 1, "no follow-up prompt: the image was already seen");
		assert.match(run.text, /dark toolbar/);
	});

	test("the built-in read stays blocked for any file the bridge did not save", async () => {
		const run = await sameTurnRead(saved => path.join(path.dirname(saved), "..", "sessions.json"));
		assert.match(String(run.outcome?.message), /internal action \(read/);
		assert.ok(run.permissions.every(permission => permission === undefined));
	});

	test("advertises negotiated vision and clears it when the Snowflake source changes", async () => {
		let connection = "Vision";
		const provider = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock", resolveConnection: () => connection,
			createClient: () => ({ initialize: async () => init(connection === "Vision"), newSession: async () => session, dispose: () => undefined }) as unknown as CocoAcpClient });
		const token = new vscode.CancellationTokenSource();
		try {
			await provider.refreshStatus();
			assert.ok((await provider.provideLanguageModelChatInformation({ silent: true }, token.token)).every(model => model.capabilities?.imageInput));
			connection = "Text"; provider.refreshLanguageModelChatInformation();
			assert.ok((await provider.provideLanguageModelChatInformation({ silent: true }, token.token)).every(model => !model.capabilities?.imageInput));
			await provider.refreshStatus();
			assert.ok((await provider.provideLanguageModelChatInformation({ silent: true }, token.token)).every(model => !model.capabilities?.imageInput));
		} finally { provider.dispose(); token.dispose(); }
	});

	test("sends real image blocks through the provider and rejects runtimes without vision", async () => {
		for (const supported of [true, false]) {
			let sent: string | readonly CocoPromptContent[] | undefined;
			const provider = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock",
				createClient: (_exe, _cwd, _connection, _model, handlers) => ({ initialize: async () => init(supported), newSession: async () => session,
					prompt: async (_id: string, prompt: string | readonly CocoPromptContent[]) => {
						sent = prompt;
						handlers?.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A chart" } });
						return { stopReason: "end_turn" };
					},
					cancel: () => undefined, dispose: () => undefined }) as unknown as CocoAcpClient });
			const token = new vscode.CancellationTokenSource();
			try {
				const response = provider.provideLanguageModelChatResponse(mapCocoModel({ id: "auto", name: "Auto" }),
					[vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart("What is shown?"), image()])],
					{ toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: () => undefined }, token.token);
				if (supported) {
					await response; assert.ok(Array.isArray(sent));
					assert.deepStrictEqual(sent.find(block => block.type === "image"), { type: "image", mimeType: "image/png", data: "AQID" });
					assert.match(sent.filter(block => block.type === "text").map(block => block.text).join(""), /What is shown/);
				} else { await assert.rejects(response, /does not support image input/); assert.strictEqual(sent, undefined); }
			} finally { provider.dispose(); token.dispose(); }
		}
	});
});