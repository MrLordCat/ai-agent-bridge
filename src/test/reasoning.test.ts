import * as assert from "assert";
import {
	createReasoningConfigurationSchema,
	normalizeThinkingMode,
	resolveReasoningBudget,
	resolveRequestThinkingMode,
	toDeepSeekReasoningEffort,
} from "../reasoning";

suite("reasoning", () => {
	test("normalizes native VS Code effort names", () => {
		assert.strictEqual(normalizeThinkingMode("none"), "off");
		assert.strictEqual(normalizeThinkingMode("low"), "light");
		assert.strictEqual(normalizeThinkingMode("medium"), "balanced");
		assert.strictEqual(normalizeThinkingMode("high"), "deep");
		assert.strictEqual(normalizeThinkingMode("max"), "deep");
	});

	test("builds native picker schemas per model family", () => {
		const local = createReasoningConfigurationSchema("qwen").properties.reasoningEffort;
		assert.deepStrictEqual(local.enum, ["none", "low", "medium", "high"]);
		assert.strictEqual(local.default, "medium");

		const deepSeek = createReasoningConfigurationSchema("deepseek").properties.reasoningEffort;
		assert.deepStrictEqual(deepSeek.enum, ["high", "max"]);
		assert.strictEqual(deepSeek.default, "high");
	});

	test("request effort overrides the global setting", () => {
		assert.strictEqual(resolveRequestThinkingMode("off", { reasoningEffort: "high" }), "deep");
		assert.strictEqual(resolveRequestThinkingMode("deep", { reasoning_effort: "none" }), "off");
		assert.strictEqual(resolveRequestThinkingMode("balanced", undefined), "balanced");
	});

	test("maps modes to local budgets and DeepSeek effort", () => {
		assert.strictEqual(resolveReasoningBudget("off", 4096), 0);
		assert.strictEqual(resolveReasoningBudget("auto", 4096), 4096);
		assert.strictEqual(resolveReasoningBudget("deep", 4096), 4096);
		assert.strictEqual(resolveReasoningBudget("balanced", 1024), 1024);
		assert.strictEqual(resolveReasoningBudget("light", 8192), 512);
		assert.strictEqual(resolveReasoningBudget("auto", Number.NaN), 16384);
		assert.strictEqual(resolveReasoningBudget("deep", 16384), 16384);
		assert.strictEqual(toDeepSeekReasoningEffort("off"), undefined);
		assert.strictEqual(toDeepSeekReasoningEffort("light"), "low");
		assert.strictEqual(toDeepSeekReasoningEffort("balanced"), "high");
		assert.strictEqual(toDeepSeekReasoningEffort("auto"), "high");
		assert.strictEqual(toDeepSeekReasoningEffort("deep"), "max");
	});
});
