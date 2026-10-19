import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { normalizeSystemDate, normalizeVolatileHostContext } from "../context/cache-diagnostics";
import { canonicalConversationUserAnchors } from "../providers/conversation-anchors";
import type { CursorSelection } from "./api-client";
import type { CursorLocalStore, CursorNativeCheckpoint } from "./native-store";

export interface CursorLegacyRecovery { agentId: string; users: string[]; deltaStart: number; nativeCheckpoint: CursorNativeCheckpoint }
const stable = (text: string) => normalizeSystemDate(normalizeVolatileHostContext(text)).replace(/<host-context\/>/g, "").replace(/\r\n/g, "\n").replace(/\n[\t ]*\n/g, "\n").trim();
const modelKey = (model: CursorSelection) => JSON.stringify([model.id, [...model.params ?? []].sort((a, b) => a.id.localeCompare(b.id))]);

/** One-time 1.18 migration: require this chat's archive, matching inputs AND its unique completed reply. */
export async function recoverLegacyCursorSession(store: CursorLocalStore, root: string, archiveScope: string, cwd: string, selection: CursorSelection,
	messages: readonly vscode.LanguageModelChatRequestMessage[]): Promise<CursorLegacyRecovery | undefined> {
	if (!/^[a-f0-9]{64}$/.test(archiveScope)) { return undefined; }
	const directory = path.join(root, "history", archiveScope);
	let files: string[];
	try { files = (await fs.readdir(directory)).filter(file => /^[a-f0-9]{64}\.txt$/.test(file)); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { return undefined; } throw error; }
	const anchors = canonicalConversationUserAnchors(messages);
	const texts = messages.map(message => stable(message.content.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => (part as vscode.LanguageModelTextPart).value).join("\n")));
	const candidates: CursorLegacyRecovery[] = [];
	let cursor: string | undefined;
	do {
		const page = await store.agents.list({ filter: { cwd, cursor, limit: 100 } }); cursor = page.nextCursor;
		for (const agent of page.items) {
			if (agent.cwd !== cwd || agent.status !== "idle" || agent.activeRunId) { continue; }
			const runs = []; let runCursor: string | undefined;
			do { const batch = await store.runs.list({ filter: { agentIds: [agent.agentId], cursor: runCursor, limit: 1000 } }); runs.push(...batch.items); runCursor = batch.nextCursor; } while (runCursor);
			runs.sort((a, b) => a.turnNumber - b.turnNumber);
			const first = runs[0], last = runs.at(-1), result = stable(last?.result ?? "");
			if (!first?.startedAt || last?.status !== "finished" || !last.latestCheckpointRef || !last.model || modelKey(last.model) !== modelKey(selection) || result.length < 100 || result === "ACK") { continue; }
			const replies = messages.flatMap((message, index) => message.role === vscode.LanguageModelChatMessageRole.Assistant && texts[index] === result ? [index] : []);
			if (replies.length !== 1) { continue; }
			const beforeReply = anchors.filter(anchor => anchor.index < replies[0]);
			const next = anchors.find(anchor => anchor.index > replies[0]);
			if (beforeReply.length < 2 || !next) { continue; }
			const matchingArchives: string[] = [];
			for (const name of files) {
				const file = path.join(directory, name), stat = await fs.stat(file);
				// Original archive was written after Agent.create and before the first prompt.
				if (stat.size > 32 * 1024 * 1024 || stat.birthtimeMs < agent.createdAt || stat.birthtimeMs > first.startedAt || first.startedAt - stat.birthtimeMs > 1000 || stat.birthtimeMs - agent.createdAt > 5000) { continue; }
				const archive = stable(await fs.readFile(file, "utf8"));
				let offset = 0, matched = true;
				for (const anchor of beforeReply) {
					const text = texts[anchor.index], at = text ? archive.indexOf(text, offset) : -1;
					if (at < 0) { matched = false; break; } offset = at + text.length;
				}
				if (matched) { matchingArchives.push(name); }
			}
			if (matchingArchives.length !== 1 || !await store.checkpoints.get({ agentId: agent.agentId, blobId: last.latestCheckpointRef.rootBlobId })) { continue; }
			candidates.push({ agentId: agent.agentId, users: beforeReply.map(anchor => anchor.key), deltaStart: next.index, nativeCheckpoint: last.latestCheckpointRef });
		}
	} while (cursor);
	// Ambiguous/cancelled/import-only histories must never be attached to a chat.
	return candidates.length === 1 ? candidates[0] : undefined;
}