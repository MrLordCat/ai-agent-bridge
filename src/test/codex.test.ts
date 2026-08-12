import * as assert from "assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import type { ClaudeChatModelProvider } from "../claude/claude-provider";
import { CodexAppServerClient, JsonLineBuffer, type CodexServerNotification } from "../codex/app-server-client";
import { CompositeChatModelProvider } from "../composite-provider";
import {
	assertCodexThreadPersistence,
	calculateCodexCompactionBudget,
	canResumeCodexToolTurn,
	CodexChatModelProvider,
	createCodexRuntimeFingerprints,
	createCodexVsCodeOnlyPolicy,
	diffCodexThreadUsage,
	findLatestCodexUserTail,
	intersectCodexThreadTools,
	isCompleteImageDataUri,
	findTempImageWithPrefix,
	mapCodexTokenUsageMetrics,
	mergeCodexTurnSteps,
	normalizeCodexRuntimeCwd,
	resolveCodexSessionPersistence,
	shouldRecoverCodexFailedToolTurn,
	shouldRecoverCodexToolTurnException,
} from "../codex/codex-provider";
import {
	buildCodexDynamicTools,
	CODEX_DEFERRED_TOOL_NAMESPACE,
	CODEX_NATIVE_TOOL_NAMESPACE,
} from "../codex/dynamic-tools";
import {
	collectPromptImagePaths,
	createCodexConversationAnchor,
	convertCodexToolResult,
	extractImageDataUrisFromText,
	extractImagePathsFromText,
	findCodexConversationTail,
	findCodexToolContinuation,
	findCodexToolContinuations,
	matchCodexConversationTail,
	MAX_PROMPT_IMAGES,
	resolveLocalImagePath,
	serializeCodexConversation,
} from "../codex/message-adapter";
import {
	createCodexReasoningConfigurationSchema,
	formatCodexRateLimit,
	mapCodexModelInformation,
	resolveCodexReasoningEffort,
} from "../codex/model-adapter";
import type { CodexModel } from "../codex/protocol";
import { parseCodexRolloutMetrics } from "../codex/rollout-metrics";
import {
	CodexInternalToolBlockedError,
	CodexStaleTurnError,
	CodexTurnBridge,
	isCodexInternalActionItem,
} from "../codex/turn-bridge";

const model: CodexModel = {
	id: "gpt-test",
	model: "gpt-test",
	displayName: "GPT Test",
	description: "Test Codex model",
	hidden: false,
	supportedReasoningEfforts: [
		{ reasoningEffort: "low", description: "Fast" },
		{ reasoningEffort: "high", description: "Deep" },
	],
	defaultReasoningEffort: "low",
	inputModalities: ["text", "image"],
	isDefault: true,
};

