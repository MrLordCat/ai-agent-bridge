import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
	applyCopilotPatch,
	findCopilotBundles,
	formatCopilotPatchStatus,
	getCopilotPatchStatus,
	restoreCopilotPatch,
	type CopilotPatchResult,
	type CopilotPatchTarget,
} from "./copilot-patch";
import { collectAppRoots, collectExtensionRoots, isWritable } from "./vscode-app-root";
import { PREPARE_USER_VSCODE_COMMAND, registerUserVsCodeCommand } from "./user-vscode-runtime";
import { workbenchBundlePathFromAppRoot } from "./byok/workbench-terminal-patch";
import { agentHostBundlePathFromAppRoot } from "./byok/agent-host-thinking-patch";
import { ADMIN_PATCH_ACTION, USER_CODE_ACTION, createElevatedPatchRunner, elevatedPatchCommand, findTerminalElevation, terminalPatchCommand, patchPermissionActions, type ElevatedPatchJob } from "./patch-elevation";
import { PatchTerminalSession } from "./patch-terminal";

const CONFIG_SECTION = "llamacpp";
const AUTO_PATCH_SETTING = "autoPatchCopilot";
const LAST_FAILURE_KEY = "copilotPatch.lastAutoFailure";
type PatchScope = "copilot" | "terminal" | "thinking";
let elevationRunning = false;
let pendingAuthorization: PatchTerminalSession | undefined;

