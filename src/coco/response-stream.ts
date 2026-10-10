import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { parseCocoContextUsage, createCocoNativeContextUsage } from "./usage-adapter";

export type CocoThinkingPartConstructor = new (text: string, id?: string) => unknown;

/** Route ACP reasoning and answer deltas into separate native Chat parts. */
export class CocoResponseStream {
	private thinkingId?: string;

	constructor(
		private readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		private readonly token: vscode.CancellationToken,
		private readonly ThinkingPart: CocoThinkingPartConstructor | null | undefined =
			(vscode as unknown as Record<string, unknown>)["LanguageModelThinkingPart"] as
			CocoThinkingPartConstructor | undefined
	) {}

	accept(update: Record<string, unknown>): void {
		if (this.token.isCancellationRequested) {
			return;
		}
		const usage = parseCocoContextUsage(update);
		if (usage) {
			this.progress.report(vscode.LanguageModelDataPart.text(JSON.stringify(createCocoNativeContextUsage(usage)), "usage"));
			return;
		}
		const content = update.content as { type?: unknown; text?: unknown } | undefined;
		if (content?.type !== "text" || typeof content.text !== "string" || !content.text) {
			return;
		}
		if (update.sessionUpdate === "agent_thought_chunk") {
			if (this.ThinkingPart) {
				this.thinkingId ??= randomUUID();
				this.progress.report(new this.ThinkingPart(content.text, this.thinkingId) as vscode.LanguageModelResponsePart);
			}
		} else if (update.sessionUpdate === "agent_message_chunk") {
			this.thinkingId = undefined;
			this.progress.report(new vscode.LanguageModelTextPart(content.text));
		}
	}
}