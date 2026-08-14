import * as assert from "node:assert";

import {
	ProviderDirectory,
	resolveSubscriptionState,
	type ApiProviderSource,
	type ProviderDirectoryOptions,
} from "../providers/provider-directory";

function fakeOptions(overrides: Partial<ProviderDirectoryOptions> & {
	config?: Record<string, unknown>;
	secrets?: Record<string, string>;
	profiles?: readonly ApiProviderSource[];
} = {}): ProviderDirectoryOptions {
	const config = overrides.config ?? {};
	const secrets = overrides.secrets ?? {};
	const profiles = overrides.profiles ?? [];
	return {
		getSecret: async key => secrets[key],
		getConfigValue: (key, fallback) => (key in config ? config[key] : fallback),
		getApiProfiles: async () => profiles,
		getCodexStatus: undefined,
		getClaudeStatus: undefined,
		probeIntervalMs: 0,
		...overrides,
	};
}

function probeResult(ok: boolean, error?: string) {
	return async () => (ok ? { ok: true } : { ok: false, error: error ?? "ECONNREFUSED" });
}

suite("provider directory", () => {
	test("maps subscription provider states", () => {
		assert.deepStrictEqual(resolveSubscriptionState(undefined), {
			state: "checking",
			detail: "Waiting for provider status.",
		});
		assert.deepStrictEqual(resolveSubscriptionState({ state: "connected", summary: "Connected (Pro)" }), {
			state: "online",
			detail: "Connected (Pro)",
		});
		assert.deepStrictEqual(resolveSubscriptionState({ state: "unavailable", summary: "Claude unavailable" }), {
			state: "offline",
			detail: "Claude unavailable",
		});
		assert.deepStrictEqual(resolveSubscriptionState({ state: "signedOut", summary: "Sign in required" }), {
			state: "unconfigured",
			detail: "Not signed in.",
		});
		assert.deepStrictEqual(resolveSubscriptionState({ state: "connected", summary: "Paused (5h limit reached)" }), {
			state: "paused",
			detail: "Paused (5h limit reached)",
		});
		assert.deepStrictEqual(resolveSubscriptionState({ state: "disabled", summary: "Off" }), {
			state: "off",
			detail: "Disabled in settings.",
		});
	});

	test("local source: offline when probe fails, online when it recovers", async () => {
		let probeOk = false;
		const directory = new ProviderDirectory(fakeOptions({
			config: { enableLocalServer: true },
			probeHttp: async (endpoint, _apiKey, _timeoutMs) => {
				assert.strictEqual(endpoint, "http://localhost:8000/v1/models");
				return probeOk ? { ok: true } : { ok: false, error: "ECONNREFUSED" };
			},
		}));
		await directory.recheck();
		let entry = directory.list().find(provider => provider.key === "local");
		assert.strictEqual(entry?.state, "offline");
		assert.match(entry?.detail ?? "", /ECONNREFUSED/);

		probeOk = true;
		await directory.recheck();
		entry = directory.list().find(provider => provider.key === "local");
		assert.strictEqual(entry?.state, "online");
	});

	test("disabled source stays off even when reachable", async () => {
		const directory = new ProviderDirectory(fakeOptions({
			config: { enableLocalServer: false },
			probeHttp: probeResult(true),
		}));
		await directory.recheck();
		assert.strictEqual(directory.stateOf("local"), "off");
	});

	test("deepseek without a key is unconfigured and is not probed", async () => {
		let probeCalls = 0;
		const directory = new ProviderDirectory(fakeOptions({
			config: { enableDeepSeek: true, enableLocalServer: false },
			probeHttp: async () => {
				probeCalls += 1;
				return { ok: true };
			},
		}));
		await directory.recheck();
		const entry = directory.list().find(provider => provider.key === "deepseek");
		assert.strictEqual(entry?.state, "unconfigured");
		assert.match(entry?.detail ?? "", /API key/);
		assert.strictEqual(probeCalls, 0);
	});

	test("deepseek with a key goes offline/online from the probe", async () => {
		const directory = new ProviderDirectory(fakeOptions({
			config: { enableDeepSeek: true },
			secrets: { "llamacpp.deepSeekApiKey": "sk-test" },
			probeHttp: probeResult(false, "HTTP 401 Unauthorized"),
		}));
		await directory.recheck();
		const entry = directory.list().find(provider => provider.key === "deepseek");
		assert.strictEqual(entry?.state, "offline");
		assert.match(entry?.detail ?? "", /401/);
	});

	test("custom api profiles: enabled+reachable online, disabled off", async () => {
		const profiles: ApiProviderSource[] = [
			{ id: "a", name: "Gateway A", baseUrl: "https://a.example/v1", enabled: true, hasApiKey: true },
			{ id: "b", name: "Gateway B", baseUrl: "https://b.example/v1", enabled: false, hasApiKey: false },
		];
		const directory = new ProviderDirectory(fakeOptions({
			profiles,
			probeHttp: async (endpoint) => endpoint.includes("a.example") ? { ok: true } : { ok: false, error: "unreachable" },
		}));
		await directory.recheck();
		assert.strictEqual(directory.stateOf("api-a"), "online");
		assert.strictEqual(directory.stateOf("api-b"), "off");
	});

	test("recheck probes only enabled sources", async () => {
		const probed: string[] = [];
		const profiles: ApiProviderSource[] = [
			{ id: "a", name: "A", baseUrl: "https://a.example/v1", enabled: true, hasApiKey: false },
			{ id: "b", name: "B", baseUrl: "https://b.example/v1", enabled: false, hasApiKey: false },
		];
		const directory = new ProviderDirectory(fakeOptions({
			config: { enableLocalServer: true, enableDeepSeek: true },
			secrets: { "llamacpp.deepSeekApiKey": "sk-test" },
			profiles,
			probeHttp: async endpoint => {
				probed.push(endpoint);
				return { ok: true };
			},
		}));
		await directory.recheck();
		assert.deepStrictEqual(probed.sort(), [
			"http://localhost:8000/v1/models",
			"https://a.example/v1/models",
			"https://api.deepseek.com/models",
		]);
	});

	test("fires onDidChange only when a state actually moves", async () => {
		let probeOk = false;
		const directory = new ProviderDirectory(fakeOptions({
			config: { enableLocalServer: true },
			probeHttp: async () => (probeOk ? { ok: true } : { ok: false, error: "down" }),
		}));
		const seen: string[] = [];
		directory.onDidChange(() => seen.push(directory.stateOf("local") ?? "?"));
		await directory.recheck();
		await directory.refresh();
		assert.deepStrictEqual(seen, ["offline"]);
		probeOk = true;
		await directory.recheck();
		assert.deepStrictEqual(seen, ["offline", "online"]);
	});

	test("ignores stale probe records after the endpoint changes", async () => {
		const config: Record<string, unknown> = { enableLocalServer: true, localServerUrl: "http://localhost:8000" };
		const directory = new ProviderDirectory(fakeOptions({
			config,
			probeHttp: probeResult(true),
		}));
		await directory.recheck();
		assert.strictEqual(directory.stateOf("local"), "online");

		config.localServerUrl = "http://localhost:9000";
		await directory.refresh();
		assert.strictEqual(directory.stateOf("local"), "checking");
	});
});
