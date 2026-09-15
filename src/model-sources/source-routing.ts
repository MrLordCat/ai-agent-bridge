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

/**
 * Whether a DeepSeek model id accepts image input (OpenAI `image_url` blocks).
 *
 * DeepSeek's `GET /models` returns only `{id, object, owned_by}`, so vision
 * cannot be read from the catalog and must be derived from the model id.
 *
 * Verified 2026-09-15 against https://api-docs.deepseek.com/quick_start/pricing
 * (Models & Pricing), which lists Vision for `deepseek-flash` and
 * "Not supported" for `deepseek-v4-pro`. The legacy names `deepseek-v4-flash`
 * and `deepseek-v4-flash-vision-exp` are retired but still accepted, and their
 * requests are served by the DeepSeek-V4.1-Flash model that accepts images
 * (https://api-docs.deepseek.com/guides/vision).
 *
 * The Flash family is vision-capable; Pro, chat, and reasoner are not.
 */
export function isDeepSeekVisionModel(modelId: string): boolean {
	const id = modelId.trim().toLowerCase();
	if (!id) {
		return false;
	}
	// Explicit opt-out for ids that name the non-vision Pro tier.
	if (/(?:^|[-_/])pro(?:[-_/]|$)/.test(id)) {
		return false;
	}
	return /vision/i.test(id) || /(?:^|[-_/])flash(?:[-_/]|$)/.test(id);
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

	// The primary source represents the local llama.cpp server by default.
	// When localEnabled is false, skip it unless the primary URL is a DeepSeek
	// endpoint (which has its own dedicated source below).
	if (configuration.localEnabled || primaryIsDeepSeek) {
		addSource({
			key: primaryIsDeepSeek ? "deepseek" : "primary",
			label: primaryIsDeepSeek ? "DeepSeek" : "Primary",
			serverUrl: configuration.primaryServerUrl,
			apiKey: primaryIsDeepSeek ? configuration.deepSeekApiKey : configuration.primaryApiKey,
			familyOverride: primaryIsDeepSeek ? "deepseek" : undefined,
			contextLengthOverride: primaryIsDeepSeek ? configuration.deepSeekContextLength : undefined,
			protocol: primaryIsDeepSeek ? "deepseek" : "llamacpp",
		});
	}

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
