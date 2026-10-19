import * as assert from "node:assert";
import { CursorTurnMetrics, type CursorLiveTurn } from "../cursor/turn-metrics";
import type { CursorSession } from "../cursor/session-store";

function fixture() {
	const updates: CursorLiveTurn[] = [];
	const session: CursorSession = { key: "chat", identity: "profile", users: [], nextUsers: [], persistent: true,
		busy: true, closed: false, deltaStart: 100, touchedAt: Date.now(), mode: "restored", reason: "history_rebased", completedAt: Date.now() - 72 * 60_000 };
	const metrics = new CursorTurnMetrics("model", "source", 102, session, update => updates.push(update));
	return { metrics, updates, session };
}

suite("Cursor cache diagnostics", () => {
	test("reports native aggregate cache writes without blaming restored history or inventing compaction evidence", () => {
		const f = fixture();
		f.metrics.input("new continuation", 2, 0); f.metrics.run("run-native");
		f.metrics.result({ inputTokens: 1280952, outputTokens: 22047, cacheReadTokens: 897178, cacheWriteTokens: 383744, totalTokens: 2583921 });
		f.metrics.finish();
		const turn = f.updates.at(-1)!.turn, diagnostics = turn.cursorCacheDiagnostics!;
		assert.ok(Math.abs(turn.promptCacheHitPercent! - 70.03993904533503) < 1e-9);
		assert.strictEqual(turn.cacheMissReason, "unknown"); assert.strictEqual(turn.compacted, undefined);
		assert.strictEqual(diagnostics.uncachedInputTokens, 30); assert.strictEqual(diagnostics.nativeRunId, "run-native");
		assert.strictEqual(diagnostics.usageScope, "native-run-aggregate"); assert.strictEqual(diagnostics.modelCallBreakdown, "unreported");
		assert.strictEqual(diagnostics.compactionStatus, "unreported"); assert.strictEqual(diagnostics.sentMessages, 2);
		assert.strictEqual(diagnostics.sentTextChars, 16); assert.strictEqual(diagnostics.sessionReason, "history_rebased");
		assert.ok(turn.gapSinceLastResponseMs! >= 72 * 60_000);
	});
	test("compares effective tool schemas across reordering, changes and omitted telemetry", () => {
		const f = fixture(), original = { a: { description: "Read", inputSchema: { type: "object", properties: { file: { type: "string" } } }, execute: () => undefined } };
		f.metrics.catalog(original); const hash = f.metrics.catalogHash!;
		f.session.toolCatalogHash = hash;
		const next = new CursorTurnMetrics("model", "source", 2, f.session, update => f.updates.push(update));
		next.catalog({ a: { execute: () => "different callback", inputSchema: { properties: { file: { type: "string" } }, type: "object" }, description: "Read" } });
		next.result(undefined); next.finish();
		let turn = f.updates.at(-1)!.turn;
		assert.strictEqual(turn.cursorCacheDiagnostics!.toolCatalogChanged, false);
		assert.strictEqual(turn.cursorCacheDiagnostics!.uncachedInputTokens, undefined); assert.strictEqual(turn.cacheMissReason, "usage_not_reported");
		next.catalog({ a: { ...original.a, description: "Search" } }); next.finish(); turn = f.updates.at(-1)!.turn;
		assert.strictEqual(turn.cursorCacheDiagnostics!.toolCatalogChanged, true);
		assert.strictEqual(turn.cursorCacheDiagnostics!.toolCatalogChangesDuringRun, 1);
		assert.match(next.catalogHash!, /^[a-f0-9]{64}$/);
	});
});