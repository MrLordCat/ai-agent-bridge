import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * Patches the VS Code workbench bundle so the RunInTerminalTool reuses an
 * idle background tool terminal for foreground (sync) commands instead of
 * spawning a new terminal per call.
 *
 * VS Code 1.131 mechanics (verified 2026-08-16 in the installed bundle):
 *  - RunInTerminalTool._initTerminal caches one foreground terminal per chat
 *    session. When a sync command times out / is interrupted, the terminal is
 *    moved to the background (isBackground=true) and the next sync call gets
 *    a NEW terminal — panels accumulate.
 *  - A background terminal is idle when its shell is alive (exitCode is
 *    undefined) and the rich CommandDetection capability reports no executing
 *    command (executingCommandObject === undefined).
 *  - This patch reuses such a terminal (flipping it back to foreground) and
 *    keeps the original behavior otherwise.
 */
export const WORKBENCH_TERMINAL_PATCH_ID = "llama-vscode-chat:idle-bg-terminal-reuse:v1";
export const WORKBENCH_TERMINAL_PATCH_MARKER = `/* ${WORKBENCH_TERMINAL_PATCH_ID} */`;

const INIT_TERMINAL_PATTERN =
        `_initTerminal(e,t,o,n,r){if(!n){let u=this._sessionTerminalAssociations.get(e);` +
        `if(u&&!u.isBackground&&!u.instance.isDisposed)if(u.instance.exitCode!==void 0)` +
        `this._logService.info(\`RunInTerminalTool: Cached terminal shell has exited (code=\${u.instance.exitCode}), creating a new terminal\`),` +
        `this._sessionTerminalAssociations.delete(e);` +
        `else return this._logService.debug(\`RunInTerminalTool: Using cached terminal with session resource \\\`\${e}\\\`\`),` +
        `this._terminalToolCreator.refreshShellIntegrationQuality(u),` +
        `this._terminalChatService.registerTerminalInstanceWithToolSession(o,u.instance),` +
        `this._backgroundNotifications.deleteAndDispose(u.instance.instanceId),u}`;

const INIT_TERMINAL_PATCHED =
        `_initTerminal(e,t,o,n,r){if(!n){let u=this._sessionTerminalAssociations.get(e);` +
        WORKBENCH_TERMINAL_PATCH_MARKER +
        `if(u&&!u.instance.isDisposed){` +
        `if(u.isBackground){` +
        `if(u.instance.exitCode===void 0&&u.shellIntegrationQuality==="rich"&&` +
        `(u.instance.capabilities.get(2)?.executingCommandObject??void 0)===void 0){` +
        `u.isBackground=!1;` +
        `this._logService.info(\`RunInTerminalTool: Reusing idle background terminal for session resource \\\`\${e}\\\`\`);` +
        `return this._terminalToolCreator.refreshShellIntegrationQuality(u),` +
        `this._terminalChatService.registerTerminalInstanceWithToolSession(o,u.instance),` +
        `this._backgroundNotifications.deleteAndDispose(u.instance.instanceId),u}}` +
        `else if(u.instance.exitCode!==void 0)` +
        `this._logService.info(\`RunInTerminalTool: Cached terminal shell has exited (code=\${u.instance.exitCode}), creating a new terminal\`),` +
        `this._sessionTerminalAssociations.delete(e);` +
        `else return this._logService.debug(\`RunInTerminalTool: Using cached terminal with session resource \\\`\${e}\\\`\`),` +
        `this._terminalToolCreator.refreshShellIntegrationQuality(u),` +
        `this._terminalChatService.registerTerminalInstanceWithToolSession(o,u.instance),` +
        `this._backgroundNotifications.deleteAndDispose(u.instance.instanceId),u}}`;

