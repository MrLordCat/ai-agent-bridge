import * as vscode from "vscode";

import {
	applyCopilotPatch,
	findCopilotBundle,
	formatCopilotPatchStatus,
	getCopilotPatchStatus,
	restoreCopilotPatch,
	type CopilotPatchResult,
} from "./copilot-patch";

const CONFIG_SECTION = "llamacpp";
const AUTO_PATCH_SETTING = "autoPatchCopilot";
const LAST_FAILURE_KEY = "copilotPatch.lastAutoFailure";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function offerReload(message: string, output: vscode.OutputChannel): Promise<void> {
	const choice = await vscode.window.showInformationMessage(message, "Reload Window", "Show Log");
	if (choice === "Reload Window") {
		await vscode.commands.executeCommand("workbench.action.reloadWindow");
	} else if (choice === "Show Log") {
		output.show(true);
	}
}

function appendResult(output: vscode.OutputChannel, result: CopilotPatchResult): void {
	output.appendLine(`[${new Date().toISOString()}] ${result.message}`);
	output.appendLine(formatCopilotPatchStatus(result.status));
	output.appendLine("");
}

async function applyPatch(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
	userInitiated: boolean
): Promise<void> {
	try {
		const target = findCopilotBundle(vscode.env.appRoot);
		const result = applyCopilotPatch(target);
		appendResult(output, result);
		await context.globalState.update(LAST_FAILURE_KEY, undefined);
		if (result.changed) {
			await offerReload(
				"AI Agent Bridge patched native model controls and bounded stored chat tool output. Reload the window to activate them.",
				output
			);
		} else if (userInitiated) {
			void vscode.window.showInformationMessage("Copilot Chat and chat-history bounds patches are already active.");
		}
	} catch (error) {
		const message = errorText(error);
		output.appendLine(`[${new Date().toISOString()}] Patch failed: ${message}`);
		output.appendLine("");
		if (userInitiated) {
			const choice = await vscode.window.showErrorMessage(`Copilot Chat patch failed: ${message}`, "Show Log");
			if (choice === "Show Log") {
				output.show(true);
			}
			return;
		}

		const failureSignature = `${vscode.version}:${message}`;
		if (context.globalState.get<string>(LAST_FAILURE_KEY) === failureSignature) {
			// Permission errors (EPERM, EACCES, EBUSY) are transient — the file
			// may be locked by a concurrent process or Windows Defender, and a
			// subsequent restart often resolves the lock.  Don't suppress the
			// next auto-patch attempt for these.
			const transient = /eperm|eacces|ebusy/i.test(message);
			if (!transient) {
				return;
			}
		}
		await context.globalState.update(LAST_FAILURE_KEY, failureSignature);
		const choice = await vscode.window.showWarningMessage(
			"AI Agent Bridge could not update the Copilot Chat patch for this VS Code build. The original bundle was not modified.",
			"Show Log",
			"Disable Auto-Patch"
		);
		if (choice === "Show Log") {
			output.show(true);
		} else if (choice === "Disable Auto-Patch") {
			await vscode.workspace.getConfiguration(CONFIG_SECTION).update(
				AUTO_PATCH_SETTING,
				false,
				vscode.ConfigurationTarget.Global
			);
		}
	}
}

async function showStatus(output: vscode.OutputChannel): Promise<void> {
	try {
		const status = getCopilotPatchStatus(findCopilotBundle(vscode.env.appRoot));
		output.appendLine(`[${new Date().toISOString()}] Patch status`);
		output.appendLine(formatCopilotPatchStatus(status));
		output.appendLine("");
		const choice = await vscode.window.showInformationMessage(
			`Copilot Chat ${status.copilotVersion}: controls ${status.applied ? "applied" : status.legacyPatch ? "legacy" : "not applied"}, `
			+ `history bounds ${status.workbenchApplied ? "applied" : "not applied"}.`,
			"Show Log"
		);
		if (choice === "Show Log") {
			output.show(true);
		}
	} catch (error) {
		const message = errorText(error);
		output.appendLine(`[${new Date().toISOString()}] Status failed: ${message}`);
		const choice = await vscode.window.showErrorMessage(`Could not inspect Copilot Chat patch: ${message}`, "Show Log");
		if (choice === "Show Log") {
			output.show(true);
		}
	}
}

async function restorePatch(output: vscode.OutputChannel): Promise<void> {
	const confirmation = await vscode.window.showWarningMessage(
		"Restore the original Copilot Chat and VS Code workbench bundles? Native controls and stored tool-output bounds will stop working after reload.",
		{ modal: true },
		"Restore"
	);
	if (confirmation !== "Restore") {
		return;
	}
	try {
		const result = restoreCopilotPatch(findCopilotBundle(vscode.env.appRoot));
		appendResult(output, result);
		await offerReload("Original Copilot Chat bundle restored. Reload the window to activate it.", output);
	} catch (error) {
		const message = errorText(error);
		output.appendLine(`[${new Date().toISOString()}] Restore failed: ${message}`);
		const choice = await vscode.window.showErrorMessage(`Could not restore Copilot Chat: ${message}`, "Show Log");
		if (choice === "Show Log") {
			output.show(true);
		}
	}
}

export function registerCopilotPatchIntegration(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel("AI Agent Bridge Copilot Patch");
	context.subscriptions.push(
		output,
		vscode.commands.registerCommand("llamacpp.applyCopilotPatch", () => applyPatch(context, output, true)),
		vscode.commands.registerCommand("llamacpp.copilotPatchStatus", () => showStatus(output)),
		vscode.commands.registerCommand("llamacpp.restoreCopilotPatch", () => restorePatch(output))
	);

	if (
		context.extensionMode === vscode.ExtensionMode.Production
		&& vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(AUTO_PATCH_SETTING, true)
	) {
		setTimeout(() => void applyPatch(context, output, false), 0);
	}
}
