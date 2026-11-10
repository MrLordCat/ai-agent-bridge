import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
        WORKBENCH_TERMINAL_PATCH_MARKER,
        applyWorkbenchTerminalPatch,
        findWorkbenchBundle,
        getWorkbenchTerminalPatchStatus,
        patchWorkbenchTerminalBundle,
        restoreWorkbenchTerminalPatch,
        unpatchWorkbenchTerminalBundle,
} from "../byok/workbench-terminal-patch";
import {
        COPILOT_PATCH_MARKER,
        VSCODE_CHAT_HISTORY_PATCH_MARKER,
        restoreCopilotPatch,
        type CopilotPatchTarget,
} from "../copilot-patch";

const INIT_TERMINAL_SOURCE =
        `class X{` +
        `async _initTerminal(e,t,o,n,r){if(!n){let u=this._sessionTerminalAssociations.get(e);` +
        `if(u&&!u.isBackground&&!u.instance.isDisposed)if(u.instance.exitCode!==void 0)` +
        `this._logService.info(\`RunInTerminalTool: Cached terminal shell has exited (code=\${u.instance.exitCode}), creating a new terminal\`),` +
        `this._sessionTerminalAssociations.delete(e);` +
        `else return this._logService.debug(\`RunInTerminalTool: Using cached terminal with session resource \\\`\${e}\\\`\`),` +
        `this._terminalToolCreator.refreshShellIntegrationQuality(u),` +
        `this._terminalChatService.registerTerminalInstanceWithToolSession(o,u.instance),` +
        `this._backgroundNotifications.deleteAndDispose(u.instance.instanceId),u}}}`;

	suite("1.133 parameter rename", () => {
		const INIT_TERMINAL_133 =
			`class X{` +
			`async _initTerminal(e,t,i,n,r){if(!n){let u=this._sessionTerminalAssociations.get(e);` +
			`if(u&&!u.isBackground&&!u.instance.isDisposed)if(u.instance.exitCode!==void 0)` +
			`this._logService.info(\`RunInTerminalTool: Cached terminal shell has exited (code=\${u.instance.exitCode}), creating a new terminal\`),` +
			`this._sessionTerminalAssociations.delete(e);` +
			`else return this._logService.debug(\`RunInTerminalTool: Using cached terminal with session resource \\\`\${e}\\\`\`),` +
			`this._terminalToolCreator.refreshShellIntegrationQuality(u),` +
			`this._terminalChatService.registerTerminalInstanceWithToolSession(i,u.instance),` +
			`this._backgroundNotifications.deleteAndDispose(u.instance.instanceId),u}}}`;

		test("reverts the 1.133 signature exactly", () => {
			assert.strictEqual(unpatchWorkbenchTerminalBundle(patchWorkbenchTerminalBundle(INIT_TERMINAL_133)), INIT_TERMINAL_133);
		});

		test("patches the 1.133 signature (tool-session parameter i)", () => {
			const patched = patchWorkbenchTerminalBundle(INIT_TERMINAL_133);
			assert.ok(patched.includes(WORKBENCH_TERMINAL_PATCH_MARKER), "marker must be present");
			assert.ok(patched.includes("_initTerminal(e,t,i,n,r){"), "original signature must be preserved");
			assert.ok(patched.includes("registerTerminalInstanceWithToolSession(i,u.instance)"), "patched code must use the captured parameter name");
			assert.ok(patched.includes("u.isBackground=!1"), "reuse branch must be present");
			new Function(patched);
		});
	});

