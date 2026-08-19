import {
        getOpenAiApiRoot,
        isCloudflareWorkersAiBase,
} from "../transport/openai-http";

/**
 * Human-readable balance/usage info for a custom API provider, fetched from
 * provider-specific endpoints:
 *  - OpenRouter: GET {base}/credits (fallback {base}/auth/key) returns the
 *    remaining credits / usage for the API key.
 *  - Cloudflare Workers AI: no public balance API exists — the account
 *    billing is only visible in the dashboard, so the row shows "n/a" with
 *    an explanation instead of a fake number.
 *  - Other OpenAI-compatible hosts: no balance endpoint, returns undefined
 *    (the row is hidden).
 */
export interface ApiProviderBalanceInfo {
        summary: string;
        tooltip: string;
}

interface BalanceJson {
        data?: {
                total_credits?: unknown;
                total_usage?: unknown;
                credits?: unknown;
                usage?: unknown;
                limit?: unknown;
                is_free_tier?: unknown;
                label?: unknown;
        };
}

function toNumber(value: unknown): number | undefined {
        return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatCredits(value: number): string {
        return `$${value.toFixed(2)}`;
}

async function fetchBalanceJson(endpoint: string, apiKey: string): Promise<BalanceJson | undefined> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        try {
                const response = await fetch(endpoint, {
                        method: "GET",
                        headers: {
                                Authorization: `Bearer ${apiKey}`,
                                Accept: "application/json",
                        },
                        signal: controller.signal,
                });
                if (!response.ok) {
                        return undefined;
                }
                const body = (await response.json()) as BalanceJson;
                return body && typeof body === "object" ? body : undefined;
        } catch {
                return undefined;
        } finally {
                clearTimeout(timer);
        }
}

async function fetchOpenRouterBalance(root: string, apiKey: string): Promise<ApiProviderBalanceInfo | undefined> {
        // Preferred: GET /api/v1/credits — { data: { total_credits, total_usage, is_free_tier, credits } }
        const credits = await fetchBalanceJson(`${root}/credits`, apiKey);
        const creditsData = credits?.data;
        if (creditsData && typeof creditsData === "object") {
                if (creditsData.is_free_tier === true) {
                        return {
                                summary: "Free tier",
                                tooltip: "OpenRouter free tier — no prepaid credits; requests are billed to the free quota.",
                        };
                }
                const remaining = toNumber(creditsData.credits)
                        ?? (toNumber(creditsData.total_credits) !== undefined && toNumber(creditsData.total_usage) !== undefined
                                ? toNumber(creditsData.total_credits)! - toNumber(creditsData.total_usage)!
                                : undefined);
                if (remaining !== undefined) {
                        const usage = toNumber(creditsData.total_usage);
                        return {
                                summary: `${formatCredits(remaining)} credits`,
                                tooltip: `OpenRouter account balance for this key.\nTotal credits: ${toNumber(creditsData.total_credits) !== undefined ? formatCredits(toNumber(creditsData.total_credits)!) : "n/a"}${usage !== undefined ? `\nUsage: ${formatCredits(usage)}` : ""}`,
                        };
                }
        }

        // Fallback: GET /api/v1/auth/key — { data: { label, usage, limit, is_free_tier } }
        const keyInfo = await fetchBalanceJson(`${root}/auth/key`, apiKey);
        const keyData = keyInfo?.data;
        if (keyData && typeof keyData === "object") {
                if (keyData.is_free_tier === true) {
                        return {
                                summary: "Free tier",
                                tooltip: "OpenRouter free tier — no prepaid credits; requests are billed to the free quota.",
                        };
                }
                const usage = toNumber(keyData.usage);
                const limit = toNumber(keyData.limit);
                if (usage !== undefined && limit !== undefined) {
                        return {
                                summary: `${formatCredits(usage)} / ${formatCredits(limit)}`,
                                tooltip: "OpenRouter usage vs. the key's credit limit.",
                        };
                }
                if (usage !== undefined) {
                        return {
                                summary: `${formatCredits(usage)} used`,
                                tooltip: "OpenRouter usage reported for this key.",
                        };
                }
        }
        return undefined;
}

export async function fetchApiProviderBalance(
        baseUrl: string,
        apiKey: string
): Promise<ApiProviderBalanceInfo | undefined> {
        try {
                if (!apiKey) {
                        return undefined;
                }
                if (isCloudflareWorkersAiBase(baseUrl)) {
                        return {
                                summary: "n/a",
                                tooltip: "Cloudflare Workers AI has no public balance API.\nBilling and included usage are shown in the dashboard: dash.cloudflare.com → Billing → Usage.",
                        };
                }
                const root = getOpenAiApiRoot(baseUrl);
                const host = new URL(root).hostname;
                if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) {
                        return await fetchOpenRouterBalance(root, apiKey);
                }
                return undefined;
        } catch {
                return undefined;
        }
}