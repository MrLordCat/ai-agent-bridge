import * as assert from "node:assert";
import { modelInformation, resolveModelLimits } from "../providers/model-descriptor";
import { providerSnapshots, providerUsageSummary } from "../providers/provider-snapshot";
import { providerSourceId } from "../providers/provider-registry";
import { resolveSubscriptionState } from "../providers/provider-directory";
import { usageProviderForSource } from "../token-usage-history";
import { buildProviderSnapshotItem } from "../ui/quick-access";

suite("Provider descriptor contracts", () => {
	test("preserves ids and capabilities while bounding context and output", () => {
		const info = modelInformation({ id: "api-one::deepseek-chat", name: "Model", family: "deepseek", version: "1", contextWindowTokens: 1_000_000, workingContextTokens: 500_000, outputTokens: 32_768, contextOrigin: "reported", capabilities: { toolCalling: false, imageInput: true } });
		assert.strictEqual(info.id, "api-one::deepseek-chat"); assert.strictEqual(info.sourceId, "api-one");
		assert.strictEqual(info.maxInputTokens + info.maxOutputTokens, 500_000); assert.strictEqual(info.capabilities.toolCalling, false);
		assert.strictEqual(resolveModelLimits(1000, 2000).maxInputTokens, 1);
		assert.throws(() => resolveModelLimits(NaN, 100), /Invalid model/);
	});
	test("attributes API-family metrics to their source instead of Local or DeepSeek", () => {
		const source = providerSourceId("api-one::deepseek-chat"); assert.strictEqual(source, "api-one"); assert.strictEqual(usageProviderForSource(source), "api");
		const snapshots = providerSnapshots([{ key: source, kind: "api", label: "My API", state: "online", detail: "Ready" }], new Map([[source, { inputTokens: 123 }], ["local", { inputTokens: 9 }]]));
		assert.strictEqual(snapshots.get(source)?.metrics?.inputTokens, 123); assert.strictEqual(buildProviderSnapshotItem(snapshots.get(source)!).label, "My API");
	});
	test("keeps monthly usage and a spending cap distinct in presentation", () => {
		assert.strictEqual(providerUsageSummary({ kind: "monthlyUsage", currency: "USD", used: 0.69, limit: 300, origin: "dashboard" }), "$0.69 / $300.00");
		assert.strictEqual(providerUsageSummary({ kind: "spendingCap", currency: "USD", used: 0.69, limit: 300, origin: "Admin API" }), "$299.31 left");
	});
	test("uses typed pause state independently of summary language", () => {
		assert.strictEqual(resolveSubscriptionState({ state: "connected", summary: "Приостановлено", paused: true }).state, "paused");
		assert.strictEqual(resolveSubscriptionState({ state: "connected", summary: "Paused is a label", paused: false }).state, "online");
	});
});