import * as assert from "node:assert";

import { buildApiProfileItem } from "../ui/quick-access";
import type { QuickAccessApiProvider } from "../api-providers/api-provider-service";

function profile(overrides: Partial<QuickAccessApiProvider> = {}): QuickAccessApiProvider {
        return {
                id: "cf-1",
                name: "Cloud",
                baseUrl: "https://api.cloudflare.com/client/v4/accounts/abc/ai/v1",
                protocol: "openai",
                contextLength: 131_072,
                enabled: true,
                hasApiKey: true,
                ...overrides,
        };
}

suite("Quick Access API provider roots", () => {
        test("enabled profile renders a root with balance, context and management", () => {
                const item = buildApiProfileItem(profile({
                        balance: { summary: "n/a", tooltip: "Cloudflare has no public balance API." },
                }), "online");
                assert.strictEqual(item.label, "Cloud");
                const labels = (item.children ?? []).map(child => child.label);
                assert.ok(labels.includes("Balance"), `children: ${labels.join(", ")}`);
                assert.ok(labels.includes("Maximum Context"));
                assert.ok(labels.includes("Providers Manager"));
                const balance = (item.children ?? []).find(child => child.label === "Balance");
                assert.strictEqual(balance?.description, "n/a");
                const context = (item.children ?? []).find(child => child.label === "Maximum Context");
                assert.strictEqual(context?.description, "131.1K");
        });

        test("offline profile is labeled offline; no-key profile shows the hint", () => {
                const offline = buildApiProfileItem(profile({ balance: undefined }), "offline");
                assert.strictEqual(offline.description, "Offline");
                const labels = (offline.children ?? []).map(child => child.label);
                assert.ok(!labels.includes("Balance"), "no balance row without balance info");
                const noKey = buildApiProfileItem(profile({ hasApiKey: false }), "online");
                assert.strictEqual(noKey.description, "No API key");
        });
});