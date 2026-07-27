import type * as vscode from "vscode";
import { enhanceSubagentToolDescription, withRequiredSubagentModel } from "../subagent-guidance";
import { stableJsonStringify } from "../utils";

const MAX_TOOL_DESCRIPTION_CHARS = 4_096;
export const CODEX_DEFERRED_TOOL_NAMESPACE = "vscode_deferred";
export const CODEX_NATIVE_TOOL_NAMESPACE = "vscode_native";
const EAGER_TOOL_SUFFIXES = [
	"readfile",
	"grepsearch",
	"filesearch",
	"semanticsearch",
	"listdir",
	"runinterminal",
	"getterminaloutput",
	"applypatch",
	"createfile",
	"replacestringinfile",
	"multireplacestringinfile",
	"managetodolist",
	"updateplan",
	"getchangedfiles",
	"geterrors",
	"runtests",
	"testfailure",
	"requestuserinput",
	"websearch",
	"fetchwebpage",
	"viewimage",
];
const EXCLUDED_VSCODE_TOOLS = new Set([
	"copilot_editFiles",
	"copilot_switchAgent",
]);
const CODEX_BUILTIN_TOOL_COLLISIONS = new Set([
	"apply_patch",
	"view_image",
]);

export interface CodexDynamicFunctionToolSpec {
	type: "function";
	name: string;
	description: string;
	inputSchema: unknown;
	deferLoading?: boolean;
}

export interface CodexDynamicNamespaceSpec {
	type: "namespace";
	name: string;
	description: string;
	tools: CodexDynamicFunctionToolSpec[];
}

export type CodexDynamicToolSpec = CodexDynamicFunctionToolSpec | CodexDynamicNamespaceSpec;

export interface CodexDynamicToolRuntimeSignature {
	namespace: string | null;
	name: string;
	inputSchema: unknown;
	deferLoading: boolean;
}

export interface CodexDynamicToolSet {
	specs: CodexDynamicToolSpec[];
	callableNames: Set<string>;
	deferredNames: Set<string>;
	toolNamespaces: Map<string, string>;
	runtimeSignatures: CodexDynamicToolRuntimeSignature[];
	skippedNames: string[];
}

export interface CodexDynamicToolCallResponse {
	contentItems: Array<
		| { type: "inputText"; text: string }
		| { type: "inputImage"; imageUrl: string }
	>;
	success: boolean;
}

function normalizeJsonSchema(value: object | undefined): unknown {
	if (!value) {
		return { type: "object", additionalProperties: true };
	}
	try {
		return JSON.parse(stableJsonStringify(value)) as unknown;
	} catch {
		return { type: "object", additionalProperties: true };
	}
}

function isValidDynamicToolName(name: string): boolean {
	return /^[a-zA-Z0-9_-]{1,128}$/.test(name);
}

function isCoreAgentTool(name: string): boolean {
	const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
	return EAGER_TOOL_SUFFIXES.some(suffix => normalized === suffix || normalized.endsWith(suffix));
}

function boundedOutputHint(name: string): string {
	switch (name) {
		case "run_in_terminal":
			return " Keep output bounded: use rg, filters, counts, head, or tail and never dump an entire large log, JSON/JSONL file, repository file list, or binary payload into chat.";
		case "get_terminal_output":
			return " Read only the smallest useful output slice and avoid repeatedly returning the complete terminal buffer.";
		case "read_file":
			return " Read focused line ranges for large files instead of returning the complete file.";
		case "grep_search":
			return " Use a narrow query and result limit before broader reads.";
		default:
			return "";
	}
}

