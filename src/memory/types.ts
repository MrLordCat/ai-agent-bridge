export type SharedMemoryScope = "global" | "workspace" | "model";
export type SharedMemoryKind = "preference" | "decision" | "environment" | "workflow" | "externalFact" | "other";

export interface SharedMemoryEntry {
	id: string;
	title: string;
	content: string;
	tags: string[];
	pinned: boolean;
	scope: SharedMemoryScope;
	scopeId?: string;
	kind: SharedMemoryKind;
	sourceUrl?: string;
	verifiedAt?: string;
	expiresAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface SharedMemoryUpsertInput {
	id?: string;
	title: string;
	content: string;
	tags?: string[];
	pinned?: boolean;
	scope?: SharedMemoryScope;
	scopeId?: string;
	kind?: SharedMemoryKind;
	sourceUrl?: string;
	verifiedAt?: string;
	expiresAt?: string;
}

export interface SharedMemoryRetrievalContext {
	workspaceId?: string;
	modelId?: string;
	includeExpired?: boolean;
	scope?: SharedMemoryScope;
}

export interface SharedMemoryPromptContext {
	text: string;
	entryCount: number;
	entryIds: string[];
	scopeCounts?: Partial<Record<SharedMemoryScope, number>>;
	/** Individually rendered entries used to build append-only prompt deltas. */
	entries?: Array<{ id: string; text: string }>;
	estimatedTokens: number;
	expiredEntryCount: number;
}

export interface SharedMemoryContextProvider {
	buildPromptContext(
		query: string,
		maxTokens: number,
		context?: SharedMemoryRetrievalContext
	): Promise<SharedMemoryPromptContext | undefined>;
}
