import type * as vscode from "vscode";
import { parseProviderModelId } from "../model-sources/source-routing";

export type ContextOrigin = "reported" | "observed" | "fallback";
export interface ModelDescriptor {
	id: string; name: string; family: string; version: string;
	contextWindowTokens: number; workingContextTokens?: number; outputTokens: number;
	contextOrigin?: ContextOrigin;
	capabilities: vscode.LanguageModelChatInformation["capabilities"];
	tooltip?: string; detail?: string;
}

export function resolveModelLimits(window: number, output: number, working?: number): { contextWindowTokens: number; maxInputTokens: number; maxOutputTokens: number } {
	if (!Number.isFinite(window) || window < 2 || !Number.isFinite(output) || output < 1) { throw new Error("Invalid model token limits"); }
	const contextWindowTokens = Math.max(2, Math.floor(Math.min(window, working !== undefined && Number.isFinite(working) && working >= 2 ? working : window)));
	const maxOutputTokens = Math.max(1, Math.min(contextWindowTokens - 1, Math.floor(output)));
	return { contextWindowTokens, maxOutputTokens, maxInputTokens: contextWindowTokens - maxOutputTokens };
}

/** Protocol policies supply reserve and options; the VS Code projection is shared. */
export function modelInformation(descriptor: ModelDescriptor): vscode.LanguageModelChatInformation & Record<string, unknown> {
	const limits = resolveModelLimits(descriptor.contextWindowTokens, descriptor.outputTokens, descriptor.workingContextTokens);
	const { sourceKey, modelId } = parseProviderModelId(descriptor.id);
	return {
		id: descriptor.id, name: descriptor.name, family: descriptor.family, version: descriptor.version,
		maxInputTokens: limits.maxInputTokens, maxOutputTokens: limits.maxOutputTokens,
		capabilities: descriptor.capabilities, tooltip: descriptor.tooltip, detail: descriptor.detail,
		sourceId: sourceKey ?? "primary", nativeModelId: modelId, contextOrigin: descriptor.contextOrigin,
	};
}