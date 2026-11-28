import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import { CocoTerminalManager } from "../coco/terminal-manager";
import { CONFIG_SECTION, EXTENSION_ID } from "../constants";
import { createOsNotifier, vscodeToastAppId } from "../os-notification";
import { resolveProviderSwitchContextTokens } from "../context/provider-handoff";
import type { SessionQualityTracker } from "../diagnostics/session-report";
import { getCurrentWorkspaceScopeId, getCurrentWorkspaceScopeLabel } from "../memory/scope";
import type { SharedMemoryService } from "../memory/shared-memory-service";
import { createMemoryTools } from "../memory/tools";
import { ChatAttachmentSource } from "./attachment-source";
import { approvalKindLabel, createAlwaysAllowStore } from "./approvals";
import { ChatChangeTracker } from "./changes/change-tracker";
import { findGitExecutable } from "./changes/shadow-git";
import { ChatController, type ChatAccountSource, type ChatQuotaSource } from "./chat-controller";
import { ChatViewHost, registerChatView } from "./chat-view";
import { CHAT_COMPACTION_TARGET_TOKENS, createChatSummarizer } from "./compaction";
import { resolveChatContextBudget } from "./context-cleaning";
import { createChatContextSettingsSource } from "./context-settings";
import { createVscodeFileReferenceOpener, openFileReference } from "./file-opener";
import { createChatMemorySource } from "./memory-context";
import { chatImageFileName } from "./image-file";
import { createChatMemoryStore } from "./memory-store";
import { ChatPromptSource } from "./prompt/instructions";
import { ChatSessionStore } from "./session-store";
import { createChatToolSource } from "./tool-executor";
import { ChatToolCatalog } from "./tools/catalog";
import { availableSubagentModelProfiles, blockedSubagentModel, subagentStandIn, unavailableSubagentModelProfiles, type SubagentModelProfile } from "../subagent-guidance";
import type { SubagentModelOption, UnavailableSubagentModel } from "./tools/types";

function subagentModelOptions(): SubagentModelOption[] {
	return availableSubagentModelProfiles().map(profile => ({ id: profile.id, label: profile.label, useWhen: profile.useWhen }));
}

function unavailableSubagentModel(profile: SubagentModelProfile): UnavailableSubagentModel {
	const until = profile.unavailableUntil ? Date.parse(profile.unavailableUntil) : Number.NaN;
	return {
		id: profile.id,
		label: profile.label,
		reason: profile.availabilityReason || "its subscription limit is used up",
		...(Number.isFinite(until) ? { until } : {}),
	};
}
import { createCoreTools } from "./tools/core-tools";
import { createChangesDiffTool } from "./tools/changes-tools";
import { createAskQuestionsTool, createTodoTool } from "./tools/interaction-tools";
import { createCloseSubagentTool, createSubagentTool, createWaitSubagentsTool } from "./tools/subagent-tool";
import { createSymbolTools } from "./tools/symbol-tools";
import { configuredDangerousCommandRules } from "./tools/danger";
import { createChatTerminalTools } from "./tools/terminal-tools";
import { createCheckTool } from "./tools/check-tools";
import { createToolAccessTools } from "./tools/tool-access-tools";
import { createWebTools } from "./tools/web-tools";

type CompositeChatProvider = Pick<vscode.LanguageModelChatProvider, "provideLanguageModelChatResponse" | "provideLanguageModelChatInformation"> & {
	onDidChangeLanguageModelChatInformation?: vscode.Event<void>;
	abandonConversation?: (conversationId: string) => Promise<void>;
};

export interface ChatWindowDeps {
	composite: CompositeChatProvider;
	getCompactionDeepSeekApiKey: () => Promise<string | undefined>;
	log?: (event: string, data: Record<string, unknown>) => void;
	/** Sent with DeepSeek summary requests. */
	userAgent?: string;
	quota?: ChatQuotaSource;
	/** Subscriptions to sign in to, offered in the model picker. */
	accounts?: ChatAccountSource;
	/** Shared durable memory the chat shows to every provider. */
	memory?: SharedMemoryService;
	/** Session Quality tracker that records finished context cleanings. */
	sessionQuality?: Pick<SessionQualityTracker, "recordCleaning" | "recordBreakdown">;
}

const NEVER_FIRES: vscode.Event<void> = () => new vscode.Disposable(() => undefined);
const CHANGE_SCHEME = "aab-chat-change";

function changeUri(filePath: string, sessionId: string, id: string, empty = false): vscode.Uri {
	// VS Code caches virtual documents by URI; the timestamp keeps a reopened diff current.
	const query = new URLSearchParams({ session: sessionId, id, v: String(Date.now()), ...(empty ? { empty: "1" } : {}) });
	return vscode.Uri.from({ scheme: CHANGE_SCHEME, path: `/${filePath}`, query: query.toString() });
}

