import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CURSOR_STORE_FILES, IndexedLocalAgentStore, openIndexedLocalAgentStore } from "../cursor/indexed-store";
import type { CursorLocalStore } from "../cursor/native-store";
import { cursorSdkRuntimeAvailable } from "../cursor/sdk-transport";

const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, item: unknown) => item instanceof Uint8Array || (item as { type?: string })?.type === "Buffer" ? Buffer.from(item instanceof Uint8Array ? item : (item as { data: number[] }).data).toString("hex") : item));
const outcome = async (work: () => Promise<unknown>) => { try { return { value: normalize(await work()) }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; } };
const files = async (root: string) => Object.fromEntries(await Promise.all(Object.values(CURSOR_STORE_FILES).map(async name =>
	[name, (await fs.readFile(path.join(root, name), "utf8").catch(() => "")).replace(/"createdAt":"[^"]+"/g, "\"createdAt\":\"<time>\"")])));

/** One scripted sequence touching every substore method, including SDK error paths. */
async function script(store: CursorLocalStore, cwd: string): Promise<unknown[]> {
	const out: unknown[] = [];
	const step = async (work: () => Promise<unknown>) => { out.push(await outcome(work)); };
	const agent = (agentId: string, updatedAt: number) => ({ agentId, cwd, status: "idle" as const, createdAt: 1, updatedAt });
	await step(() => store.agents.create({ agent: agent("a1", 1) })); await step(() => store.agents.create({ agent: agent("a2", 2) }));
	await step(() => store.agents.create({ agent: agent("a1", 5) })); await step(() => store.agents.update({ agent: agent("a1", 3) }));
	await step(() => store.agents.update({ agent: agent("missing", 3) }));
	await step(() => store.agents.list()); const page = await store.agents.list({ filter: { cwd, limit: 1 } }); out.push(normalize(page));
	await step(() => store.agents.list({ filter: { cwd, limit: 1, cursor: page.nextCursor } })); await step(() => store.agents.get({ agentId: "a1" }));
	const run = (runId: string, turnNumber: number) => ({ agentId: "a1", runId, turnNumber, status: "finished" as const, createdAt: turnNumber, updatedAt: turnNumber });
	for (const [id, turn] of [["r1", 2], ["r2", 1], ["r3", 3]] as const) { await step(() => store.runs.create({ run: run(id, turn) })); }
	await step(() => store.runs.create({ run: run("r1", 9) })); await step(() => store.runs.update({ run: { ...run("r2", 1), result: "done" } }));
	await step(() => store.runs.update({ run: run("nope", 1) }));
	const runs = await store.runs.list({ filter: { agentIds: ["a1"], limit: 2 } }); out.push(normalize(runs));
	await step(() => store.runs.list({ filter: { agentIds: ["a1"], limit: 2, cursor: runs.nextCursor } })); await step(() => store.runs.get({ agentId: "a1", runId: "r2" }));
	for (const [agentId, blobId] of [["a1", "b-c"], ["a1", "b-a"], ["a1", "b-b"], ["a2", "b-z"]]) { await step(() => store.checkpoints.create({ agentId, blobId, data: Buffer.from(`${agentId}:${blobId}`) })); }
	await step(() => store.checkpoints.create({ agentId: "a1", blobId: "b-a", data: Buffer.from("again") }));
	await step(() => store.checkpoints.update({ agentId: "a1", blobId: "b-a", data: Buffer.from("a1:b-a") }));
	await step(() => store.checkpoints.update({ agentId: "a1", blobId: "b-b", data: Buffer.from("changed bytes") }));
	await step(() => store.checkpoints.update({ agentId: "a1", blobId: "b-missing", data: Buffer.from("x") }));
	await step(() => store.checkpoints.get({ agentId: "a1", blobId: "b-b" })); await step(() => store.checkpoints.get({ agentId: "a2", blobId: "b-a" }));
	const blobs = await store.checkpoints.list({ filter: { agentIds: ["a1"], limit: 2 } }); out.push(normalize(blobs));
	await step(() => store.checkpoints.list({ filter: { agentIds: ["a1"], limit: 2, cursor: blobs.nextCursor } })); await step(() => store.checkpoints.list());
	await step(() => store.checkpoints.delete({ filter: { agentIds: ["a2"] } })); await step(() => store.checkpoints.list());
	const event = async (runId: string, index: number, idempotencyKey?: string) => {
		const result = await store.runEvents.append({ runId, eventType: "run_stream_event", payload: { index, text: "é".repeat(index) }, idempotencyKey });
		out.push(normalize({ ...result, createdAt: typeof result.createdAt }));
	};
	for (let index = 1; index <= 5; index++) { await event("r1", index, index === 2 ? "same" : undefined); }
	await event("r1", 99, "same"); await event("r2", 1); await event("r2", 2);
	for (const afterOffset of [undefined, "2", "5", "not-a-number"]) {
		const listed = await store.runEvents.list({ runId: "r1", afterOffset, limit: 2 });
		out.push(normalize({ ...listed, items: listed.items.map(item => ({ ...item, createdAt: typeof item.createdAt })) }));
	}
	await step(() => store.runs.delete({ filter: { runIds: ["r2"] } })); await step(() => store.runEvents.list({ runId: "r2" }));
	await step(() => store.agents.delete({ filter: { agentIds: ["a2"] } })); await step(() => store.agents.delete({ filter: { agentIds: ["a2"] } }));
	return out;
}

