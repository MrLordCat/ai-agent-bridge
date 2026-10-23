import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as CursorSdk from "@cursor/sdk";
import type { CursorLocalStore } from "./native-store";

type Agents = CursorLocalStore["agents"];
type Runs = CursorLocalStore["runs"];
type Checkpoints = CursorLocalStore["checkpoints"];
type RunEvents = CursorLocalStore["runEvents"];
type AgentDocument = NonNullable<Awaited<ReturnType<Agents["get"]>>>;
type RunDocument = NonNullable<Awaited<ReturnType<Runs["get"]>>>;
type RunEventDocument = Awaited<ReturnType<RunEvents["append"]>>;
type AgentFilter = Parameters<Agents["delete"]>[0]["filter"];
type RunFilter = Parameters<Runs["delete"]>[0]["filter"];
type CheckpointFilter = Parameters<Checkpoints["delete"]>[0]["filter"];
type FileName = "agents" | "runs" | "checkpoints" | "runEvents";
export type CursorStorePagination = Pick<typeof CursorSdk, "paginateAgentDocuments" | "paginateRunDocuments">;

/** Same file names and record layout as the SDK's JsonlLocalAgentStore, so either store can open the directory. */
export const CURSOR_STORE_FILES: Readonly<Record<FileName, string>> = { agents: "agents.ndjson", runs: "runs.ndjson", runEvents: "run_events.ndjson", checkpoints: "checkpoints.ndjson" };
interface Span { readonly start: number; readonly length: number }
interface BlobLine { readonly span: Span; readonly agentId?: string; readonly blobId?: string }
interface EventLine { readonly span: Span; readonly runId?: string; readonly seq: number; readonly idempotencyKey?: string | null }
const NEWLINE = 0x0a;
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const blank = (data: Buffer, start: number, end: number) => { for (let i = start; i < end; i++) { const byte = data[i]; if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) { return false; } } return true; };
const clone = <T>(value: T): T => structuredClone(value);

/** One NDJSON file addressed by byte spans: point reads and appends instead of whole-file read/parse/rewrite. */
class NdjsonFile {
	private handle?: fs.FileHandle;
	private signature = "missing";
	private size = 0;
	private repairAt?: number;
	private needsNewline = false;
	constructor(readonly file: string) {}
	async scan(visit: (record: unknown, span: Span) => void): Promise<void> {
		await this.close();
		let data: Buffer;
		try { data = await fs.readFile(this.file); } catch (error) { if (errorCode(error) !== "ENOENT") { throw error; } data = Buffer.alloc(0); }
		const lines: Span[] = [];
		for (let start = 0; start < data.length;) {
			const newline = data.indexOf(NEWLINE, start), end = newline < 0 ? data.length : newline;
			if (!blank(data, start, end)) { lines.push({ start, length: end - start }); }
			start = end + 1;
		}
		this.repairAt = undefined;
		for (const [index, span] of lines.entries()) {
			let record: unknown;
			try { record = JSON.parse(data.toString("utf8", span.start, span.start + span.length)); } catch {
				// Same tolerance as the SDK reader: an interrupted final append is ignored; it is cut off before our next append.
				if (index === lines.length - 1) { this.repairAt = span.start; break; }
				throw new Error(`Corrupt local agent store: failed to parse record ${index + 1} of ${this.file}`);
			}
			visit(record, span);
		}
		this.needsNewline = this.repairAt === undefined && data.length > 0 && data[data.length - 1] !== NEWLINE;
		await this.remember(data.length);
	}
	async changed(): Promise<boolean> {
		try { const stat = await fs.stat(this.file); return `${stat.size}:${stat.mtimeMs}` !== this.signature; } catch (error) { if (errorCode(error) === "ENOENT") { return this.signature !== "missing"; } throw error; }
	}
	async read(span: Span): Promise<unknown> {
		this.handle ??= await fs.open(this.file, "r");
		const buffer = Buffer.allocUnsafe(span.length);
		const { bytesRead } = await this.handle.read(buffer, 0, span.length, span.start);
		if (bytesRead !== span.length) { throw new Error(`Corrupt local agent store: truncated record in ${this.file}`); }
		return JSON.parse(buffer.toString("utf8"));
	}
	async append(lines: readonly string[]): Promise<Span[]> {
		await fs.mkdir(path.dirname(this.file), { recursive: true });
		if (this.repairAt !== undefined) { await this.close(); await fs.truncate(this.file, this.repairAt); this.size = this.repairAt; this.repairAt = undefined; this.needsNewline = false; }
		let offset = this.size + (this.needsNewline ? 1 : 0);
		const spans = lines.map(line => { const span = { start: offset, length: Buffer.byteLength(line) }; offset += span.length + 1; return span; });
		await fs.appendFile(this.file, `${this.needsNewline ? "\n" : ""}${lines.join("\n")}\n`);
		this.needsNewline = false;
		await this.remember(offset);
		return spans;
	}
	/** Atomic replacement, used only by rare updates and deletes. Spans refer to the current file. */
	async rewrite(parts: ReadonlyArray<Span | string>): Promise<void> {
		const source = parts.some(part => typeof part !== "string") ? await fs.readFile(this.file) : undefined;
		const newline = Buffer.from("\n"), chunks: Buffer[] = [];
		for (const part of parts) { chunks.push(typeof part === "string" ? Buffer.from(part) : source!.subarray(part.start, part.start + part.length), newline); }
		const body = Buffer.concat(chunks), temp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
		await this.close();
		await fs.mkdir(path.dirname(this.file), { recursive: true });
		await fs.writeFile(temp, body);
		for (let attempt = 0; ; attempt++) {
			try { await fs.rename(temp, this.file); break; } catch (error) {
				// Windows can briefly refuse the replacement while a scanner holds the file.
				if (attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(errorCode(error) ?? "")) { await fs.rm(temp, { force: true }); throw error; }
				await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
			}
		}
		this.repairAt = undefined; this.needsNewline = false;
		await this.remember(body.length);
	}
	async close(): Promise<void> { const handle = this.handle; this.handle = undefined; await handle?.close(); }
	private async remember(expected: number): Promise<void> {
		try {
			const stat = await fs.stat(this.file);
			// Another writer changed the file meanwhile: force a reload on the next operation.
			this.signature = stat.size === expected ? `${stat.size}:${stat.mtimeMs}` : "unknown"; this.size = stat.size;
		} catch (error) { if (errorCode(error) !== "ENOENT") { throw error; } this.signature = "missing"; this.size = 0; }
	}
}

