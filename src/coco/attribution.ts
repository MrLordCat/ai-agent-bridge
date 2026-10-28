/**
 * Cortex Code's own system prompt tells Coco to sign commits and pull requests
 * with "Generated with [Snowflake CoCo](…)" and "Co-authored-by: Snowflake CoCo
 * <noreply@snowflake.com>". The bridge forbids that in its tool policy and
 * strips the attribution from every tool call Coco hands to VS Code, so it
 * reaches neither commits nor files even when the model ignores the policy.
 */

const NAME = String.raw`\[?\**snowflake\s+(?:coco|cortex\s+code)\**\]?`;
const ATTRIBUTION = [
	String.raw`generated\s+(?:with|by)\s+${NAME}(?:\(https?:\/\/[^)\s"']*\))?[^\w\r\n"']{0,8}`,
	String.raw`co-authored-by:\s*${NAME}[^\r\n"']*`,
	String.raw`\[\**snowflake\s+coco\**\]\(mailto:noreply@snowflake\.com\)[^\r\n"']*`,
].join("|");
/** Emoji, list markers or quotes may precede the attribution on its own line. */
const PREFIX = String.raw`[^\w\r\n"']{0,8}?`;

/** `-m "Generated with …"`, `--message='Co-authored-by: …'`, `--trailer "…"` holding only attribution. */
const ATTRIBUTION_ARGUMENT = new RegExp(
	String.raw`[ \t]+(?:-m|--message|--trailer)(?:[ \t]+|=)(["'])[ \t]*${PREFIX}(?:${ATTRIBUTION})[ \t]*\1(?=\s|$|[;|&)])`,
	"giu"
);
/** A line holding only attribution, together with the blank lines before it. */
const ATTRIBUTION_LINE = new RegExp(
	String.raw`(?:^|(?:\r?\n[ \t]*)*\r?\n)[ \t]*${PREFIX}(?:${ATTRIBUTION})[ \t]*(?=\r?\n|$)`,
	"giu"
);
const LEADING_BLANK_LINES = /^(?:[ \t]*\r?\n)+/;

export function stripCocoAttribution(text: string): string {
	if (!/snowflake/i.test(text)) {
		return text;
	}
	const startedWithAttribution = new RegExp(String.raw`^[ \t]*${PREFIX}(?:${ATTRIBUTION})`, "iu").test(text);
	const stripped = text.replace(ATTRIBUTION_ARGUMENT, "").replace(ATTRIBUTION_LINE, "");
	return startedWithAttribution ? stripped.replace(LEADING_BLANK_LINES, "") : stripped;
}

/**
 * Strips attribution from every string in a tool input. Keys naming existing
 * text to match (`oldString`, `old_str`, …) are kept, so an edit that removes
 * an earlier attribution from a file still finds it.
 */
export function stripCocoAttributionFromInput<T>(input: T): T {
	return strip(input, undefined) as T;
}

function strip(value: unknown, key: string | undefined): unknown {
	if (typeof value === "string") {
		return key !== undefined && /^old/i.test(key) ? value : stripCocoAttribution(value);
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map(item => {
			const result = strip(item, key);
			changed ||= result !== item;
			return result;
		});
		return changed ? next : value;
	}
	if (value && typeof value === "object") {
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [entryKey, entry] of Object.entries(value)) {
			const result = strip(entry, entryKey);
			changed ||= result !== entry;
			next[entryKey] = result;
		}
		return changed ? next : value;
	}
	return value;
}
