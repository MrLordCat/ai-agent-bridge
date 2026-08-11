import {
	DEEPSEEK_SERVER_URL,
	DEFAULT_SERVER_URL,
} from "../constants";
import { isDeepSeekEndpoint } from "../transport/openai-http";

const MODEL_SOURCE_SEPARATOR = "::";

export type ApiRequestProtocol = "openai" | "deepseek" | "llamacpp";

export interface ChatModelSource {
	key: string;
	label: string;
	serverUrl: string;
	apiKey?: string;
	familyOverride?: string;
	contextLengthOverride?: number;
	contextLengthFallback?: number;
	protocol?: ApiRequestProtocol;
}

export interface LlamaCppModelInfo {
	id: string;
	aliases?: string[];
	contextLength?: number;
	capabilities?: string[];
	modalities?: {
		vision?: boolean;
		audio?: boolean;
	};
	meta?: {
		n_ctx_train?: number;
		[key: string]: unknown;
	};
}

export interface ModelSourceConfiguration {
	primaryServerUrl: string;
	primaryApiKey?: string;
	deepSeekApiKey?: string;
	localEnabled: boolean;
	localServerUrl: string;
	localContextLength: number;
	deepSeekEnabled: boolean;
	deepSeekContextLength: number;
	apiSources?: readonly ChatModelSource[];
}

export function normalizeServerUrl(serverUrl: string): string {
	const normalized = serverUrl.trim().replace(/\/+$/, "");
	return normalized || DEFAULT_SERVER_URL;
}

export function encodeProviderModelId(sourceKey: string, modelId: string): string {
	return `${sourceKey}${MODEL_SOURCE_SEPARATOR}${modelId}`;
}

export function parseProviderModelId(providerModelId: string): { sourceKey?: string; modelId: string } {
	const separatorIndex = providerModelId.indexOf(MODEL_SOURCE_SEPARATOR);
	if (separatorIndex <= 0) {
		return { modelId: providerModelId };
	}
	return {
		sourceKey: providerModelId.slice(0, separatorIndex),
		modelId: providerModelId.slice(separatorIndex + MODEL_SOURCE_SEPARATOR.length),
	};
}

export function inferModelFamily(modelId: string): string {
	const lower = modelId.toLowerCase();
	if (lower.includes("deepseek")) {
		return "deepseek";
	}
	if (/\b(?:gpt|openai|o[134](?:\b|-))/.test(lower)) {
		return "openai";
	}
	if (lower.includes("qwen")) {
		return "qwen";
	}
	if (lower.includes("mistral") || lower.includes("mixtral")) {
		return "mistral";
	}
	if (lower.includes("gemma")) {
		return "gemma";
	}
	if (lower.includes("phi")) {
		return "phi";
	}
	if (lower.includes("llama")) {
		return "llama";
	}
	return "llama";
}

export function resolveModelFamily(modelId: string, familyOverride: string | undefined, configuredFamily: string): string {
	const candidate = familyOverride ?? configuredFamily;
	const normalized = candidate.trim().toLowerCase();
	return normalized && normalized !== "auto" ? normalized : inferModelFamily(modelId);
}

export function createModelSources(configuration: ModelSourceConfiguration): ChatModelSource[] {
	const sources: ChatModelSource[] = [];
	const seenUrls = new Set<string>();
	const seenKeys = new Set<string>();
	const addSource = (source: ChatModelSource, deduplicateUrl = true): void => {
		const serverUrl = normalizeServerUrl(source.serverUrl);
		const urlKey = serverUrl.toLowerCase();
		if (seenKeys.has(source.key) || (deduplicateUrl && seenUrls.has(urlKey))) {
			return;
		}
		seenKeys.add(source.key);
		if (deduplicateUrl) {
			seenUrls.add(urlKey);
		}
		sources.push({ ...source, serverUrl });
	};
	const primaryIsDeepSeek = isDeepSeekEndpoint(configuration.primaryServerUrl);

	addSource({
		key: primaryIsDeepSeek ? "deepseek" : "primary",
		label: primaryIsDeepSeek ? "DeepSeek" : "Primary",
		serverUrl: configuration.primaryServerUrl,
		apiKey: primaryIsDeepSeek ? configuration.deepSeekApiKey : configuration.primaryApiKey,
		familyOverride: primaryIsDeepSeek ? "deepseek" : undefined,
		contextLengthOverride: primaryIsDeepSeek ? configuration.deepSeekContextLength : undefined,
		protocol: primaryIsDeepSeek ? "deepseek" : "llamacpp",
	});

	if (configuration.localEnabled) {
		addSource({
			key: "local",
			label: "Local",
			serverUrl: configuration.localServerUrl,
			familyOverride: "auto",
			contextLengthFallback: configuration.localContextLength,
			protocol: "llamacpp",
		});
	}

	if (configuration.deepSeekEnabled && configuration.deepSeekApiKey) {
		addSource({
			key: "deepseek",
			label: "DeepSeek",
			serverUrl: DEEPSEEK_SERVER_URL,
			apiKey: configuration.deepSeekApiKey,
			familyOverride: "deepseek",
			contextLengthOverride: configuration.deepSeekContextLength,
			protocol: "deepseek",
		});
	}

	for (const source of configuration.apiSources ?? []) {
		// API profiles are identity-based rather than URL-based. Two accounts may
		// intentionally use the same gateway with different credentials/catalogs.
		addSource(source, false);
	}

	return sources;
}
