import { createHash } from "node:crypto";

import type { OpenAIChatMessage, OpenAIFunctionToolDef } from "../types";

export interface ToolCallReliabilityOptions {
	repairEnabled: boolean;
	validateSchema: boolean;
}

export interface ToolCallReliabilityMetrics {
	accepted: number;
	repaired: number;
	rejected: number;
	unknownTool: number;
	schemaRejected: number;
	loopDetected: boolean;
}

interface AcceptedToolCall {
	ok: true;
	name: string;
	arguments: Record<string, unknown>;
	repaired: boolean;
}

interface PendingToolCall {
	ok: false;
	pending: true;
}

interface RejectedToolCall {
	ok: false;
	pending: false;
	reason: string;
	kind: "json" | "unknown_tool" | "schema";
}

type ToolCallEvaluation = AcceptedToolCall | PendingToolCall | RejectedToolCall;

export class ToolCallValidationError extends Error {
	constructor(
		message: string,
		readonly toolName?: string,
		readonly kind: RejectedToolCall["kind"] = "json"
	) {
		super(message);
		this.name = "ToolCallValidationError";
	}
}

function emptyMetrics(): ToolCallReliabilityMetrics {
	return {
		accepted: 0,
		repaired: 0,
		rejected: 0,
		unknownTool: 0,
		schemaRejected: 0,
		loopDetected: false,
	};
}

function parseObject(text: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(text) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? value as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}

function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
	return match?.[1]?.trim() ?? trimmed;
}

function extractBalancedObject(text: string): string | undefined {
	const start = text.indexOf("{");
	if (start < 0) {
		return undefined;
	}
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === "{") {
			depth += 1;
		} else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				return text.slice(start, index + 1);
			}
		}
	}
	return undefined;
}

function removeTrailingCommas(text: string): string {
	let output = "";
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			output += char;
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			output += char;
			continue;
		}
		if (char === ",") {
			let next = index + 1;
			while (next < text.length && /\s/.test(text[next])) {
				next += 1;
			}
			if (text[next] === "}" || text[next] === "]") {
				continue;
			}
		}
		output += char;
	}
	return output;
}

export function parseToolArguments(
	text: string,
	allowRepair: boolean
): { ok: true; value: Record<string, unknown>; repaired: boolean } | { ok: false; pending: boolean } {
	const trimmed = text.trim();
	if (!trimmed) {
		return { ok: false, pending: true };
	}
	const exact = parseObject(trimmed);
	if (exact) {
		return { ok: true, value: exact, repaired: false };
	}
	if (!allowRepair) {
		return { ok: false, pending: true };
	}

	const unfenced = stripCodeFence(trimmed);
	const extracted = extractBalancedObject(unfenced) ?? unfenced;
	const repairedText = removeTrailingCommas(extracted);
	const repaired = parseObject(repairedText);
	return repaired
		? { ok: true, value: repaired, repaired: repairedText !== trimmed }
		: { ok: false, pending: false };
}

function valueMatchesType(value: unknown, type: unknown): boolean {
	if (Array.isArray(type)) {
		return type.some(candidate => valueMatchesType(value, candidate));
	}
	switch (type) {
		case undefined:
			return true;
		case "null":
			return value === null;
		case "object":
			return value !== null && typeof value === "object" && !Array.isArray(value);
		case "array":
			return Array.isArray(value);
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		default:
			return true;
	}
}

