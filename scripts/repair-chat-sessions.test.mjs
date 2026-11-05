import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
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
	const output = [{ mimeType: "image/png", value: "B".repeat(300_000) }, { isText: true, value: "short text" }];
	const f = fixture(t, [{ kind: 0, v: { requests: [{ content: [{ mimeType: "image/png", data: "A".repeat(300_000) }], resultDetails: { output }, text: "x ".repeat(1_100_000) }], pendingRequests: ["old"] } }]);
	const result = f.run(["--keep-images", "0"]); assert.equal(result.status, 0, result.stderr); f.unchanged();
	const repaired = f.read(), base64 = /^[A-Za-z0-9+/]*={0,2}$/;
	for (const payload of [repaired.requests[0].content[0].data, repaired.requests[0].resultDetails.output[0].value]) {
		assert.ok(payload.length < 200 && base64.test(payload), "removed payloads must stay decodable base64");
		assert.equal(Buffer.from(payload, "base64").subarray(1, 4).toString(), "PNG");
	}
	assert.equal(repaired.requests[0].resultDetails.output[1].value, "short text");
	assert.match(repaired.requests[0].text, /characters removed/); assert.ok(repaired.requests[0].text.length < 7000);
	assert.deepEqual(repaired.pendingRequests, []);
});

test("replaces oversized base64 buffers and data URLs with decodable placeholders", t => {
	const png = "iVBORw0K" + "A".repeat(2_100_000);
	const f = fixture(t, [{ kind: 0, v: { requests: [{ variableData: { variables: [{ value: { $base64: "A".repeat(300_000) } }] },
		result: { metadata: { image: { url: `data:image/png;base64,${png}` }, raw: png, log: "line ".repeat(500_000) } } }] } }]);
	const result = f.run(["--keep-images", "0"]); assert.equal(result.status, 0, result.stderr); f.unchanged();
	const request = f.read().requests[0], metadata = request.result.metadata;
	assert.match(request.variableData.variables[0].value.$base64, /^iVBORw0KGgo[A-Za-z0-9+/]+=*$/);
	assert.match(metadata.image.url, /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]+=*$/);
	assert.match(metadata.raw, /^iVBORw0KGgo[A-Za-z0-9+/]+=*$/);
	assert.match(metadata.log, /characters removed/);
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

test("keeps the newest images and replaces only the older ones", t => {
	const requests = Array.from({ length: 6 }, (_, id) => ({ id, content: [{ mimeType: "image/png", data: `${id}` + "A".repeat(300_000) }] }));
	const f = fixture(t, [{ kind: 0, v: { requests } }]);
	const result = f.run(["--keep-images", "2"]); assert.equal(result.status, 0, result.stderr); f.unchanged();
	const kept = f.read().requests, placeholder = /^iVBORw0KGgo[A-Za-z0-9+/]+=*$/;
	assert.deepEqual(kept.slice(0, 4).map(request => request.content[0].data), Array(4).fill(kept[0].content[0].data));
	assert.match(kept[0].content[0].data, placeholder);
	for (const request of kept.slice(4)) { assert.match(request.content[0].data, /^[45]AAAA/); }
	assert.match(result.stdout, /images: kept 2, replaced 4/);
});

test("refuses an invalid image budget", t => {
	const f = fixture(t, [{ kind: 0, v: { requests: [{ id: 1 }] } }]);
	for (const keep of ["-1", "1.5", "10001", "NaN"]) { assert.notEqual(f.run(["--keep-images", keep]).status, 0); assert.ok(!fs.existsSync(f.target)); }
	f.unchanged();
});

test("trims long strings in old requests and leaves the newest ones intact", t => {
	const long = "log line ".repeat(30_000);
	const requests = Array.from({ length: 6 }, (_, id) => ({ id, content: [{ isText: true, value: `${id}${long}` }] }));
	const f = fixture(t, [{ kind: 0, v: { requests } }]);
	const result = f.run(["--keep-recent", "2", "--max-string-kb", "100", "--budget-mb", "200"]);
	assert.equal(result.status, 0, result.stderr); f.unchanged();
	const kept = f.read().requests;
	assert.match(kept[0].content[0].value, /characters removed/);
	assert.match(kept[2].content[0].value, /characters removed/);
	assert.match(kept[3].content[0].value, /characters removed/, "only the newest two requests stay intact");
	assert.ok(kept[4].content[0].value.startsWith("4log line log line"), "the newest requests keep their text");
	assert.strictEqual(kept[5].content[0].value.length, long.length + 1, "the newest request text is untouched");
	assert.match(result.stdout, /old requests: trimmed 4 long string/);
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