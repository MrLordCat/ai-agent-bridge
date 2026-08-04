import * as vscode from "vscode";

import { CONFIG_SECTION, DEFAULT_LOCAL_REASONING_BUDGET } from "../constants";
import { formatCompactTokenCount } from "../provider-metrics";
import type { ThinkingMode } from "../reasoning";

type ToolResultMode = "auto" | "tool" | "user";
type ToolCallingMode = "classic" | "apiDirect";
type KnowledgeMode = "off" | "adaptive" | "strict";

const CONTEXT_LIMIT_PRESETS = [65_536, 131_072, 258_400, 524_288, 1_048_576];

async function pickContextLimit(title: string, current: number, minimum: number, maximum: number): Promise<number | undefined> {
	const presetValues = CONTEXT_LIMIT_PRESETS.filter(value => value >= minimum && value <= maximum);
	if (!presetValues.includes(current)) {
		presetValues.push(current);
		presetValues.sort((left, right) => left - right);
	}
	const picked = await vscode.window.showQuickPick(
		[
			...presetValues.map(value => ({
				label: formatCompactTokenCount(value),
				description: value === 258_400 ? "Matches the current Codex context window" : undefined,
				detail: value === current ? "Current" : undefined,
				value,
			})),
			{ label: "Custom...", description: "Enter an exact token limit", custom: true as const },
		],
		{ title, placeHolder: "Select the maximum advertised context", ignoreFocusOut: true }
	);
	if (!picked) {
		return undefined;
	}
	if ("value" in picked && typeof picked.value === "number") {
		return picked.value;
	}
	const entered = await vscode.window.showInputBox({
		title: `${title}: Custom Limit`,
		prompt: `Enter a whole number from ${minimum} to ${maximum}`,
		value: String(current),
		ignoreFocusOut: true,
		validateInput: input => {
			if (!/^\d+$/.test(input.trim())) {
				return "Enter a whole number";
			}
			const parsed = Number(input);
			return parsed < minimum || parsed > maximum
				? `Value must be between ${minimum} and ${maximum}`
				: undefined;
		},
	});
	return entered === undefined ? undefined : Math.floor(Number(entered));
}

function contextLimitCommand(
	commandId: string,
	setting: string,
	title: string,
	fallback: number,
	minimum: number,
	maximum: number,
	refresh: () => void
): vscode.Disposable {
	return vscode.commands.registerCommand(commandId, async () => {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const configured = Number(config.get(setting, fallback));
		const current = Number.isFinite(configured) ? configured : fallback;
		const next = await pickContextLimit(title, current, minimum, maximum);
		if (next === undefined) {
			return;
		}
		await config.update(setting, next, vscode.ConfigurationTarget.Global);
		refresh();
		vscode.window.showInformationMessage(`${title}: ${formatCompactTokenCount(next)} tokens`);
	});
}

async function pickThinkingMode(current: ThinkingMode): Promise<ThinkingMode | undefined> {
	const options: Array<{ label: string; description: string; value: ThinkingMode }> = [
		{ label: "Auto", description: "Use the configured local reasoning cap", value: "auto" },
		{ label: "Off", description: "Disable model reasoning", value: "off" },
		{ label: "Light", description: "Use up to 512 hidden reasoning tokens", value: "light" },
		{ label: "Balanced", description: "Use up to 2048 hidden reasoning tokens", value: "balanced" },
		{ label: "Deep", description: "Use the configured local cap or DeepSeek Max effort", value: "deep" },
	];
	const picked = await vscode.window.showQuickPick(
		options.map(option => ({
			...option,
			detail: option.value === current ? "Current" : undefined,
		})),
		{ title: "Local LLM Thinking Mode", ignoreFocusOut: true }
	);
	return picked?.value;
}

async function pickToolResultMode(current: ToolResultMode): Promise<ToolResultMode | undefined> {
	const options: Array<{ label: string; description: string; value: ToolResultMode }> = [
		{ label: "Auto", description: "Use tool role and retry with user-style results only when required", value: "auto" },
		{ label: "Tool", description: "Always send role=tool with tool_call_id", value: "tool" },
		{ label: "User", description: "Flatten tool results into user text for maximum compatibility", value: "user" },
	];
	const picked = await vscode.window.showQuickPick(
		options.map(option => ({ ...option, detail: option.value === current ? "Current" : undefined })),
		{ title: "Local LLM Tool Result Mode", ignoreFocusOut: true }
	);
	return picked?.value;
}

