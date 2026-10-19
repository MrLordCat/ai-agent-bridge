import * as assert from "node:assert";
import * as vscode from "vscode";
import { cocoClientToolName,COCO_SDK_TOOL_PREFIX,validateCocoSdkTools } from "../coco/tool-names";
import { CocoTurnBridge } from "../coco/turn-bridge";

suite("Coco fully qualified tool names",() => {
	test("bounds names including the SDK namespace and preserves hash identity",() => {
		const names = ["configure_python_environment","get_python_environment_details","get_python_executable_details","mcp." + "long_namespace_".repeat(12)];
		for (const name of names) {
			const alias = cocoClientToolName(name);
			assert.ok((COCO_SDK_TOOL_PREFIX + alias).length <= 64); assert.match(alias,/^vscode_chat_[A-Za-z0-9_]+_[a-f0-9]{10}$/);
			assert.strictEqual(alias,cocoClientToolName(name));
		}
		assert.strictEqual((COCO_SDK_TOOL_PREFIX+cocoClientToolName(names[0])).length,64);
	});
	test("keeps colliding normalized stems distinct and accepts short names",() => {
		const names = ["same.namespace_tool","same_namespace.tool","same_namespace_tool","read_file"];
		const aliases = names.map(cocoClientToolName); assert.strictEqual(new Set(aliases).size,names.length);
		validateCocoSdkTools(aliases.map(name => ({name})));
	});
	test("rejects invalid or duplicate fully qualified names before inference",() => {
		for (const tools of [[{name:"vscode_chat_configure_python_environment_cdfb233021"}],[{name:"bad name"}],[{name:""}],[{}],[{name:"duplicate"},{name:"duplicate"}]]) {
			assert.throws(() => validateCocoSdkTools(tools),/No inference was started/);
		}
	});
	test("routes the shortened alias to the original native Chat tool and callback ID",async () => {
		const name = "configure_python_environment", bridge = new CocoTurnBridge([{name,description:"Configure Python",inputSchema:{type:"object"}}],() => undefined);
		const parts: vscode.LanguageModelResponsePart[] = [], source = new vscode.CancellationTokenSource();
		try {
			const alias = String(bridge.clientTools[0].name); assert.strictEqual(alias,cocoClientToolName(name));
			const started = bridge.start(async () => {await bridge.delegate(alias,{fixture:true},"native-boundary-id");},{report:part => parts.push(part)},source.token);
			await started;
			const call = parts.find(part => part instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart;
			assert.strictEqual(call.name,name); assert.deepStrictEqual(call.input,{fixture:true});
			await bridge.resume([new vscode.LanguageModelToolResultPart(call.callId,[new vscode.LanguageModelTextPart("ok")])],{report:() => undefined},source.token);
		} finally {source.cancel();bridge.dispose();source.dispose();}
	});
});