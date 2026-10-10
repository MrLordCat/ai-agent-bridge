import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { prepareUserVsCode } from "./user-vscode";

export const PREPARE_USER_VSCODE_COMMAND = "llamacpp.prepareUserVsCode";

export function registerUserVsCodeCommand(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
	let preparing = false;
	context.subscriptions.push(vscode.commands.registerCommand(PREPARE_USER_VSCODE_COMMAND, async () => {
		if (process.platform !== "linux" || vscode.env.remoteName) {
			void vscode.window.showInformationMessage("Prepare User VS Code runs in a local Linux desktop window. For SSH, WSL or containers, prepare VS Code on the computer that displays the window.");
			return;
		}
		if (preparing) { void vscode.window.showInformationMessage("User VS Code is already being prepared."); return; }
		preparing = true;
		try {
			const installation = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
				title: "Preparing user-owned VS Code (no root)", cancellable: true }, async (progress, token) => {
				const abort = new AbortController(), subscription = token.onCancellationRequested(() => abort.abort());
				try {
					if (token.isCancellationRequested) { abort.abort(); }
					return await prepareUserVsCode(vscode.env.appRoot, os.homedir(), {
						signal: abort.signal, extensionsDir: path.dirname(context.extensionPath),
						configHome: process.env.XDG_CONFIG_HOME,
						onProgress: files => progress.report({ message: "Copied " + files + " application files" }),
					});
				} finally { subscription.dispose(); }
			});
			output.appendLine("User-owned VS Code: " + installation.installationRoot + "\nLauncher: " + installation.launcher
				+ "\nProfile: " + installation.profileDir + "\nShared extensions: " + installation.extensionsDir);
			const choice = await vscode.window.showInformationMessage(
				"User VS Code is ready. Open AI Agent Bridge Code to apply patches automatically. It shares your installed extensions and uses a separate profile; configure settings and accounts there. Reload that window after the patch notification.",
				"Open User VS Code", "Show Log");
			if (choice === "Open User VS Code") {
				const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
				const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
				const child = spawn(installation.launcher, folder?.scheme === "file" ? [folder.fsPath] : [], { detached: true, stdio: "ignore", env });
				child.on("error", error => { output.appendLine("Launch failed: " + error.message); output.show(true); });
				child.unref();
			} else if (choice === "Show Log") { output.show(true); }
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") { return; }
			output.appendLine("User VS Code preparation failed: " + String(error));
			void vscode.window.showErrorMessage("Could not prepare user-owned VS Code: " + String(error), "Show Log")
				.then(choice => { if (choice) { output.show(true); } });
		} finally { preparing = false; }
	}));
}
