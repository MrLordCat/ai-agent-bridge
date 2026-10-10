import * as vscode from "vscode";
import { CocoTerminalManager, type CocoTerminalRunInput } from "./terminal-manager";

export const COCO_TERMINAL_TOOLS = {
	run: "llamacpp_coco_run_in_terminal",
	read: "llamacpp_coco_read_terminal",
	send: "llamacpp_coco_send_to_terminal",
	kill: "llamacpp_coco_kill_terminal",
} as const;

const HEADLESS_SHELL_TOOLS = new Set([
	"powershell", "bash", "read_powershell", "write_powershell", "stop_powershell", "list_powershell", "powershell_shutdown",
	"read_bash", "write_bash", "stop_bash", "list_bash", "bash_shutdown",
]);

/** Preserve caller tool names, including extension toolReferenceName aliases in Agents. */
export function selectCocoChatTools(tools: readonly vscode.LanguageModelChatTool[]): vscode.LanguageModelChatTool[] {
	return tools.filter(tool => !HEADLESS_SHELL_TOOLS.has(tool.name));
}

interface TerminalInput { terminalId: string; }
interface ReadInput extends TerminalInput { waitMs?: number; maxChars?: number; }
interface SendInput extends TerminalInput { text: string; addNewLine?: boolean; }

function result(value: unknown): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(value))]);
}

function confirm(title: string, message: string, command?: string): vscode.PreparedToolInvocation {
	const markdown = new vscode.MarkdownString(message);
	if (command !== undefined) { markdown.appendCodeblock(command); }
	return { invocationMessage: title, confirmationMessages: { title, message: markdown } };
}

export function registerCocoTerminalTools(context: vscode.ExtensionContext): void {
	const manager = new CocoTerminalManager();
	context.subscriptions.push(manager,
		vscode.lm.registerTool<CocoTerminalRunInput>(COCO_TERMINAL_TOOLS.run, {
			prepareInvocation: ({ input }) => confirm("Run command in a Coco terminal", "Execute in the interactive VS Code terminal panel.", input.command),
			invoke: async ({ input }, token) => {
				if (!vscode.workspace.isTrusted) { throw new Error("Trust this workspace before running terminal commands."); }
				return result(await manager.run(input, token));
			},
		}),
		vscode.lm.registerTool<ReadInput>(COCO_TERMINAL_TOOLS.read, {
			prepareInvocation: () => ({ invocationMessage: "Read Coco terminal output" }),
			invoke: async ({ input }, token) => result(await manager.read(input.terminalId, input.waitMs, input.maxChars, token)),
		}),
		vscode.lm.registerTool<SendInput>(COCO_TERMINAL_TOOLS.send, {
			prepareInvocation: ({ input }) => confirm("Send input to a Coco terminal", "Send input to the running command.", input.text),
			invoke: ({ input }, token) => {
				if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
				return result(manager.send(input.terminalId, input.text, input.addNewLine));
			},
		}),
		vscode.lm.registerTool<TerminalInput>(COCO_TERMINAL_TOOLS.kill, {
			prepareInvocation: ({ input }) => confirm("Close a Coco terminal", `Close terminal ${input.terminalId} and stop its running shell.`),
			invoke: ({ input }, token) => {
				if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
				return result(manager.kill(input.terminalId));
			},
		}),
	);
}