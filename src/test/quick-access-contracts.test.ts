import * as assert from "node:assert";
import * as vscode from "vscode";
import { LlamaQuickActionsProvider, providerRuntimeItems, type QuickAccessItem } from "../ui/quick-access";
import { QuickAccessItem as TreeItem, runtimeMetricItems } from "../ui/quick-access-items";
import { emptyTokenUsageHistorySummary } from "../token-usage-history";
import { DEEPSEEK_SERVER_URL } from "../constants";

const nodes = async (provider: LlamaQuickActionsProvider) => await Promise.resolve(provider.getChildren()) ?? [];
function flatten(items: readonly QuickAccessItem[]): QuickAccessItem[] { return items.flatMap(item => [item, ...flatten(item.children ?? [])]); }

suite("Quick Access rendering contracts", () => {
	test("does not render an empty list as an expandable group", () => {
		const item = new TreeItem("empty", "Empty", { children: [] });
		assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
		assert.strictEqual(item.contextValue, "llamacpp.quickAction");
	});
	test("uses the same live metrics, labels and throughput on cards and usage rows", () => {
		const metrics = { phase: "running" as const, inputTokens: 2000, outputTokens: 500, cachedInputTokens: 1000, throughputTokensPerSecond: 12.5, estimated: true };
		const usage = runtimeMetricItems("usage.current", metrics), card = providerRuntimeItems("api.one", metrics);
		assert.deepStrictEqual(card.map(item => [item.label, item.description, item.tooltip]), usage.map(item => [item.label, item.description, item.tooltip]));
		assert.ok(card.some(item => item.label === "Throughput"));
		assert.ok(card.some(item => item.id?.endsWith(".runtimeContext")));
	});
	test("captures source snapshots once per render and preserves unique tree ids", async () => {
		let reads = 0;
		const provider = new LlamaQuickActionsProvider({
			getProviderSnapshots: () => { reads++; return new Map([["api-one", { sourceId: "api-one", label: "One", state: "online" as const, summary: "Ready", metrics: { inputTokens: 1234, outputTokens: 5 } }]]); },
			getApiProviders: async () => [{ id: "one", name: "One", baseUrl: "https://example.test", protocol: "openai", enabled: true, hasApiKey: true, llamaCppCompat: false }],
		});
		const roots = await nodes(provider); assert.strictEqual(reads, 1);
		const ids = flatten(roots).map(item => item.id); assert.strictEqual(new Set(ids).size, ids.length);
		const card = roots.find(item => item.label === "One")!;
		assert.ok(card.children?.some(item => String(item.description).includes("1.2K")));
		await Promise.resolve(provider.getChildren(card)); assert.strictEqual(reads, 1);
	});
	test("shows recorded API history without inventing a combined live context", async () => {
		const history = emptyTokenUsageHistorySummary();
		history.today.providers.api.requests = 1; history.today.providers.api.inputTokens = 4321;
		const roots = await nodes(new LlamaQuickActionsProvider({ getTokenUsageHistory: () => history }));
		const api = flatten(roots).find(item => item.id === "llamacpp.quickAccess.usage.api")!;
		assert.ok(api); assert.ok(String(api.description).includes("4.3K"));
		assert.deepStrictEqual(api.children?.map(item => item.label), ["Today", "Last 7 Days"]);
	});
	test("keeps other sections usable when reading API profiles fails", async () => {
		const roots = await nodes(new LlamaQuickActionsProvider({ getApiProviders: async () => { throw new Error("profile unavailable"); } }));
		assert.ok(roots.some(item => item.label === "Token Usage"));
		assert.strictEqual(roots.find(item => item.label === "Providers")?.description, "Profiles unavailable");
	});
	test("uses the actual DeepSeek endpoint when the primary source is local", async () => {
		const roots = await nodes(new LlamaQuickActionsProvider({}));
		const endpoint = flatten(roots).find(item => item.id === "llamacpp.quickAccess.deepseek.endpoint")!;
		assert.ok(endpoint); assert.strictEqual(endpoint.tooltip, DEEPSEEK_SERVER_URL);
		assert.strictEqual(endpoint.command?.command, "llamacpp.configureDeepSeek");
	});
});