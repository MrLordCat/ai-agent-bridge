import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
	AGENT_HOST_NON_STREAMING_PATCH_MARKER,
	AGENT_HOST_REASONING_EFFORT_PATCH_MARKER,
	AGENT_HOST_THINKING_PATCH_MARKER,
	applyAgentHostThinkingPatch,
	agentHostBundlePathFromAppRoot,
	findAgentHostBundle,
	getAgentHostThinkingPatchStatus,
	inspectAgentHostPatchSupport,
	patchAgentHostBundle,
	restoreAgentHostThinkingPatch,
} from "../byok/agent-host-thinking-patch";

const SAMPLE_SOURCE = `class X{_refreshByokModels(){this._shutdownPromise||(this._byokModels=this._byokBridgeRegistry.getModels().map(e=>{let t=pP(e.modelIdentifier);return{provider:this.id,id:\`\${e.vendor}/\${e.id}\`,name:e.name??e.id,maxContextWindow:e.maxContextWindowTokens,supportsVision:e.supportsVision??!1,...t&&{_meta:t}}})),this._logService.trace(\`ok\`)}}`;
const PROXY_SOURCE = String.raw`class P{async _handleChatCompletions(e,t,o,i){let s;try{s=JSON.parse("{}")}catch{}let a=k1(i,s);let l=this._bridgeRegistry.getServingConnection();if(!l)return;let d={ac:new AbortController,res:t};o.inFlight.add(d);try{let u=await l.chat(a);if(u.error){this._writeJsonError(t,502,u.error,"api_error");return}t.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache",Connection:"keep-alive"});for(let p of D1(u,a.modelId))t.write(p);t.end()}catch(u){if(!t.headersSent)this._writeJsonError(t,502,"x","api_error")}finally{o.inFlight.delete(d)}}static k1(){}}`;
const K1_SOURCE = `function k1(r,n){let e=typeof n.model=="string"?n.model:"";if(!e)throw new Error("missing model");let o=(Array.isArray(n.messages)?n.messages:[]).map(t=>({role:t.role,content:t.content,toolCalls:t.tool_calls,toolCallId:t.tool_call_id})),i={};return typeof n.temperature=="number"&&(i.temperature=n.temperature),typeof n.top_p=="number"&&(i.top_p=n.top_p),typeof n.max_tokens=="number"&&(i.max_tokens=n.max_tokens),{vendor:r,modelId:e,messages:o,tools:j8(n.tools),modelOptions:Object.keys(i).length?i:void 0}}`;

// Shape verified 2026-09-17 in the VS Code 1.136.1 agent host bundle: the
// thinking-level picker is derived from the provider configurationSchema, the
// proxy answers non-streaming calls with JSON, and the request builder forwards
// reasoningEffort. All three patches must therefore be skipped.
const NATIVE_SOURCE = [
	`class N{_refreshByokModels(){this._byokModels=this._byokBridgeRegistry.getModels().map(o=>{let s=$N(o.modelIdentifier),a=this._createThinkingLevelConfigSchemaProperty(o.supportedReasoningEfforts,o.defaultReasoningEffort,o.id);return{provider:this.id,id:dH(o),name:o.name??o.id,maxContextWindow:o.maxContextWindowTokens,supportsVision:o.supportsVision??!1,...a?{configSchema:{type:"object",properties:{[db]:a}}}:{},...s&&{_meta:s}}})}}`,
	`class P{async _h(e,t,o,i){let u=await l.chat(a);if(u.error){this._writeJsonError(t,502,u.error,"api_error");return}if(s.stream===!0){t.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache",Connection:"keep-alive"});for(let p of RF(u,a.modelId))t.write(p);t.end()}else t.writeHead(200,{"Content-Type":"application/json"}),t.end(IF(u,a.modelId))}}`,
	`function b(r,n){let i={};return typeof n.max_output_tokens=="number"&&(i.max_tokens=n.max_output_tokens),{vendor:r,modelId:e,instructions:n.instructions,input:t,tools:dQ(n.tools),reasoningEffort:n.reasoning?.effort,modelOptions:Object.keys(i).length?i:void 0}}`,
].join("\n");

