import * as assert from "node:assert";

import { renderApiProviderManagerHtml } from "../ui/api-provider-manager";

suite("API provider manager", () => {
	test("renders safe profile metadata and never requests stored key material", () => {
		const html = renderApiProviderManagerHtml({
			editingId: "provider-123456",
			providers: [],
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
		const html = renderApiProviderManagerHtml({ profiles: [], providers: [] });
		assert.match(html, /No custom API providers yet/);
		assert.match(html, /Add provider/);
		assert.match(html, /Refresh models/);
	});

	test("renders built-in provider controls with real command actions", () => {
		const html = renderApiProviderManagerHtml({
			profiles: [],
			providers: [
				{ key: "local", kind: "local", label: "Local LLM", state: "offline", detail: "http://localhost:8000/v1/models: connect ECONNREFUSED" },
				{ key: "deepseek", kind: "deepseek", label: "DeepSeek", state: "online", detail: "Reachable at https://api.deepseek.com/v1/models." },
				{ key: "codex", kind: "codex", label: "Codex", state: "online", detail: "Connected" },
				{ key: "claude", kind: "claude", label: "Claude", state: "paused", detail: "Paused at usage limit" },
			],
			extras: {
				local: { enabled: true, endpoint: "http://localhost:8000" },
				deepSeek: {
					enabled: true,
					compactionSummary: false,
					balance: "$1.23",
					peakHours: "Off-peak · ½ price · next peak 01:00 (local)",
				},
				codex: {
					enabled: true,
					summary: "Connected (Plus)",
					usagePercent: 42,
					usageReset: "in 2h",
				},
				claude: {
					enabled: true,
					summary: "Connected (Max)",
					limits: [{ label: "Session Limit (5h)", description: "2h 10m / 5h" }],
				},
			},
		});

		assert.match(html, /Built-in providers/);
		assert.match(html, /Local LLM/);
		assert.match(html, /Offline/);
		assert.match(html, /data-command="llamacpp.toggleLocalServer"/);
		assert.match(html, /data-command="llamacpp.setLocalServerUrl"/);
		assert.match(html, /data-command="llamacpp.configureDeepSeek"/);
		assert.match(html, /data-command="llamacpp.openContextControl"/);
		assert.match(html, /data-command="llamacpp.toggleDeepSeekCompactionSummary"/);
		assert.match(html, /balance \$1.23/);
		assert.match(html, /Off-peak · ½ price/);
		assert.match(html, /data-command="llamacpp.codexSignIn"/);
		assert.match(html, /data-command="llamacpp.codexShowStatus"/);
		assert.match(html, /42% used · resets in 2h/);
		assert.match(html, /data-command="llamacpp.claudeSignIn"/);
		assert.match(html, /data-command="llamacpp.claudeShowStatus"/);
		assert.match(html, /data-command="llamacpp.toggleClaudeSubscription"/);
		assert.match(html, /data-command="llamacpp.toggleCodexSubscription"/);
		assert.match(html, /Paused/);
	});

	test("escapes hostile profile metadata in built-in controls", () => {
		const html = renderApiProviderManagerHtml({
			profiles: [],
			providers: [],
			extras: {
				local: { enabled: true, endpoint: 'http://evil"><script>alert(1)</script>' },
			},
		});
		assert.ok(!html.includes('<script>alert(1)</script>'));
		assert.match(html, /&lt;script&gt;/);
	});
});