suite("Agents Bridge — workbench terminal reuse patch", () => {
        test("patches the idle background terminal reuse branch into initTerminal", () => {
                const patched = patchWorkbenchTerminalBundle(INIT_TERMINAL_SOURCE);
                assert.ok(patched.includes(WORKBENCH_TERMINAL_PATCH_MARKER), "marker must be present");
                assert.ok(patched.includes("u.isBackground=!1"), "background flag must be flipped to foreground");
                assert.ok(
                        patched.includes('Reusing idle background terminal for session resource'),
                        "reuse log line must be present"
                );
                assert.ok(
                        patched.includes("u.instance.capabilities.get(2)?.executingCommandObject??void 0)===void 0"),
                        "idle check must use the rich CommandDetection capability"
                );
                assert.ok(
                        patched.includes("Using cached terminal with session resource"),
                        "the original cached-foreground path must remain"
                );
                assert.ok(
                        patched.includes("Cached terminal shell has exited"),
                        "the original exited-shell path must remain"
                );
                new Function(patched);
        });

        test("is idempotent", () => {
                const once = patchWorkbenchTerminalBundle(INIT_TERMINAL_SOURCE);
                const twice = patchWorkbenchTerminalBundle(once);
                assert.strictEqual(twice, once);
        });

        test("rejects a bundle without a unique initTerminal pattern", () => {
                assert.throws(() => patchWorkbenchTerminalBundle("class X{}"), /initTerminal pattern/);
        });

        test("reverts only its own method and keeps the rest of the file", () => {
                const source = `${VSCODE_CHAT_HISTORY_PATCH_MARKER}function __llamaBoundToolText(e){return e}` + INIT_TERMINAL_SOURCE;
                assert.strictEqual(unpatchWorkbenchTerminalBundle(patchWorkbenchTerminalBundle(source)), source);
                assert.strictEqual(unpatchWorkbenchTerminalBundle(source), source, "an unpatched file is returned as is");
        });

        test("refuses to revert a patched method that was changed afterwards", () => {
                const changed = patchWorkbenchTerminalBundle(INIT_TERMINAL_SOURCE).replace("u.isBackground=!1;", "u.isBackground=!1;x();");
                assert.throws(() => unpatchWorkbenchTerminalBundle(changed), /cannot be reverted/);
        });

        test("does not write a patched bundle that fails syntax validation", function () {
                this.timeout(30_000);
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-terminal-invalid-"));
                const bundlePath = path.join(dir, "workbench.desktop.main.js");
                const broken = INIT_TERMINAL_SOURCE + "}";
                fs.writeFileSync(bundlePath, broken);
                try {
                        assert.throws(() => applyWorkbenchTerminalPatch(bundlePath), /syntax validation/);
                        assert.strictEqual(fs.readFileSync(bundlePath, "utf8"), broken);
                        assert.ok(!fs.existsSync(bundlePath + ".llama-vscode-chat.bak"), "no backup for a refused patch");
                        assert.ok(!fs.existsSync(bundlePath + ".llama-vscode-chat.lock"), "the lock is released");
                } finally {
                        fs.rmSync(dir, { recursive: true, force: true });
                }
        });

        test("applies and restores against a temporary bundle copy", () => {
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-terminal-patch-"));
                const bundlePath = path.join(dir, "workbench.desktop.main.js");
                fs.writeFileSync(bundlePath, INIT_TERMINAL_SOURCE);
                try {
                        const applied = applyWorkbenchTerminalPatch(bundlePath);
                        assert.ok(applied.changed, "first apply must change the file");
                        assert.ok(applied.status.applied, "status must report applied");
                        assert.ok(applied.status.backupExists, "backup must be created");
                        assert.ok(
                                fs.readFileSync(bundlePath, "utf8").includes(WORKBENCH_TERMINAL_PATCH_MARKER),
                                "file must contain the marker"
                        );
                        const again = applyWorkbenchTerminalPatch(bundlePath);
                        assert.ok(!again.changed, "second apply must be a no-op");
                        const restored = restoreWorkbenchTerminalPatch(bundlePath);
                        assert.ok(restored.changed, "restore must change the file");
                        assert.ok(
                                !fs.readFileSync(bundlePath, "utf8").includes(WORKBENCH_TERMINAL_PATCH_MARKER),
                                "restored file must not contain the marker"
                        );
                        assert.strictEqual(
                                fs.readFileSync(bundlePath, "utf8"),
                                INIT_TERMINAL_SOURCE,
                                "restored file must equal the original"
                        );
                } finally {
                        fs.rmSync(dir, { recursive: true, force: true });
                }
        });

        test("restore keeps the chat-history patch even when the terminal backup is outdated", function () {
                this.timeout(30_000);
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-terminal-shared-"));
                const bundlePath = path.join(dir, "workbench.desktop.main.js");
                const historyPatched = `${VSCODE_CHAT_HISTORY_PATCH_MARKER}function __llamaBoundToolText(e){return e}` + INIT_TERMINAL_SOURCE;
                fs.writeFileSync(bundlePath, historyPatched);
                try {
                        applyWorkbenchTerminalPatch(bundlePath);
                        fs.writeFileSync(bundlePath + ".llama-vscode-chat.bak", INIT_TERMINAL_SOURCE);
                        assert.strictEqual(restoreWorkbenchTerminalPatch(bundlePath).changed, true);
                        assert.strictEqual(fs.readFileSync(bundlePath, "utf8"), historyPatched);
                        assert.strictEqual(restoreWorkbenchTerminalPatch(bundlePath).changed, false, "nothing left to restore");
                } finally {
                        fs.rmSync(dir, { recursive: true, force: true });
                }
        });

        test("matches the installed workbench bundle exactly once (read-only)", function () {
                let bundlePath: string;
                try {
                        bundlePath = findWorkbenchBundle(vscode.env.appRoot).bundlePath;
                } catch {
                        this.skip();
                        return;
                }
                const source = fs.readFileSync(bundlePath, "utf8");
                const markerCount = source.split(WORKBENCH_TERMINAL_PATCH_MARKER).length - 1;
                assert.ok(markerCount <= 1, "bundle must not be patched twice");
                const original = markerCount === 1 ? unpatchWorkbenchTerminalBundle(source) : source;
                assert.ok(!original.includes(WORKBENCH_TERMINAL_PATCH_MARKER));
                // The extension's own matcher: a bundle shape it cannot patch fails here instead of skipping.
                const patched = patchWorkbenchTerminalBundle(original);
                assert.strictEqual(patched.split(WORKBENCH_TERMINAL_PATCH_MARKER).length - 1, 1);
                assert.strictEqual(unpatchWorkbenchTerminalBundle(patched), original, "the revert must be exact");
                if (markerCount === 1) {
                        assert.strictEqual(patched, source, "an installed patch matches a fresh one");
                }
                const status = getWorkbenchTerminalPatchStatus(bundlePath);
                assert.strictEqual(status.sha256.length, 64);
        });
});

