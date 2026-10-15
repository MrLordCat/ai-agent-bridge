import * as assert from "node:assert";
import { AsyncResourceCache } from "../providers/async-resource-cache";

suite("Async resource cache contracts", () => {
	test("joins parallel readers and refreshes expired data", async () => {
		let now = 0, calls = 0;
		const cache = new AsyncResourceCache<number>(() => now);
		const load = async () => ++calls;
		assert.deepStrictEqual(await Promise.all([cache.get("one", load, { ttlMs: 10 }), cache.get("one", load, { ttlMs: 10 })]), [1, 1]);
		now = 9; assert.strictEqual(await cache.get("one", load, { ttlMs: 10 }), 1);
		now = 10; assert.strictEqual(await cache.get("one", load, { ttlMs: 10 }), 2);
	});
	test("does not publish a late response from an invalidated generation", async () => {
		const cache = new AsyncResourceCache<number>();
		let release!: (value: number) => void;
		const old = cache.get("one", () => new Promise(resolve => { release = resolve; }), { ttlMs: 10 });
		await Promise.resolve(); cache.invalidate("one");
		assert.strictEqual(await cache.get("one", async () => 2, { ttlMs: 10 }), 2);
		release(1); assert.strictEqual(await old, undefined); assert.strictEqual(cache.peek("one"), 2);
	});
	test("cancelling one consumer leaves the shared request and other readers active", async () => {
		const cache = new AsyncResourceCache<number>(), abort = new AbortController();
		let release!: (value: number) => void, sharedSignal!: AbortSignal;
		const first = cache.get("one", signal => { sharedSignal = signal; return new Promise(resolve => { release = resolve; }); }, { ttlMs: 10, signal: abort.signal });
		const second = cache.get("one", async () => 99, { ttlMs: 10 });
		await Promise.resolve(); const cancelled = assert.rejects(first, /abort/i); abort.abort(); await cancelled;
		assert.strictEqual(sharedSignal.aborted, false); release(42); assert.strictEqual(await second, 42);
	});
	test("retains previous successful data on failure and retries without caching the error", async () => {
		const cache = new AsyncResourceCache<number>();
		await cache.get("one", async () => 1, { ttlMs: 0 });
		await assert.rejects(cache.get("one", async () => { throw new Error("offline"); }, { ttlMs: 0 }), /offline/);
		assert.strictEqual(cache.peek("one"), 1);
		assert.strictEqual(await cache.get("one", async () => 2, { ttlMs: 0 }), 2); cache.clear(); assert.strictEqual(cache.peek("one"), undefined);
	});
});