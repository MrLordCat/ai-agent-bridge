import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { ADMIN_PATCH_ACTION, USER_CODE_ACTION, createElevatedPatchRunner,
	elevatedPatchCommand, findTerminalElevation, terminalPatchCommand, patchPermissionActions, quotePosixArgument, type ElevatedPatchJob } from "../patch-elevation";
import { applyCopilotPatch, findCopilotBundles, restoreCopilotPatch } from "../copilot-patch";

suite("Patch permission recovery", () => {
	let directory: string;
	setup(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-elevation-test-")); });
	teardown(() => { fs.rmSync(directory, { recursive: true, force: true }); });

	function run(body: string, count = 1): ReturnType<typeof spawnSync> {
		const modulePath = path.join(directory, "patch.cjs"), target = path.join(directory, "bundle.js");
		fs.writeFileSync(modulePath, body);
		fs.writeFileSync(target, "original");
		const jobs: ElevatedPatchJob[] = Array.from({ length: count }, () => ({
			modulePath, operation: "applyCopilotPatch", target: { bundlePath: target },
		}));
		const runner = createElevatedPatchRunner(jobs);
		try { return spawnSync(process.execPath, [runner.runnerPath], {
			encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 10_000,
		}); } finally { fs.rmSync(runner.directory, { recursive: true, force: true }); }
	}

	test("offers both choices only for a local Linux desktop", () => {
		assert.deepStrictEqual(patchPermissionActions("linux"), [USER_CODE_ACTION, ADMIN_PATCH_ACTION]);
		for (const remote of ["ssh-remote", "wsl", "dev-container"]) {
			assert.deepStrictEqual(patchPermissionActions("linux", remote), []);
		}
		assert.deepStrictEqual(patchPermissionActions("win32"), []);
		assert.deepStrictEqual(patchPermissionActions("darwin"), []);
	});

	test("quotes shell paths including apostrophes and command substitutions literally", () => {
		assert.strictEqual(quotePosixArgument("space $() ' path"), "'space $() '\"'\"' path'");
	});

	test("runs Electron as Node and leaves sudo authentication to the terminal", () => {
		const command = elevatedPatchCommand("/opt/Code app/code", "/tmp/user's/apply.cjs");
		assert.deepStrictEqual(command.args, ["/usr/bin/env", "ELECTRON_RUN_AS_NODE=1", "/opt/Code app/code", "/tmp/user's/apply.cjs"]);
		assert.strictEqual(command.command, "pkexec");
		const terminalCommand = terminalPatchCommand("/opt/Code app/code", "/tmp/user's/apply.cjs", { method: "sudo", executable: "/usr/bin/sudo" });
		assert.ok(terminalCommand.startsWith("'/usr/bin/sudo' /usr/bin/env ELECTRON_RUN_AS_NODE=1 "));
		assert.ok(terminalCommand.includes(quotePosixArgument("/tmp/user's/apply.cjs")));
	});

	test("selects su when sudo is missing and ignores directories named like commands", () => {
		const executable = path.join(directory, "su");
		fs.writeFileSync(executable, "", { mode: 0o755 });
		fs.mkdirSync(path.join(directory, "sudo"));
		assert.deepStrictEqual(findTerminalElevation(directory), { method: "su", executable });
		assert.strictEqual(findTerminalElevation(path.join(directory, "missing")), undefined);
	});

	test("prefers executable sudo when present, otherwise falls back to su", () => {
		const sudo = path.join(directory, "sudo"), su = path.join(directory, "su");
		fs.writeFileSync(sudo, "", { mode: 0o755 }); fs.writeFileSync(su, "", { mode: 0o755 });
		assert.deepStrictEqual(findTerminalElevation(directory), { method: "sudo", executable: sudo });
		if (process.platform !== "win32") {
			fs.chmodSync(sudo, 0o644);
			assert.deepStrictEqual(findTerminalElevation(directory), { method: "su", executable: su });
		}
	});

	test("passes a quoted command to su -c without expanding paths or treating env as a username", function () {
		if (process.platform !== "linux") { this.skip(); return; }
		const executable = path.join(directory, "su");
		fs.writeFileSync(executable, [
			"#!/bin/sh",
			'[ "$1" = "-" ] && [ "$2" = "root" ] && [ "$3" = "-c" ] && [ "$#" = 4 ] || exit 7',
			'exec /bin/sh -c "$4"',
			"",
		].join("\n"), { mode: 0o755 });
		const nodePath = path.join(directory, "node's $(no-expansion)"), runnerPath = path.join(directory, "runner's $(no-expansion).cjs");
		fs.symlinkSync(process.execPath, nodePath);
		fs.writeFileSync(runnerPath, "console.log('literal paths executed')");
		const command = terminalPatchCommand(nodePath, runnerPath, { method: "su", executable });
		const result = spawnSync("/bin/sh", ["-c", command], {
			encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 10_000,
		});
		assert.strictEqual(result.status, 0, String(result.stderr));
		assert.match(String(result.stdout), /literal paths executed/);
	});

	test("uses the frozen target without rediscovering root's extensions or forcing backups", () => {
		const result = run("exports.findCopilotBundles=()=>{throw Error('root discovery')}; exports.applyCopilotPatch=(target,...args)=>{if(args.length)throw Error('force'); if(!target.bundlePath.endsWith('bundle.js'))throw Error('target'); return {changed:true,message:'applied',status:{notices:[]}}};");
		assert.strictEqual(result.status, 0, String(result.stderr));
		assert.match(String(result.stdout), /applied/);
	});

	test("treats an already applied patch as success", () => {
		const result = run("exports.applyCopilotPatch=()=>({changed:false,message:'already applied',status:{notices:[]}})");
		assert.strictEqual(result.status, 0, String(result.stderr));
	});

	test("keeps trying selected jobs after a failure and reports failure", () => {
		const result = run("let count=0;exports.applyCopilotPatch=()=>{if(!count++)throw Error('unsupported');return {message:'second job applied'}};", 2);
		assert.strictEqual(result.status, 1);
		assert.match(String(result.stderr), /unsupported/);
		assert.match(String(result.stdout), /second job applied/);
	});

	test("reports partial permission failures as failure", () => {
		const result = run("exports.applyCopilotPatch=()=>({message:'part applied',status:{notices:['workbench: EACCES permission denied']}})");
		assert.strictEqual(result.status, 1);
		assert.match(String(result.stdout), /EACCES/);
	});

	test("creates private runner files and rejects empty or unknown jobs", () => {
		assert.throws(() => createElevatedPatchRunner([]), /No patches/);
		assert.throws(() => createElevatedPatchRunner([{ modulePath: "x", target: "x",
			operation: "arbitrary" as ElevatedPatchJob["operation"] }]), /Unsupported/);
		const runner = createElevatedPatchRunner([{ modulePath: "x", target: "x", operation: "applyCopilotPatch" }]);
		try {
			assert.ok(fs.existsSync(runner.runnerPath));
			if (process.platform !== "win32") {
				assert.strictEqual(fs.statSync(runner.directory).mode & 0o777, 0o700);
				assert.strictEqual(fs.statSync(runner.runnerPath).mode & 0o777, 0o600);
			}
		} finally { fs.rmSync(runner.directory, { recursive: true, force: true }); }
	});

	test("applies user-owned Copilot when workbench syntax validation cannot write system files", function () {
		this.timeout(60_000);
		if (process.platform !== "linux" || process.getuid?.() === 0) { this.skip(); return; }
		const source = findCopilotBundles(vscode.env.appRoot).find(target => target.workbenchPath);
		assert.ok(source?.workbenchPath, "The Debian test host has a real desktop workbench");
		const original = (file: string): Buffer => fs.readFileSync(
			fs.existsSync(file + ".llama-vscode-chat.backup") ? file + ".llama-vscode-chat.backup" : file);
		const bundlePath = path.join(directory, "extension.js"), workbenchPath = path.join(directory, "workbench.js");
		fs.writeFileSync(bundlePath, original(source.bundlePath));
		const workbench = original(source.workbenchPath);
		fs.writeFileSync(workbenchPath, workbench);
		fs.chmodSync(workbenchPath, 0o444);
		try {
			const result = applyCopilotPatch({ ...source, bundlePath, workbenchPath });
			assert.strictEqual(result.status.applied, true);
			assert.strictEqual(result.status.workbenchApplied, false);
			assert.ok(result.status.notices.some(notice => /EACCES|permission denied/.test(notice)));
			assert.ok(fs.readFileSync(workbenchPath).equals(workbench), "The read-only workbench stays intact");
		} finally { fs.chmodSync(workbenchPath, 0o644); }
	});

	test("preserves both backups when a read-only workbench cannot be restored", function () {
		if (process.platform !== "linux" || process.getuid?.() === 0) { this.skip(); return; }
		const bundlePath = path.join(directory, "extension.js"), workbenchPath = path.join(directory, "workbench.js");
		const backup = bundlePath + ".llama-vscode-chat.backup", workbenchBackup = workbenchPath + ".llama-vscode-chat.backup";
		fs.writeFileSync(bundlePath, "patched Copilot"); fs.writeFileSync(backup, "original Copilot");
		fs.writeFileSync(workbenchPath, "patched workbench"); fs.writeFileSync(workbenchBackup, "original workbench");
		fs.chmodSync(workbenchPath, 0o444);
		const target = { bundlePath, workbenchPath, packagePath: path.join(directory, "package.json"), manifest: { version: "test" } };
		try {
			assert.throws(() => restoreCopilotPatch(target), /EACCES|permission denied/);
			assert.ok(fs.existsSync(backup)); assert.ok(fs.existsSync(workbenchBackup));
			assert.strictEqual(fs.readFileSync(bundlePath, "utf8"), "patched Copilot");
			fs.chmodSync(workbenchPath, 0o644);
			assert.strictEqual(restoreCopilotPatch(target).changed, true);
			assert.strictEqual(fs.readFileSync(bundlePath, "utf8"), "original Copilot");
			assert.strictEqual(fs.readFileSync(workbenchPath, "utf8"), "original workbench");
		} finally { fs.chmodSync(workbenchPath, 0o644); }
	});
});
