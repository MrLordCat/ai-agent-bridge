import * as assert from "node:assert";

import {
	buildDeepSeekCompactionRequest,
	buildDeepSeekCompactionTranscript,
	buildDeepSeekCompactionTranscriptDetailed,
	parseDeepSeekCompactionResponse,
	requestDeepSeekCompactionSummary,
} from "../context/deepseek-compaction-summary";
import type { OpenAIChatMessage } from "../types";

suite("DeepSeek compaction summary", () => {
	test("builds a tool-free, thinking-disabled summary request", () => {
		const request = buildDeepSeekCompactionRequest({
			previousSummary: "Decision: keep src/context/message-compaction.ts deterministic.",
			droppedMessages: [{ role: "user", content: "Implement the semantic summarizer." }],
		});
		assert.strictEqual(request.model, "deepseek-v4-flash");
		assert.strictEqual(request.stream, false);
		assert.strictEqual(request.temperature, 0);
		assert.deepStrictEqual(request.thinking, { type: "disabled" });
		assert.ok(!("tools" in request));
		const prompt = JSON.stringify(request.messages);
		assert.match(prompt, /a request, plan, tool call, or file read is not completed work/);
		assert.match(prompt, /Completed contains outcomes and durable state changes/);
		assert.match(prompt, /Verification contains only concrete checks and observed results/);
		assert.match(prompt, /Never generalize a partial or local check into whole-chain verification/);
		assert.match(prompt, /Failed approaches must name rejected or corrected approaches/);
	});

	test("omits memory overlays, ephemeral guards, reasoning, and volatile host blocks", () => {
		const messages: OpenAIChatMessage[] = [
			{
				role: "user",
				content: "Ship compaction quality.\n<attachments>huge generated attachment</attachments>\nKeep src/context/message-compaction.ts. api_key=sk-sensitive-example-123456789",
			},
			{ role: "user", content: "PRIVATE MEMORY", providerOverlay: "shared-memory" },
			{ role: "user", content: "LOOP GUARD", ephemeral: true },
			{ role: "assistant", content: "Implemented the planner.", reasoning_content: "PRIVATE REASONING" },
		];
		const transcript = buildDeepSeekCompactionTranscript({ droppedMessages: messages });
		assert.match(transcript, /Ship compaction quality/);
		assert.match(transcript, /src\/context\/message-compaction\.ts/);
		assert.match(transcript, /volatile VS Code host metadata omitted/);
		assert.doesNotMatch(transcript, /huge generated attachment|PRIVATE MEMORY|LOOP GUARD|PRIVATE REASONING|sk-sensitive/);
		assert.match(transcript, /api_key=\[redacted\]/);
	});

	test("keeps objectives, middle milestones, coverage, and recent work under input pressure", () => {
		const messages: OpenAIChatMessage[] = [];
		for (let index = 0; index < 36; index += 1) {
			messages.push(
				{
					role: "user",
					content: index === 0
						? "PRIMARY OBJECTIVE: improve compaction without losing engineering state."
						: `routine request ${index} ${"u".repeat(420)}`,
				},
				{
					role: "assistant",
					content: index === 17
						? "DECISION MIDDLE: preserve complete turns. VERIFIED MIDDLE: regression test passed in src/context/message-compaction.ts."
						: index === 11
							? "РУССКИЙ СИГНАЛ: исправлена потеря решений, проверены тесты компакции."
							: index === 23
								? "FAILED APPROACH MIDDLE: corrected earlier wrong hypothesis; it did not solve the output corruption."
							: `routine response ${index} ${"a".repeat(420)}`,
				},
			);
		}
		messages.push({ role: "user", content: "LATEST WORK: finish the quality polish and run all tests." });

		const detailed = buildDeepSeekCompactionTranscriptDetailed({
			droppedMessages: messages,
			maxInputChars: 8_000,
		});
		const transcript = detailed.content;

		assert.ok(transcript.length <= 8_000);
		assert.match(transcript, /PRIMARY OBJECTIVE/);
		assert.match(transcript, /DECISION MIDDLE/);
		assert.match(transcript, /VERIFIED MIDDLE/);
		assert.match(transcript, /РУССКИЙ СИГНАЛ/);
		assert.match(transcript, /FAILED APPROACH MIDDLE/);
		assert.match(transcript, /LATEST WORK/);
		assert.match(transcript, /selected=\d+, omitted=\d+/);
		assert.strictEqual(detailed.diagnostics.totalTurns, 37);
		assert.ok(detailed.diagnostics.selectedTurns < detailed.diagnostics.totalTurns);
		assert.ok(detailed.diagnostics.omittedTurns > 0);
		assert.ok(detailed.diagnostics.selectedReasonCounts.objective > 0);
		assert.ok(detailed.diagnostics.selectedReasonCounts.recent > 0);
		assert.ok(detailed.diagnostics.selectedReasonCounts.failure > 0);
		assert.ok(detailed.diagnostics.rejectedApproachTurns > 0);
		assert.ok(detailed.diagnostics.selectedRejectedApproachTurns > 0);
	});

	test("pairs tool calls with results and removes repeated low-signal chatter", () => {
		const repeated = "Checking the same routine status without any change.";
		const messages: OpenAIChatMessage[] = [
			{ role: "user", content: "Inspect the compaction implementation." },
			{
				role: "assistant",
				content: repeated,
				tool_calls: [{
					id: "call-1",
					type: "function",
					function: {
						name: "read_file",
						arguments: JSON.stringify({ filePath: "src/context/message-compaction.ts", startLine: 1, endLine: 200 }),
					},
				}],
			},
			{ role: "tool", name: "read_file", tool_call_id: "call-1", content: "export function compactMessages() {}" },
			{ role: "assistant", content: repeated },
			{ role: "assistant", content: repeated },
		];

		const transcript = buildDeepSeekCompactionTranscript({ droppedMessages: messages });
		assert.match(transcript, /read_file\(filePath="src\/context\/message-compaction\.ts"/);
		assert.match(transcript, /result read_file/);
		assert.strictEqual(transcript.split(repeated).length - 1, 1);
	});

	test("preserves every structured previous-summary section when its budget is tight", () => {
		const previousSummary = [
			"Conversation summary (auto-compact):",
			"## Objective\nOBJECTIVE FACT " + "o".repeat(1_000),
			"## Completed\nCOMPLETED FACT " + "c".repeat(1_000),
			"## Decisions\nDECISION FACT " + "d".repeat(1_000),
			"## Files and symbols\nFILES FACT src/context/deepseek-compaction-summary.ts " + "f".repeat(1_000),
			"## Verification\nVERIFICATION FACT 354 passing " + "v".repeat(1_000),
			"## Failed approaches\nFAILED FACT " + "x".repeat(1_000),
			"## Constraints\nCONSTRAINT FACT paid opt-in " + "n".repeat(1_000),
			"## Open work\nOPEN FACT finish polish " + "w".repeat(1_000),
		].join("\n");
		const transcript = buildDeepSeekCompactionTranscript({
			previousSummary,
			droppedMessages: [{ role: "user", content: "new evidence" }],
			maxInputChars: 8_000,
		});

		for (const fact of ["OBJECTIVE FACT", "COMPLETED FACT", "DECISION FACT", "FILES FACT", "VERIFICATION FACT", "FAILED FACT", "CONSTRAINT FACT", "OPEN FACT"]) {
			assert.match(transcript, new RegExp(fact));
		}
	});

	test("parses usage and rejects truncated summaries", () => {
		const parsed = parseDeepSeekCompactionResponse({
			choices: [{ finish_reason: "stop", message: { content: "## Objective\nKeep context.\n## Completed\nPlanner done.\n## Decisions\nUse fallback.\n## Files and symbols\nsrc/a.ts\n## Verification\nTests pass.\n## Failed approaches\n(none)\n## Constraints\nPaid opt-in.\n## Open work\n(none)" } }],
			usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
		});
		assert.strictEqual(parsed.usage?.totalTokens, 150);
		assert.deepStrictEqual(parsed.summaryDiagnostics?.emptySections, ["Failed approaches", "Open work"]);
		assert.throws(() => parseDeepSeekCompactionResponse({
			choices: [{ finish_reason: "length", message: { content: "partial" } }],
		}), /output limit/);
		assert.throws(() => parseDeepSeekCompactionResponse({
			choices: [{ finish_reason: "stop", message: { content: "## Completed\nDone.\n## Objective\nGoal.\n## Decisions\nD.\n## Files and symbols\nF.\n## Verification\nV.\n## Failed approaches\nN.\n## Constraints\nC.\n## Open work\nO." } }],
		}), /out of order/);
	});

	test("requests the DeepSeek endpoint and returns the semantic summary", async () => {
		let capturedUrl = "";
		let capturedBody: Record<string, unknown> | undefined;
		const result = await requestDeepSeekCompactionSummary({
			apiKey: "test-key",
			userAgent: "test-agent",
			droppedMessages: [{ role: "user", content: "Preserve the current task." }],
			fetchImplementation: async (input, init) => {
				capturedUrl = String(input);
				capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(JSON.stringify({
					choices: [{ finish_reason: "stop", message: { content: "## Objective\nPreserve context.\n## Completed\n(none)\n## Decisions\nUse DeepSeek Flash.\n## Files and symbols\n(none)\n## Verification\n(none)\n## Failed approaches\n(none)\n## Constraints\nPaid opt-in.\n## Open work\nImplement it." } }],
					usage: { prompt_tokens: 42, completion_tokens: 21, total_tokens: 63 },
				}), { status: 200 });
			},
		});
		assert.strictEqual(capturedUrl, "https://api.deepseek.com/chat/completions");
		assert.strictEqual(capturedBody?.model, "deepseek-v4-flash");
		assert.match(result.content, /Use DeepSeek Flash/);
		assert.strictEqual(result.usage?.totalTokens, 63);
		assert.ok(result.inputChars > 0);
		assert.strictEqual(result.inputDiagnostics?.totalTurns, 1);
		assert.strictEqual(result.inputDiagnostics?.selectedTurns, 1);
		assert.strictEqual(result.inputDiagnostics?.omittedTurns, 0);
	});
});