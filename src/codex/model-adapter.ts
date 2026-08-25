import * as vscode from "vscode";

import type { CodexModel, CodexRateLimitSnapshot } from "./protocol";

export const CODEX_MODEL_ID_PREFIX = "codex::";

export function encodeCodexModelId(modelId: string): string {
	return `${CODEX_MODEL_ID_PREFIX}${modelId}`;
}

export function decodeCodexModelId(modelId: string): string | undefined {
	return modelId.startsWith(CODEX_MODEL_ID_PREFIX)
		? modelId.slice(CODEX_MODEL_ID_PREFIX.length)
		: undefined;
}

interface CodexReasoningConfigurationProperty {
	type: "string";
	title: string;
	enum: string[];
	enumItemLabels: string[];
	enumDescriptions: string[];
	default: string;
	group: "navigation";
}

export interface CodexReasoningConfigurationSchema {
	properties: {
		reasoningEffort: CodexReasoningConfigurationProperty;
	};
}

export function createCodexReasoningConfigurationSchema(model: CodexModel): CodexReasoningConfigurationSchema {
	const efforts = model.supportedReasoningEfforts.length > 0
		? model.supportedReasoningEfforts
		: [{ reasoningEffort: model.defaultReasoningEffort || "medium", description: "Model default reasoning" }];
	const defaultEffort = efforts.some(option => option.reasoningEffort === "high")
		? "high"
		: model.defaultReasoningEffort || efforts[0].reasoningEffort;
	return {
		properties: {
			reasoningEffort: {
				type: "string",
				title: "Thinking Effort",
				enum: efforts.map(option => option.reasoningEffort),
				enumItemLabels: efforts.map(option => {
					const value = option.reasoningEffort;
					return value.charAt(0).toUpperCase() + value.slice(1);
				}),
				enumDescriptions: efforts.map(option => option.description),
				default: defaultEffort,
				group: "navigation",
			},
		},
	};
}

export function mapCodexModelInformation(
	model: CodexModel,
	contextLength: number,
	maxOutputTokens: number
): vscode.LanguageModelChatInformation {
	const outputTokens = Math.max(1024, Math.min(contextLength - 1, Math.floor(maxOutputTokens)));
	const info: vscode.LanguageModelChatInformation & Record<string, unknown> = {
		id: encodeCodexModelId(model.id),
		name: `${model.displayName} (Codex)` ,
		family: "codex",
		version: model.model || model.id,
		maxInputTokens: Math.max(1, Math.floor(contextLength) - outputTokens),
		maxOutputTokens: outputTokens,
		capabilities: {
			toolCalling: true,
			imageInput: model.inputModalities.includes("image"),
		},
		tooltip: `${model.description}\nOpenAI Codex through your ChatGPT subscription`,
		detail: `${model.isDefault ? "Default / " : ""}ChatGPT subscription`,
	};
	info.isUserSelectable = true;
	info.multiplierNumeric = 0;
	info.model_picker_enabled = true;
	info.configurationSchema = createCodexReasoningConfigurationSchema(model);
	return info;
}

export function resolveCodexReasoningEffort(
	configured: unknown,
	modelOption: unknown,
	model: CodexModel
): string {
	const supported = new Set(model.supportedReasoningEfforts.map(option => option.reasoningEffort));
	const highDefault = supported.has("high") ? "high" : model.defaultReasoningEffort;
	const requested = typeof modelOption === "string" && modelOption.trim()
		? modelOption.trim().toLowerCase()
		: typeof configured === "string" && configured.trim().toLowerCase() !== "auto"
			? configured.trim().toLowerCase()
			: highDefault;
	if (supported.size === 0 || supported.has(requested)) {
		return requested;
	}
	return highDefault || model.supportedReasoningEfforts[0]?.reasoningEffort || "medium";
}

/** "5h" for 300 minutes, "7d" for 10080 minutes, "45m" otherwise. */
export function formatCodexWindowDuration(mins: number | null | undefined): string | undefined {
	if (typeof mins !== "number" || mins <= 0) {
		return undefined;
	}
	if (mins % 1440 === 0) {
		return `${mins / 1440}d`;
	}
	if (mins % 60 === 0) {
		return `${mins / 60}h`;
	}
	return `${mins}m`;
}

export function formatCodexRateLimit(snapshot: CodexRateLimitSnapshot | undefined): string {
	const window = snapshot?.primary;
	if (!window) {
		return "Usage unavailable";
	}
	const reset = window.resetsAt
		? new Date(window.resetsAt * 1000).toLocaleString()
		: "unknown reset";
	const windowLabel = formatCodexWindowDuration(window.windowDurationMins);
	const usage = `${Math.max(0, Math.min(100, Math.round(window.usedPercent)))}% used · resets ${reset}`;
	return windowLabel ? `${windowLabel} · ${usage}` : usage;
}
