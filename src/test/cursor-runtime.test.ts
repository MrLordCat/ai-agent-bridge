import * as assert from "node:assert";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { CursorSdkTransport } from "../cursor/sdk-transport";
import { cursorTranscript } from "../cursor/message-adapter";
import type { CursorRecordedUsage, CursorLiveTurn } from "../cursor/turn-metrics";

suite("Cursor real runtime", () => {
	test("retains synthetic facts across cold handoff, warm turn and native restore", async function () {
		if (process.env.AAB_CURSOR_REAL_CONTINUITY !== "1") { this.skip(); }
		this.timeout(240_000);
		const apiKey = process.env.AAB_CURSOR_KEY ?? process.env.CURSOR_API_KEY, model = process.env.AAB_CURSOR_MODEL;
		assert.ok(apiKey && model, "Opt-in Cursor smoke needs a chat API key and exact AAB_CURSOR_MODEL id; never use an Admin key.");
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-native-continuity-"));
		const values = new Map<string, unknown>();
		const state = { get: <T>(key: string, fallback?: T) => (values.get(key) as T | undefined) ?? fallback, update: async (key: string, value: unknown) => { values.set(key, value); }, keys: () => [...values.keys()] } as vscode.Memento;
		const updates: CursorLiveTurn[] = [], usages: CursorRecordedUsage[] = [];
		const make = () => { const sdk = new CursorSdkTransport({ storageRoot: root, state, cwd: () => root }); sdk.onDidUpdateLiveTurn(update => updates.push(update)); sdk.onDidRecordUsage(usage => usages.push(usage)); return sdk; };
		let sdk = make();
		try {
			const fact = `PIN_${randomUUID().replace(/-/g, "")}`;
			const messages = [vscode.LanguageModelChatMessage.User(`Synthetic prior Codex chat: retain marker ${fact}. Do not use tools. Reply only with that marker.`)];
			for (const mode of ["new", "warm", "restored"]) {
				if (mode === "restored") { sdk.dispose(); sdk = make(); }
				if (mode !== "new") { messages.push(vscode.LanguageModelChatMessage.User("Repeat the retained marker exactly. Do not use tools.")); }
				const response: vscode.LanguageModelResponsePart[] = [];
				await sdk.respond({ key: "api-native-smoke", label: "Cursor", serverUrl: "https://api.cursor.com/v1", protocol: "cursor", apiKey }, { id: model }, () => cursorTranscript(messages), messages,
					{ tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _copilotConversationId: "native-smoke" } }, { report: part => response.push(part) },
					{ isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined) }, 1_000_000);
				const text = response.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => (part as vscode.LanguageModelTextPart).value).join("");
				assert.ok(text.includes(fact), `Native ${mode} lost its synthetic marker.`); assert.strictEqual(updates.at(-1)?.turn.sessionMode, mode);
				messages.push(vscode.LanguageModelChatMessage.Assistant(text));
				console.log(JSON.stringify({ cursorSmoke: mode, nativeUsage: usages.at(-1) ? { inputTokens: usages.at(-1)!.inputTokens, cachedInputTokens: usages.at(-1)!.cachedInputTokens, hitPercent: updates.at(-1)?.turn.promptCacheHitPercent } : "not reported" }));
			}
		} finally { sdk.dispose(); await fs.rm(root, { recursive: true, force: true }); }
	});
});