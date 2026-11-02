import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { CompositeChatModelProvider } from "../composite-provider";
import { ConversationHistory } from "../providers/conversation-history";
import {
	detectBalanceError,
	detectBalanceFailure,
	formatBalanceNotice,
	ProviderBalanceError,
} from "../providers/balance-errors";

const none: vscode.CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => new vscode.Disposable(() => undefined),
};
const model = (id: string) => ({ id, name: id, family: "fixture", version: "1", maxInputTokens: 100_000, maxOutputTokens: 8_192, capabilities: {} });

suite("Provider balance errors", () => {
	test("turns a 402 with a provider body into one short notice", () => {
		const failure = detectBalanceFailure(402, "{\"error\":{\"message\":\"Insufficient Balance\",\"type\":\"unknown_error\"}}", "DeepSeek");
		assert.ok(failure);
		assert.strictEqual(failure.providerLabel, "DeepSeek");
		assert.strictEqual(failure.status, 402);
		assert.strictEqual(failure.detail, "Insufficient Balance");
		const notice = formatBalanceNotice(failure);
		assert.match(notice, /^DeepSeek balance is empty \(Insufficient Balance\)\. /);
		assert.match(notice, /Top up the account, then send the message again\. No retry was made\.$/);
		assert.ok(notice.length < 180, "the notice must stay short");
	});

	test("recognizes balance wording without a 402 status", () => {
		assert.ok(detectBalanceFailure(400, "{\"error\":{\"message\":\"insufficient credit balance\"}}", "DeepSeek"));
		assert.ok(detectBalanceFailure(undefined, "Your credit balance is too low to access the API.", "Claude"));
		assert.ok(detectBalanceFailure(429, "You exceeded your current quota, please check your plan and billing details.", "OpenAI"));
	});

	test("does not confuse context or rate limits with an empty balance", () => {
		assert.strictEqual(detectBalanceFailure(400, "input exceeds the context window", "DeepSeek"), undefined);
		assert.strictEqual(detectBalanceFailure(429, "rate limit exceeded", "DeepSeek"), undefined);
		assert.strictEqual(detectBalanceFailure(500, "internal error", "DeepSeek"), undefined);
	});

	test("detects the error shape the provider throws and drops its stack text", () => {
		const failure = detectBalanceError(new Error("Llama.cpp API error: 402 Payment Required"), "DeepSeek");
		assert.ok(failure);
		assert.strictEqual(failure.status, 402);
		const notice = formatBalanceNotice(failure);
		assert.strictEqual(notice, "DeepSeek balance is empty. Top up the account, then send the message again. No retry was made.");
		assert.strictEqual(detectBalanceError(new ProviderBalanceError(failure)), failure);
	});

	test("a thrown empty balance becomes one answer instead of an error", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "balance-composite-"));
		let calls = 0;
		const composite = new CompositeChatModelProvider({
			history: new ConversationHistory(root),
			providers: [{
				id: "http",
				ownsModel: () => true,
				provider: {
					provideLanguageModelChatInformation: async () => [],
					provideTokenCount: async () => 1,
					provideLanguageModelChatResponse: async () => {
						calls++;
						throw new Error("Llama.cpp API error: 402 Payment Required");
					},
				},
			}],
		});
		const parts: vscode.LanguageModelResponsePart[] = [];
		try {
			await composite.provideLanguageModelChatResponse(
				model("deepseek::deepseek-flash"),
				[vscode.LanguageModelChatMessage.User("hello")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _conversationId: "balance-chat" } } as never,
				{ report: part => parts.push(part) },
				none
			);
			assert.strictEqual(calls, 1, "one provider call, no retry loop");
			assert.strictEqual(parts.length, 1);
			const text = (parts[0] as vscode.LanguageModelTextPart).value;
			assert.strictEqual(text, "DeepSeek balance is empty. Top up the account, then send the message again. No retry was made.");
		} finally {
			composite.dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("other HTTP failures still surface as errors", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "balance-composite-real-"));
		const composite = new CompositeChatModelProvider({
			history: new ConversationHistory(root),
			providers: [{
				id: "http",
				ownsModel: () => true,
				provider: {
					provideLanguageModelChatInformation: async () => [],
					provideTokenCount: async () => 1,
					provideLanguageModelChatResponse: async () => { throw new Error("Llama.cpp API error: 500 Internal Server Error"); },
				},
			}],
		});
		try {
			await assert.rejects(() => composite.provideLanguageModelChatResponse(
				model("deepseek::deepseek-flash"),
				[vscode.LanguageModelChatMessage.User("hello")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _conversationId: "balance-500" } } as never,
				{ report: () => undefined },
				none
			), /500 Internal Server Error/);
		} finally {
			composite.dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
