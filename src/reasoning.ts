import { DEFAULT_LOCAL_REASONING_BUDGET } from "./constants";

export type ThinkingMode = "off" | "light" | "balanced" | "deep" | "auto";

const THINKING_MODE_ALIASES: Readonly<Record<string, ThinkingMode>> = {
	auto: "auto",
	default: "auto",
	off: "off",
	none: "off",
	minimal: "light",
	light: "light",
	low: "light",
	balanced: "balanced",
	medium: "balanced",
	deep: "deep",
	high: "deep",
	xhigh: "deep",
	max: "deep",
};

export function normalizeThinkingMode(value: unknown): ThinkingMode {
	if (typeof value !== "string") {
		return "auto";
	}
	return THINKING_MODE_ALIASES[value.trim().toLowerCase()] ?? "auto";
}

export function resolveRequestThinkingMode(
	configuredMode: unknown,
	modelOptions: Readonly<Record<string, unknown>> | undefined
): ThinkingMode {
	const requestedMode =
		modelOptions?.reasoningEffort ??
		modelOptions?.reasoning_effort ??
		modelOptions?.thinkingLevel ??
		modelOptions?.thinking_level ??
		modelOptions?.thinkingMode ??
		modelOptions?.thinking_mode;

	return requestedMode === undefined
		? normalizeThinkingMode(configuredMode)
		: normalizeThinkingMode(requestedMode);
}

export function resolveReasoningBudget(mode: ThinkingMode, configuredBudget: number): number {
	const normalizedBudget = Number.isFinite(configuredBudget)
		? configuredBudget
		: DEFAULT_LOCAL_REASONING_BUDGET;
	const cap = Math.max(256, Math.min(65536, Math.floor(normalizedBudget)));
	switch (mode) {
		case "off":
			return 0;
		case "light":
			return Math.min(512, cap);
		case "balanced":
			return Math.min(2048, cap);
		case "deep":
		case "auto":
		default:
			return cap;
	}
}

// DeepSeek API (api-docs.deepseek.com/guides/thinking_mode, verified 2026-08-15):
// `reasoning_effort` accepts low|high|max; the API also maps user-set
// "medium" and "xhigh" to the model's "high" level. "none" disables thinking.
export function toDeepSeekReasoningEffort(mode: ThinkingMode): "low" | "high" | "max" | undefined {
	switch (mode) {
		case "off":
			return undefined;
		case "deep":
			return "max";
		case "light":
			return "low";
		case "balanced":
		case "auto":
		default:
			return "high";
	}
}

interface ReasoningConfigurationProperty {
	type: "string";
	title: string;
	enum: string[];
	enumItemLabels: string[];
	enumDescriptions: string[];
	default: string;
	group: "navigation";
}

export interface ReasoningConfigurationSchema {
	properties: {
		reasoningEffort: ReasoningConfigurationProperty;
	};
}

export function createReasoningConfigurationSchema(family: string): ReasoningConfigurationSchema {
	const isDeepSeek = family.toLowerCase().includes("deepseek");
	const efforts = isDeepSeek
		? ["high", "max"]
		: ["none", "low", "medium", "high"];
	const descriptions: Readonly<Record<string, string>> = {
		none: "Disable model reasoning for the current chat session.",
		low: "Use a small reasoning budget for faster responses.",
		medium: "Balance reasoning quality and response latency.",
		high: "Use a larger reasoning budget for complex tasks.",
		max: "Use the maximum DeepSeek reasoning effort.",
	};

	return {
		properties: {
			reasoningEffort: {
				type: "string",
				title: "Thinking Effort",
				enum: efforts,
				enumItemLabels: efforts.map(effort => effort.charAt(0).toUpperCase() + effort.slice(1)),
				enumDescriptions: efforts.map(effort => descriptions[effort]),
				default: isDeepSeek ? "high" : "medium",
				group: "navigation",
			},
		},
	};
}