function validateValue(value: unknown, schemaValue: unknown, path: string, issues: string[]): void {
	if (!schemaValue || typeof schemaValue !== "object") {
		return;
	}
	const schema = schemaValue as Record<string, unknown>;
	if (Array.isArray(schema.anyOf)) {
		const matched = schema.anyOf.some(candidate => {
			const candidateIssues: string[] = [];
			validateValue(value, candidate, path, candidateIssues);
			return candidateIssues.length === 0;
		});
		if (!matched) {
			issues.push(`${path} does not match any allowed schema`);
		}
	}
	if (Array.isArray(schema.oneOf)) {
		const matches = schema.oneOf.filter(candidate => {
			const candidateIssues: string[] = [];
			validateValue(value, candidate, path, candidateIssues);
			return candidateIssues.length === 0;
		}).length;
		if (matches !== 1) {
			issues.push(`${path} must match exactly one allowed schema`);
		}
	}
	if (Array.isArray(schema.allOf)) {
		for (const candidate of schema.allOf) {
			validateValue(value, candidate, path, issues);
		}
	}
	if (!valueMatchesType(value, schema.type)) {
		issues.push(`${path} has the wrong type`);
		return;
	}
	if ("const" in schema && !Object.is(schema.const, value)) {
		issues.push(`${path} does not equal the required constant`);
	}
	if (Array.isArray(schema.enum) && !schema.enum.some(candidate => Object.is(candidate, value))) {
		issues.push(`${path} is not one of the allowed values`);
	}
	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) {
			issues.push(`${path} is below the minimum`);
		}
		if (typeof schema.maximum === "number" && value > schema.maximum) {
			issues.push(`${path} is above the maximum`);
		}
		if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
			issues.push(`${path} must be greater than the exclusive minimum`);
		}
		if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
			issues.push(`${path} must be less than the exclusive maximum`);
		}
		if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
			const quotient = value / schema.multipleOf;
			if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * 16) {
				issues.push(`${path} is not a multiple of ${schema.multipleOf}`);
			}
		}
	}
	if (typeof value === "string") {
		if (typeof schema.minLength === "number" && value.length < schema.minLength) {
			issues.push(`${path} is shorter than the minimum length`);
		}
		if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
			issues.push(`${path} is longer than the maximum length`);
		}
		if (typeof schema.pattern === "string") {
			try {
				if (!new RegExp(schema.pattern, "u").test(value)) {
					issues.push(`${path} does not match the required pattern`);
				}
			} catch {
				// Invalid schemas are ignored rather than rejecting valid model output.
			}
		}
	}
	if (Array.isArray(value) && schema.items) {
		value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, issues));
	}
	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) {
			issues.push(`${path} has too few items`);
		}
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
			issues.push(`${path} has too many items`);
		}
		if (schema.uniqueItems === true) {
			const serialized = value.map(item => JSON.stringify(item));
			if (new Set(serialized).size !== serialized.length) {
				issues.push(`${path} must contain unique items`);
			}
		}
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const objectValue = value as Record<string, unknown>;
		const properties = schema.properties && typeof schema.properties === "object"
			? schema.properties as Record<string, unknown>
			: {};
		const required = Array.isArray(schema.required)
			? schema.required.filter((item): item is string => typeof item === "string")
			: [];
		for (const name of required) {
			if (!(name in objectValue)) {
				issues.push(`${path}.${name} is required`);
			}
		}
		for (const [name, child] of Object.entries(objectValue)) {
			if (name in properties) {
				validateValue(child, properties[name], `${path}.${name}`, issues);
			} else if (schema.additionalProperties === false) {
				issues.push(`${path}.${name} is not allowed`);
			} else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
				validateValue(child, schema.additionalProperties, `${path}.${name}`, issues);
			}
		}
		const propertyCount = Object.keys(objectValue).length;
		if (typeof schema.minProperties === "number" && propertyCount < schema.minProperties) {
			issues.push(`${path} has too few properties`);
		}
		if (typeof schema.maxProperties === "number" && propertyCount > schema.maxProperties) {
			issues.push(`${path} has too many properties`);
		}
	}
}

export function validateToolArguments(argumentsValue: Record<string, unknown>, schema: object | undefined): string[] {
	const issues: string[] = [];
	validateValue(argumentsValue, schema, "$", issues);
	return issues.slice(0, 8);
}

function repairTerminalTimeout(
	name: string,
	argumentsValue: Record<string, unknown>,
	repairEnabled: boolean
): boolean {
	if (!repairEnabled || name !== "run_in_terminal" || argumentsValue.mode !== "sync") {
		return false;
	}
	const timeout = argumentsValue.timeout;
	if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 999) {
		return false;
	}
	argumentsValue.timeout = timeout * 1_000;
	return true;
}

/**
 * Auto-fills empty string defaults for the `description` field when it is required but missing.
 * VS Code Copilot tools (e.g. subagent dispatch) often require `description` in their input
 * schema, but local models may omit it. An empty description is safe as a fallback.
 */
function repairMissingRequiredDescription(
	argumentsValue: Record<string, unknown>,
	schema: object | undefined,
	repairEnabled: boolean
): boolean {
	if (!repairEnabled || !schema || typeof schema !== "object") {
		return false;
	}
	if ("description" in argumentsValue) {
		return false;
	}
	const schemaObj = schema as Record<string, unknown>;
	const required = Array.isArray(schemaObj.required)
		? schemaObj.required.filter((item): item is string => typeof item === "string")
		: [];
	if (!required.includes("description")) {
		return false;
	}
	const properties = schemaObj.properties && typeof schemaObj.properties === "object"
		? schemaObj.properties as Record<string, unknown>
		: {};
	const descSchema = properties["description"];
	// Only fill if the schema expects a string (most common case).
	// Handle both direct "string" type and type unions like ["string", "null"].
	if (descSchema && typeof descSchema === "object") {
		const descType = (descSchema as Record<string, unknown>).type;
		const isStringType =
			descType === "string" ||
			(Array.isArray(descType) && descType.includes("string"));
		if (isStringType) {
			argumentsValue["description"] = "";
			return true;
		}
	}
	return false;
}

export class ToolCallReliabilityGuard {
	private definitions = new Map<string, OpenAIFunctionToolDef>();
	private namesByLowerCase = new Map<string, string>();
	private catalogConfigured = false;
	private options: ToolCallReliabilityOptions = { repairEnabled: true, validateSchema: true };
	private metrics = emptyMetrics();

