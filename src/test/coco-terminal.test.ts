import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { CocoTerminalManager, type CocoTerminalHost } from "../coco/terminal-manager";
import { COCO_TERMINAL_TOOLS, selectCocoChatTools } from "../coco/terminal-tools";
import { CocoTurnBridge } from "../coco/turn-bridge";

class TerminalHost implements CocoTerminalHost, vscode.Disposable {
	readonly change = new vscode.EventEmitter<vscode.TerminalShellIntegrationChangeEvent>();
	readonly start = new vscode.EventEmitter<vscode.TerminalShellExecutionStartEvent>();
	readonly end = new vscode.EventEmitter<vscode.TerminalShellExecutionEndEvent>();
	readonly closed = new vscode.EventEmitter<vscode.Terminal>();
	readonly onDidChangeTerminalShellIntegration = this.change.event;
	readonly onDidStartTerminalShellExecution = this.start.event;
	readonly onDidEndTerminalShellExecution = this.end.event;
	readonly onDidCloseTerminal = this.closed.event;
	readonly terminals: Array<{ terminal: vscode.Terminal; options: vscode.TerminalOptions; calls: string[]; input: unknown[]; shown: boolean }> = [];
	readonly commands: Array<{ execution: vscode.TerminalShellExecution; terminal: vscode.Terminal; push: (text: string) => void; finish: () => void }> = [];
	integrationEnabled = true;

	createTerminal(options: vscode.TerminalOptions): vscode.Terminal {
		const entry = { terminal: undefined as unknown as vscode.Terminal, options, calls: [] as string[], input: [] as unknown[], shown: false };
		const integration = {
			cwd: typeof options.cwd === "string" ? vscode.Uri.file(options.cwd) : options.cwd,
			executeCommand: (command: string) => {
				entry.calls.push(command);
				const chunks: string[] = [];
				let ended = false, wake: (() => void) | undefined;
				const execution = {
					commandLine: { value: command, confidence: 2, isTrusted: true }, cwd: undefined,
					read: async function* () {
						while (!ended || chunks.length) {
							if (chunks.length) { yield chunks.shift()!; }
							else { await new Promise<void>(resolve => { wake = resolve; }); }
						}
					},
				} as vscode.TerminalShellExecution;
				this.commands.push({
					execution, terminal: entry.terminal,
					push: text => { chunks.push(text); wake?.(); },
					finish: () => { ended = true; wake?.(); },
				});
				this.start.fire({ terminal: entry.terminal, shellIntegration: integration, execution });
				return execution;
			},
		} as vscode.TerminalShellIntegration;
		entry.terminal = {
			name: options.name, shellIntegration: this.integrationEnabled ? integration : undefined,
			show: () => { entry.shown = true; }, sendText: (text: string, newLine: boolean) => entry.input.push({ text, newLine }),
			dispose: () => {
				this.commands.filter(command => command.terminal === entry.terminal).forEach(command => command.finish());
				this.closed.fire(entry.terminal);
			},
		} as unknown as vscode.Terminal;
		this.terminals.push(entry);
		return entry.terminal;
	}

	complete(index: number, exitCode = 0): void {
		const command = this.commands[index];
		command.finish();
		this.end.fire({ terminal: command.terminal, shellIntegration: command.terminal.shellIntegration!, execution: command.execution, exitCode });
	}

	dispose(): void { this.commands.forEach(command => command.finish()); this.change.dispose(); this.start.dispose(); this.end.dispose(); this.closed.dispose(); }
}

