import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { normalizeSystemDate, normalizeVolatileHostContext } from "../context/cache-diagnostics";
import { canonicalConversationUserAnchors as cocoUserAnchors } from "./conversation-anchors";
import { sharedImageName } from "../context/provider-handoff";

type Part = { type: "text"; text: string } | { type: "data"; data: string; mimeType: string } | { type: "asset"; name: string; mimeType: string }
	| { type: "call"; callId: string; name: string; input: object } | { type: "result"; callId: string; content: Part[] };
interface Message { role: vscode.LanguageModelChatMessageRole; content: Part[] }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const imageNames = new WeakMap<Uint8Array, string>();
function imageName(part: vscode.LanguageModelDataPart): string {
	let name = imageNames.get(part.data);
	if (!name) { name = sharedImageName(part.data, part.mimeType); imageNames.set(part.data, name); }
	return name;
}
/** Saved images live once in assets/; inline base64 let a few screenshots exceed the transcript size limit. */
function storePart(part: unknown): Part[] {
	if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) { return [{ type: "asset", name: imageName(part), mimeType: part.mimeType }]; }
	if (part instanceof vscode.LanguageModelToolResultPart) { return [{ type: "result", callId: part.callId, content: part.content.flatMap(storePart) }]; }
	return encodePart(part);
}

function encodePart(part: unknown): Part[] {
	if (part instanceof vscode.LanguageModelTextPart) { return [{ type: "text", text: part.value }]; }
	if (part instanceof vscode.LanguageModelDataPart && part.mimeType !== "usage") { return [{ type: "data", data: Buffer.from(part.data).toString("base64"), mimeType: part.mimeType }]; }
	if (part instanceof vscode.LanguageModelToolCallPart) { return [{ type: "call", callId: part.callId, name: part.name, input: part.input }]; }
	if (part instanceof vscode.LanguageModelToolResultPart) { return [{ type: "result", callId: part.callId, content: part.content.flatMap(encodePart) }]; }
	return [];
}
function store(message: vscode.LanguageModelChatRequestMessage): Message { return { role: message.role, content: message.content.flatMap(storePart) }; }
type Assets = ReadonlyMap<string, Uint8Array | undefined>;
function decodePart(part: Part, assets: Assets): vscode.LanguageModelTextPart | vscode.LanguageModelDataPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelToolResultPart {
	switch (part.type) {
		case "text": return new vscode.LanguageModelTextPart(part.text);
		case "data": return new vscode.LanguageModelDataPart(Buffer.from(part.data, "base64"), part.mimeType);
		case "asset": {
			const bytes = assets.get(part.name);
			if (!bytes) { return new vscode.LanguageModelTextPart(`[Historical image ${part.mimeType} unavailable: ${part.name}]`); }
			const data = new vscode.LanguageModelDataPart(bytes, part.mimeType); imageNames.set(data.data, part.name); return data;
		}
		case "call": return new vscode.LanguageModelToolCallPart(part.callId, part.name, part.input);
		case "result": return new vscode.LanguageModelToolResultPart(part.callId, part.content.filter(p => p.type === "text" || p.type === "data" || p.type === "asset").map(p => decodePart(p, assets) as vscode.LanguageModelTextPart | vscode.LanguageModelDataPart));
	}
}
function decode(message: Message, assets: Assets = new Map()): vscode.LanguageModelChatRequestMessage { return new vscode.LanguageModelChatMessage(message.role, message.content.map(part => decodePart(part, assets))); }
const isSystemMessage = (message: vscode.LanguageModelChatRequestMessage) => message.role !== vscode.LanguageModelChatMessageRole.User && message.role !== vscode.LanguageModelChatMessageRole.Assistant;
const JOURNAL_MAX_BYTES = 512 * 1024 * 1024;
const JOURNAL_GARBAGE_MIN_BYTES = 8 * 1024 * 1024;
const ASSET_PRUNE_MIN_AGE_MS = 24 * 60 * 60_000;
const sameMessage = (a: vscode.LanguageModelChatRequestMessage, b: vscode.LanguageModelChatRequestMessage) => a === b || messageKey(a) === messageKey(b);

