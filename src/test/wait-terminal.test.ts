import * as assert from "assert";

import {
	WAIT_TERMINAL_DEFAULT_TIMEOUT_MS,
	WAIT_TERMINAL_MIN_TIMEOUT_MS,
	WAIT_TERMINAL_MAX_TIMEOUT_MS,
	WAIT_TERMINAL_TOOL_NAME,
	ensureBuiltInTools,
	formatWaitTerminalClosed,
	formatWaitTerminalResult,
	formatWaitTerminalTimeout,
	resolveWaitTerminalTimeoutMs,
	waitForTerminalNotification,
	type TerminalWaitEvents,
} from "../tools/wait-terminal";

type StartListener = Parameters<TerminalWaitEvents["onDidStartTerminalShellExecution"]>[0];
type EndListener = Parameters<TerminalWaitEvents["onDidEndTerminalShellExecution"]>[0];
type CloseListener = Parameters<TerminalWaitEvents["onDidCloseTerminal"]>[0];

interface FakeExecution {
	commandLine: { value: string; isTrusted: boolean; confidence: number };
	cwd: { fsPath: string } | undefined;
	read: () => AsyncIterable<string>;
}

interface FakeWindow {
	startListeners: StartListener[];
	endListeners: EndListener[];
	closeListeners: CloseListener[];
	events: TerminalWaitEvents;
	fireStart(commandLine: string, confidence?: number, terminalName?: string): void;
	fireEnd(commandLine: string, exitCode: number | undefined, terminalName?: string, cwd?: string, confidence?: number): void;
	fireClose(): void;
}

function makeExecution(commandLine: string, confidence: number): FakeExecution {
	return {
		commandLine: { value: commandLine, isTrusted: confidence === 2, confidence },
		cwd: undefined,
		read: async function* () {},
	};
}

function createFakeWindow(): FakeWindow {
	const startListeners: StartListener[] = [];
	const endListeners: EndListener[] = [];
	const closeListeners: CloseListener[] = [];
	let lastExecution: FakeExecution | undefined;
	const events: TerminalWaitEvents = {
		onDidStartTerminalShellExecution: listener => {
			startListeners.push(listener);
			return { dispose() {} };
		},
		onDidEndTerminalShellExecution: listener => {
			endListeners.push(listener);
			return { dispose() {} };
		},
		onDidCloseTerminal: listener => {
			closeListeners.push(listener);
			return { dispose() {} };
		},
	};
	const fireStart = (commandLine: string, confidence = 2, terminalName = "bash"): void => {
		lastExecution = makeExecution(commandLine, confidence);
		for (const listener of [...startListeners]) {
			listener({
				terminal: { name: terminalName } as never,
				shellIntegration: {} as never,
				execution: lastExecution as never,
			} as never);
		}
	};
	const fireEnd = (commandLine: string, exitCode: number | undefined, terminalName = "bash", cwd?: string, confidence = 2): void => {
		// VS Code may update the same execution's commandLine at end; recreate
		// when the wait started without a matching start event.
		if (!lastExecution || lastExecution.commandLine.value !== commandLine) {
			lastExecution = makeExecution(commandLine, confidence);
		} else {
			lastExecution.commandLine.value = commandLine;
			lastExecution.commandLine.confidence = confidence;
			lastExecution.commandLine.isTrusted = confidence === 2;
		}
		lastExecution.cwd = cwd ? { fsPath: cwd } : undefined;
		for (const listener of [...endListeners]) {
			listener({
				terminal: { name: terminalName } as never,
				shellIntegration: {} as never,
				execution: lastExecution as never,
				exitCode,
			} as never);
		}
	};
	const fireClose = (): void => {
		for (const listener of [...closeListeners]) {
			listener({} as never);
		}
	};
	return { startListeners, endListeners, closeListeners, events, fireStart, fireEnd, fireClose };
}

