import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { CocoChatModelProvider } from "../coco/coco-provider";
import { mapCocoModel } from "../coco/model-adapter";
import { CompositeChatModelProvider } from "../composite-provider";
import { ConversationHistory } from "../providers/conversation-history";
import type { CocoRecordedUsage } from "../coco/turn-metrics";

suite("Coco real runtime", () => {
	test("continues Codex history, imports middle facts, reuses cache and restores after reload", async function () {
		if (process.env.AAB_COCO_REAL_CONTINUITY !== "1") { this.skip(); }
		this.timeout(180_000);
		const executable = process.env.AAB_COCO_CLI;
		assert.ok(executable, "Set AAB_COCO_CLI to the installed cortex executable");
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "coco-real-context-"));
		const values = new Map<string, unknown>();
		const state = { get: (key: string, fallback?: unknown) => values.get(key) ?? fallback, update: async (key: string, value: unknown) => { values.set(key, value); }, keys: () => [...values.keys()] } as vscode.Memento;
		const usage: CocoRecordedUsage[] = [], providers: CocoChatModelProvider[] = [], composites: CompositeChatModelProvider[] = [];
		const options = { toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _copilotConversationId: "native-integration-check" } };
		const token: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined) };
		// Small advertised budget deliberately exercises the real chunk-import path.
		const model = { ...mapCocoModel({ id: "claude-opus-5-5", name: "Opus 5.5" }, 1_000_000), maxInputTokens: 67_536 };
		const user = vscode.LanguageModelChatMessage.User, assistant = vscode.LanguageModelChatMessage.Assistant;
		const make = () => {
			const coco = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => executable, state, storageRoot: path.join(root, "archive") });
			coco.onDidRecordUsage(value => usage.push(value)); providers.push(coco);
			const composite = new CompositeChatModelProvider({ history: new ConversationHistory(path.join(root, "journal")), providers: [
				{ id: "codex", ownsModel: id => id.startsWith("codex::"), provider: { provideLanguageModelChatInformation: async () => [], provideTokenCount: async () => 1,
					provideLanguageModelChatResponse: async (_m, _messages, _o, progress) => { progress.report(new vscode.LanguageModelTextPart("Latest Codex finding: CODEX_FOUND")); } } },
				{ id: "coco", provider: coco, ownsModel: id => id.startsWith("coco::"), onForeignRequest: id => coco.onForeignRequest(id) },
			] }); composites.push(composite); return { coco, composite };
		};
		const send = async (composite: CompositeChatModelProvider, selected: vscode.LanguageModelChatInformation, messages: vscode.LanguageModelChatRequestMessage[]) => {
			const parts: vscode.LanguageModelResponsePart[] = [];
			await composite.provideLanguageModelChatResponse(selected, messages, options, { report: part => parts.push(part) }, token);
			return parts.filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart).map(p => p.value).join("");
		};
		const verify = (text: string) => { for (const marker of ["PINNED_FIRST", "PINNED_MIDDLE", "CODEX_FOUND"]) { assert.ok(text.includes(marker), `Missing ${marker}`); } };
		try {
			const first = make();
			await send(first.composite, { ...model, id: "codex::fixture" }, [user("Remember initial rule marker PINNED_FIRST."), assistant("x".repeat(4500) + "\nMiddle finding marker: PINNED_MIDDLE\n" + "y".repeat(4500)), user("Investigate the latest finding.")]);
			const request = user("Report the initial rule marker, middle finding marker and latest Codex finding. Return only those three values. Do not use tools.");
			const cold = await send(first.composite, model, [user("Investigate the latest finding."), assistant("Latest Codex finding: CODEX_FOUND"), request]); verify(cold);
			const again = user("Repeat those same three values. Do not use tools.");
			const warm = await send(first.composite, model, [request, assistant(cold), again]); verify(warm);
			first.composite.dispose(); first.coco.dispose();
			const restored = make();
			verify(await send(restored.composite, model, [again, assistant(warm), user("Repeat the same three values after reconnecting. Do not use tools.")]));
			assert.strictEqual(usage.length, 3); assert.ok(usage.every(value => value.inputTokens > 0 && value.cachedInputTokens !== undefined));
			console.log("Coco real integration:", JSON.stringify(usage.map(value => ({ input: value.inputTokens, cacheRead: value.cachedInputTokens, hitPercent: Number((value.cachedInputTokens! / value.inputTokens * 100).toFixed(2)), prompts: value.modelTurns }))));
		} finally { composites.forEach(c => c.dispose()); providers.forEach(p => p.dispose()); await fs.rm(root, { recursive: true, force: true }); }
	});
});