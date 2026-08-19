import { randomUUID } from "node:crypto";
import * as vscode from "vscode";

import {
	normalizeServerUrl,
	type ApiRequestProtocol,
	type ChatModelSource,
} from "../model-sources/source-routing";
import {
	fetchApiProviderBalance,
	type ApiProviderBalanceInfo,
} from "./balance";

const API_PROVIDER_STORAGE_KEY = "llamacpp.apiProviders.v1";
const API_PROVIDER_SECRET_PREFIX = "llamacpp.apiProvider.";

export function apiProviderSecretKey(id: string): string {
	return `${API_PROVIDER_SECRET_PREFIX}${id}.apiKey`;
}

export const API_PROVIDER_CONTEXT_MIN = 4_096;
export const API_PROVIDER_CONTEXT_MAX = 1_048_576;
export const DEFAULT_API_PROVIDER_CONTEXT = 131_072;

export type ApiProviderFamily =
	| "auto"
	| "openai"
	| "deepseek"
	| "qwen"
	| "llama"
	| "mistral"
	| "gemma"
	| "phi";

export interface ApiProviderProfile {
	id: string;
	name: string;
	baseUrl: string;
	protocol: ApiRequestProtocol;
	family: ApiProviderFamily;
	contextLength: number;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface ApiProviderSummary extends ApiProviderProfile {
	hasApiKey: boolean;
}

export interface ApiProviderDraft {
	id?: string;
	name: string;
	baseUrl: string;
	protocol?: ApiRequestProtocol;
	family?: ApiProviderFamily;
	contextLength?: number;
	enabled?: boolean;
}

export interface ApiProviderSecretUpdate {
	apiKey?: string;
	clearApiKey?: boolean;
}

/** Enabled profile summary for Quick Access, enriched with balance info. */
export interface QuickAccessApiProvider {
	id: string;
	name: string;
	baseUrl: string;
	protocol: ApiRequestProtocol;
	contextLength: number;
	enabled: boolean;
	hasApiKey: boolean;
	balance?: ApiProviderBalanceInfo;
}

const PROTOCOLS = new Set<ApiRequestProtocol>(["openai", "deepseek", "llamacpp"]);
const FAMILIES = new Set<ApiProviderFamily>([
	"auto",
	"openai",
	"deepseek",
	"qwen",
	"llama",
	"mistral",
	"gemma",
	"phi",
]);

function normalizeId(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	return /^[a-z0-9][a-z0-9-]{5,63}$/.test(normalized) ? normalized : undefined;
}

function normalizeName(value: unknown): string {
	const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
	if (!normalized) {
		throw new Error("Provider name is required.");
	}
	if (normalized.length > 80) {
		throw new Error("Provider name must be 80 characters or fewer.");
	}
	return normalized;
}

function normalizeBaseUrl(value: unknown): string {
	const candidate = String(value ?? "").trim();
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		throw new Error("Base URL must be a valid http:// or https:// URL.");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Base URL must use http:// or https://.");
	}
	if (parsed.username || parsed.password) {
		throw new Error("Credentials are not allowed in the Base URL.");
	}
	if (parsed.search || parsed.hash) {
		throw new Error("Base URL cannot contain a query string or fragment.");
	}
	return normalizeServerUrl(parsed.toString());
}

function normalizeProtocol(value: unknown): ApiRequestProtocol {
	return typeof value === "string" && PROTOCOLS.has(value as ApiRequestProtocol)
		? value as ApiRequestProtocol
		: "openai";
}

function normalizeFamily(value: unknown): ApiProviderFamily {
	return typeof value === "string" && FAMILIES.has(value as ApiProviderFamily)
		? value as ApiProviderFamily
		: "auto";
}

function normalizeContextLength(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_API_PROVIDER_CONTEXT;
	}
	return Math.max(
		API_PROVIDER_CONTEXT_MIN,
		Math.min(API_PROVIDER_CONTEXT_MAX, Math.round(parsed))
	);
}

function normalizeStoredProfile(value: unknown): ApiProviderProfile | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const id = normalizeId(record.id);
	if (!id) {
		return undefined;
	}
	try {
		const now = new Date().toISOString();
		return {
			id,
			name: normalizeName(record.name),
			baseUrl: normalizeBaseUrl(record.baseUrl),
			protocol: normalizeProtocol(record.protocol),
			family: normalizeFamily(record.family),
			contextLength: normalizeContextLength(record.contextLength),
			enabled: record.enabled !== false,
			createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
			updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now,
		};
	} catch {
		return undefined;
	}
}

