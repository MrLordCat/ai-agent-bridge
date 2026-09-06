import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Script } from "node:vm";
import * as vscode from "vscode";

import {
	COPILOT_GIT_REPOSITORIES_GUARD_PATCH_MARKER,
	COPILOT_PATCH_ID,
	COPILOT_PATCH_MARKER,
	findCopilotBundle,
	patchCopilotGitRepositoriesGuard,
	patchAgentHistoryCap,
	patchCopilotBundle,
	patchExtensionTokenizerCache,
	patchVsCodeWorkbenchBundle,
	VSCODE_CHAT_HISTORY_PATCH_MARKER,
} from "../copilot-patch";

	for (const name of ["t", "n"]) {
		test(`guards the git repositories reactive chain with Array.isArray (${name})`, () => {
			const source = `class X{async init(){let t=await P(this.a);let r=no(this,o=>t.onDidOpenRepository(o),()=>${name}.repositories??[]);await Q(r,o=>o.length>0,void 0),!this.s&&fp(this,r,(o,a)=>{a.add(L())},o=>o.rootUri.toString()).recomputeInitiallyAndOnChange(this.s)}}`;
			const patched = patchCopilotGitRepositoriesGuard(source);
			assert.ok(patched.includes(COPILOT_GIT_REPOSITORIES_GUARD_PATCH_MARKER), "guard marker must be present");
			assert.ok(
				patched.includes(`()=>Array.isArray(${name}.repositories)?${name}.repositories:[]`),
				"Array.isArray guard must be present"
			);
			assert.ok(!patched.includes(`()=>${name}.repositories??[]`), "original unguarded expression must be gone");
			new Function(patched);
			// Idempotent.
			assert.strictEqual(patchCopilotGitRepositoriesGuard(patched), patched);
			// Missing / non-unique pattern must throw with a distinct message.
			assert.throws(
				() => patchCopilotGitRepositoriesGuard("class X{}"),
				/pattern not found/
			);
			assert.throws(
				() => patchCopilotGitRepositoriesGuard(
					"()=>t.repositories??[]()=>n.repositories??[]"
				),
				/pattern not unique/
			);
		});
	}

	suite("agent history cap shapes", () => {
		const SHAPE_060 = `class X{render(t,r,o,a){_=o.userQueryTagName,w=o.ReminderInstructionsClass,E=o.ToolReferencesHintClass;return this.props.enableSummarization?x:y}build(){return{toolCallRounds:this.props.promptContext.toolCallRounds,toolCallResults:this.props.promptContext.toolCallResults,truncateAt:v,enableCacheBreakpoints:!1}}async render(t,r,o,a){if(!this.props.promptContext.tools||!this.props.toolCallRounds?.length)return;let l=this.props.toolCallRounds.flatMap((d,p)=>this.renderOneToolCallRound(d,p,this.props.toolCallRounds.length,s,c,a));}}`;
		const SHAPE_061 = `class X{render(t,r,o,a){x=o.userQueryTagName,k=o.ReminderInstructionsClass,P=o.ToolReferencesHintClass;return this.props.enableSummarization?x:y}build(){return{toolCallRounds:this.props.promptContext.toolCallRounds,toolCallResults:this.props.promptContext.toolCallResults,truncateAt:E,enableCacheBreakpoints:!1}}async render(t,r,o,a){if(!this.props.promptContext.tools||!this.props.toolCallRounds?.length)return;let l=this.props.toolCallRounds.flatMap((d,p)=>this.renderOneToolCallRound(d,p,this.props.toolCallRounds.length,s,c,a));}}`;
		const SHAPE_0641 = `class X{render(t,r,o,a){x=o.userQueryTagName,E=o.ReminderInstructionsClass,I=o.ToolReferencesHintClass;return this.props.enableSummarization?vscpp(vscppf,null,v,vscpp(C8,{flexGrow:1,triggerSummarize:this.props.triggerSummarize,forceSimpleSummary:this.props.forceSimpleSummary,priority:900,promptContext:this.props.promptContext,location:this.props.location,maxToolResultLength:_,endpoint:this.props.endpoint,tools:this.props.promptContext.tools})):y}build(){return{toolCallRounds:this.props.promptContext.toolCallRounds,toolCallResults:this.props.promptContext.toolCallResults,truncateAt:_,enableCacheBreakpoints:!1}}async render(n,r,o,a){if(!this.props.promptContext.tools||!this.props.toolCallRounds?.length)return;let s=this.instantiationService.createChild(new mf([pkt,this.props.promptContext])),c={remaining:NPn},l=this.props.toolCallRounds.flatMap((d,p)=>this.renderOneToolCallRound(d,p,this.props.toolCallRounds.length,s,c,a));}}`;

		test("patches the 0.60.x variable names (_/w/E, truncateAt:v)", () => {
			const patched = patchAgentHistoryCap(SHAPE_060);
			assert.ok(patched.includes("__llamaRounds=this.props.promptContext.toolCallRounds"), "header cap must be added");
			assert.ok(patched.includes("truncateAt:v,enableCacheBreakpoints:!1"), "wiring must keep the original truncateAt variable");
			assert.ok(patched.includes("toolCallRounds:__llamaRounds,toolCallResults:__llamaResults,truncateAt:v"), "wiring must switch to the capped arrays");
			assert.ok(patched.includes("l=__llamaRounds.flatMap"), "element cap wiring must be added");
			new Function(patched);
		});

		test("patches the 0.61.0 variable names (x/k/P, truncateAt:E)", () => {
			const patched = patchAgentHistoryCap(SHAPE_061);
			assert.ok(patched.includes("x=o.userQueryTagName,k=o.ReminderInstructionsClass,P=o.ToolReferencesHintClass"), "original names must be preserved");
			assert.ok(patched.includes("__llamaRounds=this.props.promptContext.toolCallRounds"), "header cap must be added");
			assert.ok(patched.includes("toolCallRounds:__llamaRounds,toolCallResults:__llamaResults,truncateAt:E"), "wiring must keep truncateAt:E");
			assert.ok(!patched.includes("truncateAt:v,enableCacheBreakpoints:!1"), "no stale 0.60 wiring");
			new Function(patched);
		});

		test("patches the 0.64.1 variable names (x/E/I, render(n,r,o,a), truncateAt:_)", () => {
			const patched = patchAgentHistoryCap(SHAPE_0641);
			assert.ok(
				patched.includes("x=o.userQueryTagName,E=o.ReminderInstructionsClass,I=o.ToolReferencesHintClass"),
				"0.64.1 original names must be preserved"
			);
			assert.ok(patched.includes("__llamaRounds=this.props.promptContext.toolCallRounds"), "header cap must be added");
			assert.ok(
				patched.includes("toolCallRounds:__llamaRounds,toolCallResults:__llamaResults,truncateAt:_"),
				"wiring must keep truncateAt:_"
			);
			assert.ok(patched.includes("let __llamaRounds=this.props.toolCallRounds"), "element cap header must be added to async render");
			assert.ok(patched.includes("if(this.promptEndpoint.modelProvider===\"llamacpp\")"), "element cap must be provider-guarded");
			assert.ok(patched.includes("l=__llamaRounds.flatMap"), "element cap wiring must be added");
			assert.ok(!patched.includes("truncateAt:v,enableCacheBreakpoints:!1"), "no stale 0.60 wiring");
			assert.ok(!patched.includes("truncateAt:E,enableCacheBreakpoints:!1"), "no stale 0.61 wiring");
			new Function(patched);
			// Idempotent.
			assert.strictEqual(patchAgentHistoryCap(patched), patched);
		});
	});

