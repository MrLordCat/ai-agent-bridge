import * as vscode from "vscode";

/**
 * Wait for the next terminal command notification.
 *
 * The agent starts a command, calls this tool, and is resumed as soon as VS
 * Code reports that a terminal command finished (shell integration end
 * event). No duration guessing, no output buffering, no command matching:
 * the first notification wins — ANY terminal, ANY command.
 *
 * The result identifies the finished command (command line, terminal name,
 * working directory, exit code, duration) and warns the caller that the
 * notification may belong to a different command than the one it started,
 * so it can verify with get_terminal_output and wait again if needed.
 *
 * The only tuning is an optional safety-net timeout so a missing
 * notification (shell integration off, command already finished, terminal
 * closed) never hangs the agent forever.
 */

export const WAIT_TERMINAL_TOOL_NAME = "llamacpp_wait_for_terminal";
export const WAIT_TERMINAL_DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const WAIT_TERMINAL_MIN_TIMEOUT_MS = 5_000;
export const WAIT_TERMINAL_MAX_TIMEOUT_MS = 2 * 60 * 60_000;

export interface WaitForTerminalInput {
	/** Optional safety net in milliseconds (default 600000 = 10 min). */
	timeoutMs?: number;
}

export function resolveWaitTerminalTimeoutMs(raw: number | undefined): number {
	if (raw === undefined || !Number.isFinite(raw)) {
		return WAIT_TERMINAL_DEFAULT_TIMEOUT_MS;
	}
	return Math.min(WAIT_TERMINAL_MAX_TIMEOUT_MS, Math.max(WAIT_TERMINAL_MIN_TIMEOUT_MS, Math.round(raw)));
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

export interface WaitTerminalResultDetail {
	commandLine: string;
	exitCode: number | undefined;
	/** Runtime of the finished execution (pair start/end), or time since this wait began when the start was missed. */
	elapsedMs: number;
	/** True when elapsedMs is the command's own runtime (start event observed). */
	durationFromStart: boolean;
	terminalName?: string;
	cwd?: string;
	/** vscode.TerminalShellExecutionCommandLineConfidence (0 = Low, 1 = Medium, 2 = High). */
	commandLineConfidence?: number;
}

export function formatWaitTerminalResult(detail: WaitTerminalResultDetail): string {
	const lines = [
		"A terminal command finished.",
		`- Terminal: ${detail.terminalName || "unknown"}`,
		`- Command: ${detail.commandLine || "(unknown)"}`,
		`- Exit code: ${detail.exitCode === undefined ? "unknown" : detail.exitCode}`,
		detail.durationFromStart
			? `- Duration: ${formatDurationMs(detail.elapsedMs)} (measured from the command's start)`
			: `- Duration: ${formatDurationMs(detail.elapsedMs)} (since this wait started)`,
	];
	if (detail.cwd) {
		lines.push(`- Working directory: ${detail.cwd}`);
	}
	const confidence = detail.commandLineConfidence;
	if (confidence !== undefined) {
		const label = confidence <= 0 ? "Low" : confidence === 1 ? "Medium" : "High";
		lines.push(`- Command line confidence: ${label} (reported by shell integration)`);
		if (label !== "High") {
			lines.push(
				"- The reported command may be a FRAGMENT: bash shell integration often reports only the",
				"  first segment of a chain (`cd … && python …` shows as `cd …`). To see the full command",
				"  and its output, use get_terminal_output for the terminal above."
			);
		}
	}
	lines.push(
		"NOTE: this is the FIRST command that finished AFTER this wait started, in ANY terminal.",
		"It is not bound to the command you just started: if another agent, the user, or another terminal",
		"completed a command first, you will see that one.",
		`If the command above is NOT the one you started or looks incomplete, check get_terminal_output for the "${detail.terminalName || "terminal"}" and call this tool again if yours is still running.`,
		"You can continue working."
	);
	return lines.join("\n");
}

export function formatWaitTerminalTimeout(timeoutMs: number, elapsedMs: number): string {
	return [
		`No terminal notification within ${timeoutMs}ms (${formatDurationMs(elapsedMs)}).`,
		"Possible causes: the command already finished before this wait started, shell integration is disabled, or the command is still running.",
		"Check the terminal panel directly and do not retry the wait for a command that already finished.",
	].join("\n");
}

export function formatWaitTerminalClosed(): string {
	return "Terminal closed before any command finished. Check the terminal panel and continue without this wait.";
}

/**
 * Resolves on the next terminal command end notification. Never rejects:
 * timeout and terminal-close branch into actionable messages.
 */
export async function waitForTerminalNotification(
	events: TerminalWaitEvents,
	input: WaitForTerminalInput,
	now: () => number = Date.now
): Promise<string> {
	const timeoutMs = resolveWaitTerminalTimeoutMs(input.timeoutMs);
	const startedAt = now();

	return new Promise<string>(resolve => {
		let settled = false;
		const disposables: Array<{ dispose(): void }> = [];
		// Pair start/end events by execution identity so "Duration" is the real
		// command runtime, not the time this tool happened to wait.
		const startedExecutions = new WeakMap<object, { startedAt: number }>();

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

		disposables.push(
			events.onDidStartTerminalShellExecution(event => {
				startedExecutions.set(event.execution as unknown as object, { startedAt: now() });
			})
		);

		disposables.push(
			events.onDidEndTerminalShellExecution(event => {
				const execution = event.execution as unknown as object;
				const started = startedExecutions.get(execution);
				const elapsedMs = started ? now() - started.startedAt : now() - startedAt;
				const commandLine = event.execution.commandLine.value;
				const cwd = (event.execution as { cwd?: { fsPath?: string } }).cwd?.fsPath;
				settle(
					formatWaitTerminalResult({
						commandLine,
						exitCode: event.exitCode,
						elapsedMs,
						durationFromStart: Boolean(started),
						terminalName: event.terminal.name,
						cwd,
						commandLineConfidence: event.execution.commandLine.confidence,
					})
				);
			})
		);

		disposables.push(
			events.onDidCloseTerminal(() => {
				settle(formatWaitTerminalClosed());
			})
		);

		const timer = setTimeout(() => {
			settle(formatWaitTerminalTimeout(timeoutMs, now() - startedAt));
		}, timeoutMs);
		disposables.push({ dispose: () => clearTimeout(timer) });
	});
}

export function createWaitForTerminalToolDefinition(): vscode.LanguageModelChatTool {
	return {
		name: WAIT_TERMINAL_TOOL_NAME,
		description: "Wait for the next terminal command to finish. Call it right after starting a command instead of sleeping with a guessed duration. It resolves on the FIRST terminal-command-completion notification anywhere (your terminal, another agent's, or one typed manually) — it does NOT track a specific command or terminal. The result names the terminal, command line, exit code and duration, plus the command-line confidence: bash shell integration often reports only the FIRST segment of a chained command (`cd … && python …` is reported as `cd …`), so a short or unexpected 'Command' does not mean your command finished — use get_terminal_output for the reported terminal to see the full command and output, and call this tool again if yours is still running. timeoutMs is only a safety net (default 600000 = 10 min). Do NOT call it for a command that already finished. Requires terminal shell integration to be enabled.",
		inputSchema: {
			type: "object",
			properties: {
				timeoutMs: {
					type: "number",
					minimum: 5000,
					maximum: 7200000,
					description: "Safety net in milliseconds (default 600000 = 10 min).",
				},
			},
			additionalProperties: false,
		},
	};
}

/**
 * Appends the extension's built-in agent tools (wait-for-terminal) to the
 * advertised tool list. Some VS Code hosts do not include newly registered
 * tools in request options until a full restart; the model must still see
 * them, so the provider injects missing built-ins itself (deduped by name).
 */
export function ensureBuiltInTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined
): vscode.LanguageModelChatTool[] {
	const existing = tools ?? [];
	const names = new Set(existing.map(tool => tool.name));
	const missing = [createWaitForTerminalToolDefinition()].filter(tool => !names.has(tool.name));
	return missing.length > 0 ? [...existing, ...missing] : [...existing];
}

export class WaitForTerminalTool implements vscode.LanguageModelTool<WaitForTerminalInput> {
	constructor(private readonly events: TerminalWaitEvents = createDefaultTerminalWaitEvents()) {}

	prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<WaitForTerminalInput>): vscode.PreparedToolInvocation {
		return { invocationMessage: "Waiting for the next terminal command notification" };
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<WaitForTerminalInput>
	): Promise<vscode.LanguageModelToolResult> {
		const text = await waitForTerminalNotification(this.events, options.input);
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
	}
}

export function registerWaitForTerminalTool(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.lm.registerTool(WAIT_TERMINAL_TOOL_NAME, new WaitForTerminalTool())
	);
}