/**
 * Drop-in LocalAgentStore for the Cursor SDK over the JsonlLocalAgentStore files.
 * The SDK store re-reads and re-parses a whole file for every get/append, and loads a checkpoint
 * blob by blob, so a long chat made each run start take minutes. This store indexes each file once,
 * reads single records by byte span and appends new checkpoints and run events.
 */
export class IndexedLocalAgentStore implements CursorLocalStore {
	readonly agents: Agents;
	readonly runs: Runs;
	readonly checkpoints: Checkpoints;
	readonly runEvents: RunEvents;
	private readonly files: Record<FileName, NdjsonFile>;
	private readonly verified = new Map<FileName, number>();
	private queue: Promise<unknown> = Promise.resolve();
	private pending = 0;
	private idle?: NodeJS.Timeout;
	private agentRows: AgentDocument[] = [];
	private runRows: RunDocument[] = [];
	private blobLines: BlobLine[] = [];
	private readonly blobs = new Map<string, BlobLine>();
	private readonly sortedBlobIds = new Map<string, string[]>();
	private eventLines: EventLine[] = [];
	private readonly events = new Map<string, EventLine[]>();
	constructor(readonly root: string, private readonly pagination: CursorStorePagination, private readonly recheckMs = 1000) {
		this.files = { agents: new NdjsonFile(path.join(root, CURSOR_STORE_FILES.agents)), runs: new NdjsonFile(path.join(root, CURSOR_STORE_FILES.runs)),
			checkpoints: new NdjsonFile(path.join(root, CURSOR_STORE_FILES.checkpoints)), runEvents: new NdjsonFile(path.join(root, CURSOR_STORE_FILES.runEvents)) };
		this.agents = {
			get: ({ agentId }) => this.run(["agents"], false, async () => clone(this.agentRows.find(row => row.agentId === agentId) ?? null)),
			create: ({ agent }) => this.run(["agents"], true, async () => {
				if (this.agentRows.some(row => row.agentId === agent.agentId)) { throw new Error(`Agent ${agent.agentId} already exists`); }
				const row = clone(agent); await this.saveAgents([...this.agentRows, row]); return clone(row);
			}),
			update: ({ agent }) => this.run(["agents"], true, async () => {
				const index = this.agentRows.findIndex(row => row.agentId === agent.agentId);
				if (index < 0) { throw new Error(`Agent ${agent.agentId} not found`); }
				const rows = [...this.agentRows], row = clone(agent); rows[index] = row; await this.saveAgents(rows); return clone(row);
			}),
			delete: ({ filter }) => this.run(["agents"], true, async () => {
				const rows = this.agentRows.filter(row => !agentMatches(row, filter));
				if (rows.length === this.agentRows.length) { throw new Error("No agents matched delete filter"); }
				await this.saveAgents(rows);
			}),
			list: input => this.run(["agents"], false, async () => this.pagination.paginateAgentDocuments(this.agentRows, input?.filter)),
		};
		this.runs = {
			get: ({ agentId, runId }) => this.run(["runs"], false, async () => clone(this.runRows.find(row => row.agentId === agentId && row.runId === runId) ?? null)),
			create: ({ run }) => this.run(["runs"], true, async () => {
				if (this.runRows.some(row => row.agentId === run.agentId && row.runId === run.runId)) { throw new Error(`Run ${run.runId} already exists for agent ${run.agentId}`); }
				const row = clone(run); await this.saveRuns([...this.runRows, row]); return clone(row);
			}),
			update: ({ run }) => this.run(["runs"], true, async () => {
				const index = this.runRows.findIndex(row => row.agentId === run.agentId && row.runId === run.runId);
				if (index < 0) { throw new Error(`Run ${run.runId} not found for agent ${run.agentId}`); }
				const rows = [...this.runRows], row = clone(run); rows[index] = row; await this.saveRuns(rows); return clone(row);
			}),
			delete: ({ filter }) => this.run(["runs", "runEvents"], true, async () => {
				const removed = this.runRows.filter(row => runMatches(row, filter));
				if (!removed.length) { return; }
				await this.saveRuns(this.runRows.filter(row => !runMatches(row, filter)));
				await this.deleteEvents(new Set(removed.map(row => row.runId)));
			}),
			list: input => this.run(["runs"], false, async () => this.pagination.paginateRunDocuments(this.runRows.filter(row => runMatches(row, input?.filter)), input?.filter)),
		};
		this.checkpoints = {
			get: ({ agentId, blobId }) => this.run(["checkpoints"], false, async () => {
				const line = this.blobs.get(blobKey(agentId, blobId));
				if (!line) { return null; }
				const record = await this.files.checkpoints.read(line.span) as { dataBase64?: unknown };
				if (typeof record?.dataBase64 !== "string") { throw new Error(`Corrupt local agent store: checkpoint blob ${blobId} has no data`); }
				return Buffer.from(record.dataBase64, "base64");
			}),
			create: ({ agentId, blobId, data }) => this.run(["checkpoints"], true, async () => {
				if (this.blobs.has(blobKey(agentId, blobId))) { throw new Error(`Checkpoint blob ${blobId} already exists for agent ${agentId}`); }
				const [span] = await this.files.checkpoints.append([JSON.stringify({ agentId, blobId, dataBase64: Buffer.from(data).toString("base64") })]);
				const line = { span, agentId, blobId };
				this.blobLines.push(line); this.blobs.set(blobKey(agentId, blobId), line); this.sortedBlobIds.clear();
			}),
			update: ({ agentId, blobId, data }) => this.run(["checkpoints"], true, async () => {
				const line = this.blobs.get(blobKey(agentId, blobId));
				if (!line) { throw new Error(`Checkpoint blob ${blobId} not found for agent ${agentId}`); }
				const dataBase64 = Buffer.from(data).toString("base64");
				// Blobs are content-addressed: the SDK re-persists identical bytes, which needs no write.
				if ((await this.files.checkpoints.read(line.span) as { dataBase64?: unknown })?.dataBase64 === dataBase64) { return; }
				await this.files.checkpoints.rewrite(this.blobLines.map(other => other === line ? JSON.stringify({ agentId, blobId, dataBase64 }) : other.span));
				this.verified.delete("checkpoints");
			}),
			delete: ({ filter }) => this.run(["checkpoints"], true, async () => {
				const kept = this.blobLines.filter(line => !checkpointMatches(line, filter));
				if (kept.length === this.blobLines.length) { return; }
				await this.files.checkpoints.rewrite(kept.map(line => line.span));
				this.verified.delete("checkpoints");
			}),
			list: input => this.run(["checkpoints"], false, async () => {
				// Mirrors the SDK paginator; the sorted id list is cached because the SDK pages a whole agent 50 ids at a time.
				const filter = input?.filter, cacheKey = JSON.stringify([filter?.agentIds ?? [], filter?.blobIds ?? []]);
				let sorted = this.sortedBlobIds.get(cacheKey);
				if (!sorted) {
					sorted = this.blobLines.filter(line => line.blobId !== undefined && checkpointMatches(line, filter)).map(line => line.blobId!).sort((a, b) => a.localeCompare(b));
					this.sortedBlobIds.set(cacheKey, sorted);
				}
				const limit = filter?.limit ?? 50, cursor = filter?.cursor, rest = cursor ? sorted.filter(id => id > cursor) : sorted;
				const items = rest.slice(0, limit), last = items.at(-1);
				return { items, ...(rest.length > limit && last ? { nextCursor: last } : {}) };
			}),
		};
		this.runEvents = {
			append: ({ runId, eventType, payload, payloadRef, idempotencyKey }) => this.run(["runEvents"], true, async () => {
				const lines = this.events.get(runId) ?? [];
				const repeated = idempotencyKey ? lines.find(line => line.idempotencyKey === idempotencyKey) : undefined;
				if (repeated) { return eventDocument(await this.files.runEvents.read(repeated.span)); }
				const seq = lines.reduce((max, line) => Math.max(max, line.seq), 0) + 1;
				const stored = { runId, seq, offset: String(seq), eventType, payload: payload ?? null, payloadRef: payloadRef ?? null, idempotencyKey: idempotencyKey ?? null, createdAt: new Date().toISOString() };
				const [span] = await this.files.runEvents.append([JSON.stringify(stored)]);
				const line = { span, runId, seq, idempotencyKey: stored.idempotencyKey };
				this.eventLines.push(line); lines.push(line); this.events.set(runId, lines);
				return { ...stored, createdAt: new Date(stored.createdAt).getTime() };
			}),
			list: ({ runId, afterOffset, limit }) => this.run(["runEvents"], false, async () => {
				const after = Number.parseInt(afterOffset ?? "0", 10), size = limit ?? 100;
				const matching = (this.events.get(runId) ?? []).filter(line => line.seq > after).sort((a, b) => a.seq - b.seq);
				const items: RunEventDocument[] = [];
				for (const line of matching.slice(0, size)) { items.push(eventDocument(await this.files.runEvents.read(line.span))); }
				return { items, ...(matching.length > items.length && items.length > 0 ? { nextOffset: items.at(-1)?.offset } : {}) };
			}),
			delete: ({ filter }) => this.run(["runEvents"], true, () => this.deleteEvents(filter.runIds?.length ? new Set(filter.runIds) : undefined)),
		};
	}
	/** Releases file handles; the store reopens them on demand. */
	async dispose(): Promise<void> {
		if (this.idle) { clearTimeout(this.idle); this.idle = undefined; }
		await this.queue;
		await Promise.all(Object.values(this.files).map(file => file.close()));
	}
	private run<T>(names: readonly FileName[], write: boolean, work: () => Promise<T>): Promise<T> {
		this.pending++;
		if (this.idle) { clearTimeout(this.idle); this.idle = undefined; }
		const result = this.queue.then(async () => {
			try { await this.ready(names, write); return await work(); }
			catch (error) { for (const name of names) { this.verified.delete(name); } throw error; }
		});
		this.queue = result.then(() => undefined, () => undefined).finally(() => {
			if (--this.pending) { return; }
			// Close read handles when idle so Windows does not keep the files locked between turns.
			this.idle = setTimeout(() => { this.idle = undefined; this.queue = this.queue.then(() => Promise.all(Object.values(this.files).map(file => file.close()))).catch(() => undefined); }, 2000);
			this.idle.unref?.();
		});
		return result;
	}
	/** Loads a file once; writes always, and reads at most every recheckMs, detect changes made by another writer. */
	private async ready(names: readonly FileName[], write: boolean): Promise<void> {
		for (const name of names) {
			const checked = this.verified.get(name);
			if (checked !== undefined && !write && Date.now() - checked < this.recheckMs) { continue; }
			if (checked === undefined || await this.files[name].changed()) { await this.load(name); }
			this.verified.set(name, Date.now());
		}
	}
	private async load(name: FileName): Promise<void> {
		const file = this.files[name];
		if (name === "agents") { const rows: AgentDocument[] = []; await file.scan(record => rows.push(record as AgentDocument)); this.agentRows = rows; }
		else if (name === "runs") { const rows: RunDocument[] = []; await file.scan(record => rows.push(record as RunDocument)); this.runRows = rows; }
		else if (name === "checkpoints") {
			const lines: BlobLine[] = [];
			this.blobs.clear(); this.sortedBlobIds.clear();
			await file.scan((record, span) => {
				const value = record as { agentId?: unknown; blobId?: unknown } | null;
				const line = typeof value?.agentId === "string" && typeof value.blobId === "string" ? { span, agentId: value.agentId, blobId: value.blobId } : { span };
				lines.push(line);
				// The SDK reader returns the first matching record.
				if (line.agentId !== undefined && !this.blobs.has(blobKey(line.agentId, line.blobId!))) { this.blobs.set(blobKey(line.agentId, line.blobId!), line); }
			});
			this.blobLines = lines;
		} else {
			const lines: EventLine[] = [];
			this.events.clear();
			await file.scan((record, span) => {
				const value = record as { runId?: unknown; seq?: unknown; idempotencyKey?: unknown } | null;
				const line: EventLine = { span, runId: typeof value?.runId === "string" ? value.runId : undefined, seq: typeof value?.seq === "number" ? value.seq : Number.NaN,
					idempotencyKey: typeof value?.idempotencyKey === "string" ? value.idempotencyKey : null };
				lines.push(line);
				if (line.runId !== undefined) { const run = this.events.get(line.runId) ?? []; run.push(line); this.events.set(line.runId, run); }
			});
			this.eventLines = lines;
		}
	}
	private async saveAgents(rows: AgentDocument[]): Promise<void> { await this.files.agents.rewrite(rows.map(row => JSON.stringify(row))); this.agentRows = rows; }
	private async saveRuns(rows: RunDocument[]): Promise<void> { await this.files.runs.rewrite(rows.map(row => JSON.stringify(row))); this.runRows = rows; }
	private async deleteEvents(runIds: ReadonlySet<string> | undefined): Promise<void> {
		const kept = runIds ? this.eventLines.filter(line => line.runId === undefined || !runIds.has(line.runId)) : [];
		if (kept.length === this.eventLines.length) { return; }
		await this.files.runEvents.rewrite(kept.map(line => line.span));
		this.verified.delete("runEvents");
	}
}

