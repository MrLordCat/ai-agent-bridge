import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { enhanceSubagentToolDescription } from "./subagent-guidance";
import type { OpenAIChatMessage, OpenAIContentPart, OpenAIChatRole, OpenAIFunctionToolDef, OpenAIToolCall } from "./types";

// Tool calling sanitization helpers

/**
 * Checks if a property name is likely to represent an integer value.
 * Uses heuristics based on common integer-related keywords.
 *
 * @param propertyName - The property name to check.
 * @returns True if the property name suggests an integer, false otherwise.
 */
function isIntegerLikePropertyName(propertyName: string | undefined): boolean {
    if (!propertyName){
		return false;
	}
    const lowered = propertyName.toLowerCase();
    const integerMarkers = [
        "id",
        "limit",
        "count",
        "index",
        "size",
        "offset",
        "length",
        "results_limit",
        "maxresults",
        "debugsessionid",
        "cellid",
    ];
    return integerMarkers.some((m) => lowered.includes(m)) || lowered.endsWith("_id");
}

/**
 * Sanitizes a function name to make it safe for use.
 * Replaces invalid characters and ensures it starts with a letter.
 *
 * @param name - The original function name.
 * @returns The sanitized function name.
 */
function sanitizeFunctionName(name: unknown): string {
    if (typeof name !== "string" || !name){
		return "tool";
	}
    let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!/^[a-zA-Z]/.test(sanitized)) {
        sanitized = `tool_${sanitized}`;
    }
    sanitized = sanitized.replace(/_+/g, "_");
    return sanitized.slice(0, 64);
}

/**
 * Prunes unknown or unsupported keywords from a JSON schema.
 * Keeps only allowed schema properties for compatibility.
 *
 * @param schema - The schema object to prune.
 * @returns The pruned schema object.
 */
function pruneUnknownSchemaKeywords(schema: unknown): Record<string, unknown> {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)){
		return {};
	}
    const allow = new Set([
        "type",
        "properties",
        "required",
        "additionalProperties",
        "description",
        "enum",
        "default",
        "items",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "pattern",
        "format",
    ]);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
        if (allow.has(k)){
			out[k] = v as unknown;
		}
    }
    return out;
}

/**
 * Sanitizes a JSON schema by pruning unknown keywords and processing properties.
 * Recursively cleans the schema for safe use in tool definitions.
 *
 * @param input - The schema to sanitize.
 * @param propName - Optional property name for context.
 * @returns The sanitized schema.
 */
function sanitizeSchema(input: unknown, propName?: string): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return { type: "object", properties: {} } as Record<string, unknown>;
    }

    let schema = input as Record<string, unknown>;

    for (const composite of ["anyOf", "oneOf", "allOf"]) {
        const branch = (schema as Record<string, unknown>)[composite] as unknown;
        if (Array.isArray(branch) && branch.length > 0) {
            let preferred: Record<string, unknown> | undefined;
            for (const b of branch) {
                if (b && typeof b === "object" && (b as Record<string, unknown>).type === "string") {
                    preferred = b as Record<string, unknown>;
                    break;
                }
            }
            schema = { ...(preferred ?? (branch[0] as Record<string, unknown>)) };
            break;
        }
    }

    schema = pruneUnknownSchemaKeywords(schema);

    let t = schema.type as string | undefined;
    if (t == null) {
        t = "object";
        schema.type = t;
    }

    if (t === "number" && propName && isIntegerLikePropertyName(propName)) {
        schema.type = "integer";
        t = "integer";
    }

    if (t === "object") {
        const props = (schema.properties as Record<string, unknown> | undefined) ?? {};
        const newProps: Record<string, unknown> = {};
        if (props && typeof props === "object") {
            for (const [k, v] of Object.entries(props)) {
                newProps[k] = sanitizeSchema(v, k);
            }
        }
        schema.properties = newProps;

        const req = schema.required as unknown;
        if (Array.isArray(req)) {
            schema.required = req.filter((r) => typeof r === "string");
        } else if (req !== undefined) {
            schema.required = [];
        }

        const ap = schema.additionalProperties as unknown;
        if (ap !== undefined && typeof ap !== "boolean") {
            delete schema.additionalProperties;
        }
    } else if (t === "array") {
        const items = schema.items as unknown;
        if (Array.isArray(items) && items.length > 0) {
            schema.items = sanitizeSchema(items[0]);
        } else if (items && typeof items === "object") {
            schema.items = sanitizeSchema(items);
        } else {
            schema.items = { type: "string" } as Record<string, unknown>;
        }
    }

    return schema;
}

