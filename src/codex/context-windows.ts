import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where a Codex model window came from: a turn's usage snapshot, Codex's model catalog, or the fallback setting. */
export type CodexContextWindowSource = "server" | "catalog" | "fallback";

export interface CodexModelContextWindow {
	modelId: string;
	window: number;
	source: CodexContextWindowSource;
}

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function codexModelsCachePath(env: NodeJS.ProcessEnv = process.env): string {
	const home = env.CODEX_HOME?.trim();
	return path.join(home || path.join(os.homedir(), ".codex"), "models_cache.json");
}

/**
 * Effective input windows from Codex's own catalog (`models_cache.json`):
 * context_window × effective_context_window_percent, the value Codex later
 * reports as modelContextWindow in a turn. Entries without a valid percent are
 * skipped instead of guessed.
 */
export function parseCodexModelsCache(text: string): Map<string, number> {
	const windows = new Map<string, number>();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return windows;
	}
	const models = parsed && typeof parsed === "object" ? (parsed as { models?: unknown }).models : undefined;
	if (!Array.isArray(models)) {
		return windows;
	}
	for (const entry of models) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const { slug, context_window: contextWindow, effective_context_window_percent: percent } = entry as Record<string, unknown>;
		if (typeof slug !== "string" || !MODEL_SLUG.test(slug)) {
			continue;
		}
		if (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
			continue;
		}
		if (typeof percent !== "number" || !Number.isFinite(percent) || percent <= 0 || percent > 100) {
			continue;
		}
		windows.set(slug, Math.floor(contextWindow * percent / 100));
	}
	return windows;
}

export interface CodexModelsCacheSnapshot {
	windows: Map<string, number>;
	/** -1 when the catalog is missing or unreadable. */
	mtimeMs: number;
}

/**
 * Missing, oversized or malformed catalogs yield an empty map. Returns
 * undefined when the file still has the given modification time.
 */
export async function readCodexModelsCache(
	file = codexModelsCachePath(),
	unchangedMtimeMs?: number
): Promise<CodexModelsCacheSnapshot | undefined> {
	try {
		const stat = await fs.stat(file);
		if (stat.mtimeMs === unchangedMtimeMs) {
			return undefined;
		}
		if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) {
			return { windows: new Map(), mtimeMs: stat.mtimeMs };
		}
		return { windows: parseCodexModelsCache(await fs.readFile(file, "utf8")), mtimeMs: stat.mtimeMs };
	} catch {
		return unchangedMtimeMs === -1 ? undefined : { windows: new Map(), mtimeMs: -1 };
	}
}
