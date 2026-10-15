import { createHash, randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { conversationUserAnchors } from "../providers/conversation-anchors";
import type { CocoAcpClient, CocoAcpHandlers, CocoInitializeResult } from "./acp-client";

const STORAGE_KEY = "llamacpp.coco.sessions.v1";
const MAX_SAVED = 32;
const MAX_LIVE = 8;
const MAX_AGE = 7 * 24 * 60 * 60_000;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Json = Record<string, unknown>;

export interface CocoUserAnchor { key: string; index: number }
export function cocoUserAnchors(messages: readonly vscode.LanguageModelChatRequestMessage[]): CocoUserAnchor[] {
	return conversationUserAnchors(messages);
}

interface SavedSession { key: string; identity: string; sessionId: string; users: string[]; updatedAt: number; contextWindow?: number }
export interface CocoSession {
	key: string; identity: string; persistent: boolean; client: CocoAcpClient;
	sessionId?: string; users: string[]; initialized?: CocoInitializeResult;
	ready: boolean; fresh: boolean; busy: boolean; closed: boolean; forward: boolean; importing: boolean;
	mode: "new" | "warm" | "restored" | "resume-fallback";
	reason?: string; deltaStart: number; toolSignature?: string; contextWindow?: number;
	handlers: CocoAcpHandlers; touchedAt: number; idle?: ReturnType<typeof setTimeout>;
}

/** Only ids/fingerprints are stored here. The CLI owns its native transcript. */
export class CocoSessionStore {
	private readonly live = new Map<string, CocoSession>();
	private readonly saved = new Map<string, SavedSession>();
	private writes = Promise.resolve();
	constructor(private readonly state?: vscode.Memento) {
		const stored = state?.get<unknown>(STORAGE_KEY, []);
		for (const item of Array.isArray(stored) ? stored : []) {
			if (!item || typeof item !== "object") { continue; }
			const value = item as SavedSession;
			if (![value.key, value.identity].every(s => typeof s === "string" && /^[a-f0-9]{64}$/.test(s))
				|| typeof value.sessionId !== "string" || !/^[\w-]{1,160}$/.test(value.sessionId)
				|| !Array.isArray(value.users) || value.users.length > 10_000 || !value.users.every(s => typeof s === "string" && /^[a-f0-9]{64}$/.test(s))
				|| !Number.isFinite(value.updatedAt) || Date.now() - value.updatedAt > MAX_AGE) { continue; }
			this.saved.set(value.key, value);
		}
	}

	static identity(executable: string, cwd: string, connection: string | undefined, model: string): string {
		return digest([executable, cwd, connection, model]);
	}
	window(identity: string): number | undefined {
		const value = [...this.saved.values()].filter(s => s.identity === identity).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.contextWindow;
		return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
	}

	acquire(identity: string, conversation: unknown, anchors: readonly CocoUserAnchor[], create: (handlers: CocoAcpHandlers) => CocoAcpClient, handlers: CocoAcpHandlers): CocoSession {
		const persistent = typeof conversation === "string" && conversation.trim().length > 0 && conversation.length <= 512;
		const key = persistent ? digest([identity, conversation]) : randomUUID();
		let session = this.live.get(key);
		if (session?.busy) { throw new Error("This Coco conversation still has an active request. Finish or cancel it before starting another."); }
		const saved = session ?? this.saved.get(key);
		const users = anchors.map(a => a.key);
		const compatible = saved && saved.identity === identity && saved.users.length < users.length && saved.users.every((s, i) => s === users[i]);
		let reason: string | undefined;
		if (saved && !compatible) {
			reason = "history_changed";
			this.drop(key, true); session = undefined;
		}
		if (!session) {
			const checkpoint = compatible ? this.saved.get(key) : undefined;
			const record: CocoSession = {
				key, identity, persistent, client: undefined!, sessionId: checkpoint?.sessionId, users: checkpoint?.users ?? [],
				ready: false, fresh: true, busy: true, closed: false, forward: false, importing: false,
				mode: checkpoint ? "restored" : "new", reason, deltaStart: 0, handlers, touchedAt: Date.now(), contextWindow: checkpoint?.contextWindow,
			};
			record.client = create({
				onUpdate: update => { if (record.forward && !record.closed) { record.handlers.onUpdate?.(update); } },
				onPermission: async request => record.forward && !record.importing && !record.closed ? record.handlers.onPermission?.(request) : undefined,
				onClientTool: async (name, input) => {
					if (!record.forward || record.importing || record.closed || !record.handlers.onClientTool) { throw new Error("Tools are disabled while Coco restores conversation history."); }
					return record.handlers.onClientTool(name, input);
				},
			});
			this.live.set(key, record); session = record;
		} else {
			clearTimeout(session.idle); session.mode = "warm"; session.reason = undefined; session.busy = true; session.handlers = handlers;
		}
		session.deltaStart = compatible ? anchors[saved!.users.length].index : 0;
		session.touchedAt = Date.now();
		return session;
	}

	async prepare(session: CocoSession, cwd: string, tools: Json[]): Promise<Json> {
		// A crash during a prompt must never restore a partially modified native history.
		this.saved.delete(session.key); await this.flush(true);
		const signature = digest(tools);
		let result: Json = {};
		if (!session.ready) {
			session.initialized = await session.client.initialize();
			if (session.closed) { throw new vscode.CancellationError(); }
		}
		if (session.sessionId && (!session.ready || session.toolSignature !== signature)) {
			if (session.initialized?.agentCapabilities?.loadSession === true) {
				try {
					result = await session.client.loadSession(session.sessionId, cwd, tools);
					session.fresh = false;
				} catch {
					session.sessionId = undefined; session.mode = "resume-fallback"; session.reason = "load_failed";
				}
			} else {
				session.sessionId = undefined; session.mode = "resume-fallback"; session.reason = "load_unsupported";
			}
		}
		if (!session.sessionId) {
			result = await session.client.newSession(cwd, tools);
			if (typeof result.sessionId !== "string" || !result.sessionId) { throw new Error("Coco did not return a session ID."); }
			session.sessionId = result.sessionId; session.fresh = true;
		}
		if (session.closed) { throw new vscode.CancellationError(); }
		session.ready = true; session.toolSignature = signature;
		return result;
	}

	async checkpoint(session: CocoSession, anchors: readonly CocoUserAnchor[]): Promise<void> {
		if (session.closed || !session.sessionId) { return; }
		session.fresh = false;
		session.users = anchors.map(a => a.key);
		if (session.persistent && session.users.length <= 10_000) {
			this.saved.set(session.key, { key: session.key, identity: session.identity, sessionId: session.sessionId, users: session.users, updatedAt: Date.now(), contextWindow: session.contextWindow });
			await this.flush();
		}
	}
	finish(session: CocoSession, error?: Error): void {
		session.busy = false; session.forward = false; session.handlers = {}; session.touchedAt = Date.now();
		if (error || !session.persistent) { this.drop(session.key, true); return; }
		session.idle = setTimeout(() => this.drop(session.key, false), 30 * 60_000); session.idle.unref?.();
		for (const candidate of [...this.live.values()].filter(s => !s.busy).sort((a, b) => a.touchedAt - b.touchedAt)) {
			if (this.live.size <= MAX_LIVE) { break; } this.drop(candidate.key, false);
		}
	}
	clear(): void { for (const key of [...this.live.keys()]) { this.drop(key, true); } this.saved.clear(); void this.flush(); }
	dispose(): void { for (const key of [...this.live.keys()]) { this.drop(key, false); } }
	private drop(key: string, forget: boolean): void {
		const session = this.live.get(key);
		if (session) { session.closed = true; clearTimeout(session.idle); session.client.dispose(); this.live.delete(key); }
		if (forget) { this.saved.delete(key); void this.flush(); }
	}
	private flush(strict = false): Promise<void> {
		for (const item of [...this.saved.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(MAX_SAVED)) { this.saved.delete(item.key); }
		const snapshot = [...this.saved.values()];
		this.writes = this.writes.catch(() => undefined).then(async () => { await this.state?.update(STORAGE_KEY, snapshot); }).catch(() => {
			// Keep the warm process usable; a failed checkpoint must not be advertised as durable.
			this.saved.clear();
			if (strict) { throw new Error("Cannot checkpoint Coco before starting the request. Check VS Code workspace storage and retry."); }
		});
		return this.writes;
	}
}