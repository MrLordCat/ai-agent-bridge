import * as assert from "assert";

import {
	detectRepeatedToolCallLoop,
	injectToolCallOnlyNudge,
	injectToolLoopGuard,
	RECENT_TURN_WINDOW,
	recordRecentTurnShape,
	shouldInjectToolCallOnlyNudge,
	toolCallOnlyDensity,
	parseToolArguments,
	ToolCallReliabilityGuard,
	validateToolArguments,
} from "../tools/tool-call-reliability";
import type { RecentTurnShape } from "../tools/tool-call-reliability";
import type { OpenAIFunctionToolDef } from "../types";

const tool: OpenAIFunctionToolDef = {
	type: "function",
	function: {
		name: "read_file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
			additionalProperties: false,
		},
	},
};

const terminalTool: OpenAIFunctionToolDef = {
	type: "function",
	function: {
		name: "run_in_terminal",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string" },
				mode: { enum: ["sync", "async"] },
				timeout: { type: "number", minimum: 0 },
			},
			required: ["command", "mode"],
			additionalProperties: false,
		},
	},
};

suite("tool call reliability", () => {
	test("repairs fenced objects and trailing commas conservatively", () => {
		const parsed = parseToolArguments("```json\n{\"path\":\"README.md\",}\n```", true);
		assert.deepStrictEqual(parsed, { ok: true, value: { path: "README.md" }, repaired: true });
	});

	test("does not repair incomplete JSON before the final chunk", () => {
		assert.deepStrictEqual(parseToolArguments('{"path":"README', false), { ok: false, pending: true });
	});

	test("validates required and additional properties", () => {
		assert.deepStrictEqual(validateToolArguments({ path: "README.md" }, tool.function.parameters), []);
		assert.ok(validateToolArguments({ extra: true }, tool.function.parameters).some(issue => issue.includes("required")));
		assert.ok(validateToolArguments({ path: "README.md", extra: true }, tool.function.parameters).some(issue => issue.includes("not allowed")));
	});

	test("validates common JSON Schema constraints", () => {
		const schema = {
			type: "object",
			properties: {
				mode: { const: "safe" },
				count: { type: "integer", minimum: 1, maximum: 3 },
				name: { type: "string", minLength: 3, pattern: "^[a-z]+$" },
				items: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
			},
			required: ["mode", "count", "name", "items"],
		};
		assert.deepStrictEqual(validateToolArguments({
			mode: "safe",
			count: 2,
			name: "valid",
			items: ["a", "b"],
		}, schema), []);
		const issues = validateToolArguments({
			mode: "unsafe",
			count: 4,
			name: "X",
			items: ["a", "a"],
		}, schema);
		assert.ok(issues.some(issue => issue.includes("constant")));
		assert.ok(issues.some(issue => issue.includes("maximum")));
		assert.ok(issues.some(issue => issue.includes("minimum length")));
		assert.ok(issues.some(issue => issue.includes("unique")));
	});

	test("repairs tool-name casing and records metrics", () => {
		const guard = new ToolCallReliabilityGuard();
		guard.configure([tool], { repairEnabled: true, validateSchema: true });
		const result = guard.evaluate("READ_FILE", '{"path":"README.md"}', true);
		assert.ok(result.ok);
		assert.strictEqual(result.ok && result.name, "read_file");
		assert.deepStrictEqual(guard.consumeMetrics(), {
			accepted: 1,
			repaired: 1,
			rejected: 0,
			unknownTool: 0,
			schemaRejected: 0,
			loopDetected: false,
		});
	});

	test("repairs second-like sync terminal timeouts before schema validation", () => {
		const guard = new ToolCallReliabilityGuard();
		guard.configure([terminalTool], { repairEnabled: true, validateSchema: true });
		const result = guard.evaluate("run_in_terminal", '{"command":"npm test","mode":"sync","timeout":300}', true);
		assert.ok(result.ok);
		assert.deepStrictEqual(result.ok && result.arguments, {
			command: "npm test",
			mode: "sync",
			timeout: 300_000,
		});
		assert.strictEqual(result.ok && result.repaired, true);
		assert.strictEqual(guard.consumeMetrics().repaired, 1);
	});

	test("auto-fills a missing terminal mode instead of rejecting", () => {
		const guard = new ToolCallReliabilityGuard();
		guard.configure([terminalTool], { repairEnabled: true, validateSchema: true });
		const result = guard.evaluate("run_in_terminal", '{"command":"npm test"}', true);
		assert.ok(result.ok);
		assert.deepStrictEqual(result.ok && result.arguments, {
			command: "npm test",
			mode: "sync",
		});
		assert.strictEqual(result.ok && result.repaired, true);
		assert.strictEqual(guard.consumeMetrics().repaired, 1);
	});

	test("leaves millisecond, zero, and async terminal timeouts unchanged", () => {
		const guard = new ToolCallReliabilityGuard();
		guard.configure([terminalTool], { repairEnabled: true, validateSchema: true });
		const millisecond = guard.evaluate("run_in_terminal", '{"command":"npm test","mode":"sync","timeout":300000}', true);
		const shortMillisecond = guard.evaluate("run_in_terminal", '{"command":"quick probe","mode":"sync","timeout":3600}', true);
		const noLimit = guard.evaluate("run_in_terminal", '{"command":"npm test","mode":"sync","timeout":0}', true);
		const async = guard.evaluate("run_in_terminal", '{"command":"npm run dev","mode":"async","timeout":300}', true);
		assert.ok(millisecond.ok && millisecond.arguments.timeout === 300_000 && !millisecond.repaired);
		assert.ok(shortMillisecond.ok && shortMillisecond.arguments.timeout === 3_600 && !shortMillisecond.repaired);
		assert.ok(noLimit.ok && noLimit.arguments.timeout === 0 && !noLimit.repaired);
		assert.ok(async.ok && async.arguments.timeout === 300 && !async.repaired);
	});

	test("rejects unknown tools and invalid schemas", () => {
		const guard = new ToolCallReliabilityGuard();
		guard.configure([tool], { repairEnabled: true, validateSchema: true });
		const unknown = guard.evaluate("delete_everything", "{}", true);
		const invalid = guard.evaluate("read_file", "{}", true);
		assert.ok(!unknown.ok && !unknown.pending && unknown.kind === "unknown_tool");
		assert.ok(!invalid.ok && !invalid.pending && invalid.kind === "schema");
	});

	test("rejects calls when the request advertised no tools", () => {
		const guard = new ToolCallReliabilityGuard();
		guard.configure([], { repairEnabled: true, validateSchema: true });
		const result = guard.evaluate("read_file", "{}", true);
		assert.ok(!result.ok && !result.pending && result.kind === "unknown_tool");
	});

	test("detects only consecutive identical tool-call loops", () => {
		const calls = Array.from({ length: 3 }, (_, index) => ({
			role: "assistant" as const,
			content: "",
			tool_calls: [{
				id: `call-${index}`,
				type: "function" as const,
				function: { name: "read_file", arguments: '{"path":"README.md"}' },
			}],
		}));
		const detected = detectRepeatedToolCallLoop(calls, 3);
		assert.strictEqual(detected?.toolName, "read_file");
		assert.strictEqual(detected?.repetitions, 3);
		const guarded = injectToolLoopGuard(calls, detected);
		assert.strictEqual(guarded.at(-1)?.role, "user");
		assert.strictEqual(guarded.at(-1)?.ephemeral, true);
		assert.ok(String(guarded.at(-1)?.content).includes("Do not repeat"));
	});

	test("records turn shapes with a rolling window", () => {
		const shapes: RecentTurnShape[] = [
			"text", "toolOnly", "text", "toolOnly", "toolOnly",
			"toolOnly", "toolOnly", "toolOnly", "toolOnly", "text",
		];
		let queue: RecentTurnShape[] = [];
		for (const shape of shapes) {
			queue = recordRecentTurnShape(queue, shape);
		}
		assert.strictEqual(queue.length, RECENT_TURN_WINDOW);
		assert.strictEqual(toolCallOnlyDensity(queue), 6);
	});

	test("nudges only when tool-call-only turns dominate a full window", () => {
		// 5 of last 8 -> nudge with the default-derived threshold 4.
		const dominant: RecentTurnShape[] = [
			"toolOnly", "toolOnly", "text", "toolOnly", "toolOnly",
			"toolOnly", "text", "toolOnly",
		];
		assert.strictEqual(toolCallOnlyDensity(dominant), 6);
		assert.ok(shouldInjectToolCallOnlyNudge(dominant, 4));
		// 3 of last 8 -> no nudge.
		const sparse: RecentTurnShape[] = [
			"text", "toolOnly", "text", "text", "toolOnly",
			"text", "toolOnly", "text",
		];
		assert.ok(!shouldInjectToolCallOnlyNudge(sparse, 4));
		// Partial window (< 8 turns) never nudges.
		const partial = sparse.slice(0, 5);
		assert.ok(!shouldInjectToolCallOnlyNudge(partial, 4));
	});

	test("injects the pacing nudge only when a message is provided", () => {
		const calls = [
			{ role: "assistant" as const, content: "ok", tool_calls: [] as never[] },
		];
		const without = injectToolCallOnlyNudge(calls, undefined);
		assert.strictEqual(without.length, 1);
		assert.notStrictEqual(without[0], calls[0]);
		const withMessage = injectToolCallOnlyNudge(calls, "Pause and summarize.");
		assert.strictEqual(withMessage.length, 2);
		assert.strictEqual(withMessage.at(-1)?.role, "user");
		assert.strictEqual(withMessage.at(-1)?.ephemeral, true);
		assert.strictEqual(withMessage.at(-1)?.content, "Pause and summarize.");
	});
});
