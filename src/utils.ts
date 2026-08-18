import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { enhanceSubagentToolDescription } from "./subagent-guidance";
import type { OpenAIChatMessage, OpenAIContentPart, OpenAIChatRole, OpenAIFunctionToolDef, OpenAIToolCall } from "./types";

// --- Bounded LRU map (shared by caches that must not grow unbounded) ---

/**
 * A Map with a maximum capacity.  When the map would exceed `maxSize` after
 * inserting a new key, the oldest entry (first in insertion order) is evicted
 * — unless it is the freshly inserted key itself.
 */
export class BoundedMap<K, V> {
	private readonly _map = new Map<K, V>();
	constructor(private readonly maxSize: number) {}

	get(key: K): V | undefined { return this._map.get(key); }
	set(key: K, value: V): this {
		this._map.delete(key);
		this._map.set(key, value);
		while (this._map.size > this.maxSize) {
			const oldest = this._map.keys().next().value as K | undefined;
			if (oldest === undefined || oldest === key) {
				break;
			}
			this._map.delete(oldest);
		}
		return this;
	}
	delete(key: K): boolean { return this._map.delete(key); }
	clear(): void { this._map.clear(); }
	get size(): number { return this._map.size; }
	keys(): IterableIterator<K> { return this._map.keys(); }

	/** Iterate entries in insertion order (oldest first). */
	[Symbol.iterator](): IterableIterator<[K, V]> { return this._map[Symbol.iterator](); }
}

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

    let t = schema.type as string | string[] | undefined;
    // Normalize type unions (e.g., ["string","null"]) to the first string type,
    // so downstream code that checks `type === "string"` works correctly.
    if (Array.isArray(t)) {
        const firstString = t.find((item): item is string => typeof item === "string");
        t = firstString ?? String(t[0]);
        schema.type = t;
    }
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
 * Short `D.MM HH:MM` reset label for subscription usage windows, e.g.
 * `2.08 17:25` for August 2nd, 17:25 local time.
 */
export function formatShortResetTime(reset: Date): string {
	const day = reset.getDate();
	const month = String(reset.getMonth() + 1).padStart(2, "0");
	const hours = String(reset.getHours()).padStart(2, "0");
	const minutes = String(reset.getMinutes()).padStart(2, "0");
	return `${day}.${month} ${hours}:${minutes}`;
}

/**
 * Produces stable JSON for semantically identical tool arguments and schemas.
 * Object key order is not meaningful in JSON, but it is part of llama.cpp's
 * exact prompt prefix and therefore affects prompt-cache reuse.
 */
export function stableJsonStringify(value: unknown): string {
	// Fast path: primitives don't need cyclic detection or key sorting
	if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
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

interface ConvertMessagesOptions {
	toolResultMode?: ToolResultMode;
	/** When false, image DataParts are converted to text placeholders instead of image_url blocks. */
	supportsImageInput?: boolean;
	/** Strip tool_calls from every assistant message (user tool-result mode: the server sees no tool-role responses at all). */
	stripAllToolCalls?: boolean;
}

interface ConvertToolsOptions {
	mode?: ToolCallingMode;
	apiDirectMaxTools?: number;
	apiDirectIncludeAllTools?: boolean;
	apiDirectToolTokenBudget?: number;
}

interface LanguageModelDataPartLike {
	mimeType: string;
	data: Uint8Array;
}

function asLanguageModelDataPart(value: unknown): LanguageModelDataPartLike | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.mimeType !== "string" || !(candidate.data instanceof Uint8Array)) {
		return undefined;
	}
	return { mimeType: candidate.mimeType, data: candidate.data };
}

/**
 * True for the cache-breakpoint markers VS Code attaches to chat content.
 *
 * These parts carry no model-visible information, but VS Code moves them between
 * messages as a conversation grows. Serializing one into message text rewrites
 * already-sent history on a later turn and destroys the upstream prompt-cache
 * prefix, so they must be dropped before any textual rendering. The check is
 * shape-tolerant because the parts lose their class and `Uint8Array` payload
 * when they cross the extension host boundary.
 */
