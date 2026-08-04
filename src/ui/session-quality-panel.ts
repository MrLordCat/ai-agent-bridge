import * as vscode from "vscode";
import type { ClaudeCacheKeepAliveStatus } from "../claude/claude-provider";
import type { SessionQualityTracker } from "../diagnostics/session-report";

export class SessionQualityPanel {
	public static readonly viewType = "llamacpp.sessionQuality";
	private static current: SessionQualityPanel | undefined;

	private readonly _panel: vscode.WebviewPanel;
	private readonly _tracker: SessionQualityTracker;
	private readonly _extensionVersion: string;
	private readonly _vscodeVersion: string;
	private readonly _getClaudeCacheKeepAliveStatus: () => ClaudeCacheKeepAliveStatus;

	private constructor(
		panel: vscode.WebviewPanel,
		tracker: SessionQualityTracker,
		extensionVersion: string,
		vscodeVersion: string,
		getClaudeCacheKeepAliveStatus: () => ClaudeCacheKeepAliveStatus,
	) {
		this._panel = panel;
		this._tracker = tracker;
		this._extensionVersion = extensionVersion;
		this._vscodeVersion = vscodeVersion;
		this._getClaudeCacheKeepAliveStatus = getClaudeCacheKeepAliveStatus;

		this._panel.onDidDispose(() => {
			SessionQualityPanel.current = undefined;
		});

		this._panel.webview.onDidReceiveMessage(message => {
			// Future: handle row-expand requests in a more granular way.
			void message;
		});

		this.refresh();
	}

	public static createOrShow(
		extensionUri: vscode.Uri,
		tracker: SessionQualityTracker,
		extensionVersion: string,
		vscodeVersion: string,
		getClaudeCacheKeepAliveStatus: () => ClaudeCacheKeepAliveStatus,
	): void {
		if (SessionQualityPanel.current) {
			SessionQualityPanel.current._panel.reveal(vscode.ViewColumn.Beside);
			SessionQualityPanel.current.refresh();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			SessionQualityPanel.viewType,
			"Session Quality",
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [extensionUri],
			},
		);