/** Left side of the diff: the file before the agent's pending change; an empty document for new or deleted sides. */
function registerChangeDiff(context: vscode.ExtensionContext, tracker: ChatChangeTracker): (sessionId: string, id: string) => Promise<void> {
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(CHANGE_SCHEME, {
		provideTextDocumentContent: async uri => {
			const query = new URLSearchParams(uri.query);
			const sessionId = query.get("session");
			const id = query.get("id");
			if (query.get("empty") === "1" || !sessionId || !id) {
				return "";
			}
			return (await tracker.original(sessionId, id))?.before?.toString("utf8") ?? "";
		},
	}));
	return async (sessionId, id) => {
		const original = await tracker.original(sessionId, id);
		if (!original) {
			return;
		}
		const left = changeUri(original.path, sessionId, id, original.before === undefined);
		const right = original.exists
			? vscode.Uri.file(path.join(original.root, ...original.path.split("/")))
			: changeUri(original.path, sessionId, id, true);
		await vscode.commands.executeCommand("vscode.diff", left, right, `${path.posix.basename(original.path)} (agent changes)`);
	};
}

/** Path of the URI a click on an OS notification opens; `session` in the query names the chat. */
export const CHAT_OPEN_URI_PATH = "/open-chat";

/** The chat a notification URI asks for; undefined for any other URI of the extension. */
export function chatSessionFromUri(uri: { path: string; query: string }): string | undefined {
	if (uri.path !== CHAT_OPEN_URI_PATH) {
		return undefined;
	}
	return new URLSearchParams(uri.query).get("session") || undefined;
}

/**
 * URI a click on a Windows toast opens. VS Code adds the window id, so the click
 * focuses the window that ran the chat instead of starting a new one.
 */
async function chatOpenUri(sessionId: string): Promise<string | undefined> {
	try {
		const uri = vscode.Uri.from({
			scheme: vscode.env.uriScheme,
			authority: EXTENSION_ID,
			path: CHAT_OPEN_URI_PATH,
			query: new URLSearchParams({ session: sessionId }).toString(),
		});
		return (await vscode.env.asExternalUri(uri)).toString();
	} catch {
		return undefined;
	}
}

/** Set once the chat was shown in the secondary side bar, its home since 2.0.5. */
export const CHAT_REVEALED_KEY = "llamacpp.chat.secondarySidebarRevealed";

/**
 * Shows the chat in the secondary side bar once, so users find it after it moved there.
 * Focus returns to the editor; later the side bar keeps whatever the user chose.
 */
export async function revealChatOnce(
	state: { get(key: string): unknown; update(key: string, value: unknown): Thenable<void> },
	run: (command: string) => Thenable<unknown> = command => vscode.commands.executeCommand(command),
): Promise<boolean> {
	if (state.get(CHAT_REVEALED_KEY) === true) {
		return false;
	}
	await state.update(CHAT_REVEALED_KEY, true);
	try {
		await run("llamacpp.chat.focus");
		await run("workbench.action.focusActiveEditorGroup");
	} catch {
		// The chat stays reachable from its side bar icon.
	}
	return true;
}

