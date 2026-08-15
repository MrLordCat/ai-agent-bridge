import * as vscode from "vscode";
import type { ClaudeCacheKeepAliveStatus } from "../claude/claude-provider";
import type { SessionQualityTracker, SessionTurnRecord } from "../diagnostics/session-report";

/**
 * Collects agent/tool/API failures from turn records so the dashboard can show
 * exactly which turn, chat and tool were involved. Failed llama/deepseek turns
 * now land in the tracker as lifecyclePhase "failed" records; Claude/Codex
 * already report their failures through lifecyclePhase, resume/safety stops
 * and repair counters.
 */
function collectTurnErrors(records: readonly SessionTurnRecord[] | undefined): Array<{
	index: number;
	conversationKey?: string;
	modelId?: string;
	startedAtMs?: number;
	kind: string;
	detail: string;
	count: number;
}> {
	const errors: Array<{
		index: number;
		conversationKey?: string;
		modelId?: string;
		startedAtMs?: number;
		kind: string;
		detail: string;
		count: number;
	}> = [];
	if (!records) {
		return errors;
	}
	const push = (
		index: number,
		turn: { conversationKey?: string; modelId?: string; startedAtMs?: number },
		kind: string,
		detail: string,
		count = 1
	) => {
		errors.push({
			index,
			conversationKey: turn.conversationKey,
			modelId: turn.modelId,
			startedAtMs: turn.startedAtMs,
			kind,
			detail,
			count,
		});
	};
	records.forEach((record, index) => {
		const turn = record.turn;
		const turnIndex = index + 1;
		const phase = turn.lifecyclePhase;
		if (phase === "failed" || phase === "timed_out") {
			push(turnIndex, turn, phase === "failed" ? "turn_failed" : "turn_timed_out",
				(turn.terminalDetail || turn.resumeFailureDetail || "").slice(0, 400) || "turn ended with an error");
		}
		if (typeof turn.rejectedToolCalls === "number" && turn.rejectedToolCalls > 0) {
			const schemaPart = turn.schemaRejectedToolCalls ? ` (schema: ${turn.schemaRejectedToolCalls})` : "";
			push(turnIndex, turn, "tool_rejected",
				`${turn.rejectedToolCalls} tool call(s) rejected before execution${schemaPart} — the model called an unavailable tool or produced an invalid argument object`,
				turn.rejectedToolCalls);
		}
		if (typeof turn.toolCallRepairRetries === "number" && turn.toolCallRepairRetries > 0) {
			push(turnIndex, turn, "tool_repair_retry",
				`${turn.toolCallRepairRetries} repair retr${turn.toolCallRepairRetries === 1 ? "y" : "ies"} after a rejected tool call`);
		}
		if (turn.toolLoopDetected) {
			push(turnIndex, turn, "tool_loop", "tool call loop detected — repeated identical calls were stopped");
		}
		if (turn.reasoningLoopDetected) {
			push(
				turnIndex,
				turn,
				"reasoning_loop",
				`reasoning repetition loop detected — stream stopped${turn.reasoningLoopRetries ? ` and retried ${turn.reasoningLoopRetries} time(s) from a clean summary` : ""}`
			);
		}
		if (typeof turn.toolExecutionErrors === "number" && turn.toolExecutionErrors > 0) {
			const callLines = Array.isArray(turn.toolExecutionErrorDetails) && turn.toolExecutionErrorDetails.length > 0
				? turn.toolExecutionErrorDetails.map(d => {
					const label = d.command || d.name || "tool call";
					const head = d.head ? ` — ${d.head.replace(/\n/g, " ").slice(0, 90)}` : "";
					return `"${label}"${head}`;
				}).join("; ")
				: undefined;
			push(turnIndex, turn, "tool_execution_error",
				`${turn.toolExecutionErrors} tool result(s) contained execution failures (tracebacks, "Command exited with code 1", edit mismatch)${callLines ? ` — ${callLines}` : ""} — check the turn's tool output`,
				turn.toolExecutionErrors);
		}
		if (turn.retriedAfterOverflow) {
			push(turnIndex, turn, "api_overflow_retry", "the API rejected the prompt as too long; the turn was retried with a hard-compacted context");
		}
		if (turn.resumeFailureReason) {
			push(turnIndex, turn, "resume_failed",
				`${turn.resumeFailureReason}${turn.resumeFailureDetail ? `: ${turn.resumeFailureDetail}` : ""}`.slice(0, 400));
		}
		if (turn.safetyStopReason) {
			push(turnIndex, turn, "safety_stop",
				`${turn.safetyStopReason}${turn.safetyStopDetail ? `: ${turn.safetyStopDetail}` : ""}`.slice(0, 400));
		}
	});
	return errors;
}

export class SessionQualityPanel {
	public static readonly viewType = "llamacpp.sessionQuality";
	private static current: SessionQualityPanel | undefined;

	private readonly _panel: vscode.WebviewPanel;
	private readonly _tracker: SessionQualityTracker;
	private readonly _extensionVersion: string;
	private readonly _vscodeVersion: string;
	private readonly _getClaudeCacheKeepAliveStatus: () => ClaudeCacheKeepAliveStatus;
	private readonly _getHealthData: () => unknown;

	private constructor(
		panel: vscode.WebviewPanel,
		tracker: SessionQualityTracker,
		extensionVersion: string,
		vscodeVersion: string,
		getClaudeCacheKeepAliveStatus: () => ClaudeCacheKeepAliveStatus,
		getHealthData: () => unknown,
	) {
		this._panel = panel;
		this._tracker = tracker;
		this._extensionVersion = extensionVersion;
		this._vscodeVersion = vscodeVersion;
		this._getClaudeCacheKeepAliveStatus = getClaudeCacheKeepAliveStatus;
		this._getHealthData = getHealthData;

		this._panel.onDidDispose(() => {
			SessionQualityPanel.current = undefined;
		});

		this._panel.webview.onDidReceiveMessage(message => {
			if (message?.type === "runHealthCheck") {
				void vscode.commands.executeCommand("llamacpp.runHealthCheck");
			}
		});

		this.refresh();
	}

