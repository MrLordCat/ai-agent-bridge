import type { OpenAIChatMessage } from "../types";

export type KnowledgeMode = "off" | "adaptive" | "strict";

interface KnowledgeSystemPromptOptions {
	mode: KnowledgeMode;
	currentDate: string;
	customPrompt?: string;
}

const MAX_CUSTOM_PROMPT_CHARS = 12000;

export function normalizeKnowledgeMode(value: unknown): KnowledgeMode {
	return value === "off" || value === "strict" ? value : "adaptive";
}

export function formatLocalDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function buildKnowledgeSystemPrompt(options: KnowledgeSystemPromptOptions): string | undefined {
	const customPrompt = options.customPrompt?.trim().slice(0, MAX_CUSTOM_PROMPT_CHARS);
	const sections: string[] = [];

	if (options.mode !== "off") {
		sections.push([
			"You are a careful coding agent working inside VS Code.",
			`Current date: ${options.currentDate}.`,
			"Inspect the workspace, relevant source, and tests before making claims about the project. Use available tools autonomously; never claim that a command, test, page, or file was checked unless you actually checked it.",
			"Complete requested implementation and verification when tools permit. For audits, cite local file paths and line numbers, record commands or tests used as evidence, and keep unresolved claims explicit.",
		].join("\n"));

		sections.push([
			"File editing discipline:",
			"- Before replacing text, use the latest file content — read the relevant section again if the file may have changed since your last read.",
			"- Keep oldString short and unique to the target location (a few unchanged lines around the change, not a giant block).",
			"- If a replacement fails with \"Could not find matching text\", do NOT retry the same pair — first read the file section to see its current exact content, then retry with a corrected oldString.",
			"- When applying several edits to one file, treat each edit as changing the file: the next oldString must match the file AFTER the previous edit, not the original version.",
			"- Prefer one well-placed edit over many overlapping ones.",
		].join("\n"));

		if (options.mode === "strict") {
			sections.push([
				"Knowledge verification mode: strict.",
				"Before relying on any material external technical claim that may vary by version or date, verify it with available web or source tools. Prefer official documentation, specifications, release notes, and pinned source revisions. When runtime behavior matters, cross-check documentation against implementation or a reproducible test.",
				"Identify the product version, commit, and publication date when relevant. Separate verified facts from source-based inference and unverified assumptions. Include direct source URLs in the answer. If live verification is unavailable, say so and avoid presenting memory as current fact.",
			].join("\n"));
		} else {
			sections.push([
				"Knowledge verification mode: adaptive.",
				"Use available web or source tools when a material external claim may have changed, is version-specific, security-sensitive, or uncertain. Prefer official documentation, specifications, release notes, and pinned source revisions; cross-check implementation when behavior matters.",
				"Identify relevant versions or dates, include direct source URLs, and distinguish verified facts from inference or assumptions. If live verification is unavailable, state that limitation. Do not browse stable facts when it would not improve the result.",
			].join("\n"));
		}
	}

	if (customPrompt) {
		sections.push(`Additional user-configured instructions:\n${customPrompt}`);
	}

	return sections.length > 0 ? sections.join("\n\n") : undefined;
}

export function injectKnowledgeSystemPrompt(
	messages: readonly OpenAIChatMessage[],
	prompt: string | undefined
): OpenAIChatMessage[] {
	const next = messages.map(message => ({ ...message }));
	if (!prompt?.trim()) {
		return next;
	}

	const stablePrompt = prompt.trim();
	if (next[0]?.role === "system" && typeof next[0].content === "string") {
		next[0] = {
			...next[0],
			content: `${stablePrompt}\n\n${next[0].content}`,
		};
		return next;
	}

	return [{ role: "system", content: stablePrompt }, ...next];
}
