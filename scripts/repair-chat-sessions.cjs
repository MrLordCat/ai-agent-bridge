#!/usr/bin/env node
/* eslint-disable */
// Repairs an oversized VS Code chat session (chatSessions/<id>.jsonl).
//
// VS Code stores the whole session as kind:0 snapshots plus kind:1/kind:2
// deltas. Tool results are kept verbatim, so a few view_image calls can push a
// session past 500 MB; VS Code then fails every request with
// "RangeError: Invalid string length" while serializing the agent arguments.
//
// This script streams snapshots and subsequent set/splice deltas, replaces
// large binary payloads with a marker, trims huge text values, keeps the newest requests within a size
// budget and writes <session>.repaired.jsonl next to the original. The original
// file is never modified. Close the window that owns the session before
// replacing the file.
//
// Usage:
//   node scripts/repair-chat-sessions.cjs <session.jsonl> [--budget-mb 20]
//   node scripts/repair-chat-sessions.cjs --list
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");

const MAX_BINARY = 200_000;
const MAX_STRING = 2_000_000;
const MIN_REQUESTS = 5;

const args = process.argv.slice(2);
const budgetIndex = args.indexOf("--budget-mb");
const budgetMb = budgetIndex >= 0 ? Number(args[budgetIndex + 1]) : 20;
const listOnly = args.includes("--list");
const positional = args.filter(
	(arg, index) => !arg.startsWith("--") && !(budgetIndex >= 0 && index === budgetIndex + 1)
);
const file = positional[0];

function workspaceStorageRoots() {
	const roots = [];
	if (process.env.APPDATA) {
		roots.push(path.join(process.env.APPDATA, "Code", "User", "workspaceStorage"));
		roots.push(path.join(process.env.APPDATA, "Code - OSS", "User", "workspaceStorage"));
		roots.push(path.join(process.env.APPDATA, "Code - Insiders", "User", "workspaceStorage"));
	}
	roots.push(path.join(os.homedir(), ".config", "Code", "User", "workspaceStorage"));
	return roots.filter((root) => fs.existsSync(root));
}

function listSessions() {
	const rows = [];
	for (const root of workspaceStorageRoots()) {
		for (const workspace of fs.readdirSync(root, { withFileTypes: true })) {
			if (!workspace.isDirectory()) {
				continue;
			}
			const sessions = path.join(root, workspace.name, "chatSessions");
			if (!fs.existsSync(sessions)) {
				continue;
			}
			for (const entry of fs.readdirSync(sessions)) {
				if (!entry.endsWith(".jsonl") || entry.includes(".repaired.")) {
					continue;
				}
				const full = path.join(sessions, entry);
				rows.push({ size: fs.statSync(full).size, full });
			}
		}
	}
	rows.sort((a, b) => b.size - a.size);
	for (const row of rows.slice(0, 25)) {
		console.log(`${(row.size / 1048576).toFixed(1)} MB\t${row.full}`);
	}
	console.log(`\n${rows.length} session file(s); large ones can be repaired with this script.`);
}

if (listOnly || !file) {
	listSessions();
	if (!file) {
		console.log("\nUsage: node scripts/repair-chat-sessions.cjs <session.jsonl> [--budget-mb 20]");
	}
	process.exit(0);
}

const source = path.resolve(file);
if (!fs.existsSync(source)) {
	throw new Error(`session not found: ${source}`);
}
if (!/\.jsonl$/i.test(source)) {
	throw new Error("source must have a .jsonl extension; no files were changed");
}
if (!Number.isFinite(budgetMb) || budgetMb <= 0 || budgetMb > 1024) {
	throw new Error("--budget-mb must be a number greater than 0 and at most 1024");
}
const target = source.replace(/\.jsonl$/i, ".repaired.jsonl");
if (fs.existsSync(target)) {
	throw new Error("repaired output already exists; move it aside before retrying");
}
const mb = (chars) => (chars / 1048576).toFixed(2) + "M";
const sizeOf = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

let removedPayloads = 0;
let removedPayloadChars = 0;
let trimmedStrings = 0;
let trimmedChars = 0;

function trimText(text) {
	const marker = `\n... [${text.length - 6000} characters removed while repairing the chat session] ...\n`;
	return text.slice(0, 4000) + marker + text.slice(-2000);
}

