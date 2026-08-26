import * as vscode from "vscode";

/**
 * Wait for the next terminal command notification.
 *
 * The agent starts a command, calls this tool, and is resumed as soon as VS
 * Code reports that a terminal command finished (shell integration end
 * event). No duration guessing, no output buffering, no command matching:
 * the first notification wins.
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

export function formatWaitTerminalResult(commandLine: string, exitCode: number | undefined, elapsedMs: number): string {
	return [
		`Terminal command finished${commandLine ? ` (${commandLine})` : ""}.`,
		`Exit code: ${exitCode === undefined ? "unknown" : exitCode}.`,
		`Duration: ${formatDurationMs(elapsedMs)}.`,
		"You can continue working.",
	].join("\n");
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
				settle(
					formatWaitTerminalResult(
						event.execution.commandLine.value,
						event.exitCode,
						now() - startedAt
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
		description: "Wait until the next terminal command finishes. Call it right after starting a command instead of sleeping with a guessed duration; the tool returns as soon as a terminal command notification arrives. Returns the command line, exit code and duration. timeoutMs is only a safety net (default 10 min). Do not call this tool for a command that already finished.",
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