suite("Copilot patch", () => {
	test("keeps v16 prompt rendering and stored tool output bounded", function () {
		// GitHub-hosted Windows runners only have the bare VS Code
		// archive (no bundled extensions), so the real-bundle test is
		// skipped when Copilot Chat cannot be located. Local machines
		// fall back to the installed VS Code via where.exe.
		let target;
		try {
			target = findCopilotBundle(vscode.env.appRoot);
		} catch {
			this.skip();
			return;
		}
		const bundleBackup = target.bundlePath + ".llama-vscode-chat.backup";
		const workbenchBackup = target.workbenchPath + ".llama-vscode-chat.backup";
		const original = fs.readFileSync(fs.existsSync(bundleBackup) ? bundleBackup : target.bundlePath, "utf8");
		const patched = patchCopilotBundle(original);
		const originalWorkbench = fs.readFileSync(
			fs.existsSync(workbenchBackup) ? workbenchBackup : target.workbenchPath,
			"utf8"
		);
		const patchedWorkbench = patchVsCodeWorkbenchBundle(originalWorkbench);

		assert.ok(COPILOT_PATCH_ID.endsWith(":v22"));
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
		assert.ok(patched.includes("__llamaLastChatVendor"));
		assert.ok(patched.includes("__llamaLastConversationId"));
		// Copilot 0.64.x passes modelCapabilities/conversationId in the request
		// signature; the patch must keep the upstream bindings and wire them in.
		assert.ok(patched.includes("modelCapabilities:d"), "upstream modelCapabilities binding must be preserved");
		assert.ok(patched.includes("reasoningEffort:d.reasoningEffort"), "reasoningEffort must be injected from modelCapabilities");
		assert.ok(patched.includes("let __llamaConversationId=p??__llamaConversationMetadata(u)"), "conversation id binding must be wired");
		assert.ok(patched.includes("_copilotConversationId:__llamaConversationId"), "llama conversation id must be sent to the model");
		assert.match(patched, /\{debugName:e,messages:n,ignoreStatefulMarker:r,summarizedAtRoundId:o,requestOptions:a,finishedCb:s,location:c,source:l,telemetryProperties:u,modelCapabilities:d,conversationId:p\},m\)\{/, "0.64.1 request signature must be kept intact");
		assert.ok(patched.includes('executeCommand("llamacpp.forceCompactConversation",globalThis.__llamaLastConversationId)'));
		assert.ok(patched.includes('executeCommand("workbench.action.chat.open",{query:"/compact",preserveInput:!0})'));
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
