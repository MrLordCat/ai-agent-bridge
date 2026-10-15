import type { ProviderRuntimeMetrics } from "../provider-metrics";
import type { ProviderState, ProviderStatusEntry } from "./provider-directory";

export type ProviderUsage =
	| { kind: "spendingCap"; currency: string; used: number; limit?: number; totalUsage?: number; periodStart?: number; periodEnd?: number; origin: string }
	| { kind: "monthlyUsage"; currency: string; used: number; limit?: number; included?: number; onDemand?: number; resetAt?: number; origin: string }
	| { kind: "creditsBalance"; currency: string; remaining: number; origin: string }
	| { kind: "rollingQuota"; usedPercent: number; resetAt?: number; origin: string };

export interface ProviderSnapshot {
	sourceId: string; label: string; state: ProviderState; summary: string;
	metrics?: ProviderRuntimeMetrics; accountSummary?: string; usage?: ProviderUsage;
}

export function providerUsageSummary(usage: ProviderUsage): string {
	const money = (amount: number, currency: string) => `${currency === "USD" ? "$" : `${currency} `}${amount.toFixed(2)}`;
	switch (usage.kind) {
		case "spendingCap": return usage.limit === undefined ? `${money(usage.used, usage.currency)} used · limit not reported` : `${money(Math.max(0, usage.limit - usage.used), usage.currency)} left`;
		case "monthlyUsage": return usage.limit === undefined ? `${money(usage.used, usage.currency)} used` : `${money(usage.used, usage.currency)} / ${money(usage.limit, usage.currency)}`;
		case "creditsBalance": return `${money(usage.remaining, usage.currency)} remaining`;
		case "rollingQuota": return `${usage.usedPercent.toFixed(1)}% used`;
	}
}

export function providerSnapshots(entries: readonly ProviderStatusEntry[], metrics: ReadonlyMap<string, ProviderRuntimeMetrics>, accounts: ReadonlyMap<string, string> = new Map()): ReadonlyMap<string, ProviderSnapshot> {
	return new Map(entries.map(entry => [entry.key, {
		sourceId: entry.key, label: entry.label, state: entry.state, summary: entry.detail,
		metrics: metrics.get(entry.key === "primary" ? "local" : entry.key), accountSummary: accounts.get(entry.key),
	}]));
}