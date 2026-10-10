import * as vscode from "vscode";

import { CONFIG_SECTION, EXTENSION_ID } from "../constants";
import { CocoChatModelProvider, listCocoConnections } from "./coco-provider";

type CocoStatusUi = Pick<typeof vscode.window, "withProgress" | "showWarningMessage" | "showInformationMessage">;

export function createCocoStatusCheck(
	provider: CocoChatModelProvider, refreshQuickAccess: () => void, ui: CocoStatusUi = vscode.window
): (force?: boolean) => Promise<void> {
	let pending: Promise<void> | undefined;
	return (force = false) => {
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

export function registerCocoCommands(
	context: vscode.ExtensionContext,
	provider: CocoChatModelProvider,
	refreshQuickAccess: () => void
): void {
	const checkStatus = createCocoStatusCheck(provider, refreshQuickAccess);
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
		vscode.commands.registerCommand("llamacpp.cocoSelectConnection", async () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = config.get<string>("cocoConnection", "");
			const names = listCocoConnections();
			const selected = await vscode.window.showQuickPick([
				{ label: "Automatic / CLI default", connection: "", description: "Use the sole configured connection or the CLI default", picked: !current },
				...names.map(name => ({ label: name, connection: name, picked: name === current })),
				...(current && !names.includes(current) ? [{ label: current, connection: current, picked: true }] : []),
			], { title: "Coco: Snowflake connection", placeHolder: "Select the connection used by Coco", ignoreFocusOut: true });
			if (!selected || selected.connection === current) {
				return;
			}
			await config.update("cocoConnection", selected.connection, vscode.ConfigurationTarget.Global);
			await checkStatus();
		}),
		vscode.commands.registerCommand("llamacpp.cocoOpenSettings", () =>
			vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${EXTENSION_ID} coco`)),
		vscode.commands.registerCommand("llamacpp.cocoOpenSnowflake", async () => {
			const snowflake = vscode.extensions.getExtension("snowflake.snowflake-vsc");
			if (!snowflake) {
				await vscode.commands.executeCommand("workbench.extensions.search", "@id:snowflake.snowflake-vsc");
				return;
			}
			await snowflake.activate();
			await vscode.commands.executeCommand("cortexChat.focus");
		})
	);
}