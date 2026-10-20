import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { conversationUserAnchors, canonicalConversationUserAnchors } from "../providers/conversation-anchors";
import type { CocoSessionClient, CocoAcpHandlers, CocoInitializeResult } from "./acp-client";

const STORAGE_KEY = "llamacpp.coco.sessions.v1";
const MAX_SAVED = 32;
const MAX_LIVE = 8;
const MAX_AGE = 7 * 24 * 60 * 60_000;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Json = Record<string, unknown>;

export interface CocoUserAnchor { key: string; index: number }
export function cocoUserAnchors(messages: readonly vscode.LanguageModelChatRequestMessage[]): CocoUserAnchor[] {
	return canonicalConversationUserAnchors(messages);
}

interface SavedSession { key: string; identity: string; sessionId: string; users: string[]; updatedAt: number; contextWindow?: number; inflight?: boolean; completedUsers?: string[] }
export interface CocoSession {
	key: string; identity: string; persistent: boolean; client: CocoSessionClient;
	sessionId?: string; users: string[]; initialized?: CocoInitializeResult;
	ready: boolean; fresh: boolean; busy: boolean; closed: boolean; forward: boolean; importing: boolean;
	mode: "new" | "warm" | "restored" | "resume-fallback";
	reason?: string; deltaStart: number; toolSignature?: string; contextWindow?: number;
	handlers: CocoAcpHandlers; touchedAt: number; idle?: ReturnType<typeof setTimeout>;
	promptSent?: boolean; beforePrompt?: SavedSession;
	promptPrepared?: boolean;
}

/** Only ids/fingerprints are stored here. The CLI owns its native transcript. */
export class CocoSessionStore {
	private readonly live = new Map<string, CocoSession>();
	private readonly saved = new Map<string, SavedSession>();
	private writes = Promise.resolve();
	private readonly ready: Promise<void>;
	constructor(private readonly state?: vscode.Memento, private readonly file?: string) {
		const stored = state?.get<unknown>(STORAGE_KEY, []);
		this.accept(stored);
		this.ready = this.load(); void this.ready.catch(() => undefined);
	}
	private accept(stored: unknown): void {
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
	private async load(): Promise<void> {
		if (!this.file) { return; }
		try {
			if ((await fs.stat(this.file)).size > 16 * 1024 * 1024) { throw new Error("Coco session bindings exceed the storage limit."); }
			const document = JSON.parse(await fs.readFile(this.file, "utf8")) as { version?: unknown; sessions?: unknown };
			if (document.version !== 1 || !Array.isArray(document.sessions)) { throw new Error("Invalid Coco session bindings. Native history was preserved."); }
			this.saved.clear(); this.accept(document.sessions);
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; } }
	}
	async hasBinding(identity: string, conversation: unknown, anchors: readonly CocoUserAnchor[]): Promise<boolean> {
		await this.ready;
		const key = digest([identity, conversation]), record = this.live.get(key) ?? this.saved.get(key);
		return Boolean(record && record.users.length <= anchors.length && record.users.every((key,i) => key === anchors[i].key));
	}

	static identity(executable: string, cwd: string, connection: string | undefined, model: string): string {
		return digest([executable, cwd, connection, model]);
	}
	window(identity: string): number | undefined {
		const value = [...this.saved.values()].filter(s => s.identity === identity).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.contextWindow;
		return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
	}

