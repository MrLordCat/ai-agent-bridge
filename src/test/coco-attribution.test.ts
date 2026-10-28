import * as assert from "node:assert";
import * as vscode from "vscode";
import { stripCocoAttribution, stripCocoAttributionFromInput } from "../coco/attribution";
import { COCO_CHAT_TOOL_POLICY } from "../coco/tool-policy";
import { CocoTurnBridge } from "../coco/turn-bridge";

const GENERATED = "Generated with [Snowflake CoCo](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code)";
const CO_AUTHOR = "Co-authored-by: Snowflake CoCo <noreply@snowflake.com>";

suite("Coco attribution", () => {
	test("drops attribution -m arguments and keeps the rest of the command", () => {
		const command = `git add -A; git commit -q -m "Follow the Codex window (1.20.3)" -m "Use the default model." -m "${GENERATED}" -m "${CO_AUTHOR}"; git --no-pager log --oneline -1`;
		assert.strictEqual(stripCocoAttribution(command),
			`git add -A; git commit -q -m "Follow the Codex window (1.20.3)" -m "Use the default model."; git --no-pager log --oneline -1`);
		assert.strictEqual(stripCocoAttribution(`git commit --message='${CO_AUTHOR}' --trailer "${CO_AUTHOR}" -m 'Fix'`), `git commit -m 'Fix'`);
	});

	test("drops attribution lines from heredoc messages and pull request bodies", () => {
		const heredoc = `git commit -m "$(cat <<'EOF'\n   Fix the updater.\n\n   ${GENERATED}\n\n   ${CO_AUTHOR}\n   EOF\n   )"`;
		assert.strictEqual(stripCocoAttribution(heredoc), `git commit -m "$(cat <<'EOF'\n   Fix the updater.\n   EOF\n   )"`);
		const body = `## Summary\r\n- Fix\r\n\r\n🤖 ${GENERATED}\r\n`;
		assert.strictEqual(stripCocoAttribution(body), "## Summary\r\n- Fix\r\n");
		const rendered = "Fix\n\n[**Snowflake CoCo**](mailto:noreply@snowflake.com) *(Co-author)*\n\nCo-authored-by: Snowflake CoCo [noreply@snowflake.com](mailto:noreply@snowflake.com)";
		assert.strictEqual(stripCocoAttribution(rendered), "Fix");
		assert.strictEqual(stripCocoAttribution(`${GENERATED}\n\nBody`), "Body");
	});

	test("keeps text that only mentions Snowflake CoCo", () => {
		for (const text of [
			"git grep -n 'Generated with Snowflake CoCo'",
			"The bridge removes Generated with Snowflake CoCo lines from commits.",
			"Snowflake CoCo is the Cortex Code CLI.",
		]) {
			assert.strictEqual(stripCocoAttribution(text), text);
		}
	});

	test("cleans new file content but leaves the text an edit must match", () => {
		const input = { filePath: "NOTES.md", oldString: `Done.\n\n${CO_AUTHOR}`, newString: `Done.\n\n${CO_AUTHOR}`, content: [`a\n${GENERATED}`] };
		assert.deepStrictEqual(stripCocoAttributionFromInput(input), { filePath: "NOTES.md", oldString: input.oldString, newString: "Done.", content: ["a"] });
		const clean = { command: "npm test", nested: { list: [1, "two"] } };
		assert.strictEqual(stripCocoAttributionFromInput(clean), clean, "unchanged input keeps its identity");
	});

	test("the bridge strips attribution before Chat sees the tool call and the policy forbids it", async () => {
		const tool: vscode.LanguageModelChatTool = { name: "run_in_terminal", description: "Run a command.", inputSchema: { type: "object" } };
		const bridge = new CocoTurnBridge([tool], () => undefined);
		const token = new vscode.CancellationTokenSource();
		try {
			const parts: vscode.LanguageModelResponsePart[] = [];
			const segment = bridge.start(() => new Promise(() => undefined), { report: part => parts.push(part) }, token.token);
			void bridge.delegate(String(bridge.clientTools[0].name), { command: `git commit -m "Fix" -m "${CO_AUTHOR}"` });
			await segment;
			const call = parts.find((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart);
			assert.deepStrictEqual(call?.input, { command: `git commit -m "Fix"` });
		} finally { bridge.dispose(); token.dispose(); }
		assert.match(COCO_CHAT_TOOL_POLICY, /Never add Snowflake CoCo attribution/);
	});
});