async function pickToolCallingMode(current: ToolCallingMode): Promise<ToolCallingMode | undefined> {
	const options: Array<{ label: string; description: string; value: ToolCallingMode }> = [
		{ label: "API Direct", description: "Send a compact prioritized tool catalog within its token budget", value: "apiDirect" },
		{ label: "Classic", description: "Send the unmodified tool catalog", value: "classic" },
	];
	const picked = await vscode.window.showQuickPick(
		options.map(option => ({ ...option, detail: option.value === current ? "Current" : undefined })),
		{ title: "Local LLM Tool Calling Mode", ignoreFocusOut: true }
	);
	return picked?.value;
}

async function pickKnowledgeMode(current: KnowledgeMode): Promise<KnowledgeMode | undefined> {
	const options: Array<{ label: string; description: string; value: KnowledgeMode }> = [
		{ label: "Adaptive", description: "Verify material changing or uncertain claims with primary sources", value: "adaptive" },
		{ label: "Strict", description: "Require source-backed verification for external technical claims and audits", value: "strict" },
		{ label: "Off", description: "Disable the built-in knowledge verification policy", value: "off" },
	];
	const picked = await vscode.window.showQuickPick(
		options.map(option => ({ ...option, detail: option.value === current ? "Current" : undefined })),
		{ title: "Local LLM Knowledge Verification", ignoreFocusOut: true }
	);
	return picked?.value;
}

export function registerModelBehaviorCommands(refresh: () => void): vscode.Disposable[] {
	return [
		contextLimitCommand(
			"llamacpp.setDeepSeekContextLength",
			"deepSeekContextLength",
			"DeepSeek Maximum Context",
			258_400,
			32_768,
			1_048_576,
			refresh
		),
		contextLimitCommand(
			"llamacpp.setClaudeContextLength",
			"claudeContextLength",
			"Claude Working Context",
			258_400,
			258_400,
			967_000,
			refresh
		),
		vscode.commands.registerCommand("llamacpp.setThinkingMode", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = String(config.get("thinkingMode", "auto")) as ThinkingMode;
			const next = await pickThinkingMode(current);
			if (!next) {
				return;
			}
			await config.update("thinkingMode", next, vscode.ConfigurationTarget.Global);
			refresh();
			vscode.window.showInformationMessage(`Local LLM thinking mode: ${next}`);
		}),
		vscode.commands.registerCommand("llamacpp.setReasoningBudget", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = Number(config.get("reasoningBudget", DEFAULT_LOCAL_REASONING_BUDGET));
			const value = await vscode.window.showInputBox({
				title: "Local LLM Reasoning Cap",
				prompt: "Maximum hidden reasoning tokens for local models; DeepSeek uses High or Max effort",
				value: Number.isFinite(current) ? String(current) : String(DEFAULT_LOCAL_REASONING_BUDGET),
				ignoreFocusOut: true,
				validateInput: input => {
					if (!/^\d+$/.test(input.trim())) {
						return "Enter a whole number from 256 to 65536";
					}
					const parsed = Number(input);
					return parsed < 256 || parsed > 65536 ? "Value must be between 256 and 65536" : undefined;
				},
			});
			if (value === undefined) {
				return;
			}
			const parsed = Math.max(256, Math.min(65536, Number(value)));
			await config.update("reasoningBudget", parsed, vscode.ConfigurationTarget.Global);
			refresh();
			vscode.window.showInformationMessage(`Local LLM reasoning cap: ${parsed} tokens`);
		}),
		vscode.commands.registerCommand("llamacpp.setToolResultMode", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = String(config.get("toolResultMode", "auto")) as ToolResultMode;
			const next = await pickToolResultMode(current);
			if (!next) {
				return;
			}
			await config.update("toolResultMode", next, vscode.ConfigurationTarget.Global);
			refresh();
			vscode.window.showInformationMessage(`Local LLM tool result mode: ${next}`);
		}),
		vscode.commands.registerCommand("llamacpp.setToolCallingMode", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = String(config.get("toolCallingMode", "apiDirect")) as ToolCallingMode;
			const next = await pickToolCallingMode(current);
			if (!next) {
				return;
			}
			await config.update("toolCallingMode", next, vscode.ConfigurationTarget.Global);
			refresh();
			vscode.window.showInformationMessage(`Local LLM tool calling mode: ${next}`);
		}),
		vscode.commands.registerCommand("llamacpp.setKnowledgeMode", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = String(config.get("knowledgeMode", "adaptive")) as KnowledgeMode;
			const next = await pickKnowledgeMode(current);
			if (!next) {
				return;
			}
			await config.update("knowledgeMode", next, vscode.ConfigurationTarget.Global);
			refresh();
			vscode.window.showInformationMessage(`Local LLM knowledge verification: ${next}`);
		}),
	];
}
