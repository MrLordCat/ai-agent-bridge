import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as vscode from "vscode";

export interface CocoTerminalHost {
	createTerminal(options: vscode.TerminalOptions): vscode.Terminal;
	onDidChangeTerminalShellIntegration: vscode.Event<vscode.TerminalShellIntegrationChangeEvent>;
	onDidStartTerminalShellExecution: vscode.Event<vscode.TerminalShellExecutionStartEvent>;
	onDidEndTerminalShellExecution: vscode.Event<vscode.TerminalShellExecutionEndEvent>;
	onDidCloseTerminal: vscode.Event<vscode.Terminal>;
}

interface Command {
	execution: vscode.TerminalShellExecution;
	output: string;
	truncated: boolean;
	state: "running" | "completed" | "closed";
	exitCode?: number;
	done: Promise<void>;
	finish: () => void;
	drain: Promise<void>;
	outputError?: string;
}

interface Session {
	id: string;
	terminal: vscode.Terminal;
	closed: boolean;
	starting: boolean;
	busy?: vscode.TerminalShellExecution;
	command?: Command;
	/** Directory the terminal was created in; used until shell integration reports one. */
	createdCwd?: string;
	/** Directory reported by the last shell execution. */
	lastCwd?: string;
}

export interface CocoTerminalRunInput {
	command: string;
	terminalId?: string;
	newTerminal?: boolean;
	cwd?: string;
	mode?: "sync" | "async";
	timeoutMs?: number;
}

export interface CocoTerminalSnapshot {
	terminalId: string;
	terminalName: string;
	state: "ready" | "running" | "completed" | "closed";
	exitCode?: number;
	output: string;
	truncated: boolean;
	outputError?: string;
}

const OUTPUT_LIMIT = 128_000;
const bounded = (value: number | undefined, fallback: number, max: number): number =>
	Math.min(max, Math.max(0, Number.isFinite(value) ? Math.round(value!) : fallback));

/** Owns real integrated terminals. Closing the tab closes its shell and settles the tool. */
export class CocoTerminalManager implements vscode.Disposable {
	private readonly sessions = new Map<string, Session>();
	private readonly subscriptions: vscode.Disposable[];
	private disposed = false;
	private sequence = 0;

	constructor(
		private readonly host: CocoTerminalHost = vscode.window,
		private readonly integrationTimeoutMs = 20_000,
		private readonly onLog?: (event: string, data: Record<string, unknown>) => void,
	) {
		this.subscriptions = [
			host.onDidStartTerminalShellExecution(event => {
				const session = this.find(event.terminal);
				if (session) {
					session.busy = event.execution;
					if (event.execution.cwd) { session.lastCwd = event.execution.cwd.fsPath; }
				}
			}),
			host.onDidEndTerminalShellExecution(event => {
				const session = this.find(event.terminal);
				if (!session) { return; }
				if (session.busy === event.execution) { session.busy = undefined; }
				const command = session.command;
				if (command?.execution !== event.execution || command.state !== "running") { return; }
				command.state = "completed";
				command.exitCode = event.exitCode;
				// The end event can precede the last output chunk.
				void this.waitFor(command.drain, 200).then(command.finish);
			}),
			host.onDidCloseTerminal(terminal => {
				const session = this.find(terminal);
				if (session) { this.markClosed(session); }
			}),
		];
	}

