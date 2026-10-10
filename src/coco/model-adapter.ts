import type * as vscode from "vscode";

export const COCO_MODEL_ID_PREFIX = "coco::";

export function decodeCocoModelId(id: string): string | undefined {
	return id.startsWith(COCO_MODEL_ID_PREFIX) ? id.slice(COCO_MODEL_ID_PREFIX.length) : undefined;
}

export interface CocoModel {
	id: string;
	name: string;
	description?: string;
}

interface CocoOption {
	value?: unknown;
	name?: unknown;
	description?: unknown;
}

export interface CocoThinkingConfiguration {
	configId: string;
	currentValue: string;
	options: Array<{ value: string; label: string; description: string }>;
}

/** Use only the choices advertised by the active ACP runtime. */
export function parseCocoThinkingConfiguration(result: unknown): CocoThinkingConfiguration | undefined {
	if (!result || typeof result !== "object") {
		return undefined;
	}
	const configOptions = (result as Record<string, unknown>).configOptions;
	if (!Array.isArray(configOptions)) {
		return undefined;
	}
	const config = configOptions.find(option => option && typeof option === "object"
		&& option.category === "thought_level" && option.type === "select");
	if (!config || typeof config.id !== "string" || !Array.isArray(config.options)) {
		return undefined;
	}
	const choices = new Map<string, CocoThinkingConfiguration["options"][number]>();
	for (const option of config.options) {
		if (!option || typeof option.value !== "string" || !option.value.trim()) {
			continue;
		}
		choices.set(option.value, {
			value: option.value,
			label: typeof option.name === "string" && option.name.trim() ? option.name : option.value,
			description: typeof option.description === "string" ? option.description : "",
		});
	}
	const options = [...choices.values()];
	if (options.length === 0) {
		return undefined;
	}
	return {
		configId: config.id,
		currentValue: choices.has(config.currentValue) ? config.currentValue : options[0].value,
		options,
	};
}

export function resolveCocoReasoningEffort(
	requested: unknown,
	config: CocoThinkingConfiguration | undefined
): string | undefined {
	if (requested === undefined || requested === null) {
		return undefined;
	}
	if (typeof requested !== "string" || !config?.options.some(option => option.value === requested)) {
		throw new Error("The selected thinking effort is not supported by this Coco session. Refresh the model catalog.");
	}
	return requested;
}

/** CoCo currently returns model choices as an ACP config option, not a static catalog. */
export function parseCocoModels(result: unknown): CocoModel[] {
	if (!result || typeof result !== "object") {
		return [];
	}
	const data = result as Record<string, unknown>;
	const options = Array.isArray(data.configOptions)
		? (data.configOptions as Array<Record<string, unknown>>).find(option => option.category === "model" && option.type === "select")?.options
		: undefined;
	const legacyModels = data.models && typeof data.models === "object"
		? (data.models as Record<string, unknown>).availableModels
		: undefined;
	const choices = Array.isArray(options) ? options : legacyModels;
	if (!Array.isArray(choices)) {
		return [];
	}
	const models = new Map<string, CocoModel>();
	for (const raw of choices as Array<CocoOption & { modelId?: unknown; id?: unknown }>) {
		const id = typeof raw.value === "string" ? raw.value
			: typeof raw.modelId === "string" ? raw.modelId : raw.id;
		if (typeof id !== "string" || !id.trim()) {
			continue;
		}
		models.set(id, {
			id,
			name: typeof raw.name === "string" && raw.name.trim() ? raw.name : id,
			...(typeof raw.description === "string" ? { description: raw.description } : {}),
		});
	}
	return [...models.values()];
}

export function mapCocoModel(
	model: CocoModel,
	contextLength = 128_000,
	thinking?: CocoThinkingConfiguration,
	imageInput = false
): vscode.LanguageModelChatInformation {
	const output = Math.min(16_384, Math.floor(contextLength / 4));
	const info: vscode.LanguageModelChatInformation & Record<string, unknown> = {
		id: `${COCO_MODEL_ID_PREFIX}${model.id}`,
		name: `${model.name} (Coco)`,
		family: "coco",
		version: model.id,
		maxInputTokens: contextLength - output,
		maxOutputTokens: output,
		capabilities: { toolCalling: true, imageInput },
		tooltip: model.description ?? "Snowflake Cortex Code via your Snowflake connection",
		detail: "Snowflake Cortex Code",
	};
	info.isUserSelectable = true;
	info.model_picker_enabled = true;
	if (thinking) {
		info.configurationSchema = {
			type: "object",
			properties: {
				reasoningEffort: {
					type: "string",
					title: "Thinking Effort",
					group: "navigation",
					default: thinking.currentValue,
					enum: thinking.options.map(option => option.value),
					enumItemLabels: thinking.options.map(option => option.label),
					enumDescriptions: thinking.options.map(option => option.description),
				},
			},
		};
	}
	return info;
}