import * as vscode from "vscode";

import { DEFAULT_SERVER_URL, DEEPSEEK_SERVER_URL } from "../constants";
import { apiProviderSecretKey } from "../api-providers/api-provider-service";
import { getModelsEndpoint, isCloudflareWorkersAiBase, isDeepSeekEndpoint } from "../transport/openai-http";

/**
 * Unified provider directory: one place that knows every model source
 * (Local, DeepSeek, Codex, Claude, and custom API profiles) and whether it is
 * currently reachable.
 *
 * HTTP sources (Local, DeepSeek, custom API profiles) are probed with a
 * lightweight GET /models request on a TTL-guarded interval (default 5 min).
 * Codex and Claude states are supplied by their providers, which already
 * refresh their own status periodically.
 */

export type ProviderKind = "local" | "deepseek" | "codex" | "claude" | "api";

export type ProviderState =
	| "checking"
	| "off"
	| "unconfigured"
	| "online"
	| "offline"
	| "paused";

export interface ProviderStatusEntry {
	key: string;
	kind: ProviderKind;
	label: string;
	state: ProviderState;
	detail: string;
	lastCheckedAt?: number;
}

export interface ApiProviderSource {
	id: string;
	name: string;
	baseUrl: string;
	enabled: boolean;
	hasApiKey: boolean;
}

export interface SubscriptionProviderStatus {
	state: string;
	summary: string;
}

export interface HttpProbeResult {
	ok: boolean;
	status?: number;
	error?: string;
}

export type HttpProbeFn = (
	endpoint: string,
	apiKey: string | undefined,
	timeoutMs: number
) => Promise<HttpProbeResult>;

export interface ProviderDirectoryOptions {
	getSecret: (key: string) => Promise<string | undefined>;
	getConfigValue: (key: string, fallback?: unknown) => unknown;
	getApiProfiles: () => Promise<readonly ApiProviderSource[]>;
	/** Resolves the saved API key for a custom profile (undefined when none). */
	getApiProfileKey?: (id: string) => Promise<string | undefined>;
	getCodexStatus?: () => SubscriptionProviderStatus | undefined;
	getClaudeStatus?: () => SubscriptionProviderStatus | undefined;
	probeHttp?: HttpProbeFn;
	probeIntervalMs?: number;
	probeTimeoutMs?: number;
}

export const DEFAULT_PROVIDER_PROBE_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_PROVIDER_PROBE_TIMEOUT_MS = 5_000;

export function defaultProbeHttp(
	endpoint: string,
	apiKey: string | undefined,
	timeoutMs: number
): Promise<HttpProbeResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const headers: Record<string, string> = {
		"User-Agent": "ai-agent-bridge/provider-probe",
		Accept: "application/json",
	};
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return fetch(endpoint, { method: "GET", headers, signal: controller.signal })
		.then(async response => {
			if (!response.ok) {
				let bodySnippet = "";
				try {
					bodySnippet = (await response.text()).trim().slice(0, 160);
				} catch {
					// Keep the empty snippet when the body cannot be read.
				}
				return {
					ok: false,
					status: response.status,
					error: `HTTP ${response.status} ${response.statusText}${bodySnippet ? ` (${bodySnippet})` : ""}`,
				} satisfies HttpProbeResult;
			}
			return { ok: true } satisfies HttpProbeResult;
		})
		.catch((error: unknown): HttpProbeResult => ({
			ok: false,
			error: error instanceof Error
				? error.name === "AbortError"
					? `No response within ${Math.round(timeoutMs / 1000)}s`
					: error.message
				: String(error),
		}))
		.finally(() => clearTimeout(timer));
}

export function resolveSubscriptionState(status: SubscriptionProviderStatus | undefined): {
	state: ProviderState;
	detail: string;
} {
	if (!status) {
		return { state: "checking", detail: "Waiting for provider status." };
	}
	if (status.summary.startsWith("Paused")) {
		return { state: "paused", detail: status.summary };
	}
	switch (status.state) {
		case "disabled":
			return { state: "off", detail: "Disabled in settings." };
		case "signedOut":
			return { state: "unconfigured", detail: "Not signed in." };
		case "wrongAuth":
			return { state: "unconfigured", detail: status.summary || "Authentication rejected." };
		case "connected":
			return { state: "online", detail: status.summary || "Connected." };
		case "unavailable":
			return { state: "offline", detail: status.summary || "Runtime unavailable." };
		default:
			return { state: "checking", detail: status.summary || "Checking..." };
	}
}

