import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import type { CursorLocalAgent } from "./sdk-transport";
import type { CursorNativeCheckpoint } from "./native-store";
import type { CursorLegacyRecovery } from "./legacy-recovery";
import { conversationUserAnchors, canonicalConversationUserAnchors } from "../providers/conversation-anchors";
import { cursorFailedTurnBoundary } from "./tool-turn-recovery";

const STORAGE_KEY = "llamacpp.cursor.sessions.v1";
interface Checkpoint { key: string; identity: string; agentId: string; users: string[]; updatedAt: number; anchorVersion?: 2; nativeCheckpoint?: CursorNativeCheckpoint; inflight?: boolean; completedAt?: number; toolCatalogHash?: string; replayCallIds?: string[]; failedCallIds?: string[] }
interface ToolFailure { key: string; identity: string; callIds: string[]; message: string; updatedAt: number }
const diskWrites = new Map<string, Promise<void>>();
export interface CursorSession {
	key: string; identity: string; users: string[]; nextUsers: string[]; persistent: boolean; busy: boolean; closed: boolean;
	agentId?: string; agent?: CursorLocalAgent; deltaStart: number; touchedAt: number; idle?: ReturnType<typeof setTimeout>;
	mode: "new" | "warm" | "restored" | "resume-fallback";
	anchorVersion?: 2; reason?: string;
	nativeCheckpoint?: CursorNativeCheckpoint;
	completedAt?: number; toolCatalogHash?: string;
	replayCallIds?: string[];
	/** VS Code tool calls of the failed run whose checkpoint this session holds. */
	failedCallIds?: string[];
	/** Saved boundary before acquire rebased it; restored when no inference starts. */
	committed?: { users: string[]; failedCallIds?: string[] };
}