	async acquire(identity: string, conversation: unknown, anchors: readonly CocoUserAnchor[], create: (handlers: CocoAcpHandlers) => CocoSessionClient, handlers: CocoAcpHandlers, messages: readonly vscode.LanguageModelChatRequestMessage[] = [], callbackTools = false): Promise<CocoSession> {
		await this.ready;
		const persistent = typeof conversation === "string" && conversation.trim().length > 0 && conversation.length <= 512;
		const key = persistent ? digest([identity, conversation]) : randomUUID();
		let session = this.live.get(key);
		if (session?.busy) { throw new Error("This Coco conversation still has an active request. Finish or cancel it before starting another."); }
		if (callbackTools && session?.client.transport === "sdk") {
			const client = session.client;
			this.drop(key, false);
			await client.waitForExit?.();
			session = undefined;
		}
		const saved = session ?? this.saved.get(key);
		const users = anchors.map(a => a.key);
		if (saved && !saved.users.every((key, index) => key === users[index])) {
			const legacy = conversationUserAnchors(messages);
			if (saved.users.length < legacy.length && saved.users.every((key, index) => key === legacy[index].key)) {
				saved.users = users.slice(0, saved.users.length);
			}
		}
		const stored = this.saved.get(key);
		if (stored?.inflight && stored.users.length === users.length && stored.users.every((s,i) => s === users[i])) {
			throw new Error("The previous Coco native turn was interrupted. Send a new user message to continue its saved session. No tools were repeated.");
		}
		const previousTurn = saved && saved.users.length > 0 ? anchors[saved.users.length - 1]?.index : undefined;
		const nextTurn = saved ? anchors[saved.users.length]?.index : undefined;
		const failedAnswer = previousTurn !== undefined && nextTurn !== undefined && messages.slice(previousTurn + 1,nextTurn).some(message =>
			message.role === vscode.LanguageModelChatMessageRole.Assistant && message.content.some(part => part instanceof vscode.LanguageModelTextPart
				&& /^\s*Error: internal error \(request_id: [a-f0-9-]{36}\)\s*$/i.test(part.value)));
		const compatible = saved && !failedAnswer && saved.identity === identity && saved.users.length < users.length && saved.users.every((s, i) => s === users[i]);
		let reason: string | undefined = stored?.inflight ? "interrupted_native_session" : undefined;
		if (saved && !compatible) {
			reason = failedAnswer ? "native_error_recovery" : "history_changed";
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
				onClientTool: async (name, input, nativeCallId) => {
					if (!record.forward || record.importing || record.closed || !record.handlers.onClientTool) { throw new Error("Tools are disabled while Coco restores conversation history."); }
					return record.handlers.onClientTool(name, input, nativeCallId);
				},
			});
			this.live.set(key, record); session = record;
		} else {
			clearTimeout(session.idle); session.mode = "warm"; session.reason = undefined; session.busy = true; session.handlers = handlers;
		}
		session.deltaStart = compatible ? anchors[saved!.users.length].index : 0;
		session.promptSent = false;
		session.promptPrepared = false;
		session.beforePrompt = undefined;
		session.touchedAt = Date.now();
		return session;
	}

	async prepare(session: CocoSession, cwd: string, tools: Json[]): Promise<Json> {
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
				} catch (error) {
					session.reason = "load_failed";
					throw new Error("Coco could not load its saved native session. The binding was preserved; no history replay was started.", { cause: error });
				}
			} else {
				session.reason = "load_unsupported";
				throw new Error("This Coco runtime cannot load the saved native session. Update the CLI; no cold replay was started.");
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
	async startPrompt(session: CocoSession, anchors: readonly CocoUserAnchor[]): Promise<void> {
		session.promptPrepared = true;
		session.beforePrompt = this.saved.get(session.key);
		if (session.persistent && session.sessionId) {
			this.saved.set(session.key, { key: session.key, identity: session.identity, sessionId: session.sessionId,
				users: anchors.map(a => a.key), completedUsers: session.users, updatedAt: Date.now(), contextWindow: session.contextWindow, inflight: true });
			await this.flush(true);
		}
		session.promptSent = true;
	}

	async checkpoint(session: CocoSession, anchors: readonly CocoUserAnchor[]): Promise<void> {
		if (session.closed || !session.sessionId) { return; }
		session.fresh = false;
		session.users = anchors.map(a => a.key);
		if (session.persistent && session.users.length <= 10_000) {
			this.saved.set(session.key, { key: session.key, identity: session.identity, sessionId: session.sessionId, users: session.users, updatedAt: Date.now(), contextWindow: session.contextWindow });
			await this.flush(true);
		}
	}
	finish(session: CocoSession, error?: Error): void {
		session.busy = false; session.forward = false; session.handlers = {}; session.touchedAt = Date.now();
		if (error) {
			if (session.promptSent && session.client.lastPromptSent !== false) { this.drop(session.key, false); return; }
			if (session.beforePrompt) { this.saved.set(session.key, session.beforePrompt); }
			else if (session.promptPrepared) { this.saved.delete(session.key); }
			if (session.promptPrepared) { void this.flush(); }
			if (session.promptSent && session.client.lastPromptSent === false) { this.drop(session.key,false); return; }
		}
		if (!session.persistent) { this.drop(session.key, true); return; }
		session.idle = setTimeout(() => this.drop(session.key, false), 30 * 60_000); session.idle.unref?.();
		for (const candidate of [...this.live.values()].filter(s => !s.busy).sort((a, b) => a.touchedAt - b.touchedAt)) {
			if (this.live.size <= MAX_LIVE) { break; } this.drop(candidate.key, false);
		}
	}
	clear(): void { for (const key of [...this.live.keys()]) { this.drop(key, true); } this.saved.clear(); void this.flush(); }
	/** Stops idle CLI processes; saved bindings reload the same native sessions on the next turn. */
	releaseIdle(matches: (session: CocoSession) => boolean = () => true): void {
		for (const session of [...this.live.values()]) { if (!session.busy && matches(session)) { this.drop(session.key, false); } }
	}
	async settle(): Promise<void> { await this.writes.catch(() => undefined); }
	dispose(): void { for (const key of [...this.live.keys()]) { this.drop(key, false); } }
	private drop(key: string, forget: boolean): void {
		const session = this.live.get(key);
		if (session) { session.closed = true; clearTimeout(session.idle); session.client.dispose(); this.live.delete(key); }
		if (forget) { this.saved.delete(key); void this.flush(); }
	}
	private flush(strict = false): Promise<void> {
		for (const item of [...this.saved.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(MAX_SAVED)) { this.saved.delete(item.key); }
		const snapshot = [...this.saved.values()];
		this.writes = this.writes.catch(() => undefined).then(async () => {
			if (this.file) {
				await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
				await fs.writeFile(`${this.file}.tmp`, JSON.stringify({ version: 1, sessions: snapshot }), { mode: 0o600 });
				await fs.rename(`${this.file}.tmp`, this.file);
			}
			try { await this.state?.update(STORAGE_KEY, snapshot); } catch (error) { if (!this.file) { throw error; } }
		}).catch(() => {
			// Keep the warm process usable; a failed checkpoint must not be advertised as durable.
			if (strict) { throw new Error("Cannot checkpoint Coco session state. Check VS Code workspace storage before retrying."); }
		});
		return this.writes;
	}
}