suite("Agents Bridge — agent-host thinking patch", () => {
	test("patches the BYOK snapshot model with a thinkingLevel configSchema", () => {
		const patched = patchAgentHostBundle(SAMPLE_SOURCE);
		assert.ok(patched.includes(AGENT_HOST_THINKING_PATCH_MARKER), "marker must be present");
		assert.ok(patched.includes("thinkingLevel"), "schema property must be added");
		assert.ok(patched.includes('enum:["low","medium","high","xhigh"]'), "levels enum must be added");
		assert.ok(!patched.includes("_meta:t}}}),this._logService.trace"), "patch must be inserted between _meta and the model object end");
		new Function(patched);
	});

	test("patches the BYOK proxy to answer non-streaming requests with JSON", () => {
		const patched = patchAgentHostBundle(PROXY_SOURCE);
		assert.ok(patched.includes(AGENT_HOST_NON_STREAMING_PATCH_MARKER), "non-streaming marker must be present");
		assert.ok(patched.includes('if(s.stream!==!0)'), "stream branch must be added");
		assert.ok(patched.includes('object:"chat.completion"'), "JSON response must be added");
		assert.ok(patched.includes('Content-Type":"text/event-stream'), "SSE path must remain");
		new Function(patched);
	});

	test("patches the BYOK proxy to forward reasoning_effort", () => {
		const patched = patchAgentHostBundle(K1_SOURCE);
		assert.ok(patched.includes(AGENT_HOST_REASONING_EFFORT_PATCH_MARKER), "reasoning marker must be present");
		assert.ok(patched.includes('typeof n.reasoning_effort=="string"&&(i.reasoningEffort=n.reasoning_effort)'), "reasoning forwarding must be added");
		new Function(patched);
	});

	test("applies all three patch patterns in one pass and is idempotent", () => {
		const combined = PROXY_SOURCE + "\n" + K1_SOURCE + "\n" + SAMPLE_SOURCE;
		const once = patchAgentHostBundle(combined);
		assert.ok(once.includes(AGENT_HOST_THINKING_PATCH_MARKER));
		assert.ok(once.includes(AGENT_HOST_NON_STREAMING_PATCH_MARKER));
		assert.ok(once.includes(AGENT_HOST_REASONING_EFFORT_PATCH_MARKER));
		assert.strictEqual(patchAgentHostBundle(once), once, "second patch must be a no-op");
		new Function(once);
	});

	test("is idempotent and leaves unrelated sources untouched", () => {
		const once = patchAgentHostBundle(SAMPLE_SOURCE);
		assert.strictEqual(patchAgentHostBundle(once), once, "second patch must be a no-op");
		assert.strictEqual(patchAgentHostBundle("class A{}"), "class A{}", "no pattern → unchanged");
	});

	test("detects a VS Code build that provides all three behaviours natively", () => {
		assert.deepStrictEqual(
			inspectAgentHostPatchSupport(NATIVE_SOURCE),
			[
				{ id: "thinking-level", state: "native" },
				{ id: "non-streaming", state: "native" },
				{ id: "reasoning-effort", state: "native" },
			],
			"a 1.136-style bundle must be reported as native, not unsupported",
		);
	});

	test("keeps reporting the older bundle as patchable for backward compatibility", () => {
		const legacy = SAMPLE_SOURCE + "\n" + PROXY_SOURCE + "\n" + K1_SOURCE;
		assert.deepStrictEqual(
			inspectAgentHostPatchSupport(legacy).map(capability => capability.state),
			["patchable", "patchable", "patchable"],
			"builds without the native implementations must still be patched",
		);
	});

	test("skips the patch and creates no backup when the build is native", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-native-"));
		const file = path.join(dir, "agentHostMain.js");
		fs.writeFileSync(file, NATIVE_SOURCE, "utf8");
		try {
			const status = getAgentHostThinkingPatchStatus(file);
			assert.strictEqual(status.applied, false, "no patch marker exists yet");
			assert.strictEqual(status.nativeSupport, true, "nativeSupport must be reported");

			const result = applyAgentHostThinkingPatch(file);
			assert.strictEqual(result.changed, false, "a native build must not be patched");
			assert.match(result.message, /natively/, "the message must explain the native support");
			assert.strictEqual(fs.readFileSync(file, "utf8"), NATIVE_SOURCE, "the bundle must stay untouched");
			assert.ok(!fs.existsSync(file + ".llama-vscode-chat.bak"), "no backup must be created");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("names the unmatched capabilities when the bundle shape is unknown", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-unknown-"));
		const file = path.join(dir, "agentHostMain.js");
		// Only the thinking-level signature is present, so the other two cannot be
		// satisfied: that must remain an explicit error, never a silent skip.
		fs.writeFileSync(file, NATIVE_SOURCE.split("\n")[0], "utf8");
		try {
			assert.strictEqual(getAgentHostThinkingPatchStatus(file).nativeSupport, false);
			assert.throws(
				() => applyAgentHostThinkingPatch(file),
				/unmatched: non-streaming, reasoning-effort/,
				"an unknown shape must name the capabilities it could not satisfy",
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("apply creates a backup and restore brings the original back", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-patch-"));
		const file = path.join(dir, "agentHostMain.js");
		fs.writeFileSync(file, SAMPLE_SOURCE + "\n" + PROXY_SOURCE + "\n" + K1_SOURCE, "utf8");
		try {
			const applied = applyAgentHostThinkingPatch(file);
			assert.strictEqual(applied.changed, true);
			assert.ok(fs.readFileSync(file, "utf8").includes(AGENT_HOST_NON_STREAMING_PATCH_MARKER));
			assert.ok(fs.existsSync(file + ".llama-vscode-chat.bak"), "backup must exist");
			const again = applyAgentHostThinkingPatch(file);
			assert.strictEqual(again.changed, false, "re-apply must be a no-op");
			const restored = restoreAgentHostThinkingPatch(file);
			assert.strictEqual(restored.changed, true);
			assert.strictEqual(fs.readFileSync(file, "utf8"), SAMPLE_SOURCE + "\n" + PROXY_SOURCE + "\n" + K1_SOURCE, "restore must return the original");
			assert.ok(!fs.existsSync(file + ".llama-vscode-chat.bak"), "backup must be removed");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("locates the real VS Code 1.131 agent host bundle and matches its pattern", function () {
		const candidate = agentHostBundlePathFromAppRoot(vscode.env.appRoot);
		if (!fs.existsSync(candidate)) {
			this.skip();
			return;
		}
		const bundle = fs.readFileSync(candidate, "utf8");
		const status = getAgentHostThinkingPatchStatus(candidate);
		const patched = patchAgentHostBundle(bundle);
		if (patched === bundle) {
			// Newer VS Code versions no longer ship the 1.131 BYOK snapshot
			// pattern; the patch patterns are still covered synthetically above.
			this.skip();
			return;
		}
		assert.notStrictEqual(patched, bundle, "the installed 1.131 bundle must contain the BYOK snapshot pattern");
		assert.ok(patched.includes(AGENT_HOST_THINKING_PATCH_MARKER));
		assert.ok(status.backupPath.endsWith(".llama-vscode-chat.bak"));
		void findAgentHostBundle(vscode.env.appRoot);
	});
});