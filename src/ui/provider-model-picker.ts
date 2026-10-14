import * as vscode from "vscode";
import { PROVIDER_VENDOR } from "../constants";
import { decodeCodexModelId } from "../codex/model-adapter";
import { decodeCocoModelId } from "../coco/model-adapter";
import { decodeClaudeModelId } from "../claude/message-adapter";
import { parseProviderModelId } from "../model-sources/source-routing";

export interface ModelPickerProfile { id: string; name: string; baseUrl: string; enabled: boolean }
export interface ProviderModelGroup { key: string; label: string; description: string; models: vscode.LanguageModelChatInformation[] }
export interface ProviderModelItem extends vscode.QuickPickItem {
	group?: ProviderModelGroup;
	model?: vscode.LanguageModelChatInformation;
	action?: "back" | "manage";
}
export interface ProviderModelPickerUI {
	pick(items: readonly ProviderModelItem[], options: vscode.QuickPickOptions): Thenable<ProviderModelItem | undefined>;
	execute(command: string, options?: unknown): Thenable<unknown>;
}
const defaultUI: ProviderModelPickerUI = {
	pick: (items, options) => vscode.window.showQuickPick(items, options),
	execute: (command, options) => vscode.commands.executeCommand(command, options),
};

/** Group by source identity, so identical names and models never merge API profiles. */
export function groupProviderModels(models: readonly vscode.LanguageModelChatInformation[], profiles: readonly ModelPickerProfile[]): ProviderModelGroup[] {
	const groups = new Map<string, ProviderModelGroup>();
	const apiProfiles = new Map(profiles.map(profile => [`api-${profile.id}`, profile]));
	const ensure = (key: string, label: string, description: string): ProviderModelGroup => {
		let group = groups.get(key);
		if (!group) { group = { key, label, description, models: [] }; groups.set(key, group); }
		return group;
	};
	// Keep an enabled profile visible even if its catalog is empty or unavailable.
	for (const [key, profile] of apiProfiles) { if (profile.enabled) { ensure(key, profile.name, profile.baseUrl); } }
	for (const model of models) {
		let group: ProviderModelGroup;
		if (decodeCodexModelId(model.id) !== undefined) { group = ensure("codex", "Codex", "ChatGPT subscription"); }
		else if (decodeCocoModelId(model.id) !== undefined) { group = ensure("coco", "Coco", "Snowflake Cortex Code"); }
		else if (decodeClaudeModelId(model.id) !== undefined) { group = ensure("claude", "Claude", "Claude subscription"); }
		else {
			const { sourceKey } = parseProviderModelId(model.id);
			if (sourceKey?.startsWith("api-")) {
				const profile = apiProfiles.get(sourceKey);
				if (!profile?.enabled) { continue; }
				group = ensure(sourceKey, profile.name, profile.baseUrl);
			} else if (sourceKey === "deepseek") { group = ensure("deepseek", "DeepSeek", "DeepSeek API"); }
			else { group = ensure(sourceKey ?? "primary", "Local LLM", "Local model server"); }
		}
		if (!group.models.some(existing => existing.id === model.id)) { group.models.push(model); }
	}
	for (const group of groups.values()) { group.models.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)); }
	return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

/** Use the current chat's modelSelector; no prompt is sent and no new chat is requested. */
export async function showProviderModelPicker(models: readonly vscode.LanguageModelChatInformation[], profiles: readonly ModelPickerProfile[], ui = defaultUI): Promise<void> {
	const groups = groupProviderModels(models, profiles);
	const manage: ProviderModelItem = { label: "$(settings-gear) Manage providers", action: "manage", alwaysShow: true };
	while (true) {
		const providerItems: ProviderModelItem[] = groups.map(group => ({
			label: group.label, description: `${group.models.length} ${group.models.length === 1 ? "model" : "models"}${group.models.length ? "" : " · unavailable"}`,
			detail: group.description, group,
		}));
		const selected = await ui.pick([...providerItems, manage], {
			title: "Models by provider", placeHolder: "Choose a provider", matchOnDetail: true,
		});
		if (!selected) { return; }
		if (selected.action === "manage") { await ui.execute("llamacpp.openApiProviders"); return; }
		const group = selected.group;
		if (!group) { return; }
		const items: ProviderModelItem[] = group.models.map(model => ({
			label: model.name, model,
			description: `${model.capabilities.toolCalling ? "" : "Chat only · "}${(model.maxInputTokens + model.maxOutputTokens).toLocaleString("en-US")} tokens`,
			detail: model.detail,
		}));
		const choice = await ui.pick([{ label: "$(arrow-left) Back to providers", action: "back", alwaysShow: true }, ...items, manage], {
			title: `Models · ${group.label}`, placeHolder: group.models.length ? "Choose a model" : "No models available. Check this profile in Providers Manager.",
			matchOnDescription: true,
		});
		if (!choice) { return; }
		if (choice.action === "back") { continue; }
		if (choice.action === "manage") { await ui.execute("llamacpp.openApiProviders"); return; }
		if (!choice.model) { return; }
		await ui.execute("workbench.action.chat.open", {
			modelSelector: { vendor: PROVIDER_VENDOR, id: choice.model.id },
			...(choice.model.capabilities.toolCalling ? {} : { mode: "ask" }),
		});
		return;
	}
}