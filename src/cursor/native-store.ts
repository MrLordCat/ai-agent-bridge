import type { AgentOptions } from "@cursor/sdk";
import { cursorCallSignature } from "./call-signature";

export type CursorLocalStore = NonNullable<NonNullable<AgentOptions["local"]>["store"]>;
export interface CursorNativeCheckpoint { schemaVersion: 1; rootBlobId: string }
export interface CursorFailedTurn { runId: string; error: string; checkpoint: CursorNativeCheckpoint; startCheckpoint?: CursorNativeCheckpoint | null; calls: Array<{ alias: string; input: unknown }>; uncheckpointedCalls?: Array<{ alias: string; input: unknown }> }
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** SDK 1.0.37 can lose agent.latestCheckpoint while retaining the run's checkpoint. */
export class CursorNativeStore {
	readonly store: CursorLocalStore;
	private readonly pinned = new Map<string, CursorNativeCheckpoint>();
	constructor(readonly raw: CursorLocalStore) {
		this.store = { runs: raw.runs, checkpoints: raw.checkpoints, runEvents: raw.runEvents, agents: {
			create: input => raw.agents.create(input),
			delete: input => raw.agents.delete(input),
			list: input => raw.agents.list(input),
			get: async input => {
				const agent = await raw.agents.get(input);
				if (!agent) { return null; }
				const checkpoint = this.pinned.get(input.agentId) ?? agent.latestCheckpoint ?? await this.latest(input.agentId, false);
				return { ...agent, ...(checkpoint ? { latestCheckpoint: checkpoint } : {}) };
			},
			update: async input => {
				const current = await raw.agents.get({ agentId: input.agent.agentId });
				const checkpoint = input.agent.latestCheckpoint ?? current?.latestCheckpoint;
				const pin = this.pinned.get(input.agent.agentId);
				if (pin && input.agent.latestCheckpoint && input.agent.latestCheckpoint.rootBlobId !== pin.rootBlobId) { this.pinned.delete(input.agent.agentId); }
				return raw.agents.update({ agent: { ...input.agent, ...(checkpoint ? { latestCheckpoint: checkpoint } : {}) } });
			},
		} };
	}
	private async latest(agentId: string, completed: boolean): Promise<CursorNativeCheckpoint | undefined> {
		let cursor: string | undefined;
		const runs = [];
		do {
			const page = await this.raw.runs.list({ filter: { agentIds: [agentId], cursor, limit: 1000 } });
			runs.push(...page.items); cursor = page.nextCursor;
		} while (cursor);
		for (const run of runs.sort((a, b) => b.turnNumber - a.turnNumber)) {
			if (completed && run.status !== "finished") { continue; }
			const checkpoint = run.latestCheckpointRef;
			if (checkpoint && await this.raw.checkpoints.get({ agentId, blobId: checkpoint.rootBlobId })) { return checkpoint; }
		}
		return undefined;
	}
	async checkpoint(agentId: string, runId?: string): Promise<CursorNativeCheckpoint | undefined> {
		if (!runId) { return this.latest(agentId, true); }
		const run = await this.raw.runs.get({ agentId, runId });
		const checkpoint = run?.status === "finished" ? run.latestCheckpointRef : undefined;
		return checkpoint && await this.raw.checkpoints.get({ agentId, blobId: checkpoint.rootBlobId }) ? checkpoint : undefined;
	}
	async restore(agentId: string, checkpoint: CursorNativeCheckpoint): Promise<void> {
		const agent = await this.raw.agents.get({ agentId });
		if (!agent || !await this.raw.checkpoints.get({ agentId, blobId: checkpoint.rootBlobId })) { throw new Error("The saved Cursor native checkpoint is missing. No inference was started."); }
		this.pinned.set(agentId, checkpoint);
		await this.raw.agents.update({ agent: { ...agent, latestCheckpoint: checkpoint, status: "idle", activeRunId: null } });
	}
	async failedTurn(agentId: string, runId: string | undefined, conversation: (id: string) => Promise<unknown>): Promise<CursorFailedTurn | undefined> {
		let run = runId ? await this.raw.runs.get({ agentId, runId }) : undefined;
		if (!runId) {
			const runs = []; let cursor: string | undefined;
			do { const page = await this.raw.runs.list({ filter: { agentIds: [agentId], cursor, limit: 1000 } }); runs.push(...page.items); cursor = page.nextCursor; } while (cursor);
			run = runs.sort((a, b) => b.turnNumber - a.turnNumber)[0];
		}
		if (!run || run.status !== "error" || !run.latestCheckpointRef || !run.error || !await this.raw.checkpoints.get({ agentId, blobId: run.latestCheckpointRef.rootBlobId })) { return undefined; }
		const turns = await conversation(run.runId), calls: CursorFailedTurn["calls"] = [];
		if (!Array.isArray(turns) || !turns.length) { return undefined; }
		for (const value of turns) {
			const turn = record(value), body = record(turn?.turn);
			if (turn?.type !== "agentConversationTurn" || !Array.isArray(body?.steps)) { return undefined; }
			for (const value of body.steps) {
				const step = record(value); if (step?.type !== "toolCall") { continue; }
				const message = record(step.message), result = record(message?.result);
				if (result?.status !== "success" && result?.status !== "error") { return undefined; }
				const args = record(message?.args);
				if (message?.type === "mcp" && typeof args?.toolName === "string" && args.toolName.startsWith("vscode_")) { calls.push({ alias: args.toolName, input: args.args }); }
			}
		}
		const uncheckpointedCalls = await this.uncheckpointedCalls(run.runId, calls);
		if (!uncheckpointedCalls) { return undefined; }
		return { runId: run.runId, error: run.error, checkpoint: run.latestCheckpointRef, startCheckpoint: run.startCheckpointRef, calls, uncheckpointedCalls };
	}
	private async uncheckpointedCalls(runId: string, checkpointed: CursorFailedTurn["calls"]): Promise<CursorFailedTurn["calls"] | undefined> {
		const events = new Map<string, CursorFailedTurn["calls"][number]>();
		let offset: string | undefined, scanned = 0;
		do {
			const page = await this.raw.runEvents.list({ runId, afterOffset: offset, limit: 1000 });
			for (const event of page.items) {
				if (++scanned > 200_000) { return undefined; }
				const message = record(record(event.payload)?.message), args = record(message?.args);
				if (message?.type !== "tool_call" || typeof args?.toolName !== "string" || !args.toolName.startsWith("vscode_")) { continue; }
				if (typeof message.call_id !== "string" || !message.call_id || events.size >= 512 && !events.has(message.call_id)) { return undefined; }
				const call = { alias: args.toolName, input: args.args }, old = events.get(message.call_id);
				if (old && cursorCallSignature(old.alias, old.input) !== cursorCallSignature(call.alias, call.input)) { return undefined; }
				events.set(message.call_id, call);
			}
			offset = page.nextOffset ?? undefined;
		} while (offset);
		if (!events.size) { return []; } // Older stores can lack the stream log.
		const remaining = new Map<string, number>();
		for (const call of checkpointed) { const key = cursorCallSignature(call.alias, call.input); remaining.set(key, (remaining.get(key) ?? 0) + 1); }
		const extra: CursorFailedTurn["calls"] = [];
		for (const call of events.values()) {
			const key = cursorCallSignature(call.alias, call.input), count = remaining.get(key) ?? 0;
			if (count) { remaining.set(key, count - 1); } else { extra.push(call); }
		}
		return [...remaining.values()].some(count => count > 0) ? undefined : extra;
	}
}