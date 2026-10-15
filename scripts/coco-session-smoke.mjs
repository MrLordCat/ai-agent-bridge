import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout, clearTimeout } from "node:timers";

if (!process.argv.includes("--run")) {
	console.log("Pass --run to make three small real-model requests. Optional: --cli PATH --connection NAME --model ID.");
	process.exit(0);
}
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const extensions = path.join(os.homedir(), ".vscode", "extensions");
const installed = fs.readdirSync(extensions).filter(name => name.startsWith("snowflake.snowflake-vsc-")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
const executable = option("--cli") ?? path.join(extensions, installed ?? "missing-snowflake-extension", "bin", process.platform === "win32" ? "cortex.exe" : "cortex");
const { CocoAcpClient } = createRequire(import.meta.url)("../out/coco/acp-client.js");
const marker = `COCO_CONTINUITY_${randomUUID()}`;
const model = option("--model") ?? "claude-opus-5-5";
let output = "", context, client;
const handlers = {
	onUpdate: update => {
		if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") { output += update.content.text; }
		if (update.sessionUpdate === "usage_update") { context = { used: update.used, size: update.size }; }
	},
	onPermission: async () => undefined,
	onClientTool: async () => { throw new Error("Smoke test must not execute tools"); },
};
const makeClient = () => new CocoAcpClient(executable, process.cwd(), option("--connection"), model, handlers);
const deadline = setTimeout(() => client?.dispose(), 120_000);
async function prompt(session, text, stage) {
	output = ""; context = undefined;
	const result = await client.prompt(session, text);
	assert.equal(result.stopReason, "end_turn");
	assert.ok(result.usage && Number.isSafeInteger(result.usage.inputTokens) && Number.isSafeInteger(result.usage.outputTokens), "CLI must report measured prompt usage");
	console.log(JSON.stringify({ stage, usage: result.usage, context }));
	return output;
}
try {
	client = makeClient();
	const initialized = await client.initialize();
	assert.equal(initialized.agentCapabilities?.loadSession, true);
	const session = await client.newSession(process.cwd());
	await prompt(session.sessionId, `This is a conversation continuity test. Do not use tools. Remember the exact marker ${marker}. Reply only READY.`, "cold");
	assert.ok((await prompt(session.sessionId, "Return the exact marker from my previous message. Do not use tools.", "warm")).includes(marker), "Warm prompt must retain the earlier marker");
	client.dispose();
	client = makeClient();
	await client.initialize();
	await client.loadSession(session.sessionId, process.cwd());
	output = "";
	assert.ok((await prompt(session.sessionId, "Return the same exact marker again. Do not use tools.", "restored")).includes(marker), "Restored prompt must retain the earlier marker");
	console.log("Coco continuity and measured usage: PASS");
} finally { clearTimeout(deadline); client?.dispose(); }