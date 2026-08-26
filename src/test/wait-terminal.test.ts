import * as assert from "assert";

import {
	WAIT_TERMINAL_DEFAULT_TIMEOUT_MS,
	WAIT_TERMINAL_MIN_TIMEOUT_MS,
	WAIT_TERMINAL_MAX_TIMEOUT_MS,
	formatWaitTerminalClosed,
	formatWaitTerminalResult,
	formatWaitTerminalTimeout,
	resolveWaitTerminalTimeoutMs,
	waitForTerminalNotification,
	type TerminalWaitEvents,
} from "../tools/wait-terminal";

type EndListener = Parameters<TerminalWaitEvents["onDidEndTerminalShellExecution"]>[0];
type CloseListener = Parameters<TerminalWaitEvents["onDidCloseTerminal"]>[0];

interface FakeWindow {
	endListeners: EndListener[];
	closeListeners: CloseListener[];
	events: TerminalWaitEvents;
	fireEnd(commandLine: string, exitCode: number | undefined): void;
	fireClose(): void;
}

function createFakeWindow(): FakeWindow {
	const endListeners: EndListener[] = [];
	const closeListeners: CloseListener[] = [];
	const events: TerminalWaitEvents = {
		onDidEndTerminalShellExecution: listener => {
			endListeners.push(listener);
			return { dispose() {} };
		},
		onDidCloseTerminal: listener => {
			closeListeners.push(listener);
			return { dispose() {} };
		},
	};
	const fireEnd = (commandLine: string, exitCode: number | undefined): void => {
		for (const listener of [...endListeners]) {
			listener({
				terminal: {} as never,
				shellIntegration: {} as never,
				execution: {
					commandLine: { value: commandLine, isTrusted: true, confidence: 2 },
					cwd: undefined,
					read: async function* () {},
				} as never,
				exitCode,
			} as never);
		}
	};
	const fireClose = (): void => {
		for (const listener of [...closeListeners]) {
			listener({} as never);
		}
	};
	return { endListeners, closeListeners, events, fireEnd, fireClose };
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
		win.fireEnd("npm test", 0);
		const text = await promise;
		assert.ok(text.includes("Terminal command finished (npm test)"), text);
		assert.ok(text.includes("Exit code: 0"), text);
		assert.ok(text.includes("You can continue working."), text);
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
		const result = formatWaitTerminalResult("npm run package", 1, 65_430);
		assert.ok(result.includes("Exit code: 1"), result);
		assert.ok(result.includes("Duration: 1m 5s"), result);

		const timeout = formatWaitTerminalTimeout(60_000, 60_000);
		assert.ok(timeout.includes("No terminal notification within 60000ms"), timeout);
	});
});

