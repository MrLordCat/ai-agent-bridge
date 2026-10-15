import * as assert from "node:assert";
import * as vscode from "vscode";
import { ApiSourceRouter, type ApiSourceAdapter } from "../providers/api-source-router";
import type { ChatModelSource } from "../model-sources/source-routing";

suite("API source router contracts", () => {
	test("routes discovery, response, counting and disposal through the registered transport", async () => {
		const calls: string[] = [];
		const source: ChatModelSource = { key: "api-test", label: "Test", serverUrl: "https://example.test" };
		const model: vscode.LanguageModelChatInformation = { id: "api-test::model", name: "Test", family: "other-family", version: "1", capabilities: {}, maxInputTokens: 100, maxOutputTokens: 10 };
		const token = new vscode.CancellationTokenSource();
		const adapter: ApiSourceAdapter = {
			id: "custom", matches: s => s.key === source.key,
			discover: async (_source, request) => { calls.push("discovery"); request.report([model]); },
			respond: async () => { calls.push("response"); }, countTokens: async () => 42,
			refresh: () => { calls.push("refresh"); }, dispose: () => { calls.push("dispose"); },
		};
		const router = new ApiSourceRouter([adapter]);
		try {
			await router.discover(source, { token: token.token, version: "1", report: models => assert.strictEqual(models[0], model) }, async () => { throw new Error("Wrong fallback"); });
			await router.respond(source, { modelId: "model", model, messages: [], options: { toolMode: vscode.LanguageModelChatToolMode.Auto }, progress: { report: () => undefined }, token: token.token }, async () => { throw new Error("Wrong fallback"); });
			assert.strictEqual(await router.countTokens(model, async () => 0), 42);
			let http = 0; await router.discover({ ...source, key: "api-http" }, { token: token.token, version: "1", report: () => undefined }, async () => { http++; });
			assert.strictEqual(http, 1); router.refresh(); assert.strictEqual(await router.countTokens(model, async () => 9), 9);
		} finally { router.dispose(); token.dispose(); }
		assert.deepStrictEqual(calls, ["discovery", "response", "refresh", "dispose"]);
	});
});