function appendToolDescription(base: string, extra: string | undefined): string {
	if (!extra) {
		return base;
	}
	if (!base) {
		return extra;
	}
	return `${base}\n\n${extra}`;
}

/**
 * Produces stable JSON for semantically identical tool arguments and schemas.
 * Object key order is not meaningful in JSON, but it is part of llama.cpp's
 * exact prompt prefix and therefore affects prompt-cache reuse.
 */
export function stableJsonStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	const normalize = (candidate: unknown): unknown => {
		if (Array.isArray(candidate)) {
			return candidate.map(normalize);
		}
		if (!candidate || typeof candidate !== "object") {
			return candidate;
		}
		if (seen.has(candidate)) {
			throw new TypeError("Cannot stringify a circular JSON value");
		}
		seen.add(candidate);
		const source = candidate as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort((left, right) => left.localeCompare(right))) {
			const item = source[key];
			if (item !== undefined && typeof item !== "function" && typeof item !== "symbol") {
				result[key] = normalize(item);
			}
		}
		seen.delete(candidate);
		return result;
	};

	return JSON.stringify(normalize(value));
}

function getToolExecutionHint(name: string, hasRunInTerminal: boolean): string | undefined {
	switch (name) {
		case "run_in_terminal":
				return "Primary persistent shell tool. Batch related one-off commands in sync mode and keep at most one background terminal. Use async only for an indefinite server, watcher, or daemon. For sync commands omit timeout when possible; timeout is milliseconds (120 seconds = 120000), never 120/300/600 as seconds because expiry creates another background terminal. Reuse a returned terminal id with get_terminal_output or send_to_terminal instead of starting another background job. For large JSON/JSONL files, keep output bounded with head/tail/rg instead of printing entire files.";
		case "run_task":
			return "Use this for existing workspace tasks from tasks.json or detected npm tasks. After starting a task, read its output with get_task_output.";
		case "get_task_output":
			return "Terminal panels do not become chat context automatically; use this to read the captured output of a task started with run_task.";
		case "create_and_run_task":
			return hasRunInTerminal
				? "Do NOT use this to run scripts or ad-hoc commands. Use run_in_terminal instead."
				: "Use only for existing VS Code tasks defined in tasks.json. For running scripts or ad-hoc commands, prefer run_in_terminal.";
		case "terminal_last_command":
			return "Use this only to inspect the last command already run in an existing terminal when its output is needed.";
		case "terminal_selection":
			return "Use this only to inspect user-selected text from a terminal pane.";
		case "run_vscode_command":
			return hasRunInTerminal
				? "Do not use this to create terminals or run shell commands. Use run_in_terminal instead."
				: "Use only for VS Code UI commands, not shell command execution.";
		case "fetch_webpage":
			return "Use for live, source-backed verification. Prefer official documentation, specifications, release notes, and stable versioned pages; retain the direct URL and relevant version or publication date.";
		case "github_repo":
			return "Use to inspect upstream implementation when documented behavior is incomplete. Prefer a pinned tag or commit over a moving default branch and report the revision used.";
		case "github_text_search":
			return "Use to locate implementation evidence, then inspect the surrounding source at a pinned tag or commit before treating the match as authoritative.";
		default:
			return undefined;
	}
}

export type ToolResultMode = "user" | "tool";
export type ToolCallingMode = "classic" | "apiDirect";

export interface ConvertMessagesOptions {
	toolResultMode?: ToolResultMode;
	/** When false, image DataParts are converted to text placeholders instead of image_url blocks. */
	supportsImageInput?: boolean;
}

export interface ConvertToolsOptions {
	mode?: ToolCallingMode;
	apiDirectMaxTools?: number;
	apiDirectIncludeAllTools?: boolean;
	apiDirectToolTokenBudget?: number;
}

/**
 * Convert a Uint8Array to a base64 string without relying on Buffer (browser-safe).
 */