	configure(tools: readonly OpenAIFunctionToolDef[] | undefined, options: ToolCallReliabilityOptions): void {
		this.definitions.clear();
		this.namesByLowerCase.clear();
		this.catalogConfigured = true;
		for (const tool of tools ?? []) {
			this.definitions.set(tool.function.name, tool);
			this.namesByLowerCase.set(tool.function.name.toLocaleLowerCase(), tool.function.name);
		}
		this.options = options;
		this.metrics = emptyMetrics();
	}

	evaluate(nameValue: string | undefined, argumentText: string, final: boolean): ToolCallEvaluation {
		const parsed = parseToolArguments(argumentText, final && this.options.repairEnabled);
		if (!parsed.ok) {
			if (parsed.pending && !final) {
				return { ok: false, pending: true };
			}
			this.metrics.rejected += 1;
			return { ok: false, pending: false, kind: "json", reason: "arguments are not a valid JSON object" };
		}

		const rawName = String(nameValue ?? "").trim().replace(/^`+|`+$/g, "");
		let name = rawName;
		let repaired = parsed.repaired;
		if (this.catalogConfigured && !this.definitions.has(name)) {
			const canonical = this.namesByLowerCase.get(name.toLocaleLowerCase());
			if (canonical && this.options.repairEnabled) {
				name = canonical;
				repaired = true;
			} else {
				if (!final) {
					return { ok: false, pending: true };
				}
				this.metrics.rejected += 1;
				this.metrics.unknownTool += 1;
				return { ok: false, pending: false, kind: "unknown_tool", reason: `unknown tool: ${rawName || "<missing>"}` };
			}
		}
		if (repairTerminalTimeout(name, parsed.value, this.options.repairEnabled)) {
			repaired = true;
		}

		const definition = this.definitions.get(name);
		if (this.options.repairEnabled) {
			if (repairMissingRequiredDescription(parsed.value, definition?.function.parameters, this.options.repairEnabled)) {
				repaired = true;
			}
		}
		if (this.options.validateSchema && definition) {
			const issues = validateToolArguments(parsed.value, definition.function.parameters);
			if (issues.length > 0) {
				if (!final) {
					return { ok: false, pending: true };
				}
				this.metrics.rejected += 1;
				this.metrics.schemaRejected += 1;
				return { ok: false, pending: false, kind: "schema", reason: issues.join("; ") };
			}
		}

		this.metrics.accepted += 1;
		if (repaired) {
			this.metrics.repaired += 1;
		}
		return { ok: true, name, arguments: parsed.value, repaired };
	}

	markLoopDetected(): void {
		this.metrics.loopDetected = true;
	}

	consumeMetrics(): ToolCallReliabilityMetrics {
		const result = { ...this.metrics };
		this.metrics = emptyMetrics();
		return result;
	}
}

function canonicalToolSignature(name: string, argumentText: string): string | undefined {
	const parsed = parseToolArguments(argumentText, true);
	if (!parsed.ok) {
		return undefined;
	}
	return `${name}:${JSON.stringify(parsed.value)}`;
}

export interface ToolLoopDetection {
	toolName: string;
	repetitions: number;
	signatureHash: string;
}

export function detectRepeatedToolCallLoop(
	messages: readonly OpenAIChatMessage[],
	threshold: number
): ToolLoopDetection | undefined {
	const signatures: Array<{ name: string; signature: string }> = [];
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
			continue;
		}
		for (const call of message.tool_calls) {
			const signature = canonicalToolSignature(call.function.name, call.function.arguments);
			if (signature) {
				signatures.push({ name: call.function.name, signature });
			}
		}
	}
	if (signatures.length < threshold) {
		return undefined;
	}
	const latest = signatures[signatures.length - 1];
	let repetitions = 0;
	for (let index = signatures.length - 1; index >= 0; index -= 1) {
		if (signatures[index].signature !== latest.signature) {
			break;
		}
		repetitions += 1;
	}
	if (repetitions < threshold) {
		return undefined;
	}
	return {
		toolName: latest.name,
		repetitions,
		signatureHash: createHash("sha256").update(latest.signature).digest("hex").slice(0, 12),
	};
}

export function injectToolLoopGuard(
	messages: readonly OpenAIChatMessage[],
	detection: ToolLoopDetection | undefined
): OpenAIChatMessage[] {
	const next = messages.map(message => ({ ...message }));
	if (!detection) {
		return next;
	}
	return [
		...next,
		{
			role: "user",
			content: [
				"Tool reliability guard:",
				`The identical ${detection.toolName} call has already been attempted ${detection.repetitions} consecutive times.`,
				"Do not repeat it with the same arguments. Use the existing result, inspect the error, change the approach, or explain what blocks progress.",
			].join("\n"),
		},
	];
}
