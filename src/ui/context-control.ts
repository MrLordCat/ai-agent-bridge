import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import {
	CLAUDE_CONTEXT_TARGET_MAX,
	CLAUDE_CONTEXT_TARGET_MIN,
} from "../claude/claude-provider";
import { CODEX_WORKING_CONTEXT_MIN } from "../codex/codex-provider";
import type { CodexContextWindowSource, CodexFollowReason, CodexFollowTarget, CodexModelContextWindow } from "../codex/context-windows";
import { CONFIG_SECTION } from "../constants";
import {
	getFollowedCodexContext,
	onDidChangeFollowedCodexContext,
	resolveManualSharedContextLimit,
	resolveSharedContextLimit,
	SHARED_CONTEXT_MAX,
} from "../context/provider-handoff";
import { clampInteger, formatTokenCount } from "../utils";
import type { ProviderRuntimeMetrics } from "../provider-metrics";

const DEEPSEEK_CONTEXT_MIN = 32_768;
const DEEPSEEK_CONTEXT_MAX = 1_048_576;
const DEEPSEEK_MAX_OUTPUT_MIN = 1_024;
const DEEPSEEK_MAX_OUTPUT_MAX = 393_216;

export interface ContextControlState {
	/** One working context for Codex, Claude, Coco and Cursor. */
	sharedTarget: number;
	sharedMinimum: number;
	sharedMaximum: number;
	/** The stored slider value; equals sharedTarget unless the limit follows Codex. */
	manualSharedTarget: number;
	followCodex: boolean;
	/** Codex model and Codex-reported window the shared context follows, once known. */
	followedCodexModelId?: string;
	followedCodexWindow?: number;
	/** Why that model is followed: last used, Codex default, or largest known window. */
	followedCodexReason?: CodexFollowReason;
	claudeTarget: number;
	claudeMinimum: number;
	claudeMaximum: number;
	codexTarget: number;
	/** Window of the followed Codex model, or runtime metrics, or the fallback setting. */
	codexMaximum: number;
	codexMaximumObserved: boolean;
	codexMaximumSource: CodexContextWindowSource;
	codexModels: CodexModelContextWindow[];
	/** Largest window among Codex models known from Codex itself. */
	codexLargest?: CodexModelContextWindow;
	deepSeekContextTarget: number;
	deepSeekContextMinimum: number;
	deepSeekContextMaximum: number;
	deepSeekMaxOutputTarget: number;
	deepSeekMaxOutputMinimum: number;
	deepSeekMaxOutputMaximum: number;
}

export interface CodexContextSnapshot {
	models: readonly CodexModelContextWindow[];
	/** Last used model, else Codex's default, else the largest known window. */
	followTarget?: CodexFollowTarget;
}