const blobKey = (agentId: string, blobId: string) => `${agentId}\u0000${blobId}`;
const eventDocument = (record: unknown): RunEventDocument => { const value = record as RunEventDocument & { createdAt: string | number }; return { ...value, createdAt: new Date(value.createdAt).getTime() }; };
const agentMatches = (row: AgentDocument, filter: AgentFilter) => !(filter.agentIds?.length && !filter.agentIds.includes(row.agentId)) && (filter.cwd === undefined || row.cwd === filter.cwd);
const runMatches = (row: RunDocument, filter?: RunFilter) => !(filter?.agentIds?.length && !filter.agentIds.includes(row.agentId) || filter?.runIds?.length && !filter.runIds.includes(row.runId));
const checkpointMatches = (line: BlobLine, filter?: CheckpointFilter) => !(filter?.agentIds?.length && !filter.agentIds.includes(line.agentId!) || filter?.blobIds?.length && !filter.blobIds.includes(line.blobId!));

const opened = new Map<string, IndexedLocalAgentStore>();
/** One instance per directory, so every SDK call in this extension host shares the same index and write queue. */
export function openIndexedLocalAgentStore(root: string, pagination: CursorStorePagination): IndexedLocalAgentStore {
	const resolved = path.resolve(root), key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
	let store = opened.get(key);
	if (!store) { store = new IndexedLocalAgentStore(resolved, pagination); opened.set(key, store); }
	return store;
}
