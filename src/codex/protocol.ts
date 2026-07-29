export interface CodexChatGptAccount {
	type: "chatgpt";
	email: string | null;
	planType: string;
}

export interface CodexApiKeyAccount {
	type: "apiKey";
}

export interface CodexBedrockAccount {
	type: "amazonBedrock";
	credentialSource?: string;
}

export type CodexAccount = CodexChatGptAccount | CodexApiKeyAccount | CodexBedrockAccount;

export interface CodexAccountResponse {
	account: CodexAccount | null;
	requiresOpenaiAuth: boolean;
}

export interface CodexReasoningEffortOption {
	reasoningEffort: string;
	description: string;
}

export interface CodexModel {
	id: string;
	model: string;
	displayName: string;
	description: string;
	hidden: boolean;
	supportedReasoningEfforts: CodexReasoningEffortOption[];
	defaultReasoningEffort: string;
	inputModalities: string[];
	isDefault: boolean;
	serviceTiers?: Array<{ id: string; name: string; description: string }>;
	defaultServiceTier?: string | null;
}

export interface CodexModelListResponse {
	data: CodexModel[];
	nextCursor: string | null;
}

export interface CodexTokenUsageBreakdown {
	totalTokens: number;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
}

export interface CodexThreadTokenUsage {
	total: CodexTokenUsageBreakdown;
	last: CodexTokenUsageBreakdown;
	modelContextWindow: number | null;
}

export interface CodexRateLimitWindow {
	usedPercent: number;
	windowDurationMins: number | null;
	resetsAt: number | null;
}

export interface CodexRateLimitSnapshot {
	limitId: string | null;
	limitName: string | null;
	primary: CodexRateLimitWindow | null;
	secondary: CodexRateLimitWindow | null;
	planType: string | null;
	rateLimitReachedType: string | null;
}

export interface CodexRateLimitsResponse {
	rateLimits: CodexRateLimitSnapshot;
	rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot> | null;
}

export interface CodexThreadStartResponse {
	thread: { id: string; ephemeral: boolean; historyMode?: "legacy" | "paginated" };
	model: string;
	modelProvider: string;
}

export type CodexThreadResumeResponse = CodexThreadStartResponse;

export interface CodexTurnStartResponse {
	turn: { id: string; status: string };
}

export interface CodexLoginStartResponse {
	type: "chatgpt" | "chatgptDeviceCode";
	loginId: string;
	authUrl?: string;
	verificationUrl?: string;
	userCode?: string;
}

export interface CodexTurnCompletedParams {
	threadId: string;
	turn: {
		id: string;
		status: "completed" | "interrupted" | "failed";
		error: { message?: string } | null;
	};
}

export interface CodexThreadTurnSnapshot {
	id: string;
	status: "completed" | "interrupted" | "failed" | "inProgress";
	error: { message?: string } | null;
	items: Array<Record<string, unknown>>;
}

export interface CodexThreadReadResponse {
	thread: {
		id: string;
		path?: string | null;
		ephemeral?: boolean;
		status?: { type?: string };
		turns?: CodexThreadTurnSnapshot[];
	};
}

export interface CodexItemNotificationParams {
	threadId: string;
	turnId: string;
	item: Record<string, unknown>;
}

export interface CodexAgentMessageDeltaParams {
	threadId: string;
	turnId: string;
	itemId: string;
	delta: string;
}

export interface CodexReasoningDeltaParams {
	threadId: string;
	turnId: string;
	itemId: string;
	delta: string;
}

export interface CodexTokenUsageParams {
	threadId: string;
	turnId: string;
	tokenUsage: CodexThreadTokenUsage;
}

export interface CodexLoginCompletedParams {
	loginId: string | null;
	success: boolean;
	error: string | null;
}
