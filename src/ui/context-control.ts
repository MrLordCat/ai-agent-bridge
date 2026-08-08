import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import {
	CLAUDE_CONTEXT_TARGET_MAX,
	CLAUDE_CONTEXT_TARGET_MIN,
} from "../claude/claude-provider";
import { CODEX_WORKING_CONTEXT_MIN } from "../codex/codex-provider";
import { CONFIG_SECTION } from "../constants";
import { clampInteger, formatTokenCount } from "../utils";
import type { ProviderRuntimeMetrics } from "../provider-metrics";

const DEEPSEEK_CONTEXT_MIN = 32_768;
const DEEPSEEK_CONTEXT_MAX = 1_048_576;
const DEEPSEEK_MAX_OUTPUT_MIN = 1_024;
const DEEPSEEK_MAX_OUTPUT_MAX = 393_216;

export interface ContextControlState {
	claudeTarget: number;
	claudeMinimum: number;
	claudeMaximum: number;
	codexTarget: number;
	codexMinimum: number;
	codexMaximum: number;
	codexMaximumObserved: boolean;
	deepSeekContextTarget: number;
	deepSeekContextMinimum: number;
	deepSeekContextMaximum: number;
	deepSeekMaxOutputTarget: number;
	deepSeekMaxOutputMinimum: number;
	deepSeekMaxOutputMaximum: number;
}


export function resolveContextControlState(
	configuration: Pick<vscode.WorkspaceConfiguration, "get">,
	codexMetrics?: ProviderRuntimeMetrics
): ContextControlState {
	const configuredCodexWindow = clampInteger(
		configuration.get("codexContextLength", 258_400),
		CODEX_WORKING_CONTEXT_MIN,
		1_048_576,
		258_400
	);
	const observedCodexWindow = codexMetrics?.contextWindowTokens;
	const hasObservedCodexWindow = Number.isFinite(observedCodexWindow) && (observedCodexWindow ?? 0) > 0;
	const codexMaximum = hasObservedCodexWindow
		? Math.max(CODEX_WORKING_CONTEXT_MIN, Math.floor(observedCodexWindow!))
		: configuredCodexWindow;
	return {
		claudeTarget: clampInteger(
			configuration.get("claudeContextLength", CLAUDE_CONTEXT_TARGET_MIN),
			CLAUDE_CONTEXT_TARGET_MIN,
			CLAUDE_CONTEXT_TARGET_MAX,
			CLAUDE_CONTEXT_TARGET_MIN
		),
		claudeMinimum: CLAUDE_CONTEXT_TARGET_MIN,
		claudeMaximum: CLAUDE_CONTEXT_TARGET_MAX,
		codexTarget: clampInteger(
			configuration.get("codexWorkingContextTarget", codexMaximum),
			CODEX_WORKING_CONTEXT_MIN,
			codexMaximum,
			codexMaximum
		),
		codexMinimum: CODEX_WORKING_CONTEXT_MIN,
		codexMaximum,
		codexMaximumObserved: hasObservedCodexWindow,		deepSeekContextTarget: clampInteger(
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
	refresh: () => void
): vscode.Disposable {
	let panel: vscode.WebviewPanel | undefined;
	return vscode.commands.registerCommand("llamacpp.openContextControl", () => {
		if (panel) {
			panel.reveal(vscode.ViewColumn.Active);
			panel.webview.html = renderContextControl(panel.webview, resolveContextControlState(
				vscode.workspace.getConfiguration(CONFIG_SECTION),
				getCodexMetrics()
			));
			return;
		}
		panel = vscode.window.createWebviewPanel(
			"llamacpp.contextControl",
			"Provider Context",
			vscode.ViewColumn.Active,
			{ enableScripts: true }
		);
		panel.webview.html = renderContextControl(panel.webview, resolveContextControlState(
			vscode.workspace.getConfiguration(CONFIG_SECTION),
			getCodexMetrics()
		));
		panel.webview.onDidReceiveMessage(async (message: unknown) => {
			if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "save") {
				return;
			}
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const current = resolveContextControlState(config, getCodexMetrics());
			const claudeTarget = clampInteger(
				(message as { claudeTarget?: unknown }).claudeTarget,
				current.claudeMinimum,
				current.claudeMaximum,
				current.claudeTarget
			);
			const codexTarget = clampInteger(
				(message as { codexTarget?: unknown }).codexTarget,
				current.codexMinimum,
				current.codexMaximum,
				current.codexTarget
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
				config.update("claudeContextLength", claudeTarget, vscode.ConfigurationTarget.Global),
				config.update("codexWorkingContextTarget", codexTarget, vscode.ConfigurationTarget.Global),
				config.update("deepSeekContextLength", deepSeekContextTarget, vscode.ConfigurationTarget.Global),
				config.update("deepSeekDefaultMaxOutputTokens", deepSeekMaxOutputTarget, vscode.ConfigurationTarget.Global),
			]);
			refresh();
			void panel?.webview.postMessage({
				type: "saved",
				claudeTarget,
				codexTarget,
				deepSeekContextTarget,
				deepSeekMaxOutputTarget,
			});
			vscode.window.showInformationMessage(
				`Provider limits: Claude ${formatTokenCount(claudeTarget)} · Codex ${formatTokenCount(codexTarget)} · DeepSeek ctx ${formatTokenCount(deepSeekContextTarget)} · out ${formatTokenCount(deepSeekMaxOutputTarget)}`
			);
		}, undefined);
		panel.onDidDispose(() => {
			panel = undefined;
		});
	});
}

