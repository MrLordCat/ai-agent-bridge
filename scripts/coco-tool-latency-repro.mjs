import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { setTimeout, clearTimeout } from "node:timers";
const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
if (!args.includes("--run")) {
	console.log("No model requests sent. Use --run --cli PATH --transport sdk|acp [--delay-ms 35000] [--connection NAME]. Only an inert marker callback runs.");
} else {
	const require = createRequire(import.meta.url);
	const { CocoSdkClient } = require("../out/coco/sdk-client.js"), { CocoAcpClient } = require("../out/coco/acp-client.js");
	const transport = value("--transport"), cli = value("--cli");
	const delayMs = args.includes("--delay-ms") ? Number(value("--delay-ms")) : 35000;
	if (!cli || !["sdk", "acp"].includes(transport) || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 120000) { throw new Error("Invalid CLI, transport or delay"); }
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "coco-tool-latency-"));
	const marker = `CALLBACK_${randomUUID()}`;
	let answer = "", calls = 0, callbackMs, started;
	const handlers = {
		onUpdate: update => { if (update.sessionUpdate === "agent_message_chunk") { answer += update.content?.text ?? ""; } },
		onPermission: async () => undefined,
		onClientTool: async name => {
			if (name !== "vscode_chat_probe") { throw new Error("Only the inert diagnostic callback is allowed"); }
			calls++; const began = Date.now(); await delay(delayMs);
			callbackMs = Date.now() - began;
			return { output: marker };
		},
	};
	const Type = transport === "sdk" ? CocoSdkClient : CocoAcpClient;
	const client = new Type(cli, cwd, args.includes("--connection") ? value("--connection") : undefined, "claude-opus-5-5", handlers);
	const deadline = setTimeout(() => client.dispose(), 150000);
	try {
		await client.initialize();
		const { sessionId } = await client.newSession(cwd, [{ name: "vscode_chat_probe", description: "Get the diagnostic marker. No side effects. Wait for its result; never retry it.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }]);
		started = Date.now();
		await client.prompt(sessionId, "Diagnostic only: call vscode_chat_probe exactly once and wait for its result. Return only the exact marker from its result. Do not invent a marker or call another tool. If the callback fails, report the error and stop.");
		const passed = calls === 1 && answer.includes(marker);
		console.log(JSON.stringify({ transport, delayMs, calls, callbackMs, elapsedMs: Date.now()-started, markerReceived: answer.includes(marker), passed }));
		if (!passed) { process.exitCode = 1; }
	} catch (error) {
		console.log(JSON.stringify({ transport, delayMs, calls, callbackMs, elapsedMs: started ? Date.now()-started : undefined, error: error.message })); process.exitCode = 1;
	} finally {
		clearTimeout(deadline); client.dispose(); await client.waitForExit(); await fs.rm(cwd, { recursive: true, force: true });
	}
}