/** Wires the chat webview to a controller that runs agent turns through the composite provider. */
export function registerChatWindow(context: vscode.ExtensionContext, deps: ChatWindowDeps): void {
	const storage = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
	const root = path.join(storage, "chat-sessions");
	const folders = () => (vscode.workspace.workspaceFolders ?? [])
		.filter(folder => folder.uri.scheme === "file")
		.map(folder => ({ name: folder.name, fsPath: folder.uri.fsPath }));
	// The same two switches the HTTP provider reads for its own auto-injection.
	const memoryEnabled = (): boolean => {
		const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
		return cfg.get<boolean>("memoryEnabled", true) !== false
			&& cfg.get<boolean>("memoryAutoInject", true) !== false;
	};
	const memory = deps.memory
		? createChatMemorySource(deps.memory, { enabled: memoryEnabled, workspaceId: getCurrentWorkspaceScopeId })
		: undefined;
	const memoryStore = deps.memory
		? createChatMemoryStore(deps.memory, {
			enabled: () => vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("memoryEnabled", true) !== false,
			workspaceId: getCurrentWorkspaceScopeId,
			projectLabel: getCurrentWorkspaceScopeLabel,
		})
		: undefined;
	const changes = new ChatChangeTracker({
		storageDir: path.join(storage, "chat-changes"),
		folders,
		findGit: findGitExecutable,
		log: deps.log,
	});
	const changeMaintenance = setTimeout(() => {
		void changes.maintain().catch(() => undefined);
	}, 12_000);
	changeMaintenance.unref?.();
	context.subscriptions.push({ dispose: () => clearTimeout(changeMaintenance) });
	const sessionStore = new ChatSessionStore(root);
	const sessionRetention = setTimeout(() => {
		const started = Date.now();
		void sessionStore.pruneOrphans()
			.then(result => deps.log?.("storage.retention.done", {
				store: "chat-sessions",
				removedFiles: result.removedFiles,
				removedBytes: result.removedBytes,
				durationMs: Date.now() - started,
			}))
			.catch(error => deps.log?.("storage.retention.failed", {
				store: "chat-sessions",
				message: error instanceof Error ? error.message : String(error),
			}));
	}, 7_000);
	sessionRetention.unref?.();
	context.subscriptions.push({ dispose: () => clearTimeout(sessionRetention) });
	const terminals = new CocoTerminalManager(vscode.window, undefined, deps.log, "Chat");
	const reportInvalidRule = (pattern: string, error: string) => deps.log?.("chat.dangerous_rule_invalid", { pattern, error });
	const catalog = new ChatToolCatalog({
		builtins: [
			...createCoreTools(),
			...createWebTools(),
			...createSymbolTools(),
			createTodoTool(),
			createChangesDiffTool(),
			createAskQuestionsTool(),
			...createToolAccessTools(),
			...(deps.memory ? createMemoryTools(deps.memory) : []),
			...createChatTerminalTools({ manager: terminals, rules: () => configuredDangerousCommandRules(reportInvalidRule) }),
			createCheckTool({ logDir: path.join(storage, "chat-checks"), rules: () => configuredDangerousCommandRules(reportInvalidRule) }),
			createSubagentTool({
				// The bridge's subagent catalog: cheapest first, premium flagships left out; exhausted subscriptions are
				// listed apart, so a call to one is answered with its limit instead of "unknown model".
				models: subagentModelOptions,
				unavailable: () => unavailableSubagentModelProfiles().map(unavailableSubagentModel),
			}),
			createWaitSubagentsTool({ models: subagentModelOptions }),
			createCloseSubagentTool({ models: subagentModelOptions }),
		],
		state: context.globalState,
	});
	const attachments = new ChatAttachmentSource({ log: deps.log, pasteDir: vscode.Uri.file(path.join(storage, "chat-attachments")) });
	const contextSettings = createChatContextSettingsSource();
	const alwaysAllow = createAlwaysAllowStore();
	/** Lists what runs without an approval card and takes the picked kinds off the list. */
	const manageAlwaysAllowed = async (): Promise<void> => {
		const keys = alwaysAllow.keys();
		if (keys.length === 0) {
			void vscode.window.showInformationMessage("Nothing is always allowed. Choose Always allow on an approval card in the SubHarness chat.");
			return;
		}
		const picked = await vscode.window.showQuickPick(
			keys.map(key => ({ label: approvalKindLabel(key), description: key, key })),
			{ title: "SubHarness: Always Allowed Actions", placeHolder: "Pick the actions that should ask again", canPickMany: true }
		);
		for (const item of picked ?? []) {
			await alwaysAllow.remove(item.key);
		}
	};
	const osNotifier = createOsNotifier({ appId: process.platform === "win32" ? vscodeToastAppId(vscode.env.appRoot) : undefined, log: deps.log });
	const controller = new ChatController({
		alwaysAllow,
		osNotify: (title, body, sessionId) => {
			if (!vscode.window.state.focused && vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("chat.systemNotifications", true) !== false) {
				// Only a Windows toast can carry a click target.
				const launch = process.platform === "win32" ? chatOpenUri(sessionId) : Promise.resolve(undefined);
				void launch.then(uri => osNotifier(title, body, uri));
			}
		},
		backend: deps.composite,
		onDidChangeModels: deps.composite.onDidChangeLanguageModelChatInformation ?? NEVER_FIRES,
		store: sessionStore,
		tools: createChatToolSource(catalog),
		state: context.workspaceState,
		globalState: context.globalState,
		log: deps.log,
		changes,
		terminals,
		openChange: registerChangeDiff(context, changes),
		openImage: async (image, key) => {
			const folder = vscode.Uri.joinPath(context.globalStorageUri, "chat-images");
			await vscode.workspace.fs.createDirectory(folder);
			try {
				for (const [name, type] of await vscode.workspace.fs.readDirectory(folder)) {
					if (type === vscode.FileType.File) {
						const file = vscode.Uri.joinPath(folder, name);
						try {
							if ((await vscode.workspace.fs.stat(file)).mtime < Date.now() - 24 * 60 * 60 * 1000) {
								await vscode.workspace.fs.delete(file);
							}
						} catch {
							// Cleanup is best effort.
						}
					}
				}
			} catch {
				// Cleanup is best effort.
			}
			const uri = vscode.Uri.joinPath(folder, chatImageFileName(key, image.mimeType));
			await vscode.workspace.fs.writeFile(uri, Buffer.from(image.data, "base64"));
			await vscode.commands.executeCommand("vscode.open", uri);
		},
		openFileReference: async target => {
			const opener = createVscodeFileReferenceOpener(() => folders().map(folder => folder.fsPath), ChatViewHost.panelViewType);
			deps.log?.("chat.file_reference.opened", { outcome: await openFileReference(target, opener) });
		},
		saveExport: async (suggestedName, content) => {
			const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
			const target = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.joinPath(folder, suggestedName),
				filters: { Markdown: ["md"] },
				saveLabel: "Export",
			});
			if (!target) {
				return undefined;
			}
			await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
			return target.fsPath;
		},
		prompt: new ChatPromptSource({ folders, memoryEnabled }),
		attachments,
		memory,
		memoryStore,
		subagentStandIn,
		subagentBlocked: modelId => {
			const profile = blockedSubagentModel(modelId);
			return profile ? unavailableSubagentModel(profile) : undefined;
		},
		subagentModels: subagentModelOptions,
		abandonConversation: async id => { await deps.composite.abandonConversation?.(id); },
		confirm: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
		notify: async (message, action) => {
			const choice = await vscode.window.showInformationMessage(message, action);
			if (choice === action) {
				// VS Code generates "<viewId>.focus" for every contributed view.
				await Promise.resolve(vscode.commands.executeCommand("llamacpp.chat.focus")).catch(() => undefined);
			}
			return choice === action;
		},
		quota: deps.quota,
		accounts: deps.accounts,
		contextSettings,
		compaction: {
			summarize: createChatSummarizer({
				apiKey: deps.getCompactionDeepSeekApiKey,
				userAgent: deps.userAgent ?? "ai-agent-bridge",
				log: deps.log,
			}),
			limits: () => {
				const trigger = resolveProviderSwitchContextTokens();
				// A lowered switch limit lowers the target too, so the compacted chat stays well under it.
				return { triggerTokens: trigger, targetTokens: Math.min(CHAT_COMPACTION_TARGET_TOKENS, Math.floor(trigger / 2)) };
			},
			cleaningBudget: () => resolveChatContextBudget(),
			onCleaned: event => deps.sessionQuality?.recordCleaning(event),
			onRequestBreakdown: event => deps.sessionQuality?.recordBreakdown(event),
		},
	});
	const host = registerChatView(context, controller);
	const focusChat = async (): Promise<void> => {
		await Promise.resolve(vscode.commands.executeCommand("llamacpp.chat.focus")).catch(() => undefined);
	};
	void revealChatOnce(context.globalState);
	context.subscriptions.push(
		terminals,
		controller,
		alwaysAllow,
		contextSettings,
		vscode.window.registerUriHandler({
			handleUri: async uri => {
				const sessionId = chatSessionFromUri(uri);
				if (!sessionId) {
					return;
				}
				deps.log?.("chat.notification.opened", {});
				await focusChat();
				await controller.openSession(sessionId);
			},
		}),
		vscode.commands.registerCommand("llamacpp.chat.new", () => controller.newChat()),
		vscode.commands.registerCommand("llamacpp.chat.history", () => controller.showSessions()),
		vscode.commands.registerCommand("llamacpp.chat.manageToolApprovals", manageAlwaysAllowed),
		vscode.commands.registerCommand("llamacpp.chat.openInEditor", () => host.openInEditor()),
		vscode.commands.registerCommand("llamacpp.chat.addSelection", async () => {
			const selection = attachments.selection();
			if (!selection) {
				await vscode.window.showInformationMessage("Select some text first.");
				return;
			}
			controller.addAttachments([selection]);
			await focusChat();
		}),
		vscode.commands.registerCommand("llamacpp.chat.addFile", async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
			const editorUri = vscode.window.activeTextEditor?.document.uri;
			const targets = uris && uris.length > 0 ? uris : uri ? [uri] : editorUri ? [editorUri] : [];
			const files = await attachments.fromUris(targets.map(target => target.toString()));
			if (files.length === 0) {
				return;
			}
			controller.addAttachments(files);
			await focusChat();
		}),
	);
}
