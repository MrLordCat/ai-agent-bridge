import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Script } from "node:vm";
import * as vscode from "vscode";

import {
	COPILOT_PATCH_ID,
	COPILOT_PATCH_MARKER,
	findCopilotBundle,
	patchCopilotBundle,
	patchVsCodeWorkbenchBundle,
	VSCODE_CHAT_HISTORY_PATCH_MARKER,
} from "../copilot-patch";

suite("Copilot patch", () => {
	test("keeps v16 prompt rendering and stored tool output bounded", () => {
		const target = findCopilotBundle(vscode.env.appRoot);
		const bundleBackup = target.bundlePath + ".llama-vscode-chat.backup";
		const workbenchBackup = target.workbenchPath + ".llama-vscode-chat.backup";
		const original = fs.readFileSync(fs.existsSync(bundleBackup) ? bundleBackup : target.bundlePath, "utf8");
		const patched = patchCopilotBundle(original);
		const originalWorkbench = fs.readFileSync(
			fs.existsSync(workbenchBackup) ? workbenchBackup : target.workbenchPath,
			"utf8"
		);
		const patchedWorkbench = patchVsCodeWorkbenchBundle(originalWorkbench);

		assert.ok(COPILOT_PATCH_ID.endsWith(":v16"));
		assert.ok(patched.includes(COPILOT_PATCH_MARKER));
		assert.ok(patched.includes("er._llamaToolsSignature"));
		assert.ok(patched.includes("if(__llamaToolCurrent!==er._llamaToolsSignature)"));
		assert.ok(!patched.includes("er._toolsStable"));
		assert.ok(patched.includes('this.endpoint.modelProvider!=="llamacpp"'));
		assert.match(
			patched,
			/modelProvider==="llamacpp"\|\|[^?]{1,80}\?Number\.MAX_SAFE_INTEGER/
		);
		assert.match(
			patched,
			/promptEndpoint\.modelProvider==="llamacpp"\?this\.promptEndpoint\.modelMaxPromptTokens:Math\.floor/
		);
		assert.ok(!patched.includes(
			'this.endpoint.modelProvider==="llamacpp"?' +
			'this.endpoint.cloneWithTokenOverride(Number.MAX_SAFE_INTEGER)'
		));
		assert.doesNotThrow(() => new Script(patched));
		assert.ok(patchedWorkbench.includes(VSCODE_CHAT_HISTORY_PATCH_MARKER));
		assert.ok(patchedWorkbench.includes("__llamaBoundToolText"));
		assert.ok(patchedWorkbench.includes("__llamaBoundToolPayload"));

		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llama-copilot-patch-test-"));
		const workbenchModule = path.join(tempDir, "workbench.mjs");
		try {
			fs.writeFileSync(workbenchModule, patchedWorkbench);
			assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", workbenchModule]));
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