function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function collectThinkingPartText(part: unknown): string {
	if (!part || typeof part !== "object") {
		return "";
	}
	if (part instanceof vscode.LanguageModelTextPart) {
		return "";
	}

	const obj = part as Record<string, unknown>;
	const ctorName = (part as { constructor?: { name?: string } }).constructor?.name;
	const isThinkingCtor = ctorName === "LanguageModelThinkingPart";
	const candidates = [
		obj.reasoning_content,
		obj.reasoning,
		obj.thinking,
		isThinkingCtor ? obj.text : undefined,
		isThinkingCtor ? obj.value : undefined,
		typeof obj.text === "string" && obj.metadata !== undefined && obj.mimeType === undefined ? obj.text : undefined,
	];

	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}

	return "";
}

/**
 * Convert VS Code chat request messages into OpenAI-compatible message objects.
 * @param messages The VS Code chat messages to convert.
 * @returns OpenAI-compatible messages array.
 */
/**
 * Converts VS Code language model chat messages to OpenAI-compatible format.
 * Transforms message roles and content to match OpenAI's chat completion API.
 *
 * @param messages - Array of VS Code chat messages to convert.
 * @returns Array of OpenAI-compatible chat messages.
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options?: ConvertMessagesOptions
): OpenAIChatMessage[] {
	const toolResultMode: ToolResultMode = options?.toolResultMode === "tool" ? "tool" : "user";
	const knownToolNames = new Map<string, string>();
	const raw: OpenAIChatMessage[] = [];
	for (const [messageIndex, m] of messages.entries()) {
		const role = mapRole(m);
		const textParts: string[] = [];
		const reasoningParts: string[] = [];
		const toolCalls: OpenAIToolCall[] = [];
		const toolResults: { callId: string; content: string; name?: string }[] = [];
		const dataParts: vscode.LanguageModelDataPart[] = [];

		for (const [partIndex, part] of (m.content ?? []).entries()) {
			if (part instanceof vscode.LanguageModelTextPart) {
				textParts.push(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				let args = "{}";
				try {
					args = stableJsonStringify(part.input ?? {});
				} catch {
					args = "{}";
				}
				const fallbackId = createHash("sha256")
					.update(`${messageIndex}:${partIndex}:${part.name}:`)
					.update(args)
					.digest("hex")
					.slice(0, 24);
				const id = part.callId || `call_${fallbackId}`;
				knownToolNames.set(id, part.name);
				toolCalls.push({ id, type: "function", function: { name: part.name, arguments: args } });
			} else if (isToolResultPart(part)) {
				const callId = (part as { callId?: string }).callId ?? "";
				const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
				toolResults.push({ callId, content, name: knownToolNames.get(callId) });
			} else if (part instanceof vscode.LanguageModelDataPart) {
				dataParts.push(part);
			} else {
				const thinkingText = collectThinkingPartText(part);
				if (thinkingText) {
					reasoningParts.push(thinkingText);
				}
			}
		}

		// Build multimodal content when images are present.
		// For providers without image support (DeepSeek), images degrade to text placeholders.
		const buildContentPayload = (): string | OpenAIContentPart[] | undefined => {
			const text = textParts.join("");
			if (dataParts.length === 0) {
				return text || undefined;
			}
			const canSendImages = options?.supportsImageInput === true;
			const contentParts: OpenAIContentPart[] = [];
			for (const dp of dataParts) {
				if (dp.mimeType.startsWith("image/")) {
					if (canSendImages) {
						const base64 = bytesToBase64(dp.data);
						const dataUri = `data:${dp.mimeType};base64,${base64}`;
						contentParts.push({
							type: "image_url",
							image_url: { url: dataUri, detail: "auto" },
						});
					} else {
						// Provider doesn't support images — add a text placeholder.
						const sizeKb = (dp.data.byteLength / 1024).toFixed(1);
						contentParts.push({
							type: "text",
							text: `[Image: ${dp.mimeType}, ${sizeKb} KB — image input not supported by this provider]`,
						});
					}
				} else if (dp.mimeType === "text/plain" || dp.mimeType === "text/markdown") {
					const textContent = new TextDecoder().decode(dp.data);
					contentParts.push({ type: "text", text: textContent });
				}
			}
			if (text) {
				contentParts.unshift({ type: "text", text });
			}
			return contentParts.length > 0 ? contentParts : undefined;
		};

		let emittedAssistantToolCall = false;
		if (toolCalls.length > 0) {
			const assistantMessage: OpenAIChatMessage = {
				role: "assistant",
				content: textParts.join("") || "",
				tool_calls: toolCalls,
			};
			const reasoningContent = reasoningParts.join("");
			if (reasoningContent) {
				assistantMessage.reasoning_content = reasoningContent;
			}
			raw.push(assistantMessage);
			emittedAssistantToolCall = true;
		}

		for (const tr of toolResults) {
			if (toolResultMode === "tool" && tr.callId) {
				raw.push({ role: "tool", tool_call_id: tr.callId, name: tr.name, content: tr.content || "" });
				continue;
			}

			const callMeta = tr.callId ? ` call_id=${tr.callId}` : "";
			const nameMeta = tr.name ? ` name=${tr.name}` : "";
			const prefix = `[tool_result${callMeta}${nameMeta}]`;
			raw.push({ role: "user", content: tr.content ? `${prefix}\n${tr.content}` : prefix });
		}

		const contentPayload = buildContentPayload();
		if (contentPayload && (role === "system" || role === "user" || (role === "assistant" && !emittedAssistantToolCall))) {
			raw.push({ role, content: contentPayload });
		}
	}

	// Post-process to merge consecutive messages of the same role (User/System/Assistant)
	// Post-process: Hoist all System messages to the very top and merge them.
	// This prevents System messages from appearing in the middle of conversation (e.g. User -> System -> User),
	// which causes Jinja template errors in many Llama.cpp models.
	const systemMessages = raw.filter((m) => m.role === "system");
	const nonSystemMessages = raw.filter((m) => m.role !== "system");

	if (systemMessages.length > 0) {
		const mergedSystemContent = systemMessages
			.map((m) => m.content)
			.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
			.join("\n\n");

		if (mergedSystemContent) {
			nonSystemMessages.unshift({ role: "system", content: mergedSystemContent });
		}
	}

	// Post-process to merge consecutive messages of the same role (User/System/Assistant)
	const merged: OpenAIChatMessage[] = [];
	for (const msg of nonSystemMessages) {
		if (merged.length === 0) {
			merged.push(msg);
			continue;
		}
		const last = merged[merged.length - 1];

		// Never merge multimodal (array) content — keep each image message separate.
		const lastHasArrayContent = Array.isArray(last.content);
		const msgHasArrayContent = Array.isArray(msg.content);

		// Case 1: Merge consecutive Assistant messages (text and/or tool calls)
		if (msg.role === "assistant" && last.role === "assistant" && !lastHasArrayContent && !msgHasArrayContent) {
			if (msg.content) {
				last.content = last.content ? String(last.content) + "\n\n" + String(msg.content) : String(msg.content);
			}
			if (msg.reasoning_content) {
				last.reasoning_content = last.reasoning_content
					? `${last.reasoning_content}${msg.reasoning_content}`
					: msg.reasoning_content;
			}
			if (msg.tool_calls) {
				last.tool_calls = [...(last.tool_calls ?? []), ...msg.tool_calls];
			}
			continue;
		}


		// Case 2: Merge consecutive "User-side" messages (User text or Tool results)
		// Strict templates often require strict alternation [User, Assistant, User, Assistant]
		// So we merge all [User, Tool, User, Tool...] sequences into a single User message.
		// Skip merging when either message has multimodal (array) content.

		const isLastUserSide =
			(last.role === "user" && typeof last.content === "string" && !last.tool_calls) ||
			(toolResultMode !== "tool" && last.role === "tool");

		const isMsgUserSide =
			(msg.role === "user" && typeof msg.content === "string" && !msg.tool_calls) ||
			(toolResultMode !== "tool" && msg.role === "tool");

		if (isLastUserSide && isMsgUserSide && !lastHasArrayContent && !msgHasArrayContent) {
			// Ensure target is a Text User message
			if (last.role === "tool") {
				last.role = "user";
				delete last.tool_call_id;
			}

			const nextContent = typeof msg.content === "string" ? msg.content : "";
			last.content = (typeof last.content === "string" ? last.content : "") + "\n\n" + nextContent;
			continue;
		}

		merged.push(msg);
	}
	return merged;
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions.
 * @param options Request options containing tools and toolMode.
 */