suite("Codex subscription provider", () => {
	test("uses the real Codex window without the former 0.45 compaction multiplier", () => {
		const maximum = calculateCodexCompactionBudget({
			modelContextWindow: 258_400,
			workingContextTarget: 500_000,
			maxOutputTokens: 32_768,
			toolSchemaTokens: 20_000,
			developerInstructionTokens: 1_000,
		});
		assert.deepStrictEqual(maximum, {
			modelContextWindow: 258_400,
			workingContextTarget: 258_400,
			messageTokenBudget: 196_908,
			outputReserveTokens: 32_300,
			safetyReserveTokens: 8_192,
		});
		assert.strictEqual(calculateCodexCompactionBudget({
			modelContextWindow: 258_400,
			workingContextTarget: 131_072,
			maxOutputTokens: 32_768,
			toolSchemaTokens: 20_000,
			developerInstructionTokens: 1_000,
		}).messageTokenBudget, 69_580);
	});

	test("buffers split JSONL process chunks", () => {
		const buffer = new JsonLineBuffer();
		assert.deepStrictEqual(buffer.push('{"id":1'), []);
		assert.deepStrictEqual(buffer.push('}\r\n{"method":"ready"}\npartial'), [
			'{"id":1}',
			'{"method":"ready"}',
		]);
		assert.deepStrictEqual(buffer.push(" line\n"), ["partial line"]);
	});

	test("drops an incomplete JSONL fragment when the app-server generation changes", () => {
		const buffer = new JsonLineBuffer();
		assert.deepStrictEqual(buffer.push('{"old":'), []);
		buffer.reset();
		assert.deepStrictEqual(buffer.push('{"fresh":true}\n'), ['{"fresh":true}']);
	});

	test("invalidates process generation as soon as the app-server stops", () => {
		const client = new CodexAppServerClient("test");
		const internals = client as unknown as {
			process: { killed: boolean; kill: () => boolean };
			stopProcess: (error: Error) => void;
		};
		internals.process = {
			killed: false,
			kill: () => true,
		};
		const generation = client.generation;
		internals.stopProcess(new Error("test stop"));
		assert.strictEqual(client.generation, generation + 1);
		client.dispose();
	});

	test("advertises model reasoning options and context", () => {
		const info = mapCodexModelInformation(model, 258_400, 32_768) as vscode.LanguageModelChatInformation & Record<string, unknown>;
		assert.strictEqual(info.id, "codex::gpt-test");
		assert.strictEqual(info.name, "GPT Test (Codex)");
		assert.strictEqual(info.maxInputTokens, 225_632);
		assert.strictEqual(info.maxOutputTokens, 32_768);
		assert.strictEqual(info.capabilities.imageInput, true);
		assert.strictEqual(info.capabilities.toolCalling, true);

		const schema = createCodexReasoningConfigurationSchema(model);
		assert.deepStrictEqual(schema.properties.reasoningEffort.enum, ["low", "high"]);
		assert.strictEqual(schema.properties.reasoningEffort.default, "high");
	});

	test("uses native effort when supported and falls back to catalog default", () => {
		assert.strictEqual(resolveCodexReasoningEffort("auto", "high", model), "high");
		assert.strictEqual(resolveCodexReasoningEffort("high", undefined, model), "high");
		assert.strictEqual(resolveCodexReasoningEffort("auto", undefined, model), "high");
		assert.strictEqual(resolveCodexReasoningEffort("ultra", undefined, model), "high");
	});

	test("forces Codex actions through the native VS Code tool boundary", () => {
		const policy = createCodexVsCodeOnlyPolicy();
		assert.strictEqual(policy.approvalPolicy, "on-request");
		assert.strictEqual(policy.sandbox, "read-only");
		assert.deepStrictEqual(policy.environments, []);
		assert.strictEqual(policy.config.web_search, "disabled");
		assert.deepStrictEqual(policy.config.mcp_servers, {});
		assert.strictEqual(policy.config.tools.web_search, false);
		for (const feature of [
			"apps",
			"browser_use",
			"computer_use",
			"hooks",
			"image_generation",
			"multi_agent",
			"plugins",
			"shell_tool",
			"unified_exec",
		]) {
			assert.strictEqual(policy.config.features[feature], false, `${feature} must be disabled`);
		}
	});

	test("counts completed Codex thread usage by cumulative delta", () => {
		const first = {
			total: { totalTokens: 1_300, inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 300, reasoningOutputTokens: 100 },
			last: { totalTokens: 1_300, inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 300, reasoningOutputTokens: 100 },
			modelContextWindow: 258_400,
		};
		const next = {
			total: { totalTokens: 2_000, inputTokens: 1_550, cachedInputTokens: 1_200, outputTokens: 450, reasoningOutputTokens: 150 },
			last: { totalTokens: 700, inputTokens: 550, cachedInputTokens: 400, outputTokens: 150, reasoningOutputTokens: 50 },
			modelContextWindow: 258_400,
		};
		assert.deepStrictEqual(diffCodexThreadUsage(first), {
			inputTokens: 1_000,
			outputTokens: 300,
			cachedInputTokens: 800,
			reasoningOutputTokens: 100,
		});
		assert.deepStrictEqual(diffCodexThreadUsage(next, first), {
			inputTokens: 550,
			outputTokens: 150,
			cachedInputTokens: 400,
			reasoningOutputTokens: 50,
		});
		assert.strictEqual(diffCodexThreadUsage(next, next), undefined);
	});

	test("extracts private-free per-segment metrics from a Codex rollout", () => {
		const line = (timestamp: string, type: string, payload: Record<string, unknown>): string =>
			JSON.stringify({ timestamp, type, payload });
		const rollout = [
			line("2026-07-28T14:00:00.000Z", "event_msg", {
				type: "task_started",
				turn_id: "turn-target",
			}),
			line("2026-07-28T14:00:01.000Z", "event_msg", {
				type: "agent_reasoning",
				text: "private reasoning that must not be retained",
			}),
			line("2026-07-28T14:00:02.000Z", "response_item", {
				type: "function_call",
				call_id: "call-1",
				name: "read_file",
				arguments: "private arguments",
			}),
			line("2026-07-28T14:00:05.000Z", "response_item", {
				type: "function_call_output",
				call_id: "call-1",
				output: "private tool output",
			}),
			line("2026-07-28T14:00:06.000Z", "event_msg", {
				type: "token_count",
				info: {
					last_token_usage: {
						input_tokens: 1000,
						cached_input_tokens: 900,
						output_tokens: 100,
						reasoning_output_tokens: 40,
						total_tokens: 1100,
					},
				},
			}),
			line("2026-07-28T14:00:07.000Z", "event_msg", {
				type: "agent_message",
				message: "private answer",
			}),
			line("2026-07-28T14:00:08.000Z", "event_msg", {
				type: "token_count",
				info: {
					last_token_usage: {
						input_tokens: 1200,
						cached_input_tokens: 1140,
						output_tokens: 80,
						reasoning_output_tokens: 10,
						total_tokens: 1280,
					},
				},
			}),
			line("2026-07-28T14:00:09.000Z", "event_msg", {
				type: "task_complete",
				turn_id: "turn-target",
			}),
			"{partially flushed",
		].join("\n");

		const metrics = parseCodexRolloutMetrics(rollout, "turn-target");
		assert.ok(metrics);
		assert.strictEqual(metrics.completed, true);
		assert.strictEqual(metrics.durationMs, 9000);
		assert.strictEqual(metrics.firstModelEventLatencyMs, 1000);
		assert.strictEqual(metrics.firstVisibleMessageLatencyMs, 7000);
		assert.strictEqual(metrics.modelSegments, 2);
		assert.strictEqual(metrics.inputTokens, 2200);
		assert.strictEqual(metrics.cachedInputTokens, 2040);
		assert.strictEqual(metrics.outputTokens, 180);
		assert.strictEqual(metrics.reasoningOutputTokens, 50);
		assert.strictEqual(metrics.cacheHitPercent, 92.7);
		assert.strictEqual(metrics.toolCalls, 1);
		assert.strictEqual(metrics.toolOutputs, 1);
		assert.deepStrictEqual(metrics.toolNames, { read_file: 1 });
		assert.deepStrictEqual(metrics.toolDuration, {
			count: 1,
			totalMs: 3000,
			averageMs: 3000,
			maximumMs: 3000,
			p95Ms: 3000,
		});
		assert.strictEqual(metrics.steps.filter(step => step.kind === "model").length, 2);
		const rolloutToolStep = metrics.steps.find(step => step.kind === "tool");
		assert.strictEqual(rolloutToolStep?.label, "read_file");
		assert.strictEqual(rolloutToolStep?.status, "completed");
		assert.strictEqual(rolloutToolStep?.toolCategory, "vscode");
		assert.doesNotMatch(JSON.stringify(metrics), /private/);
	});

	test("keeps only the latest user turn when resuming an interrupted Codex thread", () => {
		const messages = [
			vscode.LanguageModelChatMessage.User("old request"),
			vscode.LanguageModelChatMessage.Assistant("old answer"),
			vscode.LanguageModelChatMessage.User("stop the subagent and inspect the cache"),
		];
		const tail = findLatestCodexUserTail(messages);
		assert.strictEqual(tail.length, 1);
		assert.strictEqual(tail[0], messages[2]);
	});

	test("merges rollout catalog steps with live delegated tool terminal state", () => {
		const steps = mergeCodexTurnSteps(
			[{
				id: "model-1",
				index: 1,
				kind: "model" as const,
				label: "Model segment 1",
				status: "completed" as const,
				startedAt: "2026-07-29T07:00:00.000Z",
			}],
			[{
				id: "tool-call-subagent",
				index: 1,
				kind: "tool" as const,
				label: "runSubagent",
				status: "timed_out" as const,
				toolCategory: "vscode" as const,
				startedAt: "2026-07-29T07:00:01.000Z",
			}, {
				id: "tool-search-1",
				index: 2,
				kind: "tool" as const,
				label: "Tool catalog search",
				status: "completed" as const,
				toolCategory: "catalog" as const,
				startedAt: "2026-07-29T07:00:02.000Z",
			}]
		);
		assert.deepStrictEqual(steps.map(step => [step.index, step.label, step.status]), [
			[1, "Model segment 1", "completed"],
			[2, "runSubagent", "timed_out"],
			[3, "Tool catalog search", "completed"],
		]);
	});

	test("serializes VS Code text and tool history as conversation data", () => {
		const messages = [
			vscode.LanguageModelChatMessage.User("Inspect the repository"),
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelToolCallPart("call-1", "read_file", { path: "README.md" }),
			]),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart("call-1", [new vscode.LanguageModelTextPart("# Project")]),
			]),
		];
		const input = serializeCodexConversation(messages);
		assert.ok(input.text.includes("Inspect the repository"));
		assert.ok(input.text.includes("VS Code tool call: read_file"));
		assert.ok(input.text.includes("# Project"));
		assert.deepStrictEqual(input.images, []);
		assert.strictEqual(input.omittedMessageCount, 0);
		assert.strictEqual(input.truncatedMessageCount, 0);
	});

	test("bounds oversized histories while preserving the first and latest requests", () => {
		const messages: vscode.LanguageModelChatRequestMessage[] = [
			vscode.LanguageModelChatMessage.User("FIRST-MESSAGE-MARKER"),
		];
		for (let index = 0; index < 8; index++) {
			messages.push(vscode.LanguageModelChatMessage.Assistant(
				`OLD-HISTORY-${index}\n${"x".repeat(40_000)}`
			));
		}
		messages.push(vscode.LanguageModelChatMessage.User(
			`LATEST-REQUEST-MARKER\n${"z".repeat(20_000)}\nLATEST-REQUEST-TAIL`
		));

		const input = serializeCodexConversation(messages, { maxTextChars: 12_000 });
		assert.ok(input.text.length <= 12_000, `serialized input was ${input.text.length} characters`);
		assert.ok(input.text.includes("FIRST-MESSAGE-MARKER"));
		assert.ok(input.text.includes("LATEST-REQUEST-MARKER"));
		assert.ok(input.text.includes("LATEST-REQUEST-TAIL"));
		assert.ok(input.text.includes("Earlier VS Code conversation messages were omitted"));
		assert.strictEqual(input.originalMessageCount, messages.length);
		assert.strictEqual(input.includedMessageCount, 2);
		assert.strictEqual(input.omittedMessageCount, messages.length - 2);
		assert.strictEqual(input.truncatedMessageCount, 1);
		assert.ok(input.originalTextChars > 300_000);
	});

	test("does not resend images from conversation messages omitted by the text budget", () => {
		const messages = [
			vscode.LanguageModelChatMessage.User("first"),
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelTextPart("old\n" + "x".repeat(20_000)),
				vscode.LanguageModelDataPart.image(new Uint8Array([1, 2, 3]), "image/png") as unknown as vscode.LanguageModelTextPart,
			]),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelTextPart("latest"),
				vscode.LanguageModelDataPart.image(new Uint8Array([4, 5, 6]), "image/png") as unknown as vscode.LanguageModelTextPart,
			]),
		];
		const input = serializeCodexConversation(messages, { maxTextChars: 4_096 });
		assert.strictEqual(input.omittedMessageCount, 1);
		assert.strictEqual(input.originalImageCount, 2);
		assert.strictEqual(input.omittedImageCount, 1);
		assert.strictEqual(input.images.length, 1);
		assert.ok(input.images[0].endsWith("BAUG"));
	});

	test("truncates historical tool results before dropping conversation messages", () => {
		const messages = [
			vscode.LanguageModelChatMessage.User("FIRST"),
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelToolCallPart("large-call", "read_file", { path: "large.log" }),
			]),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart("large-call", [
					new vscode.LanguageModelTextPart(`HEAD\n${"x".repeat(50_000)}\nTAIL`),
				]),
			]),
			vscode.LanguageModelChatMessage.User("LATEST"),
		];
		const input = serializeCodexConversation(messages, {
			maxTextChars: 20_000,
			maxToolResultChars: 2_048,
		});
		assert.strictEqual(input.includedMessageCount, messages.length);
		assert.strictEqual(input.omittedMessageCount, 0);
		assert.strictEqual(input.truncatedToolResultCount, 1);
		assert.ok(input.text.includes("tool result characters omitted"));
		assert.ok(input.text.includes("HEAD"));
		assert.ok(input.text.includes("TAIL"));
		assert.ok(input.text.includes("LATEST"));
	});

	test("selects only the native tool-result tail when resuming a Codex thread", () => {
		const messages = [
			vscode.LanguageModelChatMessage.User(`large history\n${"x".repeat(100_000)}`),
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelToolCallPart("pending-call", "read_file", { path: "README.md" }),
			]),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart("pending-call", [new vscode.LanguageModelTextPart("result")]),
			]),
		];
		const continuation = findCodexToolContinuation(messages, new Set(["pending-call"]));
		assert.ok(continuation);
		assert.strictEqual(continuation.callId, "pending-call");
		assert.strictEqual(continuation.messages.length, 1);
		const input = serializeCodexConversation(continuation.messages);
		assert.ok(input.text.includes("result"));
		assert.ok(input.text.length < 2_000);
		assert.ok(!input.text.includes("large history"));
	});

	test("extracts local image paths referenced by a prompt", () => {
		assert.deepStrictEqual(
			extractImagePathsFromText("see ![turret](C:/tmp/turretshots/sci-fi-turret.png) please"),
			["C:/tmp/turretshots/sci-fi-turret.png"]
		);
		assert.deepStrictEqual(
			extractImagePathsFromText("check file:///d%3A/tmp/shot.png and [x](file:///d:/tmp/a.webp)"),
			["d:/tmp/shot.png", "d:/tmp/a.webp"]
		);
		assert.deepStrictEqual(
			extractImagePathsFromText('open "D:/Power Towers/Assets/x.JPEG" and C:\\tmp\\y.gif'),
			["D:/Power Towers/Assets/x.JPEG", "C:\\tmp\\y.gif"]
		);
		assert.deepStrictEqual(
			extractImagePathsFromText("render /tmp/preview.png and /d/GitHub/logo.png"),
			["/tmp/preview.png", "/d/GitHub/logo.png"]
		);
		// Backticks, @-mentions, Obsidian embeds, and trailing punctuation.
		assert.deepStrictEqual(
			extractImagePathsFromText("open `C:/tmp/backtick.png` and @C:/tmp/at.png and ![[C:/tmp/embed.webp]]"),
			["C:/tmp/backtick.png", "C:/tmp/at.png", "C:/tmp/embed.webp"]
		);
		assert.deepStrictEqual(
			extractImagePathsFromText("(see C:/tmp/trailing.png)"),
			["C:/tmp/trailing.png"]
		);
		// Non-image references, remote URLs, and data URIs are ignored.
		assert.deepStrictEqual(
			extractImagePathsFromText("edit build/logo.png.json, keep C:/tmp/a.glb, see https://x.io/i.png"),
			[]
		);
		assert.deepStrictEqual(extractImagePathsFromText("no images here"), []);
	});

	test("extracts inline base64 image data URIs from a prompt", () => {
		const sample = "Here is the render:\ndata:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
		assert.deepStrictEqual(extractImageDataUrisFromText(sample), [
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
		]);
		// Wrapped base64 across lines is reassembled into one data URI.
		const wrapped = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEA\nAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
		assert.deepStrictEqual(extractImageDataUrisFromText(wrapped), [
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
		]);
		assert.deepStrictEqual(extractImageDataUrisFromText("plain text without images"), []);
		assert.deepStrictEqual(extractImageDataUrisFromText("data:image/svg+xml,<svg/>"), []);
	});

	test("rejects a decodable PNG data URI when its IEND chunk is truncated", () => {
		const complete = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
		const bytes = Buffer.from(complete.slice(complete.indexOf(",") + 1), "base64");
		const truncated = `data:image/png;base64,${bytes.subarray(0, -12).toString("base64")}`;
		assert.strictEqual(isCompleteImageDataUri(complete), true);
		assert.strictEqual(isCompleteImageDataUri(truncated), false);
	});

	test("recovers a truncated inline PNG from an exact temp-file prefix", async () => {
		const complete = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
		const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "llama-image-recovery-"));
		const imagePath = path.join(tempDirectory, "vision.png");
		try {
			await fs.writeFile(imagePath, complete);
			const recovered = await findTempImageWithPrefix("image/png", complete.subarray(0, -12), tempDirectory);
			assert.strictEqual(recovered, imagePath);
		} finally {
			await fs.rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test("resolves git-bash style image paths to real filesystem variants", () => {
		const tmp = "C:\\Users\\krist\\AppData\\Local\\Temp";
		assert.deepStrictEqual(resolveLocalImagePath("/tmp/vision_test.png", tmp), [
			"/tmp/vision_test.png",
			"C:\\Users\\krist\\AppData\\Local\\Temp/vision_test.png",
		]);
		assert.deepStrictEqual(resolveLocalImagePath("C:/tmp/vision_test.png", tmp), [
			"C:/tmp/vision_test.png",
			"C:\\Users\\krist\\AppData\\Local\\Temp/vision_test.png",
		]);
		assert.deepStrictEqual(resolveLocalImagePath("/d/GitHub/logo.png", tmp), [
			"/d/GitHub/logo.png",
			"D:/GitHub/logo.png",
		]);
		assert.deepStrictEqual(resolveLocalImagePath("D:/real/x.png", tmp), ["D:/real/x.png"]);
	});

	test("collects prompt image paths only from the latest user message", () => {
		const messages = [
			vscode.LanguageModelChatMessage.User("old C:/old/one.png"),
			vscode.LanguageModelChatMessage.Assistant("ok"),
			vscode.LanguageModelChatMessage.User("look at C:/new/two.png and C:/new/three.png"),
		];
		assert.deepStrictEqual(collectPromptImagePaths(messages), ["C:/new/two.png", "C:/new/three.png"]);
		assert.deepStrictEqual(collectPromptImagePaths(messages, 1), ["C:/new/two.png"]);
		assert.strictEqual(collectPromptImagePaths([]).length, 0);
		assert.ok(MAX_PROMPT_IMAGES >= 1);
	});

	test("keeps one app-server turn alive across a native tool card", async () => {
		const notifications = new vscode.EventEmitter<CodexServerNotification>();
		const stops = new vscode.EventEmitter<Error>();
		let turnStarts = 0;
		const fakeClient = {
			onNotification: notifications.event,
			onDidStop: stops.event,
			request: async (method: string) => {
				if (method === "turn/start") {
					turnStarts++;
					return { turn: { id: "turn-1", status: "inProgress" } };
				}
				return {};
			},
		} as unknown as CodexAppServerClient;
		const usageSnapshots: number[] = [];
		const outputEstimates: number[] = [];
		let metricUpdates = 0;
		const bridge = new CodexTurnBridge(
			fakeClient,
			"thread-1",
			undefined,
			undefined,
			(_bridge, usage) => usageSnapshots.push(usage.last.totalTokens),
			(_bridge, tokens) => outputEstimates.push(tokens),
			false,
			false,
			() => metricUpdates++
		);
		const firstParts: vscode.LanguageModelResponsePart[] = [];
		const secondParts: vscode.LanguageModelResponsePart[] = [];
		const tokenSource = new vscode.CancellationTokenSource();
		const firstBoundaryPromise = bridge.start(
			{ threadId: "thread-1", input: [] },
			{ report: part => firstParts.push(part) },
			tokenSource.token
		);
		notifications.fire({
			method: "item/agentMessage/delta",
			params: { threadId: "thread-1", turnId: "turn-1", itemId: "preface", delta: "pre" },
		});
		notifications.fire({
			method: "thread/tokenUsage/updated",
			params: {
				threadId: "thread-1",
				turnId: "turn-1",
				tokenUsage: {
					total: { totalTokens: 12_000, inputTokens: 11_000, cachedInputTokens: 10_000, outputTokens: 1_000, reasoningOutputTokens: 100 },
					last: { totalTokens: 1_200, inputTokens: 1_100, cachedInputTokens: 1_000, outputTokens: 100, reasoningOutputTokens: 10 },
					modelContextWindow: 258_400,
				},
			},
		});
		const dynamicResponsePromise = bridge.delegate({
			callId: "call-1",
			tool: "read_file",
			input: { path: "README.md" },
			turnId: "turn-1",
		});
		const firstBoundary = await firstBoundaryPromise;
		assert.strictEqual(firstBoundary.kind, "delegated");
		assert.ok(firstParts.some(part => part instanceof vscode.LanguageModelToolCallPart));

		const toolResponse = { contentItems: [{ type: "inputText" as const, text: "file contents" }], success: true };
		const resumed = bridge.resume(new Map([["call-1", toolResponse]]), { report: part => secondParts.push(part) }, tokenSource.token);
		assert.deepStrictEqual(await dynamicResponsePromise, toolResponse);
		const toolStep = bridge.liveMetrics.steps.find(step => step.kind === "tool");
		assert.strictEqual(toolStep?.label, "read_file");
		assert.strictEqual(toolStep?.status, "completed");
		assert.ok(metricUpdates >= 3);
		notifications.fire({
			method: "item/agentMessage/delta",
			params: { threadId: "thread-1", turnId: "turn-1", itemId: "answer", delta: "done" },
		});
		notifications.fire({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
		});
		assert.strictEqual((await resumed).kind, "completed");
		assert.strictEqual(turnStarts, 1);
		assert.ok(secondParts.some(part => part instanceof vscode.LanguageModelTextPart));
		assert.strictEqual(bridge.finalText, "predone");
		assert.strictEqual(bridge.segmentText, "done");
		assert.deepStrictEqual(usageSnapshots, [1_200]);
		assert.ok(outputEstimates.length >= 2);
		assert.strictEqual(outputEstimates.at(-1), 1);
		bridge.dispose();
		tokenSource.dispose();
		notifications.dispose();
		stops.dispose();
	});

	test("interrupts a strict turn when Codex starts an internal action", async () => {
		const notifications = new vscode.EventEmitter<CodexServerNotification>();
		const stops = new vscode.EventEmitter<Error>();
		const requests: string[] = [];
		let turnStarts = 0;
		const fakeClient = {
			onNotification: notifications.event,
			onDidStop: stops.event,
			request: async (method: string) => {
				requests.push(method);
				return method === "turn/start"
					? { turn: { id: `turn-strict-${++turnStarts}`, status: "inProgress" } }
					: {};
			},
		} as unknown as CodexAppServerClient;
		const bridge = new CodexTurnBridge(
			fakeClient,
			"thread-strict",
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			true
		);
		const tokenSource = new vscode.CancellationTokenSource();
		const boundary = bridge.start(
			{ threadId: "thread-strict", input: [] },
			{ report: () => undefined },
			tokenSource.token
		);
		await new Promise<void>(resolve => setImmediate(resolve));
		notifications.fire({
			method: "item/started",
			params: {
				threadId: "thread-strict",
				turnId: "turn-strict-1",
				item: { id: "internal-command", type: "commandExecution", command: "echo bypass" },
			},
		});
		await assert.rejects(boundary, CodexInternalToolBlockedError);
		await bridge.waitForBlockedInternalToolInterrupt();
		assert.ok(requests.includes("turn/interrupt"));
		const restarted = bridge.restart(
			{ threadId: "thread-strict", input: [{ type: "text", text: "use native tools" }] },
			{ report: () => undefined },
			tokenSource.token
		);
		await new Promise<void>(resolve => setImmediate(resolve));
		notifications.fire({
			method: "turn/completed",
			params: { threadId: "thread-strict", turn: { id: "turn-strict-2", status: "completed", error: null } },
		});
		assert.strictEqual((await restarted).kind, "completed");
		assert.strictEqual(turnStarts, 2);
		assert.strictEqual(isCodexInternalActionItem({ type: "fileChange" }), true);
		assert.strictEqual(isCodexInternalActionItem({ type: "agentMessage" }), false);
		bridge.dispose();
		tokenSource.dispose();
		notifications.dispose();
		stops.dispose();
	});

	test("restarts a failed tool turn on the same Codex thread", async () => {
		const notifications = new vscode.EventEmitter<CodexServerNotification>();
		const stops = new vscode.EventEmitter<Error>();
		const turnStartParams: Record<string, unknown>[] = [];
		const fakeClient = {
			onNotification: notifications.event,
			onDidStop: stops.event,
			request: async (method: string, params: Record<string, unknown>) => {
				if (method === "turn/start") {
					turnStartParams.push(params);
					return { turn: { id: `turn-${turnStartParams.length}`, status: "inProgress" } };
				}
				return {};
			},
		} as unknown as CodexAppServerClient;
		const bridge = new CodexTurnBridge(fakeClient, "thread-recovery");
		const tokenSource = new vscode.CancellationTokenSource();
		const first = bridge.start(
			{ threadId: "thread-recovery", input: [{ type: "text", text: "large original input" }] },
			{ report: () => undefined },
			tokenSource.token
		);
		await new Promise<void>(resolve => setImmediate(resolve));
		notifications.fire({
			method: "turn/completed",
			params: { threadId: "thread-recovery", turn: { id: "turn-1", status: "failed", error: null } },
		});
		const failed = await first;
		assert.strictEqual(failed.kind, "completed");

		const recovered = bridge.restart(
			{ threadId: "thread-recovery", input: [{ type: "text", text: "continue" }] },
			{ report: () => undefined },
			tokenSource.token
		);
		await new Promise<void>(resolve => setImmediate(resolve));
		// A duplicate terminal event from the old turn must not complete the recovery turn.
		notifications.fire({
			method: "turn/completed",
			params: { threadId: "thread-recovery", turn: { id: "turn-1", status: "failed", error: null } },
		});
		notifications.fire({
			method: "turn/completed",
			params: { threadId: "thread-recovery", turn: { id: "turn-2", status: "completed", error: null } },
		});
		const boundary = await recovered;
		assert.strictEqual(boundary.kind, "completed");
		if (boundary.kind === "completed") {
			assert.strictEqual(boundary.completed.turn.id, "turn-2");
		}
		assert.strictEqual(turnStartParams.length, 2);
		assert.strictEqual(turnStartParams[1].threadId, "thread-recovery");
		assert.strictEqual(JSON.stringify(turnStartParams[1]).includes("large original input"), false);
		bridge.dispose();
		tokenSource.dispose();
		notifications.dispose();
		stops.dispose();
	});

	test("recovers only transient Codex tool-turn failures", () => {
		assert.strictEqual(shouldRecoverCodexFailedToolTurn(), true);
		assert.strictEqual(shouldRecoverCodexFailedToolTurn("Internal server error"), true);
		assert.strictEqual(shouldRecoverCodexFailedToolTurn("Input exceeds the maximum length"), false);
		assert.strictEqual(shouldRecoverCodexFailedToolTurn("Rate limit exceeded"), false);
		assert.strictEqual(shouldRecoverCodexFailedToolTurn("Request was interrupted"), false);
		assert.strictEqual(shouldRecoverCodexToolTurnException(new CodexStaleTurnError("stale")), true);
		assert.strictEqual(shouldRecoverCodexToolTurnException(new CodexInternalToolBlockedError("commandExecution")), true);
		assert.strictEqual(shouldRecoverCodexToolTurnException(new Error("transport failed")), false);
	});

	test("recovers a completed turn when app-server omits turn/completed after a subagent result", async () => {
		const notifications = new vscode.EventEmitter<CodexServerNotification>();
		const stops = new vscode.EventEmitter<Error>();
		let threadReads = 0;
		const fakeClient = {
			onNotification: notifications.event,
			onDidStop: stops.event,
			request: async (method: string) => {
				if (method === "turn/start") {
					return { turn: { id: "turn-subagent", status: "inProgress" } };
				}
				if (method === "thread/read") {
					threadReads++;
					return {
						thread: {
							id: "thread-subagent",
							turns: [{
								id: "turn-subagent",
								status: "completed",
								error: null,
								items: [{
									type: "agentMessage",
									id: "final-after-subagent",
									phase: "final_answer",
									text: "Recovered after subagent",
								}],
							}],
						},
					};
				}
				return {};
			},
		} as unknown as CodexAppServerClient;
		const bridge = new CodexTurnBridge(fakeClient, "thread-subagent");
		const tokenSource = new vscode.CancellationTokenSource();
		const first = bridge.start(
			{ threadId: "thread-subagent", input: [] },
			{ report: () => undefined },
			tokenSource.token
		);
		const subagentResponse = bridge.delegate({
			callId: "subagent-call",
			tool: "runSubagent",
			input: { description: "inspect" },
		});
		assert.strictEqual((await first).kind, "delegated");

		const parts: vscode.LanguageModelResponsePart[] = [];
		const resumed = bridge.resume(new Map([["subagent-call", {
			contentItems: [{ type: "inputText", text: "child_session_ref: done" }],
			success: true,
		}]]), { report: part => parts.push(part) }, tokenSource.token);
		assert.strictEqual((await subagentResponse).success, true);
		const boundary = await resumed;
		assert.strictEqual(boundary.kind, "completed");
		assert.strictEqual(threadReads, 1);
		assert.ok(parts.some(part =>
			part instanceof vscode.LanguageModelTextPart
			&& part.value === "Recovered after subagent"
		));
		assert.strictEqual(bridge.segmentText, "Recovered after subagent");
		bridge.dispose();
		tokenSource.dispose();
		notifications.dispose();
		stops.dispose();
	});

	test("reconciles ephemeral turns from thread status without requesting stored turns", async () => {
		const notifications = new vscode.EventEmitter<CodexServerNotification>();
		const stops = new vscode.EventEmitter<Error>();
		const threadReadParams: Record<string, unknown>[] = [];
		let markFirstRead!: () => void;
		const firstRead = new Promise<void>(resolve => { markFirstRead = resolve; });
		const fakeClient = {
			onNotification: notifications.event,
			onDidStop: stops.event,
			request: async (method: string, params: Record<string, unknown>) => {
				if (method === "turn/start") {
					return { turn: { id: "turn-ephemeral", status: "inProgress" } };
				}
				if (method === "thread/read") {
					threadReadParams.push(params);
					markFirstRead();
					return {
						thread: {
							id: "thread-ephemeral",
							ephemeral: true,
							status: { type: "idle" },
						},
					};
				}
				return {};
			},
		} as unknown as CodexAppServerClient;
		const bridge = new CodexTurnBridge(
			fakeClient,
			"thread-ephemeral",
			undefined,
			undefined,
			undefined,
			undefined,
			true
		);
		const tokenSource = new vscode.CancellationTokenSource();
		const first = bridge.start(
			{ threadId: "thread-ephemeral", input: [] },
			{ report: () => undefined },
			tokenSource.token
		);
		bridge.delegate({ callId: "call-ephemeral", tool: "read_file", input: {} });
		assert.strictEqual((await first).kind, "delegated");
		const resumed = bridge.resume(new Map([["call-ephemeral", {
			contentItems: [{ type: "inputText", text: "done" }],
			success: true,
		}]]), { report: () => undefined }, tokenSource.token);
		await firstRead;
		await new Promise<void>(resolve => setImmediate(resolve));
		await (bridge as unknown as { reconcileTurnBoundary(): Promise<void> }).reconcileTurnBoundary();
		const boundary = await resumed;
		assert.strictEqual(boundary.kind, "completed");
		assert.strictEqual(threadReadParams.length, 2);
		assert.ok(threadReadParams.every(params => !("includeTurns" in params)));
		bridge.dispose();
		tokenSource.dispose();
		notifications.dispose();
		stops.dispose();
	});

	test("falls back to ephemeral status reconciliation when includeTurns is rejected", async () => {
		const notifications = new vscode.EventEmitter<CodexServerNotification>();
		const stops = new vscode.EventEmitter<Error>();
		const threadReadParams: Record<string, unknown>[] = [];
		let markRejectedRead!: () => void;
		const rejectedRead = new Promise<void>(resolve => { markRejectedRead = resolve; });
		const fakeClient = {
			onNotification: notifications.event,
			onDidStop: stops.event,
			request: async (method: string, params: Record<string, unknown>) => {
				if (method === "turn/start") {
					return { turn: { id: "turn-ephemeral-fallback", status: "inProgress" } };
				}
				if (method === "thread/read") {
					threadReadParams.push(params);
					if (threadReadParams.length === 1) {
						markRejectedRead();
						throw new Error("ephemeral threads do not support includeTurns");
					}
					return {
						thread: {
							id: "thread-ephemeral-fallback",
							ephemeral: true,
							status: { type: "idle" },
						},
					};
				}
				return {};
			},
		} as unknown as CodexAppServerClient;
		const bridge = new CodexTurnBridge(fakeClient, "thread-ephemeral-fallback");
		const tokenSource = new vscode.CancellationTokenSource();
		const first = bridge.start(
			{ threadId: "thread-ephemeral-fallback", input: [] },
			{ report: () => undefined },
			tokenSource.token
		);
		bridge.delegate({ callId: "call-ephemeral-fallback", tool: "grep_search", input: {} });
		assert.strictEqual((await first).kind, "delegated");
		const resumed = bridge.resume(new Map([["call-ephemeral-fallback", {
			contentItems: [{ type: "inputText", text: "done" }],
			success: true,
		}]]), { report: () => undefined }, tokenSource.token);
		await rejectedRead;
		await new Promise<void>(resolve => setImmediate(resolve));
		await (bridge as unknown as { reconcileTurnBoundary(): Promise<void> }).reconcileTurnBoundary();
		await (bridge as unknown as { reconcileTurnBoundary(): Promise<void> }).reconcileTurnBoundary();
		assert.strictEqual((await resumed).kind, "completed");
		assert.strictEqual(threadReadParams[0].includeTurns, true);
		assert.ok(threadReadParams.slice(1).every(params => !("includeTurns" in params)));
		bridge.dispose();
		tokenSource.dispose();
		notifications.dispose();
		stops.dispose();
	});

	test("rejects a resumed turn when reconciliation errors out past its deadline", async () => {
		const notifications = new vscode.EventEmitter<CodexServerNotification>();
		const stops = new vscode.EventEmitter<Error>();
		let markReadStarted!: () => void;
		let rejectRead!: (error: Error) => void;
		const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
		const fakeClient = {
			onNotification: notifications.event,
			onDidStop: stops.event,
			request: async (method: string) => {
				if (method === "turn/start") {
					return { turn: { id: "turn-stale", status: "inProgress" } };
				}
				if (method === "thread/read") {
					markReadStarted();
					return new Promise((_resolve, reject) => { rejectRead = reject; });
				}
				return {};
			},
		} as unknown as CodexAppServerClient;
		const bridge = new CodexTurnBridge(fakeClient, "thread-stale");
		const tokenSource = new vscode.CancellationTokenSource();
		const first = bridge.start(
			{ threadId: "thread-stale", input: [] },
			{ report: () => undefined },
			tokenSource.token
		);
		bridge.delegate({ callId: "call-stale", tool: "runSubagent", input: {} });
		assert.strictEqual((await first).kind, "delegated");
		const resumed = bridge.resume(new Map([["call-stale", {
			contentItems: [{ type: "inputText", text: "done" }],
			success: true,
		}]]), { report: () => undefined }, tokenSource.token);
		await readStarted;
		(bridge as unknown as { reconcileDeadlineAt: number }).reconcileDeadlineAt = Date.now() - 1;
		rejectRead(new Error("thread/read timed out"));
		await assert.rejects(resumed, CodexStaleTurnError);
		bridge.dispose();
		tokenSource.dispose();
		notifications.dispose();
		stops.dispose();
	});

	test("batches parallel dynamic tool calls into one resumed app-server turn", async () => {
		const notifications = new vscode.EventEmitter<CodexServerNotification>();
		const stops = new vscode.EventEmitter<Error>();
		const fakeClient = {
			onNotification: notifications.event,
			onDidStop: stops.event,
			request: async (method: string) => method === "turn/start"
				? { turn: { id: "turn-batch", status: "inProgress" } }
				: {},
		} as unknown as CodexAppServerClient;
		const bridge = new CodexTurnBridge(fakeClient, "thread-batch");
		const parts: vscode.LanguageModelResponsePart[] = [];
		const tokenSource = new vscode.CancellationTokenSource();
		const boundaryPromise = bridge.start(
			{ threadId: "thread-batch", input: [] },
			{ report: part => parts.push(part) },
			tokenSource.token
		);
		const firstResponse = bridge.delegate({ callId: "call-a", tool: "read_file", input: { path: "a" } });
		const secondResponse = bridge.delegate({ callId: "call-b", tool: "read_file", input: { path: "b" } });
		assert.strictEqual((await boundaryPromise).kind, "delegated");
		assert.deepStrictEqual(bridge.pendingCalls.map(call => call.callId), ["call-a", "call-b"]);
		assert.strictEqual(parts.filter(part => part instanceof vscode.LanguageModelToolCallPart).length, 2);

		const resumePromise = bridge.resume(new Map([
			["call-a", { contentItems: [{ type: "inputText" as const, text: "A" }], success: true }],
			["call-b", { contentItems: [{ type: "inputText" as const, text: "B" }], success: true }],
		]), { report: () => undefined }, tokenSource.token);
		assert.strictEqual((await firstResponse).contentItems[0].type, "inputText");
		assert.strictEqual((await secondResponse).contentItems[0].type, "inputText");
		notifications.fire({
			method: "turn/completed",
			params: { threadId: "thread-batch", turn: { id: "turn-batch", status: "completed", error: null } },
		});
		assert.strictEqual((await resumePromise).kind, "completed");
		bridge.dispose();
		tokenSource.dispose();
		notifications.dispose();
		stops.dispose();
	});

	test("queues late dynamic tool calls until the next native tool segment", async () => {
		const notifications = new vscode.EventEmitter<CodexServerNotification>();
		const stops = new vscode.EventEmitter<Error>();
		const fakeClient = {
			onNotification: notifications.event,
			onDidStop: stops.event,
			request: async (method: string) => method === "turn/start"
				? { turn: { id: "turn-late", status: "inProgress" } }
				: {},
		} as unknown as CodexAppServerClient;
		const bridge = new CodexTurnBridge(fakeClient, "thread-late");
		const firstParts: vscode.LanguageModelResponsePart[] = [];
		const secondParts: vscode.LanguageModelResponsePart[] = [];
		const tokenSource = new vscode.CancellationTokenSource();
		const firstBoundary = bridge.start(
			{ threadId: "thread-late", input: [] },
			{ report: part => firstParts.push(part) },
			tokenSource.token
		);
		const firstResponse = bridge.delegate({ callId: "call-first", tool: "read_file", input: { path: "a" } });
		assert.strictEqual((await firstBoundary).kind, "delegated");

		const lateResponse = bridge.delegate({ callId: "call-late", tool: "grep_search", input: { query: "b" } });
		assert.deepStrictEqual(bridge.reportedCalls.map(call => call.callId), ["call-first"]);
		assert.deepStrictEqual(bridge.pendingCalls.map(call => call.callId), ["call-first", "call-late"]);

		const secondBoundary = bridge.resume(new Map([
			["call-first", { contentItems: [{ type: "inputText", text: "A" }], success: true }],
		]), { report: part => secondParts.push(part) }, tokenSource.token);
		assert.strictEqual((await firstResponse).success, true);
		assert.strictEqual((await secondBoundary).kind, "delegated");
		assert.deepStrictEqual(bridge.reportedCalls.map(call => call.callId), ["call-late"]);
		assert.strictEqual(secondParts.filter(part => part instanceof vscode.LanguageModelToolCallPart).length, 1);
		const latePart = secondParts.find(part => part instanceof vscode.LanguageModelToolCallPart);
		assert.ok(latePart instanceof vscode.LanguageModelToolCallPart);
		assert.strictEqual(latePart.callId, "call-late");

		const completedBoundary = bridge.resume(new Map([
			["call-late", { contentItems: [{ type: "inputText", text: "B" }], success: true }],
		]), { report: () => undefined }, tokenSource.token);
		assert.strictEqual((await lateResponse).success, true);
		notifications.fire({
			method: "turn/completed",
			params: { threadId: "thread-late", turn: { id: "turn-late", status: "completed", error: null } },
		});
		assert.strictEqual((await completedBoundary).kind, "completed");
		bridge.dispose();
		tokenSource.dispose();
		notifications.dispose();
		stops.dispose();
	});

	test("rejects an incomplete parallel tool-result batch without resuming the turn", async () => {
		const notifications = new vscode.EventEmitter<CodexServerNotification>();
		const stops = new vscode.EventEmitter<Error>();
		const fakeClient = {
			onNotification: notifications.event,
			onDidStop: stops.event,
			request: async () => ({ turn: { id: "turn-incomplete", status: "inProgress" } }),
		} as unknown as CodexAppServerClient;
		const bridge = new CodexTurnBridge(fakeClient, "thread-incomplete");
		const tokenSource = new vscode.CancellationTokenSource();
		const boundaryPromise = bridge.start(
			{ threadId: "thread-incomplete", input: [] },
			{ report: () => undefined },
			tokenSource.token
		);
		void bridge.delegate({ callId: "call-a", tool: "read_file", input: { path: "a" } });
		void bridge.delegate({ callId: "call-b", tool: "read_file", input: { path: "b" } });
		await boundaryPromise;

		await assert.rejects(
			bridge.resume(new Map([
				["call-a", { contentItems: [{ type: "inputText", text: "A" }], success: true }],
			]), { report: () => undefined }, tokenSource.token),
			/missing call ids: call-b/
		);
		assert.strictEqual(bridge.pendingCalls.length, 2);
		bridge.dispose();
		tokenSource.dispose();
		notifications.dispose();
		stops.dispose();
	});

	test("releases a suspended native tool call when the app-server stops", async () => {
		const notifications = new vscode.EventEmitter<CodexServerNotification>();
		const stops = new vscode.EventEmitter<Error>();
		const fakeClient = {
			onNotification: notifications.event,
			onDidStop: stops.event,
			request: async () => ({ turn: { id: "turn-stop", status: "inProgress" } }),
		} as unknown as CodexAppServerClient;
		let stopCallbacks = 0;
		const bridge = new CodexTurnBridge(fakeClient, "thread-stop", undefined, () => stopCallbacks++);
		const tokenSource = new vscode.CancellationTokenSource();
		const boundaryPromise = bridge.start(
			{ threadId: "thread-stop", input: [] },
			{ report: () => undefined },
			tokenSource.token
		);
		const toolResponse = bridge.delegate({ callId: "call-stop", tool: "read_file", input: { path: "a" } });
		const stopped = new Error("app-server stopped for test");
		stops.fire(stopped);

		await assert.rejects(boundaryPromise, /stopped for test/);
		assert.strictEqual((await toolResponse).success, false);
		assert.strictEqual(stopCallbacks, 1);
		assert.strictEqual(bridge.pendingCalls.length, 0);
		bridge.dispose();
		tokenSource.dispose();
		notifications.dispose();
		stops.dispose();
	});

	test("marks a suspended native tool call timed out and emits terminal metrics", async () => {
		const notifications = new vscode.EventEmitter<CodexServerNotification>();
		const stops = new vscode.EventEmitter<Error>();
		const fakeClient = {
			onNotification: notifications.event,
			onDidStop: stops.event,
			request: async () => ({ turn: { id: "turn-timeout", status: "inProgress" } }),
		} as unknown as CodexAppServerClient;
		let timeoutReason: string | undefined;
		let metricUpdates = 0;
		const bridge = new CodexTurnBridge(
			fakeClient,
			"thread-timeout",
			undefined,
			(_bridge, reason) => timeoutReason = reason,
			undefined,
			undefined,
			false,
			false,
			() => metricUpdates++,
			5
		);
		const tokenSource = new vscode.CancellationTokenSource();
		const boundaryPromise = bridge.start(
			{ threadId: "thread-timeout", input: [] },
			{ report: () => undefined },
			tokenSource.token
		);
		const toolResponse = bridge.delegate({ callId: "call-timeout", tool: "runSubagent", input: {} });
		assert.strictEqual((await boundaryPromise).kind, "delegated");
		assert.strictEqual((await toolResponse).success, false);
		assert.strictEqual(timeoutReason, "timeout");
		assert.strictEqual(bridge.liveMetrics.steps.find(step => step.kind === "tool")?.status, "timed_out");
		assert.ok(metricUpdates >= 2);
		bridge.dispose();
		tokenSource.dispose();
		notifications.dispose();
		stops.dispose();
	});

	test("finds every pending native tool result in one Copilot round", () => {
		const messages = [vscode.LanguageModelChatMessage.User([
			new vscode.LanguageModelToolResultPart("call-a", [new vscode.LanguageModelTextPart("A")]),
			new vscode.LanguageModelToolResultPart("call-b", [new vscode.LanguageModelTextPart("B")]),
		])];
		const matches = findCodexToolContinuations(messages, new Set(["call-a", "call-b"]));
		assert.deepStrictEqual(new Set(matches.map(match => match.callId)), new Set(["call-a", "call-b"]));
	});

	test("keeps an active Codex tool turn when the outer tool catalog changes", () => {
		const active = { modelId: "gpt-test", runtimeKey: "catalog-before", processGeneration: 3 };
		assert.strictEqual(canResumeCodexToolTurn(active, {
			modelId: "gpt-test",
			runtimeKey: "catalog-after",
			processGeneration: 3,
		}), true);
		assert.strictEqual(canResumeCodexToolTurn(active, {
			modelId: "different-model",
			runtimeKey: "catalog-after",
			processGeneration: 3,
		}), false);
		assert.strictEqual(canResumeCodexToolTurn(active, {
			modelId: "gpt-test",
			runtimeKey: "catalog-after",
			processGeneration: 4,
		}), false);
	});

	test("keeps completed-thread runtime identity stable across tool catalog changes", () => {
		const before = createCodexRuntimeFingerprints({
			modelId: "gpt-test",
			cwd: "workspace",
			approvalPolicy: "on-request",
			sandbox: "workspace-write",
			dynamicTools: [{ name: "read_file" }],
		});
		const after = createCodexRuntimeFingerprints({
			modelId: "gpt-test",
			cwd: "workspace",
			approvalPolicy: "on-request",
			sandbox: "workspace-write",
			dynamicTools: [{ name: "read_file" }, { name: "grep_search" }],
		});
		const changedSandbox = createCodexRuntimeFingerprints({
			modelId: "gpt-test",
			cwd: "workspace",
			approvalPolicy: "on-request",
			sandbox: "read-only",
			dynamicTools: [{ name: "read_file" }, { name: "grep_search" }],
		});
		assert.strictEqual(before.runtimeKey, after.runtimeKey);
		assert.notStrictEqual(before.toolCatalogKey, after.toolCatalogKey);
		assert.notStrictEqual(after.runtimeKey, changedSandbox.runtimeKey);
	});

	test("normalizes Windows workspace spelling used in Codex thread settings", () => {
		assert.strictEqual(normalizeCodexRuntimeCwd("D:/GitHub/Project", "win32"), "d:\\GitHub\\Project");
		assert.strictEqual(normalizeCodexRuntimeCwd("d:\\GitHub\\Project", "win32"), "d:\\GitHub\\Project");
		assert.strictEqual(normalizeCodexRuntimeCwd("/work/Project", "linux"), "/work/Project");
	});

	test("reuses only the safe intersection of stored and current thread tools", () => {
		const effective = intersectCodexThreadTools(
			new Set(["read_file", "apply_patch", "removed_tool", "changed_tool"]),
			new Map([
				["apply_patch", CODEX_NATIVE_TOOL_NAMESPACE],
				["removed_tool", CODEX_DEFERRED_TOOL_NAMESPACE],
			]),
			new Map([
				["read_file", "read-v1"],
				["apply_patch", "patch-v1"],
				["removed_tool", "removed-v1"],
				["changed_tool", "changed-v1"],
			]),
			new Set(["read_file", "apply_patch", "new_tool", "changed_tool"]),
			new Map([
				["read_file", "read-v1"],
				["apply_patch", "patch-v1"],
				["new_tool", "new-v1"],
				["changed_tool", "changed-v2"],
			])
		);
		assert.deepStrictEqual(effective.callableNames, new Set(["read_file", "apply_patch"]));
		assert.deepStrictEqual(
			effective.toolNamespaces,
			new Map([["apply_patch", CODEX_NATIVE_TOOL_NAMESPACE]])
		);
	});

	test("bounds native tool output before returning it to the active Codex turn", () => {
		const result = new vscode.LanguageModelToolResultPart("call", [
			new vscode.LanguageModelTextPart(`HEAD\n${"x".repeat(20_000)}\nTAIL`),
		]);
		const converted = convertCodexToolResult(result, 2_048);
		assert.strictEqual(converted.success, true);
		const textItem = converted.contentItems.find(item => item.type === "inputText");
		assert.ok(textItem && textItem.text.length <= 2_048);
		assert.ok(textItem?.text.includes("HEAD"));
		assert.ok(textItem?.text.includes("TAIL"));
	});

	test("reuses a completed Codex conversation only for an unchanged history", () => {
		const original = [vscode.LanguageModelChatMessage.User("original request")];
		const anchor = createCodexConversationAnchor(original, "completed answer");
		const nextTurn = [
			...original,
			vscode.LanguageModelChatMessage.Assistant("completed answer"),
			vscode.LanguageModelChatMessage.User("follow-up request"),
		];
		const tail = findCodexConversationTail(nextTurn, anchor);
		assert.ok(tail);
		assert.strictEqual(tail.length, 1);
		assert.strictEqual((tail[0].content[0] as vscode.LanguageModelTextPart).value, "follow-up request");

		const edited = [
			vscode.LanguageModelChatMessage.User("edited original request"),
			vscode.LanguageModelChatMessage.Assistant("completed answer"),
			vscode.LanguageModelChatMessage.User("follow-up request"),
		];
		assert.strictEqual(findCodexConversationTail(edited, anchor), undefined);
	});

	test("reuses a completed conversation when Copilot rewrites historical tool plumbing", () => {
		const original = [
			vscode.LanguageModelChatMessage.User("original request"),
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelToolCallPart("live-call", "read_file", { path: "before.ts" }),
			]),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart("live-call", [new vscode.LanguageModelTextPart("live result")]),
			]),
		];
		const anchor = createCodexConversationAnchor(original, "completed answer");
		const nextTurn = [
			vscode.LanguageModelChatMessage.User("original request"),
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelToolCallPart("persisted-call", "read_file", { path: "after.ts" }),
			]),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart("persisted-call", [new vscode.LanguageModelTextPart("persisted result")]),
			]),
			vscode.LanguageModelChatMessage.Assistant("completed answer"),
			vscode.LanguageModelChatMessage.User("follow-up request"),
		];
		const match = matchCodexConversationTail(nextTurn, anchor);
		assert.strictEqual(match.strategy, "suffix");
		assert.strictEqual(match.matchedUserMessages, 1);
		assert.strictEqual(match.tail?.length, 1);
		assert.strictEqual(
			(match.tail?.[0].content[0] as vscode.LanguageModelTextPart).value,
			"follow-up request"
		);
	});

	test("rejects suffix reuse when the latest semantic request changed", () => {
		const original = [
			vscode.LanguageModelChatMessage.User("original request"),
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelToolCallPart("call", "read_file", { path: "file.ts" }),
			]),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart("call", [new vscode.LanguageModelTextPart("result")]),
			]),
		];
		const anchor = createCodexConversationAnchor(original, "same answer");
		const edited = [
			vscode.LanguageModelChatMessage.User("edited original request"),
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelToolCallPart("persisted-call", "read_file", { path: "file.ts" }),
			]),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart("persisted-call", [new vscode.LanguageModelTextPart("result")]),
			]),
			vscode.LanguageModelChatMessage.Assistant("same answer"),
			vscode.LanguageModelChatMessage.User("follow-up"),
		];
		const match = matchCodexConversationTail(edited, anchor);
		assert.strictEqual(match.tail, undefined);
		assert.strictEqual(match.missReason, "user-history-suffix-changed");
	});

	test("uses trusted Copilot conversation identity across unstable rendered history", () => {
		const original = [
			vscode.LanguageModelChatMessage.User("original request"),
			vscode.LanguageModelChatMessage.User("generated service context before completion"),
		];
		const anchor = createCodexConversationAnchor(original, "completed answer");
		const nextTurn = [
			vscode.LanguageModelChatMessage.User("rewritten service context"),
			vscode.LanguageModelChatMessage.User("different rendered plumbing"),
			vscode.LanguageModelChatMessage.Assistant("completed answer"),
			vscode.LanguageModelChatMessage.User("follow-up request"),
		];
		const untrusted = matchCodexConversationTail(nextTurn, anchor);
		assert.strictEqual(untrusted.tail, undefined);
		assert.strictEqual(untrusted.missReason, "user-history-suffix-changed");

		const trusted = matchCodexConversationTail(nextTurn, anchor, { trustedConversation: true });
		assert.strictEqual(trusted.strategy, "conversation-id");
		assert.strictEqual(trusted.matchedUserMessages, 0);
		assert.strictEqual(trusted.tail?.length, 1);
		assert.strictEqual(
			(trusted.tail?.[0].content[0] as vscode.LanguageModelTextPart).value,
			"follow-up request"
		);
	});

	test("trusted Copilot identity still requires the exact prior answer", () => {
		const original = [vscode.LanguageModelChatMessage.User("request")];
		const anchor = createCodexConversationAnchor(original, "expected answer");
		const regenerated = [
			vscode.LanguageModelChatMessage.User("rewritten request context"),
			vscode.LanguageModelChatMessage.Assistant("different answer"),
			vscode.LanguageModelChatMessage.User("follow-up"),
		];
		const match = matchCodexConversationTail(regenerated, anchor, { trustedConversation: true });
		assert.strictEqual(match.tail, undefined);
		assert.strictEqual(match.missReason, "assistant-answer-missing");
	});

	test("does not reuse a conversation when the prior assistant answer differs", () => {
		const original = [vscode.LanguageModelChatMessage.User("request")];
		const anchor = createCodexConversationAnchor(original, "expected answer");
		const regenerated = [
			...original,
			vscode.LanguageModelChatMessage.Assistant("different answer"),
			vscode.LanguageModelChatMessage.User("follow-up"),
		];
		assert.strictEqual(findCodexConversationTail(regenerated, anchor), undefined);
	});

	test("advertises public and private outer tools for native Copilot delegation", () => {
		const tools: vscode.LanguageModelChatTool[] = [
			{ name: "copilot_readFile", description: "Read a workspace file", inputSchema: { type: "object" } },
			{ name: "private_tool", description: "Private caller tool", inputSchema: { type: "object" } },
		];
		const dynamic = buildCodexDynamicTools(tools);
		assert.deepStrictEqual(dynamic.specs.map(tool => tool.name), ["copilot_readFile", "private_tool"]);
		assert.deepStrictEqual(dynamic.skippedNames, []);
		assert.ok(dynamic.callableNames.has("private_tool"));
	});

	test("keeps the Codex dynamic catalog stable across tool permutations", () => {
		const first = buildCodexDynamicTools([
			{ name: "zeta_tool", description: "Z", inputSchema: { type: "object", properties: { b: { type: "string" }, a: { type: "number" } } } },
			{ name: "alpha_tool", description: "A", inputSchema: { required: ["value"], properties: { value: { type: "string" } }, type: "object" } },
		], { deferNonCoreTools: false });
		const second = buildCodexDynamicTools([
			{ name: "alpha_tool", description: "A", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } },
			{ name: "zeta_tool", description: "Z", inputSchema: { properties: { a: { type: "number" }, b: { type: "string" } }, type: "object" } },
		], { deferNonCoreTools: false });
		assert.deepStrictEqual(first.specs, second.specs);
		assert.deepStrictEqual(first.runtimeSignatures, second.runtimeSignatures);
	});

	test("enables durable Codex sessions unless an explicit scope disables them", () => {
		assert.deepStrictEqual(resolveCodexSessionPersistence({
			persistProviderSessions: { defaultValue: false },
			codexEphemeralThreads: { defaultValue: true },
		}), {
			enabled: true,
			useEphemeralThreads: false,
			persistProviderSessionsOverride: undefined,
			codexEphemeralThreadsOverride: undefined,
		});
		assert.deepStrictEqual(resolveCodexSessionPersistence({
			persistProviderSessions: { globalValue: false },
			codexEphemeralThreads: {},
		}), {
			enabled: false,
			useEphemeralThreads: true,
			persistProviderSessionsOverride: false,
			codexEphemeralThreadsOverride: undefined,
		});
		assert.deepStrictEqual(resolveCodexSessionPersistence({
			persistProviderSessions: { globalValue: false, workspaceValue: true },
			codexEphemeralThreads: { globalValue: true, workspaceFolderValue: false },
		}), {
			enabled: true,
			useEphemeralThreads: false,
			persistProviderSessionsOverride: true,
			codexEphemeralThreadsOverride: false,
		});
	});

	test("resolves the contributed VS Code defaults to durable Codex threads", () => {
		const config = vscode.workspace.getConfiguration("llamacpp");
		const persistence = resolveCodexSessionPersistence({
			persistProviderSessions: config.inspect<boolean>("persistProviderSessions"),
			codexEphemeralThreads: config.inspect<boolean>("codexEphemeralThreads"),
		});
		assert.strictEqual(config.get<boolean>("persistProviderSessions"), true);
		assert.strictEqual(config.get<boolean>("codexEphemeralThreads"), false);
		assert.strictEqual(persistence.enabled, true);
		assert.strictEqual(persistence.useEphemeralThreads, false);
	});

	test("rejects a thread persistence mismatch before a model turn can start", () => {
		assert.strictEqual(assertCodexThreadPersistence(false, false), false);
		assert.strictEqual(assertCodexThreadPersistence(true, true), true);
		assert.throws(
			() => assertCodexThreadPersistence(false, true),
			/returned ephemeral=true.*No model turn was started/
		);
		assert.throws(
			() => assertCodexThreadPersistence(false, undefined),
			/returned ephemeral=undefined.*No model turn was started/
		);
	});

	test("restores durable Codex thread metadata beyond the former four-hour TTL", async () => {
		const values = new Map<string, unknown>();
		let updateCompleted = false;
		const workspaceState = {
			keys: () => [...values.keys()],
			get: <T>(key: string, defaultValue?: T): T | undefined =>
				(values.has(key) ? values.get(key) as T : defaultValue),
			update: async (key: string, value: unknown): Promise<void> => {
				await Promise.resolve();
				values.set(key, value);
				updateCompleted = true;
			},
		} as vscode.Memento;
		const provider = new CodexChatModelProvider("test", undefined, workspaceState);
		await (provider as unknown as { rememberConversationThread(value: unknown): Promise<void> }).rememberConversationThread({
			threadId: "thread-durable-1",
			ephemeral: false,
			modelId: "gpt-5.6-terra",
			runtimeKey: "runtime-key",
			toolCatalogKey: "tools-key",
			callableNames: new Set(["read_file"]),
			toolNamespaces: new Map<string, string>(),
			toolSignatures: new Map([["read_file", "signature"]]),
			copilotConversationId: "conversation-1",
			copilotTurnIndex: 1,
			anchor: createCodexConversationAnchor([vscode.LanguageModelChatMessage.User("request")], "answer"),
			lastUsedAt: Date.now() - 5 * 60 * 60_000,
			processGeneration: 0,
		});
		assert.strictEqual(updateCompleted, true);
		provider.dispose();

		const restored = new CodexChatModelProvider("test", undefined, workspaceState);
		const threads = (restored as unknown as { conversationThreads: Map<string, { ephemeral: boolean; processGeneration: number }> })
			.conversationThreads;
		assert.strictEqual(threads.size, 1);
		assert.strictEqual(threads.get("thread-durable-1")?.ephemeral, false);
		assert.strictEqual(threads.get("thread-durable-1")?.processGeneration, -1);
		restored.dispose();
	});

	test("arms an explicit Codex rollover for the newest durable thread", async () => {
		const values = new Map<string, unknown>();
		const workspaceState = {
			keys: () => [...values.keys()],
			get: <T>(key: string, defaultValue?: T): T | undefined =>
				(values.has(key) ? values.get(key) as T : defaultValue),
			update: async (key: string, value: unknown): Promise<void> => {
				values.set(key, value);
			},
		} as vscode.Memento;
		const provider = new CodexChatModelProvider("test", undefined, workspaceState);
		await (provider as unknown as { rememberConversationThread(value: unknown): Promise<void> }).rememberConversationThread({
			threadId: "thread-rollover-1",
			ephemeral: false,
			modelId: "codex::gpt-5.6-terra",
			runtimeKey: "runtime-key",
			toolCatalogKey: "tools-key",
			callableNames: new Set(["read_file"]),
			toolNamespaces: new Map<string, string>(),
			toolSignatures: new Map([["read_file", "signature"]]),
			copilotConversationId: "large-chat",
			copilotTurnIndex: 42,
			anchor: createCodexConversationAnchor([vscode.LanguageModelChatMessage.User("request")], "answer"),
			lastUsedAt: Date.now(),
			processGeneration: 0,
		});

		const prepared = await provider.prepareLatestDurableThreadRollover();
		assert.strictEqual(prepared.modelId, "codex::gpt-5.6-terra");
		assert.strictEqual(prepared.sourceConversationId, "large-chat");
		assert.deepStrictEqual(
			values.get("llamacpp.codexPendingRollover.v1"),
			{
				threadId: "thread-rollover-1",
				modelId: "codex::gpt-5.6-terra",
				sourceConversationId: "large-chat",
				armedAt: (values.get("llamacpp.codexPendingRollover.v1") as { armedAt: number }).armedAt,
			}
		);
		provider.dispose();
	});

	test("reattaches a durable Codex thread with thread/resume", async () => {
		const provider = new CodexChatModelProvider("test");
		const calls: Array<{ method: string; params: unknown; timeoutMs: number | undefined }> = [];
		const fakeClient = {
			generation: 7,
			request: async (method: string, params: unknown, timeoutMs?: number) => {
				calls.push({ method, params, timeoutMs });
				return {
					thread: { id: "thread-durable-1", ephemeral: false, historyMode: "legacy" },
					model: "gpt-5.6-terra",
					modelProvider: "openai",
				};
			},
			dispose: () => undefined,
		};
		const internals = provider as unknown as {
			client: typeof fakeClient;
			reattachDurableThread(value: Record<string, unknown>): Promise<boolean>;
		};
		Object.defineProperty(internals, "client", { value: fakeClient });
		const conversation = {
			threadId: "thread-durable-1",
			ephemeral: false,
			modelId: "gpt-5.6-terra",
			runtimeKey: "runtime-key",
			toolCatalogKey: "tools-key",
			callableNames: new Set<string>(),
			toolNamespaces: new Map<string, string>(),
			toolSignatures: new Map<string, string>(),
			anchor: createCodexConversationAnchor([vscode.LanguageModelChatMessage.User("request")], "answer"),
			lastUsedAt: Date.now(),
			processGeneration: -1,
		};
		assert.strictEqual(await internals.reattachDurableThread(conversation), true);
		const policy = createCodexVsCodeOnlyPolicy();
		assert.strictEqual(calls.length, 1);
		const resumeCall = calls[0];
		assert.strictEqual(resumeCall.method, "thread/resume");
		assert.strictEqual(resumeCall.timeoutMs, 15_000);
		const resumeParams = resumeCall.params as Record<string, unknown>;
		assert.strictEqual(typeof resumeParams.developerInstructions, "string");
		assert.ok(String(resumeParams.developerInstructions).length > 100);
		assert.deepStrictEqual({ ...resumeParams, developerInstructions: undefined }, {
			developerInstructions: undefined,
			threadId: "thread-durable-1",
			excludeTurns: true,
			model: "gpt-5.6-terra",
			cwd: normalizeCodexRuntimeCwd(
				vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
			),
			approvalPolicy: policy.approvalPolicy,
			sandbox: policy.sandbox,
			config: policy.config,
		});
		assert.strictEqual(conversation.processGeneration, 7);
		provider.dispose();
	});

	test("adds model-routing guidance to the native subagent tool", () => {
		const dynamic = buildCodexDynamicTools([{
			name: "runSubagent",
			description: "Run a listed agent",
			inputSchema: { type: "object" },
		}]);
		const tool = dynamic.specs.find(spec => spec.type === "function");
		assert.ok(tool && tool.type === "function");
		assert.ok(tool.description.includes("Subagent model routing"));
		assert.ok(tool.description.includes("Never omit runSubagent.model"));
	});

	test("defers uncommon Codex tools while keeping the core agent loop eager", () => {
		const tools: vscode.LanguageModelChatTool[] = [
			{ name: "read_file", description: "Read a workspace file", inputSchema: { type: "object" } },
			{ name: "run_in_terminal", description: "Run a command", inputSchema: { type: "object" } },
			{ name: "llamacpp_search_memory", description: "Search memory", inputSchema: { type: "object" } },
			{ name: "specialized_private_tool", description: "Rare tool", inputSchema: { type: "object" } },
		];
		const dynamic = buildCodexDynamicTools(tools, { deferNonCoreTools: true });
		const eagerNames = dynamic.specs
			.filter(tool => tool.type === "function")
			.map(tool => tool.name);
		const namespace = dynamic.specs.find(tool => tool.type === "namespace");
		assert.deepStrictEqual(eagerNames, ["read_file", "run_in_terminal"]);
		assert.ok(namespace && namespace.type === "namespace");
		assert.strictEqual(namespace.name, CODEX_DEFERRED_TOOL_NAMESPACE);
		assert.deepStrictEqual(namespace.tools.map(tool => tool.name), ["llamacpp_search_memory", "specialized_private_tool"]);
		assert.ok(namespace.tools.every(tool => tool.deferLoading === true));
		assert.deepStrictEqual(dynamic.deferredNames, new Set(["llamacpp_search_memory", "specialized_private_tool"]));
		assert.deepStrictEqual(dynamic.toolNamespaces, new Map([
			["llamacpp_search_memory", CODEX_DEFERRED_TOOL_NAMESPACE],
			["specialized_private_tool", CODEX_DEFERRED_TOOL_NAMESPACE],
		]));
		assert.deepStrictEqual(
			dynamic.runtimeSignatures.filter(tool => tool.deferLoading).map(tool => tool.namespace),
			[CODEX_DEFERRED_TOOL_NAMESPACE, CODEX_DEFERRED_TOOL_NAMESPACE]
		);
	});

	test("namespaces VS Code tools that collide with built-in Codex tools", () => {
		const tools: vscode.LanguageModelChatTool[] = [
			{ name: "read_file", description: "Read a workspace file", inputSchema: { type: "object" } },
			{ name: "apply_patch", description: "Apply a patch", inputSchema: { type: "object" } },
			{ name: "view_image", description: "View an image", inputSchema: { type: "object" } },
		];
		const dynamic = buildCodexDynamicTools(tools, { deferNonCoreTools: true });
		const nativeNamespace = dynamic.specs.find(
			tool => tool.type === "namespace" && tool.name === CODEX_NATIVE_TOOL_NAMESPACE
		);
		assert.ok(nativeNamespace && nativeNamespace.type === "namespace");
		assert.deepStrictEqual(nativeNamespace.tools.map(tool => tool.name), ["apply_patch", "view_image"]);
		assert.ok(nativeNamespace.tools.every(tool => tool.deferLoading !== true));
		assert.deepStrictEqual(dynamic.toolNamespaces, new Map([
			["apply_patch", CODEX_NATIVE_TOOL_NAMESPACE],
			["view_image", CODEX_NATIVE_TOOL_NAMESPACE],
		]));
		assert.deepStrictEqual(
			dynamic.runtimeSignatures.filter(tool => tool.namespace === CODEX_NATIVE_TOOL_NAMESPACE).map(tool => tool.name),
			["apply_patch", "view_image"]
		);
	});

	test("routes namespaced dynamic tools only through their declared namespace", async () => {
		const provider = new CodexChatModelProvider("test");
		const delegatedTools: string[] = [];
		const internals = provider as unknown as {
			dynamicToolContexts: Map<string, {
				callableNames: ReadonlySet<string>;
				toolNamespaces: ReadonlyMap<string, string>;
				delegate: (call: { tool: string }) => Promise<{ contentItems: Array<{ type: "inputText"; text: string }>; success: boolean }>;
			}>;
			handleDynamicToolCall: (params: Record<string, unknown>) => Promise<{ success: boolean }> | { success: boolean };
		};
		internals.dynamicToolContexts.set("thread", {
			callableNames: new Set(["create_directory", "apply_patch"]),
			toolNamespaces: new Map([
				["create_directory", CODEX_DEFERRED_TOOL_NAMESPACE],
				["apply_patch", CODEX_NATIVE_TOOL_NAMESPACE],
			]),
			delegate: async call => {
				delegatedTools.push(call.tool);
				return { contentItems: [{ type: "inputText", text: "ok" }], success: true };
			},
		});

		const rejected = await internals.handleDynamicToolCall({
			threadId: "thread",
			callId: "wrong-namespace",
			tool: "create_directory",
			namespace: null,
			arguments: { path: "tmp" },
		});
		assert.strictEqual(rejected.success, false);
		const accepted = await internals.handleDynamicToolCall({
			threadId: "thread",
			callId: "correct-namespace",
			tool: "create_directory",
			namespace: CODEX_DEFERRED_TOOL_NAMESPACE,
			arguments: { path: "tmp" },
		});
		assert.strictEqual(accepted.success, true);
		const nativeAccepted = await internals.handleDynamicToolCall({
			threadId: "thread",
			callId: "native-namespace",
			tool: "apply_patch",
			namespace: CODEX_NATIVE_TOOL_NAMESPACE,
			arguments: { patch: "test" },
		});
		assert.strictEqual(nativeAccepted.success, true);
		assert.deepStrictEqual(delegatedTools, ["create_directory", "apply_patch"]);
		provider.dispose();
	});

	test("declines every internal Codex approval request", async () => {
		const provider = new CodexChatModelProvider("test");
		const internals = provider as unknown as {
			handleServerRequest(request: { id: number; method: string; params: unknown }): Promise<unknown>;
		};
		assert.deepStrictEqual(await internals.handleServerRequest({
			id: 1,
			method: "item/commandExecution/requestApproval",
			params: { threadId: "strict", command: "echo bypass" },
		}), { decision: "decline" });
		assert.deepStrictEqual(await internals.handleServerRequest({
			id: 2,
			method: "item/fileChange/requestApproval",
			params: { threadId: "strict" },
		}), { decision: "decline" });
		assert.deepStrictEqual(await internals.handleServerRequest({
			id: 3,
			method: "item/permissions/requestApproval",
			params: { threadId: "strict", permissions: { network: true } },
		}), { permissions: {}, scope: "turn" });
		provider.dispose();
	});

	test("formats Codex subscription usage", () => {
		const formatted = formatCodexRateLimit({
			limitId: "codex",
			limitName: null,
			primary: { usedPercent: 12.4, windowDurationMins: 10080, resetsAt: null },
			secondary: null,
			planType: "plus",
			rateLimitReachedType: null,
		});
		assert.strictEqual(formatted, "12% used / resets unknown reset");
	});

	test("uses current request usage instead of cumulative thread billing for context", () => {
		const metrics = mapCodexTokenUsageMetrics("gpt-test", {
			total: {
				totalTokens: 12_889_873,
				inputTokens: 12_865_404,
				cachedInputTokens: 12_485_632,
				outputTokens: 24_469,
				reasoningOutputTokens: 6_991,
			},
			last: {
				totalTokens: 126_998,
				inputTokens: 126_146,
				cachedInputTokens: 125_696,
				outputTokens: 852,
				reasoningOutputTokens: 516,
			},
			modelContextWindow: 258_400,
		});
		assert.strictEqual(metrics.contextUsedTokens, 126_998);
		assert.strictEqual(metrics.contextWindowTokens, 258_400);
		assert.ok((metrics.contextUsagePercent ?? 0) > 49 && (metrics.contextUsagePercent ?? 0) < 50);
		assert.ok(metrics.contextDetail?.includes("thread cumulative usage 12,889,873"));
	});

	test("combines catalogs and routes prefixed Codex model ids", async () => {
		const calls: string[] = [];
		const makeProvider = (id: string, marker: string): vscode.LanguageModelChatProvider => ({
			provideLanguageModelChatInformation: async () => [{
				id,
				name: id,
				family: marker,
				version: "1",
				maxInputTokens: 100,
				maxOutputTokens: 20,
				capabilities: {},
			}],
			provideLanguageModelChatResponse: async () => {
				calls.push(marker);
			},
			provideTokenCount: async () => marker === "codex" ? 2 : 1,
		});
		const provider = new CompositeChatModelProvider(
			makeProvider("local::qwen", "local"),
			makeProvider("codex::gpt-test", "codex")
		);
		const tokenSource = new vscode.CancellationTokenSource();
		const infos = await provider.provideLanguageModelChatInformation({ silent: true }, tokenSource.token);
		assert.deepStrictEqual(infos.map(info => info.id), ["codex::gpt-test", "local::qwen"]);

		const codexInfo = infos.find(info => info.id.startsWith("codex::"));
		assert.ok(codexInfo);
		await provider.provideLanguageModelChatResponse(
			codexInfo!,
			[],
			{ tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
			{ report: () => undefined },
			tokenSource.token
		);
		assert.deepStrictEqual(calls, ["codex"]);
		assert.strictEqual(await provider.provideTokenCount(codexInfo!, "test", tokenSource.token), 2);
		provider.dispose();
		tokenSource.dispose();
	});

	test("refreshes Claude availability in background for another provider", async () => {
		const events: string[] = [];
		let releaseRefresh!: () => void;
		let markRefreshDone!: () => void;
		const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
		const refreshDone = new Promise<void>(resolve => { markRefreshDone = resolve; });
		const makeProvider = (marker: string): vscode.LanguageModelChatProvider => ({
			provideLanguageModelChatInformation: async () => [],
			provideLanguageModelChatResponse: async () => { events.push(marker); },
			provideTokenCount: async () => 1,
		});
		const claude = {
			...makeProvider("claude"),
			refreshSubscriptionUsage: async () => {
				events.push("availability-started");
				await refreshGate;
				events.push("availability-finished");
				markRefreshDone();
			},
		} as unknown as ClaudeChatModelProvider;
		const provider = new CompositeChatModelProvider(
			makeProvider("local"),
			makeProvider("codex"),
			claude
		);
		const tokenSource = new vscode.CancellationTokenSource();
		await provider.provideLanguageModelChatResponse(
			{
				id: "codex::gpt-test",
				name: "Codex",
				family: "codex",
				version: "1",
				maxInputTokens: 100,
				maxOutputTokens: 20,
				capabilities: {},
			},
			[],
			{ tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
			{ report: () => undefined },
			tokenSource.token
		);
		assert.deepStrictEqual(events, ["availability-started", "codex"]);
		releaseRefresh();
		await refreshDone;
		assert.deepStrictEqual(events, ["availability-started", "codex", "availability-finished"]);
		provider.dispose();
		tokenSource.dispose();
	});
});
