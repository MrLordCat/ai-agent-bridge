import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import { ConversationHistory, mergeConversationHistory } from "../providers/conversation-history";
import { CocoTurnMetrics } from "../coco/turn-metrics";
import { SessionQualityTracker } from "../diagnostics/session-report";
import type { LlamaChatTurnMetrics } from "../llama-provider";

suite("Extension performance research", () => {
	test("measures journal, history merge and streaming cost without inference", async function () {
		if (process.env.AAB_PERF_RESEARCH !== "1") { this.skip(); return; }
		this.timeout(60000);
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-perf-"));
		const reports: Record<string, unknown>[] = [];
		const measure = async (operation: () => Promise<void>) => {
			const cpu = process.cpuUsage(), rss = process.memoryUsage().rss, started = performance.now();
			await operation(); const used = process.cpuUsage(cpu);
			return { wallMs: +(performance.now() - started).toFixed(2), cpuMs: +((used.user + used.system) / 1000).toFixed(2), rssDeltaMiB: +((process.memoryUsage().rss - rss) / 1048576).toFixed(2) };
		};
		try {
			for (const chars of [100000, 1000000, 3000000]) {
				const folder = path.join(root, String(chars)), journal = new ConversationHistory(folder);
				const messages = [vscode.LanguageModelChatMessage.User("Preserve the original requirement"), vscode.LanguageModelChatMessage.Assistant("a".repeat(chars))];
				const initial = await journal.begin("performance-chat", messages); await initial.complete([]);
				const rounds = 5;
				const journalCost = await measure(async () => {
					for (let index = 0; index < rounds; index++) {
						messages.push(vscode.LanguageModelChatMessage.User(`Request ${index}`));
						const lease = await journal.begin("performance-chat", messages);
						const response = new vscode.LanguageModelTextPart(`Answer ${index}`); await lease.complete([response]);
						messages.push(vscode.LanguageModelChatMessage.Assistant([response]));
					}
				});
				const mergeCost = await measure(async () => { for (let index = 0; index < 20; index++) { mergeConversationHistory(messages, messages); } });
				const file = path.join(folder, (await fs.readdir(folder))[0]);
				reports.push({ historyChars: chars, journalRounds: rounds, journal: journalCost, mergeRounds: 20, merge: mergeCost, savedBytes: (await fs.stat(file)).size });
			}
			let updates = 0;
			const metrics = new CocoTurnMetrics("benchmark", 100, () => { updates++; });
			const stream = await measure(async () => { for (let index = 0; index < 10000; index++) { metrics.accept({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "token " } }); } });
			reports.push({ streamChunks: 10000, publishedUpdates: updates, stream });
			const tracker = new SessionQualityTracker();
			let sample: LlamaChatTurnMetrics | undefined;
			const capture = new CocoTurnMetrics("benchmark", 100, update => { sample = update.turn; }); capture.setSession("new", "benchmark");
			for (let index = 0; index < 500; index++) { tracker.recordTurn({ ...sample!, requestId: `turn-${index}`, lifecyclePhase: "completed" }); }
			let reportBytes = 0;
			const reportCost = await measure(async () => { for (let index = 0; index < 100; index++) { reportBytes = Buffer.byteLength(JSON.stringify(tracker.toJSON(), null, 2)); } });
			reports.push({ reportRecords: 500, serializationRounds: 100, reportBytes, reportCost });
			for (const report of reports) { console.log(`BRIDGE_PERF ${JSON.stringify(report)}`); }
			if (process.env.AAB_PERF_REPORT) { await fs.writeFile(process.env.AAB_PERF_REPORT, JSON.stringify({ node: process.versions.node, vscode: vscode.version, reports }, null, 2) + "\n", "utf8"); }
		} finally { await fs.rm(root, { recursive: true, force: true }); }
	});
});