/** Version 2 is JSON Lines: header, then `systems`, `servedBy` and `message` records; the last `systems` record wins. */
function parseJournal(buffer: Buffer): { systems: Message[]; body: Message[]; servedBy?: string; intact: boolean; systemBytes: number; garbage: number } {
	const firstEnd = buffer.indexOf(10);
	const header = JSON.parse(buffer.toString("utf8", 0, firstEnd < 0 ? buffer.length : firstEnd)) as { version?: unknown; messages?: unknown; servedBy?: unknown };
	const servedByOf = (value: unknown) => typeof value === "string" && value.length <= 512 ? value : undefined;
	if (header.version === 1) {
		if (!Array.isArray(header.messages)) { throw new Error("Invalid conversation checkpoint."); }
		const messages = header.messages as Message[];
		return { systems: messages.filter(m => m.role !== vscode.LanguageModelChatMessageRole.User && m.role !== vscode.LanguageModelChatMessageRole.Assistant),
			body: messages.filter(m => m.role === vscode.LanguageModelChatMessageRole.User || m.role === vscode.LanguageModelChatMessageRole.Assistant), servedBy: servedByOf(header.servedBy), intact: false, systemBytes: 0, garbage: 0 };
	}
	if (header.version !== 2) { throw new Error("Invalid conversation checkpoint."); }
	let systems: Message[] = [], servedBy = servedByOf(header.servedBy), intact = firstEnd >= 0, systemBytes = 0, garbage = 0;
	const body: Message[] = [];
	for (let start = firstEnd + 1; firstEnd >= 0 && start < buffer.length;) {
		const end = buffer.indexOf(10, start), stop = end < 0 ? buffer.length : end;
		if (stop > start) {
			let record: { systems?: unknown; servedBy?: unknown; message?: unknown };
			try { record = JSON.parse(buffer.toString("utf8", start, stop)); }
			catch (error) { if (end < 0) { intact = false; break; } throw error; }
			if (Array.isArray(record.systems)) { garbage += systemBytes; systemBytes = stop - start + 1; systems = record.systems as Message[]; }
			else if ("servedBy" in record) { servedBy = servedByOf(record.servedBy); }
			else if (record.message && typeof record.message === "object") { body.push(record.message as Message); }
			else { throw new Error("Invalid conversation record."); }
		}
		if (end < 0) { if (stop > start) { intact = false; } break; }
		start = end + 1;
	}
	return { systems, body, servedBy, intact, systemBytes, garbage };
}
function assetNames(parts: readonly Part[], names = new Set<string>()): Set<string> {
	for (const part of parts) { if (part.type === "asset") { names.add(part.name); } else if (part.type === "result") { assetNames(part.content, names); } }
	return names;
}

/**
 * Every step merges the whole stored journal against the incoming request, so
 * a long chat would otherwise re-encode and re-hash all earlier messages (and
 * their images) on each tool round. Message objects are never mutated after
 * they are created, so their key is computed once.
 */
const messageKeys = new WeakMap<vscode.LanguageModelChatRequestMessage, string>();

function messageKey(message: vscode.LanguageModelChatRequestMessage): string {
	const cached = messageKeys.get(message);
	if (cached !== undefined) { return cached; }
	const parts = message.content.flatMap(encodePart);
	const text = parts.filter((p): p is Extract<Part, { type: "text" }> => p.type === "text").map(p => p.text).join("");
	const stable = parts.filter(p => p.type !== "text").map(p => p.type === "result" ? { type: p.type, callId: p.callId } : p.type === "data" ? { type: p.type, mimeType: p.mimeType, hash: hash(p.data) } : p);
	const key = hash(JSON.stringify([message.role, normalizeSystemDate(normalizeVolatileHostContext(text)), stable]));
	messageKeys.set(message, key);
	return key;
}

/** Match retained anchors, preserve missing middle entries, and cut branches before edited requests. */
export function mergeConversationHistory(previous: readonly vscode.LanguageModelChatRequestMessage[], incoming: readonly vscode.LanguageModelChatRequestMessage[]): vscode.LanguageModelChatRequestMessage[] {
	const system = isSystemMessage;
	const latestSystems = incoming.filter(system);
	const systems = latestSystems.length ? latestSystems : previous.filter(system);
	const uniqueSystems = [...new Map(systems.map(message => [messageKey(message), message])).values()];
	return [...uniqueSystems, ...mergeConversationBody(previous.filter(message => !system(message)), incoming.filter(message => !system(message)))];
}