export function isCacheControlPart(value: unknown): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	return (value as { mimeType?: unknown }).mimeType === "cache_control";
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
	// Serialized thinking parts (constructor name lost during IPC) are plain
	// objects with a `text` property and no `mimeType`.  The `metadata` field
	// is optional so we cannot require it — but any unknown part with `text`
	// and no `mimeType` that isn't a known VS Code part is treated as thinking.
	const isSerializedThinkingPart =
		!isThinkingCtor &&
		typeof obj.text === "string" &&
		obj.mimeType === undefined &&
		!("callId" in obj) &&
		!("tool_call_id" in obj);
	const candidates = [
		obj.reasoning_content,
		obj.reasoning,
		obj.thinking,
		isThinkingCtor ? obj.text : undefined,
		isThinkingCtor ? obj.value : undefined,
		isSerializedThinkingPart ? obj.text : undefined,
	];

	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}

	return "";
}

/**
 * True for text parts that lost their class when crossing the extension-host
 * boundary (plain objects with a string `value` and no tool/result/mime
 * markers). Without this check `instanceof LanguageModelTextPart` misses them
 * and the user's message text silently vanishes from the prompt.
 */
function isSerializedTextPart(part: unknown): boolean {
	if (!part || typeof part !== "object") {
		return false;
	}
	const obj = part as Record<string, unknown>;
	return (
		typeof obj.value === "string" &&
		obj.mimeType === undefined &&
		!("callId" in obj) &&
		!("tool_call_id" in obj) &&
		!("name" in obj) &&
		!("input" in obj) &&
		!(Array.isArray(obj.content))
	);
}

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
		const toolResults: { callId: string; content: string; dataParts: LanguageModelDataPartLike[]; name?: string }[] = [];
		const dataParts: LanguageModelDataPartLike[] = [];

		for (const [partIndex, part] of (m.content ?? []).entries()) {
			if (part instanceof vscode.LanguageModelTextPart) {
				textParts.push(part.value);
			} else if (isSerializedTextPart(part)) {
				// Parts can cross the extension-host boundary as plain objects
				// (constructor name lost), so `instanceof` silently misses them
				// and the user's text would vanish from the prompt. Match by
				// shape instead: a `value` string with no tool/result/mime
				// markers is a text part.
				textParts.push((part as { value: string }).value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				let args = "{}";
				try {
					args = stableJsonStringify(part.input ?? {});
				} catch {
					// Keep the fallback value when serialization fails.
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
				const collected = collectToolResultContent(part as { content?: ReadonlyArray<unknown> });
				toolResults.push({ callId, ...collected, name: knownToolNames.get(callId) });
			} else if (isCacheControlPart(part)) {
				continue;
			} else if (part instanceof vscode.LanguageModelDataPart) {
				const dataPart = asLanguageModelDataPart(part);
				if (dataPart) {
					dataParts.push(dataPart);
				}
			} else {
				const thinkingText = collectThinkingPartText(part);
				if (thinkingText) {
					reasoningParts.push(thinkingText);
				}
			}
		}

		// Build multimodal content when images are present.
		// For providers without image support (DeepSeek), images degrade to text placeholders.
		const buildContentPayload = (
			text: string,
			contentDataParts: readonly LanguageModelDataPartLike[]
		): string | OpenAIContentPart[] | undefined => {
			if (contentDataParts.length === 0) {
				return text || undefined;
			}
			const canSendImages = options?.supportsImageInput === true;
			const contentParts: OpenAIContentPart[] = [];
			for (const dp of contentDataParts) {
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
			const callMeta = tr.callId ? ` call_id=${tr.callId}` : "";
			const nameMeta = tr.name ? ` name=${tr.name}` : "";
			const prefix = `[tool_result${callMeta}${nameMeta}]`;
			if (toolResultMode === "tool" && tr.callId) {
				let toolContent = tr.content || "";
				if (tr.dataParts.length > 0 && options?.supportsImageInput !== true) {
					const placeholders = tr.dataParts.map(dp => {
						const sizeKb = (dp.data.byteLength / 1024).toFixed(1);
						return `[Image: ${dp.mimeType}, ${sizeKb} KB — image input not supported by this provider]`;
					});
					toolContent = [toolContent, ...placeholders].filter(Boolean).join("\n");
				}
				raw.push({ role: "tool", tool_call_id: tr.callId, name: tr.name, content: toolContent });
				if (tr.dataParts.length > 0 && options?.supportsImageInput === true) {
					const imagePayload = buildContentPayload(`${prefix}\nImage output from the tool:`, tr.dataParts);
					if (imagePayload) {
						raw.push({ role: "user", content: imagePayload });
					}
				}
				continue;
			}

			const toolText = tr.content ? `${prefix}\n${tr.content}` : prefix;
			raw.push({ role: "user", content: buildContentPayload(toolText, tr.dataParts) ?? toolText });
		}

		const contentPayload = buildContentPayload(textParts.join(""), dataParts);
		if (contentPayload && (role === "system" || role === "user" || (role === "assistant" && !emittedAssistantToolCall))) {
			const msg: OpenAIChatMessage = { role, content: contentPayload };
			const reasoningContent = reasoningParts.join("");
			if (reasoningContent) {
				msg.reasoning_content = reasoningContent;
			}
			raw.push(msg);
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
	// In user mode results are plain user messages, so the server sees
	// assistant tool_calls with no tool-role responses at all and rejects
	// the sequence (DeepSeek 400). Strip all assistant tool_calls; the
	// results remain in the transcript as user text.
	return sanitizeOrphanToolCalls(
		merged,
		options?.stripAllToolCalls === true || toolResultMode !== "tool"
	);
}

/**
 * Removes tool_calls from assistant messages that are not immediately
 * followed by enough tool-result messages. OpenAI-compatible servers reject
 * such sequences with 400 "insufficient tool messages following tool_calls
 * message". Orphans appear when a turn was interrupted/steered while a
 * native tool card was still pending, or when a subagent context drops
 * tool results while keeping the assistant tool_calls message.
 *
 * In user tool-result mode the results are plain user messages, so the
 * server sees assistant tool_calls with no tool-role responses at all —
 * DeepSeek rejects those unconditionally. In that mode all assistant
 * tool_calls are stripped (the results remain in the transcript as user
 * text, so no information is lost).
 */
function sanitizeOrphanToolCalls(
	messages: OpenAIChatMessage[],
	stripAllToolCalls: boolean
): OpenAIChatMessage[] {
	const isToolResultLike = (message: OpenAIChatMessage): boolean =>
		message.role === "tool"
		|| (message.role === "user" && typeof message.content === "string"
			&& (message.content.includes("[tool_result") || message.content.includes("call_id=")));
	let stripped = 0;
	const sanitized = messages.map((message, index) => {
		if (
			message.role !== "assistant"
			|| !Array.isArray(message.tool_calls)
			|| message.tool_calls.length === 0
		) {
			return message;
		}
		// Count only the tool results IMMEDIATELY following this assistant
		// message — a user text message in between breaks the required
		// assistant(tool_calls) → tool(...) sequence for the server.
		let followingResults = 0;
		for (let j = index + 1; j < messages.length && isToolResultLike(messages[j]); j++) {
			followingResults += 1;
		}
		if (stripAllToolCalls || followingResults < message.tool_calls.length) {
			stripped += 1;
			const rest: OpenAIChatMessage = { role: message.role, content: message.content };
			if (message.reasoning_content !== undefined) {
				rest.reasoning_content = message.reasoning_content;
			}
			return rest;
		}
		return message;
	});
	if (stripped > 0 && typeof console !== "undefined") {
		console.warn(`[Llama.cpp Provider] Stripped orphan tool_calls from ${stripped} assistant message(s)`);
	}
	return sanitized;
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
			// Editing tools must never fall out of the apiDirect catalog when it
			// is capped at 70 tools: a missing multi_replace_string_in_file made
			// the model call it → "unknown tool" → repair retry → visible
			// duplicate edit attempts while nothing actually executed.
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
				multi_replace_string_in_file: 167,
				edit_file: 166,
				text_document_edit: 166,
				apply_edit: 166,
				replace_string_in_file: 164,
				get_changed_files: 160,
				create_file: 156,
				delete_file: 154,
				move_file: 153,
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
		// Fast path: primitives and arrays of primitives
		if (value === null || value === undefined || typeof value !== "object") {
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
			: Math.min(apiDirectMaxTools, 100);
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
 * Collect text and image data from a tool result.
 * @param pr Tool result-like object with content array.
 */
/**
 * Collects text content and preserves image DataParts from a tool result part.
 *
 * @param pr - The tool result part with content.
 * @returns The concatenated text plus image data parts.
 */
function collectToolResultContent(pr: { content?: ReadonlyArray<unknown> }): {
	content: string;
	dataParts: LanguageModelDataPartLike[];
} {
	let text = "";
	const dataParts: LanguageModelDataPartLike[] = [];
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (typeof c === "string") {
			text += c;
		} else if (isCacheControlPart(c)) {
			// Dropped before the JSON.stringify fallback below, which would otherwise
			// serialize the marker straight into the tool result text.
			continue;
		} else {
			const dataPart = asLanguageModelDataPart(c);
			if (dataPart) {
				if (dataPart.mimeType.startsWith("image/")) {
					dataParts.push(dataPart);
				} else if (dataPart.mimeType === "text/plain" || dataPart.mimeType === "text/markdown") {
					text += new TextDecoder().decode(dataPart.data);
				}
				continue;
			}
			try {
				text += JSON.stringify(c);
			} catch {
				/* ignore */
			}
		}
	}
	return { content: text, dataParts };
}

// --- Shared helpers (single implementations for previously duplicated code) ---

/**
 * Casts an unknown value to a plain record, or returns an empty record for
 * non-objects and arrays. Strict version — arrays are never treated as records.
 */
export function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

/**
 * Parses an unknown value as an integer clamped to [minimum, maximum], using
 * `fallback` for non-finite input. Canonical argument order: value, min, max,
 * fallback (previously duplicated with conflicting orders across modules).
 */
export function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

/** Truncates a string with an ellipsis when it exceeds maxChars. */
export function truncate(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

/**
 * Strips cursor position report (CPR) noise from terminal tool output.
 *
 * Bash/readline queries the cursor position with ESC[6n when re-drawing long
 * prompts. On Windows git-bash the reply (ESC[row;colR) occasionally leaks
 * into the terminal buffer instead of being consumed, so tool results contain
 * stray "[22;3R" / "3R[21;5R[21;11R" lines that confuse models. The VS Code
 * bundles never send ESC[6n (verified 2026-08-16), so the query comes from
 * the shell itself and cannot be fixed on the VS Code side; filtering the
 * leaked replies out of tool output is the reliable fix.
 */
export function stripTerminalControlNoise(text: string): string {
        if (!text.includes("[") || !text.includes("R")) {
                return text;
        }
        // Full CPR sequences including the escape character. Built from a
        // string so the escape is visible and eslint no-control-regex is happy.
        const cprPattern = new RegExp(String.fromCharCode(27) + "\\[\\d+;\\d+R", "g");
        const cleaned = text.replace(cprPattern, "");
        const out: string[] = [];
        for (const line of cleaned.split("\n")) {
                // Bare CPR chains glued to a prompt, e.g. "$ [22;3R" -> "$ ".
                const stripped = line.replace(/(\s)(?:\[\d+;\d+R)+/g, "$1");
                const trimmed = stripped.trim();
                // A line that is nothing but CPR noise (possibly a chain whose
                // first token lost its opening bracket, e.g. "3R[21;5R[21;11R").
                if (/^(?:\[\d+;\d+R|\d*R(?:\[\d+;\d+R)+)$/.test(trimmed)) {
                        continue;
                }
                // Prompt-only residue left after CPR removal.
                if (/^[$>]\s*$/.test(trimmed)) {
                        continue;
                }
                out.push(stripped);
        }
        return out.join("\n");
}

/** Node-compatible binary-to-base64 (Buffer path; faster than btoa loops). */
export function bytesToBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** Normalizes a Copilot turn index to a safe integer (or undefined). */
export function normalizeCopilotTurnIndex(value: unknown): number | undefined {
	const numeric = typeof value === "number" ? value : Number.NaN;
	return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

/** Extracts plain text from a chat message content (string or parts). */
export function contentToText(content: OpenAIChatMessage["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map(part => part.type === "text" && typeof part.text === "string" ? part.text : "")
			.join("\n");
	}
	return "";
}

/** Parses an unknown value as a non-negative integer (0 for invalid input). */
export function nonNegativeInteger(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.floor(value))
		: 0;
}

/** Formats a token count as 1.2K / 3.4M / plain number. */
export function formatTokenCount(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(1)}K`;
	}
	return String(value);
}
