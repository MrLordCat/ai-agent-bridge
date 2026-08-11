import * as assert from "node:assert";
import { Script } from "node:vm";

import { SessionQualityPanel } from "../ui/session-quality-panel";

suite("session quality panel", () => {
	test("renders the responsive live dashboard with valid embedded JavaScript", () => {
		const data = {
			generatedAt: "2026-07-28T08:58:45.592Z",
			extensionVersion: "1.8.37",
			vscodeVersion: "1.127.0",
			providerHealth: {
				claudeCacheKeepAlive: {
					state: "success",
					reason: "Keep-alive completed with 99.4% cache read.",
					enabled: true,
					updatedAt: Date.parse("2026-07-28T08:55:00Z"),
					intervalMs: 2_700_000,
					usagePercent: 42,
					usageSnapshotAgeMs: 5_000,
					sessionCount: 2,
					eligibleSessionCount: 1,
					candidateModelId: "claude-opus-5",
					candidatePrefixTokens: 190_481,
					nextAttemptAt: Date.parse("2026-07-28T09:40:00Z"),
					lastAttemptAt: Date.parse("2026-07-28T08:54:55Z"),
					lastSuccessAt: Date.parse("2026-07-28T08:55:00Z"),
					lastResultCacheHitPercent: 99.4,
					lastResultInputTokens: 190_481,
					lastResultCacheWriteTokens: 1_136,
				},
			},
			summary: {
				turns: 2,
				totalModelTurns: 33,
				promptTokens: 16_475_311,
				cachedPromptTokens: 16_012_544,
				cacheHitPercent: 97.2,
				cacheAverageHitPercent: 57.6,
				cacheWorstHitPercent: 18,
				turnsWithCacheReport: 2,
				cacheHealthyTurns: 1,
				cacheStartupMissTurns: 1,
				cacheMissBreakdown: [{ reason: "tool_catalog_changed", count: 1, percent: 100 }],
				cacheByModel: [{
					modelLabel: "deepseek (v4-pro)",
					turns: 1,
					modelSegments: 32,
					promptTokens: 32_692,
					cachedTokens: 5_888,
					hitPercent: 18,
					healthyTurns: 0,
					missTurns: 1,
					subagentTurns: 0,
				}],
				averageFirstTokenLatencyMs: 3304,
				averageTokensPerSecond: 5.4,
				totalToolCalls: 1,
				repairedToolCalls: 0,
				rejectedToolCalls: 0,
				toolCallRepairRetries: 0,
				toolLoopsDetected: 0,
				compactedTurns: 1,
				overflowRetries: 0,
			},
			records: [{
				index: 1,
				requestId: "request-1",
				modelId: "deepseek::deepseek-v4-pro",
				promptTokens: 32_692,
				cachedPromptTokens: 5_888,
				promptCacheHitPercent: 18,
				cacheMissReason: "tool_catalog_changed",
				cacheMissDetail: "catalog changed </script><script>bad()</script>",
				firstTokenLatencyMs: 3304,
				tokensPerSecond: 5.4,
				toolCalls: 1,
				modelTurns: 32,
				firstVisibleLatencyMs: 5100,
				reasoningOutputTokens: 4043,
				toolDurationTotalMs: 3000,
				averageToolDurationMs: 3000,
				maximumToolDurationMs: 3000,
				p95ToolDurationMs: 3000,
				toolCallBreakdown: { read_file: 1 },
				metricsSource: "rollout",
				usageSegments: [{
					index: 1,
					recordedAt: "2026-07-28T08:58:40.000Z",
					inputTokens: 1000,
					cachedInputTokens: 900,
					outputTokens: 100,
					reasoningOutputTokens: 40,
					totalTokens: 1100,
					cacheHitPercent: 90,
				}],
				context: {
					contextLength: 524_288,
					inputBudget: 445_644,
					messageTokensBeforeCompact: 521_884,
					messageTokensAfterCompact: 401_000,
					messageCountBeforeCompact: 1459,
					messageCountAfterCompact: 1090,
					replyReserveTokens: 36_700,
					toolTokens: 7064,
					cappedTools: 70,
					softInputTarget: 401_880,
					hardInputTarget: 333_723,
					tokenCountSource: "heuristic",
					estimatedUsedTokens: 444_764,
					estimatedFreeTokens: 79_524,
					estimatedUsagePercent: 84.8,
					autoCompacted: true,
					hardCompacted: false,
					promptSegments: [
						{ kind: "system", label: "System", tokens: 1200 },
						{ kind: "tools", label: "Tool catalog", tokens: 7064 },
						{ kind: "shared_memory", label: "Shared memory", tokens: 829 },
						{ kind: "reasoning", label: "Reasoning", tokens: 4043 },
						{ kind: "tool_results", label: "Tool results", tokens: 2500 },
					],
				},
			}, {
				index: 2,
				requestId: "codex-request",
				modelId: "gpt-5.6-sol",
				providerKind: "codex",
				lifecyclePhase: "timed_out",
				terminalDetail: "Native VS Code tool timed out.",
				threadMode: "interrupted-resume",
				threadReuseMissReason: "no-stored-thread",
				promptTokens: 235_703,
				cachedPromptTokens: 115_456,
				promptCacheHitPercent: 49,
				initialSegmentCacheHitPercent: 0,
				continuationCacheHitPercent: 96.7,
				finalSegmentInputTokens: 119_410,
				finalSegmentCachedInputTokens: 115_456,
				cacheMissReason: "healthy",
				modelTurns: 2,
				toolCalls: 1,
				delegatedToolCalls: 1,
				catalogToolCalls: 0,
				steps: [{
					id: "tool-call-subagent",
					index: 1,
					kind: "tool",
					label: "runSubagent",
					status: "timed_out",
					toolCategory: "vscode",
					startedAt: "2026-07-29T07:00:00.000Z",
					durationMs: 1_800_000,
				}],
			}, {
				index: 3,
				requestId: "claude-request",
				modelId: "claude-opus-5",
				providerKind: "claude",
				lifecyclePhase: "completed",
				sessionMode: "resume-fallback",
				cacheMissReason: "resume_invalid_resume_boundary",
				cacheMissDetail: "Durable Claude resume failed at sdk_resume: invalid branch.",
				resumeFailureReason: "invalid_resume_boundary",
				resumeFailureStage: "sdk_resume",
				resumeFailureDetail: "Invalid resumeSessionAt message UUID",
				resumeFallbackDecision: "input_limit",
				resumeFallbackEstimatedInputTokens: 71_666,
				resumeFallbackMaxInputTokens: 64_000,
				turnMaxModelSegments: 24,
				turnMaxCumulativeInputTokens: 2_000_000,
				safetyStopReason: "max_model_segments",
				safetyStopDetail: "Agent SDK stopped at maxTurns=24.",
				promptTokens: 4920,
				cachedPromptTokens: 4096,
				cacheWriteInputTokens: 512,
				promptCacheHitPercent: 83.3,
				outputTokens: 120,
				reasoningOutputTokens: 80,
				modelTurns: 1,
				toolCalls: 1,
				delegatedToolCalls: 1,
				metricsSource: "live",
				steps: [{
					id: "tool-claude-read",
					index: 1,
					kind: "tool",
					label: "read_file",
					status: "completed",
					toolCategory: "vscode",
					startedAt: "2026-07-29T08:00:00.000Z",
					durationMs: 20,
				}],
				usageSegments: [{
					index: 1,
					recordedAt: "2026-07-29T08:00:01.000Z",
					freshInputTokens: 312,
					inputTokens: 4920,
					cachedInputTokens: 4096,
					cacheCreationInputTokens: 512,
					outputTokens: 120,
					reasoningOutputTokens: 80,
					totalTokens: 5040,
					cacheHitPercent: 83.3,
				}],
				context: {
					contextLength: 258400,
					inputBudget: 240000,
					rawMaxTokens: 1000000,
					usableMaxTokens: 240000,
					categories: [{ name: "systemPrompt", tokens: 1200 }],
					messageTokensBeforeCompact: 4500,
					messageTokensAfterCompact: 4500,
					messageCountBeforeCompact: 20,
					messageCountAfterCompact: 20,
					replyReserveTokens: 18400,
					toolTokens: 420,
					cappedTools: 12,
					softInputTarget: 240000,
					hardInputTarget: 240000,
					tokenCountSource: "server",
					estimatedUsedTokens: 4920,
					estimatedFreeTokens: 235080,
					estimatedUsagePercent: 1.9,
					autoCompacted: false,
					hardCompacted: false,
				},
			}],
		};

		const renderHtml = (SessionQualityPanel.prototype as unknown as {
			renderHtml: (value: unknown) => string;
		}).renderHtml;
		const html = renderHtml.call(SessionQualityPanel.prototype, data);

		// Static shell: header, tabs and empty lazy tab containers.
		assert.match(html, /class="live-pill"/);
		assert.match(html, /class="tabs"/);
		assert.match(html, /data-tab="cache"/);
		assert.match(html, /data-tab="perf"/);
		assert.match(html, /id="tab-cache"/);
		assert.match(html, /id="tab-perf"/);
		assert.match(html, /id="tab-errors"/);
		assert.match(html, /id="tab-health"/);
		assert.match(html, /const detailKey = String\(r\.requestId/);
		assert.match(html, /const detailId = "detail-" \+ detailKey/);
		assert.match(html, /"struct-details-" \+ detailKey/);
		assert.match(html, /data-target=/);
		assert.match(html, /Expand block details/);
		assert.match(html, /class="struct-detail-list"/);
		assert.match(html, /block\.tokens\)\) \+ ' total/);
		assert.match(html, /saveOpenStructureDetails/);
		assert.match(html, /captureOpenTurnAnchor/);
		assert.match(html, /restoreOpenTurnAnchor\(state\.turnAnchor\)/);
		assert.ok(!html.includes('const detailId = "detail-" + i;'));
		assert.match(html, /compactTurnRecord/);
		assert.match(html, /lastResultCacheHitPercent/);
		assert.match(html, /step.status === 'timed_out'/);
		assert.match(html, /cold Codex startup/);
		assert.match(html, /continuation cache health recovered above 90%/);
		assert.match(html, /resumeFallbackDecision: r\.resumeFallbackDecision/);
		assert.match(html, /cacheWriteInputTokens":512/);
		assert.match(html, /"toolCallBreakdown":\{"read_file":1\}/);
		assert.match(html, /"metricsSource":"rollout"/);
		assert.match(html, /Gap distribution/);
		assert.match(html, /spark-bar/);
		assert.match(html, /perf-chat-filter/);
		assert.match(html, /Alt\+click: full JSON/);
		assert.match(html, /aria-expanded="false"/);
		assert.ok(!html.includes("</script><script>bad()"));

		const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
		assert.ok(scriptMatch, "expected an embedded dashboard script");
		assert.doesNotThrow(() => new Script(scriptMatch[1]));

		// Execute the dashboard script against a minimal DOM stub so the tab
		// render helpers can be invoked directly (no jsdom dependency). Live
		// updates build only the active tab, so the cache tab (default) and the
		// performance tab content are verified through their render functions.
		let lastFake: Record<string, unknown> | undefined;
		const fakeElement = () => {
			const el: Record<string, unknown> = {
				innerHTML: "",
				dataset: {},
				textContent: "",
				value: "",
				hidden: false,
				style: {},
				className: "",
				classList: {
					toggle: () => undefined,
					add: () => undefined,
					remove: () => undefined,
					contains: () => false,
				},
				setAttribute: () => undefined,
				getAttribute: () => null,
				addEventListener: () => undefined,
				appendChild: () => undefined,
				getBoundingClientRect: () => ({ top: 0, bottom: 0 }),
			};
			lastFake = el;
			return el;
		};
		const sandbox: Record<string, unknown> = {
			console,
			setTimeout,
			clearTimeout,
			document: {
				getElementById: () => fakeElement(),
				createElement: () => fakeElement(),
				querySelector: () => null,
				querySelectorAll: () => [],
				addEventListener: () => undefined,
			},
		};
		sandbox.window = sandbox;
		sandbox.addEventListener = () => undefined;
		new Script(scriptMatch[1]).runInNewContext(sandbox);
		if (lastFake?.textContent?.toString().startsWith("Error:")) {
			assert.fail(lastFake.textContent.toString());
		}
		const call = (name: string): string => {
			const fn = sandbox[name] as (value: unknown) => string;
			assert.strictEqual(typeof fn, "function", `expected script function ${name}`);
			return fn(data);
		};

		// Cache tab (rendered by default on load).
		const cacheHtml = call("renderCacheTab");
		assert.match(cacheHtml, /class="metric-grid"/);
		assert.match(cacheHtml, /Claude cache keep-alive/);
		assert.match(cacheHtml, /Last success/);
		assert.match(cacheHtml, /Protected session/);
		assert.match(cacheHtml, /id="turn-search"/);
		assert.match(cacheHtml, /id="issues-filter"/);
		assert.match(cacheHtml, /class="detail-grid"/);
		assert.match(cacheHtml, /Model usage segments/);
		assert.match(cacheHtml, /Codex session &amp; cache/);
		assert.match(cacheHtml, /Processed blend/);
		assert.match(cacheHtml, /Shared memory/);
		assert.match(cacheHtml, /Reasoning/);
		assert.match(cacheHtml, /Tool results/);
		assert.match(cacheHtml, /estimated block split/);
		assert.match(cacheHtml, /Final \/ continuation segment/);
		assert.match(cacheHtml, /Delegated VS Code tools/);
		assert.match(cacheHtml, /Claude session &amp; cache/);
		assert.match(cacheHtml, /Cache creation/);
		assert.match(cacheHtml, /Resume failure/);
		assert.match(cacheHtml, /Failure stage/);
		assert.match(cacheHtml, /Original SDK error/);
		assert.match(cacheHtml, /Fallback decision/);
		assert.match(cacheHtml, /Estimated cold replay/);
		assert.match(cacheHtml, /Turn guard/);
		assert.match(cacheHtml, /Safety stop/);
		assert.match(cacheHtml, /Claude SDK context snapshot/);
		assert.match(cacheHtml, /Claude.*live steps/);

		// Performance tab (lazily rendered on switch).
		const perfHtml = call("renderPerfTab");
		assert.match(perfHtml, /Gap med \/ p95/);
		assert.match(perfHtml, /Turn timeline/);
	});
});