	async run(input: CocoTerminalRunInput, token: vscode.CancellationToken): Promise<CocoTerminalSnapshot> {
		if (this.disposed) { throw new Error("Coco terminal service is closed."); }
		if (typeof input.command !== "string" || !input.command.trim()) { throw new Error("A non-empty command is required."); }
		if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
		if (input.terminalId && input.newTerminal) { throw new Error("Use either terminalId or newTerminal, not both."); }
		const selection = this.select(input);
		const session = selection.session;
		this.onLog?.("coco.terminal.run", {
			command: input.command.slice(0, 160),
			cwd: input.cwd,
			requestedId: input.terminalId,
			newTerminal: input.newTerminal === true,
			action: selection.created ? "create" : "reuse",
			reason: selection.reason,
			terminalId: session.id,
			terminalName: (session.terminal as { name?: string }).name,
			idleCount: [...this.sessions.values()].filter(candidate => this.isIdle(candidate)).length,
			sessionCwd: this.knownCwd(session),
		});
		if (session.closed) { throw new Error("This terminal was closed. Omit terminalId to select another terminal."); }
		if (session.starting || session.busy || session.command?.state === "running") {
			throw new Error("This terminal is busy. Read its output, or use a new terminal; do not interrupt the user's command.");
		}
		if (input.terminalId && input.cwd && !this.matchesCwd(session, input.cwd)) {
			throw new Error("cwd does not match this terminal's reported directory. Omit cwd to preserve shell state, or omit terminalId to select a terminal in that directory.");
		}
		session.starting = true;
		// Keep selection ordered by last use, including explicitly selected terminals.
		this.sessions.delete(session.id);
		this.sessions.set(session.id, session);
		session.terminal.show(true);
		const cancellation = token.onCancellationRequested(() => this.close(session));
		try {
			const integration = await this.waitForIntegration(session, token);
			if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
			if (session.closed || session.busy) { throw new Error("The terminal was closed or became busy before execution. No command was sent."); }
			// Reusing a terminal that sits in another directory: enter the requested
			// directory first instead of leaving an extra terminal behind.
			if (!input.terminalId && input.cwd && !this.matchesCwd(session, input.cwd)) {
				const entered = await this.enterDirectory(session, integration, input.cwd, token).catch(() => false);
				if (!entered) {
					// The shell refused the change; a terminal created there is the honest option.
					const replacement = this.create(input.cwd);
					this.onLog?.("coco.terminal.run", {
						command: input.command.slice(0, 160), cwd: input.cwd,
						action: "create", reason: "directory-change-failed",
						terminalId: replacement.id, idleCount: [...this.sessions.values()].filter(candidate => this.isIdle(candidate)).length,
					});
					await this.prepareSession(replacement, token);
					const replacementIntegration = replacement.terminal.shellIntegration
						?? await this.waitForIntegration(replacement, token);
					return await this.executeIn(replacement, input, token, replacementIntegration);
				}
			}
			return await this.executeIn(session, input, token, integration);
		} catch (error) {
			// If initialization failed, leave no empty terminal behind. Never replay a command.
			if (!session.command) { this.close(session); }
			if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
			throw error;
		} finally {
			session.starting = false;
			cancellation.dispose();
		}
	}

	/** Shows the terminal and waits until shell integration can execute commands. */
	private async prepareSession(session: Session, token: vscode.CancellationToken): Promise<vscode.TerminalShellIntegration> {
		this.sessions.delete(session.id);
		this.sessions.set(session.id, session);
		session.terminal.show(true);
		return this.waitForIntegration(session, token);
	}

	private async executeIn(
		session: Session,
		input: CocoTerminalRunInput,
		token: vscode.CancellationToken,
		integration: vscode.TerminalShellIntegration,
	): Promise<CocoTerminalSnapshot> {
		if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
		if (session.closed || session.busy) { throw new Error("The terminal was closed or became busy before execution. No command was sent."); }
		const execution = integration.executeCommand(input.command);
		let finish!: () => void;
		const command: Command = {
			execution, output: "", truncated: false, state: "running",
			done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish(), drain: Promise.resolve(),
		};
		session.command = command;
		// Subscribe immediately: read() does not replay earlier terminal output.
		command.drain = this.capture(execution.read(), command);
		const waitMs = input.mode === "async" ? 1_000 : bounded(input.timeoutMs, 120_000, 3_600_000);
		await this.waitFor(command.done, waitMs);
		if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
		return this.snapshot(session);
	}