/** Completed native checkpoints only; credentials and chat text never enter Memento. */
export class CursorSessionStore {
	private readonly live = new Map<string, CursorSession>();
	private readonly saved = new Map<string, Checkpoint>();
	private readonly failures = new Map<string, ToolFailure>();
	private writes = Promise.resolve();
	private readonly ready: Promise<void>;
	constructor(private readonly state?: vscode.Memento, private readonly file?: string) {
		const stored = state?.get<unknown>(STORAGE_KEY, []);
		this.accept(stored);
		this.ready = this.load();
		void this.ready.catch(() => undefined); // Surface read failures when a request awaits acquire.
	}
	private accept(stored: unknown): void {
		for (const item of Array.isArray(stored) ? stored : []) {
			const value = item as Checkpoint;
			if (!value || ![value.key, value.identity].every(s => typeof s === "string" && /^[a-f0-9]{64}$/.test(s))
				|| typeof value.agentId !== "string" || !/^[\w-]{1,160}$/.test(value.agentId)
				|| !Array.isArray(value.users) || value.users.length > 10_000 || !value.users.every(s => typeof s === "string" && /^[a-f0-9]{64}$/.test(s))
				|| !Number.isFinite(value.updatedAt) || Date.now() - value.updatedAt > 7 * 86400_000) { continue; }
			if (value.nativeCheckpoint && (value.nativeCheckpoint.schemaVersion !== 1 || typeof value.nativeCheckpoint.rootBlobId !== "string" || !/^[\w+/=-]{1,256}$/.test(value.nativeCheckpoint.rootBlobId))) { continue; }
			if (value.inflight && !value.nativeCheckpoint) { continue; }
			if ([value.replayCallIds, value.failedCallIds].some(ids => ids !== undefined && (!Array.isArray(ids) || ids.length > 512 || !ids.every(id => typeof id === "string" && /^cursor-[\w-]{1,160}$/.test(id))))) { continue; }
			if (!this.saved.has(value.key) || this.saved.get(value.key)!.updatedAt <= value.updatedAt) { this.saved.set(value.key, value); }
		}
	}
	private async load(): Promise<void> {
		if (!this.file) { return; }
		await diskWrites.get(this.file)?.catch(() => undefined);
		try {
			if ((await fs.stat(this.file)).size > 32 * 1024 * 1024) { throw new Error("Cursor session bindings exceed the storage limit."); }
			const saved = JSON.parse(await fs.readFile(this.file, "utf8")) as { version?: unknown; sessions?: unknown; failures?: unknown };
			if (saved.version !== 1 || !Array.isArray(saved.sessions)) { throw new Error("Invalid Cursor session bindings. The native history was preserved."); }
			this.accept(saved.sessions);
			for (const value of Array.isArray(saved.failures) ? saved.failures : []) {
				const failure = value as ToolFailure;
				if (failure && [failure.key, failure.identity].every(key => typeof key === "string" && /^[a-f0-9]{64}$/.test(key))
					&& Array.isArray(failure.callIds) && failure.callIds.length <= 512 && failure.callIds.every(id => typeof id === "string" && /^cursor-[\w-]{1,160}$/.test(id))
					&& typeof failure.message === "string" && failure.message.length <= 2000 && Number.isFinite(failure.updatedAt) && Date.now() - failure.updatedAt < 86400_000) { this.failures.set(failure.key, failure); }
			}
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; } }
	}
	async acquire(key: string | undefined, identity: string, messages: readonly vscode.LanguageModelChatRequestMessage[], legacyIdentities: readonly string[] = []): Promise<CursorSession> {
		await this.ready;
		const persistent = Boolean(key), actualKey = key ?? randomUUID(), canonical = canonicalConversationUserAnchors(messages);
		let record = this.live.get(actualKey);
		if (record?.busy) { throw new Error("This Cursor conversation still has an active request."); }
		const previous = record ?? this.saved.get(actualKey), users = canonical.map(anchor => anchor.key);
		const anchors = previous?.anchorVersion === 2 ? canonical : conversationUserAnchors(messages);
		const sameIdentity = previous && (previous.identity === identity || legacyIdentities.includes(previous.identity));
		// Retention, host-prefix changes and text-part repacking can alter old entries.
		// A retained last completed user anchor still establishes the native continuation boundary.
		const prefix = sameIdentity && previous.users.length < anchors.length && previous.users.every((s, i) => s === anchors[i].key);
		const retained = sameIdentity && previous.users.length ? anchors.slice(0, -1).findLastIndex(anchor => anchor.key === previous.users.at(-1)) : -1;
		// A failed run's checkpoint is located by its own tool calls. Checkpoints saved before
		// failedCallIds existed are recognised by the failure receipt written with them.
		const failure = this.failures.get(actualKey);
		const failedCallIds = previous?.failedCallIds ?? (previous?.completedAt !== undefined && failure?.identity === previous.identity && Math.abs(failure.updatedAt - previous.completedAt) < 60_000 ? failure.callIds : undefined);
		const failedBoundary = sameIdentity && failedCallIds?.length ? cursorFailedTurnBoundary(messages, failedCallIds) : -1;
		const compatible = failedBoundary >= 0 || prefix || retained >= 0;
		if (sameIdentity && !compatible) {
			throw new Error("Cursor could not match this request to its completed native history. No inference was started and the existing session was preserved. Restore the original chat branch or start a new chat; automatic full-history replay is disabled.");
		}
		if (previous && !compatible) { this.drop(actualKey); record = undefined; }
		if (!record) {
			const checkpoint = compatible ? this.saved.get(actualKey) : undefined;
			record = { key: actualKey, identity, persistent, agentId: checkpoint?.agentId, users: checkpoint?.users ?? [], nextUsers: users,
				mode: checkpoint ? "restored" : "new", busy: true, closed: false, deltaStart: 0, touchedAt: Date.now(), anchorVersion: 2,
				nativeCheckpoint: checkpoint?.nativeCheckpoint, completedAt: checkpoint?.completedAt, toolCatalogHash: checkpoint?.toolCatalogHash, replayCallIds: checkpoint?.replayCallIds,
				reason: previous && !sameIdentity ? "configuration_changed" : checkpoint?.inflight ? "interrupted_request" : checkpoint ? "checkpoint_loaded" : "new_conversation" };
			this.live.set(actualKey, record);
		} else { clearTimeout(record.idle); record.busy = true; record.mode = "warm"; record.nextUsers = users; }
		record.identity = identity; record.anchorVersion = 2;
		record.committed = compatible ? { users: [...record.users], failedCallIds } : undefined;
		if (compatible) { record.reason = failedBoundary >= 0 ? "failed_turn_continued" : prefix ? "history_extended" : "history_rebased"; }
		record.deltaStart = !compatible ? 0 : failedBoundary >= 0 ? failedBoundary : anchors[prefix ? previous!.users.length : retained + 1].index;
		if (compatible) { record.users = canonical.filter(anchor => anchor.index < record!.deltaStart).map(anchor => anchor.key); record.failedCallIds = undefined; }
		return record;
	}
	async toolFailure(key: string | undefined, identity: string, callIds: readonly string[]): Promise<string | undefined> {
		await this.ready; const failure = key ? this.failures.get(key) : undefined;
		return failure?.identity === identity && callIds.length && callIds.every(id => failure.callIds.includes(id)) ? failure.message : undefined;
	}
	async rememberToolFailure(key: string, identity: string, callIds: readonly string[], message: string): Promise<void> {
		await this.ready;
		this.failures.set(key, { key, identity, callIds: [...new Set(callIds)].slice(-512), message: message.slice(0, 2000), updatedAt: Date.now() });
		while (this.failures.size > 32) { this.failures.delete(this.failures.keys().next().value!); }
		await this.flush();
	}
	async interrupted(key: string | undefined, identity: string): Promise<Checkpoint | undefined> {
		await this.ready; const saved = key ? this.saved.get(key) : undefined;
		return saved?.identity === identity && saved.inflight && saved.nativeCheckpoint && !this.live.get(saved.key)?.busy ? saved : undefined;
	}
	async repairFailed(key: string, identity: string, agentId: string, users: string[], nativeCheckpoint: CursorNativeCheckpoint, replayCallIds?: string[], failedCallIds?: string[]): Promise<void> {
		this.saved.set(key, { key, identity, agentId, users, nativeCheckpoint, replayCallIds, failedCallIds, anchorVersion: 2, updatedAt: Date.now() });
		const live = this.live.get(key); if (live && !live.busy) { this.close(live); }
		await this.flush();
	}
	async recover(record: CursorSession, recovered: CursorLegacyRecovery): Promise<void> {
		if (record.closed || !record.persistent || record.agentId || record.reason !== "new_conversation"
			|| [...this.saved.values()].some(saved => saved.agentId === recovered.agentId && saved.key !== record.key)) { throw new Error("Cannot attach this Cursor native session to the current chat."); }
		Object.assign(record, recovered, { mode: "restored", reason: "legacy_binding_recovered" });
		this.saved.set(record.key, { key: record.key, identity: record.identity, agentId: recovered.agentId, users: recovered.users, nativeCheckpoint: recovered.nativeCheckpoint, anchorVersion: 2, updatedAt: Date.now() });
		await this.flush();
	}
	async begin(record: CursorSession): Promise<void> {
		if (record.closed) { return; }
		if (record.persistent && record.agentId && record.users.length && record.nativeCheckpoint) {
			this.saved.set(record.key, { key: record.key, identity: record.identity, agentId: record.agentId, users: record.users, updatedAt: record.touchedAt, anchorVersion: 2, nativeCheckpoint: record.nativeCheckpoint, inflight: true, completedAt: record.completedAt, toolCatalogHash: record.toolCatalogHash, replayCallIds: record.replayCallIds });
		} else { this.saved.delete(record.key); }
		await this.flush();
	}
	async complete(record: CursorSession): Promise<void> {
		if (record.closed) { return; }
		record.users = record.nextUsers; record.touchedAt = Date.now(); record.completedAt = record.touchedAt;
		const agentId = record.agent?.agentId;
		if (record.persistent && agentId && /^[\w-]{1,160}$/.test(agentId)) {
			record.agentId = agentId;
			this.saved.set(record.key, { key: record.key, identity: record.identity, agentId, users: record.users, updatedAt: record.touchedAt, anchorVersion: 2, nativeCheckpoint: record.nativeCheckpoint, completedAt: record.completedAt, toolCatalogHash: record.toolCatalogHash, replayCallIds: record.replayCallIds, failedCallIds: record.failedCallIds });
			await this.flush();
		}
		if (record.closed) { return; }
		record.busy = false;
		if (!record.persistent || !agentId) { this.close(record); return; }
		record.idle = setTimeout(() => this.close(record), 30 * 60_000); record.idle.unref?.();
		const idle = [...this.live.values()].filter(s => !s.busy).sort((a, b) => a.touchedAt - b.touchedAt);
		for (const old of idle.slice(0, Math.max(0, idle.length - 8))) { this.close(old); }
	}
	async releaseUnstarted(record: CursorSession): Promise<void> {
		if (record.closed) { return; }
		const agentId = record.agent?.agentId ?? record.agentId;
		// Nothing reached the native agent, so keep the boundary that was saved before this request.
		if (record.committed) { record.users = record.committed.users; record.failedCallIds = record.committed.failedCallIds; record.committed = undefined; }
		if (!record.persistent || !agentId || !record.users.length || record.mode === "resume-fallback") { this.close(record); return; }
		record.busy = false;
		this.saved.set(record.key, { key: record.key, identity: record.identity, agentId, users: record.users, updatedAt: Date.now(), anchorVersion: 2, nativeCheckpoint: record.nativeCheckpoint, completedAt: record.completedAt, toolCatalogHash: record.toolCatalogHash, replayCallIds: record.replayCallIds, failedCallIds: record.failedCallIds });
		record.idle = setTimeout(() => this.close(record), 30 * 60_000); record.idle.unref?.();
		await this.flush();
	}
	fail(record: CursorSession): void { this.close(record); }
	settle(): Promise<void> { return this.writes.catch(() => undefined); }
	private drop(key: string): void { const record = this.live.get(key); if (record) { this.close(record); } this.saved.delete(key); }
	private close(record: CursorSession): void {
		if (record.closed) { return; }
		record.closed = true; clearTimeout(record.idle); record.agent?.close();
		if (this.live.get(record.key) === record) { this.live.delete(record.key); }
	}
	private flush(): Promise<void> {
		const values = [...this.saved.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 32);
		const failures = [...this.failures.values()].filter(value => Date.now() - value.updatedAt < 86400_000).slice(-32);
		this.saved.clear(); for (const value of values) { this.saved.set(value.key, value); }
		const write = this.writes.catch(() => undefined).then(async () => {
			if (this.file) {
				const file = this.file;
				const disk = (diskWrites.get(file) ?? Promise.resolve()).catch(() => undefined).then(async () => {
					await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
					await fs.writeFile(`${file}.tmp`, JSON.stringify({ version: 1, sessions: values, failures }), { mode: 0o600 });
					await fs.rename(`${file}.tmp`, file);
				});
				diskWrites.set(file, disk);
				try { await disk; } finally { if (diskWrites.get(file) === disk) { diskWrites.delete(file); } }
			}
			await this.state?.update(STORAGE_KEY, values);
		});
		this.writes = write.then(() => undefined); return this.writes;
	}
	dispose(): void { for (const record of [...this.live.values()]) { if (record.busy) { this.fail(record); } else { this.close(record); } } }
}