export function resolveContextControlState(
	configuration: Pick<vscode.WorkspaceConfiguration, "get">,
	codexMetrics?: ProviderRuntimeMetrics,
	codex?: CodexContextSnapshot
): ContextControlState {
	const configuredCodexWindow = clampInteger(
		configuration.get("codexContextLength", 258_400),
		CODEX_WORKING_CONTEXT_MIN,
		1_048_576,
		258_400
	);
	const observedCodexWindow = codexMetrics?.contextWindowTokens;
	const hasObservedCodexWindow = Number.isFinite(observedCodexWindow) && (observedCodexWindow ?? 0) > 0;
	const target = codex?.followTarget;
	const targetWindow = target
		? codex?.models.find(model => model.modelId === target.modelId && model.source !== "fallback")
		: undefined;
	const codexMaximumSource: CodexContextWindowSource = targetWindow?.source ?? (hasObservedCodexWindow ? "server" : "fallback");
	const codexMaximum = targetWindow
		? Math.max(CODEX_WORKING_CONTEXT_MIN, Math.floor(targetWindow.window))
		: hasObservedCodexWindow
			? Math.max(CODEX_WORKING_CONTEXT_MIN, Math.floor(observedCodexWindow!))
			: configuredCodexWindow;
	const codexModels = [...(codex?.models ?? [])];
	const codexLargest = codexModels
		.filter(model => model.source !== "fallback")
		.reduce<CodexModelContextWindow | undefined>((best, model) => !best || model.window > best.window ? model : best, undefined);
	const followCodex = configuration.get<boolean>("sharedContextFollowCodex", false) === true;
	const followed = getFollowedCodexContext();
	const sharedTarget = clampInteger(resolveSharedContextLimit(configuration), CODEX_WORKING_CONTEXT_MIN, SHARED_CONTEXT_MAX, CODEX_WORKING_CONTEXT_MIN);
	return {
		sharedTarget,
		sharedMinimum: CODEX_WORKING_CONTEXT_MIN,
		sharedMaximum: SHARED_CONTEXT_MAX,
		manualSharedTarget: clampInteger(resolveManualSharedContextLimit(configuration), CODEX_WORKING_CONTEXT_MIN, SHARED_CONTEXT_MAX, CODEX_WORKING_CONTEXT_MIN),
		followCodex,
		followedCodexModelId: followed?.modelId,
		followedCodexWindow: followed ? clampInteger(followed.window, CODEX_WORKING_CONTEXT_MIN, SHARED_CONTEXT_MAX, CODEX_WORKING_CONTEXT_MIN) : undefined,
		followedCodexReason: followed && followed.modelId === target?.modelId ? target.reason : undefined,
		claudeTarget: clampInteger(sharedTarget, CLAUDE_CONTEXT_TARGET_MIN, CLAUDE_CONTEXT_TARGET_MAX, CLAUDE_CONTEXT_TARGET_MIN),
		claudeMinimum: CLAUDE_CONTEXT_TARGET_MIN,
		claudeMaximum: CLAUDE_CONTEXT_TARGET_MAX,
		codexTarget: Math.min(sharedTarget, codexMaximum),
		codexMaximum,
		codexMaximumObserved: codexMaximumSource === "server",
		codexMaximumSource,
		codexModels,
		codexLargest,
		deepSeekContextTarget: clampInteger(
			configuration.get("deepSeekContextLength", 258_400),
			DEEPSEEK_CONTEXT_MIN,
			DEEPSEEK_CONTEXT_MAX,
			258_400
		),
		deepSeekContextMinimum: DEEPSEEK_CONTEXT_MIN,
		deepSeekContextMaximum: DEEPSEEK_CONTEXT_MAX,
		deepSeekMaxOutputTarget: clampInteger(
			configuration.get("deepSeekDefaultMaxOutputTokens", 70_000),
			DEEPSEEK_MAX_OUTPUT_MIN,
			DEEPSEEK_MAX_OUTPUT_MAX,
			70_000
		),
		deepSeekMaxOutputMinimum: DEEPSEEK_MAX_OUTPUT_MIN,
		deepSeekMaxOutputMaximum: DEEPSEEK_MAX_OUTPUT_MAX,	};
}