function renderContextControl(webview: vscode.Webview, state: ContextControlState): string {
	const nonce = randomBytes(16).toString("base64");
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
	</style>
</head>
<body>
	<h1>Provider working context</h1>
	<p class="lead">Changes apply to new provider sessions. Existing durable transcripts remain available.</p>
	<section class="card">
		<div class="row"><h2>Claude Opus 5</h2><span class="value" id="claudeValue"></span></div>
		<input id="claude" type="range" min="${state.claudeMinimum}" max="${state.claudeMaximum}" step="1" value="${state.claudeTarget}">
		<div class="bounds"><span>${formatTokenCount(state.claudeMinimum)}</span><span>${formatTokenCount(state.claudeMaximum)}</span></div>
		<p>Uses the real 1M model variant. The selected value is Claude Code's auto-compaction threshold; 967k leaves headroom below the raw 1M window.</p>
	</section>
	<section class="card">
		<div class="row"><h2>Codex</h2><span class="value" id="codexValue"></span></div>
		<input id="codex" type="range" min="${state.codexMinimum}" max="${state.codexMaximum}" step="1" value="${state.codexTarget}">
		<div class="bounds"><span>${formatTokenCount(state.codexMinimum)}</span><span>${formatTokenCount(state.codexMaximum)}</span></div>
		<p>The target is capped to the ${state.codexMaximumObserved ? "server-reported" : "configured fallback"} model window. Output, tool schemas, developer instructions, and a safety reserve are deducted before cold-start history compaction.</p>
	</section>
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
		const claude = document.getElementById('claude');
		const codex = document.getElementById('codex');
		const deepSeekContext = document.getElementById('deepSeekContext');
		const deepSeekOutput = document.getElementById('deepSeekOutput');
		const compact = value => value >= 1000000 ? (value / 1000000).toFixed(2).replace(/\\.00$/, '') + 'M' : (value / 1000).toFixed(1).replace(/\\.0$/, '') + 'k';
		const update = () => {
			document.getElementById('claudeValue').textContent = compact(Number(claude.value));
			document.getElementById('codexValue').textContent = compact(Number(codex.value));
			document.getElementById('deepSeekContextValue').textContent = compact(Number(deepSeekContext.value));
			document.getElementById('deepSeekOutputValue').textContent = compact(Number(deepSeekOutput.value));
			document.getElementById('status').textContent = '';
		};
		claude.addEventListener('input', update);
		codex.addEventListener('input', update);
		deepSeekContext.addEventListener('input', update);
		deepSeekOutput.addEventListener('input', update);
		document.getElementById('save').addEventListener('click', () => vscode.postMessage({ type: 'save', claudeTarget: Number(claude.value), codexTarget: Number(codex.value), deepSeekContextTarget: Number(deepSeekContext.value), deepSeekMaxOutputTarget: Number(deepSeekOutput.value) }));
		window.addEventListener('message', event => { if (event.data?.type === 'saved') document.getElementById('status').textContent = 'Saved'; });
		update();
	</script>
</body>
</html>`;
}