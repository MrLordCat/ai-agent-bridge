import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { normalizeSystemDate, normalizeVolatileHostContext } from "../context/cache-diagnostics";
import { canonicalConversationUserAnchors as cocoUserAnchors } from "./conversation-anchors";
import { sharedImageName } from "../context/provider-handoff";

type Part = { type: "text"; text: string } | { type: "data"; data: string; mimeType: string }
	| { type: "call"; callId: string; name: string; input: object } | { type: "result"; callId: string; content: Part[] };
interface Message { role: vscode.LanguageModelChatMessageRole; content: Part[] }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function encodePart(part: unknown): Part[] {
	if (part instanceof vscode.LanguageModelTextPart) { return [{ type: "text", text: part.value }]; }
	if (part instanceof vscode.LanguageModelDataPart && part.mimeType !== "usage") { return [{ type: "data", data: Buffer.from(part.data).toString("base64"), mimeType: part.mimeType }]; }
	if (part instanceof vscode.LanguageModelToolCallPart) { return [{ type: "call", callId: part.callId, name: part.name, input: part.input }]; }
	if (part instanceof vscode.LanguageModelToolResultPart) { return [{ type: "result", callId: part.callId, content: part.content.flatMap(encodePart) }]; }
	return [];
}
function encode(message: vscode.LanguageModelChatRequestMessage): Message { return { role: message.role, content: message.content.flatMap(encodePart) }; }
function decodePart(part: Part): vscode.LanguageModelTextPart | vscode.LanguageModelDataPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelToolResultPart {
	switch (part.type) {
		case "text": return new vscode.LanguageModelTextPart(part.text);
		case "data": return new vscode.LanguageModelDataPart(Buffer.from(part.data, "base64"), part.mimeType);
		case "call": return new vscode.LanguageModelToolCallPart(part.callId, part.name, part.input);
		case "result": return new vscode.LanguageModelToolResultPart(part.callId, part.content.filter(p => p.type === "text" || p.type === "data").map(p => decodePart(p) as vscode.LanguageModelTextPart | vscode.LanguageModelDataPart));
	}
}
function decode(message: Message): vscode.LanguageModelChatRequestMessage { return new vscode.LanguageModelChatMessage(message.role, message.content.map(decodePart)); }

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
	const system = (message: vscode.LanguageModelChatRequestMessage) => message.role !== vscode.LanguageModelChatMessageRole.User && message.role !== vscode.LanguageModelChatMessageRole.Assistant;
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
		let common = 0;
		while (common < Math.min(oldUsers.length, newUsers.length) && oldUsers[common].key === newUsers[common].key) { common++; }
		if (common && common < oldUsers.length) { ceiling = oldUsers[common].index; }
		if (common === newUsers.length && newUsers.length <= oldUsers.length) {
			ceiling = oldUsers[Math.max(0, common - 1)].index;
		}
		const oldKeys = new Set(oldUsers.map(anchor => anchor.key));
		if (!common && !newUsers.slice(0, -1).some(n => oldKeys.has(n.key))) { return [...incoming]; }
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

interface Entry { messages: vscode.LanguageModelChatRequestMessage[]; revision: number; active: number; pending?: Promise<void> }
export interface ConversationHistoryLease {
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	transcriptPath?: string;
	complete(parts: readonly vscode.LanguageModelResponsePart[]): Promise<void>;
}

/** Workspace-local visible Chat history; hidden provider reasoning is never captured. */
export class ConversationHistory {
	private readonly entries = new Map<string, Entry>();
	private readonly loading = new Map<string, Promise<Entry>>();
	private readonly savedImages = new Set<string>();
	constructor(private readonly root: string) {}
	private async persist(owner: Entry, file: string, revision: number, messages: readonly vscode.LanguageModelChatRequestMessage[]): Promise<void> {
		const assets = new Map<string, Uint8Array>();
		const collect = (part: unknown): void => {
			if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) {
				const name = sharedImageName(part.data, part.mimeType); if (!this.savedImages.has(name)) { assets.set(name, part.data); }
			} else if (part instanceof vscode.LanguageModelToolResultPart) { part.content.forEach(collect); }
		};
		messages.forEach(message => message.content.forEach(collect));
		if (assets.size) {
			await fs.mkdir(path.join(this.root, "assets"), { recursive: true, mode: 0o700 });
			for (const [name, bytes] of assets) { await fs.writeFile(path.join(this.root, "assets", name), bytes, { mode: 0o600 }); this.savedImages.add(name); }
		}
		const payload = JSON.stringify({ version: 1, messages: messages.map(encode) });
		if (Buffer.byteLength(payload) > 64 * 1024 * 1024) { throw new Error("The saved Chat transcript exceeds 64 MiB. Compact the source Chat before another cross-provider handoff."); }
		const commit = async () => {
			if (owner.revision !== revision) { return; }
			await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
			const temporary = `${file}.tmp`;
			await fs.writeFile(temporary, payload, { mode: 0o600 }); await fs.rename(temporary, file);
		};
		const writeTask = (owner.pending ?? Promise.resolve()).catch(() => undefined).then(commit);
		owner.pending = writeTask;
		try { await writeTask; } finally { if (owner.pending === writeTask) { owner.pending = undefined; } }
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
			try {
				const stat = await fs.stat(file);
				if (stat.size > 64 * 1024 * 1024) { throw new Error("Saved conversation exceeds the supported size."); }
				const document = JSON.parse(await fs.readFile(file, "utf8")) as { version?: unknown; messages?: unknown };
				if (document.version !== 1 || !Array.isArray(document.messages)) { throw new Error("Invalid conversation checkpoint."); }
				stored = document.messages.map(message => decode(message as Message));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw new Error("Cannot restore the common Chat transcript. Check workspace storage before continuing or switching models.", { cause: error }); }
			}
			const loaded = { messages: stored, revision: 0, active: 0 }; this.entries.set(key, loaded); return loaded;
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
		catch (error) { owner.active--; throw new Error("Cannot save the incoming Chat transcript. Check workspace storage before continuing or switching models.", { cause: error }); }
		let finished = false;
		return { messages, transcriptPath: file, complete: async parts => {
			if (finished) { return; } finished = true; owner.active--;
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