export class ApiProviderService implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(
		private readonly state: vscode.Memento,
		private readonly secrets: vscode.SecretStorage
	) {}

	get count(): number {
		return this.list().length;
	}

	get enabledCount(): number {
		return this.list().filter(profile => profile.enabled).length;
	}

	private readonly balances = new Map<string, { info: ApiProviderBalanceInfo; fetchedAt: number }>();
	private readonly balanceInflight = new Map<string, Promise<ApiProviderBalanceInfo | undefined>>();

	/**
	 * Balance/usage info for a profile, fetched from provider-specific
	 * endpoints and cached for 60 seconds (like the DeepSeek balance).
	 */
	async getBalanceInfo(id: string): Promise<ApiProviderBalanceInfo | undefined> {
		const profile = this.get(id);
		if (!profile || !profile.enabled) {
			return undefined;
		}
		const cached = this.balances.get(id);
		if (cached && Date.now() - cached.fetchedAt < 60_000) {
			return cached.info;
		}
		const inFlight = this.balanceInflight.get(id);
		if (inFlight) {
			return inFlight;
		}
		const promise = (async () => {
			const apiKey = await this.getApiKey(id);
			if (!apiKey) {
				return undefined;
			}
			const info = await fetchApiProviderBalance(profile.baseUrl, apiKey);
			if (info) {
				this.balances.set(id, { info, fetchedAt: Date.now() });
			}
			return info;
		})();
		this.balanceInflight.set(id, promise);
		try {
			return await promise;
		} finally {
			this.balanceInflight.delete(id);
		}
	}

	/** Enabled profiles enriched with their (cached) balance info, for Quick Access. */
	async quickAccessApiProviders(): Promise<QuickAccessApiProvider[]> {
		const summaries = await this.listSummaries();
		return Promise.all(summaries
			.filter(profile => profile.enabled)
			.map(async profile => ({
				id: profile.id,
				name: profile.name,
				baseUrl: profile.baseUrl,
				protocol: profile.protocol,
				contextLength: profile.contextLength,
				enabled: profile.enabled,
				hasApiKey: profile.hasApiKey,
				balance: await this.getBalanceInfo(profile.id),
			})));
	}

	list(): ApiProviderProfile[] {
		const stored = this.state.get<unknown[]>(API_PROVIDER_STORAGE_KEY, []);
		if (!Array.isArray(stored)) {
			return [];
		}
		return stored
			.map(normalizeStoredProfile)
			.filter((profile): profile is ApiProviderProfile => profile !== undefined)
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	get(id: string): ApiProviderProfile | undefined {
		return this.list().find(profile => profile.id === id);
	}

	async listSummaries(): Promise<ApiProviderSummary[]> {
		const profiles = this.list();
		return Promise.all(profiles.map(async profile => ({
			...profile,
			hasApiKey: Boolean(await this.secrets.get(this.secretKey(profile.id))),
		})));
	}

	async getModelSources(): Promise<ChatModelSource[]> {
		const enabled = this.list().filter(profile => profile.enabled);
		return Promise.all(enabled.map(async profile => ({
			key: `api-${profile.id}`,
			label: profile.name,
			serverUrl: profile.baseUrl,
			apiKey: await this.secrets.get(this.secretKey(profile.id)),
			familyOverride: profile.family,
			contextLengthOverride: profile.contextLength,
			protocol: profile.protocol,
		})));
	}

	async upsert(
		draft: ApiProviderDraft,
		secretUpdate: ApiProviderSecretUpdate = {}
	): Promise<ApiProviderProfile> {
		const profiles = this.list();
		const requestedId = normalizeId(draft.id);
		const existingIndex = requestedId
			? profiles.findIndex(profile => profile.id === requestedId)
			: -1;
		if (requestedId && existingIndex < 0) {
			throw new Error("The API provider no longer exists. Refresh the manager and try again.");
		}
		const existing = existingIndex >= 0 ? profiles[existingIndex] : undefined;
		const now = new Date().toISOString();
		const profile: ApiProviderProfile = {
			id: existing?.id ?? randomUUID(),
			name: normalizeName(draft.name),
			baseUrl: normalizeBaseUrl(draft.baseUrl),
			protocol: normalizeProtocol(draft.protocol),
			family: normalizeFamily(draft.family),
			contextLength: normalizeContextLength(draft.contextLength),
			enabled: draft.enabled !== false,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};

		const duplicate = profiles.find(candidate =>
			candidate.id !== profile.id
			&& candidate.name.toLocaleLowerCase() === profile.name.toLocaleLowerCase()
		);
		if (duplicate) {
			throw new Error(`An API provider named "${profile.name}" already exists.`);
		}

		if (existingIndex >= 0) {
			profiles.splice(existingIndex, 1, profile);
		} else {
			profiles.push(profile);
		}
		await this.state.update(API_PROVIDER_STORAGE_KEY, profiles);

		const apiKey = secretUpdate.apiKey?.trim();
		if (apiKey) {
			await this.secrets.store(this.secretKey(profile.id), apiKey);
		} else if (secretUpdate.clearApiKey) {
			await this.secrets.delete(this.secretKey(profile.id));
		}
		this.balances.delete(profile.id);

		this._onDidChange.fire();
		return profile;
	}

	async setEnabled(id: string, enabled: boolean): Promise<void> {
		const profile = this.get(id);
		if (!profile) {
			throw new Error("The API provider no longer exists.");
		}
		await this.upsert({ ...profile, enabled });
	}

	async remove(id: string): Promise<boolean> {
		const profiles = this.list();
		const next = profiles.filter(profile => profile.id !== id);
		if (next.length === profiles.length) {
			return false;
		}
		await this.state.update(API_PROVIDER_STORAGE_KEY, next);
		await this.secrets.delete(this.secretKey(id));
		this.balances.delete(id);
		this._onDidChange.fire();
		return true;
	}

	dispose(): void {
		this._onDidChange.dispose();
	}

	private secretKey(id: string): string {
		return apiProviderSecretKey(id);
	}

	/** The saved API key for a profile, or undefined when none is stored. */
	async getApiKey(id: string): Promise<string | undefined> {
		return this.secrets.get(this.secretKey(id));
	}
}