function sanitize(node) {
	if (typeof node === "string") {
		if (node.length > MAX_STRING) {
			trimmedStrings++;
			trimmedChars += node.length;
			return trimText(node);
		}
		return node;
	}
	if (Array.isArray(node)) {
		for (let index = 0; index < node.length; index++) {
			node[index] = sanitize(node[index]);
		}
		return node;
	}
	if (!node || typeof node !== "object") {
		return node;
	}
	const mime = typeof node.mimeType === "string" ? node.mimeType : undefined;
	if (typeof node.data === "string" && node.data.length > MAX_BINARY && mime && !mime.startsWith("text/")) {
		removedPayloads++;
		removedPayloadChars += node.data.length;
		node.data = `[${mime} payload removed while repairing the chat session: ${node.data.length} chars]`;
	}
	for (const key of Object.keys(node)) {
		if (key === "$mid") {
			continue;
		}
		node[key] = sanitize(node[key]);
	}
	return node;
}

function location(value, keys) {
	let node = value;
	for (const key of keys) {
		if (!node || typeof node !== "object" || !Object.hasOwn(node, key)) {
			throw new Error("invalid delta path; no repaired file was written");
		}
		node = node[key];
	}
	return node;
}

async function readSession(file) {
	const { parserStream } = await import("stream-json");
	const { default: streamValues } = await import("stream-json/streamers/stream-values.js");
	let value, records = 0;
	await pipeline(fs.createReadStream(file), parserStream({ jsonStreaming: true }), streamValues.asStream(), async (entries) => {
		for await (const { value: edit } of entries) {
			records++;
			if (edit?.kind === 0) {
				value = sanitize(edit.v);
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					throw new Error("invalid kind:0 session snapshot");
				}
				continue;
			}
			if (!value || ![1, 2].includes(edit?.kind) || !Array.isArray(edit.k) || edit.k.some(key =>
				typeof key !== "string" && (!Number.isSafeInteger(key) || key < 0) || ["__proto__", "constructor", "prototype"].includes(key))) {
				throw new Error("invalid or unsupported session delta; no repaired file was written");
			}
			if (edit.kind === 2) {
				const array = location(value, edit.k), index = edit.i ?? array?.length;
				if (!Array.isArray(array) || !Number.isSafeInteger(index) || index < 0 || index > array.length || edit.v !== undefined && !Array.isArray(edit.v)) {
					throw new Error("invalid array splice delta");
				}
				array.length = index;
				for (const item of edit.v ?? []) { array.push(sanitize(item)); }
			} else if (!edit.k.length) {
				if (!edit.v || typeof edit.v !== "object" || Array.isArray(edit.v)) { throw new Error("invalid root replacement"); }
				value = sanitize(edit.v);
			} else {
				const parent = location(value, edit.k.slice(0, -1)), key = edit.k.at(-1);
				if (!parent || typeof parent !== "object" || Array.isArray(parent) && (!Number.isSafeInteger(key) || key < 0 || key > parent.length)) {
					throw new Error("invalid assignment delta");
				}
				if (Object.hasOwn(edit, "v")) { parent[key] = sanitize(edit.v); } else { delete parent[key]; }
			}
		}
	});
	if (!value || !Array.isArray(value.requests)) { throw new Error("session snapshot with requests not found"); }
	return { value, records };
}

async function main() {
	const size = fs.statSync(source).size;
	if (size > 1024 * 1024 * 1024) { throw new Error(`refusing to load a ${mb(size)} session`); }
	const { value, records } = await readSession(source), requests = value.requests, budget = budgetMb * 1024 * 1024;
	console.log(`original: ${mb(size)}, applied ${records} snapshot/delta record(s)`);
	let kept = 0, keptBytes = 0;
	for (let index = requests.length - 1; index >= 0; index--) {
		const bytes = sizeOf(requests[index]);
		if (kept >= MIN_REQUESTS && keptBytes + bytes > budget) { break; }
		kept++; keptBytes += bytes;
	}
	value.requests = requests.slice(requests.length - kept);
	value.pendingRequests = [];
	let line = JSON.stringify({ kind: 0, v: value });
	while (Buffer.byteLength(line, "utf8") + 1 > budget && value.requests.length > 1) {
		value.requests.shift(); line = JSON.stringify({ kind: 0, v: value });
	}
	if (Buffer.byteLength(line, "utf8") + 1 > budget) { throw new Error("newest request or session metadata exceeds the budget; no repaired file was written"); }
	fs.writeFileSync(target, line + "\n", { encoding: "utf8", flag: "wx" });
	console.log(`removed ${removedPayloads} binary payload(s) (${mb(removedPayloadChars)}), trimmed ${trimmedStrings} string(s) (${mb(trimmedChars)}); requests kept ${value.requests.length}/${requests.length}`);
	console.log(`wrote ${target} (${mb(fs.statSync(target).size)})`);
	console.log("Next: close the owning window, move the original aside, rename the repaired file to its name, reopen the window.");
}

main().catch(error => { console.error(`Repair failed: ${error.message}`); process.exitCode = 1; });