function mergeConversationBody(previous: readonly vscode.LanguageModelChatRequestMessage[], incoming: readonly vscode.LanguageModelChatRequestMessage[]): vscode.LanguageModelChatRequestMessage[] {
	if (!previous.length || !incoming.length) { return [...incoming]; }
	const oldUsers = cocoUserAnchors(previous), newUsers = cocoUserAnchors(incoming);
	const toolContinuation = incoming.at(-1)?.content.some(p => p instanceof vscode.LanguageModelToolResultPart) === true;
	let ceiling = previous.length;
	if (!toolContinuation && oldUsers.length && newUsers.length) {
		// The capped Copilot render drops middle turns, so incoming anchors are an ordered
		// subsequence of the stored ones; only an anchor missing from that order is an edit.
		let matched = 0, cursor = 0, last = -1;
		for (const [position, anchor] of newUsers.entries()) {
			let found = -1;
			// The capped render keeps the first turn, so a window starting elsewhere is only retained, never
			// an edit; the current request only matches the next stored one (a regeneration).
			const end = position === 0 || position === newUsers.length - 1 ? Math.min(cursor + 1, oldUsers.length) : oldUsers.length;
			for (let index = cursor; index < end; index++) { if (oldUsers[index].key === anchor.key) { found = index; break; } }
			if (found < 0) { break; }
			matched++; last = found; cursor = found + 1;
		}
		if (matched && cursor < oldUsers.length) { ceiling = oldUsers[cursor].index; }
		if (matched === newUsers.length && newUsers.length <= oldUsers.length) {
			ceiling = oldUsers[Math.max(0, last)].index;
		}
		const oldKeys = new Set(oldUsers.map(anchor => anchor.key));
		if (!matched && !newUsers.slice(0, -1).some(n => oldKeys.has(n.key))) { return [...incoming]; }
	}
	const keys = incoming.map(messageKey);
	const positions = new Map<string, { first: number; last: number }>();
	for (const [index, key] of keys.entries()) {
		const found = positions.get(key); if (found) { found.last = index; } else { positions.set(key, { first: index, last: index }); }
	}
	const priorKeys = previous.slice(0, ceiling).map(messageKey);
	const priorPositions = new Map<string, number[]>();
	for (const [index, key] of priorKeys.entries()) {
		const list = priorPositions.get(key) ?? []; list.push(index); priorPositions.set(key, list);
	}
	const latestUser = newUsers.at(-1)?.index ?? incoming.length;
	for (let index = ceiling - 1; index >= 0; index--) {
		const match = positions.get(priorKeys[index])?.last ?? -1;
		if (match < 0 || (!toolContinuation && match >= latestUser)) { continue; }
		// Merge backwards around stable anchors. New prefix snapshots must survive,
		// and old replies omitted by the renderer remain available before the new task.
		const reversed: vscode.LanguageModelChatRequestMessage[] = [];
		let cursor = index;
		for (let next = match; next >= 0; next--) {
			const candidates = priorPositions.get(keys[next]) ?? [];
			let low = 0, high = candidates.length - 1, found = -1;
			while (low <= high) {
				const middle = (low + high) >>> 1;
				if (candidates[middle] <= cursor) { found = candidates[middle]; low = middle + 1; } else { high = middle - 1; }
			}
			if (found >= 0) { while (cursor > found) { reversed.push(previous[cursor--]); } cursor = found - 1; }
			reversed.push(incoming[next]);
		}
		while (cursor >= 0) { reversed.push(previous[cursor--]); }
		return [...reversed.reverse(), ...previous.slice(index + 1, ceiling), ...incoming.slice(match + 1)];
	}
	return [...incoming];
}

/** What the journal file currently holds; a step appends only what is missing. */
interface DiskState { systems: readonly vscode.LanguageModelChatRequestMessage[]; body: readonly vscode.LanguageModelChatRequestMessage[]; servedBy?: string; bytes: number; systemBytes: number; garbage: number }
interface Entry { messages: vscode.LanguageModelChatRequestMessage[]; revision: number; active: number; pending?: Promise<void>; servedBy?: string; disk?: DiskState }
export interface ConversationHistoryLease {
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	transcriptPath?: string;
	/** Model that last produced output in this chat, before the current request. */
	servedBy?: string;
	complete(parts: readonly vscode.LanguageModelResponsePart[], servedBy?: string): Promise<void>;
}

