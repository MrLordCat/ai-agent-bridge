import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { recoverLegacyCursorSession } from "../cursor/legacy-recovery";
import { cursorTranscript } from "../cursor/message-adapter";
import { cursorSdkRuntimeAvailable } from "../cursor/sdk-transport";

async function fixture() {
	const sdk = await import("@cursor/sdk"), root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-legacy-recovery-"));
	const store = new sdk.JsonlLocalAgentStore(root), scope = createHash("sha256").update("only-this-chat").digest("hex");
	const history = [vscode.LanguageModelChatMessage.User("FIRST original requirement"), vscode.LanguageModelChatMessage.Assistant("An older finding"), vscode.LanguageModelChatMessage.User("SECOND original request")];
	const reply = "Unique completed native answer. ".repeat(10), selection = { id: "test-model", params: [{ id: "context", value: "1m" }] };
	const messages = [...history, vscode.LanguageModelChatMessage.Assistant(reply), vscode.LanguageModelChatMessage.User("Continue after reload")];
	const dir = path.join(root, "history", scope), file = path.join(dir, `${createHash("sha256").update("original archive").digest("hex")}.txt`);
	await fs.mkdir(dir, { recursive: true }); await fs.writeFile(file, cursorTranscript(history).text);
	const birth = (await fs.stat(file)).birthtimeMs, checkpoint = { schemaVersion: 1 as const, rootBlobId: "original-checkpoint" };
	const agent = { agentId: "agent-original", cwd: root, status: "idle" as const, createdAt: Math.floor(birth) - 100, updatedAt: Math.ceil(birth) + 100 };
	const run = { agentId: agent.agentId, runId: "run-original", turnNumber: 1, status: "finished" as const, model: selection, result: reply, createdAt: agent.createdAt, updatedAt: agent.updatedAt, startedAt: Math.ceil(birth) + 10, latestCheckpointRef: checkpoint };
	await store.agents.create({ agent }); await store.runs.create({ run });
	await store.checkpoints.create({ agentId: agent.agentId, blobId: checkpoint.rootBlobId, data: Buffer.from("opaque checkpoint") });
	return { store, root, scope, selection, messages, agent, run, file, checkpoint,
		recover: () => recoverLegacyCursorSession(store, root, scope, root, selection, messages), dispose: () => fs.rm(root, { recursive: true, force: true }) };
}

suite("Cursor legacy native recovery", () => {
	test("finds a unique completed agent by this chat's original archive and visible final reply without modifying native storage", async function () {
		if (!cursorSdkRuntimeAvailable()) { this.skip(); }
		const f = await fixture();
		try {
			const before = await fs.readFile(path.join(f.root, "agents.ndjson"), "utf8"), result = await f.recover();
			assert.strictEqual(result?.agentId, f.agent.agentId); assert.strictEqual(result?.deltaStart, 4);
			assert.strictEqual(result?.users.length, 2); assert.deepStrictEqual(result?.nativeCheckpoint, f.checkpoint);
			assert.strictEqual(await fs.readFile(path.join(f.root, "agents.ndjson"), "utf8"), before);
		} finally { await f.dispose(); }
	});
	test("refuses an unrelated scope, workspace, model or missing completed reply", async function () {
		if (!cursorSdkRuntimeAvailable()) { this.skip(); }
		const f = await fixture();
		try {
			assert.strictEqual(await recoverLegacyCursorSession(f.store, f.root, "a".repeat(64), f.root, f.selection, f.messages), undefined);
			assert.strictEqual(await recoverLegacyCursorSession(f.store, f.root, f.scope, "another-workspace", f.selection, f.messages), undefined);
			assert.strictEqual(await recoverLegacyCursorSession(f.store, f.root, f.scope, f.root, { id: "another-model" }, f.messages), undefined);
			assert.strictEqual(await recoverLegacyCursorSession(f.store, f.root, f.scope, f.root, f.selection, f.messages.filter((_, i) => i !== 3)), undefined);
		} finally { await f.dispose(); }
	});
	test("rejects failed, running and import-only agents and missing native bytes", async function () {
		if (!cursorSdkRuntimeAvailable()) { this.skip(); }
		const f = await fixture();
		try {
			for (const status of ["error", "running"] as const) {
				await f.store.runs.update({ run: { ...f.run, status } }); assert.strictEqual(await f.recover(), undefined);
			}
			await f.store.runs.update({ run: { ...f.run, result: "ACK" } }); assert.strictEqual(await f.recover(), undefined);
			await f.store.runs.update({ run: f.run }); await f.store.checkpoints.delete({ filter: { agentIds: [f.agent.agentId] } });
			assert.strictEqual(await f.recover(), undefined);
		} finally { await f.dispose(); }
	});
	test("rejects ambiguous completed candidates and edited historical requests", async function () {
		if (!cursorSdkRuntimeAvailable()) { this.skip(); }
		const f = await fixture();
		try {
			await f.store.agents.create({ agent: { ...f.agent, agentId: "agent-other" } });
			await f.store.runs.create({ run: { ...f.run, agentId: "agent-other", runId: "run-other" } });
			await f.store.checkpoints.create({ agentId: "agent-other", blobId: f.checkpoint.rootBlobId, data: Buffer.from("different native bytes") });
			assert.strictEqual(await f.recover(), undefined);
			await f.store.agents.delete({ filter: { agentIds: ["agent-other"] } });
			f.messages[0] = vscode.LanguageModelChatMessage.User("EDITED original requirement");
			assert.strictEqual(await f.recover(), undefined);
		} finally { await f.dispose(); }
	});
});