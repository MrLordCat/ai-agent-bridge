import * as assert from "node:assert";
import * as vscode from "vscode";
import { CursorApiClient, type CursorModel, type CursorSelection } from "../cursor/api-client";
import { CursorProfileTransport } from "../cursor/profile-transport";
import type { ChatModelSource } from "../model-sources/source-routing";

const token: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined) };
const source: ChatModelSource = { key: "api-cursor-test", label: "Cursor", serverUrl: "https://api.cursor.com/v1", apiKey: "test-key", protocol: "cursor" };
const options: vscode.ProvideLanguageModelChatResponseOptions = { toolMode: vscode.LanguageModelChatToolMode.Auto };
interface ModelSchema { configurationSchema?: { properties: Record<string, { group?: string; enum?: string[]; enumItemLabels?: string[]; default?: string; title?: string }> } }

function fixture(descriptor: CursorModel) {
	const selections: CursorSelection[] = [];
	const profile = new CursorProfileTransport(s => new CursorApiClient(s.apiKey!, s.serverUrl, async (input, init) => {
		const url = String(input);
		if (url.endsWith("/models")) { return new Response(JSON.stringify({ items: [descriptor] })); }
		if (url.endsWith("/agents")) {
			selections.push(JSON.parse(String(init?.body)).model);
			return new Response(JSON.stringify({ agent: { id: "agent" }, run: { id: "run" } }));
		}
		if (url.endsWith("/stream")) { return new Response('event: result\ndata: {"status":"FINISHED","text":"done"}\n\nevent: done\ndata: {}\n\n'); }
		throw new Error("Unexpected Cursor endpoint");
	}), null);
	return { profile, selections };
}

suite("Cursor thinking picker", () => {
	test("exposes supported effort aliases as one navigation picker and sends the original API id", async () => {
		for (const id of ["effort", "reasoning_effort", "reasoningEffort", "thinking_level", "thinkingLevel", "thinking-effort"]) {
			const f = fixture({ id: "model", parameters: [{ id, values: [{ value: "low", displayName: "Quick" }, { value: "xhigh", displayName: "Deep" }] }, { id: "fast", values: [{ value: "true" }, { value: "false" }] }], variants: [{ isDefault: true, params: [{ id, value: "xhigh" }, { id: "fast", value: "false" }] }] });
			try {
				const [model] = await f.profile.models(source, token, "test");
				const schema = (model as unknown as ModelSchema).configurationSchema!.properties;
				assert.strictEqual(schema.reasoningEffort.group, "navigation");
				assert.strictEqual(schema.reasoningEffort.title, "Thinking Effort");
				assert.strictEqual(schema.reasoningEffort.default, "xhigh");
				assert.deepStrictEqual(schema.reasoningEffort.enum, ["low", "xhigh"]);
				assert.deepStrictEqual(schema.reasoningEffort.enumItemLabels, ["Quick", "Deep"]);
				assert.strictEqual(Object.values(schema).filter(item => item.group === "navigation").length, 1);
				if (id !== "reasoningEffort") { assert.ok(!schema[id]); }
				await f.profile.respond(source, "model", model, [vscode.LanguageModelChatMessage.User("test")], { ...options, modelOptions: { reasoningEffort: "low" } }, { report: () => undefined }, token);
				assert.deepStrictEqual(f.selections[0].params, [{ id: "fast", value: "false" }, { id, value: "low" }]);
			} finally { f.profile.dispose(); }
		}
	});

	test("uses advertised variant levels when parameter definitions are absent", async () => {
		const f = fixture({ id: "model", variants: [{ isDefault: true, params: [{ id: "thinking_level", value: "high" }] }, { params: [{ id: "thinking_level", value: "low" }] }, { params: [{ id: "thinking_level", value: "low" }] }] });
		try {
			const [model] = await f.profile.models(source, token, "test");
			const thinking = (model as unknown as ModelSchema).configurationSchema!.properties.reasoningEffort;
			assert.deepStrictEqual(thinking.enum, ["high", "low"]); assert.strictEqual(thinking.default, "high");
			await f.profile.respond(source, "model", model, [vscode.LanguageModelChatMessage.User("test")], { ...options, modelOptions: { reasoningEffort: "low" } }, { report: () => undefined }, token);
			assert.deepStrictEqual(f.selections[0].params, [{ id: "thinking_level", value: "low" }]);
		} finally { f.profile.dispose(); }
	});

	test("preserves the provider default and legacy options while rejecting unsupported thinking levels", async () => {
		const f = fixture({ id: "model", parameters: [{ id: "effort", values: [{ value: "low" }, { value: "high" }] }], variants: [{ isDefault: true, params: [{ id: "effort", value: "high" }] }] });
		try {
			const [model] = await f.profile.models(source, token, "test");
			for (const modelOptions of [{}, { effort: "low" }, { reasoning_effort: "low" }, { thinkingLevel: "low" }]) {
				await f.profile.respond(source, "model", model, [vscode.LanguageModelChatMessage.User("test")], { ...options, modelOptions }, { report: () => undefined }, token);
			}
			assert.deepStrictEqual(f.selections.map(selection => selection.params), [[{ id: "effort", value: "high" }], ...Array.from({ length: 3 }, () => [{ id: "effort", value: "low" }])]);
			await assert.rejects(f.profile.respond(source, "model", model, [vscode.LanguageModelChatMessage.User("test")], { ...options, modelOptions: { reasoningEffort: "invented" } }, { report: () => undefined }, token), /Unsupported Cursor parameter/);
			assert.strictEqual(f.selections.length, 4);
		} finally { f.profile.dispose(); }
	});

	test("does not invent a thinking picker for models whose catalog reports no supported level", async () => {
		for (const descriptor of [{ id: "plain-model" }, { id: "plain-model", parameters: [{ id: "context_window", values: [{ value: "200k" }] }, { id: "fast", values: [{ value: "true" }] }] }]) {
			const f = fixture(descriptor);
			try {
				const [model] = await f.profile.models(source, token, "test");
				assert.ok(!(model as unknown as ModelSchema).configurationSchema?.properties.reasoningEffort);
			} finally { f.profile.dispose(); }
		}
	});
});