export function registerContextControlCommand(
	getCodexMetrics: () => ProviderRuntimeMetrics | undefined,
	refresh: () => void,
	getCodexContext?: () => CodexContextSnapshot
): vscode.Disposable {
	let panel: vscode.WebviewPanel | undefined;
	const currentState = () => resolveContextControlState(
		vscode.workspace.getConfiguration(CONFIG_SECTION),
		getCodexMetrics(),
		getCodexContext?.()
	);
	return vscode.Disposable.from(onDidChangeFollowedCodexContext(() => {
		if (!panel) {
			return;
		}
		const state = currentState();
		void panel.webview.postMessage({
			type: "followed",
			window: state.followedCodexWindow ?? 0,
			codexMaximum: state.codexMaximum,
			label: formatFollowedLabel(state),
		});
	}), vscode.commands.registerCommand("llamacpp.openContextControl", () => {
		if (panel) {
			panel.reveal(vscode.ViewColumn.Active);
			panel.webview.html = renderContextControl(panel.webview, currentState());
			return;
		}
		panel = vscode.window.createWebviewPanel(
			"llamacpp.contextControl",
			"Provider Context",
			vscode.ViewColumn.Active,
			{ enableScripts: true }
		);
		panel.webview.html = renderContextControl(panel.webview, currentState());
		panel.webview.onDidReceiveMessage(async (message: unknown) => {
			if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "save") {
				return;
			}
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = currentState();
			const followCodex = (message as { followCodex?: unknown }).followCodex === true;
			const sharedTarget = clampInteger(
				(message as { sharedTarget?: unknown }).sharedTarget,
				current.sharedMinimum,
				current.sharedMaximum,
				current.manualSharedTarget
			);
			const deepSeekContextTarget = clampInteger(
				(message as { deepSeekContextTarget?: unknown }).deepSeekContextTarget,
				current.deepSeekContextMinimum,
				current.deepSeekContextMaximum,
				current.deepSeekContextTarget
			);
			const deepSeekMaxOutputTarget = clampInteger(
				(message as { deepSeekMaxOutputTarget?: unknown }).deepSeekMaxOutputTarget,
				current.deepSeekMaxOutputMinimum,
				current.deepSeekMaxOutputMaximum,
				current.deepSeekMaxOutputTarget
			);
			await Promise.all([
				// Following Codex keeps the stored slider value for when the toggle is turned off.
				...(followCodex ? [] : [config.update("sharedContextLength", sharedTarget, vscode.ConfigurationTarget.Global)]),
				...(followCodex !== current.followCodex ? [config.update("sharedContextFollowCodex", followCodex, vscode.ConfigurationTarget.Global)] : []),
				config.update("deepSeekContextLength", deepSeekContextTarget, vscode.ConfigurationTarget.Global),
				config.update("deepSeekDefaultMaxOutputTokens", deepSeekMaxOutputTarget, vscode.ConfigurationTarget.Global),
			]);
			refresh();
			const saved = currentState();
			void panel?.webview.postMessage({
				type: "saved",
				sharedTarget: saved.sharedTarget,
				deepSeekContextTarget,
				deepSeekMaxOutputTarget,
			});
			vscode.window.showInformationMessage(
				`Shared context ${formatTokenCount(saved.sharedTarget)}${saved.followCodex ? " (follows Codex)" : ""} · Codex ${formatTokenCount(saved.codexTarget)} · Claude ${formatTokenCount(saved.claudeTarget)} · DeepSeek ctx ${formatTokenCount(deepSeekContextTarget)} · out ${formatTokenCount(deepSeekMaxOutputTarget)}`
			);
		}, undefined);
		panel.onDidDispose(() => {
			panel = undefined;
		});
	}));
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);
}

const CODEX_WINDOW_SOURCE_LABELS: Record<CodexContextWindowSource, string> = {
	server: "reported by Codex in a turn",
	catalog: "Codex model catalog",
	fallback: "fallback setting",
};

const CODEX_FOLLOW_REASON_LABELS: Record<CodexFollowReason, string> = {
	lastUsed: "last used",
	default: "Codex default",
	largest: "largest known",
};

function formatFollowedLabel(state: ContextControlState): string {
	if (!state.followedCodexModelId || !state.followedCodexWindow) {
		return "no Codex window known yet";
	}
	const reason = state.followedCodexReason ? `${CODEX_FOLLOW_REASON_LABELS[state.followedCodexReason]} model ` : "";
	return `${reason}${state.followedCodexModelId}, ${formatTokenCount(state.followedCodexWindow)}`;
}