interface ProbeRecord {
	lastAttemptAt: number;
	result: HttpProbeResult;
	endpoint: string;
}

export class ProviderDirectory implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	private readonly entries = new Map<string, ProviderStatusEntry>();
	private readonly probes = new Map<string, ProbeRecord>();
	private readonly probeTimer: NodeJS.Timeout | undefined;
	private readonly probeHttp: HttpProbeFn;
	private readonly probeIntervalMs: number;
	private readonly probeTimeoutMs: number;

	constructor(private readonly options: ProviderDirectoryOptions) {
		this.probeHttp = options.probeHttp ?? defaultProbeHttp;
		this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROVIDER_PROBE_INTERVAL_MS;
		this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROVIDER_PROBE_TIMEOUT_MS;
		if (this.probeIntervalMs > 0) {
			this.probeTimer = setInterval(() => void this.recheck(), this.probeIntervalMs);
		}
	}

	dispose(): void {
		if (this.probeTimer) {
			clearInterval(this.probeTimer);
		}
		this._onDidChange.dispose();
	}

	/** All directory entries in a stable order. */
	list(): ProviderStatusEntry[] {
		return [...this.entries.values()];
	}

	stateOf(key: string): ProviderState | undefined {
		return this.entries.get(key)?.state;
	}

	/** Re-evaluates everything the directory knows (config flags, subscription
	 *  states, saved probe results) and fires onDidChange when anything moved. */
	async refresh(): Promise<void> {
		const before = this.snapshot();
		const config = this.options;
		const secrets = this.options.getSecret;
		const profiles = await config.getApiProfiles().catch(() => []);

		const localEnabled = config.getConfigValue("enableLocalServer", true) !== false;
		const localServerUrl = String(config.getConfigValue("localServerUrl", DEFAULT_SERVER_URL) ?? DEFAULT_SERVER_URL);
		const deepSeekEnabled = config.getConfigValue("enableDeepSeek", true) !== false;
		const codexEnabled = config.getConfigValue("enableCodexSubscription", true) !== false;
		const claudeEnabled = config.getConfigValue("enableClaudeSubscription", true) !== false;

		const deepSeekKey = await secrets("llamacpp.deepSeekApiKey").catch(() => undefined);
		const deepSeekEndpoint = getModelsEndpoint(this.deepSeekServerUrl());

		this.setBuiltin("local", "Local LLM", "local", localEnabled, undefined, {
			unconfiguredDetail: "No server URL configured.",
			endpoint: getModelsEndpoint(localServerUrl),
		});
		this.setBuiltin("deepseek", "DeepSeek", "deepseek", deepSeekEnabled, deepSeekKey, {
			unconfiguredDetail: "No API key saved. Run Configure DeepSeek.",
			endpoint: deepSeekEndpoint,
		});

		const codex = resolveSubscriptionState(config.getCodexStatus?.());
		this.setMapped("codex", "Codex", "codex", codexEnabled, codex.state, codex.detail);
		const claude = resolveSubscriptionState(config.getClaudeStatus?.());
		this.setMapped("claude", "Claude", "claude", claudeEnabled, claude.state, claude.detail);

		for (const profile of profiles) {
			const key = `api-${profile.id}`;
			if (!profile.enabled) {
				this.setMapped(key, profile.name, "api", true, "off", "Disabled in the provider manager.");
				continue;
			}
			const endpoint = getModelsEndpoint(profile.baseUrl);
			const probed = this.probes.get(key);
			if (!probed || probed.endpoint !== endpoint) {
				this.setMapped(key, profile.name, "api", true, "checking",
					profile.hasApiKey ? "Awaiting first availability check." : "No API key saved yet.");
			} else if (probed.result.ok) {
				this.setMapped(key, profile.name, "api", true, "online", `Reachable at ${endpoint}.`);
			} else {
				const status = probed.result.status;
				const cloudflareHint = (status === 401 || status === 403) && isCloudflareWorkersAiBase(profile.baseUrl)
					? " (token rejected: paste the FULL token including its prefix, e.g. cfut_..., with Account > Workers AI > Read for this account)"
					: "";
				this.setMapped(key, profile.name, "api", true, "offline",
					`${endpoint}: ${probed.result.error ?? "Unreachable."}${cloudflareHint}`);
			}
		}

		const after = this.snapshot();
		if (before !== after) {
			this._onDidChange.fire();
		}
	}

	/** Probes every enabled HTTP source now (Local, DeepSeek, custom API
	 *  profiles) and refreshes the directory. Used by the periodic timer and
	 *  the manual "Recheck" button in the Providers Manager. */
	async recheck(): Promise<void> {
		const config = this.options;
		const secrets = this.options.getSecret;
		const profiles = await config.getApiProfiles().catch(() => []);
		const now = Date.now();

		const jobs: Array<Promise<void>> = [];

		if (config.getConfigValue("enableLocalServer", true) !== false) {
			const url = String(config.getConfigValue("localServerUrl", DEFAULT_SERVER_URL) ?? DEFAULT_SERVER_URL);
			jobs.push(this.probeSource("local", getModelsEndpoint(url), undefined, now));
		}

		if (config.getConfigValue("enableDeepSeek", true) !== false) {
			const key = await secrets("llamacpp.deepSeekApiKey").catch(() => undefined);
			if (key) {
				jobs.push(this.probeSource("deepseek", getModelsEndpoint(this.deepSeekServerUrl()), key, now));
			}
		}

		for (const profile of profiles.filter(profile => profile.enabled)) {
			const profileKey = profile.hasApiKey
				? await (this.options.getApiProfileKey?.(profile.id) ?? secrets(apiProviderSecretKey(profile.id))).catch(() => undefined)
				: undefined;
			jobs.push(this.probeSource(`api-${profile.id}`, getModelsEndpoint(profile.baseUrl), profileKey, now));
		}

		await Promise.allSettled(jobs);
		await this.refresh();
	}

	private deepSeekServerUrl(): string {
		const configured = String(this.options.getConfigValue("serverUrl", DEEPSEEK_SERVER_URL) ?? DEEPSEEK_SERVER_URL);
		return isDeepSeekEndpoint(configured) ? configured : DEEPSEEK_SERVER_URL;
	}

	private async probeSource(
		key: string,
		endpoint: string,
		apiKey: string | undefined,
		now: number
	): Promise<void> {
		const result = await this.probeHttp(endpoint, apiKey, this.probeTimeoutMs);
		this.probes.set(key, { lastAttemptAt: now, result, endpoint });
	}

	private setMapped(
		key: string,
		label: string,
		kind: ProviderKind,
		enabled: boolean,
		state: ProviderState,
		detail: string
	): void {
		const effectiveState: ProviderState = !enabled ? "off" : state;
		const effectiveDetail = !enabled
			? "Disabled in settings."
			: detail;
		this.upsert(key, { key, kind, label, state: effectiveState, detail: effectiveDetail });
	}

	private setBuiltin(
		key: string,
		label: string,
		kind: ProviderKind,
		enabled: boolean,
		apiKey: string | undefined,
		hints: { unconfiguredDetail: string; endpoint?: string }
	): void {
		if (!enabled) {
			this.upsert(key, { key, kind, label, state: "off", detail: "Disabled in settings." });
			return;
		}
		if (!apiKey && kind === "deepseek") {
			this.upsert(key, { key, kind, label, state: "unconfigured", detail: hints.unconfiguredDetail });
			return;
		}
		const probed = hints.endpoint && this.probes.get(key)?.endpoint !== hints.endpoint
			? undefined
			: this.probes.get(key);
		if (!probed) {
			this.upsert(key, { key, kind, label, state: "checking", detail: "Awaiting first availability check." });
			return;
		}
		const endpoint = hints.endpoint ?? probed.endpoint;
		this.upsert(key, {
			key,
			kind,
			label,
			state: probed.result.ok ? "online" : "offline",
			detail: probed.result.ok
				? `Reachable at ${endpoint}.`
				: `${endpoint}: ${probed.result.error ?? "Unreachable."}`,
			lastCheckedAt: probed.lastAttemptAt,
		});
	}

	private upsert(key: string, entry: ProviderStatusEntry): void {
		const previous = this.entries.get(key);
		if (
			previous
			&& previous.state === entry.state
			&& previous.detail === entry.detail
			&& previous.label === entry.label
		) {
			return;
		}
		this.entries.set(key, entry);
	}

	private snapshot(): string {
		return JSON.stringify([...this.entries.values()].map(entry => [
			entry.key, entry.state, entry.detail,
		]));
	}
}
