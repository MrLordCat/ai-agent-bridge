import * as assert from "node:assert";
import * as fs from "node:fs";
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
	test("keeps v9 prompt rendering and stored tool output bounded", () => {
		const target = findCopilotBundle(vscode.env.appRoot);
		const original = fs.readFileSync(target.bundlePath, "utf8");
		const patched = patchCopilotBundle(original);
		const originalWorkbench = fs.readFileSync(target.workbenchPath, "utf8");
		const patchedWorkbench = patchVsCodeWorkbenchBundle(originalWorkbench);

		assert.ok(COPILOT_PATCH_ID.endsWith(":v9"));
		assert.ok(patched.includes(COPILOT_PATCH_MARKER));
		assert.ok(!patched.includes(
			'this.endpoint.modelProvider==="llamacpp"?' +
			'this.endpoint.cloneWithTokenOverride(Number.MAX_SAFE_INTEGER)'
		));
		assert.doesNotThrow(() => new Script(patched));
		assert.ok(patchedWorkbench.includes(VSCODE_CHAT_HISTORY_PATCH_MARKER));
		assert.ok(patchedWorkbench.includes("__llamaBoundToolText"));
		assert.ok(patchedWorkbench.includes("__llamaBoundToolPayload"));
	});
});
