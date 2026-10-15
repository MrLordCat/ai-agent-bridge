import * as assert from "node:assert";
import { DelegatedTurnState, PendingToolRegistry } from "../tools/delegated-turn-state";

suite("Delegated turn controller contracts", () => {
	test("delivers each result once and reports incomplete batches", () => {
		const calls = new PendingToolRegistry<{ reported: boolean }>();
		calls.set("one", { reported: true }); calls.set("two", { reported: true });
		assert.deepStrictEqual(calls.missing(new Set(["one"]), call => call.reported), ["two"]);
		let delivered = 0;
		assert.strictEqual(calls.accept(["one", "one", "unknown"], id => id, () => delivered++), 1);
		assert.strictEqual(delivered, 1); assert.strictEqual(calls.size, 1);
	});
	test("yields for tools, buffers output and attaches the next native response", async () => {
		const state = new DelegatedTurnState<number, string>(10);
		const first = state.attach(); assert.throws(() => state.attach(), /already attached/);
		state.release(); await first; state.enqueue("output", 6);
		assert.deepStrictEqual(state.takeOutput(), ["output"]);
		const second = state.attach(); state.finish(undefined, () => undefined); await second;
		assert.ok(state.terminal); assert.ok(!state.attached);
	});
	test("retires pending callbacks once and drops late output after cancellation", async () => {
		const state = new DelegatedTurnState<number, string>(); let settled = 0;
		state.pending.set("one", 1); const boundary = assert.rejects(state.attach(), /cancelled/);
		assert.ok(state.finish(new Error("cancelled"), () => settled++));
		assert.ok(!state.finish(new Error("again"), () => settled++)); await boundary;
		state.enqueue("late", 4); assert.deepStrictEqual(state.takeOutput(), []); assert.strictEqual(settled, 1);
	});
	test("bounds detached output and clears pending calls before reentrant settlement", () => {
		const state = new DelegatedTurnState<number, string>(4);
		state.enqueue("four", 4); assert.throws(() => state.enqueue("x", 1), /Too much output/);
		state.pending.set("one", 1);
		state.finish(undefined, () => assert.strictEqual(state.pending.size, 0));
	});
});