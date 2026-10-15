import * as assert from "node:assert";
import * as vscode from "vscode";
import { ApiProviderService } from "../api-providers/api-provider-service";
import { fetchApiProviderBalance } from "../api-providers/balance";
import { buildApiProfileItem } from "../ui/quick-access";
import { renderApiProviderManagerHtml } from "../ui/api-provider-manager";

function fixture() {
	const values = new Map<string, unknown>(), keys = new Map<string, string>();
	const changed = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
	const state = { get: (key: string, fallback?: unknown) => values.has(key) ? values.get(key) : fallback, update: async (key: string, value: unknown) => { values.set(key, value); }, keys: () => [...values.keys()] } as vscode.Memento;
	const secrets: vscode.SecretStorage = { get: async key => keys.get(key), store: async (key, value) => { keys.set(key, value); }, delete: async key => { keys.delete(key); }, keys: async () => [...keys.keys()], onDidChange: changed.event };
	const service = new ApiProviderService(state, secrets);
	return { service, state, secrets, dispose: () => { service.dispose(); changed.dispose(); } };
}

const credits = (remaining: number) => new Response(JSON.stringify({ data: { credits: remaining } }));

suite("API balance service", () => {
	test("Cursor metadata and refresh make no balance requests, including with legacy credentials", async () => {
		const originalFetch = globalThis.fetch, f = fixture();
		let calls = 0;
		globalThis.fetch = async () => { calls++; throw new Error("No balance request expected"); };
		try {
			const profile = await f.service.upsert({ name: "Cursor", baseUrl: "https://api.cursor.com/v1" }, { apiKey: "chat-key" });
			const legacyKey = `llamacpp.apiProvider.${profile.id}.cursorAdminApiKey`;
			await f.secrets.store(legacyKey, "old-admin-key");
			await f.state.update("llamacpp.cursorBudgetUsers.v1", { [profile.id]: "old@example.test" });
			assert.strictEqual(await fetchApiProviderBalance(profile.baseUrl, "chat-key"), undefined);
			assert.strictEqual(await f.service.refreshBalance(profile.id), undefined);
			for (const refresh of [true, false]) {
				const [metadata] = await f.service.quickAccessApiProviders(refresh);
				assert.strictEqual(metadata.balance, undefined);
				assert.strictEqual(metadata.balanceUpdating, false);
			}
			assert.strictEqual(calls, 0);
			assert.strictEqual((await f.service.getModelSources())[0].apiKey, "chat-key");
			const html = renderApiProviderManagerHtml({ profiles: await f.service.listSummaries(), providers: [] });
			assert.ok(!html.includes("budget-btn") && !html.includes("Budget access"));
			await f.service.remove(profile.id);
			assert.strictEqual(await f.secrets.get(legacyKey), undefined);
		} finally { globalThis.fetch = originalFetch; f.dispose(); }
	});

	test("Cursor cards hide cached budgets and loading placeholders", () => {
		const item = buildApiProfileItem({ id: "cursor", name: "Cursor", baseUrl: "https://api.cursor.com/v1", protocol: "cursor", enabled: true, hasApiKey: true, llamaCppCompat: false, balanceUpdating: true, balance: { label: "Budget", summary: "$100 left", tooltip: "Legacy budget" } }, "online");
		assert.ok(!item.children?.some(child => child.id?.includes(".balance")));
		assert.ok(item.children?.some(child => child.label === "Maximum Context"));
	});

	test("OpenRouter renders metadata before balance completion and publishes the update once", async () => {
		const originalFetch = globalThis.fetch, f = fixture();
		let release!: (value: Response) => void, started!: () => void, calls = 0;
		const pending = new Promise<void>(resolve => { started = resolve; });
		globalThis.fetch = async () => { calls++; started(); return new Promise<Response>(resolve => { release = resolve; }); };
		try {
			await f.service.upsert({ name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" }, { apiKey: "key" });
			const updated = new Promise<void>(resolve => { f.service.onDidChangeBalance(() => resolve()); });
			const [first] = await f.service.quickAccessApiProviders(false);
			assert.strictEqual(first.balance, undefined); assert.strictEqual(first.balanceUpdating, true);
			await pending; await f.service.quickAccessApiProviders(false); assert.strictEqual(calls, 1);
			release(credits(75.5)); await updated;
			const [second] = await f.service.quickAccessApiProviders(false);
			assert.strictEqual(second.balance?.summary, "$75.50 credits");
			assert.strictEqual(second.balanceUpdating, false); assert.strictEqual(calls, 1);
		} finally { release?.(credits(0)); globalThis.fetch = originalFetch; f.dispose(); }
	});

	test("OpenRouter joins concurrent loads, caches successful balances and supports forced refresh", async () => {
		const originalFetch = globalThis.fetch, f = fixture();
		let calls = 0;
		globalThis.fetch = async () => { calls++; return credits(80); };
		try {
			const profile = await f.service.upsert({ name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" }, { apiKey: "key" });
			const [first, second] = await Promise.all([f.service.getBalanceInfo(profile.id), f.service.getBalanceInfo(profile.id)]);
			assert.strictEqual(first, second); assert.strictEqual(calls, 1);
			await f.service.getBalanceInfo(profile.id); assert.strictEqual(calls, 1);
			await f.service.refreshBalance(profile.id); assert.strictEqual(calls, 2);
		} finally { globalThis.fetch = originalFetch; f.dispose(); }
	});

	test("a delayed response cannot overwrite the balance after credentials change", async () => {
		const originalFetch = globalThis.fetch, f = fixture();
		let release!: (value: Response) => void, started!: () => void, calls = 0;
		const pending = new Promise<void>(resolve => { started = resolve; });
		globalThis.fetch = async () => { calls++; if (calls > 1) { return credits(80); } started(); return new Promise<Response>(resolve => { release = resolve; }); };
		try {
			const profile = await f.service.upsert({ name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" }, { apiKey: "old-key" });
			const stale = f.service.getBalanceInfo(profile.id); await pending;
			await f.service.upsert({ ...profile }, { apiKey: "new-key" });
			assert.strictEqual((await f.service.getBalanceInfo(profile.id))?.summary, "$80.00 credits");
			release(credits(10)); assert.strictEqual(await stale, undefined);
			assert.strictEqual((await f.service.getBalanceInfo(profile.id))?.summary, "$80.00 credits");
		} finally { release?.(credits(0)); globalThis.fetch = originalFetch; f.dispose(); }
	});
});