	/** Runs `cd` in the reused terminal; false when the shell could not enter the directory. */
	private async enterDirectory(
		session: Session,
		integration: vscode.TerminalShellIntegration,
		cwd: string,
		token: vscode.CancellationToken,
	): Promise<boolean> {
		// A double-quoted path works in PowerShell, bash and cmd; characters a
		// shell would expand are refused so a new terminal is used instead.
		if (/["`$]/.test(cwd)) { return false; }
		const command = `cd "${cwd}"`;
		let finish!: () => void;
		const directoryChange: Command = {
			execution: integration.executeCommand(command), output: "", truncated: false, state: "running",
			done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish(), drain: Promise.resolve(),
		};
		session.command = directoryChange;
		directoryChange.drain = this.capture(directoryChange.execution.read(), directoryChange);
		await this.waitFor(directoryChange.done, 10_000, token);
		const entered = directoryChange.state === "completed" && directoryChange.exitCode === 0;
		this.onLog?.("coco.terminal.change_directory", {
			terminalId: session.id, cwd, exitCode: directoryChange.exitCode, state: directoryChange.state, entered,
		});
		return entered && !token.isCancellationRequested;
	}

	async read(terminalId: string, waitMs = 0, maxChars = 12_000, token?: vscode.CancellationToken): Promise<CocoTerminalSnapshot> {
		const session = this.get(terminalId);
		if (token?.isCancellationRequested) { throw new vscode.CancellationError(); }
		if (session.command) {
			await this.waitFor(session.command.done, session.command.state === "running" ? bounded(waitMs, 0, 60_000) : 200, token);
		}
		return this.snapshot(session, bounded(maxChars, 12_000, OUTPUT_LIMIT));
	}

	send(terminalId: string, text: string, addNewLine = true): CocoTerminalSnapshot {
		const session = this.get(terminalId);
		if (session.closed) { throw new Error("This terminal was closed."); }
		if (!session.command || session.command.state !== "running") {
			throw new Error("Use the run tool for a new command. Input is only accepted while a command is running.");
		}
		session.terminal.show(true);
		session.terminal.sendText(text, addNewLine);
		return this.snapshot(session);
	}

	kill(terminalId: string): CocoTerminalSnapshot {
		const session = this.get(terminalId);
		this.close(session);
		return this.snapshot(session);
	}

	dispose(): void {
		this.disposed = true;
		for (const session of this.sessions.values()) { this.close(session); }
		for (const subscription of this.subscriptions) { subscription.dispose(); }
		this.sessions.clear();
	}

	private create(cwd?: string): Session {
		if (this.sessions.size >= 64) {
			for (const [id, session] of this.sessions) {
				if (session.closed) { this.sessions.delete(id); }
				if (this.sessions.size < 64) { break; }
			}
		}
		if ([...this.sessions.values()].filter(session => !session.closed).length >= 32) {
			throw new Error("Close an unused Coco terminal before creating another.");
		}
		const session: Session = {
			id: randomUUID(), closed: false, starting: false,
			createdCwd: cwd,
			terminal: this.host.createTerminal({
				name: `Coco ${++this.sequence}`, cwd: cwd || vscode.workspace.workspaceFolders?.[0]?.uri,
				location: vscode.TerminalLocation.Panel,
			}),
		};
		this.sessions.set(session.id, session);
		return session;
	}

	/**
	 * Picks the terminal for a run. A cwd only forces a new terminal when no idle
	 * one is in that directory: models pass cwd on most calls, and creating a tab
	 * per command left the panel full of terminals.
	 */
	private select(input: CocoTerminalRunInput): { session: Session; created: boolean; reason: string } {
		if (input.terminalId) {
			return { session: this.get(input.terminalId), created: false, reason: "explicit-terminal-id" };
		}
		const idle = [...this.sessions.values()].reverse().filter(candidate => this.isIdle(candidate));
		if (input.newTerminal) {
			return { session: this.create(input.cwd), created: true, reason: "new-terminal-requested" };
		}
		if (!input.cwd) {
			const session = idle[0];
			return session
				? { session, created: false, reason: "idle-terminal" }
				: { session: this.create(undefined), created: true, reason: "no-idle-terminal" };
		}
		const matching = idle.find(candidate => this.matchesCwd(candidate, input.cwd!));
		if (matching) {
			return { session: matching, created: false, reason: "idle-terminal-in-cwd" };
		}
		const reusable = idle[0];
		if (reusable) {
			return { session: reusable, created: false, reason: "idle-terminal-other-cwd" };
		}
		return { session: this.create(input.cwd), created: true, reason: "no-idle-terminal" };
	}

	/** Shell-reported directory, then the last execution's, then the creation directory. */
	private knownCwd(session: Session): string | undefined {
		return session.terminal.shellIntegration?.cwd?.fsPath ?? session.lastCwd ?? session.createdCwd;
	}

	private isIdle(session: Session): boolean {
		return !session.closed && !session.terminal.exitStatus && !session.starting && !session.busy
			&& session.command?.state !== "running";
	}

	private matchesCwd(session: Session, cwd: string): boolean {
		const actual = this.knownCwd(session);
		if (!actual) { return false; }
		const normalize = (directory: string) => {
			const resolved = path.resolve(directory);
			return process.platform === "win32" ? resolved.toLowerCase() : resolved;
		};
		return normalize(actual) === normalize(cwd);
	}

	private get(id: string): Session {
		const session = this.sessions.get(id);
		if (!session) { throw new Error("Unknown Coco terminal ID. Use the ID returned by the run tool."); }
		return session;
	}

	private find(terminal: vscode.Terminal): Session | undefined {
		return [...this.sessions.values()].find(session => session.terminal === terminal);
	}

	private close(session: Session): void {
		if (session.closed) { return; }
		this.markClosed(session);
		session.terminal.dispose();
	}

	private markClosed(session: Session): void {
		session.closed = true;
		session.busy = undefined;
		if (session.command?.state === "running") { session.command.state = "closed"; session.command.finish(); }
	}

	private snapshot(session: Session, maxChars = 12_000): CocoTerminalSnapshot {
		const command = session.command;
		return {
			terminalId: session.id, terminalName: session.terminal.name,
			state: session.closed ? "closed" : command?.state ?? "ready",
			exitCode: command?.exitCode, output: maxChars > 0 ? command?.output.slice(-maxChars) ?? "" : "",
			truncated: Boolean(command?.truncated || (command && command.output.length > maxChars)),
			...(command?.outputError ? { outputError: command.outputError } : {}),
		};
	}

	private async capture(stream: AsyncIterable<string>, command: Command): Promise<void> {
		try {
			for await (const chunk of stream) {
				command.output += stripVTControlCharacters(chunk);
				if (command.output.length > OUTPUT_LIMIT) {
					command.output = command.output.slice(-OUTPUT_LIMIT);
					command.truncated = true;
				}
			}
		} catch {
			command.outputError = "VS Code stopped providing terminal output. Inspect the terminal panel; do not run the command again automatically.";
		}
	}

	private waitForIntegration(session: Session, token: vscode.CancellationToken): Promise<vscode.TerminalShellIntegration> {
		if (session.terminal.shellIntegration) { return Promise.resolve(session.terminal.shellIntegration); }
		return new Promise((resolve, reject) => {
			const subscriptions: vscode.Disposable[] = [];
			const settle = (integration?: vscode.TerminalShellIntegration, error?: Error) => {
				clearTimeout(timer);
				for (const subscription of subscriptions) { subscription.dispose(); }
				if (integration) { resolve(integration); } else { reject(error); }
			};
			const timer = setTimeout(() => settle(undefined, new Error(
				"Terminal shell integration did not activate. Enable terminal.integrated.shellIntegration.enabled and select a supported shell (PowerShell 7, bash or zsh). No command was sent."
			)), this.integrationTimeoutMs);
			subscriptions.push(
				this.host.onDidChangeTerminalShellIntegration(event => {
					if (event.terminal === session.terminal) { settle(event.shellIntegration); }
				}),
				this.host.onDidCloseTerminal(terminal => {
					if (terminal === session.terminal) { settle(undefined, new Error("Terminal closed before execution. No command was sent.")); }
				}),
				token.onCancellationRequested(() => settle(undefined, new vscode.CancellationError())),
			);
			if (token.isCancellationRequested) { settle(undefined, new vscode.CancellationError()); }
		});
	}

	private waitFor(done: Promise<void>, ms: number, token?: vscode.CancellationToken): Promise<void> {
		return new Promise((resolve, reject) => {
			const settle = (cancelled = false) => {
				clearTimeout(timer); cancellation?.dispose();
				if (cancelled) { reject(new vscode.CancellationError()); } else { resolve(); }
			};
			const timer = setTimeout(() => settle(), ms);
			const cancellation = token?.onCancellationRequested(() => settle(true));
			void done.then(() => settle());
			if (token?.isCancellationRequested) { settle(true); }
		});
	}
}