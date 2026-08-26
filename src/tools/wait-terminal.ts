import * as vscode from "vscode";

/**
 * Waits until a terminal command finishes instead of sleeping for a guessed
 * duration. Uses VS Code shell integration events
 * (onDidStart/onDidEndTerminalShellExecution), so commands started via the
 * Copilot Chat RunInTerminalTool (or any terminal with shell integration)
 * resolve immediately when they end.
 *
 * Design notes:
 * - `execution.read()` only returns data written AFTER read() was called, so
 *   the output tail is captured by attaching the reader on
 *   onDidStartTerminalShellExecution (when the command matches). If the
 *   command already started before this tool was invoked, no live output is
 *   available — the result still carries command line, exit code and
 *   duration.
 * - Timeout is only a safety net (default 15 min, max 2 h). The whole point
 *   is not to guess the duration; a generous timeout should practically never
 *   fire for a still-running command.
 */

export const WAIT_TERMINAL_TOOL_NAME = "llamacpp_wait_for_terminal";
export const WAIT_TERMINAL_DEFAULT_TIMEOUT_MS = 15 * 60_000;
export const WAIT_TERMINAL_MIN_TIMEOUT_MS = 5_000;
export const WAIT_TERMINAL_MAX_TIMEOUT_MS = 2 * 60 * 60_000;
export const WAIT_TERMINAL_OUTPUT_BUFFER_LIMIT = 16_384;
export const WAIT_TERMINAL_DEFAULT_TAIL_CHARS = 2_000;

export interface WaitForTerminalInput {
	/** Substring of the command line to wait for (case-insensitive), e.g. "npm run build". Omit to wait for the next command that finishes. */
	command?: string;
	/** Maximum wait in milliseconds (default 900000 = 15 min, clamped 5000..7200000). */
	timeoutMs?: number;
	/** Maximum output characters to return (tail, default 2000, max 16384). */
	outputTailChars?: number;
}

export function resolveWaitTerminalTimeoutMs(raw: number | undefined): number {
	if (raw === undefined || !Number.isFinite(raw)) {
		return WAIT_TERMINAL_DEFAULT_TIMEOUT_MS;
	}
	return Math.min(WAIT_TERMINAL_MAX_TIMEOUT_MS, Math.max(WAIT_TERMINAL_MIN_TIMEOUT_MS, Math.round(raw)));
}

export function resolveWaitTerminalTailChars(raw: number | undefined): number {
	if (raw === undefined || !Number.isFinite(raw)) {
		return WAIT_TERMINAL_DEFAULT_TAIL_CHARS;
	}
	return Math.min(WAIT_TERMINAL_OUTPUT_BUFFER_LIMIT, Math.max(0, Math.round(raw)));
}

export function commandLineMatches(command: string | undefined, commandLine: string): boolean {
	const needle = command?.trim().toLowerCase();
	if (!needle) {
		return true;
	}
	return commandLine.toLowerCase().includes(needle);
}

export interface TerminalWaitEvents {
	onDidStartTerminalShellExecution(
		listener: (event: vscode.TerminalShellExecutionStartEvent) => void
	): { dispose(): void };
	onDidEndTerminalShellExecution(
		listener: (event: vscode.TerminalShellExecutionEndEvent) => void
	): { dispose(): void };
	onDidCloseTerminal(listener: (terminal: vscode.Terminal) => void): { dispose(): void };
}

export function createDefaultTerminalWaitEvents(): TerminalWaitEvents {
	return {
		onDidStartTerminalShellExecution: listener => vscode.window.onDidStartTerminalShellExecution(listener),
		onDidEndTerminalShellExecution: listener => vscode.window.onDidEndTerminalShellExecution(listener),
		onDidCloseTerminal: listener => vscode.window.onDidCloseTerminal(listener),
	};
}

interface LiveOutputCapture {
	buffer: string;
	readerAttached: boolean;
}

function appendTail(capture: LiveOutputCapture, chunk: string): void {
	capture.buffer = (capture.buffer + chunk).slice(-WAIT_TERMINAL_OUTPUT_BUFFER_LIMIT);
}

function formatDurationMs(elapsedMs: number): string {
	if (elapsedMs < 1_000) {
		return `${Math.round(elapsedMs)}ms`;
	}
	if (elapsedMs < 60_000) {
		return `${(elapsedMs / 1_000).toFixed(1)}s`;
	}
	const minutes = Math.floor(elapsedMs / 60_000);
	const seconds = Math.round((elapsedMs % 60_000) / 1_000);
	return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;
}

export function formatWaitTerminalResult(value: {
	commandLine: string;
	exitCode: number | undefined;
	startedAt: number;
	endedAt: number;
	cwd?: string;
	output?: string;
	outputTailChars: number;
}): string {
	const lines = [
		"Terminal command finished:",
		`- command: ${value.commandLine}`,
		`- exit code: ${value.exitCode === undefined ? "unknown (shell did not report; treat as failure unless the output looks complete)" : value.exitCode}`,
		`- duration: ${formatDurationMs(Math.max(0, value.endedAt - value.startedAt))}`,
	];
	if (value.cwd) {
		lines.push(`- cwd: ${value.cwd}`);
	}
	if (value.output !== undefined && value.output.length > 0) {
		const clipped = value.output.slice(-value.outputTailChars);
		const omitted = value.output.length - clipped.length;
		lines.push(
			`- output (${value.output.length} chars captured, shown last ${clipped.length}):`
				+ (omitted > 0 ? ` (${omitted} chars omitted)` : "")
				+ `\n${clipped.trimEnd()}`
		);
	} else {
		lines.push(
			"- output: not captured (command started before this wait; check the terminal panel for the full output)"
		);
	}
	return lines.join("\n");
}

