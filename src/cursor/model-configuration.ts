import type { CursorModel, CursorParameter } from "./api-client";

const REASONING_PARAMETER_IDS = ["reasoningeffort", "thinkingeffort", "thinkinglevel", "reasoninglevel", "effort", "effortlevel", "thinking", "reasoning"];
const normalizedId = (id: string): string => id.replace(/[_\s-]/g, "").toLowerCase();
const isReasoningId = (id: string): boolean => REASONING_PARAMETER_IDS.includes(normalizedId(id));

/** Some catalogs describe supported reasoning values only in model variants. */
export function cursorModelParameters(model: CursorModel): CursorParameter[] {
	const parameters = [...(model.parameters ?? [])];
	const inferred = new Map<string, string[]>();
	for (const variant of model.variants ?? []) {
		for (const parameter of variant.params) {
			if (!isReasoningId(parameter.id) || parameters.some(item => item.id === parameter.id)) { continue; }
			const values = inferred.get(parameter.id) ?? [];
			if (!values.includes(parameter.value)) { values.push(parameter.value); }
			inferred.set(parameter.id, values);
		}
	}
	for (const [id, values] of inferred) { parameters.push({ id, values: values.map(value => ({ value })) }); }
	return parameters;
}

export function cursorReasoningParameter(parameters: readonly CursorParameter[]): CursorParameter | undefined {
	for (const id of REASONING_PARAMETER_IDS) {
		const parameter = parameters.find(item => normalizedId(item.id) === id && item.values.length > 0);
		if (parameter) { return parameter; }
	}
	return undefined;
}

export function cursorReasoningSchema(parameter: CursorParameter, model: CursorModel) {
	const defaultValue = model.variants?.find(variant => variant.isDefault)?.params.find(item => item.id === parameter.id)?.value;
	return {
		type: "string", title: "Thinking Effort", group: "navigation",
		enum: parameter.values.map(item => item.value),
		enumItemLabels: parameter.values.map(item => item.displayName ?? (item.value === "xhigh" ? "Extra High" : item.value.replace(/[_-]/g, " ").replace(/\b\w/g, character => character.toUpperCase()))),
		default: parameter.values.some(item => item.value === defaultValue) ? defaultValue : parameter.values[0].value,
	};
}

/** VS Code uses reasoningEffort; Cursor receives the original catalog parameter ID. */
export function cursorReasoningOption(options: Readonly<Record<string, unknown>> | undefined, parameterId: string): unknown {
	return options?.reasoningEffort ?? options?.reasoning_effort ?? options?.thinkingLevel ?? options?.thinking_level ?? options?.[parameterId];
}