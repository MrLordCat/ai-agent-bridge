import * as assert from "node:assert";
import { compactMessages } from "../context/message-compaction";
import type { OpenAIChatMessage } from "../types";

suite("message compaction", () => {
	test("summarizes old tool payloads without mutating source messages", () => {
		const largeTail = "x".repeat(2400);
		const messages: OpenAIChatMessage[] = [
			{ role: "system", content: "Stable system prompt" },
			{ role: "user", content: "old request" },
			{ role: "tool", name: "read_file", tool_call_id: "1", content: "secret payload".repeat(100) },
			{ role: "assistant", content: "old answer" },
			{ role: "user", content: largeTail },
			{ role: "assistant", content: largeTail },
		];

		const compacted = compactMessages(messages, {
			tokenBudget: 100,
			keepLastCount: 2,
			label: "Summary",
			estimateTokens: items => items.reduce((sum, item) => sum + (typeof item.content === "string" ? item.content.length : 0), 0),
		});

		assert.match(String(compacted[1].content), /tool_result read_file/);
		assert.ok(compacted.every(message => typeof message.content !== "string" || message.content.length <= 1203));
		assert.strictEqual(messages[4].content, largeTail);
		assert.strictEqual(messages[5].content, largeTail);
	});

	test("keeps code decisions and file paths in old assistant summaries", () => {
		const messages: OpenAIChatMessage[] = [
			{ role: "system", content: "Stable system prompt" },
			{ role: "user", content: "Please fix the provider" },
			{
				role: "assistant",
				content: [
					"Implemented the retry fix in src/transport/openai-http.ts.",
					"```ts",
					"export function retry() {",
					"  return true;",
					"}",
					"```",
					"Next: add regression tests.",
				].join("\n"),
			},
			{ role: "user", content: "new request" },
			{ role: "assistant", content: "new answer" },
		];

		// tokenBudget must be low enough that the messages exceed it,
		// otherwise compactMessages returns them as-is (no summary).
		const compacted = compactMessages(messages, {
			tokenBudget: 10,
			keepLastCount: 2,
			label: "Summary",
			estimateTokens: items => items.length * 100,
		});
		const summary = String(compacted[1].content);
		assert.match(summary, /src\/transport\/openai-http\.ts/);
		assert.match(summary, /add regression tests/i);
		assert.match(summary, /export function retry/);
	});

	test("drops complete turns instead of leaving orphaned tool results", () => {
		const messages: OpenAIChatMessage[] = [
			{ role: "system", content: "Stable system prompt" },
			{ role: "user", content: "old request" },
			{ role: "assistant", content: "old answer" },
			{ role: "user", content: "inspect file" },
			{
				role: "assistant",
				tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
			},
			{ role: "tool", tool_call_id: "call-1", name: "read_file", content: "file contents" },
			{ role: "assistant", content: "inspection complete" },
			{ role: "user", content: "new request" },
			{ role: "assistant", content: "new answer" },
		];

		const compacted = compactMessages(messages, {
			tokenBudget: 4,
			keepLastCount: 6,
			label: "Summary",
			estimateTokens: items => items.length,
		});

		assert.deepStrictEqual(
			compacted.filter(message => message.role !== "system").map(message => message.role),
			["user", "assistant"]
		);
		assert.ok(!compacted.some(message => message.role === "tool"));
	});

	test("balances original tasks with recent tool activity in long summaries", () => {
		const messages: OpenAIChatMessage[] = [{ role: "system", content: "Stable system prompt" }];
		for (let index = 0; index < 40; index += 1) {
			messages.push(
				{ role: "user", content: `task ${index}` },
				{
					role: "assistant",
					tool_calls: [{
						id: `call-${index}`,
						type: "function",
						function: { name: "read_file", arguments: JSON.stringify({ filePath: `src/file-${index}.ts` }) },
					}],
				},
				{
					role: "tool",
					name: "read_file",
					tool_call_id: `call-${index}`,
					content: JSON.stringify({ filePath: `src/file-${index}.ts`, status: "ok" }),
				}
			);
		}
		messages.push({ role: "user", content: "current task" }, { role: "assistant", content: "current answer" });

		// tokenBudget must be low enough that the messages exceed it,
		// otherwise compactMessages returns them as-is (no summary).
		const compacted = compactMessages(messages, {
			tokenBudget: 1000,
			keepLastCount: 2,
			label: "Summary",
			estimateTokens: items => items.length * 100,
		});
		const summary = String(compacted[1].content);
		assert.match(summary, /task 0/);
		assert.match(JSON.stringify(compacted), /src\\?\/file-39\.ts/);
		assert.ok(summary.split("\n").length <= 33);
	});

	test("deduplicates old compaction summaries on repeated compaction", () => {
		// Simulate the result of a first compaction pass: system prompt,
		// a summary (user role since summaries moved out of the system block),
		// and a few recent turns.
		const afterFirstCompact: OpenAIChatMessage[] = [
			{ role: "system", content: "Stable system prompt" },
			{ role: "user", content: "Conversation summary (auto-compact):\nBuilt fix in src/foo.ts" },
			{ role: "user", content: "latest question" },
			{ role: "assistant", content: "latest answer" },
		];

		// Extend with lots more messages so the next compaction is forced.
		const extended: OpenAIChatMessage[] = [...afterFirstCompact];
		for (let i = 0; i < 10; i++) {
			extended.push(
				{ role: "user", content: `long task description number ${i}`.repeat(5) },
				{ role: "assistant", content: `long answer number ${i}`.repeat(5) },
			);
		}
		extended.push(
			{ role: "user", content: "final question" },
			{ role: "assistant", content: "final answer" },
		);

		const compacted = compactMessages(extended, {
			tokenBudget: 100,
			keepLastCount: 2,
			label: "Conversation summary (auto-compact)",
			estimateTokens: items => items.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0),
		});

		// Count how many messages are compaction summaries (any role).
		const summaryMessages = compacted.filter(
			m => (m.role === "system" || m.role === "user")
				&& typeof m.content === "string"
				&& m.content.startsWith("Conversation summary"),
		);
		assert.strictEqual(
			summaryMessages.length,
			1,
			`expected exactly one summary message but got ${summaryMessages.length}: ${summaryMessages.map(m => (m.content as string).slice(0, 60)).join(" | ")}`,
		);

		// The first system message should be the original prompt, and the
		// summary must NOT be a system message (it would break the upstream
		// prompt cache for tools + messages when it changes).
		assert.strictEqual(compacted[0].role, "system");
		assert.strictEqual(compacted[0].content, "Stable system prompt");
                const summaryMessage = compacted.find(
                        m => typeof m.content === "string" && m.content.startsWith("Conversation summary"),
                );
                assert.strictEqual(summaryMessage?.role, "user", "summary must use the user role so system+tools stay cached");
        });

        test("fills a large target with recent history instead of only the minimum tail", () => {
                const messages: OpenAIChatMessage[] = [{ role: "system", content: "Stable system prompt" }];
                for (let index = 0; index < 120; index += 1) {
                        messages.push(
                                { role: "user", content: `request-${index}: ${"u".repeat(100)}` },
                                { role: "assistant", content: `answer-${index}: ${"a".repeat(100)}` },
                        );
                }
                const estimateTokens = (items: OpenAIChatMessage[]): number => items.reduce(
                        (sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0),
                        0
                );
                const tokenBudget = 14_000;
                const compacted = compactMessages(messages, {
                        tokenBudget,
                        keepLastCount: 12,
                        label: "Conversation summary (auto-compact)",
                        estimateTokens,
                });

		const used = estimateTokens(compacted);
		assert.ok(used <= tokenBudget, `expected ${used} to fit within ${tokenBudget}`);
		assert.ok(used >= tokenBudget * 0.8, `expected compaction to fill the target, got ${used}`);
		assert.ok(
			compacted.filter(message => message.role !== "system").length > 60,
			"expected substantially more than the fixed 12-message minimum"
		);
	});
});