async function resumePatchAuthorization(output: vscode.OutputChannel): Promise<boolean> {
	const session = pendingAuthorization;
	if (session) {
		session.terminal.show();
		const choice = session.canRetry
			? await vscode.window.showWarningMessage(
				"The previous administrator patch attempt failed. Retry it in the same terminal, or close it to start a new patch workflow.",
				"Retry in Terminal", "Close Attempt", "Show Log")
			: await vscode.window.showInformationMessage(
				"Patch authorization is active in the terminal. Enter the password there or close the attempt before starting another.",
				"Close Attempt", "Show Log");
		if (pendingAuthorization !== session) { return true; }
		if (choice === "Retry in Terminal") { await session.run(); }
		else if (choice === "Close Attempt") { session.dispose(); return false; }
		else if (choice === "Show Log") { output.show(true); }
		return true;
	}
	if (elevationRunning) {
		void vscode.window.showInformationMessage("A patch authorization request is already running.");
		return true;
	}
	return false;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function permissionError(message: string): boolean {
	return /eperm|eacces|erofs|access is denied|permission denied/i.test(message);
}

/**
 * Lists the locations a patch search visited, so a "not found" report says what
 * was actually checked instead of only which call failed.
 */
function describeSearch(explicitRoot: string | undefined): string[] {
	const lines: string[] = [`Active application root: ${explicitRoot ?? "unknown"}`];
	const appRoots = collectAppRoots(explicitRoot);
	lines.push(`Application roots checked (${appRoots.length}):`);
	for (const entry of appRoots) {
		lines.push(`  - [${entry.source}] ${entry.root}`);
	}
	const extensionRoots = collectExtensionRoots(explicitRoot);
	lines.push(`Extension directories checked (${extensionRoots.length}):`);
	for (const entry of extensionRoots) {
		lines.push(`  - [${entry.source}] ${entry.root}`);
	}
	return lines;
}

function appendResult(output: vscode.OutputChannel, result: CopilotPatchResult): void {
	output.appendLine(`[${new Date().toISOString()}] ${result.message}`);
	output.appendLine(formatCopilotPatchStatus(result.status));
	output.appendLine("");
}

async function offerReload(message: string, output: vscode.OutputChannel): Promise<void> {
	const choice = await vscode.window.showInformationMessage(message, "Reload Window", "Show Log");
	if (choice === "Reload Window") {
		await vscode.commands.executeCommand("workbench.action.reloadWindow");
	} else if (choice === "Show Log") {
		output.show(true);
	}
}

function elevationJobs(context: vscode.ExtensionContext, scope?: PatchScope, restore = false): ElevatedPatchJob[] {
	const jobs: ElevatedPatchJob[] = [];
	const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const modulePath = (name: string): string => path.join(context.extensionPath, "out", name + ".js");
	if (!scope || scope === "copilot") {
		for (const target of findCopilotBundles(vscode.env.appRoot)) {
			// Do not patch another installed VS Code just because search discovered it.
			if (target.appRoot && path.resolve(target.appRoot) !== path.resolve(vscode.env.appRoot)) { continue; }
			if (restore && !getCopilotPatchStatus(target).backupExists) { continue; }
			jobs.push({ modulePath: modulePath("copilot-patch"),
				operation: restore ? "restoreCopilotPatch" : "applyCopilotPatch", target: { ...target } });
		}
	}
	if (scope === "terminal" || (!scope && configuration.get<boolean>("workbenchTerminalPatchEnabled", true))) {
		const target = workbenchBundlePathFromAppRoot(vscode.env.appRoot);
		if (scope || fs.existsSync(target)) { jobs.push({ modulePath: modulePath("byok/workbench-terminal-patch"),
			operation: restore ? "restoreWorkbenchTerminalPatch" : "applyWorkbenchTerminalPatch",
			target }); }
	}
	if (scope === "thinking" || (!scope && configuration.get<boolean>("agentHostThinkingPatchEnabled", true))) {
		const target = agentHostBundlePathFromAppRoot(vscode.env.appRoot);
		if (scope || fs.existsSync(target)) { jobs.push({ modulePath: modulePath("byok/agent-host-thinking-patch"),
			operation: restore ? "restoreAgentHostThinkingPatch" : "applyAgentHostThinkingPatch",
			target }); }
	}
	return jobs;
}

/** Elevation starts only after the user selects the administrator action. */
async function retryWithAdministratorRights(context: vscode.ExtensionContext, output: vscode.OutputChannel,
	scope?: PatchScope, restore = false): Promise<void> {
	if (!patchPermissionActions(process.platform, vscode.env.remoteName).includes(ADMIN_PATCH_ACTION)) { return; }
	if (await resumePatchAuthorization(output)) { return; }
	if (pendingAuthorization || elevationRunning) { await resumePatchAuthorization(output); return; }
	elevationRunning = true;
	let runner: ReturnType<typeof createElevatedPatchRunner> | undefined;
	let terminalOwnsRunner = false;
	try {
		runner = createElevatedPatchRunner(elevationJobs(context, scope, restore));
		const command = elevatedPatchCommand(process.execPath, runner.runnerPath);
		const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
			execFile(command.command, command.args, { encoding: "utf8", timeout: 120_000, maxBuffer: 512_000 },
				(error, stdout, stderr) => resolve({ error, stdout, stderr }));
		});
		output.appendLine((result.stdout + result.stderr).trim());
		if (!result.error) {
			await offerReload("Selected patches updated with administrator rights. Reload the window.", output);
			return;
		}
		output.appendLine("Administrator authorization or patching failed: " + errorText(result.error));
		const terminalElevation = findTerminalElevation();
		const terminalAction = terminalElevation ? `Run ${terminalElevation.method} in Terminal` : undefined;
		const choice = await vscode.window.showWarningMessage(
			terminalElevation
				? `Graphical authorization did not complete. Enter ${terminalElevation.method === "su" ? "the root password" : "your sudo password"} directly in a VS Code terminal.`
				: "Graphical authorization did not complete, and neither sudo nor su is available. You can prepare a user-owned VS Code copy.",
			...(terminalAction ? [terminalAction] : []), USER_CODE_ACTION, "Show Log");
		if (choice === USER_CODE_ACTION) {
			await vscode.commands.executeCommand(PREPARE_USER_VSCODE_COMMAND);
		} else if (terminalAction && choice === terminalAction && terminalElevation) {
			const retainedRunner = runner;
			const terminalCommand = terminalPatchCommand(process.execPath, runner.runnerPath, terminalElevation);
			const session = new PatchTerminalSession({
				command: terminalCommand,
				cleanup: () => fs.rmSync(retainedRunner.directory, { recursive: true, force: true }),
				onClosed: () => { if (pendingAuthorization === session) { pendingAuthorization = undefined; } },
				onSuccess: () => { void offerReload("Selected patches updated with administrator rights. Reload the window.", output); },
				onFailure: error => {
					output.appendLine(errorText(error) + " Retry in the same terminal: " + terminalCommand);
					void vscode.window.showErrorMessage(
						errorText(error) + " Retry here or use Apply Patch in Quick Access.",
						"Retry in Terminal", "Show Log").then(async answer => {
							if (pendingAuthorization !== session) { return; }
							if (answer === "Retry in Terminal") { await session.run(); }
							else if (answer === "Show Log") { output.show(true); }
						});
				},
			});
			pendingAuthorization = session;
			context.subscriptions.push(session);
			terminalOwnsRunner = true;
			await session.run();
		} else if (choice === "Show Log") {
			output.show(true);
		}
	} catch (error) {
		output.appendLine("Administrator patch failed: " + errorText(error));
		void vscode.window.showErrorMessage("Could not apply patches with administrator rights. See the patch log.", "Show Log")
			.then(choice => { if (choice === "Show Log") { output.show(true); } });
	} finally {
		if (!terminalOwnsRunner) {
			if (runner) { fs.rmSync(runner.directory, { recursive: true, force: true }); }
		}
		elevationRunning = false;
	}
}