/** Converts the outer Copilot tool catalog into app-server dynamic tool specs. */
export function buildCodexDynamicTools(
	advertisedTools: readonly vscode.LanguageModelChatTool[],
	options: { deferNonCoreTools?: boolean } = {}
): CodexDynamicToolSet {
	const eagerSpecs: CodexDynamicFunctionToolSpec[] = [];
	const nativeSpecs: CodexDynamicFunctionToolSpec[] = [];
	const deferredSpecs: CodexDynamicFunctionToolSpec[] = [];
	const callableNames = new Set<string>();
	const deferredNames = new Set<string>();
	const toolNamespaces = new Map<string, string>();
	const skippedNames: string[] = [];

	const stableAdvertisedTools = [...advertisedTools].sort((left, right) => {
		const nameOrder = left.name.localeCompare(right.name);
		if (nameOrder !== 0) {
			return nameOrder;
		}
		return stableJsonStringify(left.inputSchema ?? {}).localeCompare(
			stableJsonStringify(right.inputSchema ?? {})
		);
	});

	for (const tool of stableAdvertisedTools) {
		if (
			callableNames.has(tool.name)
			|| EXCLUDED_VSCODE_TOOLS.has(tool.name)
			|| !isValidDynamicToolName(tool.name)
		) {
			skippedNames.push(tool.name);
			continue;
		}
		const useNativeNamespace = CODEX_BUILTIN_TOOL_COLLISIONS.has(tool.name);
		const deferLoading = !useNativeNamespace && options.deferNonCoreTools === true && !isCoreAgentTool(tool.name);
		const routedTool = withRequiredSubagentModel(tool);
		const spec: CodexDynamicFunctionToolSpec = {
			type: "function",
			name: routedTool.name,
			description: enhanceSubagentToolDescription(
				routedTool.name,
				(routedTool.description || `Invoke the VS Code tool ${routedTool.name}.`)
				+ boundedOutputHint(routedTool.name)
			).slice(0, MAX_TOOL_DESCRIPTION_CHARS),
			inputSchema: normalizeJsonSchema(routedTool.inputSchema),
			...(deferLoading ? { deferLoading: true } : {}),
		};
		if (useNativeNamespace) {
			nativeSpecs.push(spec);
			toolNamespaces.set(tool.name, CODEX_NATIVE_TOOL_NAMESPACE);
		} else if (deferLoading) {
			deferredSpecs.push(spec);
			deferredNames.add(tool.name);
			toolNamespaces.set(tool.name, CODEX_DEFERRED_TOOL_NAMESPACE);
		} else {
			eagerSpecs.push(spec);
		}
		callableNames.add(tool.name);
	}

	const specs: CodexDynamicToolSpec[] = [...eagerSpecs];
	if (nativeSpecs.length > 0) {
		specs.push({
			type: "namespace",
			name: CODEX_NATIVE_TOOL_NAMESPACE,
			description: "Native VS Code tools whose names overlap with built-in Codex tools.",
			tools: nativeSpecs,
		});
	}
	if (deferredSpecs.length > 0) {
		specs.push({
			type: "namespace",
			name: CODEX_DEFERRED_TOOL_NAMESPACE,
			description: "Less common VS Code and Copilot tools available through tool search.",
			tools: deferredSpecs,
		});
	}
	const runtimeSignatures: CodexDynamicToolRuntimeSignature[] = [
		...eagerSpecs.map(tool => ({
			namespace: null,
			name: tool.name,
			inputSchema: tool.inputSchema,
			deferLoading: false,
		})),
		...nativeSpecs.map(tool => ({
			namespace: CODEX_NATIVE_TOOL_NAMESPACE,
			name: tool.name,
			inputSchema: tool.inputSchema,
			deferLoading: false,
		})),
		...deferredSpecs.map(tool => ({
			namespace: CODEX_DEFERRED_TOOL_NAMESPACE,
			name: tool.name,
			inputSchema: tool.inputSchema,
			deferLoading: true,
		})),
	].sort((left, right) => `${left.namespace ?? ""}\0${left.name}`.localeCompare(`${right.namespace ?? ""}\0${right.name}`));

	return { specs, callableNames, deferredNames, toolNamespaces, runtimeSignatures, skippedNames };
}
