import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
	capHistoryImages,
	capStoredImages,
	ConversationHistory,
	DEFAULT_HISTORY_IMAGE_LIMIT,
	HISTORY_IMAGE_MARKER,
	resolveHistoryImageLimit,
} from "../providers/conversation-history";

const user = vscode.LanguageModelChatMessage.User, assistant = vscode.LanguageModelChatMessage.Assistant;
/** A 1x1 PNG; the bytes do not matter, only that they are an image part. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
/** Distinct bytes per call, so every image becomes its own asset file. */
let imageSeed = 0;
const image = () => new vscode.LanguageModelDataPart(
	Buffer.concat([PNG, Buffer.from(`seed-${imageSeed++}`)]),
	"image/png"
);

function imagesIn(messages: readonly vscode.LanguageModelChatRequestMessage[]): number {
	let total = 0;
	for (const message of messages) {
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) { total++; }
			else if (part instanceof vscode.LanguageModelToolResultPart) {
				total += part.content.filter(inner => inner instanceof vscode.LanguageModelDataPart).length;
			}
		}
	}
	return total;
}

suite("Chat transcript image retention", () => {
	test("the limit is clamped and defaults to a hundred images", () => {
		assert.strictEqual(DEFAULT_HISTORY_IMAGE_LIMIT, 100);
		assert.strictEqual(resolveHistoryImageLimit(undefined), 100);
		assert.strictEqual(resolveHistoryImageLimit(-5), 0);
		assert.strictEqual(resolveHistoryImageLimit(40.7), 40);
		assert.strictEqual(resolveHistoryImageLimit(999999), 2_000);
		assert.strictEqual(resolveHistoryImageLimit("50"), 100, "a non-number falls back to the default");
	});

	test("live messages keep only the newest images", () => {
		const messages = [
			user([image(), new vscode.LanguageModelTextPart("old turn")]),
			assistant("answer"),
			user([image(), image(), new vscode.LanguageModelTextPart("newest turn")]),
		];
		const capped = capHistoryImages(messages, 2);
		assert.strictEqual(capped.removed, 1);
		assert.strictEqual(imagesIn(capped.messages), 2);
		assert.match(JSON.stringify(capped.messages[0].content), new RegExp(HISTORY_IMAGE_MARKER.replace(/[[\]]/g, "\\$&")));
		// The newest message is untouched.
		assert.strictEqual(capped.messages[2], messages[2]);
		assert.match(JSON.stringify(capped.messages[2].content), /newest turn/);
	});

	test("images inside tool results are capped too", () => {
		const messages = [
			user([new vscode.LanguageModelToolResultPart("call-1", [image(), new vscode.LanguageModelTextPart("shot 1")])]),
			user([new vscode.LanguageModelToolResultPart("call-2", [image(), new vscode.LanguageModelTextPart("shot 2")])]),
		];
		const capped = capHistoryImages(messages, 1);
		assert.strictEqual(capped.removed, 1);
		assert.strictEqual(imagesIn(capped.messages), 1);
		assert.match(JSON.stringify(capped.messages[1].content), /shot 2/, "the newest tool result keeps its image");
	});

	test("a zero limit drops every image but keeps the text", () => {
		const capped = capHistoryImages([user([image(), new vscode.LanguageModelTextPart("KEEP_ME")])], 0);
		assert.strictEqual(capped.removed, 1);
		assert.strictEqual(imagesIn(capped.messages), 0);
		assert.match(JSON.stringify(capped.messages[0].content), /KEEP_ME/);
	});

	test("stored parts keep the newest images and record the removed count", () => {
		const stored = [
			{ role: vscode.LanguageModelChatMessageRole.User, content: [
				{ type: "asset" as const, name: `${"a".repeat(64)}.png`, mimeType: "image/png" },
				{ type: "text" as const, text: "first" },
			] },
			{ role: vscode.LanguageModelChatMessageRole.User, content: [
				{ type: "result" as const, callId: "call", content: [
					{ type: "asset" as const, name: `${"b".repeat(64)}.png`, mimeType: "image/png" },
					{ type: "data" as const, data: "AAAA", mimeType: "image/jpeg" },
				] },
			] },
		];
		const capped = capStoredImages(stored, 1);
		assert.strictEqual(capped.removed, 2);
		const text = JSON.stringify(capped.messages);
		assert.strictEqual((text.match(/"type":"asset"/g) ?? []).length, 0, "no asset newer than the limit survives");
		assert.strictEqual((text.match(/"type":"data"/g) ?? []).length, 1, "the newest image is kept");
		assert.strictEqual((text.match(/earlier image removed/g) ?? []).length, 2);
	});

	test("a long chat keeps its newest images when reloaded from disk", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-images-"));
		try {
			// 120 one-message turns, each with an image, exceed the default of 100.
			const messages: vscode.LanguageModelChatRequestMessage[] = [];
			for (let index = 0; index < 120; index++) {
				messages.push(user([image(), new vscode.LanguageModelTextPart(`turn-${index}`)]));
				messages.push(assistant(`answer-${index}`));
			}
			const journal = new ConversationHistory(root, () => 100);
			const lease = await journal.begin("images-chat", messages);
			await lease.complete([]);
			// The host sends the retained render window plus the new request.
			const incoming = [...messages.slice(-40), user([new vscode.LanguageModelTextPart("NEXT")])];
			const restored = await new ConversationHistory(root, () => 100).begin("images-chat", incoming);
			assert.strictEqual(imagesIn(restored.messages), 100, "the reloaded transcript holds only the newest 100 images");
			const serialized = JSON.stringify(restored.messages);
			assert.match(serialized, /turn-119/);
			assert.match(serialized, /earlier image removed/, "older turns keep a visible marker");
			// The text of an old turn survives; only its image is dropped.
			assert.match(serialized, /turn-0\b/);
			assert.doesNotMatch(serialized.slice(0, serialized.indexOf("turn-19")), /seed-\d+/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("a lowered limit removes images from an existing transcript and its assets", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-images-drop-"));
		try {
			const messages: vscode.LanguageModelChatRequestMessage[] = [];
			for (let index = 0; index < 5; index++) {
				messages.push(user([image(), new vscode.LanguageModelTextPart(`turn-${index}`)]));
			}
			const journal = new ConversationHistory(root, () => 5);
			const lease = await journal.begin("drop-chat", messages);
			await lease.complete([]);
			const folder = path.join(root, "assets");
			assert.strictEqual((await fs.readdir(folder)).length, 5, "every image is stored once");

			// Same chat under a smaller limit: loading drops the old ones, saving rewrites the journal.
			const trimmed = new ConversationHistory(root, () => 2);
			const next = await trimmed.begin("drop-chat", [...messages.slice(-3), user("NEXT")]);
			assert.strictEqual(imagesIn(next.messages), 2);
			await next.complete([]);
			// Their files are no longer referenced, so the prune pass can delete them.
			const old = new Date(Date.now() - 48 * 60 * 60_000);
			for (const name of await fs.readdir(folder)) { await fs.utimes(path.join(folder, name), old, old); }
			const pruned = await new ConversationHistory(root, () => 2).pruneAssets();
			assert.strictEqual(pruned.removed, 3, "images dropped by the limit are pruned");
			assert.strictEqual((await fs.readdir(folder)).length, 2);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