/**
 * Converts VS Code language model chat options to OpenAI-compatible tool format.
 * Extracts and transforms tool definitions for API requests.
 *
 * @param options - VS Code chat response options containing tools.
 * @returns Object with tools array and tool_choice configuration.
 */
export function convertTools(options: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: "auto" | { type: "function"; function: { name: string } };
};
export function convertTools(
	options: vscode.ProvideLanguageModelChatResponseOptions,
	convertOptions: ConvertToolsOptions
): {
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: "auto" | { type: "function"; function: { name: string } };
};
export function convertTools(
	options: vscode.ProvideLanguageModelChatResponseOptions,
	convertOptions?: ConvertToolsOptions
): {
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: "auto" | { type: "function"; function: { name: string } };
} {
	const tools = options.tools ?? [];
	if (!tools || tools.length === 0) {
		return {};
	}

	const mode: ToolCallingMode = convertOptions?.mode === "apiDirect" ? "apiDirect" : "classic";
	const apiDirectMaxTools = Number.isInteger(convertOptions?.apiDirectMaxTools)
		? Math.max(1, Math.min(128, convertOptions?.apiDirectMaxTools as number))
		: 128;
	const apiDirectIncludeAllTools = convertOptions?.apiDirectIncludeAllTools === true;
	const apiDirectToolTokenBudget = Number.isInteger(convertOptions?.apiDirectToolTokenBudget)
		? Math.max(256, Math.min(65536, convertOptions?.apiDirectToolTokenBudget as number))
		: 12000;

	const requiredMode = options.toolMode === vscode.LanguageModelChatToolMode.Required;
	const hasRunInTerminal = tools.some((t) => sanitizeFunctionName((t as { name?: string } | undefined)?.name) === "run_in_terminal");
	// When run_in_terminal is available, suppress tools that cause VS Code UI prompts
	// or duplicate ad-hoc shell execution (create_and_run_task, run_vscode_command).
	const suppressedWhenTerminalAvailable = new Set(["run_vscode_command", "create_and_run_task"]);
	const suppressedToolNames: string[] = [];
	const effectiveTools = tools
		.filter((t): t is vscode.LanguageModelChatTool => Boolean(t && typeof t === "object"))
		.filter((t) => {
			const name = sanitizeFunctionName(t.name);
			const suppress = hasRunInTerminal && !requiredMode && suppressedWhenTerminalAvailable.has(name);
			if (suppress) {
				suppressedToolNames.push(name);
			}
			return !suppress;
		});

	if (effectiveTools.length === 0) {
		return {};
	}

	const getToolPriority = (name: string): number => {
		const directPriority: Record<string, number> = {
			run_in_terminal: 200,
			run_task: 198,
			read_file: 195,
			grep_search: 190,
			file_search: 185,
			list_dir: 180,
			get_errors: 176,
			llamacpp_search_memory: 175,
			llamacpp_store_memory: 174,
			semantic_search: 172,
			vscode_listCodeUsages: 168,
			replace_string_in_file: 164,
			get_changed_files: 160,
			create_file: 156,
			create_and_run_task: 152,
			get_task_output: 150,
			get_terminal_output: 148,
			send_to_terminal: 144,
			kill_terminal: 140,
			run_vscode_command: 136,
			memory: 132,
			session_store_sql: 128,
			fetch_webpage: 124,
			view_image: 120,
			vscode_askQuestions: 116,
			vscode_renameSymbol: 112,
			github_repo: 108,
			github_text_search: 104,
			terminal_last_command: 100,
			terminal_selection: 96,
			llamacpp_delete_memory: 92,
			runSubagent: 170,
			executeSubagent: 168,
			exploreSubagent: 166,
			terminate: 164,
		};
		return directPriority[name] ?? 0;
	};

	const sortToolsByPriority = (items: vscode.LanguageModelChatTool[]): vscode.LanguageModelChatTool[] => {
		return [...items].sort((a, b) => {
			const an = sanitizeFunctionName(a.name);
			const bn = sanitizeFunctionName(b.name);
			const priorityDiff = getToolPriority(bn) - getToolPriority(an);
			if (priorityDiff !== 0) {
				return priorityDiff;
			}
			return an.localeCompare(bn);
		});
	};

	const compactApiDirectSchema = (value: unknown): unknown => {
		if (!value || typeof value !== "object") {
			return value;
		}
		if (Array.isArray(value)) {
			return value.map(item => compactApiDirectSchema(item));
		}

		const obj = value as Record<string, unknown>;
		const next: Record<string, unknown> = {};
		const drop = new Set(["description", "default", "format", "pattern", "minLength", "maxLength"]);
		for (const [key, raw] of Object.entries(obj)) {
			if (drop.has(key)) {
				continue;
			}
			next[key] = compactApiDirectSchema(raw);
		}
		return next;
	};

	const normalizeDescriptionForMode = (name: string, description: string): string => {
		if (mode !== "apiDirect") {
			return description;
		}
		const compact = description.replace(/\s+/g, " ").trim();
		if (!compact) {
			return `Execute ${name}`;
		}

		const sentenceSplit = compact.split(/(?<=[.!?])\s+/);
		const sentence = sentenceSplit[0]?.trim() ?? compact;
		const base = sentence.length >= 24 ? sentence : compact;
		if (base.length <= 200) {
			return base;
		}

		const clipped = base.slice(0, 200);
		const safeCut = Math.max(clipped.lastIndexOf(" "), clipped.lastIndexOf(","));
		const shortened = safeCut >= 80 ? clipped.slice(0, safeCut) : clipped;
		return `${shortened}.`;
	};

	const stableTools = sortToolsByPriority(effectiveTools);
	const selectedTools = (() => {
		if (mode !== "apiDirect" || requiredMode) {
			return stableTools;
		}

		const countLimit = apiDirectIncludeAllTools
			? apiDirectMaxTools
			: Math.min(apiDirectMaxTools, 70);
		return stableTools.slice(0, countLimit);
	})();

	const unbudgetedToolDefs: OpenAIFunctionToolDef[] = selectedTools.map((t) => {
			const name = sanitizeFunctionName(t.name);
			const descriptionBase = typeof t.description === "string" ? t.description : "";
			const description = appendToolDescription(
				enhanceSubagentToolDescription(name, normalizeDescriptionForMode(name, descriptionBase)),
				getToolExecutionHint(name, hasRunInTerminal)
			);
			const params = JSON.parse(stableJsonStringify(
				sanitizeSchema(t.inputSchema ?? { type: "object", properties: {} })
			)) as Record<string, unknown>;
			const normalizedParams = mode === "apiDirect"
				? (JSON.parse(stableJsonStringify(compactApiDirectSchema(params))) as Record<string, unknown>)
				: params;
			return {
				type: "function" as const,
				function: {
					name,
					description,
					parameters: normalizedParams,
				},
			} satisfies OpenAIFunctionToolDef;
		});
	const toolDefs = (() => {
		if (mode !== "apiDirect" || requiredMode) {
			return unbudgetedToolDefs;
		}

		const selected: OpenAIFunctionToolDef[] = [];
		let estimatedTokens = 0;
		for (const definition of unbudgetedToolDefs) {
			const definitionTokens = Math.max(1, Math.ceil(JSON.stringify(definition).length / 4));
			if (selected.length > 0 && estimatedTokens + definitionTokens > apiDirectToolTokenBudget) {
				continue;
			}
			selected.push(definition);
			estimatedTokens += definitionTokens;
		}
		return selected;
	})();

	let tool_choice: "auto" | { type: "function"; function: { name: string } } = "auto";
	if (requiredMode) {
		if (selectedTools.length !== 1) {
            throw new Error("LanguageModelChatToolMode.Required is not supported with more than one tool");
		}
		tool_choice = { type: "function", function: { name: sanitizeFunctionName(selectedTools[0].name) } };
	}

	return { tools: toolDefs, tool_choice };
}