suite("Coco interactive terminals", () => {
	let host: TerminalHost, manager: CocoTerminalManager, source: vscode.CancellationTokenSource;
	setup(() => { host = new TerminalHost(); manager = new CocoTerminalManager(host, 20); source = new vscode.CancellationTokenSource(); });
	teardown(() => { manager.dispose(); host.dispose(); source.dispose(); });

	test("automatically reuses an idle shell after a failed command without a terminalId", async () => {
		const pending = manager.run({ command: "first" }, source.token);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.strictEqual(host.terminals[0].options.location, vscode.TerminalLocation.Panel);
		assert.strictEqual(host.terminals[0].shown, true);
		host.commands[0].push("\u001b[32mhello\u001b[0m\r\n"); host.complete(0, 7);
		const first = await pending;
		assert.strictEqual(first.exitCode, 7); assert.match(first.output, /hello/); assert.ok(!first.output.includes(String.fromCharCode(27)));
		const second = manager.run({ command: "second" }, source.token);
		await new Promise<void>(resolve => setImmediate(resolve));
		host.commands[1].push("second output"); host.complete(1);
		const secondResult = await second;
		assert.strictEqual(secondResult.output, "second output");
		assert.strictEqual(secondResult.terminalId, first.terminalId);
		assert.strictEqual(host.terminals.length, 1); assert.deepStrictEqual(host.terminals[0].calls, ["first", "second"]);
	});

	test("creates a separate shell only when explicitly requested and rejects conflicting selection", async () => {
		const firstCall = manager.run({ command: "first" }, source.token);
		await new Promise<void>(resolve => setImmediate(resolve)); host.complete(0);
		const first = await firstCall;
		const secondCall = manager.run({ command: "separate", newTerminal: true }, source.token);
		await new Promise<void>(resolve => setImmediate(resolve)); host.complete(1);
		const second = await secondCall;
		assert.notStrictEqual(second.terminalId, first.terminalId);
		await assert.rejects(manager.run({ command: "invalid", terminalId: first.terminalId, newTerminal: true }, source.token), /either terminalId or newTerminal/);
		assert.strictEqual(host.terminals.length, 2);
		const explicit = manager.run({ command: "select first", terminalId: first.terminalId }, source.token);
		await new Promise<void>(resolve => setImmediate(resolve)); host.complete(2); await explicit;
		const automatic = manager.run({ command: "reuse last selected" }, source.token);
		await new Promise<void>(resolve => setImmediate(resolve)); host.complete(3);
		assert.strictEqual((await automatic).terminalId, first.terminalId);
		assert.strictEqual(host.terminals.length, 2);
	});

	test("reserves terminal selection before awaiting shell initialization for concurrent calls", async () => {
		const first = manager.run({ command: "parallel first" }, source.token);
		const second = manager.run({ command: "parallel second" }, source.token);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.strictEqual(host.terminals.length, 2);
		assert.deepStrictEqual(host.terminals[0].calls, ["parallel first"]);
		assert.deepStrictEqual(host.terminals[1].calls, ["parallel second"]);
		host.complete(0); host.complete(1);
		assert.notStrictEqual((await first).terminalId, (await second).terminalId);
	});

	test("reuses a requested directory without changing the cwd of another idle shell", async () => {
		const cwd = path.resolve("coco-test-first");
		const otherCwd = path.resolve("coco-test-other");
		const first = manager.run({ command: "first", cwd }, source.token);
		await new Promise<void>(resolve => setImmediate(resolve)); host.complete(0);
		const firstResult = await first;
		const matching = manager.run({ command: "matching", cwd }, source.token);
		await new Promise<void>(resolve => setImmediate(resolve)); host.complete(1);
		assert.strictEqual((await matching).terminalId, firstResult.terminalId);
		Object.assign(host.terminals[0].terminal.shellIntegration!, { cwd: vscode.Uri.file(otherCwd) });
		const different = manager.run({ command: "must start in requested cwd", cwd }, source.token);
		await new Promise<void>(resolve => setImmediate(resolve)); host.complete(2);
		assert.notStrictEqual((await different).terminalId, firstResult.terminalId);
		assert.strictEqual(host.terminals[1].options.cwd, cwd);
		await assert.rejects(manager.run({ command: "wrong cwd", terminalId: firstResult.terminalId, cwd }, source.token), /cwd does not match/);
		assert.strictEqual(host.terminals.length, 2);
	});

	test("creates a replacement after the user closes the idle terminal", async () => {
		const first = manager.run({ command: "first" }, source.token);
		await new Promise<void>(resolve => setImmediate(resolve)); host.complete(0);
		const firstResult = await first;
		host.terminals[0].terminal.dispose();
		const second = manager.run({ command: "next command" }, source.token);
		await new Promise<void>(resolve => setImmediate(resolve)); host.complete(1);
		assert.notStrictEqual((await second).terminalId, firstResult.terminalId);
		assert.strictEqual(host.terminals.length, 2);
	});

	test("manual terminal closure releases a pending synchronous command without restarting it", async () => {
		const pending = manager.run({ command: "long command" }, source.token);
		await new Promise<void>(resolve => setImmediate(resolve));
		host.terminals[0].terminal.dispose();
		const closed = await pending;
		assert.strictEqual(closed.state, "closed"); assert.deepStrictEqual(host.terminals[0].calls, ["long command"]);
		await assert.rejects(manager.run({ command: "again", terminalId: closed.terminalId }, source.token), /closed/);
	});

	test("timeout retains the running terminal for input, reading and explicit termination", async () => {
		const running = await manager.run({ command: "interactive command", timeoutMs: 0 }, source.token);
		assert.strictEqual(running.state, "running");
		manager.send(running.terminalId, "answer", true);
		assert.deepStrictEqual(host.terminals[0].input, [{ text: "answer", newLine: true }]);
		const reading = manager.read(running.terminalId, 60_000);
		manager.kill(running.terminalId);
		assert.strictEqual((await reading).state, "closed");
		assert.deepStrictEqual(host.terminals[0].calls, ["interactive command"]);
	});

	test("chat cancellation closes its running terminal and rejects the tool wait", async () => {
		const pending = manager.run({ command: "long command" }, source.token);
		await new Promise<void>(resolve => setImmediate(resolve));
		source.cancel();
		await assert.rejects(pending, error => error instanceof vscode.CancellationError);
		assert.deepStrictEqual(host.terminals[0].calls, ["long command"]);
	});

	test("missing shell integration never sends a command or falls back to a hidden shell", async () => {
		host.integrationEnabled = false;
		await assert.rejects(manager.run({ command: "must not run" }, source.token), /shell integration.*No command was sent/);
		assert.deepStrictEqual(host.terminals[0].calls, []);
		assert.deepStrictEqual(host.terminals[0].input, []);
	});

	test("does not interrupt another command or mix concurrent terminal output", async () => {
		const first = await manager.run({ command: "first", timeoutMs: 0 }, source.token);
		await assert.rejects(manager.run({ command: "overwrite", terminalId: first.terminalId }, source.token), /busy/);
		const second = await manager.run({ command: "second", timeoutMs: 0 }, source.token);
		host.commands[0].push("first output"); host.commands[1].push("second output");
		host.complete(0); host.complete(1);
		assert.strictEqual((await manager.read(first.terminalId)).output, "first output");
		assert.strictEqual((await manager.read(second.terminalId)).output, "second output");
		const manual = {} as vscode.TerminalShellExecution;
		host.start.fire({ terminal: host.terminals[0].terminal, shellIntegration: host.terminals[0].terminal.shellIntegration!, execution: manual });
		await assert.rejects(manager.run({ command: "interrupt user", terminalId: first.terminalId }, source.token), /busy/);
		const automatic = await manager.run({ command: "use idle terminal", timeoutMs: 0 }, source.token);
		assert.strictEqual(automatic.terminalId, second.terminalId);
		assert.strictEqual(host.terminals.length, 2, "the user's active shell must be skipped without creating an unnecessary third shell");
	});

	test("bounds noisy output and rejects invalid terminal identifiers", async () => {
		const pending = manager.run({ command: "noisy command" }, source.token);
		await new Promise<void>(resolve => setImmediate(resolve));
		host.commands[0].push("x".repeat(200_000) + "tail"); host.complete(0);
		const snapshot = await pending;
		assert.strictEqual(snapshot.output.length, 12_000); assert.ok(snapshot.truncated); assert.ok(snapshot.output.endsWith("tail"));
		assert.strictEqual((await manager.read(snapshot.terminalId, 0, 100)).output.length, 100);
		await assert.rejects(manager.read("not-my-terminal"), /Unknown Coco terminal/);
	});

	test("keeps extension reference names callable and removes agent-host shell tools from ACP", () => {
		const names = ["powershell", "read_powershell", "write_powershell", "stop_powershell", "list_powershell", "powershell_shutdown",
			"bash", "read_bash", "write_bash", "stop_bash", "list_bash", "bash_shutdown", "cocoRunInTerminal", COCO_TERMINAL_TOOLS.run,
			"cocoReadTerminal", "cocoSendToTerminal", "cocoKillTerminal", "run_in_terminal", "read_file"];
		const tools = names.map(name => ({ name, description: name, inputSchema: { type: "object" } }));
		const selected = selectCocoChatTools(tools);
		assert.deepStrictEqual(selected.map(tool => tool.name), names.slice(12));
		const bridge = new CocoTurnBridge(tools, () => undefined);
		try {
			assert.strictEqual(bridge.clientTools.length, selected.length);
			assert.ok(bridge.clientTools.some(tool => String(tool.description).includes("cocoRunInTerminal")));
			assert.ok(!bridge.clientTools.some(tool => /VS Code Chat tool powershell\./.test(String(tool.description))));
		} finally { bridge.dispose(); }
	});
});

