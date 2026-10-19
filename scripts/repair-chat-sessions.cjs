#!/usr/bin/env node
/* eslint-disable */
// Repairs an oversized VS Code chat session (chatSessions/<id>.jsonl).
//
// VS Code stores the whole session as one kind:0 JSON snapshot plus kind:1
// deltas. Tool results are kept verbatim, so a few view_image calls can push a
// session past 500 MB; VS Code then fails every request with
// "RangeError: Invalid string length" while serializing the agent arguments.
//
// This script reads the kind:0 snapshot, replaces large binary payloads with a
// marker, trims huge text values, keeps the newest requests within a size
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
const target = source.replace(/\.jsonl$/i, ".repaired.jsonl");
const mb = (chars) => (chars / 1048576).toFixed(2) + "M";
const sizeOf = (value) => {
	try {
		return JSON.stringify(value).length;
	} catch {
		return -1;
	}
};

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

// readline splits on lone CR/LF and can also fail on a very long record, so the
// snapshot boundary is located in the raw file instead. Every record starts
// with a newline followed by {"kind":N, and the JSON itself is minified.
function readSnapshotLine(file) {
	const size = fs.statSync(file).size;
	if (size > 1024 * 1024 * 1024) {
		throw new Error(`refusing to load a ${mb(size)} session; repair it in a different way`);
	}
	const text = fs.readFileSync(file, "utf8");
	const start = text.startsWith('{"kind":0') ? 0 : text.indexOf('\n{"kind":0');
	if (start < 0) {
		throw new Error("kind:0 snapshot not found; this does not look like a VS Code chat session");
	}
	const from = start + (start === 0 ? 0 : 1);
	const next = text.indexOf('\n{"kind":', from);
	return next < 0 ? text.slice(from).trim() : text.slice(from, next);
}

const snapshotLine = readSnapshotLine(source);
if (!snapshotLine) {
	throw new Error("kind:0 snapshot not found; this does not look like a VS Code chat session");
}
console.log(`original: ${mb(fs.statSync(source).size)} (snapshot ${mb(snapshotLine.length)})`);
const value = JSON.parse(snapshotLine).v;
sanitize(value);
const requests = value.requests ?? [];
let kept = 0;
let keptChars = 0;
for (let index = requests.length - 1; index >= 0; index--) {
	const size = sizeOf(requests[index]);
	if (kept >= MIN_REQUESTS && keptChars + size > budgetMb * 1024 * 1024) {
		break;
	}
	kept++;
	keptChars += size;
}
value.requests = requests.slice(requests.length - kept);
value.pendingRequests = [];
const line = JSON.stringify({ kind: 0, v: value });
fs.writeFileSync(target, line + "\n", "utf8");
console.log(
	`removed ${removedPayloads} binary payload(s) (${mb(removedPayloadChars)}), ` +
		`trimmed ${trimmedStrings} string(s) (${mb(trimmedChars)}); requests kept ${kept}/${requests.length}`
);
console.log(`wrote ${target} (${mb(fs.statSync(target).size)})`);
console.log(
	"Next: close the owning window, move the original aside, rename the repaired file to its name, reopen the window."
);
