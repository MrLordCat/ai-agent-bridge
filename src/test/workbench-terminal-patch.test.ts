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
} from "../byok/workbench-terminal-patch";

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
                const patternText =
                        `_initTerminal(e,t,o,n,r){if(!n){let u=this._sessionTerminalAssociations.get(e);` +
                        `if(u&&!u.isBackground&&!u.instance.isDisposed)`;
                const patternCount = source.split(patternText).length - 1;
                if (markerCount === 1) {
                        assert.strictEqual(patternCount, 0, "patched bundle must not contain the original pattern");
                } else {
                        assert.strictEqual(markerCount, 0, "bundle must not be half-patched");
                        assert.strictEqual(patternCount, 1, "unpatched bundle must contain the pattern exactly once");
                }
                const status = getWorkbenchTerminalPatchStatus(bundlePath);
                assert.strictEqual(status.sha256.length, 64);
        });
});
