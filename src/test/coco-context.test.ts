import * as assert from "node:assert";
import * as vscode from "vscode";
import { estimateCocoTokens, serializeCocoMessages } from "../coco/message-adapter";

suite("Coco bounded conversation", () => {
	test("shortens oversized history while keeping the latest request and image bytes intact", () => {
		const blocks = serializeCocoMessages([
			vscode.LanguageModelChatMessage.User("Initial project instructions"),
			vscode.LanguageModelChatMessage.Assistant("Old history. ".repeat(80_000)),
			vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart("LATEST REQUEST: fix this image"), vscode.LanguageModelDataPart.image(new Uint8Array([1, 2, 3]), "image/png")]),
		], 40_000);
		const text = blocks.map(block => block.type === "text" ? block.text : "").join("");
		assert.ok(text.length <= 40_000);
		assert.match(text, /Initial project instructions/);
		assert.match(text, /LATEST REQUEST: fix this image/);
		assert.match(text, /Earlier conversation shortened/);
		assert.deepStrictEqual(blocks.filter(block => block.type === "image"), [{ type: "image", data: "AQID", mimeType: "image/png" }]);
	});

	test("keeps useful ends of large current tool results instead of rejecting the conversation", () => {
		const result = new vscode.LanguageModelToolResultPart("build", [new vscode.LanguageModelTextPart("BUILD START\n" + "log\n".repeat(80_000) + "BUILD ERROR AT END")]);
		const blocks = serializeCocoMessages([
			vscode.LanguageModelChatMessage.User("Fix the build error"),
			vscode.LanguageModelChatMessage.User([result]),
		], 30_000);
		const text = blocks.map(block => block.type === "text" ? block.text : "").join("");
		assert.ok(text.length <= 30_000);
		assert.match(text, /Fix the build error/);
		assert.match(text, /BUILD ERROR AT END/);
	});

	test("counts large old messages without invoking serialization or throwing the prompt limit error", () => {
		const message = vscode.LanguageModelChatMessage.Assistant("old".repeat(200_000));
		assert.ok(estimateCocoTokens(message) >= 150_000);
		assert.doesNotThrow(() => estimateCocoTokens(message));
	});
});