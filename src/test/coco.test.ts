import * as assert from "node:assert";
import * as vscode from "vscode";

import { CocoChatModelProvider, type CocoProviderStatus } from "../coco/coco-provider";
import { createCocoStatusCheck } from "../coco/commands";
import { CocoAcpClient } from "../coco/acp-client";
import {
	decodeCocoModelId, mapCocoModel, parseCocoModels, parseCocoThinkingConfiguration, resolveCocoReasoningEffort,
} from "../coco/model-adapter";
import { CocoResponseStream } from "../coco/response-stream";
import { CompositeChatModelProvider } from "../composite-provider";

suite("Snowflake Coco provider", () => {
	const sessionResult = (id = "test-session") => ({ sessionId: id, configOptions: [{
		category: "model", type: "select", options: [{ value: "auto", name: "Auto" }, { value: "test-model", name: "Test Model" }],
	}] });
	const fakeClient = (newSession: () => Promise<Record<string, unknown>>, dispose: () => void = () => undefined): CocoAcpClient => ({
		initialize: async () => undefined,
		newSession,
		prompt: async () => { throw new Error("Status probes must not run inference"); },
		dispose,
	}) as unknown as CocoAcpClient;

	test("reports a connected catalog and connection without running a model request", async () => {
		let probes = 0;
		const provider = new CocoChatModelProvider({
			isEnabled: () => true, resolveCli: () => "mock-cli", resolveConnection: () => "Azure SSO",
			createClient: () => { probes++; return fakeClient(async () => sessionResult()); },
		});
		const states: string[] = [];
		const subscription = provider.onDidChangeStatus(status => states.push(status.state));
		try {
			const status = await provider.refreshStatus();
			assert.strictEqual(status.state, "connected");
			assert.strictEqual(status.connection, "Azure SSO");
			assert.strictEqual(status.modelCount, 2);
			assert.ok(status.checkedAt);
			assert.deepStrictEqual(states.filter((state, index) => index === 0 || state !== states[index - 1]), ["checking", "connected"]);
			await provider.refreshStatus();
			assert.strictEqual(probes, 1, "a fresh catalog must be reused");
			await provider.refreshStatus(true);
			assert.strictEqual(probes, 2, "manual recheck must bypass the catalog TTL");
		} finally { subscription.dispose(); provider.dispose(); }
	});

	test("reports disabled and missing-runtime states without spawning a CLI", async () => {
		let enabled = false;
		const provider = new CocoChatModelProvider({
			isEnabled: () => enabled, resolveCli: () => undefined, resolveConnection: () => "Saved connection",
			createClient: () => { throw new Error("No CLI should be started"); },
		});
		try {
			const off = await provider.refreshStatus();
			assert.strictEqual(off.state, "disabled");
			assert.strictEqual(off.connection, "Saved connection");
			const cancellation = new vscode.CancellationTokenSource();
			try {
				await assert.rejects(provider.provideLanguageModelChatResponse(
					mapCocoModel({ id: "auto", name: "Auto" }), [],
					{ toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: () => undefined }, cancellation.token
				), /disabled/);
			} finally { cancellation.dispose(); }
			enabled = true;
			assert.strictEqual((await provider.refreshStatus()).state, "unconfigured");
		} finally { provider.dispose(); }
	});

	test("deduplicates simultaneous status probes and reports failed ACP sessions", async () => {
		let probes = 0;
		let rejectSession!: (error: Error) => void;
		const pending = new Promise<Record<string, unknown>>((_resolve, reject) => { rejectSession = reject; });
		const provider = new CocoChatModelProvider({
			isEnabled: () => true, resolveCli: () => "mock-cli",
			createClient: () => { probes++; return fakeClient(() => pending); },
		});
		try {
			const first = provider.refreshStatus();
			const second = provider.refreshStatus();
			assert.strictEqual(probes, 1);
			rejectSession(new Error("Authentication failed"));
			const results = await Promise.all([first, second]);
			assert.ok(results.every(result => result.state === "unavailable" && result.modelCount === 0));
		} finally { provider.dispose(); }
	});

	test("discards a late catalog after switching Snowflake connections", async () => {
		let connection = "Old";
		let oldDisposed = false;
		let resolveOld!: (session: Record<string, unknown>) => void;
		const oldSession = new Promise<Record<string, unknown>>(resolve => { resolveOld = resolve; });
		const provider = new CocoChatModelProvider({
			isEnabled: () => true, resolveCli: () => "mock-cli", resolveConnection: () => connection,
			createClient: (_executable, _cwd, selected) => selected === "Old"
				? fakeClient(() => oldSession, () => { oldDisposed = true; })
				: fakeClient(async () => sessionResult("new-session")),
		});
		try {
			const oldCheck = provider.refreshStatus();
			connection = "New";
			provider.refreshLanguageModelChatInformation();
			assert.ok(oldDisposed);
			await oldCheck; // An invalidated check must settle even if the old RPC never responds.
			await provider.refreshStatus();
			resolveOld(sessionResult("old-session"));
			await oldCheck;
			assert.strictEqual(provider.providerStatus.connection, "New");
			assert.strictEqual(provider.providerStatus.state, "connected");
		} finally { provider.dispose(); }
	});

	test("bounds a stuck initialization even when disposing the client does not reject its RPC", async function () {
		this.timeout(2_000);
		let disposed = 0, sessions = 0;
		const provider = new CocoChatModelProvider({
			isEnabled: () => true, resolveCli: () => "mock-cli", discoveryTimeoutMs: 20,
			createClient: () => ({
				initialize: () => new Promise<void>(() => undefined),
				newSession: async () => { sessions++; return sessionResult(); },
				dispose: () => { disposed++; },
			}) as unknown as CocoAcpClient,
		});
		try {
			const status = await provider.refreshStatus();
			assert.strictEqual(status.state, "unavailable"); assert.match(status.summary, /timed out/);
			assert.strictEqual(disposed, 1); assert.strictEqual(sessions, 0);
		} finally { provider.dispose(); }
	});

	test("times out model discovery, preserves the catalog and ignores a late reply after retry", async function () {
		this.timeout(2_000);
		let probes = 0, disposed = 0;
		let resolveLate!: (value: Record<string, unknown>) => void;
		const late = new Promise<Record<string, unknown>>(resolve => { resolveLate = resolve; });
		const source = new vscode.CancellationTokenSource();
		const provider = new CocoChatModelProvider({
			isEnabled: () => true, resolveCli: () => "mock-cli", discoveryTimeoutMs: 30,
			createClient: () => {
				probes++; return fakeClient(probes === 2 ? () => late : async () => sessionResult(), () => { disposed++; });
			},
		});
		try {
			await provider.refreshStatus();
			const pending = provider.refreshStatus(true);
			const during = await provider.provideLanguageModelChatInformation({ silent: true }, source.token);
			assert.ok(during.some(model => model.id === "coco::test-model"));
			const failed = await pending;
			assert.strictEqual(failed.state, "unavailable"); assert.match(failed.summary, /timed out/);
			assert.strictEqual(failed.modelCount, 2);
			assert.strictEqual((await provider.refreshStatus(true)).state, "connected");
			resolveLate({ sessionId: "late", models: { availableModels: [{ modelId: "late-model", name: "Late" }] } });
			await new Promise<void>(resolve => setImmediate(resolve));
			const after = await provider.provideLanguageModelChatInformation({ silent: true }, source.token);
			assert.ok(after.some(model => model.id === "coco::test-model"));
			assert.ok(!after.some(model => model.id === "coco::late-model"));
			assert.strictEqual(probes, 3); assert.strictEqual(disposed, 3);
		} finally { provider.dispose(); source.dispose(); }
	});

	test("cancels a shared check promptly and allows a new manual retry", async () => {
		let probes = 0, disposed = 0;
		const provider = new CocoChatModelProvider({
			isEnabled: () => true, resolveCli: () => "mock-cli",
			createClient: () => {
				probes++; return fakeClient(probes === 1 ? () => new Promise(() => undefined) : async () => sessionResult(), () => { disposed++; });
			},
		});
		const source = new vscode.CancellationTokenSource();
		try {
			const first = provider.refreshStatus(true, source.token);
			const second = provider.refreshStatus(true);
			source.cancel();
			const results = await Promise.all([first, second]);
			assert.ok(results.every(result => result.state === "unavailable" && /cancelled/.test(result.summary)));
			assert.strictEqual(disposed, 1);
			assert.strictEqual((await provider.refreshStatus(true)).state, "connected");
			assert.strictEqual(probes, 2);
		} finally { provider.dispose(); source.dispose(); }
	});

	test("shares refreshes for the same source without restarting the CLI or clearing known models", async () => {
		let probes = 0, disposed = 0;
		let resolveSession!: (value: Record<string, unknown>) => void;
		const session = new Promise<Record<string, unknown>>(resolve => { resolveSession = resolve; });
		const provider = new CocoChatModelProvider({
			isEnabled: () => true, resolveCli: () => "mock-cli",
			createClient: () => { probes++; return fakeClient(probes === 1 ? async () => sessionResult() : () => session, () => { disposed++; }); },
		});
		const source = new vscode.CancellationTokenSource();
		try {
			await provider.refreshStatus();
			const first = provider.refreshStatus(true);
			provider.refreshLanguageModelChatInformation();
			const second = provider.refreshStatus(true);
			const models = await provider.provideLanguageModelChatInformation({ silent: true }, source.token);
			assert.ok(models.some(model => model.id === "coco::test-model"));
			assert.strictEqual(probes, 2); assert.strictEqual(disposed, 1);
			resolveSession(sessionResult()); await Promise.all([first, second]);
			await provider.refreshStatus();
			assert.strictEqual(probes, 2, "completion must restore the cache TTL after repeated refreshes");
		} finally { provider.dispose(); source.dispose(); }
	});

	test("reports synchronous launch failures and settles despite an error during cleanup", async () => {
		let probes = 0;
		const provider = new CocoChatModelProvider({
			isEnabled: () => true, resolveCli: () => "mock-cli",
			createClient: () => {
				if (++probes === 1) { throw new Error("Launch failure"); }
				return fakeClient(async () => sessionResult(), () => { throw new Error("Cleanup failure"); });
			},
		});
		try {
			assert.strictEqual((await provider.refreshStatus()).state, "unavailable");
			assert.strictEqual((await provider.refreshStatus(true)).state, "connected");
		} finally { provider.dispose(); }
	});

	test("settles outstanding checks on disposal and never starts a pre-cancelled check", async () => {
		let probes = 0, disposed = 0;
		const provider = new CocoChatModelProvider({
			isEnabled: () => true, resolveCli: () => "mock-cli",
			createClient: () => { probes++; return fakeClient(() => new Promise(() => undefined), () => { disposed++; }); },
		});
		const source = new vscode.CancellationTokenSource();
		try {
			source.cancel(); await provider.refreshStatus(true, source.token);
			assert.strictEqual(probes, 0);
			const pending = provider.refreshStatus(); provider.dispose(); await pending;
			assert.strictEqual(disposed, 1);
		} finally { provider.dispose(); source.dispose(); }
	});

	test("deduplicates manual progress notifications and closes them on cancellation", async () => {
		let notifications = 0, warnings = 0, infos = 0, refreshes = 0, probes = 0;
		const messages: string[] = [];
		const source = new vscode.CancellationTokenSource();
		const provider = new CocoChatModelProvider({
			isEnabled: () => true, resolveCli: () => "mock-cli",
			createClient: () => { probes++; return fakeClient(() => new Promise(() => undefined)); },
		});
		const ui = {
			withProgress: (options: vscode.ProgressOptions, task: (progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => Promise<CocoProviderStatus>) => {
				notifications++; assert.strictEqual(options.cancellable, true);
				return task({ report: update => { if (update.message) { messages.push(update.message); } } }, source.token);
			},
			showWarningMessage: () => { warnings++; return Promise.resolve(undefined); },
			showInformationMessage: () => { infos++; return Promise.resolve(undefined); },
		} as unknown as NonNullable<Parameters<typeof createCocoStatusCheck>[2]>;
		try {
			const check = createCocoStatusCheck(provider, () => { refreshes++; }, ui);
			const first = check(true), second = check(true);
			assert.strictEqual(first, second);
			await new Promise<void>(resolve => setImmediate(resolve)); source.cancel();
			await Promise.all([first, second]);
			assert.strictEqual(notifications, 1); assert.strictEqual(probes, 1); assert.strictEqual(refreshes, 1);
			assert.strictEqual(warnings, 0); assert.strictEqual(infos, 0);
			assert.ok(messages.some(message => /Loading models/.test(message)));
		} finally { provider.dispose(); source.dispose(); }
	});

	const thinkingResult = { configOptions: [{
		id: "thought_level", category: "thought_level", type: "select", currentValue: "high",
		options: ["auto", "minimal", "low", "medium", "high", "max"].map(value => ({
			value, name: value.charAt(0).toUpperCase() + value.slice(1),
		})),
	}] };

	test("exposes the runtime's thinking levels and current default in the native picker", () => {
		const thinking = parseCocoThinkingConfiguration(thinkingResult);
		assert.ok(thinking);
		assert.strictEqual(thinking.configId, "thought_level");
		const info = mapCocoModel({ id: "auto", name: "Auto" }, 128_000, thinking) as
			vscode.LanguageModelChatInformation & { configurationSchema: {
				properties: { reasoningEffort: { enum: string[]; default: string; enumItemLabels: string[]; group: string } };
			} };
		const property = info.configurationSchema.properties.reasoningEffort;
		assert.deepStrictEqual(property.enum, ["auto", "minimal", "low", "medium", "high", "max"]);
		assert.deepStrictEqual(property.enumItemLabels, ["Auto", "Minimal", "Low", "Medium", "High", "Max"]);
		assert.strictEqual(property.default, "high");
		assert.strictEqual(property.group, "navigation");
	});

	test("does not invent thinking controls when ACP supplies none", () => {
		assert.strictEqual(parseCocoThinkingConfiguration({ configOptions: [] }), undefined);
		assert.strictEqual(parseCocoThinkingConfiguration({ configOptions: [null, { category: "thought_level" }] }), undefined);
		assert.strictEqual(parseCocoThinkingConfiguration({ configOptions: [{
			id: "thought_level", category: "thought_level", type: "select", options: [{ value: "" }],
		}] }), undefined);
		assert.ok(!("configurationSchema" in mapCocoModel({ id: "auto", name: "Auto" })));
	});

	test("preserves an explicit effort and refuses values unsupported by the session", () => {
		const thinking = parseCocoThinkingConfiguration(thinkingResult);
		assert.strictEqual(resolveCocoReasoningEffort("low", thinking), "low");
		assert.strictEqual(resolveCocoReasoningEffort("max", thinking), "max");
		assert.strictEqual(resolveCocoReasoningEffort("auto", thinking), "auto");
		assert.strictEqual(resolveCocoReasoningEffort(undefined, thinking), undefined);
		assert.throws(() => resolveCocoReasoningEffort("xhigh", thinking), /not supported/);
		assert.throws(() => resolveCocoReasoningEffort("high", undefined), /not supported/);
	});

	test("streams reasoning separately from the answer and groups consecutive thought deltas", () => {
		class ThinkingPart {
			constructor(readonly value: string, readonly id?: string) {}
		}
		const parts: unknown[] = [];
		const cancellation = new vscode.CancellationTokenSource();
		const stream = new CocoResponseStream({ report: part => parts.push(part) }, cancellation.token, ThinkingPart);
		const update = (kind: string, text: string): void => stream.accept({
			sessionUpdate: kind, content: { type: "text", text },
		});
		try {
			update("agent_thought_chunk", "First thought. ");
			update("agent_thought_chunk", "Second thought.");
			update("agent_message_chunk", "Answer.");
			update("agent_thought_chunk", "Next thought block.");
			assert.ok(parts[0] instanceof ThinkingPart);
			assert.ok(parts[1] instanceof ThinkingPart);
			assert.ok(parts[2] instanceof vscode.LanguageModelTextPart);
			assert.ok(parts[3] instanceof ThinkingPart);
			assert.strictEqual(parts[0].value, "First thought. ");
			assert.strictEqual(parts[0].id, parts[1].id);
			assert.notStrictEqual(parts[0].id, parts[3].id);
			assert.strictEqual(parts[2].value, "Answer.");
			cancellation.cancel();
			update("agent_thought_chunk", "Cancelled thought.");
			update("agent_message_chunk", "Cancelled answer.");
			assert.strictEqual(parts.length, 4);
		} finally {
			cancellation.dispose();
		}
	});

	test("keeps thinking out of ordinary answer text when the host has no ThinkingPart", () => {
		const parts: vscode.LanguageModelResponsePart[] = [];
		const cancellation = new vscode.CancellationTokenSource();
		const stream = new CocoResponseStream({ report: part => parts.push(part) }, cancellation.token, null);
		try {
			stream.accept({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Reasoning" } });
			stream.accept({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "ignored" } });
			stream.accept({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Ignored user echo" } });
			stream.accept({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer" } });
			assert.strictEqual(parts.length, 1);
			assert.ok(parts[0] instanceof vscode.LanguageModelTextPart);
			assert.strictEqual(parts[0].value, "Answer");
		} finally {
			cancellation.dispose();
		}
	});

	test("reads the model choices returned by current and older ACP sessions", () => {
		const current = parseCocoModels({ configOptions: [{
			category: "model", type: "select", currentValue: "auto",
			options: [
				{ value: "auto", name: "Auto" },
				{ value: "claude-sonnet", name: "Claude Sonnet", description: "Available to this role" },
				{ value: "", name: "Invalid" },
			],
		}] });
		assert.deepStrictEqual(current.map(model => model.id), ["auto", "claude-sonnet"]);
		assert.strictEqual(current[1].description, "Available to this role");
		const older = parseCocoModels({ models: { availableModels: [{ modelId: "gpt", name: "GPT" }] } });
		assert.deepStrictEqual(older.map(model => model.id), ["gpt"]);
		assert.deepStrictEqual(parseCocoModels({ configOptions: [] }), []);
	});

	test("makes Coco models selectable and routes them away from the default provider", async () => {
		const info = mapCocoModel({ id: "auto", name: "Auto" });
		assert.strictEqual(info.id, "coco::auto");
		assert.strictEqual(decodeCocoModelId(info.id), "auto");
		assert.strictEqual(decodeCocoModelId("codex::auto"), undefined);
		assert.strictEqual((info as unknown as { isUserSelectable: boolean }).isUserSelectable, true);
		const defaultProvider: vscode.LanguageModelChatProvider = {
			provideLanguageModelChatInformation: () => [],
			provideLanguageModelChatResponse: async () => undefined,
			provideTokenCount: async () => 1,
		};
		const coco = new CocoChatModelProvider();
		const composite = new CompositeChatModelProvider(defaultProvider, defaultProvider, undefined, coco);
		try {
			const count = await composite.provideTokenCount(info, "A longer Coco prompt", new vscode.CancellationTokenSource().token);
			assert.ok(count > 1);
		} finally {
			composite.dispose();
			coco.dispose();
		}
	});
});