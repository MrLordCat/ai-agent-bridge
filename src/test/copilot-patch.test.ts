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
	patchExtensionTokenizerCache,
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

		assert.ok(COPILOT_PATCH_ID.endsWith(":v21"));
		assert.ok(patched.includes(COPILOT_PATCH_MARKER));
		// The tokenizer memoisation cache lives on the class constructor
		// (module-scoped, outlives instances), so it is referenced as
		// `__llamaT.__llamaTokenCache` where __llamaT = this.constructor.
		assert.ok(patched.includes("__llamaTokenCache"));
		assert.ok(patched.includes("__llamaTokenHash"));
		assert.ok(patched.includes("__llamaRounds"));
		assert.ok(patched.includes("__llamaAgentHistoryRounds"));
		assert.ok(patched.includes("this._llamaFullTools"));
		assert.ok(patched.includes("subAgentInvocationId&&Array.isArray(this._llamaFullTools)"));
		assert.ok(patched.includes("__llamaAgentHistoryTurns"));
		assert.ok(patched.includes("__llamaTurnCap"));
		assert.ok(patched.includes("let __llamaRounds=this.props.toolCallRounds"));
		assert.ok(!patched.includes("async _textTokenLength(e){return e?this.languageModel.countTokens(e):0}"));
		assert.ok(patched.includes("this._llamaToolsSignature"));
		assert.ok(patched.includes("if(__llamaToolCurrent!==this._llamaToolsSignature)"));
		assert.ok(!patched.includes("er._llamaToolsSignature"));
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
		assert.ok(patchedWorkbench.includes("replace(/\\x1b\\[[\\d;]*R/g"));
		assert.ok(!patchedWorkbench.includes("vscode-chat-history-bounds:v1 */"));

		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llama-copilot-patch-test-"));
		const workbenchModule = path.join(tempDir, "workbench.mjs");
		try {
			fs.writeFileSync(workbenchModule, patchedWorkbench);
			assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", workbenchModule]));
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("memoises extension model token counts across tokenizer instances", async () => {
		const synthetic =
			"function toRawMessages(list){return list}function breakpointsFor(){return false}const BASE=3;" +
			"var Tokenizer=class{constructor(languageModel){this.languageModel=languageModel}" +
			"async _textTokenLength(e){return e?this.languageModel.countTokens(e):0}" +
			"async countMessageTokens(e){let t=toRawMessages([e],{emitCacheBreakpoints:breakpointsFor(this.languageModel.vendor)});" +
			"if(t.length===0)return 0;let r=await this.languageModel.countTokens(t[0]);return BASE+r}};" +
			"globalThis.__test={Tokenizer};";
		const context: Record<string, unknown> = { console };
		context.globalThis = context;
		new Script(patchExtensionTokenizerCache(synthetic)).runInNewContext(context);
		const { Tokenizer } = context.__test as { Tokenizer: new (model: unknown) => {
			_textTokenLength(text: string): Promise<number>;
			countMessageTokens(message: unknown): Promise<number>;
		} };

		let upstreamCalls = 0;
		const languageModel = {
			vendor: "llamacpp",
			id: "deepseek::deepseek-v4-flash",
			async countTokens(value: unknown) {
				upstreamCalls += 1;
				return typeof value === "string" ? value.length : 42;
			},
		};

		for (let i = 0; i < 5; i++) {
			const tokenizer = new Tokenizer(languageModel);
			assert.strictEqual(await tokenizer._textTokenLength("description"), "description".length);
			await tokenizer._textTokenLength("a".repeat(500));
			assert.strictEqual(await tokenizer.countMessageTokens({ role: "user", content: "hello" }), 45);
		}
		assert.strictEqual(upstreamCalls, 3);

		const builtIn = new Tokenizer({ ...languageModel, vendor: "copilot" });
		await builtIn._textTokenLength("description");
		assert.strictEqual(upstreamCalls, 4);
	});
});
