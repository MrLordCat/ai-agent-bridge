import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./repair-chat-sessions.cjs", import.meta.url));
function fixture(t, records, extension = ".jsonl") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "aab-chat-repair-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const source = path.join(root, "session" + extension), target = source.replace(/\.jsonl$/i, ".repaired.jsonl");
	const original = records.map(value => JSON.stringify(value)).join("\n") + "\n";
	fs.writeFileSync(source, original);
	return { root, source, target, original,
		run: (args = [], preload) => spawnSync(process.execPath, [...preload ? ["--require", preload] : [], script, source, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 }),
		read: () => JSON.parse(fs.readFileSync(target, "utf8")).v,
		unchanged: () => assert.equal(fs.readFileSync(source, "utf8"), original),
	};
}

test("repairs binary/text payloads while preserving the original", t => {
	const f = fixture(t, [{ kind: 0, v: { requests: [{ content: [{ mimeType: "image/png", data: "A".repeat(300_000) }], text: "x".repeat(2_100_000) }], pendingRequests: ["old"] } }]);
	const result = f.run(); assert.equal(result.status, 0, result.stderr); f.unchanged();
	const repaired = f.read(); assert.match(repaired.requests[0].content[0].data, /payload removed/);
	assert.match(repaired.requests[0].text, /characters removed/); assert.ok(repaired.requests[0].text.length < 7000);
	assert.deepEqual(repaired.pendingRequests, []);
});

test("applies set, delete, append and truncate deltas before selecting recent requests", t => {
	const f = fixture(t, [
		{ kind: 0, v: { requests: [{ id: "first", response: ["old"], obsolete: true }, { id: "second" }] } },
		{ kind: 1, k: ["requests", 0, "updated"], v: "последняя версия" },
		{ kind: 1, k: ["requests", 0, "obsolete"] },
		{ kind: 2, k: ["requests", 0, "response"], i: 0, v: ["new", "extra"] },
		{ kind: 2, k: ["requests", 0, "response"], i: 1 },
		{ kind: 2, k: ["requests"], v: [{ id: "third" }] },
		{ kind: 2, k: ["requests"], i: 1, v: [{ id: "latest" }] },
	]);
	const result = f.run(); assert.equal(result.status, 0, result.stderr); f.unchanged();
	assert.deepEqual(f.read().requests, [{ id: "first", response: ["new"], updated: "последняя версия" }, { id: "latest" }]);
});

test("uses the most recent complete snapshot and subsequent updates", t => {
	const f = fixture(t, [{ kind: 0, v: { requests: [{ id: "obsolete" }] } }, { kind: 0, v: { requests: [{ id: "fresh" }] } }, { kind: 1, k: ["requests", 0, "done"], v: true }]);
	const result = f.run(); assert.equal(result.status, 0, result.stderr); assert.deepEqual(f.read().requests, [{ id: "fresh", done: true }]); f.unchanged();
});

test("refuses unsupported source extensions and existing output without changing either", t => {
	const bad = fixture(t, [{ kind: 0, v: { requests: [] } }], ".json");
	assert.notEqual(bad.run().status, 0); bad.unchanged();
	const f = fixture(t, [{ kind: 0, v: { requests: [] } }]); fs.writeFileSync(f.target, "existing repair");
	assert.notEqual(f.run().status, 0); assert.equal(fs.readFileSync(f.target, "utf8"), "existing repair"); f.unchanged();
});

test("enforces a UTF-8 byte budget and refuses invalid budgets", t => {
	const f = fixture(t, [{ kind: 0, v: { requests: Array.from({ length: 8 }, (_, id) => ({ id, text: "я".repeat(10_000) })) } }]);
	for (const budget of ["0", "-1", "NaN"]) { assert.notEqual(f.run(["--budget-mb", budget]).status, 0); assert.ok(!fs.existsSync(f.target)); }
	const result = f.run(["--budget-mb", "0.05"]); assert.equal(result.status, 0, result.stderr);
	assert.ok(fs.statSync(f.target).size <= 0.05 * 1024 * 1024); assert.equal(f.read().requests.at(-1).id, 7); f.unchanged();
});

test("refuses corrupt, unknown and unsafe deltas instead of writing a stale snapshot", t => {
	for (const delta of [{ kind: 9, k: [], v: [] }, { kind: 1, k: ["missing", "field"], v: true }, { kind: 1, k: ["__proto__", "polluted"], v: true }]) {
		const f = fixture(t, [{ kind: 0, v: { requests: [] } }, delta]);
		assert.notEqual(f.run().status, 0); assert.ok(!fs.existsSync(f.target)); f.unchanged();
	}
	const f = fixture(t, [{ kind: 0, v: { requests: [] } }]); fs.appendFileSync(f.source, '{"kind":1,"k":');
	assert.notEqual(f.run().status, 0); assert.ok(!fs.existsSync(f.target));
});

test("streams large snapshots rather than reading the complete JSONL file as a string", t => {
	const f = fixture(t, [{ kind: 0, v: { requests: Array.from({ length: 40 }, (_, id) => ({ id, content: [{ mimeType: "image/png", data: "A".repeat(300_000) }] })) } }]);
	const guard = path.join(f.root, "guard.cjs");
	fs.writeFileSync(guard, `const fs=require('node:fs'),original=fs.readFileSync;fs.readFileSync=function(file,...args){if(String(file)===${JSON.stringify(f.source)})throw new Error('Whole-source reads forbidden');return original.call(this,file,...args)};`);
	const result = f.run([], guard); assert.equal(result.status, 0, result.stderr); assert.equal(f.read().requests.at(-1).id, 39); f.unchanged();
});