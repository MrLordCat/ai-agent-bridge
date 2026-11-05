import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Chat prompts carry attachments as `http://_vscodecontentref_/N` placeholders.
 * A model that quotes such a link back produces a reference the chat view cannot
 * resolve, and clicking it opens a broken `file:///d:/[name](http://_vscodecontentref_/1)`
 * path. The same happens to Windows paths and relative paths written into a
 * markdown destination. This module rewrites those destinations into a real
 * `file:` URI of an existing file, and otherwise into a plain code span, so a
 * link either opens or is not a link at all.
 */

/** Maps a path-like label or destination to an absolute existing file path. */
export type LinkResolver = (candidate: string) => string | undefined;

const PLACEHOLDER = /(?:https?:\/+_vscodecontentref_|vscode-content:|vscode-resource:)/i;
const MARKDOWN_LINK = /(!?)\[([^\]\n]{0,300})\]\(\s*(<[^>\n]*>|[^)\s]*)\s*\)/g;
const BARE_PLACEHOLDER = /https?:\/\/_vscodecontentref_[^\s)\]]*/gi;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

function decodeSafe(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** Strips quotes, `<...>`, a `:line` suffix, an anchor and a query. */
function cleanCandidate(value: string): string {
	let cleaned = value.trim();
	if ((cleaned.startsWith("<") && cleaned.endsWith(">")) || (cleaned.startsWith("\"") && cleaned.endsWith("\""))) {
		cleaned = cleaned.slice(1, -1).trim();
	}
	cleaned = decodeSafe(cleaned).replace(/^file:\/\/\/?/i, "").replace(/^\/([A-Za-z]:)/, "$1");
	cleaned = cleaned.replace(/[?#].*$/, "").replace(/:\d+(?:-\d+)?$/, "");
	return cleaned;
}

function isAbsolutePath(value: string): boolean {
	return WINDOWS_ABSOLUTE.test(value) || path.isAbsolute(value);
}

/**
 * Resolves a file that exists on disk. Absolute paths are checked as-is;
 * relative ones are tried against each root (workspace folders, then cwd).
 */
export function createFileLinkResolver(roots: readonly string[]): LinkResolver {
	const usable = roots.filter(root => typeof root === "string" && root.length > 0);
	return raw => {
		const candidate = cleanCandidate(raw);
		if (!candidate || PLACEHOLDER.test(candidate)) {
			return undefined;
		}
		const absolute = isAbsolutePath(candidate);
		if (absolute) {
			try {
				return existsSync(candidate) ? path.resolve(candidate) : undefined;
			} catch {
				return undefined;
			}
		}
		for (const root of usable) {
			try {
				const target = path.resolve(path.join(root, candidate));
				if (existsSync(target)) {
					return target;
				}
			} catch {
				// An unusable root is not an error: try the next one.
			}
		}
		return undefined;
	};
}

/** Resolver for the current window: workspace folders, then the process cwd. */
export const resolveWorkspaceLink: LinkResolver = candidate => {
	const roots = [
		...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
		process.cwd(),
	];
	return createFileLinkResolver(roots)(candidate);
};

function codeSpan(value: string): string {
	const trimmed = value.trim().replace(/^`+|`+$/g, "").replace(/\s+/g, " ");
	return trimmed ? `\`${trimmed}\`` : "";
}

function fileLink(label: string, absolute: string): string {
	const text = label.trim() || path.basename(absolute);
	return `[${text}](${vscode.Uri.file(absolute).toString()})`;
}

function reference(label: string, resolve: LinkResolver): string {
	const cleaned = label.trim().replace(/^`+|`+$/g, "");
	const found = cleaned ? resolve(cleaned) : undefined;
	return found ? fileLink(cleaned, found) : codeSpan(cleaned);
}

function rewriteDestination(label: string, rawDestination: string, resolve: LinkResolver): string | undefined {
	const destination = rawDestination.trim().replace(/^</, "").replace(/>$/, "");
	if (!destination || destination.startsWith("#") || /^data:/i.test(destination)) {
		return undefined;
	}
	if (PLACEHOLDER.test(destination)) {
		return reference(label, resolve);
	}
	if (/^file:/i.test(destination)) {
		const decoded = decodeSafe(destination);
		// A destination that already contains markdown is the mangled form of a
		// placeholder link; the useful part is the file name inside it.
		const embedded = /\[([^\]\n]{1,300})\]\([^)\n]*\)/.exec(decoded);
		if (embedded && PLACEHOLDER.test(decoded)) {
			return reference(embedded[1], resolve);
		}
		const plainPath = decoded.replace(/^file:\/\/\/?/i, "").replace(/^\/([A-Za-z]:)/, "$1");
		const found = resolve(plainPath);
		return found ? fileLink(label, found) : codeSpan(plainPath);
	}
	// Remote links and other schemes are the model's own and must not change.
	if (SCHEME.test(destination) && !WINDOWS_ABSOLUTE.test(destination)) {
		return undefined;
	}
	const found = resolve(destination);
	return found ? fileLink(label, found) : undefined;
}

/**
 * Rewrites every markdown link whose destination cannot be opened by the chat
 * view. Text without such links is returned unchanged.
 */
export function sanitizeChatMarkdown(text: string, resolve: LinkResolver = resolveWorkspaceLink): string {
	if (!text || (!text.includes("](") && !PLACEHOLDER.test(text))) {
		return text;
	}
	const rewritten = text.replace(MARKDOWN_LINK, (match, bang: string, label: string, destination: string) => {
		const replacement = rewriteDestination(label, destination, resolve);
		if (replacement === undefined) {
			return match;
		}
		// An image link with a broken destination becomes its readable label.
		return bang === "!" && !replacement.startsWith("[") ? codeSpan(label) : replacement;
	});
	return rewritten.replace(BARE_PLACEHOLDER, "");
}

/** True while the tail could still grow into a link or a bare placeholder. */
// A tail ending in `]` may still become `](destination)`, so it is held too.
const PARTIAL_LINK_TAIL = /\[[^[\]\n]{0,300}\]?(?:\(\s*(?:<[^>\n]*|[^)\s]*)?)?$/;
const PARTIAL_PLACEHOLDER_TAIL = /https?:\/+_vscodecontentref_?[^\s)\]]*$/i;

function safeCut(text: string): number {
	// A partial link wins over a partial placeholder: the placeholder sits inside
	// its destination, so holding the destination would split the whole link.
	const open = text.lastIndexOf("[");
	if (open >= 0 && PARTIAL_LINK_TAIL.test(text.slice(open))) {
		return open;
	}
	const partialPlaceholder = PARTIAL_PLACEHOLDER_TAIL.exec(text);
	if (partialPlaceholder) {
		return partialPlaceholder.index;
	}
	return text.length;
}

/**
 * Sanitizes text streamed in deltas. A link split across chunks is held back
 * until it is complete, while ordinary prose is released immediately.
 */
export class ChatMarkdownLinkStream {
	private pending = "";

	constructor(private readonly resolve: LinkResolver = resolveWorkspaceLink) {}

	push(delta: string): string {
		if (!delta) {
			return "";
		}
		this.pending += delta;
		const cut = safeCut(this.pending);
		if (cut <= 0) {
			return "";
		}
		const ready = this.pending.slice(0, cut);
		this.pending = this.pending.slice(cut);
		return sanitizeChatMarkdown(ready, this.resolve);
	}

	flush(): string {
		if (!this.pending) {
			return "";
		}
		const ready = this.pending;
		this.pending = "";
		return sanitizeChatMarkdown(ready, this.resolve);
	}
}
