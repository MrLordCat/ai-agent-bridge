import { createHash } from "node:crypto";

export const COCO_SDK_SERVER_NAME = "vscode_chat";
export const COCO_SDK_TOOL_PREFIX = `mcp__${COCO_SDK_SERVER_NAME}__`;
export const COCO_WIRE_TOOL_NAME_MAX = 64;

/** Snowflake validates the fully qualified name, including the SDK namespace. */
export function cocoClientToolName(name: string): string {
	const prefix = "vscode_chat_", suffix = "_" + createHash("sha256").update(name).digest("hex").slice(0,10);
	return boundCocoClientToolName(prefix + name.replace(/[^a-zA-Z0-9_]/g,"_") + suffix);
}

/** Preserve the hash suffix when upgrading an existing recorded alias. */
export function boundCocoClientToolName(alias: string): string {
	const maximum = COCO_WIRE_TOOL_NAME_MAX - COCO_SDK_TOOL_PREFIX.length;
	return alias.length <= maximum ? alias : alias.slice(0,maximum-11) + alias.slice(-11);
}

export function validateCocoSdkTools(tools: readonly Record<string,unknown>[]): void {
	const seen = new Set<string>();
	for (const tool of tools) {
		if (typeof tool.name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(tool.name)
			|| (COCO_SDK_TOOL_PREFIX + tool.name).length > COCO_WIRE_TOOL_NAME_MAX || seen.has(tool.name)) {
			throw new Error("Invalid Coco SDK tool catalog: fully qualified tool names must be unique, use letters/digits/underscore/hyphen, and fit 64 characters including the MCP namespace. No inference was started.");
		}
		seen.add(tool.name);
	}
}