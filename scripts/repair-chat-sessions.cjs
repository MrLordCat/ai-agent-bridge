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
// replacing the file. The newest images are kept (100 by default) so a repaired
// chat still shows its recent screenshots.
//
// Usage:
//   node scripts/repair-chat-sessions.cjs <session.jsonl> [--budget-mb 20] [--keep-images 100]
//        [--max-string-kb 2000] [--keep-recent 0]
//   node scripts/repair-chat-sessions.cjs --list
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");

const MAX_BINARY = 200_000;
// VS Code decodes these fields as base64 while loading; a text marker makes the whole session load empty.
const PLACEHOLDER_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const MAX_STRING = 2_000_000;
const MIN_REQUESTS = 5;

const args = process.argv.slice(2);
const optionValue = (name, fallback) => {
	const index = args.indexOf(name);
	return index >= 0 ? Number(args[index + 1]) : fallback;
};
const budgetMb = optionValue("--budget-mb", 20);
const keepImages = optionValue("--keep-images", 100);
// Requests within the newest `keepRecent` keep their long tool outputs intact.
const keepRecent = optionValue("--keep-recent", 0);
// Older requests lose tool output beyond this size (0 keeps the 2 MB default).
const maxStringKb = optionValue("--max-string-kb", 0);
const listOnly = args.includes("--list");
// Values of "--name value" options must not be mistaken for the session path.
const optionValueIndexes = new Set(args
	.flatMap((arg, index) => (arg === "--budget-mb" || arg === "--keep-images" || arg === "--keep-recent" || arg === "--max-string-kb" ? [index + 1] : [])));
