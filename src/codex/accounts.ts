import * as os from "node:os";
import * as path from "node:path";

/**
 * Codex stores every credential, thread and catalogue under CODEX_HOME
 * (~/.codex by default). A second ChatGPT subscription therefore needs a
 * second home: one app-server process per home, each signing in on its own.
 * The built-in account keeps the historical model ids (`codex::<slug>`) so
 * saved chats and settings continue to work; extra accounts use
 * `codex::<account>::<slug>`.
 */
export const CODEX_DEFAULT_ACCOUNT_ID = "";
export const CODEX_ACCOUNT_MODEL_PREFIX = "codex::";
/** Marks a model id that belongs to a named account instead of the built-in one. */
const ACCOUNT_SEGMENT = "::";
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface CodexAccountConfig {
	id: string;
	label?: string;
	/** Absolute or `~`-relative home for this account; defaults to ~/.codex-<id>. */
	codexHome?: string;
	/** Optional Codex CLI override for this account only. */
	cliPath?: string;
}

export interface CodexAccountIdentity {
	/** Empty string for the built-in account. */
	id: string;
	label: string;
	codexHome?: string;
	cliPath?: string;
}

export const CODEX_DEFAULT_ACCOUNT: CodexAccountIdentity = { id: CODEX_DEFAULT_ACCOUNT_ID, label: "Default" };

export function normalizeCodexAccountId(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	return ACCOUNT_ID_PATTERN.test(normalized) ? normalized : undefined;
}

function expandHome(value: string, homeDir: string): string {
	const trimmed = value.trim();
	if (trimmed === "~") {
		return homeDir;
	}
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return path.join(homeDir, trimmed.slice(2));
	}
	return path.resolve(trimmed);
}

/** Extra homes live beside ~/.codex so Codex can create its helper binaries there. */
export function defaultCodexAccountHome(accountId: string, homeDir = os.homedir()): string {
	return path.join(homeDir, `.codex-${accountId}`);
}

/**
 * Normalizes the `llamacpp.codexAccounts` setting. Invalid ids are dropped
 * instead of silently mapped to the built-in account, and the built-in
 * account is always first.
 */
export function resolveCodexAccounts(raw: unknown, homeDir = os.homedir()): CodexAccountIdentity[] {
	const accounts: CodexAccountIdentity[] = [{ ...CODEX_DEFAULT_ACCOUNT }];
	if (!Array.isArray(raw)) {
		return accounts;
	}
	const seen = new Set<string>([CODEX_DEFAULT_ACCOUNT_ID]);
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const id = normalizeCodexAccountId(record.id);
		if (!id || seen.has(id)) {
			continue;
		}
		seen.add(id);
		const label = typeof record.label === "string" && record.label.trim()
			? record.label.trim().slice(0, 40)
			: id;
		const homeValue = typeof record.codexHome === "string" ? record.codexHome.trim() : "";
		const home = homeValue ? expandHome(homeValue, homeDir) : defaultCodexAccountHome(id, homeDir);
		const cliPath = typeof record.cliPath === "string" && record.cliPath.trim()
			? expandHome(record.cliPath, homeDir)
			: undefined;
		accounts.push({ id, label, codexHome: home, ...(cliPath ? { cliPath } : {}) });
	}
	return accounts;
}

export function resolveActiveCodexAccountId(
	accounts: readonly CodexAccountIdentity[],
	stored: unknown
): string {
	const candidate = normalizeCodexAccountId(stored);
	if (candidate !== undefined && accounts.some(account => account.id === candidate)) {
		return candidate;
	}
	return CODEX_DEFAULT_ACCOUNT_ID;
}

export function findCodexAccount(
	accounts: readonly CodexAccountIdentity[],
	accountId: unknown
): CodexAccountIdentity | undefined {
	const requested = accountId && typeof accountId === "object"
		? (accountId as { accountId?: unknown }).accountId
		: accountId;
	if (requested === undefined || requested === null || requested === "") {
		return accounts.find(account => account.id === CODEX_DEFAULT_ACCOUNT_ID);
	}
	const normalized = normalizeCodexAccountId(requested);
	return normalized === undefined ? undefined : accounts.find(account => account.id === normalized);
}

/** Reads `llamacpp.codexActiveAccount`; an unknown value falls back to the built-in account. */
export function resolveActiveCodexAccountSetting(
	config: { get(key: string, defaultValue?: unknown): unknown }
): string {
	return normalizeCodexAccountId(config.get("codexActiveAccount", "")) ?? CODEX_DEFAULT_ACCOUNT_ID;
}

/** `codex::<slug>` for the built-in account, `codex::<id>::<slug>` otherwise. */
export function codexAccountModelPrefix(accountId: string): string {
	return accountId ? `${CODEX_ACCOUNT_MODEL_PREFIX}${accountId}${ACCOUNT_SEGMENT}` : CODEX_ACCOUNT_MODEL_PREFIX;
}

export function encodeCodexAccountModelId(accountId: string, modelId: string): string {
	return `${codexAccountModelPrefix(accountId)}${modelId}`;
}

/**
 * Returns the model slug for this account, or undefined when the id belongs
 * to another account. Named account ids win over the built-in one, so
 * `codex::work::gpt-5` never resolves as the built-in slug `work::gpt-5`.
 */
export function decodeCodexAccountModelId(modelId: string, accountId: string): string | undefined {
	if (!modelId.startsWith(CODEX_ACCOUNT_MODEL_PREFIX)) {
		return undefined;
	}
	const rest = modelId.slice(CODEX_ACCOUNT_MODEL_PREFIX.length);
	if (accountId) {
		const prefix = `${accountId}${ACCOUNT_SEGMENT}`;
		return rest.startsWith(prefix) && rest.length > prefix.length ? rest.slice(prefix.length) : undefined;
	}
	return rest.includes(ACCOUNT_SEGMENT) ? undefined : rest;
}

/** True when no account id is longer than the limit; rejects ambiguous prefixes. */
export function isValidCodexAccountId(value: unknown): boolean {
	return normalizeCodexAccountId(value) !== undefined;
}

/** Durable state keys must not be shared between accounts. */
export function codexAccountStateKey(baseKey: string, accountId: string): string {
	return accountId ? `${baseKey}.account.${accountId}` : baseKey;
}

/** Human-readable suffix for a picker label; the built-in account stays unlabelled. */
export function codexAccountLabelSuffix(account: CodexAccountIdentity): string {
	return account.id ? ` · ${account.label}` : "";
}
