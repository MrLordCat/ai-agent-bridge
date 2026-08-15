import * as vscode from "vscode";
import type { SharedMemoryEntry } from "./types";

/**
 * Entries that participate in the prompt context of the given workspace:
 * global entries always, workspace entries only when their scopeId matches.
 */
export function filterEntriesVisibleInWorkspace(
	entries: readonly SharedMemoryEntry[],
	workspaceId: string | undefined
): SharedMemoryEntry[] {
	return entries.filter(entry =>
		entry.scope === "global"
		|| (entry.scope === "workspace" && workspaceId !== undefined && entry.scopeId === workspaceId)
	);
}

export function getCurrentWorkspaceScopeId(): string | undefined {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		return undefined;
	}
	return folders
		.map(folder => folder.uri.toString())
		.sort((a, b) => a.localeCompare(b))
		.join("|");
}

export function getCurrentWorkspaceScopeLabel(): string {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		return "current project";
	}
	return folders
		.map(folder => folder.name)
		.sort((a, b) => a.localeCompare(b))
		.join(", ");
}