/**
 * Validate tool names to ensure they contain only word chars, hyphens, or underscores.
 * @param tools Tools to validate.
 */
/**
 * Validates an array of VS Code language model chat tools.
 * Ensures tool definitions are properly structured before use.
 *
 * @param tools - Array of tools to validate.
 */
export function validateTools(tools: readonly vscode.LanguageModelChatTool[]): void {
	for (const tool of tools) {
		if (!tool.name.match(/^[\w-]+$/)) {
            throw new Error(
                `Invalid tool name "${tool.name}": only alphanumeric characters, hyphens, and underscores are allowed.`
            );
		}
	}
}

/**
 * Validate the request message sequence for correct tool call/result pairing.
 * @param messages The full request message list.
 */
/**
 * Validates an array of VS Code language model chat request messages.
 * Checks for proper message structure and content.
 *
 * @param messages - Array of messages to validate.
 */
export function validateRequest(messages: readonly vscode.LanguageModelChatRequestMessage[]): void {
	const lastMessage = messages[messages.length - 1];
	if (!lastMessage) {
		throw new Error("Invalid request: no messages.");
	}

	messages.forEach((message, i) => {
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			const toolCallIds = new Set(
				message.content
					.filter((part) => part instanceof vscode.LanguageModelToolCallPart)
					.map((part) => (part as unknown as vscode.LanguageModelToolCallPart).callId)
			);
			if (toolCallIds.size === 0) {
				return;
			}

			let nextMessageIdx = i + 1;
			const errMsg =
				"Invalid request: Tool call part must be followed by a User message with a LanguageModelToolResultPart with a matching callId.";
			while (toolCallIds.size > 0) {
				const nextMessage = messages[nextMessageIdx++];
				if (!nextMessage || nextMessage.role !== vscode.LanguageModelChatMessageRole.User) {
                    throw new Error(errMsg);
				}

				nextMessage.content.forEach((part) => {
					if (!isToolResultPart(part)) {
                        throw new Error(errMsg);
					}
					const callId = (part as { callId: string }).callId;
					toolCallIds.delete(callId);
				});
			}
		}
	});
}

