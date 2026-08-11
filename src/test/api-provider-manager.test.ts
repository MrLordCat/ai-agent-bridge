import * as assert from "node:assert";

import { renderApiProviderManagerHtml } from "../ui/api-provider-manager";

suite("API provider manager", () => {
	test("renders safe profile metadata and never requests stored key material", () => {
		const html = renderApiProviderManagerHtml({
			editingId: "provider-123456",
			profiles: [{
				id: "provider-123456",
				name: "Gateway <prod>",
				baseUrl: "https://gateway.example/v1",
				protocol: "openai",
				family: "deepseek",
				contextLength: 262_144,
				enabled: true,
				createdAt: "2026-08-09T00:00:00.000Z",
				updatedAt: "2026-08-09T00:00:00.000Z",
				hasApiKey: true,
			}],
		});

		assert.match(html, /Gateway &lt;prod&gt;/);
		assert.match(html, /Saved — leave blank to keep/);
		assert.match(html, /VS Code SecretStorage/);
		assert.match(html, /Content-Security-Policy/);
		assert.ok(!html.includes("apiKeyValue"));
	});

	test("shows an empty state and add action", () => {
		const html = renderApiProviderManagerHtml({ profiles: [] });
		assert.match(html, /No custom API providers yet/);
		assert.match(html, /Add provider/);
		assert.match(html, /Refresh models/);
	});
});
