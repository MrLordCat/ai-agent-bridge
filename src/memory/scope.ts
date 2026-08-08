import * as vscode from "vscode";

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