/** Workspace-local visible Chat history; hidden provider reasoning is never captured. */
export class ConversationHistory {
	private readonly entries = new Map<string, Entry>();
	private readonly loading = new Map<string, Promise<Entry>>();
	private readonly savedImages = new Set<string>();
	constructor(private readonly root: string) {}
	/** Deletes images no saved chat references; recent ones may belong to a journal still being written. */
	async pruneAssets(now = Date.now()): Promise<{ removed: number; bytes: number }> {
		const referenced = new Set<string>(), chunk = 64 * 1024 * 1024;
		for (const name of await fs.readdir(this.root).catch(() => [] as string[])) {
			if (!name.endsWith(".json")) { continue; }
			const buffer = await fs.readFile(path.join(this.root, name));
			for (let start = 0; start < buffer.length; start += chunk) {
				for (const match of buffer.toString("latin1", start, Math.min(buffer.length, start + chunk + 80)).matchAll(/[0-9a-f]{64}\.[a-z]+/g)) { referenced.add(match[0]); }
			}
		}
		let removed = 0, bytes = 0;
		const folder = path.join(this.root, "assets");
		for (const name of await fs.readdir(folder).catch(() => [] as string[])) {
			if (referenced.has(name) || !/^[0-9a-f]{64}\.[a-z]+$/.test(name)) { continue; }
			const file = path.join(folder, name), stat = await fs.stat(file).catch(() => undefined);
			if (!stat || now - stat.mtimeMs < ASSET_PRUNE_MIN_AGE_MS) { continue; }
			await fs.rm(file, { force: true }); this.savedImages.delete(name); removed++; bytes += stat.size;
		}
		return { removed, bytes };
	}
	private async persist(owner: Entry, file: string, revision: number, messages: readonly vscode.LanguageModelChatRequestMessage[]): Promise<void> {
		const assets = new Map<string, Uint8Array>();
		const collect = (part: unknown): void => {
			if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) {
				const name = imageName(part); if (!this.savedImages.has(name)) { assets.set(name, part.data); }
			} else if (part instanceof vscode.LanguageModelToolResultPart) { part.content.forEach(collect); }
		};
		messages.forEach(message => message.content.forEach(collect));
		if (assets.size) {
			await fs.mkdir(path.join(this.root, "assets"), { recursive: true, mode: 0o700 });
			for (const [name, bytes] of assets) { await fs.writeFile(path.join(this.root, "assets", name), bytes, { mode: 0o600 }); this.savedImages.add(name); }
		}
		const commit = async () => {
			if (owner.revision !== revision) { return; }
			await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
			const systems = messages.filter(isSystemMessage), body = messages.filter(message => !isSystemMessage(message));
			const disk = owner.disk, servedBy = owner.servedBy;
			const systemsLine = (list: readonly vscode.LanguageModelChatRequestMessage[]) => JSON.stringify({ systems: list.map(store) });
			const tooLarge = () => new Error(`The saved Chat transcript exceeds ${JOURNAL_MAX_BYTES / 1048576} MiB. Compact the source Chat before another cross-provider handoff.`);
			if (disk && disk.body.length <= body.length && disk.garbage <= Math.max(JOURNAL_GARBAGE_MIN_BYTES, disk.bytes / 4)
				&& disk.body.every((message, index) => sameMessage(message, body[index]))) {
				const lines: string[] = [];
				let systemBytes = disk.systemBytes, garbage = disk.garbage;
				if (disk.systems.length !== systems.length || disk.systems.some((message, index) => !sameMessage(message, systems[index]))) {
					const line = systemsLine(systems); garbage += systemBytes; systemBytes = Buffer.byteLength(line) + 1; lines.push(line);
				}
				if (servedBy !== disk.servedBy) { lines.push(JSON.stringify({ servedBy: servedBy ?? null })); }
				for (let index = disk.body.length; index < body.length; index++) { lines.push(JSON.stringify({ message: store(body[index]) })); }
				if (!lines.length) { return; }
				const chunk = lines.join("\n") + "\n", bytes = disk.bytes + Buffer.byteLength(chunk);
				if (bytes > JOURNAL_MAX_BYTES) { throw tooLarge(); }
				owner.disk = undefined;
				await fs.appendFile(file, chunk, { mode: 0o600 });
				owner.disk = { systems, body, servedBy, bytes, systemBytes, garbage };
				return;
			}
			const header = JSON.stringify({ version: 2, ...(servedBy ? { servedBy } : {}) }), systemLine = systemsLine(systems);
			const payload = [header, systemLine, ...body.map(message => JSON.stringify({ message: store(message) }))].join("\n") + "\n";
			const bytes = Buffer.byteLength(payload);
			if (bytes > JOURNAL_MAX_BYTES) { throw tooLarge(); }
			owner.disk = undefined;
			const temporary = `${file}.tmp`;
			await fs.writeFile(temporary, payload, { mode: 0o600 }); await fs.rename(temporary, file);
			owner.disk = { systems, body, servedBy, bytes, systemBytes: Buffer.byteLength(systemLine) + 1, garbage: 0 };
		};
		const writeTask = (owner.pending ?? Promise.resolve()).catch(() => undefined).then(commit);
		owner.pending = writeTask;
		try { await writeTask; } finally { if (owner.pending === writeTask) { owner.pending = undefined; } }
	}
	/**
	 * Whether a saved transcript already backs this conversation. Copilot may
	 * render only a short tail of such a chat, because begin() restores the rest;
	 * a chat without one must still be rendered in full once to seed it.
	 */
	has(conversation: unknown): boolean {
		if (typeof conversation !== "string" || !conversation.trim() || conversation.length > 512) { return false; }
		const key = hash(conversation), entry = this.entries.get(key);
		if (entry) { return entry.messages.length > 0; }
		try { return statSync(path.join(this.root, `${key}.json`)).size > 0; } catch { return false; }
	}
	async begin(conversation: unknown, incoming: readonly vscode.LanguageModelChatRequestMessage[]): Promise<ConversationHistoryLease> {
		if (typeof conversation !== "string" || !conversation.trim() || conversation.length > 512) {
			return { messages: incoming, complete: async () => undefined };
		}
		const key = hash(conversation), file = path.join(this.root, `${key}.json`);
		let entry = this.entries.get(key);
		if (!entry && this.loading.has(key)) { entry = await this.loading.get(key)!; }
		if (!entry) {
			const load = async (): Promise<Entry> => {
			let stored: vscode.LanguageModelChatRequestMessage[] = [];
			let servedBy: string | undefined, disk: DiskState | undefined;
			try {
				const stat = await fs.stat(file);
				if (stat.size > JOURNAL_MAX_BYTES) { throw new Error("Saved conversation exceeds the supported size."); }
				const buffer = await fs.readFile(file), journal = parseJournal(buffer);
				servedBy = journal.servedBy;
				const assets = new Map<string, Uint8Array | undefined>();
				for (const name of assetNames([...journal.systems, ...journal.body].flatMap(message => message.content))) {
					if (!/^[0-9a-f]{64}\.[a-z]+$/.test(name)) { continue; }
					assets.set(name, await fs.readFile(path.join(this.root, "assets", name)).catch(() => undefined));
					if (assets.get(name)) { this.savedImages.add(name); }
				}
				const systems = journal.systems.map(message => decode(message, assets)), body = journal.body.map(message => decode(message, assets));
				stored = [...systems, ...body];
				// A legacy file or a torn final line is rewritten in full by the next step.
				if (journal.intact) { disk = { systems, body, servedBy, bytes: buffer.length, systemBytes: journal.systemBytes, garbage: journal.garbage }; }
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw new Error("Cannot restore the common Chat transcript. Check workspace storage before continuing or switching models.", { cause: error }); }
			}
			const loaded: Entry = { messages: stored, revision: 0, active: 0, servedBy, disk }; this.entries.set(key, loaded); return loaded;
			};
			const pending = load(); this.loading.set(key, pending);
			try { entry = await pending; } finally { this.loading.delete(key); }
		}
		const owner = entry, revision = ++owner.revision;
		owner.active++;
		this.entries.delete(key); this.entries.set(key, owner);
		owner.messages = mergeConversationHistory(owner.messages, incoming);
		const messages = [...owner.messages];
		try { await this.persist(owner, file, revision, messages); }
		catch (error) { owner.active--; throw new Error(`Cannot save the incoming Chat transcript (${error instanceof Error ? error.message : String(error)}). Check workspace storage before continuing or switching models.`, { cause: error }); }
		let finished = false;
		return { messages, transcriptPath: file, servedBy: owner.servedBy, complete: async (parts, servedBy) => {
			if (finished) { return; } finished = true; owner.active--;
			if (servedBy) { owner.servedBy = servedBy; }
			if (owner.revision !== revision) { return; }
			const content = parts.flatMap(encodePart);
			if (content.length) {
				const combined: Part[] = [];
				for (const part of content) {
					const last = combined.at(-1);
					if (part.type === "text" && last?.type === "text") { last.text += part.text; } else { combined.push(part); }
				}
				owner.messages = [...messages, decode({ role: vscode.LanguageModelChatMessageRole.Assistant, content: combined })];
			}
			await this.persist(owner, file, revision, owner.messages);
			// Disk retains older chats; bound the live index.
			if (this.entries.size > 16) {
				const oldest = [...this.entries].find(([id, value]) => id !== key && value.active === 0 && !value.pending)?.[0];
				if (oldest) { this.entries.delete(oldest); }
			}
		} };
	}
}