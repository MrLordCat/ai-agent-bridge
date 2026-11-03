import * as assert from "node:assert";
import * as path from "node:path";
import {
	CODEX_DEFAULT_ACCOUNT_ID,
	codexAccountLabelSuffix,
	codexAccountModelPrefix,
	codexAccountStateKey,
	decodeCodexAccountModelId,
	encodeCodexAccountModelId,
	findCodexAccount,
	resolveActiveCodexAccountId,
	resolveActiveCodexAccountSetting,
	resolveCodexAccounts,
} from "../codex/accounts";
import { mapCodexModelInformation } from "../codex/model-adapter";
import type { CodexModel } from "../codex/protocol";
import { summarizeSubscriptionEvents } from "../diagnostics/subscription-usage";

const model: CodexModel = {
	id: "gpt-test",
	model: "gpt-test",
	displayName: "GPT Test",
	description: "Test Codex model",
	hidden: false,
	supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep" }],
	defaultReasoningEffort: "high",
	inputModalities: ["text", "image"],
	isDefault: true,
};

suite("Codex accounts", () => {
	const home = path.join(path.sep, "home", "krist");

	test("the built-in account is always first and keeps its historical ids", () => {
		const accounts = resolveCodexAccounts([], home);
		assert.strictEqual(accounts.length, 1);
		assert.strictEqual(accounts[0].id, CODEX_DEFAULT_ACCOUNT_ID);
		assert.strictEqual(codexAccountModelPrefix(""), "codex::");
		assert.strictEqual(encodeCodexAccountModelId("", "gpt-5"), "codex::gpt-5");
		assert.strictEqual(decodeCodexAccountModelId("codex::gpt-5", ""), "gpt-5");
	});

	test("a named account gets its own home and model prefix", () => {
		const accounts = resolveCodexAccounts([{ id: "Work" }, { id: "work" }, { id: "bad id!" }], home);
		assert.strictEqual(accounts.length, 2, "duplicates and invalid ids are dropped");
		const work = accounts[1];
		assert.strictEqual(work.id, "work");
		assert.strictEqual(work.label, "work");
		assert.strictEqual(work.codexHome, path.join(home, ".codex-work"));
		assert.strictEqual(codexAccountModelPrefix("work"), "codex::work::");
		assert.strictEqual(encodeCodexAccountModelId("work", "gpt-5"), "codex::work::gpt-5");
		assert.strictEqual(decodeCodexAccountModelId("codex::work::gpt-5", "work"), "gpt-5");
		assert.strictEqual(decodeCodexAccountModelId("codex::work::gpt-5", ""), undefined,
			"a named id never resolves as a built-in slug");
		assert.strictEqual(decodeCodexAccountModelId("codex::gpt-5", "work"), undefined);
		assert.strictEqual(decodeCodexAccountModelId("codex::other::gpt-5", "work"), undefined);
	});

	test("a custom home and label override the defaults", () => {
		const accounts = resolveCodexAccounts([{
			id: "second",
			label: "Second subscription",
			codexHome: "~/codex-second",
			cliPath: "~/.local/bin/codex",
		}], home);
		assert.strictEqual(accounts[1].label, "Second subscription");
		assert.strictEqual(accounts[1].codexHome, path.join(home, "codex-second"));
		assert.strictEqual(accounts[1].cliPath, path.join(home, ".local", "bin", "codex"));
		assert.strictEqual(codexAccountLabelSuffix(accounts[0]), "");
		assert.strictEqual(codexAccountLabelSuffix(accounts[1]), " · Second subscription");
	});

	test("the active account falls back to the built-in one", () => {
		const accounts = resolveCodexAccounts([{ id: "work" }], home);
		assert.strictEqual(resolveActiveCodexAccountId(accounts, "work"), "work");
		assert.strictEqual(resolveActiveCodexAccountId(accounts, ""), CODEX_DEFAULT_ACCOUNT_ID);
		assert.strictEqual(resolveActiveCodexAccountId(accounts, "removed"), CODEX_DEFAULT_ACCOUNT_ID);
		assert.strictEqual(resolveActiveCodexAccountId(accounts, undefined), CODEX_DEFAULT_ACCOUNT_ID);
		assert.strictEqual(resolveActiveCodexAccountSetting({ get: (_key, fallback) => fallback }), CODEX_DEFAULT_ACCOUNT_ID);
		assert.strictEqual(resolveActiveCodexAccountSetting({ get: () => "Work" }), "work");
	});

	test("account lookup accepts the tree command argument", () => {
		const accounts = resolveCodexAccounts([{ id: "work", label: "Work" }], home);
		assert.strictEqual(findCodexAccount(accounts, undefined)?.id, "");
		assert.strictEqual(findCodexAccount(accounts, { accountId: "work" } as never)?.id, "work");
		assert.strictEqual(findCodexAccount(accounts, "work")?.id, "work");
		assert.strictEqual(findCodexAccount(accounts, "missing"), undefined);
	});

	test("durable keys never overlap between accounts", () => {
		assert.strictEqual(codexAccountStateKey("llamacpp.codexLastModel.v1", ""), "llamacpp.codexLastModel.v1");
		assert.strictEqual(codexAccountStateKey("llamacpp.codexLastModel.v1", "work"), "llamacpp.codexLastModel.v1.account.work");
	});

	test("the picker label names the account and keeps its own model id", () => {
		const primary = mapCodexModelInformation(model, 258_400, 32_768);
		assert.strictEqual(primary.id, "codex::gpt-test");
		assert.strictEqual(primary.name, "GPT Test (Codex)");
		const second = mapCodexModelInformation(model, 258_400, 32_768, { accountId: "work", accountLabel: " · Work" });
		assert.strictEqual(second.id, "codex::work::gpt-test");
		assert.strictEqual(second.name, "GPT Test (Codex) · Work");
	});

	test("each account keeps its own usage windows in the ledger", () => {
		const at = Date.UTC(2026, 10, 1, 6, 0, 0);
		const report = summarizeSubscriptionEvents([
			{ type: "window", provider: "codex", kind: "fiveHour", at, utilization: 40 },
			{ type: "window", provider: "codex:work", kind: "fiveHour", at, utilization: 70 },
			{ type: "usage", id: "a", provider: "codex", at: at + 1, modelId: "gpt-test", fresh: 10, cached: 90, cacheWrite: 0, output: 5 },
			{ type: "usage", id: "b", provider: "codex:work", at: at + 2, modelId: "Work / gpt-test", fresh: 20, cached: 80, cacheWrite: 0, output: 15 },
		]);
		const primary = report.providers.find(provider => provider.provider === "codex");
		const work = report.providers.find(provider => provider.provider === "codex:work");
		assert.ok(primary && work);
		assert.strictEqual(primary.current[0].totals.requests, 1);
		assert.strictEqual(work.current[0].totals.requests, 1);
		assert.strictEqual(work.current[0].peakUtilization, 70);
		assert.notStrictEqual(primary.current[0].totals.totalTokens, work.current[0].totals.totalTokens);
	});
});
