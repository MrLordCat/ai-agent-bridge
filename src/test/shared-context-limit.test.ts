import * as assert from "node:assert";
import { type ChildProcessWithoutNullStreams, type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as vscode from "vscode";
import { ApiProviderService, type QuickAccessApiProvider } from "../api-providers/api-provider-service";
import { CocoAcpClient } from "../coco/acp-client";
import { cocoNativeCompactionTokens, COCO_COMPACTION_THRESHOLD_ENV, resolveCocoCompactionThreshold } from "../coco/model-adapter";
import { createCodexVsCodeOnlyPolicy, resolveCodexAutoCompactTokenLimit } from "../codex/codex-provider";
import { resolveSharedContextLimit } from "../context/provider-handoff";
import { ProviderDirectory, type ApiProviderSource } from "../providers/provider-directory";
import { buildApiProfileItem, buildCocoItem } from "../ui/quick-access";

function configuration(values: Record<string, unknown>): Pick<vscode.WorkspaceConfiguration, "get"> {
	return { get: <T>(key: string, fallback?: T) => key in values ? values[key] as T : fallback };
}

function serviceFixture() {
	const values = new Map<string, unknown>(), keys = new Map<string, string>();
	const changed = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
	const state = { get: (key: string, fallback?: unknown) => values.has(key) ? values.get(key) : fallback,
		update: async (key: string, value: unknown) => { values.set(key, value); }, keys: () => [...values.keys()] } as vscode.Memento;
	const secrets: vscode.SecretStorage = { get: async key => keys.get(key),
		store: async (key, value) => { keys.set(key, value); }, delete: async key => { keys.delete(key); },
		keys: async () => [...keys.keys()], onDidChange: changed.event };
	const service = new ApiProviderService(state, secrets);
	return { service, dispose: () => { service.dispose(); changed.dispose(); } };
}

const cursorProfile: QuickAccessApiProvider = {
	id: "cursor-1", name: "Cursor", baseUrl: "https://api.cursor.com/v1", protocol: "cursor",
	contextLength: 510_040, maximumContextLength: 1_000_000, contextMaximumReported: true,
	llamaCppCompat: false, enabled: true, hasApiKey: true,
};

suite("Shared working context limit", () => {
	test("uses sharedContextLength, inherits the legacy Codex target at zero and clamps", () => {
		assert.strictEqual(resolveSharedContextLimit(configuration({ sharedContextLength: 400_000, codexWorkingContextTarget: 258_400 })), 400_000);
		assert.strictEqual(resolveSharedContextLimit(configuration({ sharedContextLength: 0, codexWorkingContextTarget: 300_000 })), 300_000);
		assert.strictEqual(resolveSharedContextLimit(configuration({})), 258_400);
		assert.strictEqual(resolveSharedContextLimit(configuration({ sharedContextLength: 5_000_000 })), 1_048_576);
		assert.strictEqual(resolveSharedContextLimit(configuration({ sharedContextLength: 1_000 })), 32_768);
	});

	test("Codex only lowers its native auto-compaction below 90% of the real window", () => {
		assert.strictEqual(resolveCodexAutoCompactTokenLimit(200_000, 400_000), 200_000);
		assert.strictEqual(resolveCodexAutoCompactTokenLimit(258_400, 258_400), undefined);
		assert.strictEqual(resolveCodexAutoCompactTokenLimit(360_000, 400_000), undefined);
		assert.strictEqual(createCodexVsCodeOnlyPolicy(200_000).config.model_auto_compact_token_limit, 200_000);
		assert.ok(!("model_auto_compact_token_limit" in createCodexVsCodeOnlyPolicy().config));
	});

	test("Coco receives the shared limit as a bounded fraction of its model window", () => {
		assert.strictEqual(resolveCocoCompactionThreshold(258_400, 1_000_000), 0.2584);
		assert.strictEqual(resolveCocoCompactionThreshold(100_000, 1_000_000), 0.2);
		assert.strictEqual(resolveCocoCompactionThreshold(1_000_000, 1_000_000), undefined);
		assert.strictEqual(resolveCocoCompactionThreshold(258_400, 200_000), undefined);
		assert.strictEqual(cocoNativeCompactionTokens(258_400, 1_000_000), 258_400);
		assert.strictEqual(cocoNativeCompactionTokens(900_000, 1_000_000), 750_000, "the CLI caps 1M windows at 75%");
		assert.strictEqual(cocoNativeCompactionTokens(500_000, 500_000), 450_000, "unset threshold keeps the 90% default");
	});

	test("the Coco ACP process gets the threshold environment without VS Code Node hooks", () => {
		let captured: NodeJS.ProcessEnv | undefined;
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
		}) as unknown as ChildProcessWithoutNullStreams;
		const fakeSpawn = ((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => { captured = options.env; return child; }) as unknown as typeof spawn;
		const client = new CocoAcpClient("cortex", process.cwd(), undefined, "model", {}, fakeSpawn, { [COCO_COMPACTION_THRESHOLD_ENV]: "0.2584" });
		try {
			assert.strictEqual(captured?.[COCO_COMPACTION_THRESHOLD_ENV], "0.2584");
			assert.strictEqual(captured?.NODE_OPTIONS, undefined);
		} finally { client.dispose(); }
	});

	test("Cursor profiles use the shared limit instead of their own slider and record catalog loads", async () => {
		const f = serviceFixture();
		try {
			const profile = await f.service.upsert({ name: "Cursor", baseUrl: "https://api.cursor.com/v1", protocol: "cursor" }, { apiKey: "test-key" });
			await f.service.setWorkingContextLength(profile.id, 510_040);
			assert.strictEqual((await f.service.getModelSources())[0].workingContextLength, resolveSharedContextLimit());
			assert.strictEqual(f.service.catalogLoadedAt(`api-${profile.id}`), undefined);
			f.service.recordContextMaximum(`api-${profile.id}`, 1_000_000, true);
			assert.ok(f.service.catalogLoadedAt(`api-${profile.id}`));
		} finally { f.dispose(); }
	});

	test("a fresh Cursor catalog keeps the profile online when the probe fails", async () => {
		const timeouts = new Map<string, number>();
		const profiles: ApiProviderSource[] = [
			{ id: "cursor", name: "Cursor", baseUrl: "https://api.cursor.com/v1", enabled: true, hasApiKey: true, protocol: "cursor" },
			{ id: "gateway", name: "Gateway", baseUrl: "https://gateway.example/v1", enabled: true, hasApiKey: true, protocol: "openai" },
		];
		const loaded = new Set(["api-cursor", "api-gateway"]);
		const directory = new ProviderDirectory({
			getSecret: async () => undefined, getConfigValue: (_key, fallback) => fallback, getApiProfiles: async () => profiles,
			getCatalogLoadedAt: key => loaded.has(key) ? Date.now() : undefined, probeIntervalMs: 0,
			probeHttp: async (endpoint, _key, timeoutMs) => { timeouts.set(endpoint, timeoutMs); return { ok: false, error: "No response within 5s" }; },
		});
		try {
			await directory.recheck();
			assert.strictEqual(directory.stateOf("api-cursor"), "online");
			assert.match(directory.list().find(entry => entry.key === "api-cursor")!.detail, /catalog loaded.*probe failed \(No response within 5s\)/);
			assert.strictEqual(directory.stateOf("api-gateway"), "offline", "other APIs still follow their probe");
			const timeoutFor = (host: string) => [...timeouts].find(([endpoint]) => endpoint.includes(host))?.[1];
			assert.strictEqual(timeoutFor("api.cursor.com"), 15_000, "Cursor's probe matches its catalog timeout");
			assert.strictEqual(timeoutFor("gateway.example"), 5_000);
			loaded.clear(); await directory.refresh();
			assert.strictEqual(directory.stateOf("api-cursor"), "offline");
		} finally { directory.dispose(); }
	});

	test("Quick Access shows the shared limit for Cursor and Coco and explains Offline", () => {
		const cursor = buildApiProfileItem(cursorProfile, "offline", undefined, "https://api.cursor.com/v1/models: HTTP 503", 258_400);
		assert.match(String(cursor.tooltip), /HTTP 503/);
		const working = cursor.children?.find(child => child.label === "Working Context");
		assert.match(String(working?.description), /^258\.4K shared$/);
		assert.strictEqual(working?.command?.command, "llamacpp.openContextControl");
		const gateway = buildApiProfileItem({ ...cursorProfile, protocol: "openai", baseUrl: "https://gateway.example/v1" }, "online", undefined, undefined, 258_400);
		assert.match(String(gateway.children?.find(child => child.label === "Working Context")?.description), /^510(?:\.0+)?K$/);
		const coco = buildCocoItem(true, { state: "connected", summary: "Connected", modelCount: 2 }, 128_000,
			{ modelId: "claude-opus-5-5", contextWindowTokens: 1_000_000, updatedAt: Date.now() }, 258_400);
		const cocoWorking = coco.children?.find(child => child.id?.endsWith("coco.workingContext"));
		assert.match(String(cocoWorking?.description), /^258\.4K shared$/);
		assert.match(String(cocoWorking?.tooltip), /about 258\.4K/);
	});
});
