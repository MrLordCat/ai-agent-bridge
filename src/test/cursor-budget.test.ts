import * as assert from "node:assert";
import * as vscode from "vscode";
import { ApiProviderService, cursorBudgetAdminSecretKey } from "../api-providers/api-provider-service";
import { fetchCursorBudget } from "../api-providers/cursor-budget";
import type { FetchImplementation } from "../transport/openai-http";
import { buildApiProfileItem } from "../ui/quick-access";
import { renderApiProviderManagerHtml } from "../ui/api-provider-manager";

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const member = (overrides: Record<string, unknown> = {}) => ({ email: "developer@company.com", spendCents: 2450.125487, overallSpendCents: 3200.75, monthlyLimitDollars: 200, hardLimitOverrideDollars: 100, effectivePerUserLimitDollars: 100, ...overrides });
function backend(body: unknown = { teamMemberSpend: [member()], subscriptionCycleStart: 1708992000000 }, status = 200) {
	const calls: Array<{ url: string; method?: string; authorization: string | null; body?: unknown }> = [];
	const fetchImpl: FetchImplementation = async (input, init) => {
		const url = String(input);
		calls.push({ url, method: init?.method, authorization: new Headers(init?.headers).get("Authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
		return url.endsWith("/me") ? response({ userEmail: "Developer@Company.com" }) : response(body, status);
	};
	return { calls, fetchImpl };
}
function serviceFixture() {
	const values = new Map<string, unknown>(), keys = new Map<string, string>();
	const changed = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
	const state = { get: (key: string, fallback?: unknown) => values.has(key) ? values.get(key) : fallback, update: async (key: string, value: unknown) => { values.set(key, value); }, keys: () => [...values.keys()] } as vscode.Memento;
	const secrets: vscode.SecretStorage = { get: async key => keys.get(key), store: async (key, value) => { keys.set(key, value); }, delete: async key => { keys.delete(key); }, keys: async () => [...keys.keys()], onDidChange: changed.event };
	const service = new ApiProviderService(state, secrets);
	return { service, values, secrets, dispose: () => { service.dispose(); changed.dispose(); } };
}

suite("Cursor team budget", () => {
	test("renders cached profile metadata while the budget request is still pending", async () => {
		const originalFetch = globalThis.fetch, f = serviceFixture();
		let release!: (value: Response) => void, signalStarted!: () => void, calls = 0;
		const started = new Promise<void>(resolve => { signalStarted = resolve; });
		globalThis.fetch = async () => { calls++; signalStarted(); return new Promise<Response>(resolve => { release = resolve; }); };
		try {
			const profile = await f.service.upsert({ name: "Cursor", baseUrl: "https://api.cursor.com/v1" }, { apiKey: "key" });
			await f.service.setCursorBudgetAccess(profile.id, { userEmail: "developer@company.com" });
			const refreshed = new Promise<void>(resolve => { f.service.onDidChangeBalance(() => resolve()); });
			const first = await f.service.quickAccessApiProviders(false);
			assert.strictEqual(first.length, 1); assert.strictEqual(first[0].balance, undefined);
			assert.strictEqual(first[0].balanceUpdating, true);
			await started; assert.strictEqual(calls, 1);
			await f.service.quickAccessApiProviders(false); assert.strictEqual(calls, 1);
			release(response({ teamMemberSpend: [member()] })); await refreshed;
			const updated = await f.service.quickAccessApiProviders(false);
			assert.strictEqual(updated[0].balance?.summary, "$75.50 left");
			assert.strictEqual(updated[0].balanceUpdating, false); assert.strictEqual(calls, 1);
		} finally { release?.(response({})); globalThis.fetch = originalFetch; f.dispose(); }
	});

	test("does not repeatedly refresh providers without a supported balance endpoint", async () => {
		const f = serviceFixture(); let loads = 0;
		const load = f.service.getBalanceInfo.bind(f.service);
		f.service.getBalanceInfo = async (...args) => { loads++; return load(...args); };
		try {
			await f.service.upsert({ name: "Plain API", baseUrl: "https://example.test/v1" }, { apiKey: "key" });
			const refreshed = new Promise<void>(resolve => { f.service.onDidChangeBalance(() => resolve()); });
			await f.service.quickAccessApiProviders(false); await refreshed;
			await f.service.quickAccessApiProviders(false); await f.service.quickAccessApiProviders(false);
			assert.strictEqual(loads, 1);
		} finally { f.dispose(); }
	});

	test("reads the exact user and enforced limit with cents converted separately from included usage", async () => {
		const b = backend({ teamMemberSpend: [member({ email: "other@company.com", effectivePerUserLimitDollars: 5000 }), member()] });
		const info = await fetchCursorBudget("chat-key", {}, b.fetchImpl);
		assert.strictEqual(info.label, "Budget"); assert.strictEqual(info.summary, "$75.50 left");
		assert.deepStrictEqual(info.rows?.map(row => [row.label, row.summary]), [["Used", "$24.50"], ["Limit", "$100.00"], ["Total usage", "$32.01"]]);
		assert.match(info.tooltip, /on-demand/); assert.match(info.tooltip, /included subscription/);
		assert.strictEqual(b.calls[0].authorization, "Bearer chat-key");
		assert.strictEqual(b.calls[1].url, "https://api.cursor.com/teams/spend"); assert.strictEqual(b.calls[1].method, "POST");
		assert.deepStrictEqual(b.calls[1].body, { searchTerm: "developer@company.com", page: 1, pageSize: 100 });
	});

	test("uses a separate Admin key for spend and a configured user without replacing the chat key", async () => {
		const b = backend();
		const info = await fetchCursorBudget("chat-key", { adminApiKey: "admin-key", userEmail: " Developer@Company.com " }, b.fetchImpl);
		assert.strictEqual(info.summary, "$75.50 left"); assert.strictEqual(b.calls.length, 1);
		assert.strictEqual(Buffer.from(b.calls[0].authorization!.slice(6), "base64").toString(), "admin-key:");
	});

	test("handles zero and exceeded limits without inventing an unlimited balance", async () => {
		for (const [limit, used, expected] of [[0, 0, "$0.00 left"], [100, 15000, "$0.00 left"]] as const) {
			const info = await fetchCursorBudget("key", {}, backend({ teamMemberSpend: [member({ effectivePerUserLimitDollars: limit, spendCents: used })] }).fetchImpl);
			assert.strictEqual(info.summary, expected);
			if (used > 0) { assert.match(info.tooltip, /Over budget by \$50\.00/); }
		}
		const missing = await fetchCursorBudget("key", {}, backend({ teamMemberSpend: [member({ effectivePerUserLimitDollars: undefined, monthlyLimitDollars: null, hardLimitOverrideDollars: 0 })] }).fetchImpl);
		assert.strictEqual(missing.summary, "$24.50 used · limit not reported");
	});

	test("keeps permission, throttling and network failures visible without reporting a fake number", async () => {
		for (const status of [401, 403, 429]) {
			const info = await fetchCursorBudget("key", {}, backend({}, status).fetchImpl);
			assert.strictEqual(info.label, "Budget"); assert.strictEqual(info.summary, status === 429 ? "Rate limited" : "Admin access required");
			assert.deepStrictEqual(info.rows, []);
		}
		const network = await fetchCursorBudget("key", {}, async () => { throw new Error("network unavailable"); });
		assert.strictEqual(network.summary, "Unavailable");
	});

	test("does not select another team member or read all spend for a service account without a user", async () => {
		let calls = 0;
		const anonymous = await fetchCursorBudget("key", {}, async () => { calls++; return response({ apiKeyName: "service-account" }); });
		assert.strictEqual(anonymous.summary, "Select a user"); assert.strictEqual(calls, 1);
		const wrong = await fetchCursorBudget("key", {}, backend({ teamMemberSpend: [member({ email: "different@company.com" })] }).fetchImpl);
		assert.strictEqual(wrong.summary, "User not found");
	});

	test("rejects missing or malformed spend fields instead of rendering NaN", async () => {
		for (const body of [{ teamMemberSpend: [member({ spendCents: null })] }, { teamMemberSpend: [member({ spendCents: "2500" })] }, { teamMemberSpend: {} }]) {
			const info = await fetchCursorBudget("key", {}, backend(body).fetchImpl);
			assert.strictEqual(info.summary, "Unavailable"); assert.ok(!info.tooltip.includes("NaN"));
		}
	});

	test("shows Budget, Used and Limit with actions scoped to the saved Cursor profile", async () => {
		const info = await fetchCursorBudget("key", {}, backend().fetchImpl);
		const root = buildApiProfileItem({ id: "cursor-profile", name: "Cursor", baseUrl: "https://api.cursor.com/v1", protocol: "cursor", llamaCppCompat: false, enabled: true, hasApiKey: true, balance: info }, "online");
		const budget = root.children?.find(item => item.label === "Budget");
		assert.strictEqual(budget?.description, "$75.50 left");
		assert.deepStrictEqual(budget?.command?.arguments, ["cursor-profile"]);
		assert.strictEqual(budget?.command?.command, "llamacpp.cursorBudget");
		assert.deepStrictEqual(budget?.children?.map(item => item.label), ["Used", "Limit", "Total usage"]);
	});

	test("stores Admin credentials separately and updates budget views without refreshing SDK models", async () => {
		const f = serviceFixture();
		try {
			const profile = await f.service.upsert({ name: "Cursor", baseUrl: "https://api.cursor.com/v1" }, { apiKey: "chat-secret" });
			let modelChanges = 0, budgetChanges = 0;
			f.service.onDidChange(() => modelChanges++); f.service.onDidChangeBalance(() => budgetChanges++);
			await f.service.setCursorBudgetAccess(profile.id, { adminApiKey: "budget-admin-secret", userEmail: " Developer@Company.com " });
			assert.strictEqual(await f.service.getApiKey(profile.id), "chat-secret");
			assert.strictEqual(await f.secrets.get(cursorBudgetAdminSecretKey(profile.id)), "budget-admin-secret");
			assert.strictEqual(f.service.getCursorBudgetUserEmail(profile.id), "developer@company.com");
			assert.strictEqual(modelChanges, 0); assert.strictEqual(budgetChanges, 1);
			const stored = JSON.stringify([...f.values]); assert.ok(!stored.includes("chat-secret") && !stored.includes("budget-admin-secret"));
			assert.strictEqual((await f.service.getModelSources())[0].apiKey, "chat-secret");
			const html = renderApiProviderManagerHtml({ profiles: await f.service.listSummaries(), providers: [] });
			assert.match(html, /class="budget-btn"/); assert.ok(!html.includes("budget-admin-secret"));
			await f.service.remove(profile.id);
			assert.strictEqual(await f.secrets.get(cursorBudgetAdminSecretKey(profile.id)), undefined);
			assert.strictEqual(f.service.getCursorBudgetUserEmail(profile.id), undefined);
		} finally { f.dispose(); }
	});

	test("caches budget requests and refreshes on demand or when access changes", async () => {
		const originalFetch = globalThis.fetch, f = serviceFixture(), b = backend();
		globalThis.fetch = b.fetchImpl;
		try {
			const profile = await f.service.upsert({ name: "Cursor", baseUrl: "https://api.cursor.com/v1" }, { apiKey: "key" });
			const [a, c] = await Promise.all([f.service.getBalanceInfo(profile.id), f.service.getBalanceInfo(profile.id)]);
			assert.strictEqual(a?.summary, "$75.50 left"); assert.strictEqual(a, c); assert.strictEqual(b.calls.length, 2);
			await f.service.getBalanceInfo(profile.id); assert.strictEqual(b.calls.length, 2);
			await f.service.refreshBalance(profile.id); assert.strictEqual(b.calls.length, 4);
			await f.service.setCursorBudgetAccess(profile.id, { adminApiKey: "admin", userEmail: "developer@company.com" });
			await f.service.getBalanceInfo(profile.id); assert.strictEqual(b.calls.length, 5);
		} finally { globalThis.fetch = originalFetch; f.dispose(); }
	});

	test("does not let an old in-flight balance overwrite a newer budget configuration", async () => {
		const originalFetch = globalThis.fetch, f = serviceFixture();
		let release: ((value: Response) => void) | undefined;
		let signalStarted: () => void = () => undefined;
		const started = new Promise<void>(resolve => { signalStarted = resolve; });
		let count = 0;
		globalThis.fetch = async () => { count++; if (count === 1) { const pending = new Promise<Response>(resolve => { release = resolve; }); signalStarted(); return pending; } return response({ teamMemberSpend: [member({ spendCents: 2000 })] }); };
		try {
			const profile = await f.service.upsert({ name: "Cursor", baseUrl: "https://api.cursor.com/v1" }, { apiKey: "key" });
			await f.service.setCursorBudgetAccess(profile.id, { userEmail: "developer@company.com" });
			const stale = f.service.getBalanceInfo(profile.id); await started;
			await f.service.setCursorBudgetAccess(profile.id, { adminApiKey: "new-admin" });
			assert.strictEqual((await f.service.getBalanceInfo(profile.id))?.summary, "$80.00 left");
			release!(response({ teamMemberSpend: [member({ spendCents: 9000 })] }));
			assert.strictEqual(await stale, undefined);
			assert.strictEqual((await f.service.getBalanceInfo(profile.id))?.summary, "$80.00 left");
		} finally { release?.(response({})); globalThis.fetch = originalFetch; f.dispose(); }
	});

	test("refreshes at the next minute tick even when the previous budget response arrived late", async () => {
		const originalFetch = globalThis.fetch, originalNow = Date.now, f = serviceFixture();
		const start = originalNow(); let now = start, calls = 0;
		Date.now = () => now;
		globalThis.fetch = async () => { calls++; now += 2000; return response({ teamMemberSpend: [member()] }); };
		try {
			const profile = await f.service.upsert({ name: "Cursor", baseUrl: "https://api.cursor.com/v1" }, { apiKey: "key" });
			await f.service.setCursorBudgetAccess(profile.id, { userEmail: "developer@company.com" });
			await f.service.getBalanceInfo(profile.id); assert.strictEqual(calls, 1);
			now = start + 60_000; await f.service.getBalanceInfo(profile.id);
			assert.strictEqual(calls, 2);
		} finally { globalThis.fetch = originalFetch; Date.now = originalNow; f.dispose(); }
	});
});