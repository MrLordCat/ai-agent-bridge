import * as assert from "node:assert";
import * as vscode from "vscode";
import { groupProviderModels, showProviderModelPicker, type ModelPickerProfile, type ProviderModelItem, type ProviderModelPickerUI } from "../ui/provider-model-picker";

function model(id: string, name: string, toolCalling = true): vscode.LanguageModelChatInformation {
	return { id, name, family: "test", version: "test", maxInputTokens: 96_000, maxOutputTokens: 4_000, capabilities: { toolCalling } };
}
const profiles: ModelPickerProfile[] = [
	{ id: "cursor-one", name: "Cursor", baseUrl: "https://api.cursor.com/v1", enabled: true },
	{ id: "api-one", name: "Shared name", baseUrl: "https://one.example/v1", enabled: true },
	{ id: "api-two", name: "Shared name", baseUrl: "https://two.example/v1", enabled: true },
	{ id: "disabled-api", name: "Disabled", baseUrl: "https://disabled.example/v1", enabled: false },
];
function fixture(pick: (items: readonly ProviderModelItem[], step: number) => ProviderModelItem | undefined) {
	let step = 0;
	const calls: Array<{ command: string; options?: unknown }> = [];
	const ui: ProviderModelPickerUI = { pick: async items => pick(items, step++), execute: async (command, options) => { calls.push({ command, options }); } };
	return { ui, calls };
}

suite("Models by provider", () => {
	test("separates subscriptions and API profile identities while preserving model ids and names", () => {
		const models = [model("codex::gpt", "GPT"), model("coco::gpt", "GPT"), model("claude::sonnet", "Sonnet"), model("primary::local", "Local"), model("deepseek::chat", "DeepSeek"), model("api-api-one::same", "Same model"), model("api-api-two::same", "Same model"), model("api-disabled-api::hidden", "Hidden"), model("api-deleted-profile::hidden", "Deleted")];
		const original = models.map(item => ({ id: item.id, name: item.name }));
		const groups = groupProviderModels(models, profiles);
		for (const key of ["codex", "coco", "claude", "primary", "deepseek", "api-api-one", "api-api-two"]) { assert.ok(groups.some(group => group.key === key), key); }
		assert.strictEqual(groups.find(group => group.key === "api-api-one")?.models[0].id, "api-api-one::same");
		assert.strictEqual(groups.find(group => group.key === "api-api-two")?.models[0].id, "api-api-two::same");
		assert.ok(!groups.some(group => group.key === "api-disabled-api" || group.key === "api-deleted-profile"));
		assert.deepStrictEqual(models.map(item => ({ id: item.id, name: item.name })), original);
	});

	test("lists providers first, then only that provider's sorted models and switches the current chat", async () => {
		const models = [model("coco::z", "Zeta"), model("coco::a", "Alpha"), model("codex::b", "Other")];
		const f = fixture((items, step) => {
			if (step === 0) { assert.ok(items.every(item => !item.model)); return items.find(item => item.group?.key === "coco"); }
			assert.deepStrictEqual(items.filter(item => item.model).map(item => item.label), ["Alpha", "Zeta"]);
			return items.find(item => item.model?.id === "coco::a");
		});
		await showProviderModelPicker(models, [], f.ui);
		assert.deepStrictEqual(f.calls, [{ command: "workbench.action.chat.open", options: { modelSelector: { vendor: "llamacpp", id: "coco::a" } } }]);
	});

	test("returns to providers before choosing another profile with the same model name", async () => {
		const models = [model("api-api-one::same", "Same"), model("api-api-two::same", "Same")];
		const f = fixture((items, step) => {
			if (step === 0) { return items.find(item => item.group?.key === "api-api-one"); }
			if (step === 1) { return items.find(item => item.action === "back"); }
			if (step === 2) { return items.find(item => item.group?.key === "api-api-two"); }
			return items.find(item => item.model?.id === "api-api-two::same");
		});
		await showProviderModelPicker(models, profiles, f.ui);
		assert.deepStrictEqual(f.calls[0].options, { modelSelector: { vendor: "llamacpp", id: "api-api-two::same" } });
	});

	test("cancels either screen without changing the selected model or sending a prompt", async () => {
		for (const cancelOnModels of [false, true]) {
			const f = fixture((items, step) => cancelOnModels && step === 0 ? items.find(item => item.group?.key === "codex") : undefined);
			await showProviderModelPicker([model("codex::gpt", "GPT")], [], f.ui);
			assert.deepStrictEqual(f.calls, []);
		}
	});

	test("selects chat-only Cursor in Ask mode instead of leaving an unsupported Agent mode", async () => {
		const f = fixture((items, step) => step === 0 ? items.find(item => item.group?.key === "api-cursor-one") : items.find(item => item.model));
		await showProviderModelPicker([model("api-cursor-one::composer", "Composer", false)], profiles, f.ui);
		assert.deepStrictEqual(f.calls, [{ command: "workbench.action.chat.open", options: { modelSelector: { vendor: "llamacpp", id: "api-cursor-one::composer" }, mode: "ask" } }]);
	});

	test("keeps Agent mode when selecting a Cursor model with native Tools", async () => {
		const f = fixture((items, step) => step === 0 ? items.find(item => item.group?.key === "api-cursor-one") : items.find(item => item.model));
		await showProviderModelPicker([model("api-cursor-one::composer", "Composer", true)], profiles, f.ui);
		assert.deepStrictEqual(f.calls, [{ command: "workbench.action.chat.open", options: { modelSelector: { vendor: "llamacpp", id: "api-cursor-one::composer" } } }]);
	});

	test("keeps an unavailable enabled profile visible and opens its manager only on request", async () => {
		const f = fixture((items, step) => {
			if (step === 0) { const item = items.find(entry => entry.group?.key === "api-cursor-one"); assert.match(item?.description ?? "", /0 models.*unavailable/); return item; }
			assert.ok(!items.some(item => item.model));
			return items.find(item => item.action === "manage");
		});
		await showProviderModelPicker([], profiles, f.ui);
		assert.deepStrictEqual(f.calls, [{ command: "llamacpp.openApiProviders", options: undefined }]);
	});
});