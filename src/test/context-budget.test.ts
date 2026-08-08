import * as assert from "assert";
import {
	calculateContextBudget,
	estimateContextUsage,
	selectContextCompaction,
	updateHeuristicCalibration,
} from "../context/context-budget";

suite("context budget", () => {
	test("reserves output and tool tokens from soft and hard targets", () => {
		const budget = calculateContextBudget({
			contextLength: 131072,
			contextUtilization: 0.85,
			hardContextUtilization: 0.72,
			maxOutputTokens: 8192,
			minReplyReserveTokens: 1536,
			replyReservePercent: 0.10,
			toolTokens: 2048,
		});

		assert.strictEqual(budget.modelInputLimit, 131072);
		assert.strictEqual(budget.inputBudget, 111411);
		// 10% of 131072 = 13107, max(1536, min(8192, 13107)) = 8192
		assert.strictEqual(budget.replyReserveTokens, 8192);
		assert.strictEqual(budget.softInputTarget, 101171);
		assert.strictEqual(budget.hardInputTarget, 84131);
	});

	test("caps reply reserve at percent of context", () => {
		const budget = calculateContextBudget({
			contextLength: 258400,
			contextUtilization: 0.85,
			hardContextUtilization: 0.72,
			maxOutputTokens: 65536,
			minReplyReserveTokens: 1536,
			replyReservePercent: 0.07,
			toolTokens: 0,
		});

		// 7% of 258400 = 18088, max(1536, min(65536, 18088)) = 18088
		assert.strictEqual(budget.replyReserveTokens, 18088);
	});

	test("uses the configured minimum reply reserve when percent cap is lower", () => {
		const budget = calculateContextBudget({
			contextLength: 49152,
			contextUtilization: 0.85,
			hardContextUtilization: 0.72,
			maxOutputTokens: 512,
			minReplyReserveTokens: 1536,
			replyReservePercent: 0.07,
			toolTokens: 0,
		});

		// 7% of 49152 = 3440, max(1536, min(512, 3440)) = 1536
		assert.strictEqual(budget.replyReserveTokens, 1536);
	});

	test("reports usage against the runtime context window", () => {
		assert.deepStrictEqual(estimateContextUsage(49152, 20000, 2000, 8000), {
			estimatedUsedTokens: 30000,
			estimatedFreeTokens: 19152,
			estimatedUsagePercent: 61,
		});
	});

	test("allows usage above 100 percent while clamping free tokens", () => {
		assert.deepStrictEqual(estimateContextUsage(4096, 5000, 1000, 1000), {
			estimatedUsedTokens: 7000,
			estimatedFreeTokens: 0,
			estimatedUsagePercent: 170.9,
		});
	});

	test("calibration converges to the actual raw-to-server token multiplier", () => {
		const actualMultiplier = 1.68;
		let factor = 1;
		for (let turn = 0; turn < 20; turn += 1) {
			const residualRatio = actualMultiplier / factor;
			factor = updateHeuristicCalibration(factor, residualRatio);
		}

		assert.ok(
			Math.abs(factor - actualMultiplier) < 0.02,
			`expected calibration near ${actualMultiplier}, got ${factor}`
		);
		const calibratedMessageTokens = Math.round(150_000 * factor);
		assert.strictEqual(
			selectContextCompaction({
				messageTokens: calibratedMessageTokens,
				autoCompact: true,
				softInputTarget: 218_739,
				overflowRetry: false,
			}).kind,
			"auto",
			"the calibrated estimate must trigger compaction before the real prompt overflows"
		);
	});

	test("applies a single soft compaction scheme", () => {
		assert.deepStrictEqual(selectContextCompaction({
			messageTokens: 110000,
			autoCompact: true,
			softInputTarget: 101171,
			overflowRetry: false,
		}), { kind: "auto", target: 82500 });

		assert.deepStrictEqual(selectContextCompaction({
			messageTokens: 101000,
			autoCompact: true,
			softInputTarget: 101171,
			overflowRetry: false,
		}), { kind: "none" });
	});

	test("auto-compaction lands below the trigger to avoid micro-compactions", () => {
		// Compacting to exactly the soft target re-triggers on the next turn.
		// The 0.75 ratio keeps 75% of the current size (~25% reduction), which
		// leaves headroom so a single compaction lasts for many turns.
		const decision = selectContextCompaction({
			messageTokens: 450000,
			autoCompact: true,
			softInputTarget: 402100,
			overflowRetry: false,
		});
		assert.strictEqual(decision.kind, "auto");
		if (decision.kind === "auto") {
			assert.strictEqual(decision.target, 337500);
			assert.ok(decision.target < 402100, "target must stay below the trigger");
		}
	});

	test("applies the same soft compaction on a confirmed overflow retry", () => {
		assert.deepStrictEqual(selectContextCompaction({
			messageTokens: 101000,
			autoCompact: true,
			softInputTarget: 101171,
			overflowRetry: true,
		}), { kind: "auto", target: 75750 });
	});
});
