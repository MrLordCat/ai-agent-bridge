import * as assert from "node:assert";
import { resolveCodexLimitGate } from "../codex/codex-provider";
import type { CodexRateLimitSnapshot } from "../codex/protocol";

const snapshot = (value: Partial<CodexRateLimitSnapshot>): CodexRateLimitSnapshot => ({
	limitId: "codex",
	limitName: null,
	primary: null,
	secondary: null,
	planType: "plus",
	rateLimitReachedType: null,
	...value,
});

suite("Codex limit gate", () => {
	test("a reset 5-hour window clears the gate even when reached-type is stale", () => {
		// Mirrors the reported bug: the panel showed 0% used for the 5-hour window
		// and 57% for the weekly one, while rateLimitReachedType still said primary.
		const decision = resolveCodexLimitGate(snapshot({
			primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_793_800_000 },
			secondary: { usedPercent: 57, windowDurationMins: 10_080, resetsAt: 1_794_300_000 },
			rateLimitReachedType: "primary",
		}));
		assert.deepStrictEqual(decision, { kind: "clear" });
	});

	test("a window at 100% blocks the chat with its own reset", () => {
		const decision = resolveCodexLimitGate(snapshot({
			primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_793_800_000 },
			secondary: { usedPercent: 57, windowDurationMins: 10_080, resetsAt: 1_794_300_000 },
			rateLimitReachedType: "primary",
		}));
		assert.strictEqual(decision.kind, "limited");
		if (decision.kind !== "limited") {
			return;
		}
		assert.strictEqual(decision.match.window, "5-hour");
		assert.strictEqual(decision.match.resetAt?.toISOString(), new Date(1_793_800_000 * 1_000).toISOString());
		assert.strictEqual(decision.match.provisional, undefined, "a reported window is authoritative");
	});

	test("a full weekly window is named weekly", () => {
		const decision = resolveCodexLimitGate(snapshot({
			primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
			secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: null },
			rateLimitReachedType: "secondary",
		}));
		assert.strictEqual(decision.kind, "limited");
		if (decision.kind === "limited") {
			assert.strictEqual(decision.match.window, "weekly");
			assert.strictEqual(decision.match.resetAt, undefined);
		}
	});

	test("no window numbers leave the current gate untouched", () => {
		assert.deepStrictEqual(resolveCodexLimitGate(undefined), { kind: "unknown" });
		assert.deepStrictEqual(resolveCodexLimitGate(snapshot({ rateLimitReachedType: "primary" })), { kind: "unknown" });
	});
});
