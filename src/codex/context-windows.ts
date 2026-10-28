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

/** Why a model drives the followed shared context: it was used last, it is Codex's default, or it has the largest known window. */
export type CodexFollowReason = "lastUsed" | "default" | "largest";

export interface CodexFollowTarget {
	modelId: string;
	reason: CodexFollowReason;
}

/**
 * The model whose window the shared context follows. Before any Codex request
 * the windows Codex already catalogued or reported are used right away: the
 * Codex default model first, else the largest known window. Fallback-setting
 * windows never qualify; a used model whose window is still unknown follows
 * nothing until Codex reports it, rather than another model's window.
 */
export function resolveCodexFollowTarget(
	models: readonly CodexModelContextWindow[],
	lastUsedModelId?: string,
	defaultModelId?: string
): CodexFollowTarget | undefined {
	const known = models.filter(model => model.source !== "fallback");
	if (lastUsedModelId) {
		return known.some(model => model.modelId === lastUsedModelId) ? { modelId: lastUsedModelId, reason: "lastUsed" } : undefined;
	}
	if (defaultModelId && known.some(model => model.modelId === defaultModelId)) {
		return { modelId: defaultModelId, reason: "default" };
	}
	const largest = known.reduce<CodexModelContextWindow | undefined>(
		(best, model) => !best || model.window > best.window ? model : best,
		undefined
	);
	return largest ? { modelId: largest.modelId, reason: "largest" } : undefined;
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
