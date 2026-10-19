import * as vscode from "vscode";

import { CONFIG_SECTION, EXTENSION_ID } from "../constants";
import { CocoChatModelProvider, listCocoConnections } from "./coco-provider";

type CocoStatusUi = Pick<typeof vscode.window, "withProgress" | "showWarningMessage" | "showInformationMessage">;

export function createCocoStatusCheck(
	provider: CocoChatModelProvider, refreshQuickAccess: () => void, ui: CocoStatusUi = vscode.window
): (force?: boolean) => Promise<void> {
	let pending: Promise<void> | undefined;
	return (force = true) => {
		if (pending) { return pending; }
		pending = (async () => {
			let cancelled = false;
			const status = await ui.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: "Checking Coco connection", cancellable: true },
				async (progress, token) => {
					const subscription = provider.onDidChangeStatus(update => {
						if (update.state === "checking") { progress.report({ message: update.summary }); }
					});
					try {
						const result = await provider.refreshStatus(force, token);
						cancelled = token.isCancellationRequested;
						return result;
					} finally { subscription.dispose(); }
				}
			);
			refreshQuickAccess();
			if (cancelled || status.state === "checking") { return; }
			const message = `Coco: ${status.summary}. Connection: ${status.connection ?? "CLI default"}. Models: ${status.modelCount}.`;
			if (status.state === "unavailable" || status.state === "unconfigured") {
				void ui.showWarningMessage(message);
			} else {
				void ui.showInformationMessage(message);
			}
		})().finally(() => { pending = undefined; });
		return pending;
	};
}

interface CocoConnectionItem { label: string; connection: string; description?: string; picked?: boolean }
interface CocoConnectionUi {
	current(): string;
	names(): string[];
	pick(items: CocoConnectionItem[]): Thenable<CocoConnectionItem | undefined>;
	update(connection: string): Thenable<void>;
}

/** Selecting the existing connection also retries its status; cancellation does nothing. */
export async function selectCocoConnection(
	checkStatus: (force?: boolean) => Promise<void>,
	ui: CocoConnectionUi = {
		current: () => vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>("cocoConnection", ""),
		names: listCocoConnections,
		pick: items => vscode.window.showQuickPick(items, { title: "Coco: Snowflake connection", placeHolder: "Select the connection used by Coco", ignoreFocusOut: true }),
		update: connection => vscode.workspace.getConfiguration(CONFIG_SECTION).update("cocoConnection", connection, vscode.ConfigurationTarget.Global),
	}
): Promise<void> {
	const current = ui.current(), names = ui.names();
	const selected = await ui.pick([
		{ label: "Automatic / CLI default", connection: "", description: "Use the sole configured connection or the CLI default", picked: !current },
		...names.map(name => ({ label: name, connection: name, picked: name === current })),
		...(current && !names.includes(current) ? [{ label: current, connection: current, picked: true }] : []),
	]);
	if (!selected) { return; }
	if (selected.connection !== current) { await ui.update(selected.connection); }
	await checkStatus(true);
}

interface SnowflakePanelExtension {
	activate(): Thenable<unknown>;
	packageJSON?: { contributes?: { views?: Record<string, readonly { id: string }[]> } };
}
type CocoPanelHost = Pick<typeof vscode.window, "withProgress" | "showErrorMessage"> & {
	getExtension(): SnowflakePanelExtension | undefined;
	executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
	version: string;
	activationTimeoutMs?: number;
};

/** Snowflake moved Coco into the secondary sidebar on VS Code 1.106+. */
export function createCocoOpenSnowflake(host: CocoPanelHost = {
	getExtension: () => vscode.extensions.getExtension("snowflake.snowflake-vsc"),
	executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
	withProgress: vscode.window.withProgress,
	showErrorMessage: vscode.window.showErrorMessage,
	version: vscode.version,
}): () => Promise<void> {
	let pending: Promise<void> | undefined;
	return () => {
		if (pending) { return pending; }
		pending = (async () => {
			const extension = host.getExtension();
			if (!extension) { await host.executeCommand("workbench.extensions.search", "@id:snowflake.snowflake-vsc"); return; }
			const [major, minor] = host.version.split(".").map(Number);
			const modern = major > 1 || major === 1 && minor >= 106;
			const views = Object.values(extension.packageJSON?.contributes?.views ?? {}).flat().map(view => view.id);
			const preferred = modern ? "cortexChatSecondary" : "cortexChat";
			const view = views.includes(preferred) ? preferred : views.find(id => id === "cortexChat" || id === "cortexChatSecondary") ?? preferred;
			const timeoutMs = host.activationTimeoutMs ?? 45_000;
			const timeoutError = new Error("Snowflake activation timed out");
			try {
				await host.withProgress({ location: vscode.ProgressLocation.Notification, title: "Opening Snowflake Coco", cancellable: true }, async (progress, token) => {
					if (token.isCancellationRequested) { return; }
					let stopped = false, timer: NodeJS.Timeout | undefined, cancellation: vscode.Disposable | undefined;
					try {
						progress.report({ message: "Activating Snowflake extension..." });
						await Promise.race([
							Promise.resolve().then(() => extension.activate()).then(async () => {
								if (stopped || token.isCancellationRequested) { return; }
								progress.report({ message: "Opening Coco panel..." });
								await host.executeCommand(`${view}.focus`);
							}),
							new Promise<void>((_, reject) => { timer = setTimeout(() => reject(timeoutError), timeoutMs); }),
							new Promise<void>(resolve => { cancellation = token.onCancellationRequested(() => resolve()); }),
						]);
					} finally { stopped = true; clearTimeout(timer); cancellation?.dispose(); }
				});
			} catch (error) {
				// Activation errors may contain connection data; show a stable message.
				void host.showErrorMessage(error === timeoutError
					? `Snowflake did not finish opening Coco within ${Math.ceil(timeoutMs / 1_000)}s. Check Snowflake and Log (Extension Host) in Output, then retry Open Snowflake Coco.`
					: "Cannot open Snowflake Coco. Check Snowflake and Log (Extension Host) in Output, then retry Open Snowflake Coco.");
			}
		})().finally(() => { pending = undefined; });
		return pending;
	};
}

export function registerCocoCommands(
	context: vscode.ExtensionContext,
	provider: CocoChatModelProvider,
	refreshQuickAccess: () => void
): void {
	const checkStatus = createCocoStatusCheck(provider, refreshQuickAccess);
	const openSnowflake = createCocoOpenSnowflake();
	context.subscriptions.push(
		vscode.commands.registerCommand("llamacpp.toggleCoco", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const next = config.get<boolean>("enableCoco", true) === false;
			await config.update("enableCoco", next, vscode.ConfigurationTarget.Global);
			await provider.refreshStatus();
			refreshQuickAccess();
			void vscode.window.showInformationMessage(`Coco source ${next ? "enabled" : "disabled"}.`);
		}),
		vscode.commands.registerCommand("llamacpp.cocoShowStatus", () => checkStatus()),
		vscode.commands.registerCommand("llamacpp.cocoRefreshModels", () => checkStatus(true)),
		vscode.commands.registerCommand("llamacpp.cocoSelectConnection", () => selectCocoConnection(checkStatus)),
		vscode.commands.registerCommand("llamacpp.cocoOpenSettings", () =>
			vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${EXTENSION_ID} coco`)),
		vscode.commands.registerCommand("llamacpp.cocoOpenSnowflake", openSnowflake)
	);
}