	public static createOrShow(
		extensionUri: vscode.Uri,
		tracker: SessionQualityTracker,
		extensionVersion: string,
		vscodeVersion: string,
		getClaudeCacheKeepAliveStatus: () => ClaudeCacheKeepAliveStatus,
		getHealthData: () => unknown,
	): void {
		if (SessionQualityPanel.current) {
			SessionQualityPanel.current._panel.reveal(vscode.ViewColumn.Beside);
			SessionQualityPanel.current.refresh();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			SessionQualityPanel.viewType,
			"Live Report",
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
				getHealthData,
			);
		} catch (err: unknown) {
			panel.dispose();
			throw new Error(`Failed to initialize session quality panel: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
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
			health: this._getHealthData() ?? null,
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
			errors: collectTurnErrors(rawRecords),
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
.model-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.model-card-head .model-name { flex: 1; }
.model-dim { color: var(--dim); font-size: 11px; overflow-wrap: anywhere; margin: 2px 0; }
.reason-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.reason-label { font-weight: 600; }
.reason-detail { color: var(--dim); font-size: 11px; margin-top: 2px; overflow-wrap: anywhere; }
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
th, td { padding: 8px 9px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { position: sticky; top: 0; z-index: 2; background: var(--surface-2); color: var(--dim); font-size: 10px; font-weight: 700; letter-spacing: .045em; text-transform: uppercase; }
tbody tr:last-child td { border-bottom: 0; }
tr.turn-row { cursor: pointer; transition: background .12s; }
tr.turn-row:hover, tr.turn-row.open { background: var(--row-hover); }
tr.turn-row.issue { box-shadow: inset 3px 0 0 var(--warn); }
tr.turn-row.critical { box-shadow: inset 3px 0 0 var(--bad); }
tr.detail-row { display: none; }
tr.detail-row.open { display: table-row; }
tr.detail-row > td { padding: 12px; white-space: normal; background: rgba(127,127,127,.05); border-top: 1px solid rgba(127,127,127,.18); border-bottom: 1px solid rgba(127,127,127,.18); }
tr.turn-row { border-bottom: 1px solid rgba(127,127,127,.1); }
tr.turn-row.open { border-bottom-color: transparent; }
.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
@media (max-width: 640px) {
	.detail-grid { grid-template-columns: 1fr; }
}
.detail-card { min-width: 0; padding: 11px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); transition: border-color .12s, box-shadow .12s; }
.detail-card:hover { border-color: rgba(127,127,127,.4); }
.detail-card.wide { grid-column: 1 / -1; }
.detail-card h3 { margin: 0 0 8px; font-size: 11px; letter-spacing: .045em; text-transform: uppercase; color: var(--dim); padding-bottom: 6px; border-bottom: 1px solid rgba(127,127,127,.14); display: flex; align-items: center; gap: 6px; }
.detail-card h3::before { content: ""; width: 3px; height: 12px; border-radius: 2px; background: var(--accent); opacity: .8; flex: none; }
.detail-card .kv { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; border-bottom: 1px dashed rgba(127,127,127,.1); }
.detail-card .kv:last-child { border-bottom: none; }
.detail-card .kv .k { color: var(--dim); flex: none; }
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
.reason-upstream_route_changed { background: rgba(245,158,11,.16); color: #f6c45f; }
.reason-upstream_cache_partial { background: rgba(245,158,11,.16); color: #f6c45f; }
.reason-ephemeral_context_changed { background: rgba(229,173,66,.16); color: #f2c66d; }
.reason-healthy { background: rgba(70,201,111,.14); color: var(--good); }
.reason-history_rebuilt_after_restart, .reason-history_rewritten, .reason-history_truncated, .reason-history_summarized { background: rgba(181,138,240,.15); color: #c9a7f6; }
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
/* Tabs */
.tabs { display: flex; gap: 4px; margin: 14px 0 4px; border-bottom: 1px solid var(--border); }
.tab-btn { padding: 7px 14px; border: 1px solid transparent; border-bottom: 0; border-radius: 6px 6px 0 0; background: transparent; color: var(--dim); font-size: 12px; font-weight: 650; cursor: pointer; }
.tab-btn:hover { color: var(--fg); background: var(--row-hover); }
.tab-btn.active { color: var(--accent); background: var(--surface); border-color: var(--border); margin-bottom: -1px; }
.tab-btn.tab-has-issues { color: var(--warn); }
.error-detail { max-width: 520px; white-space: normal; word-break: break-word; }
.tab-panel[hidden] { display: none; }
/* Performance tab */
.gap-hist { display: flex; align-items: flex-end; gap: 12px; padding: 14px 16px 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); }
.gap-hist-col { display: flex; flex-direction: column; align-items: center; gap: 3px; flex: 1; min-width: 0; }
.gap-hist-bar { width: 100%; max-width: 56px; background: linear-gradient(180deg, var(--accent), rgba(85, 150, 245, .45)); border-radius: 3px 3px 0 0; min-height: 2px; }
.gap-hist-count { font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }
.gap-hist-label { color: var(--dim); font-size: 9px; letter-spacing: .03em; white-space: nowrap; }
.spark { display: flex; align-items: flex-end; gap: 2px; min-height: 52px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); overflow-x: auto; }
.spark-bar { flex: 1 1 0; min-width: 2px; max-width: 26px; border-radius: 2px 2px 0 0; min-height: 3px; }
.spark-good { background: var(--good); opacity: .8; }
.spark-warn { background: var(--warn); }
.spark-bad { background: var(--bad); }
.perf-row.perf-slow td { box-shadow: inset 3px 0 0 var(--warn); }
.perf-row.perf-bad td { box-shadow: inset 3px 0 0 var(--bad); }
.perf-row td, .error-row td { padding: 8px 9px; }
tr.perf-row:hover td, tr.error-row:hover td { background: rgba(127,127,127,.06); }
.section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 4px 0 10px; }
.section-heading h2 { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: .02em; display: flex; align-items: center; gap: 7px; }
.section-heading h2::before { content: ""; width: 3px; height: 13px; border-radius: 2px; background: var(--accent); opacity: .85; }
.section { margin: 18px 0 6px; }
.reason-item, .model-card { border-bottom: 1px solid rgba(127,127,127,.1); }
.gap-user { color: var(--dim); font-style: italic; }
/* Ordered input structure and estimated prefix-cache coverage. */
.struct-bar { display: flex; width: 100%; height: 14px; border-radius: 3px; overflow: hidden; border: 1px solid var(--border); background: rgba(255,255,255,.05); }
.struct-bar .bar { height: 100%; border-radius: 0; }
.struct-detail-actions { display: flex; justify-content: flex-end; margin-top: 7px; }
.struct-detail-toggle { font-size: 10px; padding: 3px 7px; }
.struct-detail-list { display: none; margin-top: 7px; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; max-height: 360px; overflow-y: auto; }
.struct-detail-list.open { display: block; }
.struct-detail-row { display: grid; grid-template-columns: minmax(125px, 1fr) minmax(130px, 2fr) minmax(215px, auto); align-items: center; gap: 9px; padding: 6px 7px; border-bottom: 1px solid rgba(127,127,127,.12); }
.struct-detail-row:last-child { border-bottom: 0; }
.struct-detail-label { min-width: 0; overflow-wrap: anywhere; }
.struct-detail-order { color: var(--dim); display: inline-block; min-width: 22px; font-variant-numeric: tabular-nums; }
.struct-detail-meter { display: flex; width: 100%; height: 9px; overflow: hidden; border-radius: 3px; background: var(--track); }
.struct-detail-meter .bar { height: 100%; min-width: 3px; border-radius: 0; }
.struct-detail-stats { color: var(--dim); font-size: 10px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.struct-system, .struct-tools, .struct-memory, .struct-guard, .struct-user, .struct-assistant, .struct-reasoning, .struct-tool-io, .struct-summary, .struct-other { box-shadow: inset 0 0 0 1px rgba(255,255,255,.25); }
.struct-block { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.struct-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.struct-bar .bar-cached.struct-system { background: #2f8f4e; }
.struct-bar .bar-cached.struct-tools { background: #2e7d32; }
.struct-bar .bar-cached.struct-other { background: #3a8f6e; }
.struct-bar .bar-cached.struct-memory { background: #238b78; }
.struct-bar .bar-cached.struct-guard { background: #678a3e; }
.struct-bar .bar-cached.struct-user { background: #46a96f; }
.struct-bar .bar-cached.struct-assistant { background: #46c96f; }
.struct-bar .bar-cached.struct-reasoning { background: #369c64; }
.struct-bar .bar-cached.struct-tool-io { background: #2f966f; }
.struct-bar .bar-cached.struct-summary { background: #5a9c54; }
.struct-bar .bar-uncached.struct-system { background: #7a2e2e; }
.struct-bar .bar-uncached.struct-tools { background: #a33b3b; }
.struct-bar .bar-uncached.struct-other { background: #a3663b; }
.struct-bar .bar-uncached.struct-memory { background: #d15d76; }
.struct-bar .bar-uncached.struct-guard { background: #b47745; }
.struct-bar .bar-uncached.struct-user { background: #df654f; }
.struct-bar .bar-uncached.struct-assistant { background: #ef6262; }
.struct-bar .bar-uncached.struct-reasoning { background: #d94d63; }
.struct-bar .bar-uncached.struct-tool-io { background: #d95b47; }
.struct-bar .bar-uncached.struct-summary { background: #c46a43; }
.struct-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
.gap-user { color: var(--dim); opacity: .75; font-style: italic; }
@media (max-width: 1180px) {
	.metric-grid { grid-template-columns: repeat(3, minmax(150px, 1fr)); }
}
@media (max-width: 720px) {
	.page { padding: 16px 12px 30px; }
	.topbar, .turn-toolbar { align-items: stretch; flex-direction: column; }
	.header-actions { justify-content: flex-start; }
	.metric-grid { grid-template-columns: repeat(2, minmax(130px, 1fr)); }
	.search { width: 100%; }
	.struct-detail-row { grid-template-columns: 1fr; gap: 4px; }
	.struct-detail-stats { text-align: left; white-space: normal; }
}
@media (max-width: 480px) {
	.turn-table { font-size: 12px; }
}
@media (max-width: 960px) {
	/* Let the turn table (and the detail grid inside it) shrink to the
	   panel width instead of forcing a 920px minimum + horizontal scroll. */
	.turn-table th, .turn-table td { white-space: normal; }
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
const metric = (label, value, caption, tone, meter) => {
	let card = '<article class="metric-card ' + tone + '">';
	card += '<div class="metric-label">' + label + '</div>';
	card += '<div class="metric-value">' + value + '</div>';
	card += '<div class="metric-caption" title="' + escAttr(String(caption)) + '">' + caption + '</div>';
	if (typeof meter === "number") card += '<div class="meter"><span class="meter-fill" style="width:' + Math.max(0, Math.min(100, meter)).toFixed(1) + '%"></span></div>';
	return card + '</article>';
};
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
			startedAtMs: r.startedAtMs,
			gapSinceLastResponseMs: r.gapSinceLastResponseMs,
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
			messageTokens: r.context.messageTokensAfterCompact,
			toolSchemaTokens: r.context.toolTokens,
			systemTokens: r.context.systemTokens,
			promptSegments: r.context.promptSegments,
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
// Newest-first variant for detail step tables: the newest step sits at the top.
const DISPLAY_SERIES_NEWEST = (items) => {
	if (!Array.isArray(items) || !items.length) {
		return items || [];
	}
	const selected = items.length <= 12
		? items.slice()
		: [...items.slice(0, 3), ...items.slice(-5)];
	return selected.reverse();
};

function render() {
	const d = DATA;
	const s = d.summary;
	let h = "";

	// Header
	h += '<main class="page">';
	h += '<header class="topbar"><div>';
	h += '<div class="title-row"><h1>Live Report</h1><span class="live-pill">Live</span></div>';
	h += '<div class="sub">Updated ' + new Date(d.generatedAt).toLocaleTimeString() + ' &middot; Extension ' + d.extensionVersion + ' &middot; VS Code ' + d.vscodeVersion + '</div>';
	h += '</div><div class="header-actions"><span class="section-note">' + s.turns + ' logical turn' + (s.turns === 1 ? '' : 's') + ' · ' + FMT(s.totalModelTurns ?? s.turns) + ' model segment' + ((s.totalModelTurns ?? s.turns) === 1 ? '' : 's') + '</span></div></header>';
	h += '<nav class="tabs" role="tablist" aria-label="Dashboard sections">';
	h += '<button id="tab-btn-cache" class="tab-btn active" role="tab" aria-selected="true" data-tab="cache">Cache &amp; models</button>';
	h += '<button id="tab-btn-perf" class="tab-btn" role="tab" aria-selected="false" data-tab="perf">Performance</button>';
	h += '<button id="tab-btn-errors" class="tab-btn' + (d.errors && d.errors.length ? ' tab-has-issues' : '') + '" role="tab" aria-selected="false" data-tab="errors">Errors' + (d.errors && d.errors.length ? ' (' + d.errors.length + ')' : '') + '</button>';
	h += '<button id="tab-btn-health" class="tab-btn" role="tab" aria-selected="false" data-tab="health">Health</button>';

	h += '</nav>';
	h += '<div id="tab-cache" class="tab-panel" data-panel="cache"></div>';
	h += '<div id="tab-perf" class="tab-panel" data-panel="perf" hidden></div>';
	h += '<div id="tab-errors" class="tab-panel" data-panel="errors" hidden></div>';
	h += '<div id="tab-health" class="tab-panel" data-panel="health" hidden></div>';
	h += '</main>';
	document.getElementById("app").innerHTML = h;
	renderActiveTab();
	restoreTabState();
	bindHealthActions();
}

// Live updates render only the active tab; switching tabs lazily builds the
// rest from the already-shipped DATA. A single turn can fire many live
// updates, so this keeps a full DOM rebuild (all four tabs, the whole turns
// table) off the hot path.
function renderActiveTab() {
	const d = DATA;
	const name = document.querySelector(".tab-btn.active")?.getAttribute("data-tab") || "cache";
	const panel = document.getElementById("tab-" + name);
	if (!panel || panel.getAttribute("data-rendered") === "1") {
		return;
	}
	let h = "";
	if (name === "cache") h = renderCacheTab(d);
	else if (name === "perf") h = renderPerfTab(d);
	else if (name === "errors") h = renderErrorsTab(d);
	else if (name === "health") h = renderHealthTab(d);
	panel.innerHTML = h;
	panel.setAttribute("data-rendered", "1");
}

function renderCacheTab(d) {
	const s = d.summary;
	const missTurns = Math.max(0, s.turnsWithCacheReport - s.cacheHealthyTurns);
	const startupMissTurns = s.cacheStartupMissTurns ?? 0;
	const seriousIssues = s.rejectedToolCalls + s.toolLoopsDetected + s.overflowRetries;
	let h = "";

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
			h += '<div class="model-stats"><span><strong>' + m.turns + '</strong> turns</span><span><strong>' + FMT(m.modelSegments ?? m.turns) + '</strong> segments</span><span><strong>' + FMT_SHORT(m.promptTokens) + '</strong> prompt</span><span><strong>' + FMT_SHORT(m.cachedTokens) + '</strong> cached</span><span><strong>' + m.missTurns + '</strong> misses</span>' + (m.subagentTurns > 0 ? '<span><strong>' + m.subagentTurns + '</strong> subagent</span>' : '') + (m.chats && m.chats.length ? '<span class="model-chats" title="' + escAttr(m.chats.join(', ')) + '"><strong>' + m.chats.length + '</strong> chat' + (m.chats.length === 1 ? '' : 's') + ': ' + esc(m.chats.map(c => c.slice(0, 8)).join(', ')) + '</span>' : '') + '</div>';
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
		const chats = [...new Set(d.records.map(r => r.conversationKey).filter(Boolean))];
		const chatCount = chats.length;
		// Keep the dashboard bounded: render only the most recent turns, but let
		// the filters/search see the full history via DATA.
		const MAX_DISPLAY_TURNS = 40;
		const allRecords = d.records || [];
		const displayRecords = allRecords.length > MAX_DISPLAY_TURNS
			? allRecords.slice(-MAX_DISPLAY_TURNS)
			: allRecords;
		h += '<section class="section turns-section"><div class="section-heading"><h2>Turns</h2><span class="section-note">' + (chatCount > 1 ? chatCount + ' chats · ' : '') + 'Showing last ' + Math.min(displayRecords.length, MAX_DISPLAY_TURNS) + ' of ' + allRecords.length + ' · Select a row for cache, context, tools and backend details</span></div>';
		h += '<div class="turn-toolbar"><div class="turn-filters">';
		h += '<input id="turn-search" class="search" type="search" placeholder="Search model, reason or request ID" aria-label="Search turns">';
		h += '<select id="model-filter" class="select" aria-label="Filter by model"><option value="">All models</option>';
		for (const model of models) h += '<option value="' + escAttr(String(model)) + '">' + esc(MODEL_LABEL(model)) + '</option>';
		h += '</select>';
		if (chatCount > 1) {
			h += '<select id="chat-filter" class="select" aria-label="Filter by chat"><option value="">All chats</option>';
			for (const chat of chats) h += '<option value="' + escAttr(chat) + '">' + esc(chat.slice(0, 8)) + '</option>';
			h += '</select>';
		}
		h += '<button id="issues-filter" class="btn" type="button" aria-pressed="false">Issues only</button></div>';
		h += '<button id="expand-all" class="btn" type="button">Expand all</button></div>';
		h += '<div class="table-shell"><table class="turn-table"><thead><tr>';
		h += '<th style="width:22px"></th>';
		h += '<th>#</th>';
		h += '<th>Model</th>';
		if (chatCount > 1) h += '<th>Chat</th>';
		h += '<th>Processed input</th>';
		h += '<th>Cache reuse</th>';
		if (hasPrefix) h += '<th>Status</th>';
		h += '<th>At</th>';
		h += '<th>Tools</th>';
		h += '<th>Context</th>';
		h += '<th>Compact</th>';
		h += '<th style="width:52px">Data</th>';
		h += '</tr></thead><tbody>';

		const displayOffset = allRecords.length - displayRecords.length;
		// Newest first: the latest turn sits at the top of the table.
		const displayRows = [...displayRecords].reverse();
		for (let i = 0; i < displayRows.length; i++) {
			const r = displayRows[i];
			// data-index must address DATA.records (full history), not the
			// truncated display list, so Alt+Copy keeps working.
			const dataIndex = displayOffset + (displayRecords.length - 1 - i);
			const hit = EFFECTIVE_HIT(r);
			const detailKey = String(r.requestId || ("turn-" + String(r.index ?? dataIndex) + "-" + String(r.conversationKey || "")))
				.replace(/[^a-zA-Z0-9_-]/g, "-");
			const detailId = "detail-" + detailKey;
			const cacheIssue = typeof hit === "number" && hit < 90;
			const critical = Boolean(
				r.rejectedToolCalls
				|| r.toolLoopDetected
				|| r.reasoningLoopDetected
				|| r.retriedAfterOverflow
				|| r.safetyStopReason
			);
			const reasonIssue = Boolean(r.cacheMissReason && r.cacheMissReason !== "healthy" && r.cacheMissReason !== "cold_start");
			const issue = critical || cacheIssue || reasonIssue;
			const searchable = [r.modelId, r.cacheMissReason, r.requestId, r.conversationKey].filter(Boolean).join(" ").toLowerCase();

			h += '<tr class="turn-row ' + (critical ? 'critical' : issue ? 'issue' : '') + '" tabindex="0" role="button" aria-expanded="false" data-detail="' + detailId + '" data-issue="' + (issue ? '1' : '0') + '" data-model="' + escAttr(String(r.modelId || '')) + '" data-chat="' + escAttr(String(r.conversationKey || '')) + '" data-search="' + escAttr(searchable) + '">';
			h += '<td><span class="expand-icon">▶</span></td>';
			h += '<td class="compact-number">' + r.index + (r.isSubagent ? '<span class="subagent-tag">sub</span>' : '') + '</td>';
			h += '<td class="model-cell" title="' + escAttr(String(r.modelId || '')) + '">' + esc(MODEL_LABEL(r.modelId)) + '</td>';
			if (chatCount > 1) h += '<td class="compact-number" title="Chat ' + escAttr(String(r.conversationKey || 'unknown')) + '">' + (r.conversationKey ? esc(r.conversationKey.slice(0, 8)) : '—') + '</td>';
			h += '<td class="compact-number" title="' + FMT(r.promptTokens) + ' tokens processed across ' + FMT(r.modelTurns ?? 1) + ' model segment(s)">' + FMT_SHORT(r.promptTokens) + '</td>';			// Cache cell with mini bar
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
			h += '<td class="compact-number" title="' + (r.startedAtMs !== undefined ? new Date(r.startedAtMs).toLocaleString() : '') + '">' + CLOCK(r.startedAtMs) + '</td>';
			h += '<td>' + (r.toolCalls ?? 0) + (r.repairedToolCalls ? " (" + r.repairedToolCalls + "r)" : "") + (r.rejectedToolCalls ? " (" + r.rejectedToolCalls + "x)" : "") + '</td>';
			h += '<td>' + (r.context?.estimatedUsagePercent !== undefined ? FMT1(r.context.estimatedUsagePercent) + "%" : "n/a") + '</td>';
			h += '<td>' + (r.context?.hardCompacted ? "hard" : r.context?.autoCompacted ? "auto" : "—") + '</td>';
			// Default clipboard payload is compact. Full diagnostics remain available
			// from DATA by record index without duplicating the large JSON in the DOM.
			const turnJson = safeStringify(compactTurnRecord(r));
			h += '<td><span class="copy-btn" role="button" tabindex="0" data-index="' + dataIndex + '" data-json="' + turnJson + '" title="Click: compact JSON · Shift+click: formatted text · Alt+click: full JSON">Copy</span></td>';
			h += '</tr>';

			// Detail row — expandable cache/context/tool/backend diagnostics.
			const detailColspan = (hasPrefix ? 11 : 10) + (chatCount > 1 ? 1 : 0);
			h += '<tr class="detail-row" id="' + detailId + '"><td colspan="' + detailColspan + '">';
			h += '<div class="detail-grid">';

			// Prefix/cache diagnostics differ by transport. Codex owns a durable
			// app-server thread, so generic byte-prefix fields are not meaningful.
			const isColdStart = r.prefixPreviousMessageCount === undefined;
			if (IS_CODEX(r)) {
				h += '<section class="detail-card"><h3>Codex session &amp; cache</h3>';
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
				h += '<section class="detail-card"><h3>Claude session &amp; cache</h3>';
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
				h += '<section class="detail-card"><h3>Prefix &amp; cache</h3>';
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
			const structMode = !IS_CODEX(r) && !IS_CLAUDE(r);
			if (typeof detailInputTokens === "number" && detailInputTokens > 0 && typeof detailCachedTokens === "number") {
				const cached = detailCachedTokens;
				const uncached = Math.max(0, detailInputTokens - cached);
				const hitPct = (cached / detailInputTokens) * 100;
				// Stateless HTTP (llama/deepseek) shows the input structure bar
				// instead of the generic cached/miss split — the structure bar
				// already paints each block's cache coverage.
				if (!structMode) {
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
				}

				// Input structure: show WHERE the cache break lands. The prompt is
				// system → tools → messages and the Anthropic/OpenAI prompt cache
				// only covers a byte-identical prefix, so a changed tools block
				// invalidates every message after it. Segment the bar by block and
				// paint the cached portion of each block green.
				//
				// The heuristic block sizes are NOT scaled up to the
				// server-reported input total: scaling distorted the cache split
				// (cached is a real server number, so scaled blocks made
				// system+tools appear larger than the cache could cover and
				// painted a false miss inside the tools block).
				if (structMode && r.context) {
					const structSystem = typeof r.context.systemTokens === "number" ? r.context.systemTokens : 0;
					const structTools = typeof r.context.toolTokens === "number" ? r.context.toolTokens : 0;
					const structMessageTotal = typeof r.context.messageTokensAfterCompact === "number"
						? r.context.messageTokensAfterCompact
						: 0;
					// messageTokens includes system-role messages; subtract them in
					// the legacy fallback so System is never counted twice.
					const structMessages = Math.max(0, structMessageTotal - structSystem);
					const structOther = typeof r.context.otherTokens === "number" ? r.context.otherTokens : 0;
					const segmentCss = {
						system: "struct-system",
						tools: "struct-tools",
						shared_memory: "struct-memory",
						guard: "struct-guard",
						user: "struct-user",
						user_context: "struct-user",
						assistant: "struct-assistant",
						reasoning: "struct-reasoning",
						tool_calls: "struct-tool-io",
						tool_results: "struct-tool-io",
						summary: "struct-summary",
						other: "struct-other",
					};
					const orderedSegments = Array.isArray(r.context.promptSegments)
						? r.context.promptSegments.filter(segment => Number(segment.tokens) > 0)
						: [];
					const blocks = orderedSegments.length > 0
						? orderedSegments.map(segment => ({
							label: String(segment.label || segment.kind || "Other"),
							tokens: Number(segment.tokens) || 0,
							css: segmentCss[segment.kind] || "struct-other",
							messageCount: Number(segment.messageCount) || undefined,
						}))
						: [
							{ label: "System", tokens: structSystem, css: "struct-system" },
							{ label: "Tool catalog", tokens: structTools, css: "struct-tools" },
							{ label: "Other", tokens: structOther, css: "struct-other" },
							{ label: "Messages", tokens: structMessages, css: "struct-assistant" },
						].filter(block => block.tokens > 0);
					const structTotal = blocks.reduce((sum, block) => sum + block.tokens, 0);
					if (structTotal > 0 && typeof detailInputTokens === "number" && detailInputTokens > 0) {
						// The heuristic block sizes usually under-count the real
						// server-side input (tokenizer details, tool schemas, extra
						// system text). Without the missing tail, cached tokens could
						// cover every block (all 100%) while the server still reports
						// a lower blended hit — paint the unmeasured tail so the bar
						// stays consistent with the overall cache hit.
						const unmeasuredTail = Math.max(0, detailInputTokens - structTotal);
						if (unmeasuredTail > 0) {
							blocks.push({ label: "Unmeasured", tokens: unmeasuredTail, css: "struct-other" });
						}
						const structTotalWithTail = structTotal + unmeasuredTail;
						let consumed = 0;
						const segments = [];
						const detailBlocks = [];
						const legend = new Map();
						for (const block of blocks) {
							const blockCached = Math.max(0, Math.min(block.tokens, cached - consumed));
							const blockMiss = Math.max(0, block.tokens - blockCached);
							const blockHit = block.tokens > 0 ? Math.round((blockCached / block.tokens) * 100) : 0;
							if (blockCached > 0) {
								segments.push({
									css: "bar bar-cached " + block.css,
									width: blockCached,
									title: block.label + ": " + blockHit + "% cached (" + FMT(Math.round(blockCached)) + " of " + FMT(Math.round(block.tokens)) + " tokens)",
								});
							}
							if (blockMiss > 0) {
								segments.push({
									css: "bar bar-uncached " + block.css,
									width: blockMiss,
									title: block.label + ": " + blockHit + "% cached — " + FMT(Math.round(blockMiss)) + " tokens not cached",
								});
							}
							const aggregate = legend.get(block.label) || { label: block.label, tokens: 0, cached: 0 };
							aggregate.tokens += block.tokens;
							aggregate.cached += blockCached;
							legend.set(block.label, aggregate);
							detailBlocks.push({
								label: block.label,
								tokens: block.tokens,
								cached: blockCached,
								miss: blockMiss,
								hit: blockHit,
								css: block.css,
								messageCount: block.messageCount,
							});
							consumed += block.tokens;
						}
						h += '<div class="struct-bar" style="margin-top:6px">';
						for (const segment of segments) {
							h += '<div class="' + segment.css + '" style="width:' + ((segment.width / structTotalWithTail) * 100).toFixed(2) + '%" title="' + escAttr(segment.title) + '"></div>';
						}
						h += '</div>';
						h += '<div class="struct-legend" style="font-size:10px;color:var(--dim);margin-top:3px">';
						for (const block of legend.values()) {
							const blockHit = block.tokens > 0 ? Math.round((block.cached / block.tokens) * 100) : 0;
							const stateColor = blockHit >= 99 ? 'var(--good)' : blockHit >= 50 ? 'var(--warn)' : 'var(--bad)';
							h += '<span class="struct-block" style="margin-right:10px"><span class="struct-dot" style="background:' + stateColor + '"></span><strong>' + esc(block.label) + '</strong> ' + FMT_SHORT(Math.round(block.tokens)) + ' · ' + blockHit + '%</span>';
						}
						h += '<span style="opacity:.7">estimated block split; cached cutoff is server-reported</span>';
						h += '</div>';
						const structureDetailId = "struct-details-" + detailKey;
						h += '<div class="struct-detail-actions"><button class="btn struct-detail-toggle" type="button" aria-expanded="false" aria-controls="' + structureDetailId + '" data-target="' + structureDetailId + '">Expand block details</button></div>';
						h += '<div class="struct-detail-list" id="' + structureDetailId + '">';
						detailBlocks.forEach(function(block, blockIndex) {
							const cachedPct = block.tokens > 0 ? (block.cached / block.tokens) * 100 : 0;
							const missPct = Math.max(0, 100 - cachedPct);
							h += '<div class="struct-detail-row">';
							h += '<div class="struct-detail-label"><span class="struct-detail-order">#' + (blockIndex + 1) + '</span><strong>' + esc(block.label) + '</strong>' + (block.messageCount ? ' <span class="section-note">· ' + FMT(block.messageCount) + ' msg</span>' : '') + '</div>';
							h += '<div class="struct-detail-meter" title="' + escAttr(block.label + ": " + block.hit + "% cached") + '">';
							if (block.cached > 0) h += '<div class="bar bar-cached ' + block.css + '" style="width:' + cachedPct.toFixed(2) + '%"></div>';
							if (block.miss > 0) h += '<div class="bar bar-uncached ' + block.css + '" style="width:' + missPct.toFixed(2) + '%"></div>';
							h += '</div>';
							h += '<div class="struct-detail-stats">' + FMT(Math.round(block.tokens)) + ' total · ' + FMT(Math.round(block.cached)) + ' cached · ' + FMT(Math.round(block.miss)) + ' miss · <strong>' + block.hit + '%</strong></div>';
							h += '</div>';
						});
						h += '</div>';
					}
				}

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
			}
			h += '</section>';

			// Context section
			if (r.context) {
				const c = r.context;
				h += '<section class="detail-card"><h3>' + (IS_CODEX(r) ? 'Final context snapshot' : IS_CLAUDE(r) ? 'Claude SDK context snapshot' : 'Context budget') + '</h3>';
				h += '<div class="kv"><span class="k">Budget</span><span class="v">' + FMT(c.contextLength) + ' total / ' + FMT(c.inputBudget) + ' usable</span></div>';
				if (IS_STATEFUL(r)) h += '<div class="kv"><span class="k">Processed across segments</span><span class="v">' + FMT(r.promptTokens) + ' input · ' + FMT(r.outputTokens) + ' output</span></div>';
				if (IS_CLAUDE(r) && c.rawMaxTokens !== undefined) h += '<div class="kv"><span class="k">Provider raw / SDK usable</span><span class="v">' + FMT(c.rawMaxTokens) + ' / ' + FMT(c.usableMaxTokens) + '</span></div>';
				h += '<div class="kv"><span class="k">Messages</span><span class="v">' + FMT(c.messageTokensAfterCompact) + ' tok (' + c.messageCountAfterCompact + ' msgs) → was ' + FMT(c.messageTokensBeforeCompact) + ' (' + c.messageCountBeforeCompact + ')</span></div>';
				if (c.compactionTargetTokens !== undefined) h += '<div class="kv"><span class="k">Compaction target / fill / retained</span><span class="v">' + FMT(c.compactionTargetTokens) + ' / ' + FMT(c.compactionTargetFillPercent) + '% / ' + FMT(c.compactionRetainedPercent) + '%</span></div>';
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
			h += '<div class="kv"><span class="k">Tool loop detected</span><span class="v">' + (r.toolLoopDetected ? "⚠️ yes" : "no") + '</span></div>';
			h += '<div class="kv"><span class="k">Reasoning loop detected</span><span class="v">' + (r.reasoningLoopDetected ? "⚠️ yes" : "no") + (r.reasoningLoopRetries ? ' · retries ' + r.reasoningLoopRetries : '') + '</span></div>';
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
			if (r.startedAtMs !== undefined) h += '<div class="kv"><span class="k">Started</span><span class="v">' + new Date(r.startedAtMs).toLocaleString() + '</span></div>';
			if (r.gapSinceLastResponseMs !== undefined) h += '<div class="kv"><span class="k">Gap since prev turn</span><span class="v ' + (r.gapSinceLastResponseMs > 30000 ? 'tone-warn' : '') + '">' + DURATION(r.gapSinceLastResponseMs) + '</span></div>';
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
				for (const step of DISPLAY_SERIES_NEWEST(r.steps)) {
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
				for (const segment of DISPLAY_SERIES_NEWEST(r.usageSegments)) {
					h += '<tr><td>' + FMT(segment.index) + '</td><td>' + esc(segment.recordedAt ? new Date(segment.recordedAt).toLocaleTimeString() : 'n/a') + '</td>' + (IS_CLAUDE(r) ? '<td>' + FMT(segment.freshInputTokens) + '</td>' : '') + '<td>' + FMT(segment.inputTokens) + '</td><td>' + FMT(segment.cachedInputTokens) + '</td>' + (IS_CLAUDE(r) ? '<td>' + FMT(segment.cacheCreationInputTokens) + '</td>' : '') + '<td class="' + HIT_COLOR(segment.cacheHitPercent) + '">' + PCT(segment.cacheHitPercent) + '</td><td>' + FMT(segment.outputTokens) + '</td><td>' + FMT(segment.reasoningOutputTokens) + '</td><td>' + FMT(segment.totalTokens) + '</td></tr>';
				}
				h += '</tbody></table></div>';
				if (r.usageSegments.length > 12) h += '<div class="section-note" style="margin-top:6px">Showing the first 3 and last 5 usage segments. Use Alt+Copy for the full JSON.</div>';
				if (r.usageSegmentsTruncated) h += '<div class="section-note" style="margin-top:6px">Only the first retained segment snapshots are shown.</div>';
				h += '</section>';
			}

			// Request and backend diagnostics
			const hasBackend = r.backendVia || r.backendCfPop || r.backendTraceId;
			h += '<section class="detail-card"><h3>Request &amp; backend</h3>';
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
	h += '</div>'; // tab-cache
	return h;
}

const ERROR_KIND_LABEL = {
	turn_failed: "Turn failed",
	turn_timed_out: "Turn timed out",
	tool_rejected: "Tool rejected",
	tool_repair_retry: "Tool repair retry",
	tool_loop: "Tool loop",
	tool_execution_error: "Tool execution error",
	api_overflow_retry: "API overflow retry",
	resume_failed: "Session resume failed",
	safety_stop: "Safety stop",
};

// Kinds that signal real API-level failures or silent crashes. Everything else
// (rejected tool calls, repair retries, execution errors like "path not found")
// is usually non-fatal — the model recovers and the turn completes.
const ERROR_CRITICAL_KINDS = new Set([
	"turn_failed",
	"turn_timed_out",
	"api_overflow_retry",
	"resume_failed",
	"safety_stop",
	"tool_loop",
]);
function isCriticalErrorKind(kind) {
	return ERROR_CRITICAL_KINDS.has(kind);
}

function renderErrorsTab(d) {
	const errors = Array.isArray(d.errors) ? d.errors : [];
	if (!errors.length) {
		return '<div class="empty">No errors recorded. Failed turns, rejected tool calls and API problems will appear here.</div>';
	}
	let h = "";
	const byKind = {};
	for (const e of errors) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
	const chats = [...new Set(errors.map(e => e.conversationKey).filter(Boolean))];

	h += '<section class="metric-grid" aria-label="Errors summary">';
	h += '<article class="metric-card tone-bad"><div class="metric-label">Errors</div><div class="metric-value">' + FMT(errors.length) + '</div><div class="metric-caption">across ' + FMT(chats.length) + ' chat' + (chats.length === 1 ? '' : 's') + '</div></article>';
	for (const [kind, count] of Object.entries(byKind).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
		h += '<article class="metric-card tone-warn"><div class="metric-label">' + esc(ERROR_KIND_LABEL[kind] || kind) + '</div><div class="metric-value">' + FMT(count) + '</div><div class="metric-caption">of ' + FMT(errors.length) + ' total</div></article>';
	}
	h += '</section>';

	h += '<section class="section"><div class="section-heading"><h2>Error log</h2><span class="section-note">Turn number, chat and what happened — newest first</span></div>';
	h += '<div class="turn-toolbar"><div class="turn-filters">';
	if (chats.length > 1) {
		h += '<select id="error-chat-filter" class="select" aria-label="Filter errors by chat"><option value="">All chats</option>';
		for (const chat of chats) h += '<option value="' + escAttr(chat) + '">' + esc(chat.slice(0, 8)) + '</option>';
		h += '</select>';
	}
	h += '<select id="error-kind-filter" class="select" aria-label="Filter errors by kind"><option value="">All kinds</option>';
	const kinds = Object.keys(byKind).sort((a, b) => {
		const la = ERROR_KIND_LABEL[a] || a;
		const lb = ERROR_KIND_LABEL[b] || b;
		return la.localeCompare(lb);
	});
	for (const kind of kinds) h += '<option value="' + escAttr(kind) + '">' + esc(ERROR_KIND_LABEL[kind] || kind) + '</option>';
	h += '</select>';
	h += '<button id="error-critical-filter" class="btn active" type="button" aria-pressed="true" title="Show only API errors and silent failures (turn failures, timeouts, overflow retries, resume/safety stops, tool loops). Tool rejections and execution errors like &quot;path not found&quot; are hidden by default.">API &amp; failures only</button>';
	h += '</div></div>';
	h += '<div class="table-shell"><table class="turn-table"><thead><tr>';
	h += '<th>#</th><th>At</th><th>Chat</th><th>Model</th><th>Type</th><th>Details</th>';
	h += '</tr></thead><tbody>';
	const rows = [...errors].reverse();
	for (const e of rows) {
		h += '<tr class="error-row" data-error-chat="' + escAttr(String(e.conversationKey || '')) + '" data-error-kind="' + escAttr(e.kind) + '" data-error-critical="' + (isCriticalErrorKind(e.kind) ? '1' : '0') + '">';
		h += '<td class="compact-number">#' + e.index + '</td>';
		h += '<td class="compact-number" title="' + (e.startedAtMs !== undefined ? new Date(e.startedAtMs).toLocaleString() : '') + '">' + CLOCK(e.startedAtMs) + '</td>';
		h += '<td class="compact-number" title="' + escAttr(String(e.conversationKey || 'unknown')) + '">' + (e.conversationKey ? esc(e.conversationKey.slice(0, 8)) : '—') + '</td>';
		h += '<td class="model-cell" title="' + escAttr(String(e.modelId || '')) + '">' + esc(MODEL_LABEL(e.modelId)) + '</td>';
		h += '<td><span class="reason-badge reason-' + escAttr(e.kind) + '">' + esc(ERROR_KIND_LABEL[e.kind] || e.kind) + (e.count > 1 ? ' ×' + e.count : '') + '</span></td>';
		h += '<td class="error-detail" title="' + escAttr(e.detail) + '">' + esc(e.detail) + '</td>';
		h += '</tr>';
	}
	h += '</tbody></table></div></section>';
	return h;
}

function applyErrorFilters() {
	const chat = document.getElementById("error-chat-filter")?.value || "";
	const kind = document.getElementById("error-kind-filter")?.value || "";
	const criticalOnly = document.getElementById("error-critical-filter")?.classList.contains("active") || false;
	document.querySelectorAll(".error-row").forEach(function(row) {
		const matchesChat = !chat || row.getAttribute("data-error-chat") === chat;
		const matchesKind = !kind || row.getAttribute("data-error-kind") === kind;
		const matchesCritical = !criticalOnly || row.getAttribute("data-error-critical") === "1";
		row.classList.toggle("hidden-row", !(matchesChat && matchesKind && matchesCritical));
	});
}

const HEALTH_STATUS_LABEL = { pass: "Pass", warn: "Warning", fail: "Failed", unknown: "Unknown" };
const HEALTH_TONE = { pass: "tone-good", warn: "tone-warn", fail: "tone-bad", unknown: "tone-info" };

function renderHealthTab(d) {
	const hd = d.health;
	if (!hd) {
		return '<div class="empty">No provider health check has been run yet.<br><button id="health-run" class="btn" type="button">Run health check</button></div>';
	}
	const overall = hd.overallStatus || "unknown";
	let h = "";

	h += '<section class="metric-grid" aria-label="Health summary">';
	h += '<article class="metric-card ' + (HEALTH_TONE[overall] || "tone-info") + '"><div class="metric-label">Overall</div><div class="metric-value">' + esc((HEALTH_STATUS_LABEL[overall] || overall).toUpperCase()) + '</div><div class="metric-caption">checked ' + (hd.generatedAt ? new Date(hd.generatedAt).toLocaleTimeString() : "—") + '</div></article>';
	const ss = hd.sessionSummary;
	if (ss) {
		h += metric("Session turns", FMT(ss.turns), FMT(ss.totalModelTurns ?? ss.turns) + " model segments", "tone-info");
		h += metric("Cache hit", PCT(ss.cacheHitPercent), "across " + FMT_SHORT(ss.promptTokens ?? 0) + " input tokens", HIT_TONE(ss.cacheHitPercent ?? 0));
		h += metric("Errors", FMT(ss.errorCount ?? 0), ss.rejectedToolCalls + " rejected · " + ss.repairedToolCalls + " repaired · " + (ss.toolLoopsDetected || 0) + " loops", (ss.errorCount || 0) > 0 ? "tone-warn" : "tone-good");
	}
	h += '<button id="health-run" class="btn" type="button">Run health check</button>';
	h += '</section>';

	if (Array.isArray(hd.configurationChecks) && hd.configurationChecks.length) {
		h += '<section class="section"><div class="section-heading"><h2>Configuration</h2><span class="section-note">Extension settings</span></div><div class="reason-list">';
		for (const check of hd.configurationChecks) {
			const tone = HEALTH_TONE[check.status] || "tone-info";
			h += '<div class="reason-item"><div class="reason-main"><span class="reason-badge reason-' + escAttr(check.status) + '">' + esc(check.status) + '</span><span class="reason-label">' + esc(check.label) + '</span></div><div class="reason-detail ' + tone + '">' + esc(check.detail || "") + '</div></div>';
		}
		h += '</div></section>';
	}

	if (Array.isArray(hd.sources) && hd.sources.length) {
		h += '<section class="section"><div class="section-heading"><h2>Endpoints</h2><span class="section-note">Direct LLM servers</span></div>';
		for (const source of hd.sources) {
			h += '<div class="model-card"><div class="model-card-head"><span class="reason-badge reason-' + escAttr(source.status || "unknown") + '">' + esc(source.status || "unknown") + '</span><span class="model-name">' + esc(source.label || source.key) + '</span><span class="model-dim">' + esc(source.serverUrl || "") + '</span></div>';
			if (Array.isArray(source.modelIds) && source.modelIds.length) {
				h += '<div class="model-dim">Models: ' + esc(source.modelIds.join(", ")) + '</div>';
			}
			if (Array.isArray(source.checks) && source.checks.length) {
				for (const check of source.checks) {
					h += '<div class="reason-item"><div class="reason-main"><span class="reason-badge reason-' + escAttr(check.status) + '">' + esc(check.status) + '</span><span class="reason-label">' + esc(check.label) + '</span></div><div class="reason-detail">' + esc(check.detail || "") + '</div></div>';
				}
			}
			h += '</div>';
		}
		h += '</section>';
	}

	if (hd.claude || hd.codex) {
		h += '<section class="section"><div class="section-heading"><h2>Subscription providers</h2><span class="section-note">Claude and Codex</span></div><div class="model-grid">';
		if (hd.claude) {
			h += '<div class="model-card"><div class="model-card-head"><span class="reason-badge reason-' + escAttr(hd.claude.status) + '">' + esc(hd.claude.status) + '</span><span class="model-name">Claude</span></div><div class="reason-detail">' + esc(hd.claude.summary || "") + (hd.claude.usagePercent !== undefined ? " · usage " + FMT1(hd.claude.usagePercent) + "%" : "") + (hd.claude.resetLabel ? " · resets " + esc(hd.claude.resetLabel) : "") + '</div>';
			if (hd.claude.keepAlive) {
				h += '<div class="model-dim">Keep-alive: ' + esc(hd.claude.keepAlive.state) + (hd.claude.keepAlive.reason ? " (" + esc(hd.claude.keepAlive.reason) + ")" : "") + (hd.claude.keepAlive.enabled ? " · every " + FMT(Math.round((hd.claude.keepAlive.intervalMs || 0) / 60000)) + " min" : " · disabled") + '</div>';
			}
			h += '</div>';
		}
		if (hd.codex) {
			h += '<div class="model-card"><div class="model-card-head"><span class="reason-badge reason-' + escAttr(hd.codex.status) + '">' + esc(hd.codex.status) + '</span><span class="model-name">Codex</span></div><div class="reason-detail">' + esc(hd.codex.summary || "") + '</div></div>';
		}
		h += '</div></section>';
	}

	h += '<div class="section-note" style="margin-top:10px">Generated ' + (hd.generatedAt ? new Date(hd.generatedAt).toLocaleString() : "—") + ' · Extension ' + esc(hd.extensionVersion || "") + ' · VS Code ' + esc(hd.vscodeVersion || "") + '</div>';
	return h;
}

function bindHealthActions() {
	const runBtn = document.getElementById("health-run");
	if (runBtn && !runBtn.dataset.bound) {
		runBtn.dataset.bound = "1";
		runBtn.addEventListener("click", function() {
			// eslint-disable-next-line no-undef
			acquireVsCodeApi().postMessage({ type: "runHealthCheck" });
		});
	}
}

function renderPerfTab(d) {
	const records = Array.isArray(d.records) ? d.records : [];
	if (!records.length) {
		return '<div class="empty">No turns recorded yet. Performance data appears as turns complete.</div>';
	}
	let h = "";
	const median = (values) => {
		if (!values.length) return undefined;
		const s = [...values].sort((a, b) => a - b);
		return s[Math.floor(s.length / 2)];
	};
	const pct = (values, p) => {
		if (!values.length) return undefined;
		const s = [...values].sort((a, b) => a - b);
		return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
	};
	// Gaps that led into a tool-continuation round measure the renderer+plumbing
	// pause inside one agent turn. Gaps that led into a fresh user turn include
	// how long the user took to type — those are excluded from statistics.
	const gapRecords = records.filter(r =>
		typeof r.gapSinceLastResponseMs === "number" && r.gapKind !== "user"
	);
	const gaps = gapRecords.map(r => r.gapSinceLastResponseMs).filter(v => typeof v === "number");
	const durs = records.map(r => r.durationMs).filter(v => typeof v === "number");
	const ttfts = records.map(r => r.firstTokenLatencyMs).filter(v => typeof v === "number");
	const ctks = records.map(r => r.hostTokenCountCalls).filter(v => typeof v === "number");
	const chats = [...new Set(records.map(r => r.conversationKey).filter(Boolean))];

	const perfMetric = (label, value, caption, tone) =>
		'<article class="metric-card ' + (tone || 'tone-info') + '"><div class="metric-label">' + label + '</div><div class="metric-value">' + value + '</div><div class="metric-caption">' + caption + '</div></article>';

	h += '<section class="metric-grid" aria-label="Performance summary">';
	h += perfMetric("Gap med / p95", DURATION(median(gaps)) + ' / ' + DURATION(pct(gaps, 95)), 'Tool-round pauses only — user typing time excluded', gaps.length && median(gaps) > 60000 ? 'tone-warn' : 'tone-info');
	h += perfMetric("Gap max", DURATION(gaps.length ? Math.max(...gaps) : undefined), 'Worst tool-round pause', gaps.length && Math.max(...gaps) > 120000 ? 'tone-bad' : 'tone-info');
	h += perfMetric("Turn med / p95", DURATION(median(durs)) + ' / ' + DURATION(pct(durs, 95)), 'Provider duration — the model call itself', 'tone-purple');
	h += perfMetric("TTFT med", DURATION(median(ttfts)), 'Time to first token inside the provider call', ttfts.length && median(ttfts) > 10000 ? 'tone-warn' : 'tone-info');
	h += perfMetric("Host tokenizer", ctks.length ? median(ctks).toFixed(0) + ' calls' : 'n/a', 'Memoised countTokens RPCs per turn', ctks.length && median(ctks) > 10 ? 'tone-warn' : 'tone-good');
	h += perfMetric("Turns tracked", FMT(records.length), 'From ' + FMT(records.length) + ' records · gap−turn ≈ Copilot-side time', 'tone-good');
	h += '</section>';

	// Gap histogram (tool gaps only)
	if (gaps.length) {
		const buckets = [
			{ label: '<5s', max: 5000 }, { label: '5-15s', max: 15000 }, { label: '15-30s', max: 30000 },
			{ label: '30-60s', max: 60000 }, { label: '60-120s', max: 120000 }, { label: '>120s', max: Infinity },
		];
		const counts = buckets.map(b => gaps.filter(g => g < b.max).length);
		buckets.forEach((b, i) => { counts[i] = gaps.filter(g => g >= (i === 0 ? 0 : buckets[i - 1].max) && g < b.max).length; });
		const maxCount = Math.max(1, ...counts);
		h += '<section class="section"><div class="section-heading"><h2>Gap distribution</h2><span class="section-note">' + gaps.length + ' tool-round pauses (user gaps excluded)</span></div><div class="gap-hist">';
		buckets.forEach((b, i) => {
			h += '<div class="gap-hist-col" title="' + b.label + ': ' + counts[i] + ' turns">';
			h += '<div class="gap-hist-bar" style="height:' + Math.max(4, (counts[i] / maxCount) * 60).toFixed(0) + 'px"></div>';
			h += '<div class="gap-hist-count">' + counts[i] + '</div><div class="gap-hist-label">' + b.label + '</div>';
			h += '</div>';
		});
		h += '</div></section>';
	}

	// Sparkline of recent tool gaps. Bars stretch to fill the track (dynamic
	// count: a few pauses fill the full row, many pauses stay narrow).
	if (gaps.length > 1) {
		const recent = gaps.slice(-80);
		const maxGap = Math.max(...recent, 1);
		h += '<section class="section"><div class="section-heading"><h2>Recent gaps</h2><span class="section-note">last ' + recent.length + ' tool-round pauses — each bar is one pause</span></div><div class="spark">';
		for (const g of recent) {
			const tone = g > 120000 ? 'spark-bad' : g > 60000 ? 'spark-warn' : 'spark-good';
			h += '<div class="spark-bar ' + tone + '" style="height:' + Math.max(3, (g / maxGap) * 48).toFixed(0) + 'px" title="' + DURATION(g) + '"></div>';
		}
		h += '</div></section>';
	}

	// Perf turn table with chat filter
	h += '<section class="section turns-section"><div class="section-heading"><h2>Turn timeline</h2><span class="section-note">Gap &gt; 60s is highlighted; user gaps shown grey and excluded from stats</span></div>';
	h += '<div class="turn-toolbar"><div class="turn-filters">';
	if (chats.length > 1) {
		h += '<select id="perf-chat-filter" class="select" aria-label="Filter performance by chat"><option value="">All chats</option>';
		for (const chat of chats) h += '<option value="' + escAttr(chat) + '">' + esc(chat.slice(0, 8)) + '</option>';
		h += '</select>';
	}
	h += '</div><span class="section-note">Chat filter isolates one conversation</span></div>';
	h += '<div class="table-shell"><table class="turn-table"><thead><tr>';
	h += '<th>At</th><th>Msgs</th><th>Gap</th><th>Turn</th><th>TTFT</th><th>Cache</th><th>Tokens</th><th>ctk</th>';
	h += '<th>Chat</th>';
	h += '<th>Model</th></tr></thead><tbody>';
	const rows = [...records].sort((a, b) => (a.startedAtMs || 0) - (b.startedAtMs || 0)).slice(-40).reverse();
	for (const r of rows) {
		const isUserGap = r.gapKind === "user" && typeof r.gapSinceLastResponseMs === "number";
		const slow = !isUserGap && typeof r.gapSinceLastResponseMs === "number" && r.gapSinceLastResponseMs > 60000;
		const bad = !isUserGap && typeof r.gapSinceLastResponseMs === "number" && r.gapSinceLastResponseMs > 120000;
		h += '<tr class="perf-row' + (bad ? ' perf-bad' : slow ? ' perf-slow' : '') + '" data-perf-chat="' + escAttr(String(r.conversationKey || '')) + '">';
		h += '<td class="compact-number" title="' + (r.startedAtMs !== undefined ? new Date(r.startedAtMs).toLocaleString() : '') + '">' + CLOCK(r.startedAtMs) + '</td>';
		h += '<td class="compact-number">' + (r.messageCount !== undefined ? FMT(r.messageCount) : '—') + '</td>';
		h += '<td class="compact-number ' + (isUserGap ? 'gap-user' : slow ? 'tone-warn' : '') + '" title="' + (isUserGap ? 'User gap — waiting for your next message, excluded from stats' : 'Pause before this tool round') + '">' + DURATION(r.gapSinceLastResponseMs) + (isUserGap ? ' u' : '') + '</td>';
		h += '<td class="compact-number">' + DURATION(r.durationMs) + '</td>';
		h += '<td class="compact-number">' + DURATION(r.firstTokenLatencyMs) + '</td>';
		h += '<td class="' + HIT_COLOR(EFFECTIVE_HIT(r)) + '">' + PCT(EFFECTIVE_HIT(r)) + '</td>';
		h += '<td class="compact-number" title="' + FMT(r.promptTokens) + ' processed tokens">' + FMT_SHORT(r.promptTokens) + '</td>';
		h += '<td class="compact-number">' + (typeof r.hostTokenCountCalls === "number" ? r.hostTokenCountCalls : 'n/a') + '</td>';
		h += '<td class="compact-number" title="' + escAttr(String(r.conversationKey || 'unknown')) + '">' + (r.conversationKey ? esc(r.conversationKey.slice(0, 8)) : '—') + '</td>';
		h += '<td class="model-cell" title="' + escAttr(String(r.modelId || '')) + '">' + esc(MODEL_LABEL(r.modelId)) + '</td>';
		h += '</tr>';
	}
	h += '</tbody></table></div></section>';
	return h;
}

// Perf tab chat filter
function applyPerfFilters() {
	const chat = document.getElementById("perf-chat-filter")?.value || "";
	document.querySelectorAll(".perf-row").forEach(function(row) {
		const matches = !chat || row.getAttribute("data-perf-chat") === chat;
		row.classList.toggle("hidden-row", !matches);
	});
}

function switchTab(name) {
	document.querySelectorAll(".tab-btn").forEach(b => {
		const active = b.getAttribute("data-tab") === name;
		b.classList.toggle("active", active);
		b.setAttribute("aria-selected", String(active));
	});
	document.querySelectorAll(".tab-panel").forEach(p => {
		p.hidden = p.getAttribute("data-panel") !== name;
	});
	renderActiveTab();
	if (name === "cache") applyTurnFilters();
	if (name === "perf") applyPerfFilters();
	if (name === "errors") applyErrorFilters();
	if (name === "health") bindHealthActions();
}

function restoreTabState(state) {
	const name = (state && state.tab) || "cache";
	switchTab(name);
	const perfChat = document.getElementById("perf-chat-filter");
	if (perfChat && state && state.perfChat) perfChat.value = state.perfChat;
	applyPerfFilters();
}

// Delegated click handler — avoids onclick attributes (stripped by VS Code Webview).
document.addEventListener("click", function(e) {
	const tabBtn = e.target.closest(".tab-btn");
	if (tabBtn) {
		switchTab(tabBtn.getAttribute("data-tab"));
		return;
	}

	const issuesButton = e.target.closest("#issues-filter");
	if (issuesButton) {
		const active = !issuesButton.classList.contains("active");
		issuesButton.classList.toggle("active", active);
		issuesButton.setAttribute("aria-pressed", String(active));
		applyTurnFilters();
		return;
	}

	const errorCriticalButton = e.target.closest("#error-critical-filter");
	if (errorCriticalButton) {
		const active = !errorCriticalButton.classList.contains("active");
		errorCriticalButton.classList.toggle("active", active);
		errorCriticalButton.setAttribute("aria-pressed", String(active));
		applyErrorFilters();
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

	const structureButton = e.target.closest(".struct-detail-toggle");
	if (structureButton) {
		const targetId = structureButton.getAttribute("data-target");
		const target = targetId ? document.getElementById(targetId) : null;
		if (!target) return;
		const open = !target.classList.contains("open");
		target.classList.toggle("open", open);
		structureButton.setAttribute("aria-expanded", String(open));
		structureButton.textContent = open ? "Collapse block details" : "Expand block details";
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
	if (e.target.id === "model-filter" || e.target.id === "chat-filter") applyTurnFilters();
	if (e.target.id === "perf-chat-filter") applyPerfFilters();
	if (e.target.id === "error-chat-filter" || e.target.id === "error-kind-filter") applyErrorFilters();
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
	const chat = document.getElementById("chat-filter")?.value || "";
	const issuesOnly = document.getElementById("issues-filter")?.classList.contains("active") || false;
	document.querySelectorAll(".turn-row").forEach(function(row) {
		const matchesQuery = !query || (row.getAttribute("data-search") || "").includes(query);
		const matchesModel = !model || row.getAttribute("data-model") === model;
		const matchesChat = !chat || row.getAttribute("data-chat") === chat;
		const matchesIssue = !issuesOnly || row.getAttribute("data-issue") === "1";
		const visible = matchesQuery && matchesModel && matchesChat && matchesIssue;
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

function saveOpenStructureDetails() {
	const open = new Set();
	document.querySelectorAll(".struct-detail-list.open").forEach(function(el) {
		open.add(el.id);
	});
	return open;
}

function restoreOpenStructureDetails(open) {
	open.forEach(function(id) {
		const detail = document.getElementById(id);
		if (!detail) return;
		detail.classList.add("open");
		const button = [...document.querySelectorAll(".struct-detail-toggle")]
			.find(candidate => candidate.getAttribute("data-target") === id);
		if (button) {
			button.setAttribute("aria-expanded", "true");
			button.textContent = "Collapse block details";
		}
	});
}

function captureOpenTurnAnchor() {
	const rows = [...document.querySelectorAll(".turn-row.open:not(.hidden-row)")];
	if (!rows.length) return undefined;
	const visible = rows.find(function(row) {
		const rect = row.getBoundingClientRect();
		return rect.bottom > 0 && rect.top < window.innerHeight;
	});
	const row = visible || rows[0];
	return {
		detailId: row.getAttribute("data-detail"),
		top: row.getBoundingClientRect().top,
	};
}

function restoreOpenTurnAnchor(anchor) {
	if (!anchor || !anchor.detailId || typeof anchor.top !== "number") return;
	const row = document.querySelector('.turn-row[data-detail="' + anchor.detailId + '"]');
	if (!row) return;
	const delta = row.getBoundingClientRect().top - anchor.top;
	if (Math.abs(delta) > 0.5) {
		window.scrollBy(0, delta);
	}
}

function captureViewState() {
	return {
		openRows: saveOpenRows(),
		openStructureDetails: saveOpenStructureDetails(),
		turnAnchor: captureOpenTurnAnchor(),
		query: document.getElementById("turn-search")?.value || "",
		model: document.getElementById("model-filter")?.value || "",
		chat: document.getElementById("chat-filter")?.value || "",
		perfChat: document.getElementById("perf-chat-filter")?.value || "",
		errorChat: document.getElementById("error-chat-filter")?.value || "",
		errorKind: document.getElementById("error-kind-filter")?.value || "",
		errorCritical: document.getElementById("error-critical-filter")?.classList.contains("active") || false,
		tab: document.querySelector(".tab-btn.active")?.getAttribute("data-tab") || "cache",
		issuesOnly: document.getElementById("issues-filter")?.classList.contains("active") || false,
	};
}

function restoreViewState(state) {
	const search = document.getElementById("turn-search");
	const model = document.getElementById("model-filter");
	const chat = document.getElementById("chat-filter");
	const issues = document.getElementById("issues-filter");
	if (search) search.value = state.query;
	if (model) model.value = state.model;
	if (chat && state.chat) chat.value = state.chat;
	if (issues) {
		issues.classList.toggle("active", state.issuesOnly);
		issues.setAttribute("aria-pressed", String(state.issuesOnly));
	}
	const errorChat = document.getElementById("error-chat-filter");
	const errorKind = document.getElementById("error-kind-filter");
	const errorCritical = document.getElementById("error-critical-filter");
	if (errorChat && state.errorChat) errorChat.value = state.errorChat;
	if (errorKind && state.errorKind) errorKind.value = state.errorKind;
	if (errorCritical) {
		errorCritical.classList.toggle("active", Boolean(state.errorCritical));
		errorCritical.setAttribute("aria-pressed", String(Boolean(state.errorCritical)));
	}
	applyTurnFilters();
	applyErrorFilters();
	restoreTabState(state);
	restoreOpenRows(state.openRows);
	restoreOpenStructureDetails(state.openStructureDetails || new Set());
	restoreOpenTurnAnchor(state.turnAnchor);
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
		if (c.compactionTargetTokens !== undefined) lines.push("Compaction target/fill/retained: " + fmt(c.compactionTargetTokens) + " / " + fmt(c.compactionTargetFillPercent) + "% / " + fmt(c.compactionRetainedPercent) + "%");
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
	lines.push("Tool loop detected: " + (r.toolLoopDetected ? "⚠️ yes" : "no"));
	lines.push(
		"Reasoning loop detected: "
		+ (r.reasoningLoopDetected ? "⚠️ yes" : "no")
		+ (r.reasoningLoopRetries ? " (retries: " + r.reasoningLoopRetries + ")" : "")
	);
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

// Coalesce live updates: keep-alive pings often carry identical data, and a
// single running turn can fire many updates in quick succession. Skip renders
// when the data is unchanged and otherwise render at most once per second
// with the freshest snapshot.
var LAST_RENDER_KEY = "";
var RENDER_TIMER = null;
var PENDING_UPDATE = null;
var UPDATE_COALESCE_MS = 1000;

function dataKey(d) {
	const recs = d.records || [];
	const last = recs.length ? recs[recs.length - 1] : null;
	const keepAlive = d.providerHealth && d.providerHealth.claudeCacheKeepAlive;
	return [
		d.summary.turns || 0,
		recs.length,
		d.errors ? d.errors.length : 0,
		d.summary.promptTokens || 0,
		last ? last.requestId + ":" + (last.lifecyclePhase || "") + ":" + (last.outputTokens || 0) : "",
		keepAlive ? keepAlive.state : "",
	].join("|");
}

function applyUpdate(data) {
	const key = dataKey(data);
	if (key === LAST_RENDER_KEY) {
		return;
	}
	LAST_RENDER_KEY = key;
	const viewState = captureViewState();
	DATA = data;
	try {
		render();
	} catch (err) {
		showError(err);
	}
	restoreViewState(viewState);
}

// Listen for live-update messages from the extension.
window.addEventListener("message", function(e) {
	if (e.data && e.data.type === "update") {
		if (dataKey(e.data.data) === LAST_RENDER_KEY) {
			return;
		}
		PENDING_UPDATE = e.data.data;
		if (RENDER_TIMER) {
			return;
		}
		RENDER_TIMER = setTimeout(function() {
			RENDER_TIMER = null;
			const data = PENDING_UPDATE;
			PENDING_UPDATE = null;
			if (data) {
				applyUpdate(data);
			}
		}, UPDATE_COALESCE_MS);
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