function renderCodexWindows(state: ContextControlState): string {
	const tag = state.followedCodexReason ? CODEX_FOLLOW_REASON_LABELS[state.followedCodexReason] : "followed";
	const rows = [...state.codexModels]
		.sort((left, right) => right.window - left.window || left.modelId.localeCompare(right.modelId))
		.map(model => `<tr${model.modelId === state.followedCodexModelId ? ' class="current"' : ""}><td>${escapeHtml(model.modelId)}${model.modelId === state.followedCodexModelId ? ` <span class="tag">${tag}</span>` : ""}</td><td>${formatTokenCount(model.window)}</td><td>${CODEX_WINDOW_SOURCE_LABELS[model.source]}</td></tr>`)
		.join("");
	const largest = state.codexLargest
		? `${formatTokenCount(state.codexLargest.window)} <small>${escapeHtml(state.codexLargest.modelId)}</small>`
		: "unknown";
	return `<section class="card">
		<div class="row"><h2>Codex model windows</h2><span class="value">max ${largest}</span></div>
		${rows ? `<table><thead><tr><th>Model</th><th>Window</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No Codex models listed yet.</p>"}
		<p>Codex has the smallest window of the native agents and it depends on the model. The catalog value is context_window × effective percent from Codex's models_cache.json; a value reported during a turn replaces it.</p>
	</section>`;
}

function renderContextControl(webview: vscode.Webview, state: ContextControlState): string {
	const nonce = randomBytes(16).toString("base64");
	const followedLabel = escapeHtml(formatFollowedLabel(state));
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Provider Context</title>
	<style>
		body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size) var(--vscode-font-family); padding: 24px; max-width: 760px; margin: 0 auto; }
		h1 { font-size: 22px; margin: 0 0 8px; }
		.lead { color: var(--vscode-descriptionForeground); margin: 0 0 24px; }
		.card { border: 1px solid var(--vscode-widget-border); background: var(--vscode-sideBar-background); border-radius: 8px; padding: 18px; margin: 14px 0; }
		.row { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
		h2 { font-size: 16px; margin: 0; }
		.value { font-size: 20px; font-weight: 600; color: var(--vscode-textLink-foreground); }
		input[type=range] { width: 100%; margin: 18px 0 8px; accent-color: var(--vscode-progressBar-background); }
		.bounds { display: flex; justify-content: space-between; color: var(--vscode-descriptionForeground); font-size: 12px; }
		p { line-height: 1.5; color: var(--vscode-descriptionForeground); }
		button { margin-top: 14px; border: 0; padding: 8px 18px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-radius: 2px; cursor: pointer; }
		button:hover { background: var(--vscode-button-hoverBackground); }
		#status { margin-left: 12px; color: var(--vscode-testing-iconPassed); }
		.toggle { display: flex; align-items: center; gap: 8px; margin-top: 12px; color: var(--vscode-foreground); cursor: pointer; }
		input[type=range]:disabled { opacity: .5; }
		table { width: 100%; border-collapse: collapse; margin-top: 12px; }
		th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-widget-border); }
		th { color: var(--vscode-descriptionForeground); font-weight: normal; }
		tr.current td { color: var(--vscode-textLink-foreground); }
		.tag, small { color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: normal; }
	</style>
</head><span id="followedLabel">${followedLabel}</span>
<body>
	<h1>Provider working context</h1>
	<p class="lead">Changes apply to new provider sessions. Existing durable transcripts remain available.</p>
	<section class="card">
		<div class="row"><h2>Shared context: Codex, Claude, Coco, Cursor</h2><span class="value" id="sharedValue"></span></div>
		<input id="shared" type="range" min="${state.sharedMinimum}" max="${state.sharedMaximum}" step="1" value="${state.sharedTarget}">
		<div class="bounds"><span>${formatTokenCount(state.sharedMinimum)}</span><span>${formatTokenCount(state.sharedMaximum)}</span></div>
		<label class="toggle"><input id="followCodex" type="checkbox"${state.followCodex ? " checked" : ""}> Follow the Codex window (${followedLabel})</label>
		<p id="followNote"></p>
		<p>One working context for every native agent, so a switch after a rate limit keeps the same history budget. Each provider uses min(limit, its real model window) as its window and native auto-compaction threshold.</p>
		<p id="effective"></p>
	</section>
	${renderCodexWindows(state)}
	<section class="card">
		<div class="row"><h2>DeepSeek context</h2><span class="value" id="deepSeekContextValue"></span></div>
		<input id="deepSeekContext" type="range" min="${state.deepSeekContextMinimum}" max="${state.deepSeekContextMaximum}" step="1024" value="${state.deepSeekContextTarget}">
		<div class="bounds"><span>${formatTokenCount(state.deepSeekContextMinimum)}</span><span>${formatTokenCount(state.deepSeekContextMaximum)}</span></div>
		<p>Maximum context window advertised to VS Code for DeepSeek requests. Independent of the local Qwen window; applies to new requests.</p>
	</section>
	<section class="card">
		<div class="row"><h2>DeepSeek max output</h2><span class="value" id="deepSeekOutputValue"></span></div>
		<input id="deepSeekOutput" type="range" min="${state.deepSeekMaxOutputMinimum}" max="${state.deepSeekMaxOutputMaximum}" step="1024" value="${state.deepSeekMaxOutputTarget}">
		<div class="bounds"><span>${formatTokenCount(state.deepSeekMaxOutputMinimum)}</span><span>${formatTokenCount(state.deepSeekMaxOutputMaximum)}</span></div>
		<p>Default max_tokens per DeepSeek request when the chat does not provide an explicit limit. Reasoning tokens count toward this budget; raise only if long answers get cut.</p>
	</section>
	<button id="save">Apply</button><span id="status"></span>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const shared = document.getElementById('shared');
		const deepSeekContext = document.getElementById('deepSeekContext');
		const deepSeekOutput = document.getElementById('deepSeekOutput');
		const compact = value => value >= 1000000 ? (value / 1000000).toFixed(2).replace(/\\.00$/, '') + 'M' : (value / 1000).toFixed(1).replace(/\\.0$/, '') + 'k';
		let codexMaximum = ${state.codexMaximum};
		const claudeMinimum = ${state.claudeMinimum}, claudeMaximum = ${state.claudeMaximum};
		const followCodex = document.getElementById('followCodex');
		const manualTarget = ${state.manualSharedTarget};
		let followedWindow = ${state.followedCodexWindow ?? 0};
		const applyFollow = () => {
			shared.disabled = followCodex.checked;
			shared.value = String(followCodex.checked && followedWindow > 0 ? followedWindow : manualTarget);
			document.getElementById('followNote').textContent = !followCodex.checked ? ''
				: followedWindow > 0 ? 'The shared context follows the last used Codex model (before the first use: the Codex default model, else the largest known window), including a smaller window after switching models. Press Apply to save. Changing it rewrites the Claude and Coco prompt caches once.'
				: 'Until Codex catalogs or reports a model window, the slider value ' + compact(manualTarget) + ' applies.';
		};
		const update = () => {
			const value = Number(shared.value);
			document.getElementById('sharedValue').textContent = compact(value);
			document.getElementById('effective').textContent = 'Effective: Codex ' + compact(Math.min(value, codexMaximum))
				+ ' (${CODEX_WINDOW_SOURCE_LABELS[state.codexMaximumSource]} window ' + compact(codexMaximum) + ') · Claude '
				+ compact(Math.min(claudeMaximum, Math.max(claudeMinimum, value))) + ' (bounds ' + compact(claudeMinimum) + '–' + compact(claudeMaximum)
				+ ') · Coco and Cursor up to ' + compact(value) + ', capped by each model window.';
			document.getElementById('deepSeekContextValue').textContent = compact(Number(deepSeekContext.value));
			document.getElementById('deepSeekOutputValue').textContent = compact(Number(deepSeekOutput.value));
			document.getElementById('status').textContent = '';
		};
		shared.addEventListener('input', update);
		followCodex.addEventListener('change', () => { applyFollow(); update(); });
		deepSeekContext.addEventListener('input', update);
		deepSeekOutput.addEventListener('input', update);
		document.getElementById('save').addEventListener('click', () => vscode.postMessage({ type: 'save', followCodex: followCodex.checked, sharedTarget: Number(followCodex.checked ? manualTarget : shared.value), deepSeekContextTarget: Number(deepSeekContext.value), deepSeekMaxOutputTarget: Number(deepSeekOutput.value) }));
		window.addEventListener('message', event => {
			if (event.data?.type === 'saved') document.getElementById('status').textContent = 'Saved';
			if (event.data?.type === 'followed') {
				// Keeps unsaved slider edits: only the followed window and its label change.
				followedWindow = Number(event.data.window) || 0;
				codexMaximum = Number(event.data.codexMaximum) || codexMaximum;
				document.getElementById('followedLabel').textContent = String(event.data.label ?? '');
				applyFollow();
				update();
			}
		});
		applyFollow();
		update();
	</script>
</body>
</html>`;
}