function sha256(filePath: string): string {
        return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function workbenchBundlePathFromAppRoot(appRoot: string): string {
        return path.join(appRoot, "out", "vs", "workbench", "workbench.desktop.main.js");
}

export interface WorkbenchTerminalPatchTarget {
        bundlePath: string;
}

/** Locates the workbench bundle of the installed VS Code. */
export function findWorkbenchBundle(explicitRoot?: string): WorkbenchTerminalPatchTarget {
        if (explicitRoot) {
                const directPath = workbenchBundlePathFromAppRoot(explicitRoot);
                if (fs.existsSync(directPath)) {
                        return { bundlePath: directPath };
                }
        }
        throw new Error(
                `Could not locate the VS Code workbench bundle (tried ${explicitRoot ?? "<no app root>"})`
        );
}

/** Applies the idle background terminal reuse branch to the bundle source. */
export function patchWorkbenchTerminalBundle(source: string): string {
        if (source.includes(WORKBENCH_TERMINAL_PATCH_MARKER)) {
                return source;
        }
        const occurrences = source.split(INIT_TERMINAL_PATTERN).length - 1;
        if (occurrences !== 1) {
                throw new Error(
                        `workbench terminal patch: expected 1 initTerminal pattern occurrence, found ${occurrences}`
                );
        }
        return source.replace(INIT_TERMINAL_PATTERN, INIT_TERMINAL_PATCHED);
}

export interface WorkbenchTerminalPatchStatus {
        bundlePath: string;
        applied: boolean;
        backupExists: boolean;
        backupPath: string;
        metadataPath: string;
        sha256: string;
}

export interface WorkbenchTerminalPatchResult {
        changed: boolean;
        status: WorkbenchTerminalPatchStatus;
        message: string;
}

export function getWorkbenchTerminalPatchStatus(bundlePath: string): WorkbenchTerminalPatchStatus {
        const backupPath = bundlePath + ".llama-vscode-chat.bak";
        const metadataPath = bundlePath + ".llama-vscode-chat.workbench-terminal.json";
        const source = fs.readFileSync(bundlePath, "utf8");
        const applied = source.includes(WORKBENCH_TERMINAL_PATCH_MARKER);
        return {
                bundlePath,
                applied,
                backupExists: fs.existsSync(backupPath),
                backupPath,
                metadataPath,
                sha256: sha256(bundlePath),
        };
}

/** Applies the patch to the installed bundle, backing up the original once. */
export function applyWorkbenchTerminalPatch(bundlePath: string): WorkbenchTerminalPatchResult {
        const status = getWorkbenchTerminalPatchStatus(bundlePath);
        if (status.applied) {
                return {
                        changed: false,
                        status,
                        message: "Workbench terminal reuse patch is already applied.",
                };
        }
        if (!status.backupExists) {
                fs.copyFileSync(bundlePath, status.backupPath);
        }
        const source = fs.readFileSync(bundlePath, "utf8");
        const patched = patchWorkbenchTerminalBundle(source);
        fs.writeFileSync(bundlePath, patched);
        const after = getWorkbenchTerminalPatchStatus(bundlePath);
        return {
                changed: true,
                status: after,
                message:
                        "Applied the workbench terminal reuse patch. Restart VS Code windows to load the patched bundle.",
        };
}

/** Restores the original bundle from the backup and removes the metadata. */
export function restoreWorkbenchTerminalPatch(bundlePath: string): WorkbenchTerminalPatchResult {
        const status = getWorkbenchTerminalPatchStatus(bundlePath);
        if (!status.backupExists) {
                return {
                        changed: false,
                        status,
                        message: "No workbench terminal patch backup exists; nothing to restore.",
                };
        }
        fs.copyFileSync(status.backupPath, bundlePath);
        if (fs.existsSync(status.metadataPath)) {
                fs.unlinkSync(status.metadataPath);
        }
        const after = getWorkbenchTerminalPatchStatus(bundlePath);
        return {
                changed: true,
                status: after,
                message: "Restored the original workbench bundle. Restart VS Code windows to load it.",
        };
}
