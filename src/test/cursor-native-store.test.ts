import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CursorNativeStore } from "../cursor/native-store";
import { cursorSdkRuntimeAvailable } from "../cursor/sdk-transport";

async function fixture() {
	const sdk = await import("@cursor/sdk"), root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-native-store-"));
	const raw = new sdk.JsonlLocalAgentStore(root), now = Date.now(), agentId = "agent-native-test";
	await raw.agents.create({ agent: { agentId, cwd: root, status: "idle", createdAt: now, updatedAt: now } });
	const add = async (turn: number, status: "finished" | "error" | "running", blob = true) => {
		const ref = { schemaVersion: 1 as const, rootBlobId: `checkpoint-${turn}` };
		if (blob) { await raw.checkpoints.create({ agentId, blobId: ref.rootBlobId, data: Buffer.from(`opaque-native-bytes-${turn}`) }); }
		await raw.runs.create({ run: { agentId, runId: `run-${turn}`, turnNumber: turn, status, createdAt: now + turn, updatedAt: now + turn, latestCheckpointRef: ref } });
		return ref;
	};
	const first = await add(1, "finished"), managed = new CursorNativeStore(raw);
	return { raw, managed, agentId, first, add, dispose: () => fs.rm(root, { recursive: true, force: true }) };
}

