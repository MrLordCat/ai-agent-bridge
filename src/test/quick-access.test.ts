import * as assert from "assert";
import * as vscode from "vscode";

import {
	formatEndpointLabel,
	formatProviderUsageLine,
	LlamaQuickActionsProvider,
	type QuickAccessItem,
} from "../ui/quick-access";
import { resolveContextControlState } from "../ui/context-control";
import { emptyTokenUsageAggregate, emptyTokenUsageHistorySummary } from "../token-usage-history";
import { emptyUsageExperimentSummary } from "../usage-experiment";

function labelOf(item: QuickAccessItem): string {
	return typeof item.label === "string" ? item.label : item.label?.label ?? "";
}

async function getItems(
	provider: LlamaQuickActionsProvider,
	parent?: QuickAccessItem
): Promise<QuickAccessItem[]> {
	const result = await Promise.resolve(provider.getChildren(parent));
	return result ?? [];
}

suite("quick access", () => {
	test("formats endpoint labels without protocol noise", () => {
		assert.strictEqual(formatEndpointLabel("http://localhost:8000"), "localhost:8000");
		assert.strictEqual(formatEndpointLabel("https://api.deepseek.com/v1/"), "api.deepseek.com/v1");
		assert.strictEqual(formatEndpointLabel("not a URL"), "not a URL");
	});

	test("uses stable provider and settings groups instead of a flat command list", async () => {
		const provider = new LlamaQuickActionsProvider(
			() => "24.5 tok/s",
			() => ({ summary: "61.0% (30,000/49,152)", breakdown: "msg 20,000 + tools 2,000 + reserved 8,000" }),
			() => 3
		);
		const root = await getItems(provider);

		assert.deepStrictEqual(
			root.map(labelOf),
			["Local LLM", "DeepSeek", "Codex", "Claude", "Token Usage", "Usage Experiments", "Subagents", "Model Behavior", "Memory", "Diagnostics", "Copilot Patches"]
		);
		assert.ok(root.every(item => item.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed));
		assert.ok(root.every(item => item.id?.startsWith("llamacpp.quickAccess.")));
	});

	test("keeps detailed diagnostics inside the collapsed group", async () => {
		const provider = new LlamaQuickActionsProvider(
			() => "24.5 tok/s",
			() => ({ summary: "61.0%", breakdown: "msg 20K + tools 2K + reserved 8K" }),
			() => 0,
			() => "75.0% (75/100)",
			() => "4 turns / cache 75%",
		);
		const diagnostics = (await getItems(provider)).find(item => labelOf(item) === "Diagnostics");
		assert.ok(diagnostics);

		const children = await getItems(provider, diagnostics);
		assert.ok(children.some(item => labelOf(item) === "Throughput"));
		assert.ok(children.some(item => labelOf(item) === "Context Usage"));
		assert.ok(!children.some(item => labelOf(item) === "Prompt Cache"));
		const usage = (await getItems(provider)).find(item => labelOf(item) === "Token Usage");
		assert.ok(String(usage?.tooltip).includes("Last local cache snapshot: 75.0% (75/100)"));
		assert.strictEqual(children.find(item => labelOf(item) === "Live Report")?.description, "4 turns / cache 75%");
		assert.strictEqual(
			children.find(item => labelOf(item) === "Live Report")?.command?.command,
			"llamacpp.openSessionReport"
		);
		assert.ok(!children.some(item => labelOf(item) === "Context Breakdown"));
		assert.ok(!children.some(item => labelOf(item) === "Run Health Check"));
		assert.strictEqual(
			children.find(item => labelOf(item) === "Context Usage")?.tooltip,
			"msg 20K + tools 2K + reserved 8K"
		);
	});

	test("exposes knowledge verification with the other model controls", async () => {
		const provider = new LlamaQuickActionsProvider(() => undefined, () => undefined, () => 0);
		const modelBehavior = (await getItems(provider)).find(item => labelOf(item) === "Model Behavior");
		assert.ok(modelBehavior);

		const children = await getItems(provider, modelBehavior);
		const knowledge = children.find(item => labelOf(item) === "Knowledge Verification");
		assert.ok(knowledge);
		assert.strictEqual(knowledge.command?.command, "llamacpp.setKnowledgeMode");
	});

	test("shows expired memory separately with estimated context tokens", async () => {
		const provider = new LlamaQuickActionsProvider(
			() => undefined,
			() => undefined,
			() => 5,
			() => undefined,
			() => undefined,
			() => 2,
			() => undefined,
			() => undefined,
			() => undefined,
			() => undefined,
			() => [],
			() => undefined,
			() => undefined,
			() => undefined,
			() => undefined,
			() => undefined,
			() => [],
			() => emptyTokenUsageHistorySummary(),
			() => emptyUsageExperimentSummary(),
			() => undefined,
			() => undefined,
			() => undefined,
			() => undefined,
			() => undefined,
			() => 5000
		);
		const memory = (await getItems(provider)).find(item => labelOf(item) === "Memory");
		assert.strictEqual(memory?.description, "5 entries / 2 expired · ~5.0K tokens context");
	});

	test("shows separate Claude subscription limit windows", async () => {
		const provider = new LlamaQuickActionsProvider(
			() => undefined,
			() => undefined,
			() => 0,
			() => undefined,
			() => undefined,
			() => 0,
			() => undefined,
			() => "Connected (Max)",
			() => undefined,
			() => undefined,
			() => [
				{ id: "fiveHour", label: "Session Limit (5h)", description: "42% used" },
				{ id: "sevenDay", label: "Weekly Limit", description: "87% used" },
				{ id: "sevenDayOpus", label: "Weekly Opus Limit", description: "12% used" },
			]
		);
		const claude = (await getItems(provider)).find(item => labelOf(item) === "Claude");
		assert.ok(claude);

		const children = await getItems(provider, claude);
		const limits = children.find(item => labelOf(item) === "Subscription Limits");
		assert.ok(limits);
		assert.ok(String(limits.description).includes("5h: 42% used"));
		const limitChildren = await getItems(provider, limits);
		assert.strictEqual(limitChildren.find(item => labelOf(item) === "Session Limit (5h)")?.description, "42% used");
		assert.strictEqual(limitChildren.find(item => labelOf(item) === "Weekly Limit")?.description, "87% used");
		assert.strictEqual(limitChildren.find(item => labelOf(item) === "Weekly Opus Limit")?.description, "12% used");
	});

	test("opens provider context sliders from Claude and Codex quick access", async () => {
		const provider = new LlamaQuickActionsProvider(() => undefined, () => undefined, () => 0);
		const roots = await getItems(provider);
		const deepSeek = roots.find(item => labelOf(item) === "DeepSeek");
		const claude = roots.find(item => labelOf(item) === "Claude");
		const codex = roots.find(item => labelOf(item) === "Codex");
		const local = roots.find(item => labelOf(item) === "Local LLM");
		assert.ok(deepSeek && claude && codex && local);

		const deepSeekLimit = (await getItems(provider, deepSeek)).find(item => labelOf(item) === "Maximum Context");
		const deepSeekOutput = (await getItems(provider, deepSeek)).find(item => labelOf(item) === "Max Output");
		const claudeLimit = (await getItems(provider, claude)).find(item => labelOf(item) === "Maximum Context");
		assert.strictEqual(deepSeekLimit?.description, "258.4K");
		assert.strictEqual(deepSeekLimit?.command?.command, "llamacpp.openContextControl");
		assert.strictEqual(deepSeekOutput?.description, "70.0K");
		assert.strictEqual(deepSeekOutput?.command?.command, "llamacpp.openContextControl");
		assert.strictEqual(claudeLimit?.description, "258.4K target / 1M max");
		assert.strictEqual(claudeLimit?.command?.command, "llamacpp.openContextControl");
		const codexTarget = (await getItems(provider, codex)).find(item => labelOf(item) === "Working Context");
		assert.strictEqual(codexTarget?.description, "258.4K target");
		assert.strictEqual(codexTarget?.command?.command, "llamacpp.openContextControl");
		assert.ok(!(await getItems(provider, local)).some(item => labelOf(item) === "Maximum Context"));
	});

	test("shows live usage limits and DeepSeek balance near the providers", async () => {
		const provider = new LlamaQuickActionsProvider(
			() => undefined, () => undefined, () => 0,
			() => undefined, () => undefined, () => 0,
			() => "Connected (Max)", () => "Connected (Pro)",
			() => undefined, () => undefined, () => [],
			() => undefined, () => undefined, () => undefined, () => undefined,
			() => "87% used / resets 2.08 14:00",
			() => [], () => emptyTokenUsageHistorySummary(), () => emptyUsageExperimentSummary(),
			() => "110.00 CNY",
			() => 87,
			() => "2.08 14:00",
			() => 20,
			() => "7.08 21:45"
		);
		const roots = await getItems(provider);
		const deepSeek = roots.find(item => labelOf(item) === "DeepSeek");
		const codex = roots.find(item => labelOf(item) === "Codex");
		const claude = roots.find(item => labelOf(item) === "Claude");
		assert.ok(deepSeek && codex && claude);

		// The usage limit and reset time are visible directly on the provider row.
		assert.strictEqual(codex.description, "Connected (Max): 87% R:2.08 14:00");
		assert.strictEqual(claude.description, "Connected (Pro): 20% R:7.08 21:45");

		const balance = (await getItems(provider, deepSeek)).find(item => labelOf(item) === "Balance");
		assert.strictEqual(balance?.description, "110.00 CNY");

		const usageLimit = (await getItems(provider, codex)).find(item => labelOf(item) === "Usage Limit");
		assert.strictEqual(usageLimit?.description, "87% used · resets 2.08 14:00");

		// Claude cache keep-alive toggle is visible and defaults to on.
		const keepAlive = (await getItems(provider, claude)).find(item => labelOf(item) === "Cache Keep-Alive");
		assert.strictEqual(keepAlive?.description, "On (45 min)");
		assert.strictEqual(keepAlive?.command?.command, "llamacpp.toggleClaudeCacheKeepAlive");
	});

	test("formats provider usage lines with and without a reset time", () => {
		assert.strictEqual(
			formatProviderUsageLine("Connected (Plus)", 70, "2.08 17:25"),
			"Connected (Plus): 70% R:2.08 17:25"
		);
		assert.strictEqual(formatProviderUsageLine("Connected (Plus)", 70, undefined), "Connected (Plus): 70%");
		assert.strictEqual(formatProviderUsageLine("Connected", undefined, "2.08 17:25"), "Connected");
	});

	test("caps context control values to real provider bounds", () => {
		const values = new Map<string, unknown>([
			["claudeContextLength", 1_048_576],
			["codexWorkingContextTarget", 500_000],
			["codexContextLength", 400_000],
			["deepSeekContextLength", 2_000_000],
			["deepSeekDefaultMaxOutputTokens", 500_000],
		]);
		const state = resolveContextControlState({
			get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback,
		}, {
			modelId: "gpt-5.6-sol",
			contextWindowTokens: 258_400,
			updatedAt: Date.now(),
		});
		assert.strictEqual(state.claudeTarget, 967_000);
		assert.strictEqual(state.codexTarget, 258_400);
		assert.strictEqual(state.codexMaximum, 258_400);
		assert.strictEqual(state.codexMaximumObserved, true);
		assert.strictEqual(state.deepSeekContextTarget, 1_048_576);
		assert.strictEqual(state.deepSeekMaxOutputTarget, 393_216);
	});

	test("moves the same last-request metrics into Token Usage for every provider", async () => {
		const metrics = {
			modelId: "qwen3-coder",
			inputTokens: 2_000,
			outputTokens: 500,
			cachedInputTokens: 1_000,
			contextUsedTokens: 20_000,
			contextWindowTokens: 100_000,
		};
		const provider = new LlamaQuickActionsProvider(
			() => undefined, () => undefined, () => 0,
			() => undefined, () => undefined, () => 0,
			() => "Connected", () => "Connected", () => undefined, () => undefined, () => [],
			() => metrics, () => metrics, () => metrics, () => metrics
		);
		const roots = await getItems(provider);
		const usage = roots.find(item => labelOf(item) === "Token Usage");
		assert.ok(usage);
		for (const label of ["Local / Qwen", "DeepSeek", "Codex", "Claude"]) {
			const group = (await getItems(provider, usage)).find(item => labelOf(item) === label);
			assert.ok(group);
			const lastRequest = (await getItems(provider, group)).find(item => labelOf(item) === "Last Request");
			assert.ok(lastRequest);
			const children = await getItems(provider, lastRequest);
			assert.strictEqual(children.find(item => labelOf(item) === "Tokens (last)")?.description, "2.0K in · 500 out");
			assert.strictEqual(children.find(item => labelOf(item) === "Prompt Cache")?.description, "50.0% · 1.0K/2.0K");
			assert.strictEqual(children.find(item => labelOf(item) === "Context")?.description, "20.0% · 20.0K/100.0K");
		}
		for (const label of ["Local LLM", "DeepSeek", "Codex", "Claude"]) {
			const group = roots.find(item => labelOf(item) === label);
			assert.ok(group);
			assert.ok(!(await getItems(provider, group)).some(item => labelOf(item).startsWith("Tokens (")));
		}
	});

	test("labels active estimated metrics as live", async () => {
		const metrics = {
			modelId: "gpt-test",
			phase: "running" as const,
			estimated: true,
			inputTokens: 126_000,
			outputTokens: 320,
			cachedInputTokens: 125_000,
			contextUsedTokens: 126_320,
			contextWindowTokens: 258_400,
		};
		const provider = new LlamaQuickActionsProvider(
			() => undefined, () => undefined, () => 0,
			() => undefined, () => undefined, () => 0,
			() => "Connected", () => "Connected", () => undefined, () => undefined, () => [],
			() => undefined, () => undefined, () => metrics, () => undefined
		);
		const usage = (await getItems(provider)).find(item => labelOf(item) === "Token Usage");
		assert.ok(usage);
		const codex = (await getItems(provider, usage)).find(item => labelOf(item) === "Codex");
		assert.ok(codex);
		const current = (await getItems(provider, codex)).find(item => labelOf(item) === "Current Request");
		assert.ok(current);
		const children = await getItems(provider, current);
		assert.strictEqual(children.find(item => labelOf(item) === "Tokens (live)")?.description, "~126.0K in · ~320 out");
		assert.strictEqual(children.find(item => labelOf(item) === "Prompt Cache")?.description, "~99.2% · ~125.0K/~126.0K");
		assert.ok(String(children.find(item => labelOf(item) === "Context")?.description).startsWith("~48.9%"));
	});

	test("shows provider-specific today and weekly cache statistics", async () => {
		const history = emptyTokenUsageHistorySummary();
		Object.assign(history.today.providers.codex, {
			requests: 2,
			inputTokens: 3_000,
			outputTokens: 500,
			cachedInputTokens: 2_400,
			cacheEligibleInputTokens: 3_000,
			cacheReportedRequests: 2,
			reasoningOutputTokens: 200,
		});
		Object.assign(history.week.providers.codex, {
			requests: 8,
			inputTokens: 10_000,
			outputTokens: 2_000,
			cachedInputTokens: 7_000,
			cacheEligibleInputTokens: 10_000,
			cacheReportedRequests: 8,
		});
		const provider = new LlamaQuickActionsProvider(
			() => undefined, () => undefined, () => 0,
			() => undefined, () => undefined, () => 0,
			() => "Connected", () => "Connected", () => undefined, () => undefined, () => [],
			() => undefined, () => undefined, () => undefined, () => undefined, () => undefined,
			() => [], () => history
		);
		const usage = (await getItems(provider)).find(item => labelOf(item) === "Token Usage");
		assert.ok(usage);
		const codex = (await getItems(provider, usage)).find(item => labelOf(item) === "Codex");
		assert.ok(codex);
		const periods = await getItems(provider, codex);
		const today = periods.find(item => labelOf(item) === "Today");
		const week = periods.find(item => labelOf(item) === "Last 7 Days");
		assert.strictEqual(today?.description, "3.0K in · 500 out · cache 80.0% · 600 uncached");
		assert.strictEqual(week?.description, "10.0K in · 2.0K out · cache 70.0% · 3.0K uncached");
		const todayDetails = await getItems(provider, today);
		assert.strictEqual(todayDetails.find(item => labelOf(item) === "Cache Hit")?.description, "80.0% · 2.4K/3.0K");
		assert.strictEqual(todayDetails.find(item => labelOf(item) === "Uncached Input")?.description, "600");
		assert.strictEqual(todayDetails.find(item => labelOf(item) === "Zero Cache Reads")?.description, "0/2");
		assert.strictEqual(todayDetails.find(item => labelOf(item) === "Reasoning Output")?.description, "200");
	});

	test("shows matched experiment savings and separate child-provider usage", async () => {
		const baselineCodex = Object.assign(emptyTokenUsageAggregate(), {
			requests: 1,
			inputTokens: 1_000,
			outputTokens: 200,
			cachedInputTokens: 400,
			cacheEligibleInputTokens: 1_000,
			cacheReportedRequests: 1,
		});
		const delegatedCodex = Object.assign(emptyTokenUsageAggregate(), {
			requests: 1,
			inputTokens: 500,
			outputTokens: 100,
			cachedInputTokens: 300,
			cacheEligibleInputTokens: 500,
			cacheReportedRequests: 1,
		});
		const delegatedLocal = Object.assign(emptyTokenUsageAggregate(), {
			requests: 2,
			inputTokens: 800,
			outputTokens: 160,
		});
		const baseline = {
			id: "baseline-1",
			label: "bundle-vsix",
			variant: "baseline" as const,
			startedAt: 1,
			stoppedAt: 2,
			providers: { codex: baselineCodex },
			models: { "codex::gpt-test": baselineCodex },
		};
		const delegated = {
			id: "delegated-1",
			label: "bundle-vsix",
			variant: "delegated" as const,
			startedAt: 3,
			stoppedAt: 4,
			providers: { codex: delegatedCodex, local: delegatedLocal },
			models: { "codex::gpt-test": delegatedCodex, "local::qwen": delegatedLocal },
		};
		const provider = new LlamaQuickActionsProvider(
			() => undefined, () => undefined, () => 0,
			() => undefined, () => undefined, () => 0,
			() => undefined, () => undefined, () => undefined, () => undefined, () => [],
			() => undefined, () => undefined, () => undefined, () => undefined, () => undefined,
			() => [], () => emptyTokenUsageHistorySummary(), () => ({
				active: undefined,
				latestBaseline: baseline,
				latestDelegated: delegated,
				comparison: {
					totalSavingsPercent: 50,
					inputSavingsPercent: 50,
					uncachedInputSavingsPercent: 66.666,
					outputSavingsPercent: 50,
					delegatedCacheHitPercent: 60,
					baselineCodex,
					delegatedCodex,
					delegatedChildProviders: { local: delegatedLocal },
				},
			})
		);
		const experiments = (await getItems(provider)).find(item => labelOf(item) === "Usage Experiments");
		assert.strictEqual(experiments?.description, "Codex 50.0% saved");
		const children = await getItems(provider, experiments);
		const comparison = children.find(item => labelOf(item) === "Codex Comparison");
		assert.strictEqual(comparison?.description, "50.0% saved");
		assert.ok(children.some(item => labelOf(item) === "Latest Baseline"));
		assert.ok(children.some(item => labelOf(item) === "Latest Delegated"));
		assert.strictEqual(children.find(item => labelOf(item) === "Export Report")?.command?.command, "llamacpp.exportUsageExperiment");
		const comparisonDetails = await getItems(provider, comparison);
		assert.strictEqual(comparisonDetails.find(item => labelOf(item) === "Uncached Input")?.description, "66.7% saved");
		assert.ok(comparisonDetails.some(item => labelOf(item) === "Delegated Local / Qwen"));
	});

	test("groups advertised subagent models by provider", async () => {
		const provider = new LlamaQuickActionsProvider(
			() => undefined, () => undefined, () => 0,
			() => undefined, () => undefined, () => 0,
			() => undefined, () => undefined, () => undefined, () => undefined, () => [],
			() => undefined, () => undefined, () => undefined, () => undefined, () => undefined,
			() => [{
				id: "deepseek-v4-pro",
				label: "DeepSeek V4 Pro",
				provider: "deepseek",
				defaultEffort: "high",
				useWhen: "Focused complex tasks",
				availability: "unavailable",
				availabilityReason: "5-hour limit 100%",
				unavailableUntil: "2026-07-19T10:50:00.000Z",
			}]
		);
		const agents = (await getItems(provider)).find(item => labelOf(item) === "Subagents");
		assert.ok(agents);
		const deepSeek = (await getItems(provider, agents)).find(item => labelOf(item) === "DeepSeek");
		assert.ok(deepSeek);
		const models = await getItems(provider, deepSeek);
		assert.strictEqual(models[0].description, "Unavailable · high thinking");
		assert.ok(String(models[0].tooltip).includes("Focused complex tasks"));
		assert.ok(String(models[0].tooltip).includes("5-hour limit 100%"));
		assert.ok(String(models[0].tooltip).includes("Available after:"));
	});
});
