import { randomUUID } from "node:crypto";
import type * as vscode from "vscode";
import type { CursorLocalAgent } from "./sdk-transport";
import { conversationUserAnchors } from "../providers/conversation-anchors";

const STORAGE_KEY = "llamacpp.cursor.sessions.v1";
interface Checkpoint { key: string; identity: string; agentId: string; users: string[]; updatedAt: number }
export interface CursorSession {
	key: string; identity: string; users: string[]; nextUsers: string[]; persistent: boolean; busy: boolean; closed: boolean;
	agentId?: string; agent?: CursorLocalAgent; deltaStart: number; touchedAt: number; idle?: ReturnType<typeof setTimeout>;
	mode: "new" | "warm" | "restored" | "resume-fallback";
}

/** Completed native checkpoints only; credentials and chat text never enter Memento. */
export class CursorSessionStore {
	private readonly live = new Map<string, CursorSession>();
	private readonly saved = new Map<string, Checkpoint>();
	private writes = Promise.resolve();
	constructor(private readonly state?: vscode.Memento) {
		const stored = state?.get<unknown>(STORAGE_KEY, []);
		for (const item of Array.isArray(stored) ? stored : []) {
			const value = item as Checkpoint;
			if (!value || ![value.key, value.identity].every(s => typeof s === "string" && /^[a-f0-9]{64}$/.test(s))
				|| typeof value.agentId !== "string" || !/^[\w-]{1,160}$/.test(value.agentId)
				|| !Array.isArray(value.users) || value.users.length > 10_000 || !value.users.every(s => typeof s === "string" && /^[a-f0-9]{64}$/.test(s))
				|| !Number.isFinite(value.updatedAt) || Date.now() - value.updatedAt > 7 * 86400_000) { continue; }
			this.saved.set(value.key, value);
		}
	}
	acquire(key: string | undefined, identity: string, messages: readonly vscode.LanguageModelChatRequestMessage[]): CursorSession {
		const persistent = Boolean(key), actualKey = key ?? randomUUID(), anchors = conversationUserAnchors(messages);
		let record = this.live.get(actualKey);
		if (record?.busy) { throw new Error("This Cursor conversation still has an active request."); }
		const previous = record ?? this.saved.get(actualKey), users = anchors.map(anchor => anchor.key);
		const compatible = previous && previous.identity === identity && previous.users.length < users.length && previous.users.every((s, i) => s === users[i]);
		if (previous && !compatible) { this.drop(actualKey); record = undefined; }
		if (!record) {
			const checkpoint = compatible ? this.saved.get(actualKey) : undefined;
			record = { key: actualKey, identity, persistent, agentId: checkpoint?.agentId, users: checkpoint?.users ?? [], nextUsers: users,
				mode: checkpoint ? "restored" : "new", busy: true, closed: false, deltaStart: 0, touchedAt: Date.now() };
			this.live.set(actualKey, record);
		} else { clearTimeout(record.idle); record.busy = true; record.mode = "warm"; record.nextUsers = users; }
		record.deltaStart = compatible ? anchors[previous!.users.length].index : 0;
		return record;
	}
	async begin(record: CursorSession): Promise<void> {
		this.saved.delete(record.key); await this.flush();
	}
	async complete(record: CursorSession): Promise<void> {
		if (record.closed) { return; }
		record.users = record.nextUsers; record.touchedAt = Date.now();
		const agentId = record.agent?.agentId;
		if (record.persistent && agentId && /^[\w-]{1,160}$/.test(agentId)) {
			record.agentId = agentId;
			this.saved.set(record.key, { key: record.key, identity: record.identity, agentId, users: record.users, updatedAt: record.touchedAt });
			await this.flush();
		}
		if (record.closed) { return; }
		record.busy = false;
		if (!record.persistent || !agentId) { this.close(record); return; }
		record.idle = setTimeout(() => this.close(record), 30 * 60_000); record.idle.unref?.();
		const idle = [...this.live.values()].filter(s => !s.busy).sort((a, b) => a.touchedAt - b.touchedAt);
		for (const old of idle.slice(0, Math.max(0, idle.length - 8))) { this.close(old); }
	}
	fail(record: CursorSession): void { this.saved.delete(record.key); this.close(record); void this.flush().catch(() => undefined); }
	private drop(key: string): void { const record = this.live.get(key); if (record) { this.close(record); } this.saved.delete(key); }
	private close(record: CursorSession): void {
		if (record.closed) { return; }
		record.closed = true; clearTimeout(record.idle); record.agent?.close();
		if (this.live.get(record.key) === record) { this.live.delete(record.key); }
	}
	private flush(): Promise<void> {
		const values = [...this.saved.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 32);
		this.saved.clear(); for (const value of values) { this.saved.set(value.key, value); }
		const write = this.writes.catch(() => undefined).then(() => this.state?.update(STORAGE_KEY, values));
		this.writes = write.then(() => undefined); return this.writes;
	}
	dispose(): void { for (const record of [...this.live.values()]) { if (record.busy) { this.fail(record); } else { this.close(record); } } }
}