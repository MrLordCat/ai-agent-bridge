import type { ApiProviderDraft } from "./api-provider-service";

/**
 * Ready-made provider profiles. Selecting a preset in the Providers Manager
 * form fills baseUrl/protocol/family/contextLength and shows the key/notes
 * hints. Presets account for provider-specific quirks:
 *  - Cloudflare Workers AI has no OpenAI-style GET /models (HTTP 405) — the
 *    catalog is read from /ai/models/search (see getModelsEndpoint in
 *    ../transport/openai-http).
 *  - OpenRouter/OpenAI use a versioned base URL so /v1 is not appended twice.
 */
export interface ApiProviderPreset {
        id: string;
        label: string;
        description: string;
        baseUrl: string;
        protocol: "openai" | "deepseek" | "llamacpp";
        family: "auto" | "openai" | "deepseek" | "qwen" | "llama" | "mistral" | "gemma" | "phi";
        contextLength: number;
        keyLabel: string;
        notes: string;
}

export const API_PROVIDER_PRESETS: ApiProviderPreset[] = [
        {
                id: "openrouter",
                label: "OpenRouter",
                description: "One key for many models (DeepSeek, Claude, Llama, …)",
                baseUrl: "https://openrouter.ai/api/v1",
                protocol: "openai",
                family: "auto",
                contextLength: 131_072,
                keyLabel: "OpenRouter API key (sk-or-v1-…)",
                notes: "Model ids look like deepseek/deepseek-chat or anthropic/claude-sonnet-4-5. The optional HTTP-Referer and X-Title headers are not required.",
        },
        {
                id: "cloudflare",
                label: "Cloudflare Workers AI",
                description: "Cloudflare REST API with AI Gateway features (logging, caching, rate limits)",
                baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
                protocol: "openai",
                family: "auto",
                contextLength: 131_072,
                keyLabel: "Cloudflare API token (Account > Workers AI > Read)",
                notes: "Replace {account_id} with your Cloudflare account id. Model ids look like openai/gpt-4.1 or @cf/meta/llama-3.1-8b-instruct. The model catalog is loaded from /ai/models/search automatically. Requests route through your default AI Gateway; to pick a specific one, add the cf-aig-gateway-id header.",
        },
        {
                id: "deepseek",
                label: "DeepSeek",
                description: "Official DeepSeek API",
                baseUrl: "https://api.deepseek.com",
                protocol: "deepseek",
                family: "deepseek",
                contextLength: 131_072,
                keyLabel: "DeepSeek API key (sk-…)",
                notes: "Uses the DeepSeek-native request shape. When the dedicated DeepSeek key is set here, the balance shows in Quick Access.",
        },
        {
                id: "openai",
                label: "OpenAI",
                description: "Official OpenAI API",
                baseUrl: "https://api.openai.com/v1",
                protocol: "openai",
                family: "openai",
                contextLength: 131_072,
                keyLabel: "OpenAI API key (sk-proj-…)",
                notes: "Context length varies per model; adjust it after the catalog loads.",
        },
];

export function findPreset(id: string): ApiProviderPreset | undefined {
        return API_PROVIDER_PRESETS.find(preset => preset.id === id);
}

/** Builds a draft from a preset id. */
export function presetToDraft(preset: ApiProviderPreset): ApiProviderDraft {
        return {
                name: preset.label,
                baseUrl: preset.baseUrl,
                protocol: preset.protocol,
                family: preset.family,
                contextLength: preset.contextLength,
                enabled: true,
        };
}
