import * as assert from "assert";
import * as vscode from "vscode";
import { LlamaCppChatModelProvider, stripCacheControlArtifacts } from "../llama-provider";
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
                assert.strictEqual(deepSeekInfo!.maxOutputTokens, 393216);
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
                10000,
                1,
                "Conversation summary (auto-compact)"
            );

            const summary = compacted.find(msg => msg.role === "system" && typeof msg.content === "string" && msg.content.includes("Conversation summary"));
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

        test("strips every cache_control marker shape so tool text stays stable", () => {
            const legacy = 'result {"$mid":17,"mimeType":"cache_control","data":"QUJD"} tail';
            assert.strictEqual(stripCacheControlArtifacts(legacy), "result  tail");

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

        test("retries a rejected tool call with a bounded correction prompt", async () => {
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
            ];
            const out = convertMessages(messages);
            assert.strictEqual(out.length, 1);
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
            ];

            const out = convertMessages(messages, { toolResultMode: "tool" });
            assert.strictEqual(out.length, 1);
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
			}]);
			const second = convertMessages([{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelToolCallPart("", "stable_tool", secondInput)],
				name: undefined,
			}]);

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

        test("convertTools apiDirect keeps runSubagent in the default 70-tool subset", () => {
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
                { mode: "apiDirect", apiDirectToolTokenBudget: 65536 }
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

            assert.equal((out.tools ?? []).length, 70);
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
