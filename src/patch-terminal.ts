import * as vscode from "vscode";

export interface PatchTerminalHost {
	createTerminal(options: vscode.TerminalOptions): vscode.Terminal;
	onDidChangeTerminalShellIntegration: vscode.Event<vscode.TerminalShellIntegrationChangeEvent>;
	onDidEndTerminalShellExecution: vscode.Event<vscode.TerminalShellExecutionEndEvent>;
	onDidCloseTerminal: vscode.Event<vscode.Terminal>;
}

interface PatchTerminalOptions {
	command: string;
	cleanup: () => void;
	onClosed: () => void;
	onSuccess: () => void;
	onFailure: (error: Error) => void;
}

/** Owns a visible authorization terminal and retains failed attempts for retry. */
export class PatchTerminalSession implements vscode.Disposable {
	readonly terminal: vscode.Terminal;
	private phase: "retryable" | "preparing" | "running" | "closed" = "retryable";
	private execution?: vscode.TerminalShellExecution;
	private readonly subscriptions: vscode.Disposable[] = [];
	private cancelWait?: () => void;

	constructor(
		private readonly options: PatchTerminalOptions,
		private readonly host: PatchTerminalHost = vscode.window,
		private readonly integrationTimeoutMs = 10_000
	) {
		this.terminal = host.createTerminal({ name: "AI Agent Bridge Patch", shellPath: "/bin/bash" });
		this.subscriptions.push(
			host.onDidCloseTerminal(terminal => {
				if (terminal === this.terminal) { this.finish(false, false); }
			}),
			host.onDidEndTerminalShellExecution(event => {
				if (event.terminal !== this.terminal || event.execution !== this.execution) { return; }
				this.execution = undefined;
				if (event.exitCode === 0) { this.finish(true, false); }
				else {
					this.phase = "retryable";
					this.options.onFailure(new Error("Patch command exited with code " + (event.exitCode ?? "unknown") + "."));
				}
			}),
		);
	}

	get canRetry(): boolean { return this.phase === "retryable"; }
	get isClosed(): boolean { return this.phase === "closed"; }

	async run(): Promise<void> {
		if (this.isClosed) { return; }
		this.terminal.show();
		if (!this.canRetry) { return; }
		this.phase = "preparing";
		try {
			const integration = await this.waitForIntegration();
			if (this.isClosed) { return; }
			if (!integration) {
				throw new Error("Terminal shell integration did not activate. Enable terminal.integrated.shellIntegration.enabled and retry. No command was sent.");
			}
			this.phase = "running";
			this.execution = integration.executeCommand(this.options.command);
		} catch (error) {
			if (this.isClosed) { return; }
			this.phase = "retryable";
			this.options.onFailure(error instanceof Error ? error : new Error(String(error)));
		}
	}

	dispose(): void { this.finish(false, true); }

	private finish(success: boolean, closeTerminal: boolean): void {
		if (this.isClosed) { return; }
		this.phase = "closed";
		this.cancelWait?.();
		for (const subscription of this.subscriptions) { subscription.dispose(); }
		this.options.onClosed();
		try { this.options.cleanup(); }
		finally { if (closeTerminal) { this.terminal.dispose(); } }
		if (success) { this.options.onSuccess(); }
	}

	private waitForIntegration(): Promise<vscode.TerminalShellIntegration | undefined> {
		if (this.terminal.shellIntegration) { return Promise.resolve(this.terminal.shellIntegration); }
		return new Promise(resolve => {
			let settled = false;
			const settle = (integration?: vscode.TerminalShellIntegration) => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				subscription?.dispose();
				this.cancelWait = undefined;
				resolve(integration);
			};
			const timer = setTimeout(() => settle(), this.integrationTimeoutMs);
			const subscription = this.host.onDidChangeTerminalShellIntegration(event => {
				if (event.terminal === this.terminal) { settle(event.shellIntegration); }
			});
			this.cancelWait = () => settle();
			if (this.isClosed) { settle(); }
			else if (this.terminal.shellIntegration) { settle(this.terminal.shellIntegration); }
		});
	}
}
