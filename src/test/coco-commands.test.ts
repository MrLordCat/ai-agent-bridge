import * as assert from "node:assert";
import * as vscode from "vscode";
import { createCocoOpenSnowflake, selectCocoConnection } from "../coco/commands";

type PanelHost = NonNullable<Parameters<typeof createCocoOpenSnowflake>[0]>;
function panelFixture(views = ["cortexChat", "cortexChatSecondary"], version = "1.141.0") {
	const source = new vscode.CancellationTokenSource(), calls: string[] = [], errors: string[] = [], progress: string[] = [];
	let installed = true, notifications = 0, activations = 0;
	let activation: Promise<unknown> = Promise.resolve();
	const host: PanelHost = {
		version, activationTimeoutMs: 1_000,
		getExtension: () => installed ? { activate: () => { activations++; return activation; },
			packageJSON: { contributes: { views: { fixture: views.map(id => ({ id })) } } } } : undefined,
		executeCommand: async command => { calls.push(command); },
		showErrorMessage: ((message: string) => { errors.push(message); return Promise.resolve(undefined); }) as PanelHost["showErrorMessage"],
		withProgress: (async (_options, task) => {
			notifications++; assert.strictEqual(_options.cancellable, true);
			return task({ report: update => { if (update.message) { progress.push(update.message); } } }, source.token);
		}) as PanelHost["withProgress"],
	};
	return { host, calls, errors, progress, source, counts: () => ({ notifications, activations }),
		missing: () => { installed = false; },
		block: () => { let release!: () => void; activation = new Promise<void>(resolve => { release = resolve; }); return release; },
		fail: () => { activation = Promise.reject(new Error("secret-connection-data")); },
		dispose: () => source.dispose() };
}

suite("Coco connection commands", () => {
	test("opens the secondary sidebar with progress and joins repeated clicks during activation", async () => {
		const f = panelFixture(), release = f.block(), open = createCocoOpenSnowflake(f.host);
		try {
			const first = open(), second = open(); assert.strictEqual(first, second);
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepStrictEqual(f.calls, []); assert.deepStrictEqual(f.counts(), { notifications: 1, activations: 1 });
			assert.ok(f.progress.some(message => /Activating/.test(message)));
			release(); await first;
			assert.deepStrictEqual(f.calls, ["cortexChatSecondary.focus"]); assert.deepStrictEqual(f.errors, []);
		} finally { release(); f.dispose(); }
	});
	test("supports the legacy Snowflake view and the pre-secondary-sidebar layout", async () => {
		for (const f of [panelFixture(["cortexChat"]), panelFixture(undefined, "1.105.0")]) {
			try { await createCocoOpenSnowflake(f.host)(); assert.deepStrictEqual(f.calls, ["cortexChat.focus"]); }
			finally { f.dispose(); }
		}
	});
	test("reports activation failure without exposing raw connection data and permits retry", async () => {
		const f = panelFixture(); f.fail(); const open = createCocoOpenSnowflake(f.host);
		try {
			await open(); assert.strictEqual(f.errors.length, 1); assert.match(f.errors[0], /Cannot open Snowflake Coco/);
			assert.ok(!f.errors[0].includes("secret-connection-data")); assert.deepStrictEqual(f.calls, []);
			const release = f.block(); release(); await open(); assert.deepStrictEqual(f.calls, ["cortexChatSecondary.focus"]);
		} finally { f.dispose(); }
	});
	test("times out activation visibly and never opens a panel later from the expired attempt", async () => {
		const f = panelFixture(), release = f.block(); f.host.activationTimeoutMs = 5;
		try {
			await createCocoOpenSnowflake(f.host)(); assert.strictEqual(f.errors.length, 1); assert.match(f.errors[0], /did not finish/);
			release(); await new Promise<void>(resolve => setImmediate(resolve)); assert.deepStrictEqual(f.calls, []);
		} finally { release(); f.dispose(); }
	});
	test("cancels the pending UI without a late panel opening or spurious error", async () => {
		const f = panelFixture(), release = f.block();
		try {
			const opened = createCocoOpenSnowflake(f.host)(); await new Promise<void>(resolve => setImmediate(resolve));
			f.source.cancel(); await opened; release(); await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepStrictEqual(f.calls, []); assert.deepStrictEqual(f.errors, []);
		} finally { release(); f.dispose(); }
	});
	test("opens extension search when Snowflake is missing", async () => {
		const f = panelFixture(); f.missing();
		try { await createCocoOpenSnowflake(f.host)(); assert.deepStrictEqual(f.calls, ["workbench.extensions.search"]); assert.strictEqual(f.counts().notifications, 0); }
		finally { f.dispose(); }
	});
	test("reselecting the current connection forces a retry without rewriting settings", async () => {
		let updates = 0; const retries: boolean[] = [];
		await selectCocoConnection(async force => { retries.push(force === true); }, {
			current: () => "saved", names: () => ["saved"], pick: async items => items.find(item => item.connection === "saved"),
			update: async () => { updates++; },
		});
		assert.strictEqual(updates, 0); assert.deepStrictEqual(retries, [true]);
	});
	test("changing the connection stores it before requesting a fresh check", async () => {
		const events: string[] = [];
		await selectCocoConnection(async force => { events.push(`check:${force}`); }, {
			current: () => "old", names: () => ["old", "new"], pick: async items => items.find(item => item.connection === "new"),
			update: async connection => { events.push(`update:${connection}`); },
		});
		assert.deepStrictEqual(events, ["update:new", "check:true"]);
	});
	test("cancelling the connection picker leaves settings and runtime untouched", async () => {
		await selectCocoConnection(async () => { assert.fail("No check after cancellation"); }, {
			current: () => "saved", names: () => [], pick: async () => undefined,
			update: async () => { assert.fail("No update after cancellation"); },
		});
	});
});