import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import { getCurrentWorkspaceScopeId } from "../memory/scope";
import type { SharedMemoryEntry, SharedMemoryKind, SharedMemoryScope } from "../memory/types";
import type { SharedMemoryService } from "../memory/shared-memory-service";

/**
 * Estimates the context tokens a memory entry contributes to a request.
 * Matches the extension-wide heuristic of ~4 characters per token.
 */
export function estimateMemoryTokens(entries: readonly SharedMemoryEntry[]): number {
	let total = 0;
	for (const entry of entries) {
		const expired = entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= Date.now();
		if (expired) {
			continue;
		}
		total += Math.ceil((entry.title.length + entry.content.length) / 4);
	}
	return total;
}

function esc(value: unknown): string {
	return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(value: unknown): string {
	return esc(value).replace(/"/g, "&quot;");
}

function formatTokens(value: number): string {
	return value >= 1_000_000
		? `${(value / 1_000_000).toFixed(2).replace(/\.00$/, "")}M`
		: value >= 1_000
			? `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`
			: String(value);
}

function formatDate(value: string | undefined): string {
	if (!value) {
		return "—";
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

/** Human-readable project label from a workspace scopeId, e.g. "d:/GitHub/llama.cpp-with-GUI". */
export function humanScopeLabel(scope: SharedMemoryScope, scopeId: string | undefined): string {
	if (scope === "global") {
		return "global";
	}
	if (!scopeId) {
		return "workspace";
	}
	const decoded = decodeURIComponent(scopeId).replace(/^file:\/\//, "");
	return decoded.replace(/^\//, "") || scopeId;
}

export interface MemoryManagerRenderState {
	entries: SharedMemoryEntry[];
	editingId?: string;
	currentWorkspaceScopeId?: string;
}

export function renderMemoryManagerHtml(state: MemoryManagerRenderState): string {
	const nonce = randomBytes(16).toString("base64");
	const editing = state.editingId
		? state.entries.find(entry => entry.id === state.editingId)
		: undefined;
	const editingIsNew = state.editingId === "new";
	const totalTokens = estimateMemoryTokens(state.entries);

	let cards = "";
	if (state.entries.length === 0) {
		cards = '<div class="empty">No shared memory entries yet. Use <code>llamacpp_store_memory</code> or create one below.</div>';
	}
	for (const entry of state.entries) {
		const expired = entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= Date.now();
		const entryTokens = Math.ceil((entry.title.length + entry.content.length) / 4);
		const otherProject = entry.scope === "workspace"
			&& Boolean(state.currentWorkspaceScopeId)
			&& entry.scopeId !== state.currentWorkspaceScopeId;
		const filterBucket = entry.scope === "global" ? "global" : otherProject ? "other" : "current";
		cards += '<article class="entry' + (expired ? " expired" : "") + '" data-scope="' + filterBucket + '">';
		cards += '<div class="entry-head"><div class="entry-title">' + esc(entry.title) + '</div><div class="entry-actions">';
		cards += '<button class="btn edit-btn" data-id="' + escAttr(entry.id) + '" type="button">Edit</button>';
		cards += '<button class="btn danger delete-btn" data-id="' + escAttr(entry.id) + '" type="button">Delete</button>';
		cards += '</div></div>';
		cards += '<div class="badges"><span class="badge badge-kind">' + esc(entry.kind) + '</span>'
			+ '<span class="badge badge-scope">' + esc(entry.scope + (entry.scopeId ? ":" + humanScopeLabel(entry.scope, entry.scopeId) : "")) + '</span>'
			+ (otherProject ? '<span class="badge badge-expired">other project</span>' : '')
			+ (entry.pinned ? '<span class="badge badge-pinned">pinned</span>' : '')
			+ (expired ? '<span class="badge badge-expired">expired</span>' : '')
			+ '</div>';
		if (entry.tags.length > 0) {
			cards += '<div class="tags">' + entry.tags.map(tag => '<span class="tag">' + esc(tag) + '</span>').join("") + '</div>';
		}
		cards += '<div class="content">' + esc(entry.content) + '</div>';
		cards += '<div class="meta">~' + formatTokens(entryTokens) + ' tokens · updated ' + formatDate(entry.updatedAt)
			+ (entry.sourceUrl ? ' · <a href="#" class="source-link" data-url="' + escAttr(entry.sourceUrl) + '">source</a>' : '')
			+ (entry.expiresAt ? ' · expires ' + formatDate(entry.expiresAt) : '')
			+ '</div>';
		cards += '</article>';
	}

	const formOpen = Boolean(editing || editingIsNew);
	let form = "";
	if (formOpen) {
		const value = editing ?? {
			id: "",
			title: "",
			content: "",
			tags: [] as string[],
			pinned: false,
			scope: "workspace" as SharedMemoryScope,
			kind: "other",
			createdAt: "",
			updatedAt: "",
		};
		form = '<section class="card form-card">';
		form += '<h2>' + (editingIsNew ? "New memory entry" : "Edit memory entry") + '</h2>';
		if (editing && editing.scope === "workspace" && state.currentWorkspaceScopeId && editing.scopeId !== state.currentWorkspaceScopeId) {
			form += '<p class="warn">This entry belongs to another project (' + esc(humanScopeLabel(editing.scope, editing.scopeId)) + '). Saving without changing Scope keeps its project; switching Scope moves it.</p>';
		}
		form += '<label>Title<input id="fm-title" type="text" value="' + escAttr(value.title) + '" maxlength="160"></label>';
		form += '<label>Content<textarea id="fm-content" rows="6" maxlength="24000">' + esc(value.content) + '</textarea></label>';
		form += '<div class="form-row"><label>Kind<select id="fm-kind">'
			+ ["preference", "decision", "environment", "workflow", "externalFact", "other"]
				.map(kind => '<option value="' + kind + '"' + (value.kind === kind ? " selected" : "") + '>' + kind + '</option>').join("")
			+ '</select></label>';
		form += '<label>Scope<select id="fm-scope">'
			+ ["global", "workspace"].map(scope => '<option value="' + scope + '"' + (value.scope === scope ? " selected" : "") + '>' + scope + '</option>').join("")
			+ '</select></label></div>';
		form += '<label>Tags (comma separated)<input id="fm-tags" type="text" value="' + escAttr(value.tags.join(", ")) + '"></label>';
		form += '<div class="form-row"><label class="checkbox-label"><input id="fm-pinned" type="checkbox"' + (value.pinned ? " checked" : "") + '> Pinned</label>';
		form += '<label>Expires at (ISO date, optional)<input id="fm-expires" type="text" value="' + escAttr(value.expiresAt ?? "") + '" placeholder="2026-09-01T00:00:00.000Z"></label></div>';
		form += '<div class="form-actions"><button class="btn primary" id="fm-save" type="button">' + (editingIsNew ? "Create" : "Save") + '</button>'
			+ '<button class="btn" id="fm-cancel" type="button">Cancel</button></div>';
		form += '</section>';
	}

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${'vscode-webview:'} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Shared Memory</title>
	<style>
		body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size) var(--vscode-font-family); padding: 18px 22px; max-width: 860px; margin: 0 auto; }
		h1 { font-size: 20px; margin: 0 0 4px; }
		.lead { color: var(--vscode-descriptionForeground); margin: 0 0 18px; }
		.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
		.badge { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 10px; font-weight: 600; margin-right: 5px; }
		.badge-kind { background: rgba(55,148,255,.15); color: #7db9ff; }
		.badge-scope { background: rgba(70,201,111,.14); color: #7de0a0; }
		.badge-pinned { background: rgba(245,158,11,.16); color: #f6c45f; }
		.badge-expired { background: rgba(239,98,98,.16); color: #ef8484; }
		.entry { border: 1px solid var(--vscode-widget-border); background: var(--vscode-sideBar-background); border-radius: 7px; padding: 12px 14px; margin: 10px 0; }
		.entry.expired { opacity: .6; }
		.entry-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
		.entry-title { font-size: 14px; font-weight: 650; }
		.entry-actions { display: flex; gap: 6px; }
		.tags { margin: 6px 0 2px; }
		.tag { display: inline-block; padding: 0 8px; border-radius: 9px; font-size: 10px; background: rgba(127,127,127,.14); margin-right: 4px; }
		.content { margin: 8px 0; white-space: pre-wrap; word-break: break-word; line-height: 1.45; color: var(--vscode-foreground); }
		.meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
		.empty { color: var(--vscode-descriptionForeground); padding: 18px 0; }
		.card { border: 1px solid var(--vscode-widget-border); background: var(--vscode-sideBar-background); border-radius: 7px; padding: 14px 16px; margin: 12px 0; }
		.card h2 { font-size: 14px; margin: 0 0 10px; }
		label { display: block; margin: 8px 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
		input[type=text], textarea, select { width: 100%; box-sizing: border-box; margin-top: 3px; padding: 5px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font: inherit; }
		.form-row { display: flex; gap: 12px; }
		.form-row > label { flex: 1; }
		.checkbox-label { display: flex; align-items: center; gap: 7px; }
		.form-actions { display: flex; gap: 8px; margin-top: 12px; }
		.btn { border: 0; padding: 5px 14px; border-radius: 3px; cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font: inherit; }
		.btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.btn.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
		.btn.primary:hover { background: var(--vscode-button-hoverBackground); }
		.btn.danger { color: #ffb4b4; background: rgba(239,98,98,.2); }
		.btn.danger:hover { background: rgba(239,98,98,.32); }
		.chips { display: inline-flex; gap: 5px; flex-wrap: wrap; }
		.chip { border: 1px solid var(--vscode-widget-border); background: transparent; color: var(--vscode-descriptionForeground); padding: 2px 10px; border-radius: 10px; cursor: pointer; font-size: 11px; }
		.chip:hover { color: var(--vscode-foreground); }
		.chip.active { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); background: rgba(55,148,255,.12); }
		.warn { padding: 7px 10px; border: 1px solid rgba(245,158,11,.4); border-radius: 5px; color: #f6c45f; font-size: 12px; margin: 8px 0; }
		.entry.hidden { display: none; }
		#status { margin-left: 10px; color: var(--vscode-testing-iconPassed); font-size: 12px; }
	</style>
</head>
<body>
	<h1>Shared Memory</h1>
	<p class="lead">Durable reference context injected into requests. ${esc(state.entries.length)} entries · ~${esc(formatTokens(totalTokens))} tokens of context.</p>
	<div class="toolbar">
		<button class="btn primary" id="new-btn" type="button">New entry</button>
		<button class="btn" id="refresh-btn" type="button">Refresh</button>
		<button class="btn" id="open-file-btn" type="button">Open JSON file</button>
		<span class="chips" id="filter-chips">
			<button class="chip active" data-filter="all" type="button">All</button>
			<button class="chip" data-filter="global" type="button">Global</button>
			<button class="chip" data-filter="current" type="button">This project</button>
			<button class="chip" data-filter="other" type="button">Other projects</button>
		</span>
		<span id="status"></span>
	</div>
	${form}
	<div id="entries">${cards}</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.getElementById('new-btn').addEventListener('click', () => vscode.postMessage({ type: 'new' }));
		document.getElementById('refresh-btn').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
		document.getElementById('open-file-btn').addEventListener('click', () => vscode.postMessage({ type: 'openFile' }));
		document.querySelectorAll('.edit-btn').forEach(btn => btn.addEventListener('click', () => vscode.postMessage({ type: 'edit', id: btn.getAttribute('data-id') })));
		document.querySelectorAll('.delete-btn').forEach(btn => btn.addEventListener('click', () => vscode.postMessage({ type: 'delete', id: btn.getAttribute('data-id') })));
		const applyFilter = (filter) => {
			document.querySelectorAll('#filter-chips .chip').forEach(chip => chip.classList.toggle('active', chip.getAttribute('data-filter') === filter));
			document.querySelectorAll('#entries .entry').forEach(card => {
				const bucket = card.getAttribute('data-scope');
				card.classList.toggle('hidden', filter !== 'all' && bucket !== filter);
			});
		};
		document.querySelectorAll('#filter-chips .chip').forEach(chip => chip.addEventListener('click', () => applyFilter(chip.getAttribute('data-filter'))));
		const cancel = document.getElementById('fm-cancel');
		if (cancel) cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
		const save = document.getElementById('fm-save');
		if (save) save.addEventListener('click', () => {
			const tags = (document.getElementById('fm-tags').value || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
			vscode.postMessage({
				type: 'save',
				entry: {
					id: ' + (editing?.id ? JSON.stringify(editing.id) : "undefined") + ',
					title: document.getElementById('fm-title').value,
					content: document.getElementById('fm-content').value,
					tags: tags,
					kind: document.getElementById('fm-kind').value,
					scope: document.getElementById('fm-scope').value,
					pinned: document.getElementById('fm-pinned').checked,
					expiresAt: document.getElementById('fm-expires').value || undefined,
				},
			});
		});
		window.addEventListener('message', event => {
			if (event.data?.type === 'saved') document.getElementById('status').textContent = 'Saved';
			if (event.data?.type === 'deleted') document.getElementById('status').textContent = 'Deleted';
			if (event.data?.type === 'error') document.getElementById('status').textContent = 'Error: ' + event.data.message;
		});
	</script>
</body>
</html>`;
}

export class MemoryManagerPanel {
	public static readonly viewType = "llamacpp.sharedMemory";
	private static current: MemoryManagerPanel | undefined;

	private readonly _panel: vscode.WebviewPanel;
	private readonly _memory: SharedMemoryService;
	private _editingId: string | undefined;

	private constructor(panel: vscode.WebviewPanel, memory: SharedMemoryService) {
		this._panel = panel;
		this._memory = memory;
		this._panel.onDidDispose(() => {
			MemoryManagerPanel.current = undefined;
		});
		this._panel.webview.onDidReceiveMessage(async (message: unknown) => {
			if (!message || typeof message !== "object") {
				return;
			}
			const data = message as { type?: string; id?: string; entry?: Record<string, unknown> };
			try {
				if (data.type === "new") {
					this._editingId = "new";
				} else if (data.type === "edit") {
					this._editingId = String(data.id ?? "");
				} else if (data.type === "cancel") {
					this._editingId = undefined;
				} else if (data.type === "refresh") {
					// no-op: render below uses the latest entries
				} else if (data.type === "openFile") {
					const document = await vscode.workspace.openTextDocument(vscode.Uri.file(this._memory.filePath));
					await vscode.window.showTextDocument(document, { preview: false });
					return;
				} else if (data.type === "delete") {
					const id = String(data.id ?? "");
					const entry = this._memory.get(id);
					if (entry) {
						await this._memory.remove(id, {
							scope: entry.scope,
							...(entry.scope === "workspace" ? { workspaceId: getCurrentWorkspaceScopeId() } : {}),
						});
						if (this._editingId === id) {
							this._editingId = undefined;
						}
						void this._panel.webview.postMessage({ type: "deleted" });
					}
					return;
				} else if (data.type === "save") {
					const entry = data.entry ?? {};
					const scope = String(entry.scope ?? "workspace") as SharedMemoryScope;
					const existingId = typeof entry.id === "string" && entry.id ? entry.id : undefined;
					const existing = existingId ? this._memory.get(existingId) : undefined;
					// Keep the original project when the scope did not change (editing an
					// entry that belongs to another workspace must not rebind it here).
					const keepScopeId = existing && existing.scope === scope ? existing.scopeId : undefined;
					const scopeId = scope === "workspace"
						? (keepScopeId ?? getCurrentWorkspaceScopeId())
						: undefined;
					if (scope === "workspace" && !scopeId) {
						void this._panel.webview.postMessage({ type: "error", message: "Project memory requires an open workspace." });
						return;
					}
					const expiresAt = typeof entry.expiresAt === "string" && entry.expiresAt.trim()
						? entry.expiresAt.trim()
						: undefined;
					await this._memory.upsert({
						id: existingId,
						title: String(entry.title ?? ""),
						content: String(entry.content ?? ""),
						tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
						kind: String(entry.kind ?? "other") as SharedMemoryKind,
						scope,
						...(scopeId ? { scopeId } : {}),
						pinned: entry.pinned === true,
						...(expiresAt ? { expiresAt } : {}),
					});
					this._editingId = undefined;
					void this._panel.webview.postMessage({ type: "saved" });
				}
			} catch (error) {
				void this._panel.webview.postMessage({
					type: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			}
			this.render();
		}, undefined);
		this.render();
	}

	public static createOrShow(extensionUri: vscode.Uri, memory: SharedMemoryService): void {
		if (MemoryManagerPanel.current) {
			MemoryManagerPanel.current._panel.reveal(vscode.ViewColumn.Beside);
			MemoryManagerPanel.current.render();
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			MemoryManagerPanel.viewType,
			"Shared Memory",
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [extensionUri],
			},
		);
		try {
			MemoryManagerPanel.current = new MemoryManagerPanel(panel, memory);
		} catch (error: unknown) {
			panel.dispose();
			throw new Error(`Failed to initialize shared memory panel: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	public static refreshIfOpen(): void {
		MemoryManagerPanel.current?.render();
	}

	public render(): void {
		const entries = this._memory.list();
		const html = renderMemoryManagerHtml({
			entries,
			editingId: this._editingId,
			currentWorkspaceScopeId: getCurrentWorkspaceScopeId(),
		});
		if (this._panel.webview.html === html) {
			return;
		}
		this._panel.webview.html = html;
	}
}
