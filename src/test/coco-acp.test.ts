import * as assert from "node:assert";
import { type ChildProcessWithoutNullStreams, type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CocoAcpClient, type CocoAcpHandlers } from "../coco/acp-client";

suite("Coco ACP transport", () => {
	let client: CocoAcpClient;
	let output: PassThrough;
	let child: EventEmitter;
	let writes: Array<Record<string, unknown>>;
	let kills: number;

	function setup(handlers: CocoAcpHandlers = {}): void {
		output = new PassThrough();
		const input = new PassThrough();
		child = new EventEmitter();
		writes = []; kills = 0;
		input.on("data", chunk => writes.push(JSON.parse(chunk.toString())));
		const fake = Object.assign(child, {
			stdin: input, stdout: output, stderr: new PassThrough(),
			kill: () => { kills++; return true; },
		}) as unknown as ChildProcessWithoutNullStreams;
		client = new CocoAcpClient("cortex", process.cwd(), undefined, undefined, handlers,
			(() => fake) as unknown as typeof spawn);
	}
	function receive(message: unknown): void {
		output.write(JSON.stringify(message) + "\n");
	}
	async function flush(): Promise<void> {
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	teardown(() => client?.dispose());

	test("ignores non-object messages and decodes a fragmented reply", async () => {
		setup();
		const pending = client.initialize();
		output.write("null\n[]\nfalse\n7\ninvalid diagnostic line\n");
		output.write('{"jsonrpc":"2.0","id":1,"res');
		output.write('ult":{"agentCapabilities":{"promptCapabilities":{"image":true}}}}\n');
		assert.strictEqual((await pending).agentCapabilities?.promptCapabilities?.image, true);
	});

	test("answers permission and tool requests with string IDs", async () => {
		setup({ onPermission: async () => "allow", onClientTool: async (name, input) => ({ name, input }) });
		receive({ id: "permission", method: "session/request_permission", params: {} });
		receive({ id: "tool", method: "vscode_echo", params: { text: "hello" } });
		await flush();
		assert.deepStrictEqual(writes, [
			{ jsonrpc: "2.0", id: "permission", result: { outcome: { outcome: "selected", optionId: "allow" } } },
			{ jsonrpc: "2.0", id: "tool", result: { name: "vscode_echo", input: { text: "hello" } } },
		]);
	});

	test("cancels a permission request when its handler throws synchronously", async () => {
		setup({ onPermission: () => { throw new Error("failed"); } });
		receive({ id: "permission", method: "session/request_permission", params: {} });
		await flush();
		assert.deepStrictEqual(writes[0], {
			jsonrpc: "2.0", id: "permission", result: { outcome: { outcome: "cancelled" } },
		});
	});

	test("returns a protocol error when a tool handler throws synchronously", async () => {
		setup({ onClientTool: () => { throw new Error("tool failed"); } });
		receive({ id: "tool", method: "vscode_echo", params: {} });
		await flush();
		assert.deepStrictEqual(writes[0], {
			jsonrpc: "2.0", id: "tool", error: { code: -32603, message: "tool failed" },
		});
	});

	test("keeps the final reply after process exit until stdout closes", async () => {
		setup();
		const pending = client.initialize();
		child.emit("exit", 0);
		receive({ id: 1, result: { agentCapabilities: {} } });
		child.emit("close", 0);
		assert.deepStrictEqual(await pending, { agentCapabilities: {} });
	});

	test("rejects outstanding requests when the process closes", async () => {
		setup();
		const rejection = assert.rejects(client.initialize(), /CLI exited.*code 1/);
		child.emit("close", 1);
		await rejection;
	});

	test("terminates an oversized unterminated message", async () => {
		setup();
		const rejection = assert.rejects(client.initialize(), /oversized ACP message/);
		output.write("x".repeat(4_000_001));
		await rejection;
		assert.strictEqual(kills, 1);
	});

	test("terminates the session safely when an update handler throws", async () => {
		setup({ onUpdate: () => { throw new Error("failed"); } });
		const rejection = assert.rejects(client.initialize(), /update handler failed/);
		receive({ method: "session/update", params: { update: { sessionUpdate: "usage_update" } } });
		await rejection;
		assert.strictEqual(kills, 1);
	});
});
