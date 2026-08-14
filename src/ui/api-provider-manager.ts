import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import {
	DEFAULT_API_PROVIDER_CONTEXT,
	type ApiProviderDraft,
	type ApiProviderService,
	type ApiProviderSummary,
} from "../api-providers/api-provider-service";
import { CONFIG_SECTION, DEFAULT_SERVER_URL } from "../constants";
import {
	formatDeepSeekPeakEffectiveLocal,
	resolveDeepSeekPricingSnapshot,
} from "../deepseek-peak-hours";
import {
	type ProviderDirectory,
	type ProviderStatusEntry,
} from "../providers/provider-directory";

function esc(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escAttr(value: unknown): string {
	return esc(value).replace(/"/g, "&quot;");
}

function selectOption(value: string, current: string, label: string): string {
	return `<option value="${escAttr(value)}"${value === current ? " selected" : ""}>${esc(label)}</option>`;
}

export interface ProviderManagerLiveData {
	deepSeek?: { balance?: string };
	codex?: { summary?: string; usagePercent?: number; usageReset?: string };
	claude?: { summary?: string; limits?: Array<{ label: string; description: string }> };
}

export interface ProviderManagerExtras {
	local?: { enabled: boolean; endpoint: string };
	deepSeek?: {
		enabled: boolean;
		compactionSummary: boolean;
		balance?: string;
		peakHours: string;
	};
	codex?: {
		enabled: boolean;
		summary?: string;
		usagePercent?: number;
		usageReset?: string;
	};
	claude?: {
		enabled: boolean;
		summary?: string;
		limits: Array<{ label: string; description: string }>;
	};
}

export interface ApiProviderManagerRenderState {
	profiles: readonly ApiProviderSummary[];
	providers: readonly ProviderStatusEntry[];
	extras?: ProviderManagerExtras;
	editingId?: string;
	status?: string;
	error?: string;
}

function stateLabelOf(state: string | undefined): string {
	const labels: Record<string, string> = {
		checking: "Checking",
		off: "Off",
		unconfigured: "Not configured",
		online: "Online",
		offline: "Offline",
		paused: "Paused",
	};
	return labels[state ?? "checking"] ?? "—";
}

function renderBuiltinProviders(state: ApiProviderManagerRenderState): string {
	const extras = state.extras ?? {};
	const statusOf = (key: string): ProviderStatusEntry | undefined =>
		state.providers.find(provider => provider.key === key);

	const card = (
		key: string,
		name: string,
		description: string,
		enabled: boolean,
		badges: Array<{ label: string; css?: string }>,
		buttons: Array<{ command: string; label: string; primary?: boolean }>
	): string => {
		const status = statusOf(key);
		return `
		<article class="provider-card${enabled ? "" : " disabled"}">
			<div class="provider-head">
				<div>
					<div class="provider-name">${esc(name)}</div>
					<div class="endpoint">${esc(description)}</div>
				</div>
				<span class="status ${esc(status?.state ?? "checking")}">${stateLabelOf(status?.state)}</span>
			</div>
			<div class="badges">
				${badges.map(badge => `<span class="${esc(badge.css ?? "")}">${esc(badge.label)}</span>`).join("")}
			</div>
			<div class="actions">
				${buttons.map(button => `<button class="ctrl-btn${button.primary ? " primary" : ""}" data-command="${escAttr(button.command)}" type="button">${esc(button.label)}</button>`).join("")}
			</div>
		</article>`;
	};

	const local = extras.local;
	const deepSeek = extras.deepSeek;
	const codex = extras.codex;
	const claude = extras.claude;

	const cards: string[] = [];
	if (local) {
		cards.push(card("local", "Local LLM", `OpenAI-compatible server · ${local.endpoint}`, local.enabled,
			[{ label: `endpoint ${local.endpoint}` }],
			[
				{ command: "llamacpp.toggleLocalServer", label: local.enabled ? "Disable source" : "Enable source" },
				{ command: "llamacpp.setLocalServerUrl", label: "Set endpoint" },
				{ command: "llamacpp.refreshModels", label: "Refresh models" },
			]));
	}
	if (deepSeek) {
		const badges = [
			{ label: deepSeek.balance ? `balance ${deepSeek.balance}` : "balance n/a" },
			{ label: deepSeek.peakHours, css: resolveDeepSeekPricingSnapshot().isPeak ? "peak" : "" },
			{ label: `AI summaries ${deepSeek.compactionSummary ? "on (paid)" : "off"}` },
		];
		cards.push(card("deepseek", "DeepSeek", deepSeek.balance ? `API account · ${deepSeek.balance}` : "API account · balance n/a", deepSeek.enabled,
			badges,
			[
				{ command: "llamacpp.toggleDeepSeek", label: deepSeek.enabled ? "Disable source" : "Enable source" },
				{ command: "llamacpp.configureDeepSeek", label: "API key", primary: true },
				{ command: "llamacpp.openContextControl", label: "Context sliders" },
				{ command: "llamacpp.toggleDeepSeekCompactionSummary", label: "Toggle AI summaries" },
			]));
	}
	if (codex) {
		const badges = [
			{ label: codex.summary ?? "Checking..." },
		];
		if (codex.usagePercent !== undefined) {
			badges.push({ label: `${codex.usagePercent}% used${codex.usageReset ? ` · resets ${codex.usageReset}` : ""}` });
		}
		cards.push(card("codex", "Codex", codex.summary ?? "ChatGPT subscription account", codex.enabled,
			badges,
			[
				{ command: "llamacpp.toggleCodexSubscription", label: codex.enabled ? "Disable source" : "Enable source" },
				{ command: "llamacpp.codexSignIn", label: "Sign in", primary: true },
				{ command: "llamacpp.codexShowStatus", label: "Account status" },
			]));
	}
	if (claude) {
		const badges = [
			{ label: claude.summary ?? "Checking..." },
			...claude.limits.map(limit => ({ label: limit.description.split(" / ")[0] ?? limit.label })),
		];
		cards.push(card("claude", "Claude", claude.summary ?? "Claude Agent SDK subscription", claude.enabled,
			badges,
			[
				{ command: "llamacpp.toggleClaudeSubscription", label: claude.enabled ? "Disable source" : "Enable source" },
				{ command: "llamacpp.claudeSignIn", label: "Sign in", primary: true },
				{ command: "llamacpp.claudeShowStatus", label: "Account status" },
			]));
	}

	return `
		<div class="status-section">
			<div class="section-title">Built-in providers</div>
			${cards.length === 0
				? '<div class="empty">Provider controls appear after the first activation.</div>'
				: cards.join("")}
		</div>
	`;
}

export function renderApiProviderManagerHtml(state: ApiProviderManagerRenderState): string {
	const nonce = randomBytes(16).toString("base64");
	const builtinCards = renderBuiltinProviders(state);
	const editing = state.editingId
		? state.profiles.find(profile => profile.id === state.editingId)
		: undefined;
	const editingIsNew = state.editingId === "new";
	const formVisible = editingIsNew || editing !== undefined;
	const statusRows = `
		<div class="status-section">
			<div class="section-title">Provider availability</div>
			${state.providers.length === 0
				? '<div class="empty">No provider status yet — recheck after the first activation.</div>'
				: state.providers.map(provider => {
					const stateLabel = { checking: "Checking", off: "Off", unconfigured: "Not configured", online: "Online", offline: "Offline", paused: "Paused" }[provider.state] ?? provider.state;
					return `
				<article class="provider-card status-row">
					<div class="provider-head">
						<div>
							<div class="provider-name">${esc(provider.label)}</div>
							<div class="endpoint">${esc(provider.detail)}</div>
						</div>
						<span class="status ${esc(provider.state)}">${stateLabel}</span>
					</div>
				</article>`;
				}).join("")}
		</div>
	`;

	const form = formVisible
		? `
		<section class="form-card">
			<div class="section-title">${editing ? `Edit ${esc(editing.name)}` : "Add API provider"}</div>
			<div class="grid">
				<label>
					<span>Name</span>
					<input id="provider-name" maxlength="80" value="${escAttr(editing?.name ?? "")}" placeholder="OpenRouter, OpenAI, company gateway…" />
				</label>
				<label>
					<span>Base URL</span>
					<input id="provider-url" value="${escAttr(editing?.baseUrl ?? "")}" placeholder="https://openrouter.ai/api/v1" />
				</label>
				<label>
					<span>API format</span>
					<select id="provider-protocol">
						${selectOption("openai", editing?.protocol ?? "openai", "OpenAI-compatible")}
						${selectOption("deepseek", editing?.protocol ?? "openai", "DeepSeek native")}
						${selectOption("llamacpp", editing?.protocol ?? "openai", "llama.cpp")}
					</select>
					<small>Controls request fields. Gateways such as OpenRouter normally use OpenAI-compatible.</small>
				</label>
				<label>
					<span>Model family</span>
					<select id="provider-family">
						${selectOption("auto", editing?.family ?? "auto", "Auto-detect")}
						${selectOption("openai", editing?.family ?? "auto", "OpenAI / GPT")}
						${selectOption("deepseek", editing?.family ?? "auto", "DeepSeek")}
						${selectOption("qwen", editing?.family ?? "auto", "Qwen")}
						${selectOption("llama", editing?.family ?? "auto", "Llama")}
						${selectOption("mistral", editing?.family ?? "auto", "Mistral")}
						${selectOption("gemma", editing?.family ?? "auto", "Gemma")}
						${selectOption("phi", editing?.family ?? "auto", "Phi")}
					</select>
					<small>Controls context/output defaults independently from the API format.</small>
				</label>
				<label>
					<span>Context length</span>
					<input id="provider-context" type="number" min="4096" max="1048576" step="1024" value="${editing?.contextLength ?? DEFAULT_API_PROVIDER_CONTEXT}" />
				</label>
				<label>
					<span>API key</span>
					<input id="provider-key" type="password" autocomplete="new-password" placeholder="${editing?.hasApiKey ? "Saved — leave blank to keep" : "Optional for keyless endpoints"}" />
					<small>Stored only in VS Code SecretStorage and never displayed again.</small>
				</label>
			</div>
			<div class="form-options">
				<label class="check"><input id="provider-enabled" type="checkbox"${editing?.enabled !== false ? " checked" : ""} /> Enabled</label>
				${editing?.hasApiKey ? '<label class="check danger-text"><input id="provider-clear-key" type="checkbox" /> Delete saved API key</label>' : ""}
			</div>
			<div class="actions">
				<button id="save-btn" class="primary" type="button">Save provider</button>
				<button id="cancel-btn" type="button">Cancel</button>
			</div>
		</section>`
		: "";

	const cards = state.profiles.length === 0
		? '<div class="empty">No custom API providers yet. Add an OpenAI-compatible endpoint to load its models into the VS Code model picker.</div>'
		: state.profiles.map(profile => `
		<article class="provider-card${profile.enabled ? "" : " disabled"}">
			<div class="provider-head">
				<div>
					<div class="provider-name">${esc(profile.name)}</div>
					<div class="endpoint" title="${escAttr(profile.baseUrl)}">${esc(profile.baseUrl)}</div>
				</div>
				<span class="status ${profile.enabled ? "on" : "off"}">${profile.enabled ? "Enabled" : "Disabled"}</span>
			</div>
			<div class="badges">
				<span>${esc(profile.protocol)}</span>
				<span>family: ${esc(profile.family)}</span>
				<span>ctx ${profile.contextLength.toLocaleString("en-US")}</span>
				<span class="${profile.hasApiKey ? "key-set" : ""}">${profile.hasApiKey ? "key saved" : "no key"}</span>
			</div>
			<div class="actions">
				<button class="toggle-btn" data-id="${escAttr(profile.id)}" data-enabled="${profile.enabled}" type="button">${profile.enabled ? "Disable" : "Enable"}</button>
				<button class="edit-btn" data-id="${escAttr(profile.id)}" type="button">Edit</button>
				<button class="delete-btn danger" data-id="${escAttr(profile.id)}" type="button">Delete</button>
			</div>
		</article>`).join("");

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>Providers Manager</title>
	<style>
		:root { color-scheme: light dark; }
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; max-width: 1000px; margin: 0 auto; }
		h1 { font-size: 24px; margin: 0; }
		.subtitle { color: var(--vscode-descriptionForeground); margin: 7px 0 18px; line-height: 1.5; }
		.toolbar, .provider-head, .actions, .form-options { display: flex; align-items: center; gap: 8px; }
		.toolbar { justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; }
		button, input, select { font: inherit; }
		button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 6px 11px; border-radius: 3px; cursor: pointer; }
		button:hover { background: var(--vscode-button-secondaryHoverBackground); }
		button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		button.primary:hover { background: var(--vscode-button-hoverBackground); }
		button.danger { color: var(--vscode-errorForeground); }
		.notice { border-left: 3px solid var(--vscode-textLink-foreground); background: var(--vscode-textBlockQuote-background); padding: 10px 12px; margin-bottom: 18px; line-height: 1.45; }
		.provider-card, .form-card { border: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); border-radius: 6px; padding: 14px; margin-bottom: 12px; }
		.provider-card.disabled { opacity: .68; }
		.provider-head { justify-content: space-between; gap: 18px; }
		.provider-name { font-weight: 600; font-size: 15px; }
		.endpoint { color: var(--vscode-descriptionForeground); margin-top: 4px; overflow-wrap: anywhere; }
		.status, .badges span { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 2px 8px; font-size: 12px; white-space: nowrap; }
		.status.on, .key-set, .status.online { color: var(--vscode-testing-iconPassed); }
		.status.off, .status.unconfigured, .status.checking { color: var(--vscode-descriptionForeground); }
		.status.offline { color: var(--vscode-errorForeground); }
		.status.paused { color: var(--vscode-charts-yellow, #e2c08d); }
		.status-section { margin-bottom: 20px; }
		.status-section .provider-card { margin-bottom: 8px; }
		.badges { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
		.section-title { font-weight: 600; font-size: 16px; margin-bottom: 14px; }
		.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 13px; }
		label > span { display: block; margin-bottom: 5px; }
		input, select { box-sizing: border-box; width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); padding: 7px 8px; border-radius: 2px; }
		small { display: block; color: var(--vscode-descriptionForeground); margin-top: 5px; line-height: 1.35; }
		.form-options { margin: 14px 0; flex-wrap: wrap; }
		.check { display: inline-flex; align-items: center; gap: 6px; }
		.check input { width: auto; }
		.danger-text, .error { color: var(--vscode-errorForeground); }
		.message { min-height: 20px; margin: 8px 0; }
		.success { color: var(--vscode-testing-iconPassed); }
		.empty { border: 1px dashed var(--vscode-panel-border); color: var(--vscode-descriptionForeground); padding: 24px; text-align: center; border-radius: 6px; }
		code { font-family: var(--vscode-editor-font-family); }
	</style>
</head>
<body>
	<h1>Providers Manager</h1>
	<p class="subtitle">One place for every model source: Local LLM, DeepSeek, Codex, Claude, and custom API endpoints.</p>
	<div class="notice"><strong>Availability is checked automatically.</strong> HTTP sources are probed every 5 minutes; subscription states refresh on their own. Offline providers are hidden from Quick Access and their reason is shown here.</div>
	<div class="toolbar">
		<div><strong>${state.profiles.filter(profile => profile.enabled).length}</strong> active · ${state.profiles.length} configured</div>
		<div class="actions">
			<button id="refresh-models-btn" type="button">Refresh models</button>
			<button id="recheck-btn" type="button">Recheck availability</button>
			<button id="add-btn" class="primary" type="button">Add provider</button>
		</div>
	</div>
	<div class="message ${state.error ? "error" : "success"}">${esc(state.error ?? state.status ?? "")}</div>
	${form}
	${builtinCards}
	${statusRows}
	<div id="providers">${cards}</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.getElementById('add-btn').addEventListener('click', () => vscode.postMessage({ type: 'new' }));
		document.getElementById('refresh-models-btn').addEventListener('click', () => vscode.postMessage({ type: 'refreshModels' }));
		document.getElementById('recheck-btn').addEventListener('click', () => vscode.postMessage({ type: 'recheck' }));
		document.querySelectorAll('.edit-btn').forEach(button => button.addEventListener('click', () => vscode.postMessage({ type: 'edit', id: button.dataset.id })));
		document.querySelectorAll('.delete-btn').forEach(button => button.addEventListener('click', () => vscode.postMessage({ type: 'delete', id: button.dataset.id })));
		document.querySelectorAll('.toggle-btn').forEach(button => button.addEventListener('click', () => vscode.postMessage({
			type: 'toggle',
			id: button.dataset.id,
			enabled: button.dataset.enabled !== 'true',
		})));
		document.querySelectorAll('.ctrl-btn').forEach(button => button.addEventListener('click', () => vscode.postMessage({
			type: 'runCommand',
			command: button.dataset.command,
		})));
		const cancel = document.getElementById('cancel-btn');
		if (cancel) cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
		const save = document.getElementById('save-btn');
		if (save) save.addEventListener('click', () => vscode.postMessage({
			type: 'save',
			provider: {
				id: ${editing ? JSON.stringify(editing.id) : "undefined"},
				name: document.getElementById('provider-name').value,
				baseUrl: document.getElementById('provider-url').value,
				protocol: document.getElementById('provider-protocol').value,
				family: document.getElementById('provider-family').value,
				contextLength: Number(document.getElementById('provider-context').value),
				enabled: document.getElementById('provider-enabled').checked,
			},
			apiKey: document.getElementById('provider-key').value,
			clearApiKey: document.getElementById('provider-clear-key')?.checked === true,
		}));
	</script>
</body>
</html>`;
}

interface ApiProviderManagerMessage {
	type?: string;
	id?: string;
	enabled?: boolean;
	command?: string;
	provider?: ApiProviderDraft;
	apiKey?: string;
	clearApiKey?: boolean;
}

export class ApiProviderManagerPanel {
	static readonly viewType = "llamacpp.apiProviders";
	private static current: ApiProviderManagerPanel | undefined;

	private editingId: string | undefined;
	private status: string | undefined;
	private error: string | undefined;
	private renderSequence = 0;
	private readonly disposables: vscode.Disposable[] = [];

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly service: ApiProviderService,
		private readonly directory: ProviderDirectory,
		private readonly refreshModels: () => void,
		private readonly getExtras?: () => ProviderManagerLiveData
	) {
		this.disposables.push(
			this.service.onDidChange(() => void this.render()),
			this.directory.onDidChange(() => void this.render()),
			this.panel.webview.onDidReceiveMessage(message => void this.handleMessage(message)),
			this.panel.onDidDispose(() => {
				ApiProviderManagerPanel.current = undefined;
				for (const disposable of this.disposables) {
					disposable.dispose();
				}
			})
		);
		void this.render();
	}

	static createOrShow(
		service: ApiProviderService,
		directory: ProviderDirectory,
		refreshModels: () => void,
		getExtras?: () => ProviderManagerLiveData
	): void {
		if (ApiProviderManagerPanel.current) {
			ApiProviderManagerPanel.current.panel.reveal(vscode.ViewColumn.Beside);
			void ApiProviderManagerPanel.current.render();
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			ApiProviderManagerPanel.viewType,
			"AI Agent Bridge · Providers Manager",
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				enableFindWidget: true,
				retainContextWhenHidden: true,
			}
		);
		ApiProviderManagerPanel.current = new ApiProviderManagerPanel(panel, service, directory, refreshModels, getExtras);
	}

	static refreshIfOpen(): void {
		void ApiProviderManagerPanel.current?.render();
	}

	private async handleMessage(message: unknown): Promise<void> {
		if (!message || typeof message !== "object") {
			return;
		}
		const data = message as ApiProviderManagerMessage;
		this.error = undefined;
		this.status = undefined;
		try {
			switch (data.type) {
				case "new":
					this.editingId = "new";
					break;
				case "edit":
					this.editingId = String(data.id ?? "");
					break;
				case "cancel":
					this.editingId = undefined;
					break;
				case "toggle":
					await this.service.setEnabled(String(data.id ?? ""), data.enabled === true);
					this.status = data.enabled ? "Provider enabled." : "Provider disabled.";
					this.refreshModels();
					break;
				case "delete": {
					const profile = this.service.get(String(data.id ?? ""));
					if (!profile) {
						throw new Error("The API provider no longer exists.");
					}
					const confirmation = await vscode.window.showWarningMessage(
						`Delete API provider "${profile.name}" and its saved key?`,
						{ modal: true },
						"Delete"
					);
					if (confirmation !== "Delete") {
						return;
					}
					await this.service.remove(profile.id);
					if (this.editingId === profile.id) {
						this.editingId = undefined;
					}
					this.status = `Deleted ${profile.name}.`;
					this.refreshModels();
					break;
				}
				case "save": {
					if (!data.provider) {
						throw new Error("Provider data is missing.");
					}
					const profile = await this.service.upsert(data.provider, {
						apiKey: data.apiKey,
						clearApiKey: data.clearApiKey,
					});
					this.editingId = undefined;
					this.status = `Saved ${profile.name}.`;
					this.refreshModels();
					break;
				}
				case "refreshModels":
					this.refreshModels();
					this.status = "Model catalogs are refreshing.";
					break;
				case "recheck":
					await this.directory.recheck();
					this.status = "Provider availability rechecked.";
					break;
				case "runCommand": {
					const command = String(data.command ?? "").trim();
					if (!command || !command.startsWith("llamacpp.")) {
						throw new Error("Unknown provider action.");
					}
					await vscode.commands.executeCommand(command);
					this.status = "Action executed.";
					break;
				}
				default:
					return;
			}
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		}
		await this.render();
	}

	private buildExtras(): ProviderManagerExtras {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const localEnabled = config.get<boolean>("enableLocalServer", true) !== false;
		const localEndpoint = String(config.get("localServerUrl", DEFAULT_SERVER_URL) ?? DEFAULT_SERVER_URL);
		const deepSeekEnabled = config.get<boolean>("enableDeepSeek", true) !== false;
		const deepSeekCompactionSummary = config.get<boolean>("deepSeekCompactionSummary", false) === true;
		const codexEnabled = config.get<boolean>("enableCodexSubscription", true) !== false;
		const claudeEnabled = config.get<boolean>("enableClaudeSubscription", true) !== false;
		const live = this.getExtras?.() ?? {};
		const pricing = resolveDeepSeekPricingSnapshot();
		const peakHours = pricing.state === "flat"
			? `Peak billing starts ${formatDeepSeekPeakEffectiveLocal()} (local)`
			: pricing.isPeak
				? `Peak · 2× price · until ${pricing.nextTransitionLocal} (local)`
				: `Off-peak · ½ price · next peak ${pricing.nextTransitionLocal} (local)`;
		return {
			local: { enabled: localEnabled, endpoint: localEndpoint },
			deepSeek: {
				enabled: deepSeekEnabled,
				compactionSummary: deepSeekCompactionSummary,
				balance: live.deepSeek?.balance,
				peakHours,
			},
			codex: {
				enabled: codexEnabled,
				summary: live.codex?.summary,
				usagePercent: live.codex?.usagePercent,
				usageReset: live.codex?.usageReset,
			},
			claude: {
				enabled: claudeEnabled,
				summary: live.claude?.summary,
				limits: live.claude?.limits ?? [],
			},
		};
	}

	private async render(): Promise<void> {
		const sequence = ++this.renderSequence;
		const profiles = await this.service.listSummaries();
		if (sequence !== this.renderSequence) {
			return;
		}
		this.panel.webview.html = renderApiProviderManagerHtml({
			profiles,
			providers: this.directory.list(),
			extras: this.buildExtras(),
			editingId: this.editingId,
			status: this.status,
			error: this.error,
		});
	}
}