/**
 * Type guard for LanguageModelToolResultPart-like values.
 * @param value Unknown value to test.
 */
/**
 * Type guard to check if a value is a tool result part.
 * Determines if the value represents a tool call result with callId and content.
 *
 * @param value - The value to check.
 * @returns True if the value is a tool result part, false otherwise.
 */
export function isToolResultPart(value: unknown): value is { callId: string; content?: ReadonlyArray<unknown> } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	const hasCallId = typeof obj.callId === "string";
	const hasContent = "content" in obj;
	return hasCallId && hasContent;
}

/**
 * Map VS Code message role to OpenAI message role string.
 * @param message The message whose role is mapped.
 */
/**
 * Maps a VS Code chat message to an OpenAI-compatible role.
 * Converts VS Code message types to OpenAI roles, excluding tool role.
 *
 * @param message - The VS Code chat message.
 * @returns The corresponding OpenAI role.
 * @author Maruf Bepary
 */
function mapRole(message: vscode.LanguageModelChatRequestMessage): Exclude<OpenAIChatRole, "tool"> {
	const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
	const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
	const r = message.role as unknown as number;
	if (r === USER) {
		return "user";
	}
	if (r === ASSISTANT) {
		return "assistant";
	}
	return "system";
}

/**
 * Concatenate tool result content into a single text string.
 * @param pr Tool result-like object with content array.
 */
/**
 * Collects text content from a tool result part.
 * Extracts and concatenates text from the content array.
 *
 * @param pr - The tool result part with content.
 * @returns The concatenated text content.
 */
function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
	let text = "";
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (typeof c === "string") {
			text += c;
		} else {
			try {
				text += JSON.stringify(c);
			} catch {
				/* ignore */
			}
		}
	}
	return text;
}

/**
 * Try to parse a JSON object from a string.
 * @param text The input string.
 * @returns Parsed object or ok:false.
 */
/**
 * Attempts to parse a string as JSON object.
 * Safely parses JSON and returns success/failure result.
 *
 * @param text - The string to parse as JSON.
 * @returns Object with ok flag and parsed value if successful.
 */
export function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
	try {
		if (!text || !/[{]/.test(text)) {
			return { ok: false };
		}
		const value = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return { ok: true, value };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
}
