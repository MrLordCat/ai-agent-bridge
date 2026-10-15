import * as vscode from "vscode";
import { PROVIDER_VENDOR } from "../constants";
import { BUILTIN_PROVIDER_SOURCES, providerSourceId, type ProviderSourceDefinition } from "../providers/provider-registry";

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
export function groupProviderModels(models: readonly vscode.LanguageModelChatInformation[], profiles: readonly ModelPickerProfile[], sources: readonly ProviderSourceDefinition[] = BUILTIN_PROVIDER_SOURCES): ProviderModelGroup[] {
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
		const sourceKey = providerSourceId(model.id);
		const profile = apiProfiles.get(sourceKey);
		if (sourceKey.startsWith("api-") && !profile?.enabled) { continue; }
		const source = sources.find(item => item.id === sourceKey);
		const group = ensure(sourceKey, profile?.name ?? source?.label ?? sourceKey, profile?.baseUrl ?? source?.description ?? "Registered model source");
		if (!group.models.some(existing => existing.id === model.id)) { group.models.push(model); }
	}
	for (const group of groups.values()) { group.models.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)); }
	return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

/** Use the current chat's modelSelector; no prompt is sent and no new chat is requested. */
export async function showProviderModelPicker(models: readonly vscode.LanguageModelChatInformation[], profiles: readonly ModelPickerProfile[], ui = defaultUI, sources: readonly ProviderSourceDefinition[] = BUILTIN_PROVIDER_SOURCES): Promise<void> {
	const groups = groupProviderModels(models, profiles, sources);
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