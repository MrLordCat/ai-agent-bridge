import * as assert from "node:assert";

import { fetchApiProviderBalance } from "../api-providers/balance";

interface FetchArgs {
        url: string;
        headers: Record<string, string>;
}

function stubFetch(responses: Record<string, unknown>): FetchArgs[] {
        const calls: FetchArgs[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
                const body = responses[url];
                return {
                        ok: body !== undefined,
                        status: body !== undefined ? 200 : 401,
                        json: async () => body ?? { error: { message: "Missing Authentication header" } },
                } as Response;
        }) as typeof fetch;
        return calls;
}

function restoreFetch(): void {
        delete (globalThis as { fetch?: unknown }).fetch;
}

suite("API provider balance", () => {
        test("openrouter /credits remaining balance", async () => {
                const calls = stubFetch({
                        "https://openrouter.ai/api/v1/credits": {
                                data: { total_credits: 100, total_usage: 12.5, is_free_tier: false, credits: 87.5 },
                        },
                });
                try {
                        const info = await fetchApiProviderBalance("https://openrouter.ai/api/v1", "sk-or-test");
                        assert.strictEqual(info?.summary, "$87.50 credits");
                        assert.match(info?.tooltip ?? "", /Total credits: \$100\.00/);
                        assert.match(info?.tooltip ?? "", /Usage: \$12\.50/);
                        assert.strictEqual(calls.length, 1);
                        assert.strictEqual(calls[0].url, "https://openrouter.ai/api/v1/credits");
                        assert.strictEqual(calls[0].headers.Authorization, "Bearer sk-or-test");
                } finally {
                        restoreFetch();
                }
        });

        test("openrouter free tier", async () => {
                stubFetch({
                        "https://openrouter.ai/api/v1/credits": {
                                data: { is_free_tier: true },
                        },
                });
                try {
                        const info = await fetchApiProviderBalance("https://openrouter.ai/api/v1", "sk-or-test");
                        assert.strictEqual(info?.summary, "Free tier");
                } finally {
                        restoreFetch();
                }
        });

        test("openrouter falls back to /auth/key when /credits lacks numbers", async () => {
                const calls = stubFetch({
                        "https://openrouter.ai/api/v1/credits": { data: { label: "x" } },
                        "https://openrouter.ai/api/v1/auth/key": {
                                data: { label: "My key", usage: 4.2, limit: 50, is_free_tier: false },
                        },
                });
                try {
                        const info = await fetchApiProviderBalance("https://openrouter.ai/api/v1", "sk-or-test");
                        assert.strictEqual(info?.summary, "$4.20 / $50.00");
                        assert.strictEqual(calls.length, 2);
                } finally {
                        restoreFetch();
                }
        });

        test("cloudflare has no public balance and returns n/a", async () => {
                const calls = stubFetch({});
                try {
                        const info = await fetchApiProviderBalance(
                                "https://api.cloudflare.com/client/v4/accounts/abc/ai/v1",
                                "cfut-test"
                        );
                        assert.strictEqual(info?.summary, "n/a");
                        assert.match(info?.tooltip ?? "", /no public balance API/i);
                        assert.strictEqual(calls.length, 0, "cloudflare must not hit any endpoint");
                } finally {
                        restoreFetch();
                }
        });

        test("unknown hosts and missing keys return undefined", async () => {
                const calls = stubFetch({});
                try {
                        const info = await fetchApiProviderBalance("https://api.example.com/v1", "sk-test");
                        assert.strictEqual(info, undefined);
                        assert.strictEqual(await fetchApiProviderBalance("https://openrouter.ai/api/v1", ""), undefined);
                        assert.strictEqual(calls.length, 0);
                } finally {
                        restoreFetch();
                }
        });
});