		try {
			SessionQualityPanel.current = new SessionQualityPanel(
				panel,
				tracker,
				extensionVersion,
				vscodeVersion,
				getClaudeCacheKeepAliveStatus,
			);
		} catch (err: unknown) {
			panel.dispose();
			throw new Error(`Failed to initialize session quality panel: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Refresh the panel if it's currently open. Safe to call from any context. */
	public static refreshIfOpen(): void {
		SessionQualityPanel.current?.refresh();
	}

	private _initialRenderDone = false;

	public refresh(): void {
		const data = this.buildData();
		if (!this._initialRenderDone) {
			this._initialRenderDone = true;
			this._panel.webview.html = this.renderHtml(data);
			return;
		}
		// Live update: post new data — the webview re-renders without destroying
		// DOM state, so expanded rows stay open.
		void this._panel.webview.postMessage({ type: "update", data });
	}

	private buildData(): unknown {
		const summary = this._tracker.summary;
		const rawRecords = this._tracker.records;
		return {
			generatedAt: new Date().toISOString(),
			extensionVersion: this._extensionVersion,
			vscodeVersion: this._vscodeVersion,
			providerHealth: {
				claudeCacheKeepAlive: this._getClaudeCacheKeepAliveStatus(),
			},
			summary: {
				turns: summary.turns,
					totalModelTurns: summary.totalModelTurns,
				promptTokens: summary.promptTokens,
				cachedPromptTokens: summary.cachedPromptTokens,
				cacheHitPercent: summary.cacheHitPercent,
				cacheAverageHitPercent: summary.cacheAverageHitPercent,
				cacheWorstHitPercent: summary.cacheWorstHitPercent,
				turnsWithCacheReport: summary.turnsWithCacheReport,
				cacheHealthyTurns: summary.cacheHealthyTurns,
				cacheStartupMissTurns: summary.cacheStartupMissTurns,
				cacheMissBreakdown: summary.cacheMissBreakdown,
				cacheByModel: summary.cacheByModel,
				averageFirstTokenLatencyMs: summary.averageFirstTokenLatencyMs,
				averageTokensPerSecond: summary.averageTokensPerSecond,
				totalToolCalls: summary.totalToolCalls,
				repairedToolCalls: summary.repairedToolCalls,
				rejectedToolCalls: summary.rejectedToolCalls,
				toolCallRepairRetries: summary.toolCallRepairRetries,
				toolLoopsDetected: summary.toolLoopsDetected,
				compactedTurns: summary.compactedTurns,
				overflowRetries: summary.overflowRetries,
			},
			records: rawRecords?.map((record, index) => ({
				index: index + 1,
				...record.turn,
				context: record.context,
			})) ?? [],
		};
	}

	private renderHtml(data: unknown): string {
		// Escape </ that would prematurely close the <script> tag when the
		// JSON payload contains string values with "</script>" in them.
		const json = JSON.stringify(data).replace(/<\//g, "<\\/");
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
:root {
	--bg: var(--vscode-editor-background, #1e1e1e);
	--fg: var(--vscode-editor-foreground, #d4d4d4);
	--surface: var(--vscode-sideBar-background, #252526);
	--surface-2: var(--vscode-editorWidget-background, #252526);
	--border: var(--vscode-panel-border, #3c3c3c);
	--row-hover: var(--vscode-list-hoverBackground, #2a2d2e);
	--accent: var(--vscode-textLink-foreground, #3794ff);
	--focus: var(--vscode-focusBorder, #007fd4);
	--good: #46c96f;
	--warn: #e5ad42;
	--bad: #ef6262;
	--info: #5ba7f7;
	--purple: #b58af0;
	--dim: var(--vscode-descriptionForeground, #9b9b9b);
	--track: rgba(127, 127, 127, .18);
	--shadow: 0 1px 2px rgba(0, 0, 0, .18);
}
* { box-sizing: border-box; }
html { color-scheme: dark light; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.5 var(--vscode-font-family, sans-serif); }
button, input, select { font: inherit; }
button:focus-visible, input:focus-visible, select:focus-visible, tr.turn-row:focus-visible { outline: 1px solid var(--focus); outline-offset: -1px; }
.page { width: 100%; max-width: 1540px; margin: 0 auto; padding: 22px clamp(16px, 2.5vw, 34px) 40px; }
.topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 18px; }
.title-row { display: flex; align-items: center; gap: 10px; }
h1 { margin: 0; font-size: 22px; line-height: 1.25; letter-spacing: -.2px; }
.live-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border: 1px solid rgba(70,201,111,.38); border-radius: 999px; color: var(--good); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.live-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px rgba(70,201,111,.13); }
.sub { margin-top: 5px; color: var(--dim); font-size: 11px; }
.header-actions { display: flex; align-items: center; gap: 8px; }
.btn, .select, .search { min-height: 30px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface); color: var(--fg); }
.btn { padding: 4px 10px; cursor: pointer; }
.btn:hover { background: var(--row-hover); }
.btn.active { border-color: var(--accent); color: var(--accent); background: rgba(55,148,255,.08); }
.section { margin-top: 20px; }
.section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 9px; }
h2 { margin: 0; font-size: 14px; font-weight: 650; letter-spacing: .01em; }
.section-note { color: var(--dim); font-size: 11px; }
.metric-grid { display: grid; grid-template-columns: repeat(6, minmax(145px, 1fr)); gap: 10px; }
.metric-card { position: relative; min-height: 108px; overflow: hidden; padding: 13px 14px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); box-shadow: var(--shadow); }
.metric-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--metric-color, var(--info)); opacity: .9; }
.metric-label { color: var(--dim); font-size: 10px; font-weight: 700; letter-spacing: .065em; text-transform: uppercase; }
.metric-value { margin-top: 7px; font-size: clamp(20px, 2.1vw, 28px); font-weight: 720; line-height: 1.1; letter-spacing: -.5px; color: var(--metric-color, var(--fg)); }
.metric-caption { min-height: 17px; margin-top: 5px; color: var(--dim); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meter { height: 5px; margin-top: 9px; overflow: hidden; border-radius: 999px; background: var(--track); }
.meter-fill { display: block; height: 100%; max-width: 100%; border-radius: inherit; background: var(--metric-color, var(--info)); }
.tone-good { --metric-color: var(--good); }
.tone-warn { --metric-color: var(--warn); }
.tone-bad { --metric-color: var(--bad); }
.tone-info { --metric-color: var(--info); }
.tone-purple { --metric-color: var(--purple); }
.diagnostic { display: flex; align-items: flex-start; gap: 11px; margin-top: 10px; padding: 11px 13px; border: 1px solid var(--border); border-left: 3px solid var(--diag-color, var(--good)); border-radius: 6px; background: var(--surface); }
.diagnostic.warn { --diag-color: var(--warn); }
.diagnostic.bad { --diag-color: var(--bad); }
.diagnostic-icon { width: 22px; height: 22px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 50%; background: var(--track); color: var(--diag-color, var(--good)); font-weight: 800; }
.diagnostic-title { font-weight: 650; }
.diagnostic-copy { margin-top: 1px; color: var(--dim); font-size: 11px; }
.keepalive-card { margin-top: 10px; padding: 12px 13px; border: 1px solid var(--border); border-left: 3px solid var(--keepalive-color, var(--info)); border-radius: 7px; background: var(--surface); }
.keepalive-card.good { --keepalive-color: var(--good); }
.keepalive-card.warn { --keepalive-color: var(--warn); }
.keepalive-card.bad { --keepalive-color: var(--bad); }
.keepalive-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.keepalive-state { color: var(--keepalive-color, var(--info)); font-size: 12px; font-weight: 700; text-transform: uppercase; }
.keepalive-reason { margin-top: 4px; color: var(--dim); font-size: 11px; }
.keepalive-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(175px, 1fr)); gap: 7px 14px; margin-top: 11px; }
.keepalive-kv { min-width: 0; }
.keepalive-k { color: var(--dim); font-size: 9px; font-weight: 700; letter-spacing: .055em; text-transform: uppercase; }
.keepalive-v { margin-top: 2px; overflow-wrap: anywhere; font-size: 11px; font-weight: 600; }
.model-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; }
.model-card { padding: 12px 13px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); }
.model-head, .model-stats { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.model-name { min-width: 0; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-hit { font-size: 18px; font-weight: 720; }
.model-stats { margin-top: 8px; color: var(--dim); font-size: 10px; }
.model-stats strong { color: var(--fg); font-weight: 600; }
.reason-list { display: flex; flex-wrap: wrap; gap: 7px; }
.reason-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface); }
.reason-count { min-width: 20px; height: 20px; display: grid; place-items: center; border-radius: 10px; background: var(--track); font-size: 10px; font-weight: 700; }
.turn-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
.turn-filters { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.search { width: min(280px, 34vw); padding: 5px 9px; }
.select { padding: 4px 26px 4px 8px; }
.table-shell { width: 100%; overflow: auto; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); }
table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; }
.turn-table { min-width: 920px; }
th, td { padding: 8px 9px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { position: sticky; top: 0; z-index: 2; background: var(--surface-2); color: var(--dim); font-size: 10px; font-weight: 700; letter-spacing: .045em; text-transform: uppercase; }
tbody tr:last-child td { border-bottom: 0; }
tr.turn-row { cursor: pointer; transition: background .12s; }
tr.turn-row:hover, tr.turn-row.open { background: var(--row-hover); }
tr.turn-row.issue { box-shadow: inset 3px 0 0 var(--warn); }
tr.turn-row.critical { box-shadow: inset 3px 0 0 var(--bad); }
tr.detail-row { display: none; }
tr.detail-row.open { display: table-row; }
tr.detail-row > td { padding: 12px; white-space: normal; background: rgba(127,127,127,.035); }
.detail-grid { display: grid; grid-template-columns: repeat(4, minmax(220px, 1fr)); gap: 9px; }
.detail-card { min-width: 0; padding: 11px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); }
.detail-card.wide { grid-column: span 2; }
.detail-card h3 { margin: 0 0 8px; font-size: 11px; letter-spacing: .045em; text-transform: uppercase; color: var(--dim); }
.detail-card .kv { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }
.detail-card .kv .k { color: var(--dim); }
.detail-card .kv .v { min-width: 0; text-align: right; color: var(--fg); font-weight: 580; overflow-wrap: anywhere; }
.expand-icon { display: inline-grid; width: 18px; height: 18px; place-items: center; color: var(--dim); transition: transform .15s; }
.expand-icon.open { transform: rotate(90deg); color: var(--accent); }
.hit-good { color: var(--good); }
.hit-warn { color: var(--warn); }
.hit-bad { color: var(--bad); }
.empty { padding: 24px; color: var(--dim); text-align: center; border: 1px dashed var(--border); border-radius: 7px; }
.bar-wrap { display: flex; align-items: center; gap: 0; overflow: hidden; border-radius: 999px; background: var(--track); }
.bar { display: block; height: 7px; min-width: 1px; }
.bar-cached { background: var(--good); }
.bar-cache-write { background: var(--warn); }
.bar-uncached { background: var(--bad); opacity: .82; }
.reason-badge { display: inline-flex; align-items: center; max-width: 220px; padding: 2px 7px; border-radius: 999px; font-size: 10px; font-weight: 650; line-height: 1.5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.reason-cold_start { background: rgba(148,163,184,.16); color: #cbd5e1; }
.reason-upstream_expired { background: rgba(245,158,11,.16); color: #f6c45f; }
.reason-upstream_cache_pending { background: rgba(245,158,11,.16); color: #f6c45f; }
.reason-healthy { background: rgba(70,201,111,.14); color: var(--good); }
.reason-history_rewritten, .reason-history_truncated, .reason-history_summarized { background: rgba(181,138,240,.15); color: #c9a7f6; }
.reason-session_not_reused { background: rgba(239,98,98,.15); color: #ff8d8d; }
.reason-request_params_changed, .reason-tool_catalog_changed, .reason-system_prompt_changed { background: rgba(229,173,66,.16); color: #f2c66d; }
.reason-unknown { background: var(--track); color: var(--dim); }
.cache-cell { min-width: 132px; }
.cache-visual { display: grid; grid-template-columns: minmax(70px, 1fr) auto; align-items: center; gap: 7px; }
.cache-visual .bar-wrap { height: 7px; }
.cache-value { font-variant-numeric: tabular-nums; font-weight: 650; }
.compact-number { font-variant-numeric: tabular-nums; }
.model-cell { max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.subagent-tag { margin-left: 5px; color: var(--purple); font-size: 9px; font-weight: 700; text-transform: uppercase; }
.backend-info { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; }
.copy-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 42px; height: 25px; padding: 0 7px; cursor: pointer; border: 1px solid transparent; border-radius: 4px; color: var(--dim); font-size: 10px; font-weight: 650; user-select: none; }
.copy-btn:hover { color: var(--fg); border-color: var(--border); background: var(--row-hover); }
.copy-btn.copied { color: var(--good); }
.hidden-row { display: none !important; }
@media (max-width: 1180px) {
	.metric-grid { grid-template-columns: repeat(3, minmax(150px, 1fr)); }
	.detail-grid { grid-template-columns: repeat(2, minmax(220px, 1fr)); }
}
@media (max-width: 720px) {
	.page { padding: 16px 12px 30px; }
	.topbar, .turn-toolbar { align-items: stretch; flex-direction: column; }
	.header-actions { justify-content: flex-start; }
	.metric-grid { grid-template-columns: repeat(2, minmax(130px, 1fr)); }
	.detail-grid { grid-template-columns: 1fr; }
	.detail-card.wide { grid-column: auto; }
	.search { width: 100%; }
}
</style>
</head>
<body>
<div id="app"></div>
<script>
var DATA = ${json};
const FMT = (v, d = "n/a") => v !== undefined && v !== null ? v.toLocaleString("en-US") : d;
const FMT1 = (v, d) => typeof v === "number" ? v.toFixed(1) : (d ?? "n/a");
const FMT_SHORT = (v) => typeof v === "number" ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v) : "n/a";
const PCT = (v) => typeof v === "number" ? v.toFixed(1) + "%" : "n/a";
const DURATION = (v) => typeof v !== "number" ? "n/a" : v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + " s" : Math.round(v) + " ms";
const CLOCK = (v) => typeof v === "number" ? new Date(v).toLocaleTimeString() : "never";
const YESNO = (v) => v === true ? "✅" : v === false ? "❌" : "—";
const HIT_COLOR = (v) => v >= 90 ? "hit-good" : v >= 50 ? "hit-warn" : "hit-bad";
const HIT_TONE = (v) => v >= 90 ? "tone-good" : v >= 50 ? "tone-warn" : "tone-bad";
const REASON_CLASS = (r) => r ? "reason-badge reason-" + r : "";
const REASON_LABEL = (r) => r ? r.replace(/_/g, " ") : "—";
const MODEL_LABEL = (id) => String(id || "—").replace(/^.*::/, "");
const IS_CODEX = (r) => r && (r.providerKind === "codex" || typeof r.threadMode === "string");
const IS_CLAUDE = (r) => r && (r.providerKind === "claude" || typeof r.sessionMode === "string");
const IS_STATEFUL = (r) => IS_CODEX(r) || IS_CLAUDE(r);
const EFFECTIVE_HIT = (r) => IS_STATEFUL(r) && typeof r.continuationCacheHitPercent === "number"
	? r.continuationCacheHitPercent
	: r.promptCacheHitPercent;
const LIFECYCLE_TONE = (phase) => phase === "failed" || phase === "timed_out"
	? "bad"
	: phase === "running" || phase === "interrupted" || phase === "abandoned" ? "warn" : "good";
const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Safe JSON stringify — returns a fallback object if serialization fails.
var safeStringify = function(obj) { try { return escAttr(JSON.stringify(obj)); } catch(e) { return escAttr(JSON.stringify({_error: "serialization_failed", _detail: String(e && e.message ? e.message : e)})); } };
var compactTurnRecord = function(r) {
	const segments = Array.isArray(r.usageSegments) ? r.usageSegments : [];
	const first = segments[0];
	const final = segments.length ? segments[segments.length - 1] : undefined;
	return {
		index: r.index,
		requestId: r.requestId,
		modelId: r.modelId,
		providerKind: r.providerKind,
		lifecyclePhase: r.lifecyclePhase,
		terminalDetail: r.terminalDetail,
		sessionMode: r.sessionMode,
		threadMode: r.threadMode,
		inputMode: r.inputMode,
		compacted: r.compacted,
		conversationKey: r.conversationKey,
		cause: {
			classification: r.cacheMissReason,
			detail: r.cacheMissDetail,
			resumeFailureReason: r.resumeFailureReason,
			resumeFailureStage: r.resumeFailureStage,
			resumeFailureDetail: r.resumeFailureDetail,
		},
		guard: {
			resumeFallbackDecision: r.resumeFallbackDecision,
			estimatedReplayTokens: r.resumeFallbackEstimatedInputTokens,
			maxReplayTokens: r.resumeFallbackMaxInputTokens,
			maxModelSegments: r.turnMaxModelSegments,
			maxCumulativeInputTokens: r.turnMaxCumulativeInputTokens,
			stopReason: r.safetyStopReason,
			stopDetail: r.safetyStopDetail,
		},
		cache: {
			initialHitPercent: r.initialSegmentCacheHitPercent,
			continuationHitPercent: r.continuationCacheHitPercent,
			processedBlendPercent: r.promptCacheHitPercent,
			coldRewriteTokens: first && first.cacheHitPercent === 0 ? first.cacheCreationInputTokens : 0,
			finalInputTokens: final ? final.inputTokens : r.finalSegmentInputTokens,
			finalCachedInputTokens: final ? final.cachedInputTokens : r.finalSegmentCachedInputTokens,
			cumulativeProcessedInputTokens: r.promptTokens,
			cumulativeCacheReadTokens: r.cachedPromptTokens,
			cumulativeCacheWriteTokens: r.cacheWriteInputTokens,
			modelSegments: r.modelTurns,
		},
		performance: {
			durationMs: r.durationMs,
			firstModelEventLatencyMs: r.firstTokenLatencyMs,
			firstVisibleLatencyMs: r.firstVisibleLatencyMs,
			outputTokens: r.outputTokens,
			outputChars: r.outputChars,
		},
		tools: {
			calls: r.toolCalls,
			delegatedCalls: r.delegatedToolCalls,
			totalDurationMs: r.toolDurationTotalMs,
			breakdown: r.toolCallBreakdown,
		},
		context: r.context ? {
			usedTokens: r.context.estimatedUsedTokens,
			freeTokens: r.context.estimatedFreeTokens,
			usagePercent: r.context.estimatedUsagePercent,
			advertisedTools: r.context.cappedTools,
			autoCompacted: r.context.autoCompacted,
			hardCompacted: r.context.hardCompacted,
			tokenCountSource: r.context.tokenCountSource,
		} : undefined,
		metricsSource: r.metricsSource,
	};
};
const DISPLAY_SERIES = (items) => !Array.isArray(items) || items.length <= 12
	? items || []
	: [...items.slice(0, 3), ...items.slice(-5)];

function render() {
	const d = DATA;
	const s = d.summary;
	let h = "";
	const missTurns = Math.max(0, s.turnsWithCacheReport - s.cacheHealthyTurns);
	const startupMissTurns = s.cacheStartupMissTurns ?? 0;
	const seriousIssues = s.rejectedToolCalls + s.toolLoopsDetected + s.overflowRetries;
	const metric = (label, value, caption, tone, meter) => {
		let card = '<article class="metric-card ' + tone + '">';
		card += '<div class="metric-label">' + label + '</div>';
		card += '<div class="metric-value">' + value + '</div>';
		card += '<div class="metric-caption" title="' + escAttr(String(caption)) + '">' + caption + '</div>';
		if (typeof meter === "number") card += '<div class="meter"><span class="meter-fill" style="width:' + Math.max(0, Math.min(100, meter)).toFixed(1) + '%"></span></div>';
		return card + '</article>';
	};

	// Header
	h += '<main class="page">';
	h += '<header class="topbar"><div>';
	h += '<div class="title-row"><h1>Session Quality</h1><span class="live-pill">Live</span></div>';
	h += '<div class="sub">Updated ' + new Date(d.generatedAt).toLocaleTimeString() + ' &middot; Extension ' + d.extensionVersion + ' &middot; VS Code ' + d.vscodeVersion + '</div>';
	h += '</div><div class="header-actions"><span class="section-note">' + s.turns + ' logical turn' + (s.turns === 1 ? '' : 's') + ' · ' + FMT(s.totalModelTurns ?? s.turns) + ' model segment' + ((s.totalModelTurns ?? s.turns) === 1 ? '' : 's') + '</span></div></header>';

	// Primary health metrics
	h += '<section class="metric-grid" aria-label="Session summary">';
	h += metric("Processed token cache", PCT(s.cacheHitPercent), FMT_SHORT(s.cachedPromptTokens) + ' of ' + FMT_SHORT(s.promptTokens) + ' input tokens across all model segments', HIT_TONE(s.cacheHitPercent), s.cacheHitPercent);
	h += metric("Continuation reuse", PCT(s.cacheAverageHitPercent), 'Worst final/continuation segment ' + PCT(s.cacheWorstHitPercent), HIT_TONE(s.cacheAverageHitPercent), s.cacheAverageHitPercent);
	h += metric("Processed input", FMT_SHORT(s.promptTokens), FMT(s.turns) + ' logical turns · ' + FMT(s.totalModelTurns ?? s.turns) + ' model segments', 'tone-info');
	h += metric("First token", DURATION(s.averageFirstTokenLatencyMs), 'Average TTFT', s.averageFirstTokenLatencyMs > 10000 ? 'tone-warn' : 'tone-info');
	h += metric("Generation", s.averageTokensPerSecond ? FMT1(s.averageTokensPerSecond) : 'n/a', s.averageTokensPerSecond ? 'tokens per second' : 'No speed sample', 'tone-purple');
	const reliabilityTone = seriousIssues > 0 ? 'tone-bad' : s.repairedToolCalls > 0 ? 'tone-warn' : 'tone-good';
	h += metric("Reliability", seriousIssues > 0 ? seriousIssues + ' issues' : 'Healthy', s.totalToolCalls + ' calls · ' + s.repairedToolCalls + ' repaired · ' + s.compactedTurns + ' compacted', reliabilityTone);
	h += '</section>';

	// Actionable status banner
	const diagnosticClass = seriousIssues > 0 ? 'bad' : missTurns > 0 ? 'warn' : '';
	const diagnosticIcon = seriousIssues > 0 ? '!' : missTurns > 0 ? 'i' : '✓';
	const diagnosticTitle = seriousIssues > 0
		? seriousIssues + ' reliability issue' + (seriousIssues === 1 ? '' : 's') + ' need attention'
		: missTurns > 0
			? missTurns + ' cache miss turn' + (missTurns === 1 ? '' : 's') + ' detected'
			: startupMissTurns > 0
				? startupMissTurns + ' cold Codex startup' + (startupMissTurns === 1 ? '' : 's') + ' recovered'
				: s.turns > 0 ? 'Session is healthy' : 'Waiting for the first turn';
	const diagnosticCopy = seriousIssues > 0
		? s.rejectedToolCalls + ' rejected calls · ' + s.overflowRetries + ' overflow retries · ' + s.toolLoopsDetected + ' loops'
		: missTurns > 0
			? 'Open the highlighted turn below to see exactly which prefix component changed.'
			: startupMissTurns > 0
				? 'The first segment paid a real cold-start cost, but final/continuation cache health recovered above 90%.'
				: s.turns > 0 ? 'No server-reported cache or tool reliability problems.' : 'Start a model turn and this dashboard will update automatically.';
	h += '<div class="diagnostic ' + diagnosticClass + '"><div class="diagnostic-icon">' + diagnosticIcon + '</div><div><div class="diagnostic-title">' + diagnosticTitle + '</div><div class="diagnostic-copy">' + diagnosticCopy + '</div></div></div>';

	// Provider health stays visible even when there are no Claude user turns.
	const keepAlive = d.providerHealth && d.providerHealth.claudeCacheKeepAlive;
	if (keepAlive) {
		const stateLabels = {
			checking: 'Checking', disabled: 'Disabled', paused_usage_unknown: 'Paused · usage unknown',
			paused_usage_stale: 'Paused · usage stale', paused_usage_limit: 'Paused · limit protection',
			no_eligible_session: 'No eligible session', waiting: 'Waiting', running: 'Running',
			success: 'Success', failed: 'Failed',
		};
		const keepAliveTone = keepAlive.state === 'failed'
			? 'bad'
			: keepAlive.state === 'success' || keepAlive.state === 'waiting'
				? 'good'
				: keepAlive.state.startsWith('paused_') || keepAlive.state === 'disabled'
					? 'warn'
					: '';
		const kv = (label, value) => '<div class="keepalive-kv"><div class="keepalive-k">' + label + '</div><div class="keepalive-v">' + esc(String(value)) + '</div></div>';
		const usageLabel = typeof keepAlive.usagePercent === 'number'
			? FMT1(keepAlive.usagePercent) + '% · snapshot ' + DURATION(keepAlive.usageSnapshotAgeMs) + ' old'
			: 'unknown';
		const nextLabel = typeof keepAlive.nextAttemptAt === 'number'
			? CLOCK(keepAlive.nextAttemptAt) + (keepAlive.nextAttemptAt > Date.now() ? ' · in ' + DURATION(keepAlive.nextAttemptAt - Date.now()) : ' · due')
			: 'not scheduled';
		const candidateLabel = keepAlive.candidateModelId
			? MODEL_LABEL(keepAlive.candidateModelId) + ' · ' + FMT_SHORT(keepAlive.candidatePrefixTokens) + ' prefix'
			: 'none';
		const resultLabel = typeof keepAlive.lastResultCacheHitPercent === 'number'
			? PCT(keepAlive.lastResultCacheHitPercent) + ' cache read · ' + FMT_SHORT(keepAlive.lastResultCacheWriteTokens) + ' written'
			: 'no completed sample';
		h += '<section class="keepalive-card ' + keepAliveTone + '" aria-label="Claude cache keep-alive status">';
		h += '<div class="keepalive-head"><div><div class="metric-label">Claude cache keep-alive</div><div class="keepalive-state">' + esc(stateLabels[keepAlive.state] || keepAlive.state) + '</div></div><span class="section-note">Updated ' + CLOCK(keepAlive.updatedAt) + '</span></div>';
		h += '<div class="keepalive-reason">' + esc(keepAlive.reason) + '</div><div class="keepalive-grid">';
		h += kv('5-hour usage', usageLabel);
		h += kv('Live sessions', FMT(keepAlive.eligibleSessionCount) + ' eligible of ' + FMT(keepAlive.sessionCount));
		h += kv('Protected session', candidateLabel);
		h += kv('Next attempt', nextLabel);
		h += kv('Last attempt', CLOCK(keepAlive.lastAttemptAt));
		h += kv('Last success', CLOCK(keepAlive.lastSuccessAt));
		h += kv('Last result', resultLabel);
		h += kv('Last failure', keepAlive.lastFailure ? CLOCK(keepAlive.lastFailureAt) + ' · ' + keepAlive.lastFailure : 'none');
		h += '</div></section>';
	}

	// Cache by Model
	if (s.cacheByModel && s.cacheByModel.length) {
		h += '<section class="section"><div class="section-heading"><h2>Cache by model</h2><span class="section-note">Token-weighted cache efficiency</span></div><div class="model-grid">';
		for (const m of s.cacheByModel) {
			h += '<article class="model-card ' + HIT_TONE(m.hitPercent) + '">';
			h += '<div class="model-head"><div class="model-name" title="' + escAttr(String(m.modelLabel)) + '">' + esc(m.modelLabel) + '</div><div class="model-hit ' + HIT_COLOR(m.hitPercent) + '">' + PCT(m.hitPercent) + '</div></div>';
			h += '<div class="meter"><span class="meter-fill" style="width:' + Math.max(0, Math.min(100, m.hitPercent)).toFixed(1) + '%"></span></div>';
			h += '<div class="model-stats"><span><strong>' + m.turns + '</strong> turns</span><span><strong>' + FMT(m.modelSegments ?? m.turns) + '</strong> segments</span><span><strong>' + FMT_SHORT(m.promptTokens) + '</strong> prompt</span><span><strong>' + FMT_SHORT(m.cachedTokens) + '</strong> cached</span><span><strong>' + m.missTurns + '</strong> misses</span>' + (m.subagentTurns > 0 ? '<span><strong>' + m.subagentTurns + '</strong> subagent</span>' : '') + '</div>';
			h += '</article>';
		}
		h += '</div></section>';
	}

	// Cache Miss Reasons
	if (s.cacheMissBreakdown && s.cacheMissBreakdown.length) {
		h += '<section class="section"><div class="section-heading"><h2>Why cache missed</h2><span class="section-note">' + s.cacheHealthyTurns + ' healthy of ' + s.turnsWithCacheReport + ' server-reported turns</span></div><div class="reason-list">';
		for (const r of s.cacheMissBreakdown) {
			h += '<div class="reason-item"><span class="' + REASON_CLASS(r.reason) + '">' + REASON_LABEL(r.reason) + '</span><span class="reason-count">' + r.count + '</span><span class="section-note">' + r.percent.toFixed(1) + '%</span></div>';
		}
		h += '</div></section>';
	}

	// Turns table with expandable detail rows
	if (d.records && d.records.length) {
		const hasPrefix = d.records.some(r => r.cacheMissReason !== undefined || r.prefixIdenticalMessageCount !== undefined);
		const models = [...new Set(d.records.map(r => r.modelId).filter(Boolean))];
		h += '<section class="section turns-section"><div class="section-heading"><h2>Turns</h2><span class="section-note">Select a row for cache, context, tools and backend details</span></div>';
		h += '<div class="turn-toolbar"><div class="turn-filters">';
		h += '<input id="turn-search" class="search" type="search" placeholder="Search model, reason or request ID" aria-label="Search turns">';
		h += '<select id="model-filter" class="select" aria-label="Filter by model"><option value="">All models</option>';
		for (const model of models) h += '<option value="' + escAttr(String(model)) + '">' + esc(MODEL_LABEL(model)) + '</option>';
		h += '</select><button id="issues-filter" class="btn" type="button" aria-pressed="false">Issues only</button></div>';
		h += '<button id="expand-all" class="btn" type="button">Expand all</button></div>';
		h += '<div class="table-shell"><table class="turn-table"><thead><tr>';
		h += '<th style="width:22px"></th>';
		h += '<th>#</th>';
		h += '<th>Model</th>';
		h += '<th>Processed input</th>';
		h += '<th>Cache reuse</th>';
		if (hasPrefix) h += '<th>Status</th>';
		h += '<th>TTFT</th>';
		h += '<th>Speed</th>';
		h += '<th>Tools</th>';
		h += '<th>Context</th>';
		h += '<th>Compact</th>';
		h += '<th style="width:52px">Data</th>';
		h += '</tr></thead><tbody>';

		for (let i = 0; i < d.records.length; i++) {
			const r = d.records[i];
			const hit = EFFECTIVE_HIT(r);
			const detailId = "detail-" + i;
			const cacheIssue = typeof hit === "number" && hit < 90;
			const critical = Boolean(
				r.rejectedToolCalls || r.toolLoopDetected || r.retriedAfterOverflow || r.safetyStopReason
			);
			const reasonIssue = Boolean(r.cacheMissReason && r.cacheMissReason !== "healthy" && r.cacheMissReason !== "cold_start");
			const issue = critical || cacheIssue || reasonIssue;
			const searchable = [r.modelId, r.cacheMissReason, r.requestId].filter(Boolean).join(" ").toLowerCase();

			h += '<tr class="turn-row ' + (critical ? 'critical' : issue ? 'issue' : '') + '" tabindex="0" role="button" aria-expanded="false" data-detail="' + detailId + '" data-issue="' + (issue ? '1' : '0') + '" data-model="' + escAttr(String(r.modelId || '')) + '" data-search="' + escAttr(searchable) + '">';
			h += '<td><span class="expand-icon">▶</span></td>';
			h += '<td class="compact-number">' + r.index + (r.isSubagent ? '<span class="subagent-tag">sub</span>' : '') + '</td>';
			h += '<td class="model-cell" title="' + escAttr(String(r.modelId || '')) + '">' + esc(MODEL_LABEL(r.modelId)) + '</td>';
			h += '<td class="compact-number" title="' + FMT(r.promptTokens) + ' tokens processed across ' + FMT(r.modelTurns ?? 1) + ' model segment(s)">' + FMT_SHORT(r.promptTokens) + '</td>';
			// Cache cell with mini bar
			h += '<td class="cache-cell">';
			const cacheInput = IS_CODEX(r) && typeof r.finalSegmentInputTokens === "number" ? r.finalSegmentInputTokens : r.promptTokens;
			const cacheTokens = IS_CODEX(r) && typeof r.finalSegmentCachedInputTokens === "number" ? r.finalSegmentCachedInputTokens : r.cachedPromptTokens;
			if (typeof cacheInput === "number" && cacheInput > 0 && typeof cacheTokens === "number") {
				const hitPct = (cacheTokens / cacheInput) * 100;
				h += '<div class="cache-visual"><div class="bar-wrap">';
				if (hitPct > 0) h += '<div class="bar bar-cached" style="width:' + Math.max(hitPct, 2).toFixed(1) + '%"></div>';
				if (hitPct < 100) h += '<div class="bar bar-uncached" style="width:' + Math.max(100 - hitPct, 2).toFixed(1) + '%"></div>';
				h += '</div><span class="cache-value ' + HIT_COLOR(hitPct) + '">' + PCT(hitPct) + '</span></div>';
				if (IS_CODEX(r) && typeof r.promptCacheHitPercent === "number") {
					h += '<div class="section-note">final segment · processed blend ' + PCT(r.promptCacheHitPercent) + '</div>';
				} else if (IS_CLAUDE(r)) {
					h += '<div class="section-note">' + FMT_SHORT(cacheTokens) + ' read · ' + FMT_SHORT(r.cacheWriteInputTokens ?? 0) + ' written</div>';
				} else {
					h += '<div class="section-note">' + FMT_SHORT(cacheTokens) + ' cached</div>';
				}
			} else {
				h += '<span class="section-note">No cache report</span>';
			}
			h += '</td>';
			if (hasPrefix) {
				const reason = r.cacheMissReason;
				h += '<td><span class="' + REASON_CLASS(reason || (typeof hit === 'number' && hit >= 90 ? 'healthy' : 'unknown')) + '">' + REASON_LABEL(reason || (typeof hit === 'number' && hit >= 90 ? 'healthy' : 'unknown')) + '</span></td>';
			}
			h += '<td class="compact-number">' + DURATION(r.firstTokenLatencyMs) + '</td>';
			h += '<td class="compact-number">' + (r.tokensPerSecond !== undefined ? FMT1(r.tokensPerSecond) + ' t/s' : "n/a") + '</td>';
			h += '<td>' + (r.toolCalls ?? 0) + (r.repairedToolCalls ? " (" + r.repairedToolCalls + "r)" : "") + (r.rejectedToolCalls ? " (" + r.rejectedToolCalls + "x)" : "") + '</td>';
			h += '<td>' + (r.context?.estimatedUsagePercent !== undefined ? FMT1(r.context.estimatedUsagePercent) + "%" : "n/a") + '</td>';
			h += '<td>' + (r.context?.hardCompacted ? "hard" : r.context?.autoCompacted ? "auto" : "—") + '</td>';
			// Default clipboard payload is compact. Full diagnostics remain available
			// from DATA by record index without duplicating the large JSON in the DOM.
			const turnJson = safeStringify(compactTurnRecord(r));
			h += '<td><span class="copy-btn" role="button" tabindex="0" data-index="' + i + '" data-json="' + turnJson + '" title="Click: compact JSON · Shift+click: formatted text · Alt+click: full JSON">Copy</span></td>';
			h += '</tr>';

			// Detail row ...
			const detailColspan = hasPrefix ? 12 : 11;
			h += '<tr class="detail-row" id="' + detailId + '"><td colspan="' + detailColspan + '">';
			h += '<div class="detail-grid">';

			// Prefix/cache diagnostics differ by transport. Codex owns a durable
			// app-server thread, so generic byte-prefix fields are not meaningful.
			const isColdStart = r.prefixPreviousMessageCount === undefined;
			if (IS_CODEX(r)) {
				h += '<section class="detail-card wide"><h3>Codex session &amp; cache</h3>';
				h += '<div class="kv"><span class="k">Lifecycle</span><span class="v ' + LIFECYCLE_TONE(r.lifecyclePhase) + '">' + esc(r.lifecyclePhase || 'unknown') + '</span></div>';
				h += '<div class="kv"><span class="k">Thread mode</span><span class="v">' + esc(r.threadMode || 'unknown') + '</span></div>';
				h += '<div class="kv"><span class="k">Reuse miss</span><span class="v">' + esc(r.threadReuseMissReason || '—') + '</span></div>';
				h += '<div class="kv"><span class="k">First model segment</span><span class="v ' + HIT_COLOR(r.initialSegmentCacheHitPercent) + '">' + PCT(r.initialSegmentCacheHitPercent) + '</span></div>';
				h += '<div class="kv"><span class="k">Final / continuation segment</span><span class="v ' + HIT_COLOR(EFFECTIVE_HIT(r)) + '">' + PCT(EFFECTIVE_HIT(r)) + '</span></div>';
				h += '<div class="kv"><span class="k">Processed blend</span><span class="v">' + PCT(r.promptCacheHitPercent) + ' · ' + FMT(r.cachedPromptTokens) + ' of ' + FMT(r.promptTokens) + ' input tokens cached</span></div>';
				h += '<div class="kv"><span class="k">Classification</span><span class="v"><span class="' + REASON_CLASS(r.cacheMissReason || 'unknown') + '">' + REASON_LABEL(r.cacheMissReason || 'unknown') + '</span></span></div>';
				h += '<div class="kv"><span class="k">Detail</span><span class="v">' + esc(r.cacheMissDetail || "—") + '</span></div>';
				if (r.terminalDetail) h += '<div class="kv"><span class="k">Terminal detail</span><span class="v">' + esc(r.terminalDetail) + '</span></div>';
			} else if (IS_CLAUDE(r)) {
				h += '<section class="detail-card wide"><h3>Claude session &amp; cache</h3>';
				h += '<div class="kv"><span class="k">Lifecycle</span><span class="v ' + LIFECYCLE_TONE(r.lifecyclePhase) + '">' + esc(r.lifecyclePhase || 'unknown') + '</span></div>';
				h += '<div class="kv"><span class="k">Session mode</span><span class="v">' + esc(r.sessionMode || 'unknown') + '</span></div>';
				if (r.resumeFailureReason) h += '<div class="kv"><span class="k">Resume failure</span><span class="v bad">' + esc(r.resumeFailureReason) + '</span></div>';
				if (r.resumeFailureStage) h += '<div class="kv"><span class="k">Failure stage</span><span class="v">' + esc(r.resumeFailureStage) + '</span></div>';
				if (r.resumeFailureDetail) h += '<div class="kv"><span class="k">Original SDK error</span><span class="v">' + esc(r.resumeFailureDetail) + '</span></div>';
				if (r.resumeFallbackDecision) h += '<div class="kv"><span class="k">Fallback decision</span><span class="v">' + esc(r.resumeFallbackDecision) + '</span></div>';
				if (r.resumeFallbackEstimatedInputTokens !== undefined) h += '<div class="kv"><span class="k">Estimated cold replay</span><span class="v">' + FMT(r.resumeFallbackEstimatedInputTokens) + ' / ' + FMT(r.resumeFallbackMaxInputTokens) + ' tokens</span></div>';
				if (r.turnMaxModelSegments !== undefined) h += '<div class="kv"><span class="k">Turn guard</span><span class="v">' + FMT(r.turnMaxModelSegments) + ' model segments · ' + FMT(r.turnMaxCumulativeInputTokens) + ' cumulative input tokens</span></div>';
				if (r.safetyStopReason) h += '<div class="kv"><span class="k">Safety stop</span><span class="v bad">' + esc(r.safetyStopReason) + '</span></div>';
				if (r.safetyStopDetail) h += '<div class="kv"><span class="k">Safety detail</span><span class="v">' + esc(r.safetyStopDetail) + '</span></div>';
				h += '<div class="kv"><span class="k">Fresh input</span><span class="v">' + FMT(Math.max(0, (r.promptTokens ?? 0) - (r.cachedPromptTokens ?? 0) - (r.cacheWriteInputTokens ?? 0))) + '</span></div>';
				h += '<div class="kv"><span class="k">Cache read</span><span class="v ' + HIT_COLOR(r.promptCacheHitPercent) + '">' + FMT(r.cachedPromptTokens) + ' · ' + PCT(r.promptCacheHitPercent) + '</span></div>';
				h += '<div class="kv"><span class="k">Cache creation</span><span class="v">' + FMT(r.cacheWriteInputTokens ?? 0) + '</span></div>';
				h += '<div class="kv"><span class="k">Classification</span><span class="v"><span class="' + REASON_CLASS(r.cacheMissReason || 'unknown') + '">' + REASON_LABEL(r.cacheMissReason || 'unknown') + '</span></span></div>';
				h += '<div class="kv"><span class="k">Detail</span><span class="v">' + esc(r.cacheMissDetail || "—") + '</span></div>';
				if (r.terminalDetail) h += '<div class="kv"><span class="k">Terminal detail</span><span class="v">' + esc(r.terminalDetail) + '</span></div>';
			} else {
				h += '<section class="detail-card wide"><h3>Prefix &amp; cache</h3>';
				h += '<div class="kv"><span class="k">Identical msgs</span><span class="v">' + (isColdStart ? 'cold start' : r.prefixIdenticalMessageCount !== undefined ? r.prefixIdenticalMessageCount + " of " + FMT(r.prefixPreviousMessageCount) : "n/a") + '</span></div>';
				h += '<div class="kv"><span class="k">Reusable %</span><span class="v">' + (isColdStart ? '—' : r.prefixReusableMessagePercent !== undefined ? PCT(r.prefixReusableMessagePercent) : "n/a") + '</span></div>';
				h += '<div class="kv"><span class="k">Static fields</span><span class="v">' + (isColdStart ? '—' : YESNO(r.prefixStaticFieldsMatch)) + '</span></div>';
				h += '<div class="kv"><span class="k">Tools match</span><span class="v">' + (isColdStart ? '—' : YESNO(r.prefixToolsMatch)) + '</span></div>';
				h += '<div class="kv"><span class="k">Reason</span><span class="v"><span class="' + REASON_CLASS(r.cacheMissReason || 'unknown') + '">' + REASON_LABEL(r.cacheMissReason || 'unknown') + '</span></span></div>';
				h += '<div class="kv"><span class="k">Detail</span><span class="v">' + esc(r.cacheMissDetail || "—") + '</span></div>';
			}

			// Cache hit bar: Codex uses the final model segment, Claude separates
			// cache reads from cache creation, and stateless HTTP uses the prompt.
			const detailInputTokens = IS_CODEX(r) && typeof r.finalSegmentInputTokens === "number" ? r.finalSegmentInputTokens : r.promptTokens;
			const detailCachedTokens = IS_CODEX(r) && typeof r.finalSegmentCachedInputTokens === "number" ? r.finalSegmentCachedInputTokens : r.cachedPromptTokens;
			if (typeof detailInputTokens === "number" && detailInputTokens > 0 && typeof detailCachedTokens === "number") {
				const cached = detailCachedTokens;
				const uncached = Math.max(0, detailInputTokens - cached);
				const hitPct = (cached / detailInputTokens) * 100;
				const cacheWrite = IS_CLAUDE(r) ? Math.min(uncached, r.cacheWriteInputTokens ?? 0) : 0;
				const fresh = Math.max(0, uncached - cacheWrite);
				const writePct = (cacheWrite / detailInputTokens) * 100;
				const missPct = (fresh / detailInputTokens) * 100;
				h += '<div style="margin-top:4px">';
				h += '<div class="bar-wrap" style="width:100%">';
				if (hitPct > 0) h += '<div class="bar bar-cached" style="width:' + hitPct.toFixed(1) + '%" title="Cached: ' + FMT(cached) + ' tokens"></div>';
				if (writePct > 0) h += '<div class="bar bar-cache-write" style="width:' + writePct.toFixed(1) + '%" title="Cache creation: ' + FMT(cacheWrite) + ' tokens"></div>';
				if (missPct > 0) h += '<div class="bar bar-uncached" style="width:' + missPct.toFixed(1) + '%" title="Fresh: ' + FMT(fresh) + ' tokens"></div>';
				h += '</div>';
				h += '<div style="font-size:10px;color:var(--dim);margin-top:1px">';
				h += '<span style="color:var(--good)">cached ' + FMT(cached) + ' (' + hitPct.toFixed(1) + '%)</span>';
				if (IS_CLAUDE(r)) h += ' &middot; <span style="color:var(--warn)">cache write ' + FMT(cacheWrite) + ' (' + writePct.toFixed(1) + '%)</span>';
				h += ' &middot; <span style="color:var(--bad)">' + (IS_CLAUDE(r) ? 'fresh ' + FMT(fresh) : 'uncached ' + FMT(uncached)) + ' (' + missPct.toFixed(1) + '%)</span>';
				h += '</div>';

				// Composition: explain WHERE the uncached tokens came from.
				const prevMsgCount = r.prefixPreviousMessageCount;
				const matchMsgCount = r.prefixIdenticalMessageCount;
				const curMsgCount = r.prefixMessageCount ?? (r.context?.messageCountAfterCompact);
				if (!IS_CODEX(r) && typeof prevMsgCount === "number" && typeof matchMsgCount === "number") {
					const newMsgs = prevMsgCount - matchMsgCount;
					const addedMsgs = typeof curMsgCount === "number" ? Math.max(0, curMsgCount - matchMsgCount) : undefined;
					h += '<div style="font-size:11px;margin-top:2px">';
					h += '<span style="color:var(--dim)">Messages matched: </span><strong>' + matchMsgCount + ' of ' + prevMsgCount + '</strong>';
					if (newMsgs > 0) h += ' (' + newMsgs + ' changed/dropped)';
					if (addedMsgs !== undefined && addedMsgs > 0) h += ' &middot; +' + addedMsgs + ' new messages this turn';
					h += '</div>';
					// Token estimate: uncached tokens ≈ tokens from new/changed messages
					const avgNewMsgTokens = addedMsgs && addedMsgs > 0 && uncached > 0 ? Math.round(uncached / addedMsgs) : 0;
					if (avgNewMsgTokens > 0) {
						h += '<div style="font-size:10px;color:var(--dim);margin-top:1px">~' + avgNewMsgTokens + ' tok per new message (estimated)</div>';
					}
				}
				h += '</div>';
			}
			h += '</section>';

			// Context section
			if (r.context) {
				const c = r.context;
				h += '<section class="detail-card wide"><h3>' + (IS_CODEX(r) ? 'Final context snapshot' : IS_CLAUDE(r) ? 'Claude SDK context snapshot' : 'Context budget') + '</h3>';
				h += '<div class="kv"><span class="k">Budget</span><span class="v">' + FMT(c.contextLength) + ' total / ' + FMT(c.inputBudget) + ' usable</span></div>';
				if (IS_STATEFUL(r)) h += '<div class="kv"><span class="k">Processed across segments</span><span class="v">' + FMT(r.promptTokens) + ' input · ' + FMT(r.outputTokens) + ' output</span></div>';
				if (IS_CLAUDE(r) && c.rawMaxTokens !== undefined) h += '<div class="kv"><span class="k">Provider raw / SDK usable</span><span class="v">' + FMT(c.rawMaxTokens) + ' / ' + FMT(c.usableMaxTokens) + '</span></div>';
				h += '<div class="kv"><span class="k">Messages</span><span class="v">' + FMT(c.messageTokensAfterCompact) + ' tok (' + c.messageCountAfterCompact + ' msgs) → was ' + FMT(c.messageTokensBeforeCompact) + ' (' + c.messageCountBeforeCompact + ')</span></div>';
				h += '<div class="kv"><span class="k">Reply reserve</span><span class="v">' + FMT(c.replyReserveTokens) + ' (' + FMT1((c.replyReserveTokens / c.contextLength) * 100) + '% of ctx)</span></div>';
				h += '<div class="kv"><span class="k">Tool tokens</span><span class="v">' + FMT(c.toolTokens) + ' (' + c.cappedTools + ' tools)</span></div>';
				h += '<div class="kv"><span class="k">System / history / output</span><span class="v">' + FMT(c.otherTokens ?? 0) + '</span></div>';
				h += '<div class="kv"><span class="k">Soft / Hard target</span><span class="v">' + FMT(c.softInputTarget) + ' / ' + FMT(c.hardInputTarget) + '</span></div>';
				h += '<div class="kv"><span class="k">Token source</span><span class="v">' + c.tokenCountSource + '</span></div>';
				if (IS_CLAUDE(r) && Array.isArray(c.categories) && c.categories.length) {
					const categories = c.categories.filter(category => category.tokens > 0).map(category => esc(category.name) + ' ' + FMT(category.tokens)).join(' · ');
					h += '<div class="kv"><span class="k">SDK categories</span><span class="v">' + (categories || '—') + '</span></div>';
				}

				// Cache hit bar visual
				const used = c.estimatedUsedTokens || 0;
				const free = c.estimatedFreeTokens || 0;
				const total = used + free;
				const replyFrac = total > 0 ? (c.replyReserveTokens / total) * 100 : 0;
				const msgFrac = total > 0 ? ((c.messageTokensAfterCompact || 0) / total) * 100 : 0;
				const toolFrac = total > 0 ? ((c.toolTokens || 0) / total) * 100 : 0;
				const otherFrac = total > 0 ? ((c.otherTokens || 0) / total) * 100 : 0;
				const freeFrac = Math.max(0, 100 - replyFrac - msgFrac - toolFrac - otherFrac);
				h += '<div class="bar-wrap" style="width:100%;margin-top:4px">';
				if (msgFrac > 0) h += '<div class="bar bar-cached" style="width:' + msgFrac.toFixed(1) + '%" title="Messages"></div>';
				if (toolFrac > 0) h += '<div class="bar" style="width:' + toolFrac.toFixed(1) + '%;background:#888" title="Tools"></div>';
				if (otherFrac > 0) h += '<div class="bar" style="width:' + otherFrac.toFixed(1) + '%;background:var(--purple)" title="System / history / output"></div>';
				h += '<div class="bar" style="width:' + replyFrac.toFixed(1) + '%;background:#555" title="Reply reserve"></div>';
				if (freeFrac > 0) h += '<div class="bar" style="width:' + freeFrac.toFixed(1) + '%;background:transparent;border:1px solid #444" title="Free"></div>';
				h += '</div>';
				h += '<div style="font-size:10px;color:var(--dim);margin-top:1px">msg <span style="color:var(--good)">' + FMT(c.messageTokensAfterCompact) + '</span> &middot; tools ' + FMT(c.toolTokens) + ' &middot; other ' + FMT(c.otherTokens ?? 0) + ' &middot; reply ' + FMT(c.replyReserveTokens) + ' &middot; free ' + FMT(c.estimatedFreeTokens) + '</div>';
				h += '</section>';
			}

			// Tool section
			h += '<section class="detail-card"><h3>Tool reliability</h3>';
			h += '<div class="kv"><span class="k">Observed tool events</span><span class="v">' + (r.toolCalls ?? 0) + '</span></div>';
			if (IS_STATEFUL(r)) {
				h += '<div class="kv"><span class="k">Delegated VS Code tools</span><span class="v">' + FMT(r.delegatedToolCalls ?? 0) + '</span></div>';
			}
			if (IS_CODEX(r)) {
				h += '<div class="kv"><span class="k">Catalog lookups</span><span class="v">' + FMT(r.catalogToolCalls ?? 0) + '</span></div>';
			}
			h += '<div class="kv"><span class="k">Repaired</span><span class="v">' + (r.repairedToolCalls ?? 0) + '</span></div>';
			h += '<div class="kv"><span class="k">Rejected</span><span class="v">' + (r.rejectedToolCalls ?? 0) + ' (schema: ' + (r.schemaRejectedToolCalls ?? 0) + ')</span></div>';
			h += '<div class="kv"><span class="k">Repair retries</span><span class="v">' + (r.toolCallRepairRetries ?? 0) + '</span></div>';
			h += '<div class="kv"><span class="k">Loop detected</span><span class="v">' + (r.toolLoopDetected ? "⚠️ yes" : "no") + '</span></div>';
			if (r.averageToolDurationMs !== undefined) h += '<div class="kv"><span class="k">Round-trip avg / p95 / max</span><span class="v">' + DURATION(r.averageToolDurationMs) + ' / ' + DURATION(r.p95ToolDurationMs) + ' / ' + DURATION(r.maximumToolDurationMs) + '</span></div>';
			if (r.toolDurationTotalMs !== undefined) h += '<div class="kv"><span class="k">Tool wait total</span><span class="v">' + DURATION(r.toolDurationTotalMs) + '</span></div>';
			if (r.toolCallBreakdown && Object.keys(r.toolCallBreakdown).length) {
				const breakdown = Object.entries(r.toolCallBreakdown).map(([name, count]) => esc(name) + ' ×' + count).join(' · ');
				h += '<div class="kv"><span class="k">Breakdown</span><span class="v">' + breakdown + '</span></div>';
			}
			h += '</section>';

			// Performance
			h += '<section class="detail-card"><h3>Performance</h3>';
			if (r.lifecyclePhase) h += '<div class="kv"><span class="k">Lifecycle</span><span class="v ' + LIFECYCLE_TONE(r.lifecyclePhase) + '">' + esc(r.lifecyclePhase) + '</span></div>';
			h += '<div class="kv"><span class="k">Duration</span><span class="v">' + (r.durationMs ?? 0) + ' ms' + '</span></div>';
			h += '<div class="kv"><span class="k">Queue wait</span><span class="v">' + (r.queueWaitMs ?? 0) + ' ms' + '</span></div>';
			if ((r.modelTurns ?? 1) > 1) h += '<div class="kv"><span class="k">Model turns</span><span class="v">' + r.modelTurns + ' (multi-step)</span></div>';
			if (r.firstTokenLatencyMs !== undefined) h += '<div class="kv"><span class="k">' + (IS_STATEFUL(r) ? 'First model event' : 'First token') + '</span><span class="v">' + DURATION(r.firstTokenLatencyMs) + '</span></div>';
			if (r.firstVisibleLatencyMs !== undefined) h += '<div class="kv"><span class="k">First visible text</span><span class="v">' + DURATION(r.firstVisibleLatencyMs) + '</span></div>';
			if (r.reasoningOutputTokens !== undefined) h += '<div class="kv"><span class="k">Reasoning tokens</span><span class="v">' + FMT(r.reasoningOutputTokens) + '</span></div>';
			if (r.metricsSource) h += '<div class="kv"><span class="k">Metrics source</span><span class="v">' + esc(r.metricsSource) + '</span></div>';
			if (IS_STATEFUL(r)) {
				h += '<div class="kv"><span class="k">Visible output</span><span class="v">' + FMT(r.outputChars ?? 0) + ' chars</span></div>';
				const usageState = r.lifecyclePhase === "running"
					? (r.usageEstimated ? "provisional estimate" : "provisional server snapshot")
					: (r.usageEstimated ? "terminal estimate (no server segment)" : IS_CLAUDE(r) ? "final Agent SDK metrics" : "final server/rollout metrics");
				h += '<div class="kv"><span class="k">Usage state</span><span class="v">' + usageState + '</span></div>';
			} else {
				h += '<div class="kv"><span class="k">Emitted parts</span><span class="v">' + (r.emittedParts ?? 0) + ' (' + (r.outputChars ?? 0) + ' chars / ' + (r.thinkingChars ?? 0) + ' thinking)</span></div>';
				h += '<div class="kv"><span class="k">Usage estimated</span><span class="v">' + (r.usageEstimated ? "yes (no server usage)" : "no (server payload)") + '</span></div>';
			}
			h += '<div class="kv"><span class="k">Overflow retry</span><span class="v">' + (r.retriedAfterOverflow ? "yes" : "no") + '</span></div>';
			h += '</section>';

			if (Array.isArray(r.steps) && r.steps.length) {
				h += '<section class="detail-card wide"><h3>' + (IS_CLAUDE(r) ? 'Claude' : IS_CODEX(r) ? 'Codex' : 'Provider') + ' live steps (' + FMT(r.steps.length) + ')</h3>';
				h += '<div class="table-shell" style="max-height:340px"><table><thead><tr><th>#</th><th>Kind</th><th>Step</th><th>Status</th><th>At</th><th>Duration</th><th>Input</th><th>Cache read</th><th>Cache write</th><th>Output</th></tr></thead><tbody>';
				for (const step of DISPLAY_SERIES(r.steps)) {
					const statusClass = step.status === 'failed' || step.status === 'timed_out' ? 'bad' : step.status === 'running' || step.status === 'cancelled' ? 'warn' : 'good';
					const kindLabel = step.kind === 'tool' && step.toolCategory ? 'tool · ' + step.toolCategory : step.kind;
					h += '<tr><td>' + FMT(step.index) + '</td><td>' + esc(kindLabel) + '</td><td>' + esc(step.label) + '</td><td class="' + statusClass + '">' + esc(step.status) + '</td><td>' + esc(step.startedAt ? new Date(step.startedAt).toLocaleTimeString() : 'n/a') + '</td><td>' + DURATION(step.durationMs) + '</td><td>' + FMT(step.inputTokens) + '</td><td class="' + HIT_COLOR(step.cacheHitPercent) + '">' + FMT(step.cachedInputTokens) + ' · ' + PCT(step.cacheHitPercent) + '</td><td>' + FMT(step.cacheCreationInputTokens) + '</td><td>' + FMT(step.outputTokens) + '</td></tr>';
				}
				h += '</tbody></table></div>';
				if (r.steps.length > 12) h += '<div class="section-note" style="margin-top:6px">Showing the first 3 and last 5 steps. Use Alt+Copy for the full JSON.</div>';
				h += '</section>';
			}

			if (Array.isArray(r.usageSegments) && r.usageSegments.length) {
				h += '<section class="detail-card wide"><h3>Model usage segments (' + FMT(r.modelTurns ?? r.usageSegments.length) + ')</h3>';
				h += '<div class="table-shell" style="max-height:300px"><table><thead><tr><th>#</th><th>At</th>' + (IS_CLAUDE(r) ? '<th>Fresh</th>' : '') + '<th>Input</th><th>Cache read</th>' + (IS_CLAUDE(r) ? '<th>Cache write</th>' : '') + '<th>Hit</th><th>Output</th><th>Reasoning</th><th>Total</th></tr></thead><tbody>';
				for (const segment of DISPLAY_SERIES(r.usageSegments)) {
					h += '<tr><td>' + FMT(segment.index) + '</td><td>' + esc(segment.recordedAt ? new Date(segment.recordedAt).toLocaleTimeString() : 'n/a') + '</td>' + (IS_CLAUDE(r) ? '<td>' + FMT(segment.freshInputTokens) + '</td>' : '') + '<td>' + FMT(segment.inputTokens) + '</td><td>' + FMT(segment.cachedInputTokens) + '</td>' + (IS_CLAUDE(r) ? '<td>' + FMT(segment.cacheCreationInputTokens) + '</td>' : '') + '<td class="' + HIT_COLOR(segment.cacheHitPercent) + '">' + PCT(segment.cacheHitPercent) + '</td><td>' + FMT(segment.outputTokens) + '</td><td>' + FMT(segment.reasoningOutputTokens) + '</td><td>' + FMT(segment.totalTokens) + '</td></tr>';
				}
				h += '</tbody></table></div>';
				if (r.usageSegments.length > 12) h += '<div class="section-note" style="margin-top:6px">Showing the first 3 and last 5 usage segments. Use Alt+Copy for the full JSON.</div>';
				if (r.usageSegmentsTruncated) h += '<div class="section-note" style="margin-top:6px">Only the first retained segment snapshots are shown.</div>';
				h += '</section>';
			}

			// Request and backend diagnostics
			const hasBackend = r.backendVia || r.backendCfPop || r.backendTraceId;
			h += '<section class="detail-card wide"><h3>Request &amp; backend</h3>';
			h += '<div class="kv"><span class="k">Request ID</span><span class="v backend-info">' + esc(r.requestId || 'n/a') + '</span></div>';
			if (r.conversationKey) h += '<div class="kv"><span class="k">Conversation key</span><span class="v backend-info">' + esc(r.conversationKey) + '</span></div>';
			if (r.parentRequestId) h += '<div class="kv"><span class="k">Parent request</span><span class="v backend-info">' + esc(r.parentRequestId) + '</span></div>';
			if (r.parentToolCallId) h += '<div class="kv"><span class="k">Parent tool call</span><span class="v backend-info">' + esc(r.parentToolCallId) + '</span></div>';
			if (hasBackend) {
				if (r.backendVia) h += '<div class="kv"><span class="k">Via</span><span class="v backend-info">' + esc(r.backendVia) + '</span></div>';
				if (r.backendCfPop) h += '<div class="kv"><span class="k">Cf-Pop</span><span class="v backend-info">' + esc(r.backendCfPop) + '</span></div>';
				if (r.backendTraceId) h += '<div class="kv"><span class="k">Trace-ID</span><span class="v backend-info">' + esc(r.backendTraceId) + '</span></div>';
			}
			h += '</section>';

			h += '</div>';
			h += '</td></tr>';
		}
		h += '</tbody></table></div></section>';
	} else {
		h += '<div class="empty">No turns recorded yet. Start a model turn to see live metrics here.</div>';
	}

	h += '</main>';
	document.getElementById("app").innerHTML = h;
}

// Delegated click handler — avoids onclick attributes (stripped by VS Code Webview).
document.addEventListener("click", function(e) {
	const issuesButton = e.target.closest("#issues-filter");
	if (issuesButton) {
		const active = !issuesButton.classList.contains("active");
		issuesButton.classList.toggle("active", active);
		issuesButton.setAttribute("aria-pressed", String(active));
		applyTurnFilters();
		return;
	}

	const expandButton = e.target.closest("#expand-all");
	if (expandButton) {
		const visibleRows = [...document.querySelectorAll(".turn-row:not(.hidden-row)")];
		const shouldOpen = visibleRows.some(row => row.getAttribute("aria-expanded") !== "true");
		visibleRows.forEach(row => setRowOpen(row, shouldOpen));
		expandButton.textContent = shouldOpen ? "Collapse all" : "Expand all";
		return;
	}

	// Copy button
	const copyBtn = e.target.closest(".copy-btn");
	if (copyBtn) {
		e.stopPropagation();
		const index = Number(copyBtn.getAttribute("data-index"));
		const fullRecord = Number.isInteger(index) ? DATA.records[index] : undefined;
		const json = e.altKey && fullRecord
			? JSON.stringify(fullRecord)
			: copyBtn.getAttribute("data-json");
		if (!json) return;
		const asText = e.shiftKey;
		const content = asText && fullRecord
			? formatTurnText(fullRecord)
			: JSON.stringify(JSON.parse(json), null, 2);
		navigator.clipboard.writeText(content).then(function() {
			copyBtn.textContent = "Copied";
			copyBtn.classList.add("copied");
			setTimeout(function() {
				copyBtn.textContent = "Copy";
				copyBtn.classList.remove("copied");
			}, 1200);
		}).catch(function() {
			copyBtn.textContent = "Failed";
			setTimeout(function() { copyBtn.textContent = "Copy"; }, 800);
		});
		return;
	}

	// Expand/collapse
	const row = e.target.closest(".turn-row");
	if (!row) return;
	setRowOpen(row, row.getAttribute("aria-expanded") !== "true");
});

document.addEventListener("keydown", function(e) {
	if (e.key !== "Enter" && e.key !== " ") return;
	const target = e.target;
	if (target.closest(".turn-row") || target.closest(".copy-btn")) {
		e.preventDefault();
		target.click();
	}
});

document.addEventListener("input", function(e) {
	if (e.target.id === "turn-search") applyTurnFilters();
});
document.addEventListener("change", function(e) {
	if (e.target.id === "model-filter") applyTurnFilters();
});

function setRowOpen(row, open) {
	const detailId = row.getAttribute("data-detail");
	const detail = detailId ? document.getElementById(detailId) : null;
	const icon = row.querySelector(".expand-icon");
	if (!detail || !icon) return;
	detail.classList.toggle("open", open);
	row.classList.toggle("open", open);
	row.setAttribute("aria-expanded", String(open));
	icon.classList.toggle("open", open);
}

function applyTurnFilters() {
	const query = (document.getElementById("turn-search")?.value || "").trim().toLowerCase();
	const model = document.getElementById("model-filter")?.value || "";
	const issuesOnly = document.getElementById("issues-filter")?.classList.contains("active") || false;
	document.querySelectorAll(".turn-row").forEach(function(row) {
		const matchesQuery = !query || (row.getAttribute("data-search") || "").includes(query);
		const matchesModel = !model || row.getAttribute("data-model") === model;
		const matchesIssue = !issuesOnly || row.getAttribute("data-issue") === "1";
		const visible = matchesQuery && matchesModel && matchesIssue;
		row.classList.toggle("hidden-row", !visible);
		const detail = document.getElementById(row.getAttribute("data-detail"));
		if (detail) detail.classList.toggle("hidden-row", !visible);
	});
}

// Save / restore open detail rows across live updates (postMessage re-renders).
function saveOpenRows() {
	const open = new Set();
	document.querySelectorAll(".detail-row.open").forEach(function(el) {
		open.add(el.id);
	});
	return open;
}
function restoreOpenRows(open) {
	open.forEach(function(id) {
		const el = document.getElementById(id);
		if (el) {
			const row = document.querySelector('.turn-row[data-detail="' + id + '"]');
			if (row) setRowOpen(row, true);
		}
	});
}

function captureViewState() {
	return {
		openRows: saveOpenRows(),
		query: document.getElementById("turn-search")?.value || "",
		model: document.getElementById("model-filter")?.value || "",
		issuesOnly: document.getElementById("issues-filter")?.classList.contains("active") || false,
	};
}

function restoreViewState(state) {
	const search = document.getElementById("turn-search");
	const model = document.getElementById("model-filter");
	const issues = document.getElementById("issues-filter");
	if (search) search.value = state.query;
	if (model) model.value = state.model;
	if (issues) {
		issues.classList.toggle("active", state.issuesOnly);
		issues.setAttribute("aria-pressed", String(state.issuesOnly));
	}
	applyTurnFilters();
	restoreOpenRows(state.openRows);
}

function esc(s) {
	return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Build a human-readable text representation of a turn record.
function formatTurnText(r) {
	var lines = [];
	var c = r.context || {};
	var fmt = function(v) { return v === undefined || v === null ? "n/a" : typeof v === "number" ? v.toLocaleString() : String(v); };

	lines.push("Turn " + r.index + " — " + (r.modelId || "n/a"));
	lines.push("═".repeat(50));
	lines.push("");
	lines.push("Model: " + (r.modelId || "n/a"));
	lines.push("Processed input tokens: " + fmt(r.promptTokens));
	lines.push("Output tokens: " + fmt(r.outputTokens || r.estimatedOutputTokens));
	lines.push("Cached tokens: " + fmt(r.cachedPromptTokens) + (r.promptCacheHitPercent !== undefined ? " (" + r.promptCacheHitPercent.toFixed(1) + "%)" : ""));
	lines.push("Duration: " + fmt(r.durationMs) + " ms");
	lines.push((IS_STATEFUL(r) ? "First model event: " : "TTFT: ") + (r.firstTokenLatencyMs !== undefined ? r.firstTokenLatencyMs + " ms" : "n/a"));
	lines.push("First visible text: " + (r.firstVisibleLatencyMs !== undefined ? r.firstVisibleLatencyMs + " ms" : "n/a"));
	lines.push("Speed: " + (r.tokensPerSecond !== undefined ? r.tokensPerSecond.toFixed(1) + " tok/s" : "n/a"));
	lines.push("Queue wait: " + fmt(r.queueWaitMs) + " ms");
	lines.push("Model turns: " + fmt(r.modelTurns));

	// Prefix/session
	lines.push("");
	if (IS_CODEX(r)) {
		lines.push("── Codex session ──");
		lines.push("Lifecycle: " + fmt(r.lifecyclePhase));
		lines.push("Thread mode: " + fmt(r.threadMode));
		lines.push("Reuse miss: " + fmt(r.threadReuseMissReason));
		lines.push("First segment cache: " + PCT(r.initialSegmentCacheHitPercent));
		lines.push("Final/continuation cache: " + PCT(EFFECTIVE_HIT(r)));
		if (r.terminalDetail) lines.push("Terminal detail: " + r.terminalDetail);
	} else if (IS_CLAUDE(r)) {
		lines.push("── Claude session ──");
		lines.push("Lifecycle: " + fmt(r.lifecyclePhase));
		lines.push("Session mode: " + fmt(r.sessionMode));
		lines.push("Cache read: " + fmt(r.cachedPromptTokens) + " (" + PCT(r.promptCacheHitPercent) + ")");
		lines.push("Cache creation: " + fmt(r.cacheWriteInputTokens));
		lines.push("Fresh input: " + fmt(Math.max(0, (r.promptTokens || 0) - (r.cachedPromptTokens || 0) - (r.cacheWriteInputTokens || 0))));
		if (r.terminalDetail) lines.push("Terminal detail: " + r.terminalDetail);
	} else {
		lines.push("── Prefix match ──");
		var isCold = r.prefixPreviousMessageCount === undefined;
		lines.push("Identical msgs: " + (isCold ? "cold start" : fmt(r.prefixIdenticalMessageCount) + " of " + fmt(r.prefixPreviousMessageCount)));
		lines.push("Reusable %: " + (isCold ? "—" : r.prefixReusableMessagePercent !== undefined ? r.prefixReusableMessagePercent.toFixed(1) + "%" : "n/a"));
		lines.push("Static fields: " + (isCold ? "—" : r.prefixStaticFieldsMatch ? "✅" : "❌"));
		lines.push("Tools match: " + (isCold ? "—" : r.prefixToolsMatch ? "✅" : "❌"));
	}

	// Cache
	lines.push("");
	lines.push("── Cache ──");
	lines.push("Reason: " + (r.cacheMissReason || "n/a"));
	lines.push("Detail: " + (r.cacheMissDetail || "—"));
	if (typeof r.promptTokens === "number" && r.promptTokens > 0) {
		var cached = r.cachedPromptTokens || 0;
		var written = IS_CLAUDE(r) ? (r.cacheWriteInputTokens || 0) : 0;
		var uncached = Math.max(0, r.promptTokens - cached - written);
		lines.push("processed cached/read " + fmt(cached) + " (" + (r.promptCacheHitPercent || 0).toFixed(1) + "%)" + (IS_CLAUDE(r) ? " · cache write " + fmt(written) + " · fresh " + fmt(uncached) : " · processed uncached " + fmt(uncached)));
	}

	// Context
	if (r.context) {
		lines.push("");
		lines.push("── Context ──");
		lines.push("Budget: " + fmt(c.contextLength) + " total / " + fmt(c.inputBudget) + " usable");
		lines.push("Messages: " + fmt(c.messageTokensAfterCompact) + " tok (" + fmt(c.messageCountAfterCompact) + " msgs) ← was " + fmt(c.messageTokensBeforeCompact) + " (" + fmt(c.messageCountBeforeCompact) + ")");
		lines.push("Reply reserve: " + fmt(c.replyReserveTokens) + " (" + (c.replyReserveTokens / c.contextLength * 100).toFixed(1) + "%)");
		lines.push("Tool tokens: " + fmt(c.toolTokens) + " (" + fmt(c.cappedTools) + " tools)");
		lines.push("System/history/output: " + fmt(c.otherTokens));
		lines.push("Target soft/hard: " + fmt(c.softInputTarget) + " / " + fmt(c.hardInputTarget));
		lines.push("Token source: " + (c.tokenCountSource || "n/a"));
		if (IS_CLAUDE(r) && c.rawMaxTokens !== undefined) lines.push("Provider raw / SDK usable: " + fmt(c.rawMaxTokens) + " / " + fmt(c.usableMaxTokens));
		if (IS_CLAUDE(r) && Array.isArray(c.categories)) lines.push("SDK categories: " + c.categories.filter(function(category) { return category.tokens > 0; }).map(function(category) { return category.name + " " + fmt(category.tokens); }).join(" · "));
		lines.push("Compaction: " + (c.hardCompacted ? "hard" : c.autoCompacted ? "auto" : "none"));
	}

	// Tools
	lines.push("");
	lines.push("── Tools ──");
	lines.push("Observed tool events: " + fmt(r.toolCalls));
	if (IS_STATEFUL(r)) {
		lines.push("Delegated VS Code tools: " + fmt(r.delegatedToolCalls));
	}
	if (IS_CODEX(r)) {
		lines.push("Catalog lookups: " + fmt(r.catalogToolCalls));
	}
	lines.push("Repaired: " + fmt(r.repairedToolCalls));
	lines.push("Rejected: " + fmt(r.rejectedToolCalls) + " (schema: " + fmt(r.schemaRejectedToolCalls) + ")");
	lines.push("Repair retries: " + fmt(r.toolCallRepairRetries));
	lines.push("Loop detected: " + (r.toolLoopDetected ? "⚠️ yes" : "no"));
	lines.push("Tool wait total: " + fmt(r.toolDurationTotalMs) + " ms");
	lines.push("Tool round-trip avg/p95/max: " + fmt(r.averageToolDurationMs) + " / " + fmt(r.p95ToolDurationMs) + " / " + fmt(r.maximumToolDurationMs) + " ms");
	if (r.toolCallBreakdown) lines.push("Breakdown: " + Object.entries(r.toolCallBreakdown).map(function(entry) { return entry[0] + " ×" + entry[1]; }).join(" · "));

	// Performance
	lines.push("");
	lines.push("── Performance ──");
	lines.push("Lifecycle: " + fmt(r.lifecyclePhase));
	lines.push("Duration: " + fmt(r.durationMs) + " ms");
	if ((r.modelTurns ?? 1) > 1) lines.push("Model turns: " + r.modelTurns + " (multi-step)");
	lines.push("Reasoning tokens: " + fmt(r.reasoningOutputTokens));
	lines.push("Metrics source: " + fmt(r.metricsSource));
	lines.push("Retained usage segments: " + fmt(r.usageSegments?.length) + (r.usageSegmentsTruncated ? " (truncated)" : ""));
	lines.push("Emitted parts: " + fmt(r.emittedParts));
	lines.push("Output chars: " + fmt(r.outputChars));
	lines.push("Thinking chars: " + fmt(r.thinkingChars));
	var codexUsageState = r.lifecyclePhase === "running"
		? (r.usageEstimated ? "provisional estimate" : "provisional server snapshot")
		: (r.usageEstimated ? "terminal estimate (no server segment)" : "final server/rollout metrics");
	lines.push("Usage state: " + (IS_CODEX(r) ? codexUsageState : IS_CLAUDE(r) ? (r.usageEstimated ? "provisional estimate" : "Agent SDK payload") : (r.usageEstimated ? "estimated" : "server payload")));
	lines.push("Overflow retry: " + (r.retriedAfterOverflow ? "yes" : "no"));

	// Backend
	if (r.backendVia || r.backendCfPop || r.backendTraceId) {
		lines.push("");
		lines.push("── Backend ──");
		if (r.backendVia) lines.push("Via: " + r.backendVia);
		if (r.backendCfPop) lines.push("Cf-Pop: " + r.backendCfPop);
		if (r.backendTraceId) lines.push("Trace-ID: " + r.backendTraceId);
	}

	// Request ID
	lines.push("");
	lines.push("Request ID: " + (r.requestId || "n/a"));
	if (r.conversationKey) lines.push("Conversation key: " + r.conversationKey);
	if (r.parentRequestId) lines.push("Parent request: " + r.parentRequestId);
	if (r.parentToolCallId) lines.push("Parent tool call: " + r.parentToolCallId);

	return lines.join("\\n");
}

// Listen for live-update messages from the extension.
window.addEventListener("message", function(e) {
	if (e.data && e.data.type === "update") {
		var viewState = captureViewState();
		DATA = e.data.data;
		try {
			render();
		} catch (err) {
			showError(err);
		}
		restoreViewState(viewState);
	}
});

function showError(err) {
	var app = document.getElementById("app");
	app.innerHTML = "";
	var div = document.createElement("div");
	div.className = "empty";
	div.style.color = "var(--bad)";
	div.textContent = "Error: " + (err && err.message ? err.message : String(err || "unknown"));
	app.appendChild(div);
}

try {
	render();
} catch (err) {
	showError(err);
}
</script>
</body>
</html>`;
	}
}
