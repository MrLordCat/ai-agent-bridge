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
	onDidEndTerminalShellExecution(
		listener: (event: vscode.TerminalShellExecutionEndEvent) => void
	): { dispose(): void };
	onDidCloseTerminal(listener: (terminal: vscode.Terminal) => void): { dispose(): void };
}

export function createDefaultTerminalWaitEvents(): TerminalWaitEvents {
	return {
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

export function formatWaitTerminalResult(
	commandLine: string,
	exitCode: number | undefined,
	elapsedMs: number,
	terminalName?: string,
	cwd?: string,
	commandLineConfidence?: number
): string {
	const lines = [
		"A terminal command finished.",
		`- Terminal: ${terminalName || "unknown"}`,
		`- Command: ${commandLine || "(unknown)"}`,
		`- Exit code: ${exitCode === undefined ? "unknown" : exitCode}`,
		`- Duration: ${formatDurationMs(elapsedMs)}`,
	];
	if (cwd) {
		lines.push(`- Working directory: ${cwd}`);
	}
	if (commandLineConfidence !== undefined && commandLineConfidence <= 0) {
		lines.push("- Note: command line has low confidence (shell integration) — verify with the terminal panel.");
	}
	lines.push(
		"NOTE: this is the FIRST command that finished AFTER this wait started, in ANY terminal.",
		"It is not bound to the command you just started: if another agent, the user, or another terminal",
		"completed a command first, you will see that one. If the 'Command' above is NOT the command you",
		"started, check get_terminal_output for your terminal and call this tool again if yours is still running.",
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
			events.onDidEndTerminalShellExecution(event => {
				const commandLine = event.execution.commandLine.value;
				const execution = event.execution as { cwd?: { fsPath?: string } };
				settle(
					formatWaitTerminalResult(
						commandLine,
						event.exitCode,
						now() - startedAt,
						event.terminal.name,
						execution.cwd?.fsPath,
						event.execution.commandLine.confidence
					)
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
		description: "Wait for the next terminal command to finish. Call it right after starting a command instead of sleeping with a guessed duration. It resolves on the FIRST terminal-command-completion notification anywhere (your terminal, another agent's, or one typed manually) — it does NOT track a specific command or terminal. The result names the exact command line, terminal name, exit code and duration; if the reported command is NOT the one you started, another command finished first — check get_terminal_output for your terminal and call this tool again if yours is still running. timeoutMs is only a safety net (default 600000 = 10 min). Do NOT call it for a command that already finished, and do NOT expect it to match only your command. Requires terminal shell integration to be enabled.",
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