suite("Coco real terminal", () => {
	test("captures a command, accepts input and ends the shell when its terminal is closed", async function () {
		this.timeout(45_000);
		if (process.platform !== "win32") { this.skip(); return; }
		const shellPath = [
			process.env.COCO_TEST_SHELL_PATH,
			path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
			...(process.env.Path ?? process.env.PATH ?? "").split(path.delimiter).map(directory => path.join(directory, "pwsh.exe")),
		].find((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate)));
		if (!shellPath) { this.skip(); return; }
		let terminal!: vscode.Terminal;
		const manager = new CocoTerminalManager({
			createTerminal: options => { terminal = vscode.window.createTerminal({ ...options, shellPath }); return terminal; },
			onDidChangeTerminalShellIntegration: vscode.window.onDidChangeTerminalShellIntegration,
			onDidStartTerminalShellExecution: vscode.window.onDidStartTerminalShellExecution,
			onDidEndTerminalShellExecution: vscode.window.onDidEndTerminalShellExecution,
			onDidCloseTerminal: vscode.window.onDidCloseTerminal,
		});
		const source = new vscode.CancellationTokenSource();
		try {
			const first = await manager.run({ command: "$cocoReuseMarker = 'COCO_STATE'; Write-Output 'COCO_LIVE_FINITE'" }, source.token);
			assert.strictEqual(first.state, "completed"); assert.strictEqual(first.exitCode, 0);
			assert.match(first.output, /COCO_LIVE_FINITE/);
			const pid = await terminal.processId;
			assert.ok(pid, "a real shell process must own the terminal");
			const running = await manager.run({
				mode: "async",
				command: "$cocoReply = Read-Host 'COCO_INPUT_PROMPT'; Write-Output ('COCO_INPUT:' + $cocoReuseMarker + ':' + $cocoReply); Read-Host 'COCO_HOLD_PROMPT'",
			}, source.token);
			assert.strictEqual(running.state, "running");
			assert.strictEqual(running.terminalId, first.terminalId);
			assert.strictEqual(await terminal.processId, pid, "automatic reuse must retain the same shell process");
			manager.send(first.terminalId, "bridge-input", true);
			let output = "";
			for (let i = 0; i < 8; i++) {
				output = (await manager.read(first.terminalId, 1_000)).output;
				if (output.includes("COCO_INPUT:COCO_STATE:bridge-input")) { break; }
			}
			assert.match(output, /COCO_INPUT:COCO_STATE:bridge-input/, "input and preserved variables must reach the reused shell");
			process.kill(pid!, 0); // Verify that querying this live process is permitted before testing its exit.
			const waiting = manager.read(first.terminalId, 60_000);
			terminal.dispose(); // Same public terminal shutdown used by the panel's trash action.
			assert.strictEqual((await waiting).state, "closed");
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => { clearInterval(check); reject(new Error("The terminal shell process did not exit.")); }, 5_000);
				const check = setInterval(() => {
					try { process.kill(pid!, 0); }
					catch (error) {
						clearTimeout(timer); clearInterval(check);
						if ((error as NodeJS.ErrnoException).code === "ESRCH") { resolve(); } else { reject(error); }
					}
				}, 100);
			});
		} finally { manager.dispose(); source.dispose(); }
	});
});