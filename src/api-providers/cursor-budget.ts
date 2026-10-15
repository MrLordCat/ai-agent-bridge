import type { FetchImplementation } from "../transport/openai-http";
import type { ApiProviderBalanceInfo } from "./balance";

export interface CursorBudgetAccess { adminApiKey?: string; userEmail?: string }
const dollars = (value: number): string => `$${value.toFixed(2)}`;
const amount = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const email = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;

class BudgetHttpError extends Error { constructor(readonly status: number) { super(`Cursor budget API: HTTP ${status}`); } }

function unavailable(summary: string, detail: string): ApiProviderBalanceInfo {
	return { label: "Budget", summary, tooltip: `${detail}\nClick to refresh, configure Admin API access, select the budget user, or open Cursor's usage dashboard.`, rows: [] };
}

async function request(endpoint: string, authorization: string, fetchImpl: FetchImplementation, body?: unknown): Promise<Record<string, unknown>> {
	const response = await fetchImpl(endpoint, {
		method: body === undefined ? "GET" : "POST",
		headers: { Authorization: authorization, Accept: "application/json", "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5_000), redirect: "error",
	});
	if (!response.ok) { throw new BudgetHttpError(response.status); }
	const json: unknown = await response.json();
	if (!json || typeof json !== "object" || Array.isArray(json)) { throw new Error("Invalid Cursor budget response"); }
	return json as Record<string, unknown>;
}

/** Admin API reports enforced on-demand spending limits, not a prepaid balance. */
export async function fetchCursorBudget(apiKey: string, access: CursorBudgetAccess = {}, fetchImpl: FetchImplementation = fetch): Promise<ApiProviderBalanceInfo> {
	try {
		let userEmail = email(access.userEmail);
		if (!userEmail) {
			if (!apiKey) { return unavailable("Select a user", "Select the team member's email for this budget in Budget access."); }
			const identity = await request("https://api.cursor.com/v1/me", `Bearer ${apiKey}`, fetchImpl);
			userEmail = email(identity.userEmail);
		}
		if (!userEmail) { return unavailable("Select a user", "This API key does not identify a team member. Select the budget user's email."); }
		const adminKey = access.adminApiKey ?? apiKey;
		if (!adminKey) { return unavailable("Admin access required", "Cursor team budgets require an API key with Admin API access."); }
		const body = await request("https://api.cursor.com/teams/spend", `Basic ${Buffer.from(`${adminKey}:`).toString("base64")}`, fetchImpl, { searchTerm: userEmail, page: 1, pageSize: 100 });
		if (!Array.isArray(body.teamMemberSpend)) { return unavailable("Unavailable", "Cursor returned no valid team spending data."); }
		const member = body.teamMemberSpend.find((item): item is Record<string, unknown> => !!item && typeof item === "object" && email((item as Record<string, unknown>).email) === userEmail);
		if (!member) { return unavailable("User not found", "No exact email match was found in this key's team. Select the budget user or check Admin API access."); }
		const spendCents = amount(member.spendCents);
		if (spendCents === undefined) { return unavailable("Unavailable", "Cursor did not report a valid current-cycle spend for this user."); }
		const used = spendCents / 100;
		const monthly = amount(member.monthlyLimitDollars), override = amount(member.hardLimitOverrideDollars);
		const fallback = [monthly, override && override > 0 ? override : undefined].filter((value): value is number => value !== undefined);
		const limit = amount(member.effectivePerUserLimitDollars) ?? (fallback.length ? Math.min(...fallback) : undefined);
		const remaining = limit === undefined ? undefined : Math.max(0, limit - used);
		const overall = amount(member.overallSpendCents);
		const period = typeof body.subscriptionCycleStart === "number" ? new Date(body.subscriptionCycleStart) : undefined;
		const tooltip = [
			`Cursor team spending budget for ${userEmail}.`,
			`Used: ${dollars(used)} in on-demand charges during the current billing cycle.`,
			limit === undefined ? "The API did not report an enforced spending limit." : `Enforced limit: ${dollars(limit)}. Remaining: ${dollars(remaining!)}.`,
			limit !== undefined && used > limit ? `Over budget by ${dollars(used - limit)}.` : undefined,
			overall === undefined ? undefined : `Total usage including included credits: ${dollars(overall / 100)}.`,
			period && Number.isFinite(period.getTime()) ? `Billing cycle started: ${period.toLocaleDateString()}.` : undefined,
			"This is the current team spending cap; included subscription credits are reported separately.",
			"Updates every minute. Click for budget access and refresh actions.",
		].filter(Boolean).join("\n");
		return {
			usage: { kind: "spendingCap", currency: "USD", used, limit, totalUsage: overall === undefined ? undefined : overall / 100, periodStart: period && Number.isFinite(period.getTime()) ? period.getTime() : undefined, origin: "Cursor Admin API" },
			label: "Budget", summary: remaining === undefined ? `${dollars(used)} used · limit not reported` : `${dollars(remaining)} left`, tooltip,
			rows: [
				{ id: "used", label: "Used", summary: dollars(used), tooltip: "On-demand charges in the current Cursor billing cycle." },
				{ id: "limit", label: "Limit", summary: limit === undefined ? "Not reported" : dollars(limit), tooltip: "The enforced per-user spending limit reported by Cursor." },
				...(overall === undefined ? [] : [{ id: "total", label: "Total usage", summary: dollars(overall / 100), tooltip: "Total spend including included subscription usage, reported separately from the on-demand spending cap." }]),
			],
		};
	} catch (error) {
		if (error instanceof BudgetHttpError && (error.status === 401 || error.status === 403)) { return unavailable("Admin access required", "The saved key cannot read this team budget. Configure a Cursor Admin API key for budgets; the chat key remains separate."); }
		if (error instanceof BudgetHttpError && error.status === 429) { return unavailable("Rate limited", "Cursor temporarily rate-limited budget requests. Retry after the next refresh."); }
		return unavailable("Unavailable", "The Cursor budget service could not be reached or returned invalid data. Refresh to retry.");
	}
}