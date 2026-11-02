/**
 * A provider with an empty balance answers every request with 402 Payment
 * Required (or an "insufficient balance" body). Nothing about the request is
 * wrong, so retrying cannot help: this module turns the failure into one short
 * notice the user can act on, and the chat request finishes instead of failing.
 */

export interface BalanceFailure {
	/** Human-readable provider name shown to the user, e.g. "DeepSeek". */
	providerLabel: string;
	status?: number;
	/** Short provider detail (for example "Insufficient Balance"), already bounded. */
	detail?: string;
}

const BALANCE_PATTERNS: readonly RegExp[] = [
	/insufficient\s+(?:balance|credit|credits|funds|quota|token)/i,
	/payment\s+required/i,
	/credit balance is too low/i,
	/exceeded your current quota/i,
	/billing\s+(?:hard limit|issue|not active)/i,
	/no (?:remaining )?credits?\b/i,
	/余额不足/,
];
/** Context and payload limits are not a balance problem. */
const NOT_A_BALANCE_FAILURE = /context (?:length|window)|maximum length|too many tokens|input exceeds/i;
const MAX_DETAIL_CHARS = 160;

function extractDetail(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	const trimmed = text.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(trimmed) as { error?: { message?: unknown }; message?: unknown };
		const message = parsed.error?.message ?? parsed.message;
		if (typeof message === "string" && message.trim()) {
			return message.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL_CHARS);
		}
	} catch {
		// Not JSON: fall back to the plain text.
	}
	return trimmed.replace(/\s+/g, " ").slice(0, MAX_DETAIL_CHARS);
}

/** Detects an empty-balance response from an HTTP status and the response body. */
export function detectBalanceFailure(
	status: number | undefined,
	errorText: string | undefined,
	providerLabel: string
): BalanceFailure | undefined {
	const text = errorText ?? "";
	if (NOT_A_BALANCE_FAILURE.test(text)) {
		return undefined;
	}
	const matched = status === 402 || BALANCE_PATTERNS.some(pattern => pattern.test(text));
	if (!matched) {
		return undefined;
	}
	const detail = extractDetail(text);
	return {
		providerLabel,
		...(status !== undefined ? { status } : {}),
		...(detail ? { detail } : {}),
	};
}

/** Detects a balance failure that escaped as an error object. */
export function detectBalanceError(error: unknown, providerLabel?: string): BalanceFailure | undefined {
	if (error instanceof ProviderBalanceError) {
		return error.failure;
	}
	const message = error instanceof Error
		? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`
		: String(error);
	const status = /(\b402\b)|\bpayment required\b/i.test(message) ? 402 : undefined;
	const label = providerLabel
		?? (/deepseek/i.test(message) ? "DeepSeek"
			: /cursor/i.test(message) ? "Cursor"
				: /claude/i.test(message) ? "Claude"
					: /codex|chatgpt/i.test(message) ? "Codex"
						: "Provider");
	return detectBalanceFailure(status, message, label);
}

export function formatBalanceNotice(failure: BalanceFailure): string {
	const detail = failure.detail && !/llama\.?cpp api error/i.test(failure.detail)
		&& failure.detail.length <= 120
		? ` (${failure.detail.replace(/[.]+$/, "")})`
		: "";
	return `${failure.providerLabel} balance is empty${detail}. `
		+ "Top up the account, then send the message again. No retry was made.";
}

/** Thrown where the HTTP status is known, caught once and reported as text. */
export class ProviderBalanceError extends Error {
	constructor(readonly failure: BalanceFailure) {
		super(formatBalanceNotice(failure));
		this.name = "ProviderBalanceError";
	}
}
