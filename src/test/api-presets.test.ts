import * as assert from "node:assert";

import {
        API_PROVIDER_PRESETS,
        findPreset,
        presetToDraft,
} from "../api-providers/presets";
import {
        getChatCompletionsEndpoint,
        getModelsEndpoint,
        isCloudflareWorkersAiBase,
} from "../transport/openai-http";

suite("API provider presets", () => {
        test("preset ids are unique and resolve through findPreset/presetToDraft", () => {
                const ids = API_PROVIDER_PRESETS.map(preset => preset.id);
                assert.strictEqual(new Set(ids).size, ids.length, "preset ids must be unique");
                for (const preset of API_PROVIDER_PRESETS) {
                        assert.ok(preset.label.trim().length > 0, `${preset.id}: label`);
                        assert.ok(preset.baseUrl.startsWith("https://"), `${preset.id}: https baseUrl`);
                        assert.ok(preset.keyLabel.trim().length > 0, `${preset.id}: keyLabel`);
                        assert.strictEqual(findPreset(preset.id), preset);
                        const draft = presetToDraft(preset);
                        assert.strictEqual(draft.baseUrl, preset.baseUrl);
                        assert.strictEqual(draft.protocol, preset.protocol);
                        assert.strictEqual(draft.family, preset.family);
                }
        });

        test("OpenRouter preset resolves to the OpenAI-compatible endpoints", () => {
                const preset = findPreset("openrouter");
                assert.ok(preset);
                assert.strictEqual(
                        getModelsEndpoint(preset.baseUrl),
                        "https://openrouter.ai/api/v1/models"
                );
                assert.strictEqual(
                        getChatCompletionsEndpoint(preset.baseUrl),
                        "https://openrouter.ai/api/v1/chat/completions"
                );
        });

        test("Cloudflare preset routes probing and catalog to /ai/models/search", () => {
                const preset = findPreset("cloudflare");
                assert.ok(preset);
                assert.strictEqual(isCloudflareWorkersAiBase(preset.baseUrl), true);
                assert.strictEqual(
                        getModelsEndpoint(preset.baseUrl),
                        "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/models/search?per_page=100"
                );
                assert.strictEqual(
                        getChatCompletionsEndpoint(preset.baseUrl),
                        "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions"
                );
        });

        test("DeepSeek and OpenAI presets keep their base URL roots", () => {
                const deepseek = findPreset("deepseek");
                assert.ok(deepseek);
                assert.strictEqual(
                        getChatCompletionsEndpoint(deepseek.baseUrl),
                        "https://api.deepseek.com/chat/completions"
                );
                const openai = findPreset("openai");
                assert.ok(openai);
                assert.strictEqual(
                        getModelsEndpoint(openai.baseUrl),
                        "https://api.openai.com/v1/models"
                );
        });
});