const positional = args.filter((arg, index) => !arg.startsWith("--") && !optionValueIndexes.has(index));
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
if (!Number.isInteger(keepImages) || keepImages < 0 || keepImages > 10_000) {
	throw new Error("--keep-images must be an integer between 0 and 10000");
}
if (!Number.isInteger(keepRecent) || keepRecent < 0) {
	throw new Error("--keep-recent must be a non-negative integer");
}
if (!Number.isFinite(maxStringKb) || maxStringKb < 0 || maxStringKb > 1_000_000) {
	throw new Error("--max-string-kb must be a number between 0 and 1000000");
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
let removedImages = 0;
let keptImages = 0;
let trimmedOldStrings = 0;
let trimmedOldChars = 0;

const isDataImageUrl = (text) => /^data:[\w.+-]+\/image[\w.+-]*;base64,/i.test(text);

/**
 * A payload the pruning pass may keep: an image part, its data URL, a revived
 * buffer, or an unrecognised base64 blob (which is never useful as text).
 */
function isImagePayload(node, key, value) {
	if (typeof value !== "string") { return false; }
	if (key === "$base64") { return value.length > MAX_BINARY; }
	if (isDataImageUrl(value)) { return value.length > MAX_BINARY; }
	const mime = typeof node.mimeType === "string" ? node.mimeType : undefined;
	if ((key === "data" || key === "value") && mime && mime.startsWith("image/") && node.isText !== true) { return value.length > MAX_BINARY; }
	return value.length > MAX_STRING && looksBase64(value);
}

function countImages(node) {
	if (!node || typeof node !== "object") { return 0; }
	let total = 0;
	if (Array.isArray(node)) {
		for (const item of node) { total += countImages(item); }
		return total;
	}
	for (const [key, value] of Object.entries(node)) {
		if (key !== "$mid" && isImagePayload(node, key, value)) { total++; }
	}
	for (const [key, value] of Object.entries(node)) {
		if (key !== "$mid" && value && typeof value === "object") { total += countImages(value); }
	}
	return total;
}

/** Replaces image payloads in document order while `shouldDrop` says so. */
function dropImages(node, shouldDrop) {
	if (!node || typeof node !== "object") { return; }
	if (Array.isArray(node)) {
		for (const item of node) { dropImages(item, shouldDrop); }
		return;
	}
	for (const [key, value] of Object.entries(node)) {
		if (key === "$mid" || !isImagePayload(node, key, value) || !shouldDrop()) { continue; }
		node[key] = isDataImageUrl(value) ? `data:image/png;base64,${PLACEHOLDER_PNG}` : PLACEHOLDER_PNG;
		removedPayloads++; removedPayloadChars += value.length; removedImages++;
	}
	for (const [key, value] of Object.entries(node)) {
		if (key !== "$mid" && value && typeof value === "object") { dropImages(value, shouldDrop); }
	}
}

/** Keeps the newest `keepImages` images and leaves everything else to the budget pass. */
function pruneImages(requests) {
	let budget = keepImages;
	for (let index = requests.length - 1; index >= 0; index--) {
		const total = countImages(requests[index]);
		if (!total) { continue; }
		const keep = Math.max(0, Math.min(budget, total));
		budget -= keep;
		keptImages += keep;
		let drop = total - keep;
		if (!drop) { continue; }
		dropImages(requests[index], () => drop-- > 0);
	}
}

/**
 * Tool outputs in old requests are what makes a chat session grow to hundreds
 * of megabytes. The newest `keepRecent` requests stay untouched, so the model
 * still sees the current work in full; older long strings are summarized.
 */
function trimOldRequests(requests, limit) {
	if (!limit) { return; }
	const cutoff = Math.max(0, requests.length - keepRecent);
	for (let index = 0; index < cutoff; index++) {
		trimLongStrings(requests[index], limit);
	}
}

function trimLongStrings(node, limit) {
	if (typeof node === "string") { return; }
	if (!node || typeof node !== "object") { return; }
	if (Array.isArray(node)) {
		for (let index = 0; index < node.length; index++) {
			const item = node[index];
			if (typeof item === "string") { if (item.length > limit) { node[index] = trimText(item); } }
			else { trimLongStrings(item, limit); }
		}
		return;
	}
	for (const [key, value] of Object.entries(node)) {
		if (key === "$mid" || typeof value !== "string") {
			if (value && typeof value === "object") { trimLongStrings(value, limit); }
			continue;
		}
		if (isImagePayload(node, key, value) || isDataImageUrl(value)) { continue; }
		if (value.length > limit) {
			node[key] = trimText(value);
			trimmedOldStrings++; trimmedOldChars += value.length - node[key].length;
		}
	}
}

function trimText(text) {
	const marker = `\n... [${text.length - 6000} characters removed while repairing the chat session] ...\n`;
	return text.slice(0, 4000) + marker + text.slice(-2000);
}

const BASE64_SAMPLE = /^[A-Za-z0-9+/\-_]+={0,2}$/;
const looksBase64 = (text) => BASE64_SAMPLE.test(text.slice(0, 4096)) && BASE64_SAMPLE.test(text.slice(-4096));

function removePayload(text, replacement) {
	removedPayloads++;
	removedPayloadChars += text.length;
	return replacement;
}

function sanitize(node, preserveImages = true) {
	if (typeof node === "string") {
		if (node.length > MAX_STRING) {
			if (isDataImageUrl(node) && preserveImages) { return node; }
			if (/^data:[\w.+-]+\/[\w.+-]+;base64,/i.test(node)) { return removePayload(node, `data:image/png;base64,${PLACEHOLDER_PNG}`); }
			if (looksBase64(node) && preserveImages) { return node; }
			if (looksBase64(node)) { return removePayload(node, PLACEHOLDER_PNG); }
			trimmedStrings++;
			trimmedChars += node.length;
			return trimText(node);
		}
		return node;
	}
	if (Array.isArray(node)) {
		for (let index = 0; index < node.length; index++) {
			node[index] = sanitize(node[index], preserveImages);
		}
		return node;
	}
	if (!node || typeof node !== "object") {
		return node;
	}
	const mime = typeof node.mimeType === "string" ? node.mimeType : undefined;
	// Tool outputs keep screenshots as base64 in `value`, other parts in `data`.
	for (const field of ["data", "value"]) {
		const payload = node[field];
		if (typeof payload === "string" && payload.length > MAX_BINARY && mime && !mime.startsWith("text/") && node.isText !== true) {
			if (preserveImages && mime.startsWith("image/") && payload.length > MAX_BINARY) { continue; }
			node[field] = removePayload(payload, mime.startsWith("image/") ? PLACEHOLDER_PNG : "");
		}
	}
	// Serialized buffers ({ $base64 }) are revived while the session loads.
	if (typeof node.$base64 === "string" && node.$base64.length > MAX_BINARY && !preserveImages) {
		node.$base64 = removePayload(node.$base64, PLACEHOLDER_PNG);
	}
	for (const key of Object.keys(node)) {
		if (key === "$mid") {
			continue;
		}
		if (preserveImages && typeof node[key] === "string" && isImagePayload(node, key, node[key])) {
			continue;
		}
		node[key] = sanitize(node[key], preserveImages);
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
	// Images are decided first, so the request budget reflects what is really stored.
	pruneImages(requests);
	const trimLimit = maxStringKb > 0 ? maxStringKb * 1000 : MAX_STRING;
	trimOldRequests(requests, trimLimit);
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
	console.log(`images: kept ${keptImages}, replaced ${removedImages}`);
	if (trimmedOldStrings) {
		console.log(`old requests: trimmed ${trimmedOldStrings} long string(s) (${mb(trimmedOldChars)} freed), newest ${keepRecent} request(s) untouched`);
	}
	console.log(`wrote ${target} (${mb(fs.statSync(target).size)})`);
	console.log("Next: close the owning window, move the original aside, rename the repaired file to its name, reopen the window.");
}

main().catch(error => { console.error(`Repair failed: ${error.message}`); process.exitCode = 1; });
