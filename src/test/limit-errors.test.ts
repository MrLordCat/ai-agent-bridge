import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { CompositeChatModelProvider } from "../composite-provider";
import { ConversationHistory } from "../providers/conversation-history";
import {
	detectLimitError,
	formatLimitNotice,
	formatWait,
	LimitGate,
	parseResetTime,
	SubscriptionLimitError,
} from "../providers/limit-errors";

const none: vscode.CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => new vscode.Disposable(() => undefined),
};
const model = (id: string) => ({ id, name: id, family: "fixture", version: "1", maxInputTokens: 100_000, maxOutputTokens: 8_192, capabilities: {} });

suite("Subscription limit errors", () => {
	const reference = new Date("2026-11-01T10:00:00.000Z");

	test("recognizes the Claude 5-hour window and its reset time", () => {
		const match = detectLimitError(new Error("Claude API error: You've hit your 5-hour limit · resets 4pm (Europe/Tallinn)"), undefined, reference);
		assert.ok(match);
		assert.strictEqual(match.provider, "claude");
		assert.strictEqual(match.window, "5-hour");
		assert.strictEqual(match.timeZone, "Europe/Tallinn");
		assert.ok(match.resetAt);
		assert.strictEqual(match.resetAt.toISOString(), "2026-11-01T14:00:00.000Z",
			"16:00 in Tallinn (UTC+2 in November) on the same day");
	});

	test("recognizes the Codex usage limit and its retry time", () => {
		const match = detectLimitError(new Error(
			"You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 2:32 PM."),
			undefined, reference);
		assert.ok(match);
		assert.strictEqual(match.provider, "codex");
		assert.ok(match.resetAt);
		const now = new Date(match.resetAt.getTime() - 90 * 60_000);
		assert.strictEqual(formatWait(match.resetAt, now), "1 h 30 min");
	});

	test("keeps the short notice for both providers", () => {
		const claude = new SubscriptionLimitError("claude",
			detectLimitError(new Error("You've hit your 5-hour limit · resets 4pm (Europe/Tallinn)"), undefined, reference), reference);
		assert.match(claude.message, /^Claude 5-hour limit reached\. It resets at /);
		assert.match(claude.message, /Wait for the reset, then send the message again\. No retry was made\.$/);
		assert.ok(claude.message.length < 220, "the notice must stay short");
		assert.strictEqual(claude.retryable, false);
		const codex = new SubscriptionLimitError("codex",
			detectLimitError(new Error("You've hit your usage limit. try again at 2:32 PM"), "codex", reference), reference);
		assert.match(codex.message, /^Codex limit reached\. It resets at /);
	});

	test("ignores context and payload limits", () => {
		assert.strictEqual(detectLimitError(new Error("Claude API error: input exceeds the maximum length")), undefined);
		assert.strictEqual(detectLimitError(new Error("context length exceeded: too many tokens")), undefined);
		assert.strictEqual(detectLimitError(new Error("You've hit your usage limit"), "claude")?.provider, "claude",
			"the provider hint decides who owns an ambiguous message");
	});

	test("parses clock, ISO and zone-less resets", () => {
		const now = new Date(2026, 10, 1, 10, 0, 0);
		assert.strictEqual(parseResetTime("resets at 14:30", now)?.at.getHours(), 14);
		assert.strictEqual(parseResetTime("2026-11-01T18:00:00.000Z", now)?.at.toISOString(), "2026-11-01T18:00:00.000Z");
		const past = parseResetTime("resets at 9am", now);
		assert.ok(past); assert.ok(past.at.getTime() > now.getTime(), "a past clock time means tomorrow");
	});

	test("fails fast while the window is still limited", () => {
		const gate = new LimitGate();
		const now = Date.now(), resetAt = new Date(now + 60 * 60_000);
		gate.note("codex", { provider: "codex", resetAt, reason: "usage limit" }, now);
		assert.match(gate.blocked("codex", now + 1_000) ?? "", /Codex limit reached/);
		assert.strictEqual(gate.blocked("codex", resetAt.getTime() + 1), undefined, "the block ends at the reset");
		assert.strictEqual(gate.blocked("claude", now), undefined, "providers are independent");
		gate.note("claude", { provider: "claude", reason: "usage limit" }, now);
		assert.match(gate.blocked("claude", now) ?? "", /Wait for the limit to reset/);
		gate.clear("claude");
		assert.strictEqual(gate.blocked("claude", now), undefined);
	});

	test("the notice survives a missing reset time", () => {
		assert.strictEqual(formatLimitNotice("claude", undefined).includes("resets at"), false);
		assert.match(formatLimitNotice("codex", { provider: "codex", reason: "rate limit" }), /No retry was made/);
	});

	test("an escaped limit becomes a one-line answer instead of an error", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "limit-composite-"));
		const thrown = "Claude API error: You've hit your 5-hour limit · resets 4pm (Europe/Tallinn)";
		const composite = new CompositeChatModelProvider({
			history: new ConversationHistory(root),
			providers: [{
				id: "claude",
				ownsModel: () => true,
				provider: {
					provideLanguageModelChatInformation: async () => [],
					provideTokenCount: async () => 1,
					provideLanguageModelChatResponse: async () => { throw new Error(thrown); },
				},
			}],
		});
		const parts: vscode.LanguageModelResponsePart[] = [];
		try {
			await composite.provideLanguageModelChatResponse(
				model("claude::claude-opus-5-5"),
				[vscode.LanguageModelChatMessage.User("hello")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _conversationId: "limit-chat" } } as never,
				{ report: part => parts.push(part) },
				none
			);
			assert.strictEqual(parts.length, 1, "the request completes with exactly one short answer");
			const text = (parts[0] as vscode.LanguageModelTextPart).value;
			assert.match(text, /^Claude 5-hour limit reached\. It resets at /);
			assert.ok(text.length < 220);
			assert.strictEqual(text.includes(thrown), false, "the provider text is replaced, not echoed");
		} finally {
			composite.dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("other provider failures still surface as errors", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "limit-composite-real-"));
		const composite = new CompositeChatModelProvider({
			history: new ConversationHistory(root),
			providers: [{
				id: "claude",
				ownsModel: () => true,
				provider: {
					provideLanguageModelChatInformation: async () => [],
					provideTokenCount: async () => 1,
					provideLanguageModelChatResponse: async () => { throw new Error("Claude API error: connection reset by peer"); },
				},
			}],
		});
		try {
			await assert.rejects(() => composite.provideLanguageModelChatResponse(
				model("claude::claude-opus-5-5"),
				[vscode.LanguageModelChatMessage.User("hello")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _conversationId: "other-failure" } } as never,
				{ report: () => undefined },
				none
			), /connection reset by peer/);
		} finally {
			composite.dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
