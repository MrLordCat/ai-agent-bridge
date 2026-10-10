import * as assert from "node:assert";
import * as vscode from "vscode";
import { CocoAcpClient, type CocoPromptContent } from "../coco/acp-client";
import { CocoChatModelProvider } from "../coco/coco-provider";
import { serializeCocoMessages, estimateCocoTokens } from "../coco/message-adapter";
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
				createClient: () => ({ initialize: async () => init(supported), newSession: async () => session,
					prompt: async (_id: string, prompt: string | readonly CocoPromptContent[]) => { sent = prompt; return { stopReason: "end_turn" }; },
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