suite("Cursor indexed local agent store", () => {
	let root: string;
	setup(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-indexed-store-")); });
	teardown(() => fs.rm(root, { recursive: true, force: true }));

	test("matches JsonlLocalAgentStore results and files for the same operations", async function () {
		if (!cursorSdkRuntimeAvailable()) { this.skip(); }
		const sdk = await import("@cursor/sdk"), sdkRoot = path.join(root, "sdk"), ourRoot = path.join(root, "ours");
		const ours = new IndexedLocalAgentStore(ourRoot, sdk, 0);
		const expected = await script(new sdk.JsonlLocalAgentStore(sdkRoot), "fixture"), actual = await script(ours, "fixture");
		await ours.dispose();
		assert.deepStrictEqual(actual, expected);
		assert.deepStrictEqual(await files(ourRoot), await files(sdkRoot));
		// Each store opens the other's directory: an extension downgrade or upgrade keeps the native history.
		const crossed = [new sdk.JsonlLocalAgentStore(ourRoot), new IndexedLocalAgentStore(sdkRoot, sdk, 0)];
		const read = async (store: CursorLocalStore) => normalize(await Promise.all([store.agents.list(), store.runs.list(), store.checkpoints.list(),
			store.runEvents.list({ runId: "r1" }).then(page => page.items.map(item => ({ ...item, createdAt: typeof item.createdAt }))), store.checkpoints.get({ agentId: "a1", blobId: "b-b" })]));
		assert.deepStrictEqual(await read(crossed[0]), await read(crossed[1]));
		await (crossed[1] as IndexedLocalAgentStore).dispose();
	});

	test("ignores an interrupted final append and repairs it before writing", async function () {
		if (!cursorSdkRuntimeAvailable()) { this.skip(); }
		const sdk = await import("@cursor/sdk"), file = path.join(root, CURSOR_STORE_FILES.runEvents);
		const valid = JSON.stringify({ runId: "r", seq: 1, offset: "1", eventType: "e", payload: null, payloadRef: null, idempotencyKey: null, createdAt: new Date(0).toISOString() });
		await fs.writeFile(file, `${valid}\n{"runId":"r","seq":2,"payl`);
		const store = new IndexedLocalAgentStore(root, sdk, 0);
		assert.deepStrictEqual((await store.runEvents.list({ runId: "r" })).items.map(item => item.seq), [1]);
		assert.strictEqual((await store.runEvents.append({ runId: "r", eventType: "e" })).seq, 2);
		await store.dispose();
		assert.deepStrictEqual((await new sdk.JsonlLocalAgentStore(root).runEvents.list({ runId: "r" })).items.map(item => item.seq), [1, 2]);
		await fs.writeFile(file, `${valid}\n{broken\n${valid}\n`);
		await assert.rejects(new IndexedLocalAgentStore(root, sdk, 0).runEvents.list({ runId: "r" }), /Corrupt local agent store: failed to parse record 2/);
	});

	test("sees records written by another store instance", async function () {
		if (!cursorSdkRuntimeAvailable()) { this.skip(); }
		const sdk = await import("@cursor/sdk"), external = new sdk.JsonlLocalAgentStore(root), store = new IndexedLocalAgentStore(root, sdk, 0);
		await store.runEvents.append({ runId: "r", eventType: "e" });
		await external.runEvents.append({ runId: "r", eventType: "external" });
		await external.checkpoints.create({ agentId: "a", blobId: "outside", data: Buffer.from("bytes") });
		assert.deepStrictEqual((await store.runEvents.list({ runId: "r" })).items.map(item => [item.seq, item.eventType]), [[1, "e"], [2, "external"]]);
		assert.strictEqual((await store.runEvents.append({ runId: "r", eventType: "e" })).seq, 3);
		assert.strictEqual(Buffer.from((await store.checkpoints.get({ agentId: "a", blobId: "outside" }))!).toString(), "bytes");
		await store.dispose();
	});

	test("serializes concurrent appends and shares one instance per directory", async function () {
		if (!cursorSdkRuntimeAvailable()) { this.skip(); }
		const sdk = await import("@cursor/sdk"), store = openIndexedLocalAgentStore(root, sdk);
		assert.strictEqual(openIndexedLocalAgentStore(path.join(root, "."), sdk), store);
		const appended = await Promise.all(Array.from({ length: 40 }, (_, index) => store.runEvents.append({ runId: "r", eventType: "e", payload: { index } })));
		assert.deepStrictEqual(appended.map(item => item.seq).sort((a, b) => a - b), Array.from({ length: 40 }, (_, index) => index + 1));
		await Promise.all(Array.from({ length: 20 }, (_, index) => store.checkpoints.create({ agentId: "a", blobId: `b${index}`, data: Buffer.from([index]) })));
		await store.dispose();
		const sdkStore = new sdk.JsonlLocalAgentStore(root);
		assert.strictEqual((await sdkStore.runEvents.list({ runId: "r", limit: 100 })).items.length, 40);
		assert.deepStrictEqual(Buffer.from((await sdkStore.checkpoints.get({ agentId: "a", blobId: "b7" }))!), Buffer.from([7]));
	});

	test("loads a large checkpoint bundle without rereading the file per blob", async function () {
		if (!cursorSdkRuntimeAvailable()) { this.skip(); }
		const sdk = await import("@cursor/sdk"), data = Buffer.alloc(4096, 7).toString("base64");
		await fs.writeFile(path.join(root, CURSOR_STORE_FILES.checkpoints), Array.from({ length: 3000 }, (_, index) => JSON.stringify({ agentId: "a", blobId: `blob-${index.toString().padStart(5, "0")}`, dataBase64: data })).join("\n") + "\n");
		const store = new IndexedLocalAgentStore(root, sdk), started = Date.now();
		let cursor: string | undefined, count = 0;
		do { const page = await store.checkpoints.list({ filter: { agentIds: ["a"], cursor } }); for (const blobId of page.items) { count += (await store.checkpoints.get({ agentId: "a", blobId }))!.length > 0 ? 1 : 0; } cursor = page.nextCursor; } while (cursor);
		await store.dispose();
		assert.strictEqual(count, 3000);
		assert.ok(Date.now() - started < 5000, `bundle load took ${Date.now() - started} ms`);
	});
});
