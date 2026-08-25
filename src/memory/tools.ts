import * as vscode from "vscode";
import { getCurrentWorkspaceScopeId, getCurrentWorkspaceScopeLabel } from "./scope";
import type { SharedMemoryService } from "./shared-memory-service";
import type { SharedMemoryKind } from "./types";

type AgentMemoryScope = "global" | "workspace";

interface StoreMemoryInput {
	id?: string;
	title: string;
	content: string;
	tags?: string[];
	pinned?: boolean;
	scope: AgentMemoryScope;
	kind?: SharedMemoryKind;
	sourceUrl?: string;
	verifiedAt?: string;
	expiresAt?: string;
}

interface SearchMemoryInput {
	query?: string;
	limit?: number;
	includeExpired?: boolean;
	scope?: AgentMemoryScope;
	/** Return every character of matching entries (default clips long content). */
	full?: boolean;
}

interface DeleteMemoryInput {
	id: string;
	scope: AgentMemoryScope;
}

function scopeDescription(scope: AgentMemoryScope): string {
	return scope === "global"
		? "global memory (available to agents in every project)"
		: `project memory (only ${getCurrentWorkspaceScopeLabel()})`;
}

function resolveScope(scope: AgentMemoryScope): { scope: AgentMemoryScope; scopeId?: string } {
	if (scope === "global") {
		return { scope };
	}
	if (scope !== "workspace") {
		throw new Error('Memory scope must be either "global" or "workspace".');
	}
	const scopeId = getCurrentWorkspaceScopeId();
	if (!scopeId) {
		throw new Error("Project memory requires an open VS Code workspace.");
	}
	return { scope, scopeId };
}

class StoreMemoryTool implements vscode.LanguageModelTool<StoreMemoryInput> {
	constructor(private readonly memory: SharedMemoryService) {}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<StoreMemoryInput>): vscode.PreparedToolInvocation {
		const destination = scopeDescription(options.input.scope);
		return {
			invocationMessage: `Saving ${destination}: ${options.input.title}`,
			confirmationMessages: {
				title: options.input.scope === "global" ? "Save global memory" : "Save project memory",
				message: `Store "${options.input.title}" in ${destination}?`,
			},
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<StoreMemoryInput>): Promise<vscode.LanguageModelToolResult> {
		const destination = resolveScope(options.input.scope);
		const existing = options.input.id ? this.memory.get(options.input.id) : undefined;
		if (
			existing?.scope === "workspace"
			&& existing.scopeId !== getCurrentWorkspaceScopeId()
		) {
			throw new Error("Cannot update memory owned by another project.");
		}
		if (existing?.scope === "model") {
			throw new Error("Legacy model-scoped memory cannot be changed through the two-scope memory tool.");
		}
		const entry = await this.memory.upsert({ ...options.input, ...destination });
		const label = entry.scope === "global" ? "global" : "project";
		const estimatedTokens = Math.ceil(entry.content.length / 4);
		const similar = this.memory.similarEntries(entry, 2);
		const lines = [
			`Saved ${label}/${entry.kind} memory ${entry.id}: ${entry.title}`,
			`Size: ${entry.content.length} chars (~${estimatedTokens} tokens).`,
		];
		for (const candidate of similar) {
			lines.push(
				`Warning: close to existing ${candidate.id} "${candidate.title}" (similarity ${candidate.similarity.toFixed(2)}). ` +
				`Update that id if this is the same fact; keep each entry one thought.`
			);
		}
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(lines.join("\n")),
		]);
	}
}

class SearchMemoryTool implements vscode.LanguageModelTool<SearchMemoryInput> {
	constructor(private readonly memory: SharedMemoryService) {}

	prepareInvocation(): vscode.PreparedToolInvocation {
		return { invocationMessage: "Searching shared memory" };
	}

	invoke(options: vscode.LanguageModelToolInvocationOptions<SearchMemoryInput>): vscode.LanguageModelToolResult {
		const selectedScope = options.input.scope ? resolveScope(options.input.scope) : undefined;
		const entries = this.memory.search(
			options.input.query ?? "",
			options.input.limit ?? 12,
			{
				workspaceId: selectedScope?.scopeId ?? getCurrentWorkspaceScopeId(),
				includeExpired: options.input.includeExpired === true,
				scope: selectedScope?.scope,
			}
		);
		const result = entries.length === 0
			? "No matching shared memory entries."
			: entries.map(entry => {
				const metadata = [
					`${entry.scope}/${entry.kind}`,
					entry.sourceUrl ? `source=${entry.sourceUrl}` : undefined,
					entry.verifiedAt ? `verified=${entry.verifiedAt}` : undefined,
					entry.expiresAt ? `expires=${entry.expiresAt}` : undefined,
					`chars=${entry.content.length}`,
				].filter(Boolean).join("; ");
				const body = options.input.full === true
					? entry.content
					: clipMemoryContent(entry.content);
				return `- [${entry.id}] ${entry.title} (${metadata})\n${body}`;
			}).join("\n\n") + formatSearchMetrics(entries);
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
	}
}

/** Long entries dominate the model context; show head+tail and the omitted size. */
export function clipMemoryContent(content: string, headChars = 600, tailChars = 300): string {
	if (content.length <= headChars + tailChars) {
		return content;
	}
	const omitted = content.length - headChars - tailChars;
	return `${content.slice(0, headChars)}\n…[${omitted} chars omitted — pass full: true if the exact text is required]…\n${content.slice(-tailChars)}`;
}

function formatSearchMetrics(entries: readonly { content: string }[]): string {
	if (entries.length === 0) {
		return "";
	}
	const totalChars = entries.reduce((sum, entry) => sum + entry.content.length, 0);
	return `\n\n-- ${entries.length} entries, ${totalChars} chars (~${Math.ceil(totalChars / 4)} tokens)`;
}

class DeleteMemoryTool implements vscode.LanguageModelTool<DeleteMemoryInput> {
	constructor(private readonly memory: SharedMemoryService) {}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<DeleteMemoryInput>): vscode.PreparedToolInvocation {
		const destination = scopeDescription(options.input.scope);
		return {
			invocationMessage: `Deleting ${destination} ${options.input.id}`,
			confirmationMessages: {
				title: options.input.scope === "global" ? "Delete global memory" : "Delete project memory",
				message: `Permanently delete entry "${options.input.id}" from ${destination}?`,
			},
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<DeleteMemoryInput>): Promise<vscode.LanguageModelToolResult> {
		const selected = resolveScope(options.input.scope);
		const removed = await this.memory.remove(options.input.id, {
			scope: selected.scope,
			...(selected.scopeId ? { workspaceId: selected.scopeId } : {}),
		});
		const label = selected.scope === "global" ? "global" : "project";
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(removed
				? `Deleted ${label} memory ${options.input.id}.`
				: `No ${label} memory ${options.input.id} is visible in the selected scope.`),
		]);
	}
}

export function registerMemoryTools(context: vscode.ExtensionContext, memory: SharedMemoryService): void {
	context.subscriptions.push(
		vscode.lm.registerTool("llamacpp_store_memory", new StoreMemoryTool(memory)),
		vscode.lm.registerTool("llamacpp_search_memory", new SearchMemoryTool(memory)),
		vscode.lm.registerTool("llamacpp_delete_memory", new DeleteMemoryTool(memory))
	);
}
