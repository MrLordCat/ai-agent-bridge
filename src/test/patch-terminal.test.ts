import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { quotePosixArgument } from "../patch-elevation";
import { PatchTerminalSession, type PatchTerminalHost } from "../patch-terminal";

class TerminalHost implements PatchTerminalHost, vscode.Disposable {
	readonly change = new vscode.EventEmitter<vscode.TerminalShellIntegrationChangeEvent>();
	readonly end = new vscode.EventEmitter<vscode.TerminalShellExecutionEndEvent>();
	readonly close = new vscode.EventEmitter<vscode.Terminal>();
	readonly onDidChangeTerminalShellIntegration = this.change.event;
	readonly onDidEndTerminalShellExecution = this.end.event;
	readonly onDidCloseTerminal = this.close.event;
	readonly calls: string[] = [];
	readonly executions: vscode.TerminalShellExecution[] = [];
	readonly rawInput: string[] = [];
	readonly integration = {
		executeCommand: (command: string) => {
			this.calls.push(command);
			const execution = { commandLine: { value: "su", confidence: 1, isTrusted: false } } as vscode.TerminalShellExecution;
			this.executions.push(execution);
			return execution;
		},
	} as vscode.TerminalShellIntegration;
	readonly terminal = {
		name: "Patch test", show: () => {},
		sendText: (text: string) => { this.rawInput.push(text); },
		dispose: () => { this.close.fire(this.terminal); },
	} as unknown as vscode.Terminal;

	createTerminal(): vscode.Terminal { return this.terminal; }
	enableIntegration(): void {
		Object.assign(this.terminal, { shellIntegration: this.integration });
		this.change.fire({ terminal: this.terminal, shellIntegration: this.integration });
	}
	complete(index: number, exitCode: number): void {
		this.end.fire({ terminal: this.terminal, execution: this.executions[index], shellIntegration: this.integration, exitCode });
	}
	dispose(): void { this.change.dispose(); this.end.dispose(); this.close.dispose(); }
}

suite("Patch terminal authorization", () => {
	let host: TerminalHost, session: PatchTerminalSession;
	let cleanups: number, successes: number, releases: number, failures: Error[];
	setup(() => {
		host = new TerminalHost();
		cleanups = 0; successes = 0; releases = 0; failures = [];
		session = new PatchTerminalSession({
			command: "su - root -c 'patch-runner'",
			cleanup: () => { cleanups++; }, onClosed: () => { releases++; },
			onSuccess: () => { successes++; }, onFailure: error => { failures.push(error); },
		}, host, 25);
	});
	teardown(() => { session.dispose(); host.dispose(); });

	test("retains a failed attempt and retries in the same terminal before releasing it on success", async () => {
		host.enableIntegration(); await session.run();
		host.complete(0, 1);
		assert.ok(session.canRetry);
		assert.strictEqual(cleanups, 0); assert.strictEqual(releases, 0);
		await session.run();
		assert.strictEqual(session.terminal, host.terminal);
		assert.strictEqual(host.calls.length, 2);
		host.complete(1, 0);
		assert.strictEqual(successes, 1); assert.strictEqual(cleanups, 1); assert.strictEqual(releases, 1);
		assert.ok(session.isClosed);
		session.dispose(); assert.strictEqual(cleanups, 1);
	});

	test("waits for shell integration and ignores another run while preparing", async () => {
		const first = session.run(); await session.run();
		assert.strictEqual(host.calls.length, 0); assert.strictEqual(host.rawInput.length, 0);
		host.enableIntegration(); await first;
		assert.strictEqual(host.calls.length, 1);
		host.complete(0, 0); assert.strictEqual(successes, 1);
	});

	test("does not duplicate a running command or mistake an old completion for the retried command", async () => {
		host.enableIntegration(); await session.run(); await session.run();
		assert.strictEqual(host.calls.length, 1);
		host.complete(0, 1); await session.run();
		host.complete(0, 0);
		assert.strictEqual(successes, 0); assert.strictEqual(cleanups, 0); assert.ok(!session.canRetry);
		host.complete(1, 0); assert.strictEqual(successes, 1);
	});

	test("keeps an integration timeout retryable and sends no raw input before readiness", async () => {
		await session.run();
		assert.match(failures[0].message, /No command was sent/);
		assert.ok(session.canRetry); assert.strictEqual(cleanups, 0);
		assert.strictEqual(host.rawInput.length, 0); assert.strictEqual(host.calls.length, 0);
		host.enableIntegration(); await session.run();
		host.complete(0, 0); assert.strictEqual(successes, 1);
	});

	test("closing the terminal while waiting cancels the wait and releases the attempt", async () => {
		const running = session.run(); host.terminal.dispose(); await running;
		assert.ok(session.isClosed); assert.strictEqual(cleanups, 1); assert.strictEqual(releases, 1);
		host.enableIntegration(); await session.run();
		assert.strictEqual(host.calls.length, 0); assert.strictEqual(failures.length, 0);
	});

	test("closing a failed attempt releases its retained runner exactly once", async () => {
		host.enableIntegration(); await session.run(); host.complete(0, 1);
		assert.strictEqual(cleanups, 0);
		session.dispose(); session.dispose();
		assert.strictEqual(cleanups, 1); assert.strictEqual(releases, 1);
		assert.ok(session.isClosed); assert.strictEqual(successes, 0);
	});
});

suite("Patch authorization real Linux terminal", () => {
	test("observes a failed bash command and retries successfully in the same shell", async function () {
		if (process.platform !== "linux") { this.skip(); return; }
		this.timeout(45_000);
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-patch-retry-"));
		const script = path.join(directory, "attempt.cjs"), flag = path.join(directory, "failed");
		fs.writeFileSync(script, "const fs=require('node:fs');const p=process.argv[2];if(!fs.existsSync(p)){fs.writeFileSync(p,'failed');process.exit(1)}");
		let failure!: (error: Error) => void, success!: () => void;
		const failed = new Promise<Error>(resolve => { failure = resolve; });
		const succeeded = new Promise<void>(resolve => { success = resolve; });
		let cleanups = 0;
		const session = new PatchTerminalSession({
			command: "/usr/bin/env ELECTRON_RUN_AS_NODE=1 " + [process.execPath, script, flag].map(quotePosixArgument).join(" "),
			cleanup: () => { cleanups++; fs.rmSync(directory, { recursive: true, force: true }); },
			onClosed: () => {}, onFailure: error => { failure(error); }, onSuccess: success,
		});
		try {
			await session.run();
			const error = await failed;
			assert.match(error.message, /code 1/);
			assert.ok(session.canRetry); assert.ok(fs.existsSync(script)); assert.strictEqual(cleanups, 0);
			const pid = await session.terminal.processId;
			assert.ok(pid);
			await session.run(); await succeeded;
			assert.strictEqual(await session.terminal.processId, pid);
			assert.strictEqual(cleanups, 1); assert.ok(session.isClosed);
		} finally {
			session.dispose(); session.terminal.dispose();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
