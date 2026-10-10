import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type PatchOperation = "applyCopilotPatch" | "restoreCopilotPatch"
	| "applyWorkbenchTerminalPatch" | "restoreWorkbenchTerminalPatch"
	| "applyAgentHostThinkingPatch" | "restoreAgentHostThinkingPatch";

export interface ElevatedPatchJob {
	modulePath: string;
	operation: PatchOperation;
	target: string | { bundlePath: string; [key: string]: unknown };
}

export const ADMIN_PATCH_ACTION = "Apply patches with administrator rights";
export const USER_CODE_ACTION = "Prepare User VS Code (no root)";

export function patchPermissionActions(platform: string, remoteName?: string): string[] {
	return platform === "linux" && !remoteName ? [USER_CODE_ACTION, ADMIN_PATCH_ACTION] : [];
}

export function quotePosixArgument(value: string): string {
	return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/** Freeze the targets found as the desktop user: root must not rediscover another profile. */
export function createElevatedPatchRunner(jobs: readonly ElevatedPatchJob[]): { directory: string; runnerPath: string } {
	if (!jobs.length) { throw new Error("No patches selected."); }
	const allowed: PatchOperation[] = ["applyCopilotPatch", "restoreCopilotPatch",
		"applyWorkbenchTerminalPatch", "restoreWorkbenchTerminalPatch",
		"applyAgentHostThinkingPatch", "restoreAgentHostThinkingPatch"];
	for (const job of jobs) {
		if (!allowed.includes(job.operation)) { throw new Error("Unsupported patch operation."); }
	}
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-agent-bridge-patches-"));
	const runnerPath = path.join(directory, "apply.cjs");
	const body = [
		"const fs = require('node:fs'), path = require('node:path');",
		"const jobs = " + JSON.stringify(jobs) + ";",
		"let failed = false;",
		"for (const job of jobs) {",
		"  try {",
		"    const file = typeof job.target === 'string' ? job.target : job.target.bundlePath;",
		"    const owner = fs.statSync(file);",
		"    const patch = require(job.modulePath);",
		// Keep the same compatibility, backup and syntax checks as an ordinary attempt.
		"    const result = patch[job.operation](job.target);",
		"    console.log(result.message);",
		"    for (const notice of result.status?.notices || []) {",
		"      console.log('Notice: ' + notice);",
		"      if (/eperm|eacces|erofs|permission denied|access is denied/i.test(notice)) failed = true;",
		"    }",
		// New backups/metadata of user-owned Copilot must remain manageable by that user.
		"    if (process.getuid?.() === 0) {",
		"      for (const name of fs.readdirSync(path.dirname(file))) {",
		"        if (!name.startsWith(path.basename(file) + '.llama-vscode-chat.')) continue;",
		"        const artifact = path.join(path.dirname(file), name);",
		"        if (fs.lstatSync(artifact).isFile()) fs.chownSync(artifact, owner.uid, owner.gid);",
		"      }",
		"    }",
		"  } catch (error) { failed = true; console.error(String(error)); }",
		"}",
		"process.exitCode = failed ? 1 : 0;",
		"",
	].join("\n");
	try {
		fs.writeFileSync(runnerPath, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
		return { directory, runnerPath };
	} catch (error) {
		fs.rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}

export interface TerminalElevation {
	method: "sudo" | "su";
	executable: string;
}

/** Minimal Debian installations may have su without sudo. */
export function findTerminalElevation(searchPath = process.env.PATH ?? ""): TerminalElevation | undefined {
	for (const method of ["sudo", "su"] as const) {
		for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
			const executable = path.join(directory, method);
			try {
				if (!fs.statSync(executable).isFile()) { continue; }
				fs.accessSync(executable, fs.constants.X_OK);
				return { method, executable };
			} catch { /* Continue searching installed executables. */ }
		}
	}
	return undefined;
}

export function terminalPatchCommand(nodePath: string, runnerPath: string, elevation: TerminalElevation): string {
	const payload = "/usr/bin/env ELECTRON_RUN_AS_NODE=1 " + [nodePath, runnerPath].map(quotePosixArgument).join(" ");
	return elevation.method === "su"
		? quotePosixArgument(elevation.executable) + " - root -c " + quotePosixArgument(payload)
		: quotePosixArgument(elevation.executable) + " " + payload;
}

export function elevatedPatchCommand(nodePath: string, runnerPath: string): { command: string; args: string[] } {
	const args = ["/usr/bin/env", "ELECTRON_RUN_AS_NODE=1", nodePath, runnerPath];
	return {
		command: "pkexec",
		args,
	};
}