async function offerPermissionRecovery(context: vscode.ExtensionContext, output: vscode.OutputChannel,
	message: string, scope?: PatchScope, restore = false, changed = false): Promise<void> {
	if (await resumePatchAuthorization(output)) { return; }
	const choice = await vscode.window.showWarningMessage(message,
		...patchPermissionActions(process.platform, vscode.env.remoteName),
		...(changed ? ["Reload Window"] : []), "Show Log");
	if (choice === ADMIN_PATCH_ACTION) {
		await retryWithAdministratorRights(context, output, scope, restore);
	} else if (choice === USER_CODE_ACTION) {
		await vscode.commands.executeCommand(PREPARE_USER_VSCODE_COMMAND);
	} else if (choice === "Reload Window") {
		await vscode.commands.executeCommand("workbench.action.reloadWindow");
	} else if (choice === "Show Log") {
		output.show(true);
	}
}

async function applyTargets(
	output: vscode.OutputChannel,
	targets: CopilotPatchTarget[]
): Promise<{ changed: boolean; permissionFailure: boolean; workbenchSkipped: boolean; results: CopilotPatchResult[] }> {
	const results: CopilotPatchResult[] = [];
	let changed = false;
	let permissionFailure = false;
	let workbenchSkipped = false;
	for (const target of targets) {
		if (process.platform === "linux" && target.appRoot
			&& path.resolve(target.appRoot) !== path.resolve(vscode.env.appRoot) && !isWritable(target.bundlePath)) {
			output.appendLine(`Skipping read-only Copilot in another installation: ${target.bundlePath}`);
			continue;
		}
		try {
			const result = applyCopilotPatch(target, false);
			appendResult(output, result);
			changed = changed || result.changed;
			workbenchSkipped = workbenchSkipped || !result.status.workbenchApplied;
			results.push(result);
		} catch (error) {
			const message = errorText(error);
			output.appendLine(`[${new Date().toISOString()}] Patch failed for ${target.bundlePath}: ${message}`);
			output.appendLine("");
			permissionFailure = permissionFailure || permissionError(message);
			if (targets.length === 1) {
				throw error;
			}
		}
	}
	return { changed, permissionFailure, workbenchSkipped, results };
}

