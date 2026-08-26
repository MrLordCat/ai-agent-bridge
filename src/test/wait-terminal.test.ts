import * as assert from "assert";

import {
	WAIT_TERMINAL_DEFAULT_TIMEOUT_MS,
	WAIT_TERMINAL_MIN_TIMEOUT_MS,
	WAIT_TERMINAL_MAX_TIMEOUT_MS,
	commandLineMatches,
	formatWaitTerminalClosed,
	formatWaitTerminalResult,
	formatWaitTerminalTimeout,
	resolveWaitTerminalTailChars,
	resolveWaitTerminalTimeoutMs,
	waitForTerminalCompletion,
	type TerminalWaitEvents,
} from "../tools/wait-terminal";

type StartListener = Parameters<TerminalWaitEvents["onDidStartTerminalShellExecution"]>[0];
type EndListener = Parameters<TerminalWaitEvents["onDidEndTerminalShellExecution"]>[0];
type CloseListener = Parameters<TerminalWaitEvents["onDidCloseTerminal"]>[0];

interface FakeWindow {
	startListeners: StartListener[];
	endListeners: EndListener[];
	closeListeners: CloseListener[];
	events: TerminalWaitEvents;
	fireStart(commandLine: string, cwd?: string): void;
	fireEnd(commandLine: string, exitCode: number | undefined, cwd?: string): void;
	fireClose(): void;
}

function createFakeWindow(): FakeWindow {
	const startListeners: StartListener[] = [];
	const endListeners: EndListener[] = [];
	const closeListeners: CloseListener[] = [];
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
	const executeObject = (commandLine: string, cwd?: string) => ({
		commandLine: { value: commandLine, isTrusted: true, confidence: 2 },
		cwd: cwd ? { fsPath: cwd } : undefined,
		read: async function* () {},
	});
	const fireStart = (commandLine: string, cwd?: string): void => {
		for (const listener of [...startListeners]) {
			const execution = executeObject(commandLine, cwd);
			listener({ terminal: {} as never, shellIntegration: {} as never, execution } as never);
		}
	};
	const fireEnd = (commandLine: string, exitCode: number | undefined, cwd?: string): void => {
		for (const listener of [...endListeners]) {
			const execution = executeObject(commandLine, cwd);
			listener({
				terminal: {} as never,
				shellIntegration: {} as never,
				execution,
				exitCode,
			} as never);
		}
	};
	const fireClose = (): void => {
		for (const listener of [...closeListeners]) {
			listener({} as never);
		}
	};
	return {
		startListeners,
		endListeners,
		closeListeners,
		events,
		fireStart,
		fireEnd,
		fireClose,
	};
}

suite("Wait for terminal tool", () => {
	test("matches commands case-insensitively and by substring", () => {
		assert.strictEqual(commandLineMatches(undefined, "npm test"), true);
		assert.strictEqual(commandLineMatches("", "npm test"), true);
		assert.strictEqual(commandLineMatches("npm", "NPM test -- --grep provider"), true);
		assert.strictEqual(commandLineMatches("npm run build", "npm run build"), true);
		assert.strictEqual(commandLineMatches("build", "npm run build"), true);
		assert.strictEqual(commandLineMatches("run build", "npm run build"), true);
		assert.strictEqual(commandLineMatches("missing", "npm test"), false);
	});

	test("clamps timeoutMs and tail chars to safe ranges", () => {
		assert.strictEqual(resolveWaitTerminalTimeoutMs(undefined), WAIT_TERMINAL_DEFAULT_TIMEOUT_MS);
		assert.strictEqual(resolveWaitTerminalTimeoutMs(1), WAIT_TERMINAL_MIN_TIMEOUT_MS);
		assert.strictEqual(resolveWaitTerminalTimeoutMs(10 * 60_000), 10 * 60_000);
		assert.strictEqual(resolveWaitTerminalTimeoutMs(99 * 60 * 60_000), WAIT_TERMINAL_MAX_TIMEOUT_MS);
		assert.strictEqual(resolveWaitTerminalTailChars(undefined), 2_000);
		assert.strictEqual(resolveWaitTerminalTailChars(-1), 0);
		assert.strictEqual(resolveWaitTerminalTailChars(100_000), 16_384);
	});

	test("resolves when the matching command finishes", async () => {
		const win = createFakeWindow();
		const startedAt = Date.parse("2026-08-26T10:00:00Z");
		const promise = waitForTerminalCompletion(
			win.events,
			{ command: "npm test", timeoutMs: 30_000, outputTailChars: 200 },
			() => startedAt
		);
		win.fireStart("npm test -- --grep provider");
		win.fireEnd("npm test -- --grep provider", 0);
		const text = await promise;
		assert.ok(text.includes("Terminal command finished:"), text);
		assert.ok(text.includes("exit code: 0"), text);
		assert.ok(text.includes("npm test -- --grep provider"), text);
		assert.ok(text.includes("output: not captured"), text);
	});

	test("resolves with exit code unknown when the shell does not report it", async () => {
		const win = createFakeWindow();
		const promise = waitForTerminalCompletion(win.events, { command: "build.sh" });
		win.fireEnd("build.sh", undefined);
		const text = await promise;
		assert.ok(text.includes("exit code: unknown"), text);
	});

	test("does not complete on unrelated commands and finishes on timeout", async () => {
		const win = createFakeWindow();
		const promise = waitForTerminalCompletion(win.events, {
			command: "npm run package",
			timeoutMs: 1_000,
		});
		win.fireEnd("npm test", 0);
		await new Promise(resolve => setTimeout(resolve, 1_500));
		const text = await promise;
		assert.ok(text.startsWith("Timed out"), text);
		assert.ok(text.includes("npm run package"), text);
	});

	test("resolves when the terminal closes", async () => {
		const win = createFakeWindow();
		const promise = waitForTerminalCompletion(win.events, { command: "sleep 100" });
		win.fireClose();
		const text = await promise;
		assert.strictEqual(text, formatWaitTerminalClosed("sleep 100"));
	});

	test("formats result with duration and clipped output tail", () => {
		const output = "line\n".repeat(200);
		const text = formatWaitTerminalResult({
			commandLine: "npm test",
			exitCode: 1,
			startedAt: 0,
			endedAt: 65_430,
			output,
			outputTailChars: 20,
		});
		assert.ok(text.includes("exit code: 1"), text);
		assert.ok(text.includes("duration: 1m 5s"), text);
		assert.ok(text.includes("chars captured, shown last 20"), text);
		assert.ok(text.includes("(chars omitted)") || text.includes("chars omitted"), text);
	});

	test("formats actionable timeout text", () => {
		const text = formatWaitTerminalTimeout({
			timeoutMs: 60_000,
			command: "npm test",
			elapsedMs: 60_000,
		});
		assert.ok(text.includes('"npm test"'), text);
		assert.ok(text.includes("already finished"), text);
		assert.ok(text.includes("shellIntegration.enabled"), text);
	});
});