suite("Shared workbench — Copilot restore and the terminal patch", () => {
        let dir: string;
        setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-workbench-")); });
        teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });

        function target(bundle: string, workbench: string, workbenchBackup: string, recordedVersion?: string): CopilotPatchTarget {
                const bundlePath = path.join(dir, "extension.js");
                const workbenchPath = path.join(dir, "workbench.desktop.main.js");
                fs.writeFileSync(bundlePath, bundle);
                fs.writeFileSync(bundlePath + ".llama-vscode-chat.backup", "var original=1;");
                fs.writeFileSync(workbenchPath, workbench);
                fs.writeFileSync(workbenchPath + ".llama-vscode-chat.backup", workbenchBackup);
                if (recordedVersion) {
                        fs.writeFileSync(bundlePath + ".llama-vscode-chat.patch.json", JSON.stringify({ copilotVersion: recordedVersion }));
                }
                return { bundlePath, workbenchPath, packagePath: path.join(dir, "package.json"), manifest: { name: "copilot-chat", version: "0.71.0" } };
        }

        test("keeps a terminal patch applied after the workbench backup was taken", function () {
                this.timeout(30_000);
                const terminalPatched = patchWorkbenchTerminalBundle(INIT_TERMINAL_SOURCE);
                const copilot = target(COPILOT_PATCH_MARKER + "var patched=1;", VSCODE_CHAT_HISTORY_PATCH_MARKER + terminalPatched, INIT_TERMINAL_SOURCE);
                const result = restoreCopilotPatch(copilot);
                assert.strictEqual(result.changed, true);
                assert.strictEqual(fs.readFileSync(copilot.workbenchPath as string, "utf8"), terminalPatched);
                assert.strictEqual(fs.readFileSync(copilot.bundlePath, "utf8"), "var original=1;");
                assert.ok(!fs.existsSync(copilot.workbenchPath + ".llama-vscode-chat.backup"));
        });

        test("drops a terminal patch reverted after the workbench backup was taken", () => {
                const copilot = target(
                        COPILOT_PATCH_MARKER + "var patched=1;",
                        VSCODE_CHAT_HISTORY_PATCH_MARKER + INIT_TERMINAL_SOURCE,
                        patchWorkbenchTerminalBundle(INIT_TERMINAL_SOURCE)
                );
                restoreCopilotPatch(copilot);
                assert.strictEqual(fs.readFileSync(copilot.workbenchPath as string, "utf8"), INIT_TERMINAL_SOURCE);
        });

        test("leaves unpatched files alone instead of copying outdated backups", () => {
                const copilot = target("var updated=2;", "updated workbench", "previous workbench", "0.70.0");
                const result = restoreCopilotPatch(copilot);
                assert.strictEqual(result.changed, false);
                assert.strictEqual(fs.readFileSync(copilot.bundlePath, "utf8"), "var updated=2;");
                assert.strictEqual(fs.readFileSync(copilot.workbenchPath as string, "utf8"), "updated workbench");
                assert.ok(!fs.existsSync(copilot.bundlePath + ".llama-vscode-chat.backup"), "the outdated backup is removed");
        });

        test("refuses to downgrade a patched bundle from the backup of another version", () => {
                const patched = COPILOT_PATCH_MARKER + "var patched=1;";
                const copilot = target(patched, "updated workbench", "previous workbench", "0.70.0");
                assert.throws(() => restoreCopilotPatch(copilot), /would downgrade Copilot Chat/);
                assert.strictEqual(fs.readFileSync(copilot.bundlePath, "utf8"), patched);
                assert.ok(fs.existsSync(copilot.bundlePath + ".llama-vscode-chat.backup"), "the backup is kept");
                assert.ok(!fs.existsSync(copilot.workbenchPath + ".llama-vscode-chat.lock"), "both locks are released");
        });
});
