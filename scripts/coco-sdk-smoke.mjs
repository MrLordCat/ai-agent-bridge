import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { setTimeout, clearTimeout } from "node:timers";
import { deflateSync } from "node:zlib";
import { Buffer } from "node:buffer";
const require = createRequire(import.meta.url);
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
if (!args.includes("--run")) {
	console.log("No model requests sent. Use --run --cli <cortex executable> [--connection name] [--model id] after compilation to verify tool, warm and restored turns.");
} else {
	const { CocoSdkClient } = require("../out/coco/sdk-client.js");
	const cli = args.includes("--cli") ? option("--cli") : undefined;
	if (!cli) { throw new Error("--cli is required"); }
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "coco-sdk-smoke-"));
	const marker = `COCO_NATIVE_${randomUUID()}`, clients = [], reports = [];
	let answer = "", calls = 0, nativeId;
	const make = () => {
		const client = new CocoSdkClient(cli, cwd, args.includes("--connection") ? option("--connection") : undefined,
			args.includes("--model") ? option("--model") : "claude-opus-5-5", {
				onUpdate: update => { if (update.sessionUpdate === "agent_message_chunk") { answer += update.content.text; } else if (update.sessionUpdate === "tool_blocked") { console.log(JSON.stringify(update)); } },
				onClientTool: async (name, input, id) => {
					if (name !== "vscode_chat_probe" || !input || typeof input !== "object") { throw new Error("Only the inert probe tool is allowed"); }
					calls++; nativeId = id; return { output: marker };
				},
			}); clients.push(client); return client;
	};
	const timer = setTimeout(() => { for (const client of clients) { client.dispose(); } }, 180_000); timer.unref();
	try {
		const tools = [{ name: "vscode_chat_probe", description: "Obtain the temporary test marker. No side effects.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];
		const first = make(); const id = String((await first.newSession(cwd, tools)).sessionId);
		await first.setSessionConfigOption(id, "thinking", "low");
		for (const [label, client, prompt] of [
			["cold", first, "Call the supplied vscode_chat_probe tool exactly once to obtain its marker. Return only that marker. Use no other tools."],
			["warm", first, "Repeat the marker from the earlier tool result. Return only it. No tools needed."],
		]) {
			answer = ""; const started = Date.now(), result = await client.prompt(id, prompt);
			if (!answer.includes(marker)) { throw new Error(`${label}: marker missing from reply`); }
			reports.push({ label, markerRetained: true, durationMs: Date.now() - started, usage: result.usage });
			console.log(JSON.stringify(reports.at(-1)));
		}
		first.dispose(); await first.waitForExit(); const restored = make(); await restored.loadSession(id, cwd, tools);
		answer = ""; const started = Date.now(), result = await restored.prompt(id, "Repeat the original marker again. Return only it. No tools needed.");
		if (!answer.includes(marker) || calls !== 1) { throw new Error("Restored native history or callback count mismatch"); }
		reports.push({ label: "restored", markerRetained: true, durationMs: Date.now() - started, usage: result.usage });
		if (args.includes("--vision")) {
			const crc = data => { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let i=0;i<8;i++) { crc = (crc>>>1)^((crc&1)?0xedb88320:0); } } return (crc^0xffffffff)>>>0; };
			const chunk = (type,data) => { const name = Buffer.from(type), size = Buffer.alloc(4), sum = Buffer.alloc(4); size.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([name,data]))); return Buffer.concat([size,name,data,sum]); };
			const header = Buffer.alloc(13); header.writeUInt32BE(16,0); header.writeUInt32BE(16,4); header[8]=8; header[9]=6;
			const row = Buffer.concat([Buffer.from([0]),Buffer.from(Array.from({length:16},()=>[255,0,0,255]).flat())]);
			const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(Buffer.concat(Array.from({length:16},()=>row)))),chunk("IEND",Buffer.alloc(0))]);
			answer = ""; await restored.prompt(id,[{type:"text",text:"Name the dominant color of the attached image. Reply with one color word. Use no tools."},{type:"image",data:png.toString("base64"),mimeType:"image/png"}]);
			if (!/\bred\b/i.test(answer)) { throw new Error("SDK image was not recognized"); }
			reports.push({label:"vision",imageRecognized:true});
			answer = ""; await restored.prompt(id,"Repeat the original test marker. Return only it. No tools needed.");
			if (!answer.includes(marker)) { throw new Error("Native history was lost after the image turn"); }
			reports.push({label:"after-vision",markerRetained:true});
		}
		console.log(JSON.stringify({ toolCalls: calls, nativeToolIdObserved: Boolean(nativeId), reports }));
	} catch (error) {
		console.error(`Coco SDK smoke failed: ${error.message}; callbacks=${calls}; reply=${JSON.stringify(answer.slice(0, 800))}`); process.exitCode = 1;
	} finally {
		clearTimeout(timer); clients.forEach(client => client.dispose());
		await Promise.all(clients.map(client => client.waitForExit()));
		await fs.rm(cwd, { recursive: true, force: true });
	}
}