suite("Wait for terminal tool", () => {
	test("clamps timeoutMs to safe range", () => {
		assert.strictEqual(resolveWaitTerminalTimeoutMs(undefined), WAIT_TERMINAL_DEFAULT_TIMEOUT_MS);
		assert.strictEqual(resolveWaitTerminalTimeoutMs(1), WAIT_TERMINAL_MIN_TIMEOUT_MS);
		assert.strictEqual(resolveWaitTerminalTimeoutMs(10 * 60_000), 10 * 60_000);
		assert.strictEqual(resolveWaitTerminalTimeoutMs(99 * 60 * 60_000), WAIT_TERMINAL_MAX_TIMEOUT_MS);
	});

	test("resolves on the first terminal notification with exit code and duration", async () => {
		const win = createFakeWindow();
		const startedAt = Date.parse("2026-08-26T10:00:00Z");
		const promise = waitForTerminalNotification(win.events, {}, () => startedAt);
		win.fireEnd("npm test", 0, "bash", "D:/GitHub/llama-vscode-chat");
		const text = await promise;
		assert.ok(text.includes("A terminal command finished."), text);
		assert.ok(text.includes("Command: npm test"), text);
		assert.ok(text.includes("Terminal: bash"), text);
		assert.ok(text.includes("Working directory: D:/GitHub/llama-vscode-chat"), text);
		assert.ok(text.includes("Exit code: 0"), text);
		assert.ok(text.includes("Command line confidence: High"), text);
		assert.ok(text.includes("FIRST command that finished"), text);
		assert.ok(text.includes("You can continue working."), text);
	});

	test("reports the real runtime when the start event was observed", async () => {
		const win = createFakeWindow();
		let now = Date.parse("2026-08-26T10:00:00Z");
		const promise = waitForTerminalNotification(win.events, {}, () => now);
		win.fireStart("cd /d/GitHub/llama.cpp-with-GUI", 2, "python");
		now += 42_000;
		win.fireEnd("cd /d/GitHub/llama.cpp-with-GUI", 0, "python");
		const text = await promise;
		assert.ok(text.includes("Duration: 42.0s (measured from the command's start)"), text);
	});

	test("flags a fragment command line and instructs to check get_terminal_output", async () => {
		const win = createFakeWindow();
		const promise = waitForTerminalNotification(win.events, {});
		// bash integration reports only the first segment of a chain, Medium confidence.
		win.fireEnd("cd /d/GitHub/llama.cpp-with-GUI", 0, "python", undefined, 1);
		const text = await promise;
		assert.ok(text.includes("Command line confidence: Medium"), text);
		assert.ok(text.includes("may be a FRAGMENT"), text);
		assert.ok(text.includes("get_terminal_output"), text);
	});

	test("reports unknown exit code when the shell does not report one", async () => {
		const win = createFakeWindow();
		const promise = waitForTerminalNotification(win.events, {});
		win.fireEnd("build.sh", undefined);
		const text = await promise;
		assert.ok(text.includes("Exit code: unknown"), text);
	});

	test("times out with an actionable message when no notification arrives", async () => {
		const win = createFakeWindow();
		const promise = waitForTerminalNotification(win.events, { timeoutMs: 1_000 });
		await new Promise(resolve => setTimeout(resolve, 1_500));
		const text = await promise;
		assert.ok(text.startsWith("No terminal notification within"), text);
		assert.ok(text.includes("Check the terminal panel"), text);
	});

	test("resolves with terminal-closed message", async () => {
		const win = createFakeWindow();
		const promise = waitForTerminalNotification(win.events, {});
		win.fireClose();
		const text = await promise;
		assert.strictEqual(text, formatWaitTerminalClosed());
	});

	test("formats result and timeout texts", () => {
		const result = formatWaitTerminalResult({
			commandLine: "npm run package",
			exitCode: 1,
			elapsedMs: 65_430,
			durationFromStart: true,
			terminalName: "bash",
			cwd: "D:/repo",
			commandLineConfidence: 2,
		});
		assert.ok(result.includes("Command: npm run package"), result);
		assert.ok(result.includes("Terminal: bash"), result);
		assert.ok(result.includes("Exit code: 1"), result);
		assert.ok(result.includes("Duration: 1m 5s (measured from the command's start)"), result);
		assert.ok(result.includes("FIRST command that finished"), result);

		const timeout = formatWaitTerminalTimeout(60_000, 60_000);
		assert.ok(timeout.includes("No terminal notification within 60000ms"), timeout);
	});

	test("injects the built-in tool when the host does not advertise it", () => {
		// Host does not know about the new tool yet (e.g. right after update).
		const tools = ensureBuiltInTools([{ name: "read_file", description: "", inputSchema: {} }]);
		assert.strictEqual(tools.length, 2);
		assert.ok(tools.some(tool => tool.name === WAIT_TERMINAL_TOOL_NAME));
		assert.strictEqual(tools[1].name, WAIT_TERMINAL_TOOL_NAME);
		assert.ok(tools[1].description.includes("Wait for the next terminal command to finish"));
		assert.ok(tools[1].description.includes("does NOT track a specific command"), tools[1].description);

		// Deduped when the host already advertises it.
		const withHost = ensureBuiltInTools([
			{ name: "read_file", description: "", inputSchema: {} },
			{ name: WAIT_TERMINAL_TOOL_NAME, description: "host version", inputSchema: {} },
		]);
		assert.strictEqual(withHost.length, 2);
		assert.strictEqual(withHost[1].description, "host version");
	});
});

