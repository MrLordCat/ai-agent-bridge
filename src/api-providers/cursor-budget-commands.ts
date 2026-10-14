import * as vscode from "vscode";
import { isCursorCloudAgentBase } from "../transport/openai-http";
import type { ApiProviderService } from "./api-provider-service";

export function registerCursorBudgetCommand(service: ApiProviderService): vscode.Disposable {
	return vscode.commands.registerCommand("llamacpp.cursorBudget", async (id: unknown) => {
		try {
			let profile = typeof id === "string" ? service.get(id) : undefined;
			if (id === undefined) {
				const selected = await vscode.window.showQuickPick(service.list().filter(candidate => isCursorCloudAgentBase(candidate.baseUrl)).map(candidate => ({ label: candidate.name, description: candidate.baseUrl, id: candidate.id })), { title: "Cursor Budget", placeHolder: "Choose the Cursor profile" });
				if (!selected) { return; }
				profile = service.get(selected.id);
			}
			if (!profile || !isCursorCloudAgentBase(profile.baseUrl)) { throw new Error("Select a Cursor profile in Providers Manager."); }
			const action = await vscode.window.showQuickPick([
				{ label: "Refresh budget", value: "refresh", description: "Read the current billing cycle from Cursor" },
				{ label: "Configure Admin API key", value: "key", description: "Budget access only; the existing chat key stays separate" },
				{ label: "Select budget user", value: "user", description: "Team member email; empty uses the chat key's account" },
				{ label: "Open Cursor usage dashboard", value: "dashboard", description: "View account usage and billing in Cursor" },
				{ label: "Remove budget Admin key", value: "remove", description: "Return to using the saved profile key for budget requests" },
			], { title: `${profile.name} · Budget`, placeHolder: "Manage Cursor team spending budget" });
			if (!action) { return; }
			if (action.value === "dashboard") { await vscode.env.openExternal(vscode.Uri.parse("https://cursor.com/dashboard/usage")); return; }
			if (action.value === "key") {
				const key = await vscode.window.showInputBox({ title: `${profile.name} · Admin API access`, prompt: "Cursor team Admin API key for reading spend and limits. Stored only in VS Code SecretStorage.", password: true, ignoreFocusOut: true, validateInput: value => value.trim() ? undefined : "Enter an Admin API key, or cancel." });
				if (key === undefined) { return; }
				await service.setCursorBudgetAccess(profile.id, { adminApiKey: key });
			} else if (action.value === "user") {
				const userEmail = await vscode.window.showInputBox({ title: `${profile.name} · Budget user`, prompt: "Team member email. Leave empty to detect the owner of the saved chat key.", value: service.getCursorBudgetUserEmail(profile.id) ?? "", ignoreFocusOut: true, validateInput: value => !value.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? undefined : "Enter a valid team member email." });
				if (userEmail === undefined) { return; }
				await service.setCursorBudgetAccess(profile.id, { userEmail });
			} else if (action.value === "remove") { await service.setCursorBudgetAccess(profile.id, { clearAdminApiKey: true }); }
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Refreshing ${profile.name} budget` }, () => service.refreshBalance(profile.id));
		} catch (error) { vscode.window.showErrorMessage(error instanceof Error ? error.message : "Unable to update Cursor budget access."); }
	});
}