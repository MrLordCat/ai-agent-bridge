import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { LlamaCppChatModelProvider, stripCacheControlArtifacts } from "../llama-provider";
import { injectSharedMemoryContext } from "../memory/prompt";
import { ToolCallValidationError, type ToolCallReliabilityMetrics } from "../tools/tool-call-reliability";
import type { OpenAIChatMessage, OpenAIFunctionToolDef } from "../types";
import { convertMessages, convertTools, validateRequest } from "../utils";

// Mock SecretStorage
class MockSecretStorage implements vscode.SecretStorage {
    private secrets = new Map<string, string>();
    get(key: string): Thenable<string | undefined> {
        return Promise.resolve(this.secrets.get(key));
    }
    store(key: string, value: string): Thenable<void> {
        this.secrets.set(key, value);
        return Promise.resolve();
    }
    delete(key: string): Thenable<void> {
        this.secrets.delete(key);
        return Promise.resolve();
    }
    keys(): Thenable<string[]> {
        return Promise.resolve(Array.from(this.secrets.keys()));
    }
    onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event;
}

/** Simple in-memory Memento that survives provider restarts in tests. */
class MockMemento implements vscode.Memento {
    private store = new Map<string, unknown>();
    keys(): readonly string[] { return [...this.store.keys()]; }
    get<T>(key: string): T | undefined { return this.store.get(key) as T | undefined; }
    update(key: string, value: unknown): Thenable<void> { this.store.set(key, value); return Promise.resolve(); }
}