suite("Cursor native checkpoint store", () => {
	test("finds callback events beyond an error checkpoint and rejects conflicting event arguments", async function () {
		if (!cursorSdkRuntimeAvailable()) { this.skip(); }
		const f = await fixture();
		try {
			await f.add(2, "error"); const run = (await f.raw.runs.get({ agentId: f.agentId, runId: "run-2" }))!;
			await f.raw.runs.update({ run: { ...run, error: "[unknown] Premature close", startCheckpointRef: f.first } });
			const append = (id: string, status: string, file: string) => f.raw.runEvents.append({ runId: "run-2", eventType: "run_stream_event", payload: { type: "sdk_message", message: {
				type: "tool_call", call_id: id, status, args: { toolName: "vscode_read_file_hash", args: { file } },
			} } });
			await append("native-first", "running", "first"); await append("native-first", "completed", "first"); await append("native-tail", "running", "tail");
			const conversation = async () => [{ type: "agentConversationTurn", turn: { steps: [{ type: "toolCall", message: {
				type: "mcp", args: { toolName: "vscode_read_file_hash", args: { file: "first" } }, result: { status: "success" },
			} }] } }];
			const failed = await f.managed.failedTurn(f.agentId, "run-2", conversation);
			assert.strictEqual(failed?.calls.length, 1); assert.deepStrictEqual(failed?.uncheckpointedCalls, [{ alias: "vscode_read_file_hash", input: { file: "tail" } }]);
			await append("native-tail", "completed", "CHANGED");
			assert.strictEqual(await f.managed.failedTurn(f.agentId, "run-2", conversation), undefined);
		} finally { await f.dispose(); }
	});
	test("keeps an error-run checkpoint only after every native tool result is complete", async function () {
		if (!cursorSdkRuntimeAvailable()) { this.skip(); }
		const f = await fixture();
		try {
			const failed = await f.add(2, "error"), run = (await f.raw.runs.get({ agentId: f.agentId, runId: "run-2" }))!;
			await f.raw.runs.update({ run: { ...run, error: "[resource_exhausted] Error", startCheckpointRef: f.first } });
			const callback = { type: "toolCall", message: { type: "mcp", args: { toolName: "vscode_read_file_hash", args: { path: "fixture" } }, result: { status: "success" } as unknown } };
			const conversation = async () => [{ type: "agentConversationTurn", turn: { steps: [callback] } }];
			const safe = await f.managed.failedTurn(f.agentId, "run-2", conversation);
			assert.deepStrictEqual(safe?.checkpoint, failed); assert.deepStrictEqual(safe?.startCheckpoint, f.first);
			assert.strictEqual(safe?.error, "[resource_exhausted] Error"); assert.strictEqual(safe?.calls.length, 1);
			callback.message.result = undefined;
			assert.strictEqual(await f.managed.failedTurn(f.agentId, "run-2", conversation), undefined);
			callback.message.result = { status: "pending" };
			assert.strictEqual(await f.managed.failedTurn(f.agentId, "run-2", conversation), undefined);
			assert.strictEqual(await f.managed.failedTurn(f.agentId, "run-1", conversation), undefined);
		} finally { await f.dispose(); }
	});
	test("keeps a newly written SDK snapshot before the run pointer catches up and preserves it on status-only updates", async function () {
		if (!cursorSdkRuntimeAvailable()) { this.skip(); }
		const f = await fixture();
		try {
			await f.managed.restore(f.agentId, f.first);
			const fresh = { schemaVersion: 1 as const, rootBlobId: "fresh-sdk-snapshot" };
			await f.raw.checkpoints.create({ agentId: f.agentId, blobId: fresh.rootBlobId, data: Buffer.from("fresh opaque bytes") });
			const agent = (await f.managed.store.agents.get({ agentId: f.agentId }))!;
			await f.managed.store.agents.update({ agent: { ...agent, latestCheckpoint: fresh } });
			assert.deepStrictEqual((await f.managed.store.agents.get({ agentId: f.agentId }))?.latestCheckpoint, fresh);
			await f.managed.store.agents.update({ agent: { ...agent, status: "idle", latestCheckpoint: undefined } });
			assert.deepStrictEqual((await f.managed.store.agents.get({ agentId: f.agentId }))?.latestCheckpoint, fresh);
		} finally { await f.dispose(); }
	});
	test("repairs a missing agent pointer from real JSONL run records without altering checkpoint bytes", async function () {
		if (!cursorSdkRuntimeAvailable()) { this.skip(); }
		const f = await fixture();
		try {
			const second = { agentId: "agent-second", cwd: "fixture", status: "idle" as const, createdAt: Date.now(), updatedAt: Date.now() };
			await f.managed.store.agents.create({ agent: second });
			assert.ok((await f.managed.store.agents.list()).items.some(agent => agent.agentId === second.agentId));
			await f.managed.store.agents.delete({ filter: { agentIds: [second.agentId] } });
			assert.strictEqual(await f.managed.store.agents.get({ agentId: second.agentId }), null);
			assert.strictEqual((await f.raw.agents.get({ agentId: f.agentId }))?.latestCheckpoint, undefined);
			assert.deepStrictEqual((await f.managed.store.agents.get({ agentId: f.agentId }))?.latestCheckpoint, f.first);
			assert.deepStrictEqual(await f.managed.checkpoint(f.agentId, "run-1"), f.first);
			assert.strictEqual(Buffer.from((await f.managed.store.checkpoints.get({ agentId: f.agentId, blobId: f.first.rootBlobId }))!).toString(), "opaque-native-bytes-1");
		} finally { await f.dispose(); }
	});
	test("pins the completed checkpoint across a failed later run and advances only on a new native snapshot", async function () {
		if (!cursorSdkRuntimeAvailable()) { this.skip(); }
		const f = await fixture();
		try {
			const failed = await f.add(2, "error");
			assert.deepStrictEqual(await f.managed.checkpoint(f.agentId), f.first);
			await f.managed.restore(f.agentId, f.first);
			assert.deepStrictEqual((await f.managed.store.agents.get({ agentId: f.agentId }))?.latestCheckpoint, f.first);
			assert.notDeepStrictEqual(failed, f.first);
			const third = await f.add(3, "finished");
			const agent = (await f.managed.store.agents.get({ agentId: f.agentId }))!;
			await f.managed.store.agents.update({ agent: { ...agent, latestCheckpoint: third } });
			assert.deepStrictEqual((await f.managed.store.agents.get({ agentId: f.agentId }))?.latestCheckpoint, third);
		} finally { await f.dispose(); }
	});
	test("rejects missing or cross-agent blobs instead of resuming an empty conversation", async function () {
		if (!cursorSdkRuntimeAvailable()) { this.skip(); }
		const f = await fixture();
		try {
			const missing = await f.add(2, "finished", false);
			assert.strictEqual(await f.managed.checkpoint(f.agentId, "run-2"), undefined);
			await assert.rejects(f.managed.restore(f.agentId, missing), /checkpoint is missing/);
			await assert.rejects(f.managed.restore("agent-other", f.first), /checkpoint is missing/);
		} finally { await f.dispose(); }
	});
});