export function formatWaitTerminalTimeout(value: {
	timeoutMs: number;
	command?: string;
	elapsedMs: number;
}): string {
	return [
		`Timed out after ${value.timeoutMs}ms (${formatDurationMs(value.elapsedMs)}) waiting for terminal command `
		+ (value.command?.trim() ? `"${value.command.trim()}"` : "(any)")
		+ " to finish.",
		"Causes and next steps:",
		"1. The command may have already finished before this tool was called — its end event already fired and waiting cannot rewind time. Check the terminal output directly and do not call this tool again for a completed command.",
		"2. Shell integration may be unavailable — ensure terminal.integrated.shellIntegration.enabled is true and rerun the command from the terminal panel.",
		"3. The command may still be running — increase timeoutMs and retry, or check the terminal panel.",
	].join("\n");
}

export function formatWaitTerminalClosed(command?: string): string {
	return `Terminal closed before command ${command?.trim() ? `"${command.trim()}"` : "(any)"} finished.`;
}

/**
 * Waits for the terminal shell execution end event, matching the command
 * substring when provided. Resolves/throws are surfaced as a normal tool
 * result string (never rejects) so the model sees an actionable message.
 */
export async function waitForTerminalCompletion(
	events: TerminalWaitEvents,
	input: WaitForTerminalInput,
	now: () => number = Date.now
): Promise<string> {
	const timeoutMs = resolveWaitTerminalTimeoutMs(input.timeoutMs);
	const tailChars = resolveWaitTerminalTailChars(input.outputTailChars);
	const command = input.command?.trim() || undefined;
	const startedAt = now();

	return new Promise<string>(resolve => {
		let settled = false;
		const disposables: Array<{ dispose(): void }> = [];
		const capture: LiveOutputCapture = { buffer: "", readerAttached: false };
		const trackingExecutions = new Set<unknown>();

		const settle = (text: string): void => {
			if (settled) {
				return;
			}
			settled = true;
			for (const disposable of disposables) {
				try {
					disposable.dispose();
				} catch {
					// Ignore dispose failures during settle.
				}
			}
			resolve(text);
		};

		const readExecution = (execution: vscode.TerminalShellExecution): void => {
			if (trackingExecutions.has(execution)) {
				return;
			}
			trackingExecutions.add(execution);
			capture.readerAttached = true;
			void (async () => {
				try {
					for await (const chunk of execution.read()) {
						appendTail(capture, chunk);
					}
				} catch {
					// Stream closed/unavailable — the end event still resolves.
				}
			})();
		};

		disposables.push(
			events.onDidStartTerminalShellExecution(event => {
				if (!commandLineMatches(command, event.execution.commandLine.value)) {
					return;
				}
				// Reading from the start is the only way to capture output:
				// read() misses anything written before it was first called.
				readExecution(event.execution);
			})
		);

		disposables.push(
			events.onDidEndTerminalShellExecution(event => {
				if (!commandLineMatches(command, event.execution.commandLine.value)) {
					return;
				}
				const cwd = event.execution.cwd?.fsPath;
				const output = capture.buffer;
				// If we started reading on a matching start event, the buffer is
				// already set; otherwise a late read cannot recover data.
				const producedOutput = capture.readerAttached ? output : undefined;
				settle(
					formatWaitTerminalResult({
						commandLine: event.execution.commandLine.value,
						exitCode: event.exitCode,
						startedAt,
						endedAt: now(),
						cwd,
						output: producedOutput,
						outputTailChars: tailChars,
					})
				);
			})
		);

		disposables.push(
			events.onDidCloseTerminal(() => {
				settle(formatWaitTerminalClosed(command));
			})
		);

		const timer = setTimeout(() => {
			settle(
				formatWaitTerminalTimeout({
					timeoutMs,
					command,
					elapsedMs: now() - startedAt,
				})
			);
		}, timeoutMs);

		disposables.push({ dispose: () => clearTimeout(timer) });
	});
}

export class WaitForTerminalTool implements vscode.LanguageModelTool<WaitForTerminalInput> {
	constructor(private readonly events: TerminalWaitEvents = createDefaultTerminalWaitEvents()) {}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<WaitForTerminalInput>
	): vscode.PreparedToolInvocation {
		const command = options.input.command?.trim();
		return {
			invocationMessage: command
				? `Waiting for terminal command "${command}" to finish`
				: "Waiting for the next terminal command to finish",
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<WaitForTerminalInput>
	): Promise<vscode.LanguageModelToolResult> {
		const text = await waitForTerminalCompletion(this.events, options.input);
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
	}
}

export function registerWaitForTerminalTool(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.lm.registerTool(WAIT_TERMINAL_TOOL_NAME, new WaitForTerminalTool())
	);
}