suite("Llama.cpp Chat Provider Extension", () => {
    suite("provider", () => {
        const secretStorage = new MockSecretStorage();
        const provider = new LlamaCppChatModelProvider(secretStorage, "test-user-agent");
		const configureStreamingTools = (names: readonly string[]): void => {
			(provider as unknown as {
				configureToolCallReliability: (
					tools: readonly OpenAIFunctionToolDef[],
					options: { repairEnabled: boolean; validateSchema: boolean }
				) => void;
			}).configureToolCallReliability(
				names.map(name => ({
					type: "function",
					function: { name, parameters: { type: "object" } },
				})),
				{ repairEnabled: true, validateSchema: true }
			);
		};

        test("provideLanguageModelChatInformation returns array (defaults)", async () => {
            const infos = await provider.provideLanguageModelChatInformation(
                { silent: true },
                new vscode.CancellationTokenSource().token
            );
            // It might fail if no server running, but it returns array (empty or populated)
            assert.ok(Array.isArray(infos));
        });

		test("keeps primary and DeepSeek API keys separate", async () => {
			const isolatedSecrets = new MockSecretStorage();
			await isolatedSecrets.store("llamacpp.apiKey", "primary-key");
			await isolatedSecrets.store("llamacpp.deepSeekApiKey", "deepseek-key");
			const isolatedProvider = new LlamaCppChatModelProvider(isolatedSecrets, "test-user-agent");
			const providerAny = isolatedProvider as unknown as {
				getModelSources: () => Promise<Array<{ key: string; apiKey?: string }>>;
			};

			const sources = await providerAny.getModelSources();
			assert.strictEqual(sources.find(source => source.key === "primary")?.apiKey, "primary-key");
			assert.strictEqual(sources.find(source => source.key === "deepseek")?.apiKey, "deepseek-key");
		});

		test("health check warns about retired DeepSeek aliases", async () => {
			const providerAny = provider as unknown as {
				getModelSources: () => Promise<Array<{
					key: string;
					label: string;
					serverUrl: string;
					apiKey?: string;
				}>>;
				fetchModels: () => Promise<Array<{ id: string }>>;
			};
			const originalGetModelSources = providerAny.getModelSources;
			const originalFetchModels = providerAny.fetchModels;

			try {
				providerAny.getModelSources = async () => [{
					key: "deepseek",
					label: "DeepSeek",
					serverUrl: "https://api.deepseek.com",
				}];
				providerAny.fetchModels = async () => [{ id: "deepseek-chat" }];
				const report = await provider.runHealthCheck(
					"test",
					new vscode.CancellationTokenSource().token
				);
				assert.strictEqual(report.sources[0].checks.find(check =>
					check.id === "deprecated-model-alias"
				)?.status, "warning");
				assert.strictEqual(report.overallStatus, "warning");
			} finally {
				providerAny.getModelSources = originalGetModelSources;
				providerAny.fetchModels = originalFetchModels;
			}
		});

        test("discovers local and DeepSeek models as separate sources", async () => {
            const providerAny = provider as unknown as {
                getModelSources: () => Promise<Array<{
                    key: string;
                    label: string;
                    serverUrl: string;
                    apiKey?: string;
                    familyOverride?: string;
                    contextLengthOverride?: number;
                    contextLengthFallback?: number;
                }>>;
                getRuntimeContextLengthWithCache: () => Promise<number | undefined>;
                fetchModelsWithInflightCache: (
                    serverUrl: string,
                    apiKey: string | undefined,
                    apiKeyPresent: boolean
                ) => Promise<Array<{ id: string }>>;
            };
            const originalGetModelSources = providerAny.getModelSources;
            const originalGetRuntimeContextLengthWithCache = providerAny.getRuntimeContextLengthWithCache;
            const originalFetchModelsWithInflightCache = providerAny.fetchModelsWithInflightCache;

            try {
                provider.refreshLanguageModelChatInformation();
                providerAny.getModelSources = async () => [
                    {
                        key: "local",
                        label: "Local",
                        serverUrl: "http://localhost:8000",
                        familyOverride: "auto",
                        contextLengthFallback: 65536,
                    },
                    {
                        key: "deepseek",
                        label: "DeepSeek",
                        serverUrl: "https://api.deepseek.com",
                        apiKey: "sk-test",
                        familyOverride: "deepseek",
                        contextLengthOverride: 1048576,
                    },
                ];
                providerAny.getRuntimeContextLengthWithCache = async () => undefined;
                providerAny.fetchModelsWithInflightCache = async serverUrl =>
                    serverUrl.includes("deepseek")
                        ? [{ id: "deepseek-v4-pro" }]
                        : [{ id: "qwen3-local" }];

                const infos = await provider.provideLanguageModelChatInformation(
                    { silent: true },
                    new vscode.CancellationTokenSource().token
                );

                const ids = infos.map(info => info.id).sort();
                assert.deepStrictEqual(ids, ["deepseek::deepseek-v4-pro", "local::qwen3-local"]);
                assert.ok(infos.some(info => info.name.includes("(Local)")));
                assert.ok(infos.some(info => info.name.includes("(DeepSeek)")));

                const deepSeekInfo = infos.find(info => info.id === "deepseek::deepseek-v4-pro");
                assert.ok(deepSeekInfo);
                assert.strictEqual(deepSeekInfo!.maxOutputTokens, 70000);
            } finally {
                providerAny.getModelSources = originalGetModelSources;
                providerAny.getRuntimeContextLengthWithCache = originalGetRuntimeContextLengthWithCache;
                providerAny.fetchModelsWithInflightCache = originalFetchModelsWithInflightCache;
            }
        });

        test("advertises llama.cpp vision from models capabilities and props modalities", async () => {
            const providerAny = provider as unknown as {
                getModelSources: () => Promise<Array<{
                    key: string;
                    label: string;
                    serverUrl: string;
                    familyOverride?: string;
                    contextLengthFallback?: number;
                }>>;
                getRuntimeContextLengthWithCache: () => Promise<number | undefined>;
            };
            const originalGetModelSources = providerAny.getModelSources;
            const originalGetRuntimeContextLengthWithCache = providerAny.getRuntimeContextLengthWithCache;
            const originalFetch = globalThis.fetch;

            try {
                provider.refreshLanguageModelChatInformation();
                providerAny.getModelSources = async () => [{
                    key: "local",
                    label: "Local",
                    serverUrl: "http://localhost:8000",
                    familyOverride: "auto",
                    contextLengthFallback: 65536,
                }];
                providerAny.getRuntimeContextLengthWithCache = async () => 262144;
                globalThis.fetch = (async (input: string | URL | Request) => {
                    const url = String(input);
                    if (url.endsWith("/props")) {
                        return new Response(JSON.stringify({
                            modalities: { vision: true, audio: false },
                        }), { status: 200, headers: { "content-type": "application/json" } });
                    }
                    if (url.endsWith("/v1/models")) {
                        return new Response(JSON.stringify({
                            models: [{
                                model: "Qwen3.6-27B-Q3_K_S_mtp.gguf",
                                capabilities: ["completion", "multimodal"],
                            }],
                            data: [{
                                id: "Qwen3.6-27B-Q3_K_S_mtp.gguf",
                                meta: { n_ctx_train: 262144 },
                            }],
                        }), { status: 200, headers: { "content-type": "application/json" } });
                    }
                    throw new Error(`unexpected fetch: ${url}`);
                }) as typeof fetch;

                const infos = await provider.provideLanguageModelChatInformation(
                    { silent: true },
                    new vscode.CancellationTokenSource().token
                );

                assert.strictEqual(infos.length, 1);
                assert.strictEqual(infos[0].id, "local::Qwen3.6-27B-Q3_K_S_mtp.gguf");
                assert.strictEqual(infos[0].capabilities.imageInput, true);
            } finally {
                providerAny.getModelSources = originalGetModelSources;
                providerAny.getRuntimeContextLengthWithCache = originalGetRuntimeContextLengthWithCache;
                globalThis.fetch = originalFetch;
                provider.refreshLanguageModelChatInformation();
            }
        });

        test("uses local runtime context before local fallback context", async () => {
            const providerAny = provider as unknown as {
                getModelSources: () => Promise<Array<{
                    key: string;
                    label: string;
                    serverUrl: string;
                    apiKey?: string;
                    familyOverride?: string;
                    contextLengthOverride?: number;
                    contextLengthFallback?: number;
                }>>;
                getRuntimeContextLengthWithCache: () => Promise<number | undefined>;
                fetchModelsWithInflightCache: () => Promise<Array<{ id: string }>>;
            };
            const originalGetModelSources = providerAny.getModelSources;
            const originalGetRuntimeContextLengthWithCache = providerAny.getRuntimeContextLengthWithCache;
            const originalFetchModelsWithInflightCache = providerAny.fetchModelsWithInflightCache;

            try {
                provider.refreshLanguageModelChatInformation();
                providerAny.getModelSources = async () => [
                    {
                        key: "local",
                        label: "Local",
                        serverUrl: "http://localhost:8000",
                        familyOverride: "auto",
                        contextLengthFallback: 65536,
                    },
                ];
                providerAny.getRuntimeContextLengthWithCache = async () => 131072;
                providerAny.fetchModelsWithInflightCache = async () => [{ id: "qwen3-local" }];

                const infos = await provider.provideLanguageModelChatInformation(
                    { silent: true },
                    new vscode.CancellationTokenSource().token
                );

                assert.strictEqual(infos.length, 1);
                assert.strictEqual(infos[0].maxInputTokens + infos[0].maxOutputTokens, 131072);
                assert.ok(infos[0].maxInputTokens > 90000);
                assert.ok(infos[0].maxOutputTokens <= 32768);
                assert.ok(String(infos[0].tooltip).includes("Context: 131072 tokens"));
            } finally {
                providerAny.getModelSources = originalGetModelSources;
                providerAny.getRuntimeContextLengthWithCache = originalGetRuntimeContextLengthWithCache;
                providerAny.fetchModelsWithInflightCache = originalFetchModelsWithInflightCache;
            }
        });

        test("routes prefixed local model requests to the local server", async () => {
            const providerAny = provider as unknown as {
                getModelSources: () => Promise<Array<{
                    key: string;
                    label: string;
                    serverUrl: string;
                    apiKey?: string;
                    familyOverride?: string;
                    contextLengthOverride?: number;
                    contextLengthFallback?: number;
                }>>;
                getRuntimeContextLengthWithCache: () => Promise<number | undefined>;
                acquireChatRequestSlot: (
                    requestId: string,
                    queueTimeoutMs: number,
                    token: vscode.CancellationToken
                ) => Promise<{ release: () => void; waitMs: number }>;
                sendChatCompletion: (
                    serverUrl: string,
                    headers: Record<string, string>,
                    requestBody: Record<string, unknown>,
                    timeoutMs: number,
                    token: vscode.CancellationToken
                ) => Promise<Response>;
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };
            const originalGetModelSources = providerAny.getModelSources;
            const originalGetRuntimeContextLengthWithCache = providerAny.getRuntimeContextLengthWithCache;
            const originalAcquireChatRequestSlot = providerAny.acquireChatRequestSlot;
            const originalSendChatCompletion = providerAny.sendChatCompletion;
            const originalProcessStreamingResponse = providerAny.processStreamingResponse;
            const sent: Array<{ serverUrl: string; requestBody: Record<string, unknown> }> = [];
            const reportedParts: vscode.LanguageModelResponsePart[] = [];

            try {
                providerAny.getModelSources = async () => [
                    {
                        key: "local",
                        label: "Local",
                        serverUrl: "http://localhost:8000",
                        familyOverride: "auto",
                        contextLengthFallback: 65536,
                    },
                    {
                        key: "deepseek",
                        label: "DeepSeek",
                        serverUrl: "https://api.deepseek.com",
                        apiKey: "sk-test",
                        familyOverride: "deepseek",
                        contextLengthOverride: 1048576,
                    },
                ];
                providerAny.getRuntimeContextLengthWithCache = async () => 65536;
                providerAny.acquireChatRequestSlot = async () => ({ release: () => undefined, waitMs: 0 });
                providerAny.sendChatCompletion = async (serverUrl, _headers, requestBody) => {
                    sent.push({
                        serverUrl,
                        requestBody: JSON.parse(JSON.stringify(requestBody)) as Record<string, unknown>,
                    });
                    return new Response(
                        new ReadableStream<Uint8Array>({
                            start(controller) {
                                controller.close();
                            },
                        }),
                        { status: 200 }
                    );
                };
                providerAny.processStreamingResponse = async (_responseBody, progress) => {
                    progress.report(new vscode.LanguageModelTextPart("local answer"));
                };

                await provider.provideLanguageModelChatResponse(
                    {
                        id: "local::qwen3-local",
                        name: "qwen3-local (Local)",
                        family: "qwen",
                        version: "1",
                        maxInputTokens: 60000,
                        maxOutputTokens: 4096,
                        capabilities: {},
                    } as unknown as vscode.LanguageModelChatInformation,
                    [vscode.LanguageModelChatMessage.User("hello")],
                    {
                        modelOptions: {},
                        tools: [],
                        toolMode: vscode.LanguageModelChatToolMode.Auto,
                    },
                    { report: part => reportedParts.push(part) },
                    new vscode.CancellationTokenSource().token
                );
            } finally {
                providerAny.getModelSources = originalGetModelSources;
                providerAny.getRuntimeContextLengthWithCache = originalGetRuntimeContextLengthWithCache;
                providerAny.acquireChatRequestSlot = originalAcquireChatRequestSlot;
                providerAny.sendChatCompletion = originalSendChatCompletion;
                providerAny.processStreamingResponse = originalProcessStreamingResponse;
            }

            assert.strictEqual(sent.length, 1);
            assert.strictEqual(sent[0].serverUrl, "http://localhost:8000");
            assert.strictEqual(sent[0].requestBody.model, "qwen3-local");
            assert.deepStrictEqual(sent[0].requestBody.stream_options, { include_usage: true });

            const usagePart = reportedParts.find(
                (part): part is vscode.LanguageModelDataPart =>
                    part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage"
            );
            assert.ok(usagePart, "expected native usage response data");
            const usage = JSON.parse(new TextDecoder().decode(usagePart.data)) as Record<string, number>;
            assert.ok(usage.prompt_tokens > 0);
            assert.ok(usage.completion_tokens > 0);
            assert.strictEqual(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
        });

        test("provideTokenCount calculation for text", async () => {
            const count = await provider.provideTokenCount(
                {} as vscode.LanguageModelChatInformation,
                "hello world",
                new vscode.CancellationTokenSource().token
            );
            assert.strictEqual(count, 3); // "hello world".length / 4 ceil = 11/4 = 2.75 -> 3
        });

        test("provideTokenCount estimates tool and data parts", async () => {
            const message = {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [
                    new vscode.LanguageModelToolCallPart("call-1", "read_file", { path: "README.md" }),
                    new vscode.LanguageModelToolResultPart("call-1", [new vscode.LanguageModelTextPart("file content")]),
                    vscode.LanguageModelDataPart.text("structured payload", "text/plain"),
                ],
            } as unknown as vscode.LanguageModelChatRequestMessage;

            const count = await provider.provideTokenCount(
                {} as vscode.LanguageModelChatInformation,
                message,
                new vscode.CancellationTokenSource().token
            );

            assert.ok(count > 0);
        });

        test("compact summary redacts verbose tool payloads", () => {
            const providerAny = provider as unknown as {
                compactOpenAiMessages: (
                    messages: Array<{
                        role: "system" | "user" | "assistant" | "tool";
                        content?: string;
                        name?: string;
                        tool_calls?: Array<{ function?: { name?: string } }>;
                    }>,
                    tokenBudget: number,
                    keepLastCount: number,
                    label: string
                ) => Array<{ role: string; content?: string }>;
            };

            const longToolPayload = "tool-payload-very-long-1234567890".repeat(40);
            // tokenBudget must be low enough that messages exceed it,
            // otherwise compactMessages returns them as-is (no summary).
            const compacted = providerAny.compactOpenAiMessages(
                [
                    { role: "system", content: "sys" },
                    { role: "user", content: "start" },
                    {
                        role: "assistant",
                        tool_calls: [{ function: { name: "read_file" } }],
                    },
                    {
                        role: "tool",
                        name: "read_file",
                        content: longToolPayload,
                    },
                    { role: "user", content: "latest" },
                ],
                10,
                1,
                "Conversation summary (auto-compact)"
            );

            const summary = compacted.find(msg => msg.role === "user" && typeof msg.content === "string" && msg.content.includes("Conversation summary"));
            assert.ok(summary && typeof summary.content === "string");
            assert.ok(summary!.content!.includes("[tool_result read_file]"));
            assert.ok(summary!.content!.includes("[tool_calls] read_file"));
            assert.ok(!summary!.content!.includes(longToolPayload.slice(0, 80)));
        });

        test("truncates oversized tool results", () => {
            const providerAny = provider as unknown as {
                truncateToolResultMessages: (
                    messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content?: string }>,
                    maxChars: number,
                    requestId: string
                ) => Array<{ role: string; content?: string }>;
            };

            const longToolPayload = "tool-output-".repeat(200);
            const truncated = providerAny.truncateToolResultMessages(
                [{ role: "tool", content: longToolPayload }],
                120,
                "test-request"
            );

            assert.ok(typeof truncated[0].content === "string");
            assert.ok(truncated[0].content!.length < longToolPayload.length);
            assert.ok(truncated[0].content!.includes("tool result summarized"));
        });

        test("never summarizes a large system prompt as a tool result", () => {
            const providerAny = provider as unknown as {
                truncateToolResultMessages: (
                    messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content?: string }>,
                    maxChars: number,
                    requestId: string
                ) => Array<{ role: string; content?: string }>;
            };

            const longSystemPrompt = "You are a careful coding agent. ".repeat(200).trimEnd();
            const result = providerAny.truncateToolResultMessages(
                [
                    { role: "system", content: longSystemPrompt },
                    { role: "assistant", content: "x".repeat(500) },
                ],
                120,
                "test-request"
            );

            assert.strictEqual(result[0].content, longSystemPrompt);
            assert.strictEqual(result[1].content, "x".repeat(500));
        });

	test("counts tool execution errors only after the turn's query", () => {
		const providerAny = provider as unknown as {
			truncateToolResultMessages: (
				messages: Array<{ role: string; content?: string; tool_call_id?: string }>,
				maxChars: number,
				requestId: string
			) => Array<{ role: string; content?: string }>;
			lastToolExecutionErrorCount: number;
			lastToolExecutionErrorDetails: Array<{ name?: string; command?: string; head?: string }>;
		};

		const failing = { role: "tool", tool_call_id: "call_new_1", content: "Traceback (most recent call last): boom" };
		const ok = { role: "tool", tool_call_id: "call_new_2", content: "successfully edited: x" };
		const oldFailing = { role: "tool", tool_call_id: "call_old_1", content: "Traceback (most recent call last): boom" };
		const oldOk = { role: "tool", tool_call_id: "call_old_2", content: "file contents" };
		const query = { role: "user", content: "check the logs" };

		// History before the query is never re-counted; only this turn's
		// results (after the query) are.
		providerAny.lastToolExecutionErrorCount = 0;
		providerAny.truncateToolResultMessages(
			[oldFailing, oldOk, query, failing, ok],
			100_000,
			"test-request"
		);
		assert.strictEqual(providerAny.lastToolExecutionErrorCount, 1);
		assert.strictEqual(providerAny.lastToolExecutionErrorDetails[0]?.head, "Traceback (most recent call last): boom");

		// A compaction summary is a user message but must not split the turn:
		// it sits before the query and both are "before fresh".
		providerAny.lastToolExecutionErrorCount = 0;
		providerAny.truncateToolResultMessages(
			[
				{ role: "user", content: "Conversation summary (auto-compact): prior" },
				query,
				failing,
			],
			100_000,
			"test-request"
		);
		assert.strictEqual(providerAny.lastToolExecutionErrorCount, 1);

		// No plain user query in the batch (image-only or system-only) →
		// nothing is classified as fresh, so history can never inflate.
		providerAny.lastToolExecutionErrorCount = 0;
		providerAny.truncateToolResultMessages(
			[oldFailing, failing],
			100_000,
			"test-request"
		);
		assert.strictEqual(providerAny.lastToolExecutionErrorCount, 0);
	});

	test("ignores grep-style exit code 1 but keeps real failures", () => {
		const providerAny = provider as unknown as {
			truncateToolResultMessages: (
				messages: Array<{
					role: string;
					content?: string;
					tool_call_id?: string;
					tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
				}>,
				maxChars: number,
				requestId: string
			) => Array<{ role: string; content?: string }>;
			lastToolExecutionErrorCount: number;
			lastToolExecutionErrorDetails: Array<{ name?: string; command?: string; head?: string }>;
		};
		const query = { role: "user", content: "audit" };

		// grep found nothing: short output + exit 1 → not an error.
		providerAny.lastToolExecutionErrorCount = 0;
		providerAny.truncateToolResultMessages(
			[query, { role: "tool", content: "log: test.jsonl\n0\n\nCommand exited with code 1" }],
			100_000,
			"test-request"
		);
		assert.strictEqual(providerAny.lastToolExecutionErrorCount, 0);

		// grep-style exit 1 with a camelCase identifier in the output (e.g.
		// `lastToolExecutionErrorCount` printed by a diagnostics loop) must not
		// match the failure signal — "error" inside a word is not an error.
		providerAny.lastToolExecutionErrorCount = 0;
		providerAny.truncateToolResultMessages(
			[query, { role: "tool", content: "=== src/llama-provider.ts ===\nlastToolExecutionErrorCount: 4\n\nCommand exited with code 1" }],
			100_000,
			"test-request"
		);
		assert.strictEqual(providerAny.lastToolExecutionErrorCount, 0);

		// Real compiler failure: exit 1 + "error TS" in the output → counted.
		providerAny.lastToolExecutionErrorCount = 0;
		providerAny.truncateToolResultMessages(
			[query, { role: "tool", content: "> tsc -p ./\nsrc/a.ts(1,1): error TS2322: Type mismatch\n\nCommand exited with code 1" }],
			100_000,
			"test-request"
		);
		assert.strictEqual(providerAny.lastToolExecutionErrorCount, 1);

		// Exit codes 2+ always count.
		providerAny.lastToolExecutionErrorCount = 0;
		providerAny.truncateToolResultMessages(
			[query, { role: "tool", content: "boom\nCommand exited with code 2" }],
			100_000,
			"test-request"
		);
		assert.strictEqual(providerAny.lastToolExecutionErrorCount, 1);

		// The failing command itself is recorded for the report.
		providerAny.lastToolExecutionErrorCount = 0;
		providerAny.truncateToolResultMessages(
			[
				query,
				{
					role: "assistant",
					content: "",
					tool_calls: [{ id: "call_x1", type: "function", function: { name: "run_in_terminal", arguments: '{"command":"npm run compile"}' } }],
				},
				{ role: "tool", tool_call_id: "call_x1", content: "error TS2322\n\nCommand exited with code 1" },
			],
			100_000,
			"test-request"
		);
		assert.strictEqual(providerAny.lastToolExecutionErrorCount, 1);
		assert.strictEqual(providerAny.lastToolExecutionErrorDetails[0]?.name, "run_in_terminal");
		assert.strictEqual(providerAny.lastToolExecutionErrorDetails[0]?.command, "npm run compile");
	});

        test("strips every cache_control marker shape so tool text stays stable", () => {
            // Shape VS Code emits today; the previous regex did not match it and the
            // leftover marker moved between turns, breaking the cached prefix.
            const modern = 'result {"type":"data","mimeType":"cache_control","bytes":9} tail';
            assert.strictEqual(stripCacheControlArtifacts(modern), "result  tail");

            const reordered = 'a {"bytes":9,"mimeType":"cache_control","type":"data"} b';
            assert.strictEqual(stripCacheControlArtifacts(reordered), "a  b");

            const textual = "output line\n[data cache_control, 9 bytes]";
            assert.strictEqual(stripCacheControlArtifacts(textual), "output line\n");

            // Unrelated JSON must survive untouched.
            const unrelated = '{"mimeType":"text/plain","data":"keep"}';
            assert.strictEqual(stripCacheControlArtifacts(unrelated), unrelated);

            // Nested markers are removed without eating the enclosing object.
            const nested = '{"a":1,"parts":[{"type":"data","mimeType":"cache_control","bytes":9}],"b":2}';
            assert.strictEqual(stripCacheControlArtifacts(nested), '{"a":1,"parts":[],"b":2}');

            // Idempotent: sanitising twice must not change the result again.
            const once = stripCacheControlArtifacts(modern);
            assert.strictEqual(stripCacheControlArtifacts(once), once);
        });

        test("drops cache_control parts before they reach message text", () => {
            // A data part that lost its Uint8Array payload crossing the extension
            // host boundary used to fall through to JSON.stringify and land in the
            // tool result text, which moved between turns and broke the prefix.
            const serializedMarker = { $mid: 17, mimeType: "cache_control", data: "QUJD" };
            const messages = [
                vscode.LanguageModelChatMessage.Assistant([
                    new vscode.LanguageModelToolCallPart("call-1", "read_file", { path: "a.txt" }),
                ]),
                vscode.LanguageModelChatMessage.User([
                    new vscode.LanguageModelToolResultPart("call-1", [
                        new vscode.LanguageModelTextPart("file contents"),
                        serializedMarker as unknown as vscode.LanguageModelTextPart,
                    ]),
                ]),
            ];

            const converted = convertMessages(messages, { toolResultMode: "tool" });
            const serialized = JSON.stringify(converted);
            assert.ok(!serialized.includes("cache_control"), "no marker may survive into the request");
            assert.ok(serialized.includes("file contents"), "real tool output must be preserved");
        });

        test("keeps historical reasoning stable across turns and parallel conversations", () => {
            const memento = new MockMemento();
            const target = new LlamaCppChatModelProvider(new MockSecretStorage(), "test-user-agent", undefined, undefined, memento);
            const api = target as unknown as {
                setReasoningScope: (scope: string | undefined) => void;
                rememberReasoningValueForToolCall: (callId: string, reasoning: string) => void;
                injectStoredReasoningContent: (messages: OpenAIChatMessage[]) => OpenAIChatMessage[];
            };

            const toolCallMessage = (callId: string): OpenAIChatMessage => ({
                role: "assistant",
                content: "",
                tool_calls: [{
                    id: callId,
                    type: "function" as const,
                    function: { name: "read_file", arguments: "{}" },
                }],
            });

            api.setReasoningScope("chat-a");
            api.rememberReasoningValueForToolCall("call-early", "early-reasoning");

            // A second conversation stores far more entries than the old global
            // 256-entry budget allowed, which used to evict "call-early".
            api.setReasoningScope("chat-b");
            for (let index = 0; index < 600; index += 1) {
                api.rememberReasoningValueForToolCall(`b-${index}`, `reasoning-${index}`);
            }

            api.setReasoningScope("chat-a");
            const history: OpenAIChatMessage[] = [
                { role: "system", content: "system" },
                { role: "user", content: "first" },
                toolCallMessage("call-early"),
                { role: "tool", tool_call_id: "call-early", content: "result" },
                { role: "user", content: "next" },
            ];

            const injected = api.injectStoredReasoningContent(history);
            assert.strictEqual(
                injected[2].reasoning_content,
                "early-reasoning",
                "a busy parallel conversation must not evict this conversation's reasoning"
            );
        });

        test("binds fallback reasoning to call ids so the prefix stops drifting", async () => {
            const memento = new MockMemento();
            const target = new LlamaCppChatModelProvider(new MockSecretStorage(), "test-user-agent", undefined, undefined, memento);
            const api = target as unknown as {
                setReasoningScope: (scope: string | undefined) => void;
                injectStoredReasoningContent: (messages: OpenAIChatMessage[]) => OpenAIChatMessage[];
            };
            const state = target as unknown as { _currentTurnReasoningContent: string };

            api.setReasoningScope("chat-drift");
            state._currentTurnReasoningContent = "turn-1-reasoning";

            const first: OpenAIChatMessage[] = [
                { role: "user", content: "go" },
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [{ id: "call-1", type: "function" as const, function: { name: "read_file", arguments: "{}" } }],
                },
            ];
            const firstPass = api.injectStoredReasoningContent(first);
            assert.strictEqual(firstPass[1].reasoning_content, "turn-1-reasoning");

            // Next turn appends another tool call, so the positional fallback moves on.
            state._currentTurnReasoningContent = "turn-2-reasoning";
            const second: OpenAIChatMessage[] = [
                ...first,
                { role: "tool", tool_call_id: "call-1", content: "result" },
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [{ id: "call-2", type: "function" as const, function: { name: "read_file", arguments: "{}" } }],
                },
            ];
            const secondPass = api.injectStoredReasoningContent(second);
            assert.strictEqual(
                secondPass[1].reasoning_content,
                "turn-1-reasoning",
                "the earlier message must keep the reasoning it was already sent with"
            );
            assert.strictEqual(secondPass[3].reasoning_content, "turn-2-reasoning");
        });

        test("strips reasoning the host already serialized into assistant content", () => {
            const memento = new MockMemento();
            const target = new LlamaCppChatModelProvider(new MockSecretStorage(), "test-user-agent", undefined, undefined, memento);
            const api = target as unknown as {
                stripReasoningDuplicatesFromContent: (messages: OpenAIChatMessage[]) => OpenAIChatMessage[];
            };

            const reasoning = "I need to inspect the file first. Let me read it and check its contents before answering.";
            const answer = "The file contains the expected value.";
            const messages: OpenAIChatMessage[] = [
                {
                    role: "assistant",
                    content: `${reasoning}${answer}`,
                    reasoning_content: reasoning,
                    tool_calls: [{ id: "call-1", type: "function" as const, function: { name: "read_file", arguments: "{}" } }],
                },
                // Content that only shares a short coincidental prefix stays untouched.
                {
                    role: "assistant",
                    content: `${reasoning.slice(0, 40)} but then something different`,
                    reasoning_content: reasoning,
                },
                // Non-assistant messages and messages without reasoning are untouched.
                { role: "user", content: "hi" },
            ];

            const stripped = api.stripReasoningDuplicatesFromContent(messages);
            assert.strictEqual(stripped[0].content, answer, "the duplicated reasoning prefix must be removed");
            assert.strictEqual(stripped[0].reasoning_content, reasoning, "reasoning_content must be preserved");
            assert.strictEqual(
                stripped[1].content,
                `${reasoning.slice(0, 40)} but then something different`,
                "short coincidental prefixes must not be stripped"
            );
            assert.strictEqual(stripped[2].content, "hi");
        });

        test("restores reasoning from the snapshot when the host rewrote the history", () => {
            const memento = new MockMemento();
            const target = new LlamaCppChatModelProvider(new MockSecretStorage(), "test-user-agent", undefined, undefined, memento);
            const api = target as unknown as {
                restoreReasoningFromSnapshot: (messages: OpenAIChatMessage[], snapshot: OpenAIChatMessage[]) => OpenAIChatMessage[];
            };

            const snapshot: OpenAIChatMessage[] = [
                { role: "user", content: "go" },
                {
                    role: "assistant",
                    content: "answer",
                    reasoning_content: "old-thoughts",
                    tool_calls: [{ id: "call-1", type: "function" as const, function: { name: "read_file", arguments: "{}" } }],
                },
            ];
            // The host rewrote the assistant message (new content, reasoning
            // dropped) but kept the same call id.
            const rewritten: OpenAIChatMessage[] = [
                { role: "user", content: "go" },
                {
                    role: "assistant",
                    content: "rewritten",
                    tool_calls: [{ id: "call-1", type: "function" as const, function: { name: "read_file", arguments: "{}" } }],
                },
                { role: "tool", tool_call_id: "call-1", content: "result" },
            ];

            const restored = api.restoreReasoningFromSnapshot(rewritten, snapshot);
            assert.strictEqual(restored[1].reasoning_content, "old-thoughts", "reasoning must be carried over by call id");

            // Unknown call ids never receive foreign reasoning.
            const foreign: OpenAIChatMessage[] = [
                {
                    role: "assistant",
                    content: "x",
                    tool_calls: [{ id: "call-9", type: "function" as const, function: { name: "read_file", arguments: "{}" } }],
                },
            ];
            const untouched = api.restoreReasoningFromSnapshot(foreign, snapshot);
            assert.strictEqual(untouched[0].reasoning_content, undefined);
        });

        test("keeps the tail stable when the host truncates messages it already sent", () => {
            const memento = new MockMemento();
            const target = new LlamaCppChatModelProvider(new MockSecretStorage(), "test-user-agent", undefined, undefined, memento);
            const api = target as unknown as {
                stabilizeTailFromSnapshot: (tail: OpenAIChatMessage[], snapshotPrefix: OpenAIChatMessage[]) => OpenAIChatMessage[];
            };

            const fullToolResult = "FULL TOOL RESULT ".repeat(50);
            const snapshotPrefix: OpenAIChatMessage[] = [
                { role: "user", content: "go" },
                {
                    role: "assistant",
                    content: "answer",
                    reasoning_content: "thoughts",
                    tool_calls: [{ id: "call-1", type: "function" as const, function: { name: "read_file", arguments: "{}" } }],
                },
                { role: "tool", tool_call_id: "call-1", content: fullToolResult },
            ];
            // The host rewrote the tail: the tool result it already sent is now
            // truncated, and one genuinely new user message was added. The
            // rewritten tail must be replaced by the snapshot version (the
            // prompt weight must stay monotonic, the cache prefix stable),
            // while genuinely new messages stay as the host provided them.
            const hostTail: OpenAIChatMessage[] = [
                { role: "tool", tool_call_id: "call-1", content: "TRUNCATED" },
                { role: "user", content: "new question" },
            ];

            const stabilized = api.stabilizeTailFromSnapshot(hostTail, snapshotPrefix);
            assert.strictEqual(
                stabilized[0].content,
                fullToolResult,
                "a rewritten tool result with a known call id must keep the snapshot version"
            );
            assert.strictEqual(stabilized[1].content, "new question", "genuinely new messages must stay from the host");
            assert.strictEqual(stabilized[0].tool_call_id, "call-1");

            // Unknown call ids are never replaced.
            const foreignTail: OpenAIChatMessage[] = [
                { role: "tool", tool_call_id: "call-99", content: "fresh" },
            ];
            const untouched = api.stabilizeTailFromSnapshot(foreignTail, snapshotPrefix);
            assert.strictEqual(untouched[0].content, "fresh");
        });

        test("serializes local chat request slots", async () => {
            const providerAny = provider as unknown as {
                acquireChatRequestSlot: (
                    requestId: string,
                    queueTimeoutMs: number,
                    token: vscode.CancellationToken
                ) => Promise<{ release: () => void; waitMs: number }>;
            };
            const token = new vscode.CancellationTokenSource().token;
            const firstLease = await providerAny.acquireChatRequestSlot("first", 0, token);
            let secondAcquired = false;
            const secondSlot = providerAny.acquireChatRequestSlot("second", 0, token).then(lease => {
                secondAcquired = true;
                return lease;
            });

            await Promise.resolve();
            assert.strictEqual(secondAcquired, false);

            firstLease.release();
            const secondLease = await secondSlot;
            assert.strictEqual(secondAcquired, true);
            secondLease.release();
        });

        test("streams <think> blocks as thinking and keeps final visible answer", async () => {
            const providerAny = provider as unknown as {
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };

            const encoder = new TextEncoder();
            const payload =
                "data: {\"choices\":[{\"delta\":{\"content\":\"<think>reasoning path</think>final answer\"}}]}\n\n" +
                "data: [DONE]\n\n";
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(payload));
                    controller.close();
                },
            });

            const parts: vscode.LanguageModelResponsePart[] = [];
            await providerAny.processStreamingResponse(
                stream,
                {
                    report: part => parts.push(part),
                },
                new vscode.CancellationTokenSource().token
            );

            const text = parts
                .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
                .map(part => part.value)
                .join("");
            const hasThinkingPart = parts.some(part => (part as { constructor?: { name?: string } }).constructor?.name === "LanguageModelThinkingPart");
            const hasNonTextPart = parts.some(part => !(part instanceof vscode.LanguageModelTextPart));

            assert.ok(text.includes("final answer"));
            assert.ok(!text.includes("<think>"));
            assert.ok(hasThinkingPart || hasNonTextPart || text.includes("reasoning path"));
        });

        test("streams reasoning_content deltas as thinking when available", async () => {
            const providerAny = provider as unknown as {
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
                getEmittedThinkingText: (part: unknown) => string | undefined;
            };

            const encoder = new TextEncoder();
            const payload =
                "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"step 1 -> step 2\"}}]}\n\n" +
                "data: {\"choices\":[{\"delta\":{\"content\":\"done\"}}]}\n\n" +
                "data: [DONE]\n\n";
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(payload));
                    controller.close();
                },
            });

            const parts: vscode.LanguageModelResponsePart[] = [];
            await providerAny.processStreamingResponse(
                stream,
                {
                    report: part => parts.push(part),
                },
                new vscode.CancellationTokenSource().token
            );

            const text = parts
                .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
                .map(part => part.value)
                .join("");
            const hasThinkingPart = parts.some(part => (part as { constructor?: { name?: string } }).constructor?.name === "LanguageModelThinkingPart");
            const hasNonTextPart = parts.some(part => !(part instanceof vscode.LanguageModelTextPart));
            const measuredThinking = parts
                .map(part => providerAny.getEmittedThinkingText(part))
                .filter((value): value is string => typeof value === "string")
                .join("");

            assert.ok(text.includes("done"));
            assert.ok(hasThinkingPart || hasNonTextPart || text.includes("step 1 -> step 2"));
            assert.strictEqual(measuredThinking, "step 1 -> step 2");
        });

        test("retains native thinking for the next DeepSeek tool turn", async () => {
            class NativeThinkingPart {
                constructor(
                    readonly text: string,
                    readonly id?: string,
                    readonly metadata?: unknown
                ) {}
            }

            const isolatedProvider = new LlamaCppChatModelProvider(new MockSecretStorage(), "test-user-agent");
            const providerAny = isolatedProvider as unknown as {
                getThinkingConstructor: () => (new (text: string, id?: string, metadata?: unknown) => unknown) | undefined;
                configureToolCallReliability: (
                    tools: readonly OpenAIFunctionToolDef[],
                    options: { repairEnabled: boolean; validateSchema: boolean }
                ) => void;
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
                getCurrentTurnReasoningContent: () => string;
                injectStoredReasoningContent: (messages: OpenAIChatMessage[]) => OpenAIChatMessage[];
            };
            providerAny.getThinkingConstructor = () => NativeThinkingPart;
            providerAny.configureToolCallReliability(
                [{
                    type: "function",
                    function: {
                        name: "list_dir",
                        parameters: {
                            type: "object",
                            properties: { path: { type: "string" } },
                            required: ["path"],
                        },
                    },
                }],
                { repairEnabled: true, validateSchema: true }
            );

            const encoder = new TextEncoder();
            const payload =
                "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"inspect the project first\"}}]}\n\n" +
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-native-thinking\",\"function\":{\"name\":\"list_dir\",\"arguments\":\"{\\\"path\\\":\\\"D:/Game\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n" +
                "data: [DONE]\n\n";
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(payload));
                    controller.close();
                },
            });

            const parts: vscode.LanguageModelResponsePart[] = [];
            await providerAny.processStreamingResponse(
                stream,
                { report: part => parts.push(part) },
                new vscode.CancellationTokenSource().token
            );

            assert.ok(parts.some(part => part instanceof NativeThinkingPart));
            const toolCall = parts.find(
                (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
            );
            assert.ok(toolCall);
            assert.strictEqual(providerAny.getCurrentTurnReasoningContent(), "inspect the project first");

            const nextMessages = providerAny.injectStoredReasoningContent([
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [{
                        id: "old-call",
                        type: "function",
                        function: { name: "list_dir", arguments: "{\"path\":\"D:/Old\"}" },
                    }],
                },
                { role: "tool", tool_call_id: "old-call", content: "old directory contents" },
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [{
                        id: toolCall.callId,
                        type: "function",
                        function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) },
                    }],
                },
                { role: "tool", tool_call_id: toolCall.callId, content: "directory contents" },
            ]);
            assert.strictEqual(nextMessages[0].reasoning_content, undefined);
            assert.strictEqual(nextMessages[2].reasoning_content, "inspect the project first");
            assert.strictEqual(providerAny.getCurrentTurnReasoningContent(), "inspect the project first");

            const finalStream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\n\n" +
                        "data: [DONE]\n\n"
                    ));
                    controller.close();
                },
            });
            await providerAny.processStreamingResponse(
                finalStream,
                { report: () => undefined },
                new vscode.CancellationTokenSource().token
            );
            assert.strictEqual(providerAny.getCurrentTurnReasoningContent(), "");
        });

        test("loses historical reasoning_content after simulated restart, breaking cache prefix", async () => {
            // This test reproduces the DeepSeek prompt-cache regression:
            // after a VS Code restart, the in-memory _reasoningByToolCallId map is
            // lost.  VS Code may also omit LanguageModelThinkingPart from the
            // replayed history.  injectStoredReasoningContent then cannot restore
            // reasoning_content for historical tool-call messages, so the outgoing
            // prefix differs from what DeepSeek previously cached → cache miss.

            class NativeThinkingPart {
                constructor(
                    readonly text: string,
                    readonly id?: string,
                    readonly metadata?: unknown
                ) {}
            }

            // --- Turn 1: model responds with reasoning and a tool call ---
            const memento = new MockMemento();
            const preRestart = new LlamaCppChatModelProvider(new MockSecretStorage(), "test-user-agent", undefined, undefined, memento);
            const pre = preRestart as unknown as {
                getThinkingConstructor: () => (new (text: string, id?: string, metadata?: unknown) => unknown) | undefined;
                configureToolCallReliability: (
                    tools: readonly OpenAIFunctionToolDef[],
                    options: { repairEnabled: boolean; validateSchema: boolean }
                ) => void;
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
                getCurrentTurnReasoningContent: () => string;
                getReasoningForToolCall: (callId: string) => string | undefined;
                injectStoredReasoningContent: (messages: OpenAIChatMessage[]) => OpenAIChatMessage[];
            };
            pre.getThinkingConstructor = () => NativeThinkingPart;
            pre.configureToolCallReliability(
                [{
                    type: "function",
                    function: {
                        name: "read_file",
                        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
                    },
                }],
                { repairEnabled: true, validateSchema: true }
            );

            const encoder = new TextEncoder();
            const stream1 = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(
                        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"turn-1-reasoning\"}}]}\n\n" +
                        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-turn1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"D:/a.txt\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n" +
                        "data: [DONE]\n\n"
                    ));
                    controller.close();
                },
            });
            const turn1Parts: vscode.LanguageModelResponsePart[] = [];
            await pre.processStreamingResponse(stream1, { report: p => turn1Parts.push(p) }, new vscode.CancellationTokenSource().token);

            const toolCall1 = turn1Parts.find(
                (p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart
            );
            assert.ok(toolCall1, "expected a tool call in turn 1 response");
            assert.strictEqual(pre.getCurrentTurnReasoningContent(), "turn-1-reasoning");
            assert.strictEqual(pre.getReasoningForToolCall(toolCall1.callId), "turn-1-reasoning");

            // Verify: same provider can inject reasoning for its own call
            const beforeRestart = pre.injectStoredReasoningContent([
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [{
                        id: toolCall1.callId,
                        type: "function" as const,
                        function: { name: toolCall1.name, arguments: JSON.stringify(toolCall1.input) },
                    }],
                },
                { role: "tool", tool_call_id: toolCall1.callId, content: "file contents" },
                { role: "user", content: "next question" },
            ]);
            assert.strictEqual(beforeRestart[0].reasoning_content, "turn-1-reasoning",
                "pre-restart: reasoning should be injected via exact callId match");

            // --- Simulate VS Code / Extension Host restart ---
            // A fresh provider has an empty _reasoningByToolCallId map and empty
            // _currentTurnReasoningContent.  VS Code history may also omit
            // LanguageModelThinkingPart, so convertMessages won't add reasoning_content.
            const postRestart = new LlamaCppChatModelProvider(new MockSecretStorage(), "test-user-agent", undefined, undefined, memento);
            const post = postRestart as unknown as {
                getCurrentTurnReasoningContent: () => string;
                getReasoningForToolCall: (callId: string) => string | undefined;
                injectStoredReasoningContent: (messages: OpenAIChatMessage[]) => OpenAIChatMessage[];
            };

            // Map is empty — nothing persisted across the restart.
            assert.strictEqual(post.getCurrentTurnReasoningContent(), "",
                "after restart: current turn reasoning should be empty");
            assert.strictEqual(post.getReasoningForToolCall(toolCall1.callId), undefined,
                "after restart: reasoning map has no entry for the historical call");

            // The messages below represent what convertMessages produces after
            // restart when VS Code drops thinking parts: tool-call messages
            // without reasoning_content.
            const historicalWithoutReasoning: OpenAIChatMessage[] = [
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [{
                        id: toolCall1.callId,
                        type: "function" as const,
                        function: { name: toolCall1.name, arguments: JSON.stringify(toolCall1.input) },
                    }],
                    // Intentionally NO reasoning_content — simulates VS Code history
                    // that lost LanguageModelThinkingPart across restart.
                },
                { role: "tool", tool_call_id: toolCall1.callId, content: "file contents" },
                { role: "user", content: "next question" },
            ];

            const afterRestart = post.injectStoredReasoningContent(historicalWithoutReasoning);

            // THIS IS THE BUG: after restart, historical tool-call messages
            // cannot get their reasoning restored.  The outgoing prefix differs
            // from what DeepSeek previously cached → permanent cache miss.
            assert.strictEqual(
                afterRestart[0].reasoning_content,
                "turn-1-reasoning",
                "BUG: reasoning should survive restart (via persistence to globalState). " +
                "Without it, the first request after restart has a different prefix, " +
                "and DeepSeek cache misses for every historical tool-call message."
            );
        });

        test("prefix drifts across turns after restart because only the newest call gets reasoning", async () => {
            // After restart, injectStoredReasoningContent only restores reasoning
            // for the last tool-call message via the fallback.  Historical
            // messages remain without reasoning until their callIds happen to be
            // re-added to the map over many turns.  Each turn the prefix changes
            // because a different message gains reasoning_content.

            class NativeThinkingPart {
                constructor(
                    readonly text: string,
                    readonly id?: string,
                    readonly metadata?: unknown
                ) {}
            }

            const encoder = new TextEncoder();

            function makeStream(reasoning: string, callId: string, callName: string, callArgs: string): ReadableStream<Uint8Array> {
                return new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(encoder.encode(
                            `data: {"choices":[{"delta":{"reasoning_content":"${reasoning}"}}]}\n\n` +
                            `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${callId}","function":{"name":"${callName}","arguments":"${callArgs.replace(/"/g, '\\"')}"}}]},"finish_reason":"tool_calls"}]}\n\n` +
                            "data: [DONE]\n\n"
                        ));
                        controller.close();
                    },
                });
            }

            // --- Turn 1: first call ---
            const memento2 = new MockMemento();
            const prov = new LlamaCppChatModelProvider(new MockSecretStorage(), "test-user-agent", undefined, undefined, memento2);
            const p = prov as unknown as {
                getThinkingConstructor: () => (new (text: string, id?: string, metadata?: unknown) => unknown) | undefined;
                configureToolCallReliability: (
                    tools: readonly OpenAIFunctionToolDef[],
                    options: { repairEnabled: boolean; validateSchema: boolean }
                ) => void;
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
                getCurrentTurnReasoningContent: () => string;
                getReasoningForToolCall: (callId: string) => string | undefined;
                injectStoredReasoningContent: (messages: OpenAIChatMessage[]) => OpenAIChatMessage[];
            };
            p.getThinkingConstructor = () => NativeThinkingPart;
            p.configureToolCallReliability(
                [
                    { type: "function", function: { name: "read_file", parameters: { type: "object" } } },
                    { type: "function", function: { name: "grep_search", parameters: { type: "object" } } },
                ],
                { repairEnabled: true, validateSchema: true }
            );

            // Turn 1: reason_A, call_A
            await p.processStreamingResponse(
                makeStream("reason-A", "call-A", "read_file", '{"path":"D:/a.txt"}'),
                { report: () => undefined },
                new vscode.CancellationTokenSource().token
            );

            // Turn 2: reason_B, call_B
            await p.processStreamingResponse(
                makeStream("reason-B", "call-B", "grep_search", '{"query":"test"}'),
                { report: () => undefined },
                new vscode.CancellationTokenSource().token
            );

            // After 2 turns, both callIds should be in the map
            assert.strictEqual(p.getReasoningForToolCall("call-A"), "reason-A");
            assert.strictEqual(p.getReasoningForToolCall("call-B"), "reason-B");

            // Now build messages representing a 3-turn history where BOTH
            // historical tool-call messages are present.
            const fullHistory: OpenAIChatMessage[] = [
                {
                    role: "assistant", content: "",
                    tool_calls: [{ id: "call-A", type: "function" as const, function: { name: "read_file", arguments: '{"path":"D:/a.txt"}' } }],
                },
                { role: "tool", tool_call_id: "call-A", content: "content A" },
                { role: "user", content: "next" },
                {
                    role: "assistant", content: "",
                    tool_calls: [{ id: "call-B", type: "function" as const, function: { name: "grep_search", arguments: '{"query":"test"}' } }],
                },
                { role: "tool", tool_call_id: "call-B", content: "content B" },
                { role: "user", content: "one more" },
            ];

            const withReasoning = p.injectStoredReasoningContent(fullHistory);
            assert.strictEqual(withReasoning[0].reasoning_content, "reason-A",
                "call-A should get its own reasoning via exact callId match");
            assert.strictEqual(withReasoning[3].reasoning_content, "reason-B",
                "call-B should get its own reasoning via exact callId match");

            // --- Simulate restart: new provider, empty map ---
            const prov2 = new LlamaCppChatModelProvider(new MockSecretStorage(), "test-user-agent", undefined, undefined, memento2);
            const p2 = prov2 as unknown as {
                getCurrentTurnReasoningContent: () => string;
                getReasoningForToolCall: (callId: string) => string | undefined;
                injectStoredReasoningContent: (messages: OpenAIChatMessage[]) => OpenAIChatMessage[];
            };
            assert.strictEqual(p2.getReasoningForToolCall("call-A"), undefined);
            assert.strictEqual(p2.getReasoningForToolCall("call-B"), undefined);

            // After restart, NEITHER historical call gets reasoning.
            const afterRestartAll = p2.injectStoredReasoningContent(fullHistory);
            assert.strictEqual(
                afterRestartAll[0].reasoning_content,
                "reason-A",
                "BUG: call-A should get reasoning restored after restart"
            );
            assert.strictEqual(
                afterRestartAll[3].reasoning_content,
                "reason-B",
                "BUG: call-B should get reasoning restored after restart"
            );

            // ---- Now simulate Turn 3 after restart ----
            // One new turn populates the map with call-C, but call-A and
            // call-B are still missing.  This shows why the prefix keeps
            // changing across turns.
            const prov3 = new LlamaCppChatModelProvider(new MockSecretStorage(), "test-user-agent", undefined, undefined, memento2);
            const p3 = prov3 as unknown as {
                getThinkingConstructor: () => (new (text: string, id?: string, metadata?: unknown) => unknown) | undefined;
                configureToolCallReliability: (tools: readonly OpenAIFunctionToolDef[], o: { repairEnabled: boolean; validateSchema: boolean }) => void;
                processStreamingResponse: (b: ReadableStream<Uint8Array>, pr: vscode.Progress<vscode.LanguageModelResponsePart>, t: vscode.CancellationToken) => Promise<void>;
                getCurrentTurnReasoningContent: () => string;
                getReasoningForToolCall: (callId: string) => string | undefined;
                injectStoredReasoningContent: (messages: OpenAIChatMessage[]) => OpenAIChatMessage[];
            };
            p3.getThinkingConstructor = () => NativeThinkingPart;
            p3.configureToolCallReliability(
                [{ type: "function", function: { name: "grep_search", parameters: { type: "object" } } }],
                { repairEnabled: true, validateSchema: true }
            );
            await p3.processStreamingResponse(
                makeStream("reason-C", "call-C", "grep_search", '{"query":"new"}'),
                { report: () => undefined },
                new vscode.CancellationTokenSource().token
            );

            // With persistence, loadPersistedReasoningMap inside processStreamingResponse
            // restores call-A and call-B before streaming adds call-C.
            assert.strictEqual(p3.getReasoningForToolCall("call-A"), "reason-A");
            assert.strictEqual(p3.getReasoningForToolCall("call-B"), "reason-B");
            assert.strictEqual(p3.getReasoningForToolCall("call-C"), "reason-C");

            // History now includes call-A, call-B, AND call-C.
            const extendedHistory: OpenAIChatMessage[] = [
                ...fullHistory,
                {
                    role: "assistant", content: "",
                    tool_calls: [{ id: "call-C", type: "function" as const, function: { name: "grep_search", arguments: '{"query":"new"}' } }],
                },
                { role: "tool", tool_call_id: "call-C", content: "content C" },
                { role: "user", content: "final" },
            ];

            const afterTurn3 = p3.injectStoredReasoningContent(extendedHistory);
            // With persistence, all historical calls retain their reasoning.
            assert.strictEqual(
                afterTurn3[0].reasoning_content,
                "reason-A",
                "call-A should keep its reasoning across turns with persistence"
            );
            assert.strictEqual(
                afterTurn3[3].reasoning_content,
                "reason-B",
                "call-B should keep its reasoning across turns with persistence"
            );
            // call-C gets reasoning from exact match (map has it).
            assert.strictEqual(afterTurn3[6].reasoning_content, "reason-C");
        });

        test("keeps the API Direct tool prefix stable within one Copilot conversation", () => {
            const providerAny = provider as unknown as {
                stabilizeToolCatalog: (
                    modelId: string,
                    options: vscode.ProvideLanguageModelChatResponseOptions,
                    config: ReturnType<typeof convertTools>,
                    messages: readonly OpenAIChatMessage[],
                    requestId: string
                ) => ReturnType<typeof convertTools>;
            };
            const tool = (name: string): vscode.LanguageModelChatTool => ({
                name,
                description: name,
                inputSchema: { type: "object", properties: {} },
            });
            const baseOptions = {
                modelOptions: { _copilotConversationId: "conversation-cache-1" },
                tools: [tool("y_tool"), tool("z_tool")],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
            } as vscode.ProvideLanguageModelChatResponseOptions;
            const expandedOptions = {
                modelOptions: { _copilotConversationId: "conversation-cache-1" },
                tools: [tool("a_tool"), tool("y_tool"), tool("z_tool")],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
            } as vscode.ProvideLanguageModelChatResponseOptions;
            const first = providerAny.stabilizeToolCatalog(
                "deepseek-v4-pro",
                baseOptions,
                convertTools(baseOptions, { mode: "apiDirect", apiDirectMaxTools: 2 }),
                [{ role: "user", content: "first" }],
                "request-1"
            );
            const second = providerAny.stabilizeToolCatalog(
                "deepseek-v4-pro",
                expandedOptions,
                convertTools(expandedOptions, { mode: "apiDirect", apiDirectMaxTools: 2 }),
                [{ role: "user", content: "next" }],
                "request-2"
            );
            assert.deepStrictEqual(second.tools, first.tools);
        });

        test("restores host-rewritten history without dropping the new turn", () => {
            const providerAny = provider as unknown as {
                stabilizeMessagePrefix: (
                    requestId: string,
                    modelId: string,
                    scope: string | undefined,
                    messages: OpenAIChatMessage[],
                    staticFieldsHash: string,
                    toolsHash: string,
                    toolsCount: number,
                    toolNames: string[]
                ) => { messages: OpenAIChatMessage[]; stabilized: boolean };
            };
            const history = (tree: string, answer: string): OpenAIChatMessage[] => [
                { role: "system", content: "You are a careful coding agent." },
                { role: "user", content: `Fix it\n<workspace_info>\n${tree}\n</workspace_info>` },
                {
                    role: "assistant",
                    content: "checking",
                    tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
                },
                { role: "tool", tool_call_id: "call-1", content: answer },
            ];
            const stabilize = (messages: OpenAIChatMessage[], requestId: string) => providerAny.stabilizeMessagePrefix(
                requestId,
                "deepseek-v4-pro",
                "conversation-prefix-1",
                messages,
                "static-hash",
                "tools-hash",
                1,
                ["read_file"]
            );

            stabilize(history("src/a.ts", "full result"), "request-1");
            // The host re-renders the workspace tree and re-summarizes the tool
            // result, then appends this turn's new user message.
            const rewritten = [
                ...history("src/a.ts\nsnapshot.html", "result [summarized]"),
                { role: "user", content: "and now this" } as OpenAIChatMessage,
            ];
            const result = stabilize(rewritten, "request-2");

            assert.strictEqual(result.stabilized, true);
            assert.deepStrictEqual(result.messages.slice(0, 4), history("src/a.ts", "full result"));
            assert.deepStrictEqual(result.messages[4], { role: "user", content: "and now this" });
        });

        test("persists the stabilized prefix that was actually sent", () => {
            const providerAny = provider as unknown as {
                stabilizeMessagePrefix: (
                    requestId: string,
                    modelId: string,
                    scope: string | undefined,
                    messages: OpenAIChatMessage[],
                    staticFieldsHash: string,
                    toolsHash: string,
                    toolsCount: number,
                    toolNames: string[]
                ) => { messages: OpenAIChatMessage[]; stabilized: boolean };
            };
            const history = (reasoning: string | undefined, tail: string): OpenAIChatMessage[] => [
                { role: "system", content: "system" },
                { role: "user", content: "inspect" },
                {
                    role: "assistant",
                    content: "checking",
                    reasoning_content: reasoning,
                    tool_calls: [{ id: "call-reasoning", type: "function", function: { name: "read_file", arguments: "{}" } }],
                },
                { role: "tool", tool_call_id: "call-reasoning", content: "result" },
                { role: "user", content: tail },
            ];
            const stabilize = (messages: OpenAIChatMessage[], requestId: string) => providerAny.stabilizeMessagePrefix(
                requestId,
                "deepseek-v4-flash",
                "conversation-prefix-reasoning",
                messages,
                "static-hash",
                "tools-hash",
                1,
                ["read_file"]
            );

            stabilize(history("stable reasoning", "turn one"), "request-reasoning-1");
            const second = stabilize(
                [...history(undefined, "turn one"), { role: "user", content: "turn two" }],
                "request-reasoning-2"
            );
            const third = stabilize(
                [...history(undefined, "turn one"), { role: "user", content: "turn two" }, { role: "user", content: "turn three" }],
                "request-reasoning-3"
            );

            assert.strictEqual(second.messages[2].reasoning_content, "stable reasoning");
            assert.strictEqual(
                third.messages[2].reasoning_content,
                "stable reasoning",
                "the next prefix must reuse the stabilized version sent on the previous request"
            );
        });

        test("keeps live shared memory while restoring a durable snapshot prefix", () => {
            const providerAny = provider as unknown as {
                stabilizeMessagePrefix: (
                    requestId: string,
                    modelId: string,
                    scope: string | undefined,
                    messages: OpenAIChatMessage[],
                    staticFieldsHash: string,
                    toolsHash: string,
                    toolsCount: number,
                    toolNames: string[]
                ) => { messages: OpenAIChatMessage[]; stabilized: boolean; prefix: Record<string, unknown> };
            };
            const durable = (workspace: string, result: string): OpenAIChatMessage[] => [
                { role: "system", content: "system" },
                { role: "user", content: `inspect\n<workspace_info>\n${workspace}\n</workspace_info>` },
                {
                    role: "assistant",
                    content: "reading",
                    tool_calls: [{ id: "call-memory", type: "function", function: { name: "read_file", arguments: "{}" } }],
                },
                { role: "tool", tool_call_id: "call-memory", content: result },
            ];
            const stabilize = (messages: OpenAIChatMessage[], requestId: string) => providerAny.stabilizeMessagePrefix(
                requestId,
                "deepseek-v4-pro",
                "conversation-prefix-memory",
                messages,
                "static-hash",
                "tools-hash",
                1,
                ["read_file"]
            );

            const first = injectSharedMemoryContext(durable("src/a.ts", "full result"), "memory turn one");
            const firstResult = stabilize(first, "request-memory-1");
            assert.strictEqual(firstResult.prefix.messageCount, 4, "memory must stay outside the durable snapshot");
            assert.strictEqual(typeof firstResult.prefix.ephemeralHash, "string");
            assert.ok(Number(firstResult.prefix.ephemeralChars) > 0);

            const secondDurable: OpenAIChatMessage[] = [
                ...durable("src/a.ts\nsrc/b.ts", "result [summarized]"),
                {
                    role: "assistant",
                    content: "checking",
                    tool_calls: [{ id: "call-next", type: "function", function: { name: "grep_search", arguments: "{}" } }],
                },
                { role: "tool", tool_call_id: "call-next", content: "fresh result" },
            ];
            const second = injectSharedMemoryContext(secondDurable, "memory turn two");
            const result = stabilize(second, "request-memory-2");
            const memoryMessages = result.messages.filter(message => message.ephemeral);

            assert.strictEqual(result.stabilized, true);
            assert.strictEqual(result.prefix.ephemeralChanged, true, "changed memory must be visible to cache diagnostics");
            assert.strictEqual(result.prefix.previousEphemeralHash, firstResult.prefix.ephemeralHash);
            assert.strictEqual(memoryMessages.length, 1, "current shared memory must reach every request");
            assert.match(String(memoryMessages[0].content), /memory turn two/);
            assert.strictEqual(
                result.messages.filter(message => message.tool_call_id === "call-memory").length,
                1,
                "restoring the durable prefix must not duplicate the adjacent tool result"
            );
            assert.strictEqual(result.messages.at(-1)?.content, "fresh result");
        });

        test("freezes shared memory across tool rounds and refreshes it on the next user turn", async () => {
            let memoryBuildCalls = 0;
            const memoryTexts = ["memory selected for turn one", "memory selected for turn two", "unexpected tool-round refresh"];
            const memoryProvider = {
                buildPromptContext: async () => {
                    const text = memoryTexts[Math.min(memoryBuildCalls, memoryTexts.length - 1)];
                    memoryBuildCalls += 1;
                    return {
                        text,
                        entryCount: 1,
                        entryIds: [`memory-${memoryBuildCalls}`],
                        estimatedTokens: Math.ceil(text.length / 4),
                        expiredEntryCount: 0,
                    };
                },
            };
            const isolatedProvider = new LlamaCppChatModelProvider(
                new MockSecretStorage(),
                "test-user-agent",
                undefined,
                memoryProvider
            );
            const providerAny = isolatedProvider as unknown as {
                getModelSources: () => Promise<Array<{
                    key: string;
                    label: string;
                    serverUrl: string;
                    familyOverride?: string;
                    contextLengthFallback?: number;
                }>>;
                getRuntimeContextLengthWithCache: () => Promise<number | undefined>;
                acquireChatRequestSlot: (
                    requestId: string,
                    queueTimeoutMs: number,
                    token: vscode.CancellationToken
                ) => Promise<{ release: () => void; waitMs: number }>;
                sendChatCompletion: (
                    serverUrl: string,
                    headers: Record<string, string>,
                    requestBody: Record<string, unknown>,
                    timeoutMs: number,
                    token: vscode.CancellationToken
                ) => Promise<Response>;
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };
            const sent: Array<Record<string, unknown>> = [];
            providerAny.getModelSources = async () => [{
                key: "local",
                label: "Local",
                serverUrl: "http://localhost:8000",
                familyOverride: "qwen",
                contextLengthFallback: 65536,
            }];
            providerAny.getRuntimeContextLengthWithCache = async () => 65536;
            providerAny.acquireChatRequestSlot = async () => ({ release: () => undefined, waitMs: 0 });
            providerAny.sendChatCompletion = async (_serverUrl, _headers, requestBody) => {
                sent.push(JSON.parse(JSON.stringify(requestBody)) as Record<string, unknown>);
                return new Response(new ReadableStream<Uint8Array>({
                    start(controller) { controller.close(); },
                }), { status: 200 });
            };
            providerAny.processStreamingResponse = async (_responseBody, progress) => {
                progress.report(new vscode.LanguageModelTextPart("done"));
            };

            const model = {
                id: "local::qwen3-local",
                name: "qwen3-local (Local)",
                family: "qwen",
                version: "1",
                maxInputTokens: 60000,
                maxOutputTokens: 4096,
                capabilities: {},
            } as unknown as vscode.LanguageModelChatInformation;
            const options = {
                modelOptions: { _copilotConversationId: "memory-freeze-conversation" },
                tools: [{
                    name: "read_file",
                    description: "Read a file",
                    inputSchema: { type: "object", properties: {} },
                }],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
            } satisfies vscode.ProvideLanguageModelChatResponseOptions;
            const call = new vscode.LanguageModelToolCallPart("call-memory-freeze", "read_file", {});
            const result = new vscode.LanguageModelToolResultPart(
                "call-memory-freeze",
                [new vscode.LanguageModelTextPart("file contents")]
            );
            const firstTurn = [vscode.LanguageModelChatMessage.User("inspect the file")];
            const toolRound: vscode.LanguageModelChatMessage[] = [
                ...firstTurn,
                { role: vscode.LanguageModelChatMessageRole.Assistant, content: [call], name: undefined },
                { role: vscode.LanguageModelChatMessageRole.User, content: [result], name: undefined },
            ];
            const secondTurn: vscode.LanguageModelChatMessage[] = [
                ...toolRound,
                vscode.LanguageModelChatMessage.Assistant("finished the first task"),
                vscode.LanguageModelChatMessage.User("start the next task"),
            ];
            const progress = { report: () => undefined };
            const cancellation = new vscode.CancellationTokenSource().token;

            await isolatedProvider.provideLanguageModelChatResponse(model, firstTurn, options, progress, cancellation);
            await isolatedProvider.provideLanguageModelChatResponse(model, toolRound, options, progress, cancellation);
            await isolatedProvider.provideLanguageModelChatResponse(model, secondTurn, options, progress, cancellation);

            const memoryMessagesFrom = (body: Record<string, unknown>): string[] => {
                const messages = body.messages as Array<{ content?: unknown }>;
                return messages
                    .filter(message =>
                        typeof message.content === "string"
                        && message.content.includes("Shared durable memory")
                    )
                    .map(message => String(message.content));
            };
            assert.strictEqual(sent.length, 3);
            assert.strictEqual(memoryMessagesFrom(sent[0]).length, 1);
            assert.match(memoryMessagesFrom(sent[0])[0], /memory selected for turn one/);
            assert.strictEqual(
                memoryMessagesFrom(sent[1])[0],
                memoryMessagesFrom(sent[0])[0],
                "tool-result rounds must reuse the byte-identical memory block from the active user turn"
            );
            assert.strictEqual(
                memoryMessagesFrom(sent[2])[0],
                memoryMessagesFrom(sent[0])[0],
                "a new user turn must retain the old memory checkpoint at its original prefix position"
            );
            assert.strictEqual(
                memoryMessagesFrom(sent[2]).length,
                2,
                "newly selected memory must append a delta instead of replacing the old checkpoint"
            );
            assert.match(memoryMessagesFrom(sent[2])[1], /memory selected for turn two/);
            assert.strictEqual(memoryBuildCalls, 2, "memory retrieval must run once per genuine user turn");
            for (const body of sent) {
                const wireMessages = body.messages as Array<Record<string, unknown>>;
                assert.ok(
                    wireMessages.every(message =>
                        message.providerOverlay === undefined
                        && message.sharedMemoryRevisions === undefined
                        && message.ephemeral === undefined
                    ),
                    "provider-only alignment metadata must never be sent to the API"
                );
            }
        });

        test("builds an exclusive ordered prompt breakdown with memory and message subsections", () => {
            const providerAny = provider as unknown as {
                buildPromptSegments: (
                    messages: OpenAIChatMessage[],
                    toolTokens: number,
                    messageTokens: number
                ) => Array<{ kind: string; label: string; tokens: number }>;
            };
            const segments = providerAny.buildPromptSegments([
                { role: "system", content: "system prompt" },
                {
                    role: "user",
                    content: "shared memory",
                    providerOverlay: "shared-memory",
                    sharedMemoryRevisions: [{ id: "memory-1", revision: "abc" }],
                },
                { role: "user", content: "request\n<workspace_info>tree</workspace_info>" },
                {
                    role: "assistant",
                    content: "reading",
                    reasoning_content: "need to inspect",
                    tool_calls: [{
                        id: "call-1",
                        type: "function",
                        function: { name: "read_file", arguments: "{}" },
                    }],
                },
                { role: "tool", tool_call_id: "call-1", content: "file contents" },
                { role: "user", content: "guard", ephemeral: true },
            ], 600, 4_400);

            assert.deepStrictEqual(
                segments.map(segment => segment.kind),
                ["system", "tools", "shared_memory", "user_context", "assistant", "reasoning", "tool_calls", "tool_results", "guard"]
            );
            assert.strictEqual(
                segments.reduce((sum, segment) => sum + segment.tokens, 0),
                5_000,
                "exclusive message segments plus tools must equal the local prompt estimate"
            );
        });

        test("keeps the snapshot aligned when an ephemeral nudge disappears", () => {
            const providerAny = provider as unknown as {
                stabilizeMessagePrefix: (
                    requestId: string,
                    modelId: string,
                    scope: string | undefined,
                    messages: OpenAIChatMessage[],
                    staticFieldsHash: string,
                    toolsHash: string,
                    toolsCount: number,
                    toolNames: string[]
                ) => { messages: OpenAIChatMessage[]; stabilized: boolean; prefix: Record<string, unknown> };
            };
            const turn = (answer: string, toolCallId: string): OpenAIChatMessage[] => [
                { role: "system", content: "You are a careful coding agent." },
                { role: "user", content: "keep going" },
                {
                    role: "assistant",
                    content: "reading",
                    tool_calls: [{ id: toolCallId, type: "function", function: { name: "read_file", arguments: "{}" } }],
                },
                { role: "tool", tool_call_id: toolCallId, content: answer },
            ];
            const stabilize = (messages: OpenAIChatMessage[], requestId: string) => providerAny.stabilizeMessagePrefix(
                requestId,
                "deepseek-v4-pro",
                "conversation-prefix-2",
                messages,
                "static-hash",
                "tools-hash",
                1,
                ["read_file"]
            );

            // Turn 1 ends with a cross-turn nudge the provider injected itself.
            const withNudge: OpenAIChatMessage[] = [
                ...turn("result-1", "call-1"),
                { role: "user", content: "Pause and summarize.", ephemeral: true },
            ];
            const first = stabilize(withNudge, "request-1");
            // The nudge still reaches the server...
            assert.strictEqual(first.messages.at(-1)?.content, "Pause and summarize.");
            // ...but it is excluded from the recorded prefix.
            assert.strictEqual(first.prefix.messageCount, 4);

            // Turn 2: the host sends the real history (no nudge) plus a new question.
            const next = stabilize(
                [...turn("result-1", "call-1"), { role: "user", content: "new question" } as OpenAIChatMessage],
                "request-2"
            );

            // Byte-identical prefix: no rewrite needed, but the prefix aligns.
            assert.strictEqual(next.prefix.identicalMessagePrefix, 4);
            assert.strictEqual(next.prefix.ephemeralChanged, true, "a disappearing provider nudge changes the real prompt");
            assert.deepStrictEqual(next.messages.slice(0, 4), turn("result-1", "call-1"));
            assert.deepStrictEqual(next.messages[4], { role: "user", content: "new question" });

            // Turn 3: the host re-summarizes the tool result of the same call —
            // the call id anchors it, so the sent version is restored from the
            // snapshot instead of rewriting the cached prefix.
            const rewritten = stabilize(
                [...turn("result-1 [summarized]", "call-1"), { role: "user", content: "and now" } as OpenAIChatMessage],
                "request-3"
            );
            assert.strictEqual(rewritten.stabilized, true);
            assert.deepStrictEqual(rewritten.messages.slice(0, 4), turn("result-1", "call-1"));
            assert.deepStrictEqual(rewritten.messages[4], { role: "user", content: "and now" });
        });

        test("keeps the compacted snapshot usable after the host re-renders its tail", () => {
            const providerAny = provider as unknown as {
                findSnapshotAlignment: (
                    source: OpenAIChatMessage[],
                    snapshot: OpenAIChatMessage[]
                ) => { snapshotPrefix: number; newMessages: OpenAIChatMessage[] } | undefined;
            };
            const snapshot: OpenAIChatMessage[] = [
                { role: "system", content: "summary of earlier work" },
                { role: "user", content: "keep going\n<workspace_info>\nsrc/a.ts\n</workspace_info>" },
                {
                    role: "assistant",
                    content: "reading",
                    tool_calls: [{ id: "call-9", type: "function", function: { name: "read_file", arguments: "{}" } }],
                },
                { role: "tool", tool_call_id: "call-9", content: "full file body" },
            ];
            // After a restart the host re-renders the workspace tree and
            // re-summarizes the tool result of the very same turns.
            const source: OpenAIChatMessage[] = [
                { role: "system", content: "summary of earlier work" },
                { role: "user", content: "keep going\n<workspace_info>\nsrc/a.ts\nout/b.js\n</workspace_info>" },
                {
                    role: "assistant",
                    content: "reading",
                    tool_calls: [{ id: "call-9", type: "function", function: { name: "read_file", arguments: "{}" } }],
                },
                { role: "tool", tool_call_id: "call-9", content: "[tool result summarized]" },
                { role: "user", content: "next question" },
            ];

            const alignment = providerAny.findSnapshotAlignment(source, snapshot);

            assert.strictEqual(alignment?.snapshotPrefix, 4);
            assert.deepStrictEqual(alignment?.newMessages, [{ role: "user", content: "next question" }]);
        });

        test("rewinds the pivot when the host drops the snapshot tail", () => {
            const providerAny = provider as unknown as {
                findSnapshotAlignment: (
                    source: OpenAIChatMessage[],
                    snapshot: OpenAIChatMessage[]
                ) => { snapshotPrefix: number; newMessages: OpenAIChatMessage[] } | undefined;
            };
            const shared: OpenAIChatMessage[] = [
                { role: "system", content: "system" },
                { role: "user", content: "start" },
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
                },
                { role: "tool", tool_call_id: "call-1", content: "a" },
            ];
            // The snapshot still holds an answer the host discarded when the
            // user sent a new message.
            const snapshot: OpenAIChatMessage[] = [...shared, { role: "assistant", content: "interrupted answer" }];
            const source: OpenAIChatMessage[] = [...shared, { role: "user", content: "new question" }];

            const alignment = providerAny.findSnapshotAlignment(source, snapshot);

            assert.strictEqual(alignment?.snapshotPrefix, 4);
            assert.deepStrictEqual(alignment?.newMessages, [{ role: "user", content: "new question" }]);
        });

        test("keeps the snapshot when the host trims its own history window", () => {
            const providerAny = provider as unknown as {
                tailRepeatsSnapshotCalls: (
                    snapshot: readonly OpenAIChatMessage[],
                    tail: readonly OpenAIChatMessage[]
                ) => boolean;
            };
            const snapshot: OpenAIChatMessage[] = [
                { role: "system", content: "system" },
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
                },
                { role: "tool", tool_call_id: "call-1", content: "body" },
            ];
            const freshTail: OpenAIChatMessage[] = [
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [{ id: "call-2", type: "function", function: { name: "read_file", arguments: "{}" } }],
                },
                { role: "tool", tool_call_id: "call-2", content: "body" },
            ];
            const repeatedTail: OpenAIChatMessage[] = [
                { role: "tool", tool_call_id: "call-1", content: "body rewritten" },
            ];

            assert.strictEqual(providerAny.tailRepeatsSnapshotCalls(snapshot, freshTail), false);
            assert.strictEqual(providerAny.tailRepeatsSnapshotCalls(snapshot, repeatedTail), true);
        });

        test("keeps a fresh turn when the host replaces the last message", () => {
            const providerAny = provider as unknown as {
                stabilizeMessagePrefix: (
                    requestId: string,
                    modelId: string,
                    scope: string | undefined,
                    messages: OpenAIChatMessage[],
                    staticFieldsHash: string,
                    toolsHash: string,
                    toolsCount: number,
                    toolNames: string[]
                ) => { messages: OpenAIChatMessage[]; stabilized: boolean };
            };
            const stabilize = (messages: OpenAIChatMessage[], requestId: string) => providerAny.stabilizeMessagePrefix(
                requestId,
                "deepseek-v4-pro",
                "conversation-prefix-2",
                messages,
                "static-hash",
                "tools-hash",
                0,
                []
            );

            stabilize([
                { role: "system", content: "system" },
                { role: "user", content: "first question" },
            ], "request-1");
            const result = stabilize([
                { role: "system", content: "system" },
                { role: "user", content: "second question" },
            ], "request-2");

            assert.strictEqual(result.messages[1].content, "second question");
        });

        test("restores the sent-message snapshot and tool catalog after provider restart", async () => {
            const memento = new MockMemento();
            const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "llamacpp-test-"));
            const firstProvider = new LlamaCppChatModelProvider(
                new MockSecretStorage(),
                "test-user-agent",
                undefined,
                undefined,
                memento,
                storageDir
            );
            const firstProviderAny = firstProvider as unknown as {
                setConversationMessageSnapshot: (
                    scope: string,
                    messages: OpenAIChatMessage[],
                    tokenCount: number
                ) => void;
                persistContinuationState: () => Promise<void>;
                stabilizeToolCatalog: (
                    modelId: string,
                    options: vscode.ProvideLanguageModelChatResponseOptions,
                    config: ReturnType<typeof convertTools>,
                    messages: readonly OpenAIChatMessage[],
                    requestId: string
                ) => ReturnType<typeof convertTools>;
            };
            const scope = "deepseek-v4-pro\0conversation-restart-1";
            const sentMessages: OpenAIChatMessage[] = [
                { role: "system", content: "stable instructions" },
                {
                    role: "user",
                    content: "persisted shared memory",
                    providerOverlay: "shared-memory",
                    sharedMemoryRevisions: [{ id: "entry-1", revision: "revision-1" }],
                },
                { role: "user", content: "continue this long conversation" },
                { role: "assistant", content: "continuation point" },
            ];
            firstProviderAny.setConversationMessageSnapshot(scope, sentMessages, 12345);

            const tool = (name: string, description: string): vscode.LanguageModelChatTool => ({
                name,
                description,
                inputSchema: { type: "object", properties: { value: { type: "string" } } },
            });
            const firstOptions = {
                modelOptions: { _copilotConversationId: "conversation-restart-1" },
                tools: [tool("read_file", "original read"), tool("grep_search", "original grep")],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
            } as vscode.ProvideLanguageModelChatResponseOptions;
            const firstCatalog = firstProviderAny.stabilizeToolCatalog(
                "deepseek-v4-pro",
                firstOptions,
                convertTools(firstOptions, { mode: "apiDirect", apiDirectMaxTools: 2 }),
                sentMessages,
                "request-before-restart"
            );
            await firstProviderAny.persistContinuationState();

            const restartedProvider = new LlamaCppChatModelProvider(
                new MockSecretStorage(),
                "test-user-agent",
                undefined,
                undefined,
                memento,
                storageDir
            );
            const restartedProviderAny = restartedProvider as unknown as {
                getConversationMessageSnapshot: (scope: string) => {
                    messages: OpenAIChatMessage[];
                    tokenCount: number;
                } | undefined;
                stabilizeToolCatalog: (
                    modelId: string,
                    options: vscode.ProvideLanguageModelChatResponseOptions,
                    config: ReturnType<typeof convertTools>,
                    messages: readonly OpenAIChatMessage[],
                    requestId: string
                ) => ReturnType<typeof convertTools>;
            };
            const restoredSnapshot = restartedProviderAny.getConversationMessageSnapshot(scope);
            assert.ok(restoredSnapshot);
            assert.deepStrictEqual(restoredSnapshot.messages, sentMessages);
            assert.strictEqual(restoredSnapshot.tokenCount, 12345);

            const changedOptions = {
                ...firstOptions,
                tools: [tool("grep_search", "changed grep"), tool("read_file", "changed read")],
            } as vscode.ProvideLanguageModelChatResponseOptions;
            const restoredCatalog = restartedProviderAny.stabilizeToolCatalog(
                "deepseek-v4-pro",
                changedOptions,
                convertTools(changedOptions, { mode: "apiDirect", apiDirectMaxTools: 2 }),
                [{ role: "user", content: "after restart" }],
                "request-after-restart"
            );
            const canonicalFirstCatalog = [...(firstCatalog.tools ?? [])].sort((left, right) =>
                left.function.name.localeCompare(right.function.name)
            );
            assert.deepStrictEqual(restoredCatalog.tools, canonicalFirstCatalog);
        });

        test("returns exact usage from the final SSE usage chunk", async () => {
            const providerAny = provider as unknown as {
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<{
                    prompt_tokens: number;
                    completion_tokens: number;
                    total_tokens: number;
                    prompt_tokens_details?: { cached_tokens?: number };
                } | undefined>;
            };

            const encoder = new TextEncoder();
            const payload =
                "data: {\"choices\":[{\"delta\":{\"content\":\"done\"}}],\"usage\":null}\n\n" +
                "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":120,\"completion_tokens\":30,\"total_tokens\":150,\"prompt_tokens_details\":{\"cached_tokens\":80}}}\n\n" +
                "data: [DONE]\n\n";
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(payload));
                    controller.close();
                },
            });

            const usage = await providerAny.processStreamingResponse(
                stream,
                { report: () => undefined },
                new vscode.CancellationTokenSource().token
            );

            assert.deepStrictEqual(usage, {
                prompt_tokens: 120,
                completion_tokens: 30,
                total_tokens: 150,
                prompt_tokens_details: { cached_tokens: 80 },
            });
        });

        test("coalesces many small text deltas before reporting progress", async () => {
            const providerAny = provider as unknown as {
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };

            const encoder = new TextEncoder();
            const chunks = Array.from(
                { length: 100 },
                () => "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n"
            ).join("");
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(`${chunks}data: [DONE]\n\n`));
                    controller.close();
                },
            });

            const parts: vscode.LanguageModelResponsePart[] = [];
            await providerAny.processStreamingResponse(
                stream,
                {
                    report: part => parts.push(part),
                },
                new vscode.CancellationTokenSource().token
            );

            const textParts = parts.filter(
                (part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart
            );
            const text = textParts.map(part => part.value).join("");

            assert.strictEqual(text, "x".repeat(100));
            assert.ok(textParts.length < 10, `expected coalesced text parts, got ${textParts.length}`);
        });

        test("coalesces many small reasoning deltas without losing thinking metadata", async () => {
            const providerAny = provider as unknown as {
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
                getEmittedThinkingText: (part: unknown) => string | undefined;
            };

            const encoder = new TextEncoder();
            const chunks = Array.from(
                { length: 100 },
                () => "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"r\"}}]}\n\n"
            ).join("");
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(`${chunks}data: [DONE]\n\n`));
                    controller.close();
                },
            });

            const parts: vscode.LanguageModelResponsePart[] = [];
            await providerAny.processStreamingResponse(
                stream,
                { report: part => parts.push(part) },
                new vscode.CancellationTokenSource().token
            );

            const thinkingParts = parts
                .map(part => providerAny.getEmittedThinkingText(part))
                .filter((text): text is string => text !== undefined);
            assert.strictEqual(thinkingParts.join(""), "r".repeat(100));
            assert.ok(thinkingParts.length < 10, `expected coalesced thinking parts, got ${thinkingParts.length}`);
        });

        test("cancels the upstream response body while waiting for a stream chunk", async () => {
            const providerAny = provider as unknown as {
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };

            let upstreamCancelled = false;
            const stream = new ReadableStream<Uint8Array>({
                cancel() {
                    upstreamCancelled = true;
                },
            });
            const cancellation = new vscode.CancellationTokenSource();
            const processing = providerAny.processStreamingResponse(
                stream,
                { report: () => undefined },
                cancellation.token
            );

            cancellation.cancel();
            await assert.rejects(processing, error => error instanceof vscode.CancellationError);
            assert.strictEqual(upstreamCancelled, true);
            cancellation.dispose();
        });

        test("flushes buffered tool calls when stream ends without DONE", async () => {
			configureStreamingTools(["read_file"]);
            const providerAny = provider as unknown as {
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };

            const encoder = new TextEncoder();
            const payload =
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"}}]}}]}\n\n";
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(payload));
                    controller.close();
                },
            });

            const parts: vscode.LanguageModelResponsePart[] = [];
            await providerAny.processStreamingResponse(
                stream,
                {
                    report: part => parts.push(part),
                },
                new vscode.CancellationTokenSource().token
            );

            const toolCalls = parts.filter(
                (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
            );

            assert.strictEqual(toolCalls.length, 1);
            assert.strictEqual(toolCalls[0].name, "read_file");
            assert.deepStrictEqual(toolCalls[0].input, { path: "README.md" });
        });

        test("processes final SSE line without trailing newline", async () => {
			configureStreamingTools(["list_dir"]);
            const providerAny = provider as unknown as {
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };

            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        encoder.encode(
                            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_tail\",\"function\":{\"name\":\"list_dir\",\"arguments\":\"{\\\"path\\\":\\\"src\\\"}\"}}]}}]}"
                        )
                    );
                    controller.close();
                },
            });

            const parts: vscode.LanguageModelResponsePart[] = [];
            await providerAny.processStreamingResponse(
                stream,
                {
                    report: part => parts.push(part),
                },
                new vscode.CancellationTokenSource().token
            );

            const toolCalls = parts.filter(
                (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
            );

            assert.strictEqual(toolCalls.length, 1);
            assert.strictEqual(toolCalls[0].name, "list_dir");
            assert.deepStrictEqual(toolCalls[0].input, { path: "src" });
        });

        test("flushes multiple buffered tool calls at stream end", async () => {
			configureStreamingTools(["grep_search", "list_dir"]);
            const providerAny = provider as unknown as {
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };

            const encoder = new TextEncoder();
            const payload =
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"grep_search\",\"arguments\":\"{\\\"query\\\":\\\"abc\\\"}\"}},{\"index\":1,\"id\":\"call_b\",\"function\":{\"name\":\"list_dir\",\"arguments\":\"{\\\"path\\\":\\\"src\\\"}\"}}]}}]}";
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(payload));
                    controller.close();
                },
            });

            const parts: vscode.LanguageModelResponsePart[] = [];
            await providerAny.processStreamingResponse(
                stream,
                {
                    report: part => parts.push(part),
                },
                new vscode.CancellationTokenSource().token
            );

            const toolCalls = parts.filter(
                (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
            );

            assert.strictEqual(toolCalls.length, 2);
            assert.deepStrictEqual(
                toolCalls.map(call => ({ name: call.name, input: call.input })),
                [
                    { name: "grep_search", input: { query: "abc" } },
                    { name: "list_dir", input: { path: "src" } },
                ]
            );
        });

        test("repairs and validates streamed tool calls before emitting them", async () => {
            const providerAny = provider as unknown as {
                configureToolCallReliability: (
                    tools: readonly OpenAIFunctionToolDef[],
                    options: { repairEnabled: boolean; validateSchema: boolean }
                ) => void;
                consumeToolCallReliabilityMetrics: () => ToolCallReliabilityMetrics;
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };
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
            providerAny.configureToolCallReliability([tool], { repairEnabled: true, validateSchema: true });

            const payload =
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_repaired\",\"function\":{\"name\":\"READ_FILE\",\"arguments\":\"{\\\"path\\\":\\\"README.md\\\",}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n" +
                "data: [DONE]\n\n";
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(payload));
                    controller.close();
                },
            });
            const parts: vscode.LanguageModelResponsePart[] = [];
            await providerAny.processStreamingResponse(
                stream,
                { report: part => parts.push(part) },
                new vscode.CancellationTokenSource().token
            );

            const toolCall = parts.find(
                (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
            );
            assert.strictEqual(toolCall?.name, "read_file");
            assert.deepStrictEqual(toolCall?.input, { path: "README.md" });
            assert.deepStrictEqual(providerAny.consumeToolCallReliabilityMetrics(), {
                accepted: 1,
                repaired: 1,
                rejected: 0,
                unknownTool: 0,
                schemaRejected: 0,
                loopDetected: false,
            });
        });

        test("rejects a schema-invalid streamed tool call once", async () => {
            const providerAny = provider as unknown as {
                configureToolCallReliability: (
                    tools: readonly OpenAIFunctionToolDef[],
                    options: { repairEnabled: boolean; validateSchema: boolean }
                ) => void;
                consumeToolCallReliabilityMetrics: () => ToolCallReliabilityMetrics;
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };
            providerAny.configureToolCallReliability([{
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
            }], { repairEnabled: true, validateSchema: true });

            const payload =
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_invalid\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]}}]}\n\n" +
                "data: [DONE]\n\n";
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(payload));
                    controller.close();
                },
            });

            await assert.rejects(
                providerAny.processStreamingResponse(
                    stream,
                    { report: () => undefined },
                    new vscode.CancellationTokenSource().token
                ),
                error => error instanceof ToolCallValidationError && error.kind === "schema"
            );
            const metrics = providerAny.consumeToolCallReliabilityMetrics();
            assert.strictEqual(metrics.rejected, 1);
            assert.strictEqual(metrics.schemaRejected, 1);

            providerAny.configureToolCallReliability([], { repairEnabled: true, validateSchema: true });
        });

        test("auto-retries continuation when model returns empty output", async () => {
            const providerAny = provider as unknown as {
                getServerUrl: () => Promise<string>;
                getApiKey: () => Promise<string | undefined>;
                getRuntimeContextLengthWithCache: () => Promise<number | undefined>;
                acquireChatRequestSlot: (
                    requestId: string,
                    queueTimeoutMs: number,
                    token: vscode.CancellationToken
                ) => Promise<{ release: () => void; waitMs: number }>;
                sendChatCompletion: (
                    serverUrl: string,
                    headers: Record<string, string>,
                    requestBody: Record<string, unknown>,
                    timeoutMs: number,
                    token: vscode.CancellationToken
                ) => Promise<Response>;
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };

            const originalGetServerUrl = providerAny.getServerUrl;
            const originalGetApiKey = providerAny.getApiKey;
            const originalGetRuntimeContextLengthWithCache = providerAny.getRuntimeContextLengthWithCache;
            const originalAcquireChatRequestSlot = providerAny.acquireChatRequestSlot;
            const originalSendChatCompletion = providerAny.sendChatCompletion;
            const originalProcessStreamingResponse = providerAny.processStreamingResponse;

            const sentRequestBodies: Array<Record<string, unknown>> = [];
            const reportedParts: vscode.LanguageModelResponsePart[] = [];
            let streamInvocation = 0;

            const emptyResponse = () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.close();
                        },
                    }),
                    { status: 200 }
                );

            try {
                providerAny.getServerUrl = async () => "http://localhost:8000";
                providerAny.getApiKey = async () => undefined;
                providerAny.getRuntimeContextLengthWithCache = async () => 65536;
                providerAny.acquireChatRequestSlot = async () => ({ release: () => undefined, waitMs: 0 });
                providerAny.sendChatCompletion = async (
                    _serverUrl,
                    _headers,
                    requestBody,
                    _timeoutMs,
                    _token
                ) => {
                    sentRequestBodies.push(JSON.parse(JSON.stringify(requestBody)) as Record<string, unknown>);
                    return emptyResponse();
                };
                providerAny.processStreamingResponse = async (_responseBody, progress, _token) => {
                    streamInvocation += 1;
                    if (streamInvocation === 2) {
                        progress.report(new vscode.LanguageModelTextPart("Recovered response"));
                    }
                };

                await provider.provideLanguageModelChatResponse(
                    {
                        id: "test-model",
                        name: "test-model",
                        family: "llama",
                        version: "1",
                        maxInputTokens: 32768,
                        maxOutputTokens: 4096,
                        capabilities: {},
                    } as unknown as vscode.LanguageModelChatInformation,
                    [vscode.LanguageModelChatMessage.User("Explain this")],
                    {
                        modelOptions: {},
                        tools: [],
                        toolMode: vscode.LanguageModelChatToolMode.Auto,
                    },
                    {
                        report: part => reportedParts.push(part),
                    },
                    new vscode.CancellationTokenSource().token
                );
            } finally {
                providerAny.getServerUrl = originalGetServerUrl;
                providerAny.getApiKey = originalGetApiKey;
                providerAny.getRuntimeContextLengthWithCache = originalGetRuntimeContextLengthWithCache;
                providerAny.acquireChatRequestSlot = originalAcquireChatRequestSlot;
                providerAny.sendChatCompletion = originalSendChatCompletion;
                providerAny.processStreamingResponse = originalProcessStreamingResponse;
            }

            assert.strictEqual(sentRequestBodies.length, 2, "expected one auto-retry request");

            const secondMessages = sentRequestBodies[1].messages as Array<{ role?: string; content?: string }>;
            const lastMessage = secondMessages[secondMessages.length - 1];
            assert.strictEqual(lastMessage.role, "user");
            assert.ok(
                (lastMessage.content ?? "").includes("Continue from your previous response"),
                "expected continuation prompt to be appended"
            );

            const textParts = reportedParts.filter(
                (part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart
            );
            assert.strictEqual(textParts.length, 1);
            assert.strictEqual(textParts[0].value, "Recovered response");
        });

        test("retries a rejected tool call after partial text with a bounded correction prompt", async () => {
            const providerAny = provider as unknown as {
                getServerUrl: () => Promise<string>;
                getApiKey: () => Promise<string | undefined>;
                getRuntimeContextLengthWithCache: () => Promise<number | undefined>;
                acquireChatRequestSlot: (
                    requestId: string,
                    queueTimeoutMs: number,
                    token: vscode.CancellationToken
                ) => Promise<{ release: () => void; waitMs: number }>;
                sendChatCompletion: (
                    serverUrl: string,
                    headers: Record<string, string>,
                    requestBody: Record<string, unknown>,
                    timeoutMs: number,
                    token: vscode.CancellationToken
                ) => Promise<Response>;
                processStreamingResponse: (
                    responseBody: ReadableStream<Uint8Array>,
                    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                    token: vscode.CancellationToken
                ) => Promise<void>;
            };
            const originals = {
                getServerUrl: providerAny.getServerUrl,
                getApiKey: providerAny.getApiKey,
                getRuntimeContextLengthWithCache: providerAny.getRuntimeContextLengthWithCache,
                acquireChatRequestSlot: providerAny.acquireChatRequestSlot,
                sendChatCompletion: providerAny.sendChatCompletion,
                processStreamingResponse: providerAny.processStreamingResponse,
            };
            const sentRequestBodies: Array<Record<string, unknown>> = [];
            const reportedParts: vscode.LanguageModelResponsePart[] = [];
            let streamInvocation = 0;
            const emptyResponse = () => new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.close();
                },
            }), { status: 200 });

            try {
                providerAny.getServerUrl = async () => "http://localhost:8000";
                providerAny.getApiKey = async () => undefined;
                providerAny.getRuntimeContextLengthWithCache = async () => 65536;
                providerAny.acquireChatRequestSlot = async () => ({ release: () => undefined, waitMs: 0 });
                providerAny.sendChatCompletion = async (_url, _headers, body) => {
                    sentRequestBodies.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
                    return emptyResponse();
                };
                providerAny.processStreamingResponse = async (_body, progress) => {
                    streamInvocation += 1;
                    if (streamInvocation === 1) {
                        progress.report(new vscode.LanguageModelTextPart("Inspecting the file first."));
                        throw new ToolCallValidationError("$.path is required", "read_file", "schema");
                    }
                    progress.report(new vscode.LanguageModelTextPart("Recovered after correction"));
                };

                await provider.provideLanguageModelChatResponse(
                    {
                        id: "test-model",
                        name: "test-model",
                        family: "llama",
                        version: "1",
                        maxInputTokens: 32768,
                        maxOutputTokens: 4096,
                        capabilities: { toolCalling: true },
                    } as unknown as vscode.LanguageModelChatInformation,
                    [vscode.LanguageModelChatMessage.User("Read README")],
                    {
                        modelOptions: {},
                        tools: [{
                            name: "read_file",
                            description: "Read a file",
                            inputSchema: {
                                type: "object",
                                properties: { path: { type: "string" } },
                                required: ["path"],
                            },
                        }],
                        toolMode: vscode.LanguageModelChatToolMode.Auto,
                    },
                    { report: part => reportedParts.push(part) },
                    new vscode.CancellationTokenSource().token
                );
            } finally {
                providerAny.getServerUrl = originals.getServerUrl;
                providerAny.getApiKey = originals.getApiKey;
                providerAny.getRuntimeContextLengthWithCache = originals.getRuntimeContextLengthWithCache;
                providerAny.acquireChatRequestSlot = originals.acquireChatRequestSlot;
                providerAny.sendChatCompletion = originals.sendChatCompletion;
                providerAny.processStreamingResponse = originals.processStreamingResponse;
            }

            assert.strictEqual(sentRequestBodies.length, 2);
            const retryMessages = sentRequestBodies[1].messages as Array<{ role?: string; content?: string }>;
            assert.strictEqual(retryMessages.at(-1)?.role, "user");
            assert.ok(retryMessages.at(-1)?.content?.includes("previous tool call was rejected"));
            assert.ok(retryMessages.at(-1)?.content?.includes("read_file"));
            assert.ok(reportedParts.some(part =>
                part instanceof vscode.LanguageModelTextPart && part.value === "Recovered after correction"
            ));
        });
    });

    suite("utils/convertMessages", () => {
        test("maps user/assistant text", () => {
            const messages: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelTextPart("hi")],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelTextPart("hello")],
                    name: undefined,
                },
            ];
            const out = convertMessages(messages);
            assert.deepEqual(out, [
                { role: "user", content: "hi" },
                { role: "assistant", content: "hello" },
            ]);
        });

        test("merges consecutive user messages", () => {
            const messages: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelTextPart("context")],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelTextPart("query")],
                    name: undefined,
                },
            ];
            const out = convertMessages(messages);
            // Expectation: merged into one message
            assert.strictEqual(out.length, 1);
            assert.strictEqual(out[0].role, "user");
            assert.ok(String(out[0].content).includes("context"));
            assert.ok(String(out[0].content).includes("query"));
        });

        test("merges consecutive assistant messages (text + tool call)", () => {
            const messages: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelTextPart("thinking...")],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelToolCallPart("call1", "my_tool", { a: 1 })],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelToolResultPart("call1", [new vscode.LanguageModelTextPart("ok")])],
                    name: undefined,
                },
            ];
            const out = convertMessages(messages, { toolResultMode: "tool" });
            assert.strictEqual(out.length, 2);
            assert.strictEqual(out[0].role, "assistant");
            assert.strictEqual(out[0].content, "thinking...");
            assert.ok(out[0].tool_calls && out[0].tool_calls.length === 1);
            assert.strictEqual(out[0].tool_calls[0].function.name, "my_tool");
        });


        test("merges consecutive tool messages", () => {
             const messages: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelToolResultPart("id1", [new vscode.LanguageModelTextPart("res1")])],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelToolResultPart("id2", [new vscode.LanguageModelTextPart("res2")])],
                    name: undefined,
                },
            ];
            const out = convertMessages(messages);
            // Expectation: merged into single User message with combined text
            assert.strictEqual(out.length, 1);
            assert.strictEqual(out[0].role, "user");
            assert.ok(String(out[0].content).includes("res1"));
            assert.ok(String(out[0].content).includes("res2"));
        });
        test("merges user (text) into tool message", () => {
            const messages: vscode.LanguageModelChatMessage[] = [
               {
                   role: vscode.LanguageModelChatMessageRole.User,
                   content: [new vscode.LanguageModelTextPart("context")],
                   name: undefined,
               },
               {
                   role: vscode.LanguageModelChatMessageRole.User,
                   content: [new vscode.LanguageModelToolResultPart("id1", [new vscode.LanguageModelTextPart("res1")])],
                   name: undefined,
               },
           ];
           const out = convertMessages(messages);
           assert.strictEqual(out.length, 1);
           assert.strictEqual(out[0].role, "user");
           assert.ok(String(out[0].content).includes("context"));
           assert.ok(String(out[0].content).includes("res1"));
       });

       test("merges tool message and user (text)", () => {
           const messages: vscode.LanguageModelChatMessage[] = [
              {
                  role: vscode.LanguageModelChatMessageRole.User,
                  content: [new vscode.LanguageModelToolResultPart("id1", [new vscode.LanguageModelTextPart("res1")])],
                  name: undefined,
              },
              {
                  role: vscode.LanguageModelChatMessageRole.User,
                  content: [new vscode.LanguageModelTextPart("followup")],
                  name: undefined,
              },
          ];
          const out = convertMessages(messages);
          assert.strictEqual(out.length, 1);
          assert.strictEqual(out[0].role, "user");
          assert.ok(String(out[0].content).includes("res1"));
          assert.ok(String(out[0].content).includes("followup"));
      });

          test("keeps tool role when toolResultMode is tool", () => {
            const callId = "call_tool_1";
            const messages: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelToolCallPart(callId, "my_tool", { q: 1 })],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok")])],
                    name: undefined,
                },
            ];

            const out = convertMessages(messages, { toolResultMode: "tool" });
            assert.strictEqual(out.length, 2);
            assert.strictEqual(out[0].role, "assistant");
            assert.strictEqual(out[1].role, "tool");
          assert.strictEqual(out[1].tool_call_id, callId);
          assert.ok((out[1].content as string).includes("ok"));
          });

		test("keeps serialized text parts (constructor lost over IPC)", () => {
			// Parts crossing the extension-host boundary arrive as plain
			// objects with a `value` string and no class identity. Without
			// shape matching their text silently vanishes from the prompt.
			const messages = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [
						{ value: "user text that must survive" },
					],
					name: undefined,
				},
			] as unknown as vscode.LanguageModelChatMessage[];

			const out = convertMessages(messages);
			assert.strictEqual(out.length, 1);
			assert.ok(String(out[0].content).includes("user text that must survive"));
		});

        test("keeps tool_calls when every call has a matching tool result", () => {
            const callId = "call_kept_1";
            const messages: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelToolCallPart(callId, "my_tool", { q: 1 })],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok")])],
                    name: undefined,
                },
            ];

            const out = convertMessages(messages, { toolResultMode: "tool" });
            assert.strictEqual(out.length, 2);
            assert.ok(out[0].tool_calls && out[0].tool_calls.length === 1, "complete tool round must keep tool_calls");
            assert.strictEqual(out[1].role, "tool");
        });

        test("strips tool_calls when a user message breaks the assistant→tool sequence", () => {
            const callId = "call_broken_1";
            const messages: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelToolCallPart(callId, "my_tool", { q: 1 })],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelTextPart("steering text in between")],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelToolCallPart("call_kept_2", "other_tool", {})],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelToolResultPart("call_kept_2", [new vscode.LanguageModelTextPart("ok")])],
                    name: undefined,
                },
            ];

            const out = convertMessages(messages, { toolResultMode: "tool" });
            // First assistant's call is orphaned (user text follows it); second is intact.
            assert.strictEqual(out[0].role, "assistant");
            assert.strictEqual(out[0].tool_calls, undefined, "broken assistant→tool sequence must strip tool_calls");
            assert.strictEqual(out[1].role, "user");
            assert.strictEqual(out[2].role, "assistant");
            assert.ok(out[2].tool_calls && out[2].tool_calls.length === 1, "later complete round must keep tool_calls");
        });

        test("strips all assistant tool_calls in user tool-result mode", () => {
            const callId = "call_user_mode_1";
            const messages: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelToolCallPart(callId, "my_tool", { q: 1 })],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok")])],
                    name: undefined,
                },
            ];

            const out = convertMessages(messages, { toolResultMode: "user" });
            assert.strictEqual(out.length, 2);
            assert.strictEqual(out[0].role, "assistant");
            assert.strictEqual(out[0].tool_calls, undefined, "user mode must strip tool_calls (server sees no tool role)");
            assert.strictEqual(out[1].role, "user");
            assert.ok(String(out[1].content).includes("call_id="));
        });

        test("preserves tool-result images for vision models", () => {
            const callId = "call_image_1";
            const imagePart = vscode.LanguageModelDataPart.image(new Uint8Array([1, 2, 3]), "image/png");
            const messages: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelToolCallPart(callId, "view_image", { filePath: "capture.png" })],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [
                        new vscode.LanguageModelToolResultPart(callId, [
                            new vscode.LanguageModelTextPart("capture loaded"),
                            imagePart as unknown as vscode.LanguageModelTextPart,
                        ]),
                    ],
                    name: undefined,
                },
            ];

            const out = convertMessages(messages, { toolResultMode: "tool", supportsImageInput: true });
            assert.strictEqual(out.length, 3);
            assert.strictEqual(out[1].role, "tool");
            assert.strictEqual(out[1].content, "capture loaded");
            assert.strictEqual(out[2].role, "user");
            assert.ok(Array.isArray(out[2].content));
            const image = (out[2].content as Array<{ type: string; image_url?: { url?: string } }>).find(
                part => part.type === "image_url"
            );
            assert.strictEqual(image?.image_url?.url, "data:image/png;base64,AQID");
        });

        test("uses a placeholder for tool-result images without vision support", () => {
            const callId = "call_image_fallback";
            const imagePart = vscode.LanguageModelDataPart.image(new Uint8Array([1, 2, 3]), "image/png");
            const messages: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [new vscode.LanguageModelToolCallPart(callId, "view_image", { filePath: "capture.png" })],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [
                        new vscode.LanguageModelToolResultPart(callId, [
                            imagePart as unknown as vscode.LanguageModelTextPart,
                        ]),
                    ],
                    name: undefined,
                },
            ];

            const out = convertMessages(messages, { toolResultMode: "tool", supportsImageInput: false });
            assert.strictEqual(out.length, 2);
            assert.strictEqual(out[1].role, "tool");
            assert.ok(String(out[1].content).includes("image input not supported"));
            assert.ok(!String(out[1].content).includes("AQID"));
        });

        test("preserves reasoning_content on assistant tool-call messages", () => {
            const thinkingPart = {
                constructor: { name: "LanguageModelThinkingPart" },
                text: "need a file read before answering",
            } as unknown as vscode.LanguageModelChatMessage["content"][number];
            const callId = "call_reasoning_1";
            const messages: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        thinkingPart,
                        new vscode.LanguageModelToolCallPart(callId, "read_file", { path: "README.md" }),
                    ],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("contents")])],
                    name: undefined,
                },
            ];

            const out = convertMessages(messages, { toolResultMode: "tool" });
            assert.strictEqual(out.length, 2);
            assert.strictEqual(out[0].role, "assistant");
            assert.strictEqual(out[0].content, "");
            assert.strictEqual(out[0].reasoning_content, "need a file read before answering");
            assert.strictEqual(out[0].tool_calls?.[0].id, callId);
        });

        test("hoists system messages to the top", () => {
            const systemRole = 3 as vscode.LanguageModelChatMessageRole;
            const sysMsg = {
                role: systemRole,
                content: [new vscode.LanguageModelTextPart("sys instruction")],
            } as vscode.LanguageModelChatMessage;
            const userMsg = {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
            } as vscode.LanguageModelChatMessage;

            const out = convertMessages([userMsg, sysMsg]);
            assert.strictEqual(out.length, 2);
            assert.strictEqual(out[0].role, "system");
            assert.strictEqual(out[0].content, "sys instruction");
            assert.strictEqual(out[1].role, "user");
            assert.strictEqual(out[1].content, "hi");
        });


    });

    suite("utils/tools", () => {
		test("convertMessages canonicalizes tool arguments and missing call ids", () => {
			const firstInput: Record<string, unknown> = {};
			firstInput.z = 1;
			firstInput.a = { y: 2, b: 3 };
			const secondInput: Record<string, unknown> = {};
			secondInput.a = { b: 3, y: 2 };
			secondInput.z = 1;
			const first = convertMessages([{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelToolCallPart("", "stable_tool", firstInput)],
				name: undefined,
			}, {
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelToolResultPart("", [new vscode.LanguageModelTextPart("ok")])],
				name: undefined,
			}], { toolResultMode: "tool" });
			const second = convertMessages([{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelToolCallPart("", "stable_tool", secondInput)],
				name: undefined,
			}, {
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelToolResultPart("", [new vscode.LanguageModelTextPart("ok")])],
				name: undefined,
			}], { toolResultMode: "tool" });

			assert.strictEqual(first[0].tool_calls?.[0].id, second[0].tool_calls?.[0].id);
			assert.strictEqual(
				first[0].tool_calls?.[0].function.arguments,
				'{"a":{"b":3,"y":2},"z":1}'
			);
		});

        test("convertTools returns function tool definitions", () => {
			const out = convertTools({
				tools: [
					{
						name: "do_something",
						description: "Does something",
						inputSchema: { type: "object", properties: { x: { type: "number" } }, additionalProperties: false },
					},
				],
				toolMode: vscode.LanguageModelChatToolMode.Auto,
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);

			assert.ok(out);
			assert.equal(out.tool_choice, "auto");
			assert.ok(Array.isArray(out.tools) && out.tools[0].type === "function");
			assert.equal(out.tools[0].function.name, "do_something");
		});

		test("convertTools respects ToolMode.Required for single tool", () => {
			const out = convertTools({
				toolMode: vscode.LanguageModelChatToolMode.Required,
				tools: [
					{
						name: "only_tool",
						description: "Only tool",
						inputSchema: {},
					},
				],
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);
			assert.deepEqual(out.tool_choice, { type: "function", function: { name: "only_tool" } });
		});

        test("convertTools suppresses run_vscode_command when run_in_terminal exists", () => {
            const out = convertTools({
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                tools: [
                    {
                        name: "run_vscode_command",
                        description: "Run a VS Code command",
                        inputSchema: { type: "object", properties: {} },
                    },
                    {
                        name: "run_in_terminal",
                        description: "Run a terminal command",
                        inputSchema: { type: "object", properties: {} },
                    },
                ],
            } satisfies vscode.ProvideLanguageModelChatResponseOptions);

            const names = (out.tools ?? []).map(t => t.function.name);
            assert.ok(names.includes("run_in_terminal"));
            assert.ok(!names.includes("run_vscode_command"));
        });

        test("convertTools tells models to reuse the persistent terminal safely", () => {
            const out = convertTools({
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                tools: [{
                    name: "run_in_terminal",
                    description: "Run a terminal command",
                    inputSchema: { type: "object", properties: {} },
                }],
            } satisfies vscode.ProvideLanguageModelChatResponseOptions);

            const description = out.tools?.[0]?.function.description ?? "";
            assert.ok(description.includes("keep at most one background terminal"));
            assert.ok(description.includes("120 seconds = 120000"));
            assert.ok(description.includes("Reuse a returned terminal id"));
        });

        test("convertTools keeps run_vscode_command in required mode", () => {
            const out = convertTools({
                toolMode: vscode.LanguageModelChatToolMode.Required,
                tools: [
                    {
                        name: "run_vscode_command",
                        description: "Run a VS Code command",
                        inputSchema: { type: "object", properties: {} },
                    },
                ],
            } satisfies vscode.ProvideLanguageModelChatResponseOptions);

            const names = (out.tools ?? []).map(t => t.function.name);
            assert.deepEqual(names, ["run_vscode_command"]);
            assert.deepEqual(out.tool_choice, { type: "function", function: { name: "run_vscode_command" } });
        });

        test("convertTools apiDirect caps and prioritizes tool list", () => {
            const out = convertTools(
                {
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                    tools: [
                        { name: "random_tool", description: "Random", inputSchema: { type: "object", properties: {} } },
                        { name: "run_in_terminal", description: "Terminal", inputSchema: { type: "object", properties: {} } },
                        { name: "read_file", description: "Read", inputSchema: { type: "object", properties: {} } },
                        { name: "grep_search", description: "Search", inputSchema: { type: "object", properties: {} } },
                    ],
                } satisfies vscode.ProvideLanguageModelChatResponseOptions,
                { mode: "apiDirect", apiDirectMaxTools: 2 }
            );

            const names = (out.tools ?? []).map(t => t.function.name);
            assert.deepEqual(names, ["run_in_terminal", "read_file"]);
        });

        test("convertTools apiDirect keeps runSubagent in a 70-tool subset", () => {
            const fillerTools = Array.from({ length: 79 }, (_, index) => ({
                name: `random_tool_${index}`,
                description: `Random tool ${index}`,
                inputSchema: { type: "object", properties: {} },
            }));
            const out = convertTools(
                {
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                    tools: [
                        ...fillerTools,
                        { name: "runSubagent", description: "Run a listed agent", inputSchema: { type: "object", properties: {} } },
                        { name: "run_in_terminal", description: "Terminal", inputSchema: { type: "object", properties: {} } },
                        { name: "read_file", description: "Read", inputSchema: { type: "object", properties: {} } },
                        { name: "grep_search", description: "Search", inputSchema: { type: "object", properties: {} } },
                    ],
                } satisfies vscode.ProvideLanguageModelChatResponseOptions,
                { mode: "apiDirect", apiDirectMaxTools: 70, apiDirectToolTokenBudget: 65536 }
            );

            const names = (out.tools ?? []).map(t => t.function.name);
            assert.equal(names.length, 70);
            assert.ok(names.includes("runSubagent"));
        });

        test("convertTools apiDirect compacts schema metadata", () => {
            const out = convertTools(
                {
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                    tools: [
                        {
                            name: "read_file",
                            description: "Read file content. Includes extra verbose explanation for tool usage guidance.",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    path: {
                                        type: "string",
                                        description: "Absolute file path",
                                        default: "README.md",
                                    },
                                },
                                required: ["path"],
                            },
                        },
                    ],
                } satisfies vscode.ProvideLanguageModelChatResponseOptions,
                { mode: "apiDirect", apiDirectMaxTools: 8 }
            );

            const tool = out.tools?.[0];
            assert.ok(tool);
            const params = tool?.function.parameters as Record<string, unknown>;
            const props = (params.properties as Record<string, unknown>) ?? {};
            const pathSchema = (props.path as Record<string, unknown>) ?? {};
            assert.ok(typeof tool?.function.description === "string");
            assert.ok((tool?.function.description ?? "").length <= 200);
            assert.equal(pathSchema.description, undefined);
            assert.equal(pathSchema.default, undefined);
        });

        test("convertTools apiDirect prioritizes workspace task tools", () => {
            const out = convertTools(
                {
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                    tools: [
                        { name: "random_tool", description: "Random", inputSchema: { type: "object", properties: {} } },
                        { name: "run_task", description: "Run workspace task", inputSchema: { type: "object", properties: {} } },
                        { name: "get_task_output", description: "Read task output", inputSchema: { type: "object", properties: {} } },
                        { name: "grep_search", description: "Search", inputSchema: { type: "object", properties: {} } },
                    ],
                } satisfies vscode.ProvideLanguageModelChatResponseOptions,
                { mode: "apiDirect", apiDirectMaxTools: 2 }
            );

            const names = (out.tools ?? []).map(t => t.function.name);
            assert.deepEqual(names, ["run_task", "grep_search"]);
        });

        test("convertTools apiDirect adds task output guidance", () => {
            const out = convertTools(
                {
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                    tools: [
                        { name: "run_task", description: "Run workspace task", inputSchema: { type: "object", properties: {} } },
                        { name: "get_task_output", description: "Read task output", inputSchema: { type: "object", properties: {} } },
                    ],
                } satisfies vscode.ProvideLanguageModelChatResponseOptions,
                { mode: "apiDirect", apiDirectMaxTools: 8 }
            );

            const runTask = out.tools?.find(t => t.function.name === "run_task");
            const getTaskOutput = out.tools?.find(t => t.function.name === "get_task_output");
            assert.ok(runTask?.function.description?.includes("existing workspace tasks"));
            assert.ok(getTaskOutput?.function.description?.includes("do not become chat context automatically"));
        });

        test("convertTools apiDirect include-all still suppresses prompt-based command tool", () => {
            const out = convertTools(
                {
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                    tools: [
                        { name: "run_vscode_command", description: "Run VS Code command", inputSchema: { type: "object", properties: {} } },
                        { name: "run_in_terminal", description: "Run terminal command", inputSchema: { type: "object", properties: {} } },
                        { name: "read_file", description: "Read file", inputSchema: { type: "object", properties: {} } },
                    ],
                } satisfies vscode.ProvideLanguageModelChatResponseOptions,
                { mode: "apiDirect", apiDirectIncludeAllTools: true, apiDirectMaxTools: 8 }
            );

            const names = (out.tools ?? []).map(t => t.function.name);
            assert.ok(!names.includes("run_vscode_command"));
            assert.ok(names.includes("run_in_terminal"));
        });

        test("convertTools apiDirect include-all keeps browser and search tools", () => {
            const out = convertTools(
                {
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                    tools: [
                        { name: "open_browser_page", description: "Open browser page", inputSchema: { type: "object", properties: {} } },
                        { name: "read_page", description: "Read browser page", inputSchema: { type: "object", properties: {} } },
                        { name: "click_element", description: "Click element", inputSchema: { type: "object", properties: {} } },
                        { name: "grep_search", description: "Lexical search", inputSchema: { type: "object", properties: {} } },
                        { name: "semantic_search", description: "Semantic search", inputSchema: { type: "object", properties: {} } },
                    ],
                } satisfies vscode.ProvideLanguageModelChatResponseOptions,
                { mode: "apiDirect", apiDirectIncludeAllTools: true, apiDirectMaxTools: 128 }
            );

            const names = new Set((out.tools ?? []).map(t => t.function.name));
            assert.ok(names.has("open_browser_page"));
            assert.ok(names.has("read_page"));
            assert.ok(names.has("click_element"));
            assert.ok(names.has("grep_search"));
            assert.ok(names.has("semantic_search"));
        });

		test("convertTools gives source tools reproducible verification guidance", () => {
			const out = convertTools(
				{
					toolMode: vscode.LanguageModelChatToolMode.Auto,
					tools: [
						{ name: "fetch_webpage", description: "Fetch a page", inputSchema: { type: "object" } },
						{ name: "github_repo", description: "Read repository", inputSchema: { type: "object" } },
						{ name: "github_text_search", description: "Search source", inputSchema: { type: "object" } },
					],
				} satisfies vscode.ProvideLanguageModelChatResponseOptions,
				{ mode: "apiDirect", apiDirectIncludeAllTools: true, apiDirectMaxTools: 8 }
			);

			const byName = new Map((out.tools ?? []).map(tool => [tool.function.name, tool.function.description ?? ""]));
			assert.ok(byName.get("fetch_webpage")?.includes("official documentation"));
			assert.ok(byName.get("github_repo")?.includes("pinned tag or commit"));
			assert.ok(byName.get("github_text_search")?.includes("authoritative"));
		});

		test("convertTools canonicalizes tool and schema order", () => {
			const alpha = {
				name: "alpha_tool",
				description: "Alpha",
				inputSchema: { type: "object", properties: { z: { type: "string" }, a: { type: "number" } } },
			};
			const beta = {
				name: "beta_tool",
				description: "Beta",
				inputSchema: { properties: { a: { type: "number" }, z: { type: "string" } }, type: "object" },
			};
			const forward = convertTools({
				toolMode: vscode.LanguageModelChatToolMode.Auto,
				tools: [beta, alpha],
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);
			const reverse = convertTools({
				toolMode: vscode.LanguageModelChatToolMode.Auto,
				tools: [alpha, beta],
			} satisfies vscode.ProvideLanguageModelChatResponseOptions);

			assert.deepStrictEqual(forward, reverse);
			const firstParameters = forward.tools?.[0].function.parameters as Record<string, unknown> | undefined;
			const firstProperties = firstParameters?.properties as Record<string, unknown> | undefined;
			assert.deepStrictEqual(
				Object.keys(firstProperties ?? {}),
				["a", "z"]
			);
		});

        test("convertTools apiDirect include-all respects max tools cap", () => {
            const out = convertTools(
                {
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                    tools: [
                        { name: "open_browser_page", description: "Open browser page", inputSchema: { type: "object", properties: {} } },
                        { name: "read_page", description: "Read browser page", inputSchema: { type: "object", properties: {} } },
                        { name: "click_element", description: "Click element", inputSchema: { type: "object", properties: {} } },
                        { name: "grep_search", description: "Lexical search", inputSchema: { type: "object", properties: {} } },
                        { name: "semantic_search", description: "Semantic search", inputSchema: { type: "object", properties: {} } },
                    ],
                } satisfies vscode.ProvideLanguageModelChatResponseOptions,
                { mode: "apiDirect", apiDirectIncludeAllTools: true, apiDirectMaxTools: 3 }
            );

            assert.equal((out.tools ?? []).length, 3);
        });

        test("convertTools apiDirect subset never expands past the prioritized default", () => {
            const tools = Array.from({ length: 83 }, (_, index) => ({
				name: `tool_${index}`,
				description: "Utility tool",
				inputSchema: { type: "object", properties: {} },
			}));
			const out = convertTools(
				{ toolMode: vscode.LanguageModelChatToolMode.Auto, tools } satisfies vscode.ProvideLanguageModelChatResponseOptions,
				{ mode: "apiDirect", apiDirectIncludeAllTools: false, apiDirectMaxTools: 128 }
			);

            assert.equal((out.tools ?? []).length, 83);
		});

		test("convertTools apiDirect respects the approximate schema token budget", () => {
			const tools = Array.from({ length: 12 }, (_, index) => ({
				name: `verbose_tool_${index}`,
				description: "Verbose utility tool ".repeat(20),
				inputSchema: {
					type: "object",
					properties: {
						payload: { type: "string", description: "Detailed payload field ".repeat(20) },
					},
				},
			}));
			const out = convertTools(
				{ toolMode: vscode.LanguageModelChatToolMode.Auto, tools } satisfies vscode.ProvideLanguageModelChatResponseOptions,
				{ mode: "apiDirect", apiDirectIncludeAllTools: true, apiDirectMaxTools: 12, apiDirectToolTokenBudget: 256 }
			);

			assert.ok((out.tools ?? []).length >= 1);
			assert.ok((out.tools ?? []).length < tools.length);
		});

		test("convertTools apiDirect prioritizes shared memory tools", () => {
			const out = convertTools(
				{
					toolMode: vscode.LanguageModelChatToolMode.Auto,
					tools: [
						{ name: "unrelated_tool", description: "Other", inputSchema: { type: "object" } },
						{ name: "llamacpp_store_memory", description: "Store memory", inputSchema: { type: "object" } },
						{ name: "llamacpp_search_memory", description: "Search memory", inputSchema: { type: "object" } },
					],
				} satisfies vscode.ProvideLanguageModelChatResponseOptions,
				{ mode: "apiDirect", apiDirectIncludeAllTools: true, apiDirectMaxTools: 2 }
			);

			assert.deepStrictEqual(
				(out.tools ?? []).map(tool => tool.function.name),
				["llamacpp_search_memory", "llamacpp_store_memory"]
			);
		});
    });

    suite("utils/validation", () => {
        test("validateRequest enforces tool result pairing", () => {
            const callId = "xyz";
            const toolCall = new vscode.LanguageModelToolCallPart(callId, "toolA", { q: 1 });
            const toolRes = new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok")]);
            const valid = [
                { role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
                { role: vscode.LanguageModelChatMessageRole.User, content: [toolRes], name: undefined },
            ];
            assert.doesNotThrow(() => validateRequest(valid));

            const invalid = [
                { role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
                { role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart("missing")], name: undefined },
            ];
            assert.throws(() => validateRequest(invalid));
        });
    });
});