async function applyPatch(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
	userInitiated: boolean
): Promise<void> {
	if (userInitiated) {
		if (await resumePatchAuthorization(output)) { return; }
	} else if (pendingAuthorization || elevationRunning) { return; }
	try {
		const targets = findCopilotBundles(vscode.env.appRoot);
		output.appendLine(`[${new Date().toISOString()}] Copilot Chat bundles found: ${targets.length}`);
		for (const target of targets) {
			output.appendLine(`  - [${target.source ?? "unknown"}] ${target.bundlePath}`);
			output.appendLine(`    workbench: ${target.workbenchPath ?? "not found for this session"}`);
		}
		output.appendLine("");
		if (targets.length === 0) {
			output.appendLine(describeSearch(vscode.env.appRoot).join("\n") + "\n");
			throw new Error(
				"Could not locate Copilot Chat. Install GitHub Copilot Chat for this VS Code, or point VSCODE_APP_ROOT at the application root."
			);
		}

		const { changed, permissionFailure, workbenchSkipped, results } = await applyTargets(output, targets);
		await context.globalState.update(LAST_FAILURE_KEY, undefined);

		const readOnlyWorkbench = results.some(result => result.status.workbenchPath
			&& !result.status.workbenchApplied && !isWritable(result.status.workbenchPath));
		if (permissionFailure || readOnlyWorkbench || results.some(result => result.status.notices.some(permissionError))) {
			await offerPermissionRecovery(context, output,
				"Some patches need write access to this VS Code installation. Choose a user-owned copy or authorize changes to the system files.",
				undefined, false, changed);
			return;
		}
		if (changed) {
			const message = workbenchSkipped
				? "AI Agent Bridge patched native model controls. The VS Code workbench part was skipped; reload the window to activate what was applied."
				: "AI Agent Bridge patched native model controls and bounded stored chat tool output. Reload the window to activate them.";
			await offerReload(message, output);
			return;
		}
		if (permissionFailure) {
			throw new Error("The Copilot Chat bundle could not be written: permission denied.");
		}
		if (userInitiated) {
			const notices = results.flatMap(result => result.status.notices);
			void vscode.window.showInformationMessage(
				notices.length > 0
					? "Copilot Chat patch is already applied; the VS Code workbench part is not available."
					: "Copilot Chat patches are already active."
			);
		}
	} catch (error) {
		const message = errorText(error);
		output.appendLine(`[${new Date().toISOString()}] Patch failed: ${message}`);
		output.appendLine(describeSearch(vscode.env.appRoot).join("\n") + "\n");
		output.appendLine("");
		if (userInitiated) {
			if (permissionError(message)) {
				await offerPermissionRecovery(context, output, `Copilot Chat patch failed: ${message}`);
			} else {
				const choice = await vscode.window.showErrorMessage(`Copilot Chat patch failed: ${message}`, "Show Log");
				if (choice === "Show Log") { output.show(true); }
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
			permissionError(message)
				? "AI Agent Bridge cannot write this VS Code installation. Choose a user-owned copy or authorize patching the system files."
				: "AI Agent Bridge could not update the Copilot Chat patch for this VS Code build. The original bundle was not modified.",
			...(permissionError(message) ? patchPermissionActions(process.platform, vscode.env.remoteName) : []),
			"Show Log",
			"Disable Auto-Patch"
		);
		if (choice === ADMIN_PATCH_ACTION) {
			await retryWithAdministratorRights(context, output);
		} else if (choice === USER_CODE_ACTION) {
			await vscode.commands.executeCommand(PREPARE_USER_VSCODE_COMMAND);
		} else if (choice === "Show Log") {
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
		const targets = findCopilotBundles(vscode.env.appRoot);
		output.appendLine(`[${new Date().toISOString()}] Patch status`);
		if (targets.length === 0) {
			output.appendLine("No Copilot Chat bundle found.");
			output.appendLine(describeSearch(vscode.env.appRoot).join("\n") + "\n");
			output.appendLine("");
			void vscode.window.showWarningMessage("Copilot Chat was not found; see the log for the search list.", "Show Log");
			return;
		}
		const summaries: string[] = [];
		for (const target of targets) {
			const status = getCopilotPatchStatus(target);
			output.appendLine(formatCopilotPatchStatus(status));
			output.appendLine("");
			summaries.push(
				`Copilot Chat ${status.copilotVersion} (${target.source ?? "unknown"}): controls ${
					status.applied ? "applied" : status.legacyPatch ? "legacy" : "not applied"
				}, history bounds ${status.workbenchApplied ? "applied" : "not applied"}`
			);
		}
		const choice = await vscode.window.showInformationMessage(summaries.join("; "), "Show Log");
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

async function restorePatch(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
	if (await resumePatchAuthorization(output)) { return; }
	const confirmation = await vscode.window.showWarningMessage(
		"Restore the original Copilot Chat and VS Code workbench bundles? Native controls and stored tool-output bounds will stop working after reload.",
		{ modal: true },
		"Restore"
	);
	if (confirmation !== "Restore") {
		return;
	}
	try {
		const targets = findCopilotBundles(vscode.env.appRoot);
		if (targets.length === 0) {
			throw new Error("Could not locate Copilot Chat. See the log for the search list.");
		}
		let restored = false;
		for (const target of targets) {
			const status = getCopilotPatchStatus(target);
			if (!status.backupExists) {
				output.appendLine(`[${new Date().toISOString()}] No backup for ${target.bundlePath}; nothing to restore.`);
				continue;
			}
			appendResult(output, restoreCopilotPatch(target));
			restored = true;
		}
		if (restored) {
			await offerReload("Original Copilot Chat bundle restored. Reload the window to activate it.", output);
		} else {
			void vscode.window.showInformationMessage("No Copilot Chat backup was found; nothing to restore.");
		}
	} catch (error) {
		const message = errorText(error);
		output.appendLine(`[${new Date().toISOString()}] Restore failed: ${message}`);
		if (permissionError(message)) {
			await offerPermissionRecovery(context, output, "Restoring the original bundles needs administrator rights.", "copilot", true);
			return;
		}
		const choice = await vscode.window.showErrorMessage(`Could not restore Copilot Chat: ${message}`, "Show Log");
		if (choice === "Show Log") {
			output.show(true);
		}
	}
}

export function registerCopilotPatchIntegration(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel("AI Agent Bridge Copilot Patch");
	registerUserVsCodeCommand(context, output);
	context.subscriptions.push(
		output,
		vscode.commands.registerCommand("llamacpp.applyCopilotPatch", () => applyPatch(context, output, true)),
		vscode.commands.registerCommand("llamacpp.copilotPatchStatus", () => showStatus(output)),
		vscode.commands.registerCommand("llamacpp.restoreCopilotPatch", () => restorePatch(context, output)),
		vscode.commands.registerCommand("llamacpp.recoverPatchPermissions", async (scope: PatchScope, restore = false) => {
			if (!["copilot", "terminal", "thinking"].includes(scope)) { return; }
			await offerPermissionRecovery(context, output,
				"Updating this patch needs write access to the VS Code application files.", scope, restore);
		})
	);

	if (
		context.extensionMode === vscode.ExtensionMode.Production
		&& vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(AUTO_PATCH_SETTING, true)
	) {
		setTimeout(() => void applyPatch(context, output, false), 0);
	}
}
