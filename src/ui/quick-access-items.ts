import * as vscode from "vscode";
import { formatProviderCache, formatProviderContext, formatProviderTokens, type ProviderRuntimeMetrics } from "../provider-metrics";

export interface QuickAccessItemOptions {
	description?: string;
	command?: vscode.Command;
	icon?: vscode.ThemeIcon;
	tooltip?: string;
	children?: QuickAccessItem[];
	expanded?: boolean;
}

export class QuickAccessItem extends vscode.TreeItem {
	readonly children?: QuickAccessItem[];
	constructor(id: string, label: string, options: QuickAccessItemOptions = {}) {
		const group = Boolean(options.children?.length);
		super(label, group ? options.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		this.id = `llamacpp.quickAccess.${id}`;
		this.description = options.description;
		this.command = options.command;
		this.iconPath = options.icon;
		this.tooltip = options.tooltip;
		this.children = options.children;
		this.contextValue = group ? "llamacpp.quickAccessGroup" : "llamacpp.quickAction";
	}
}

export function command(command: string, title: string): vscode.Command { return { command, title }; }

export function toggleIcon(enabled: boolean): vscode.ThemeIcon {
	return new vscode.ThemeIcon(enabled ? "pass-filled" : "circle-slash", new vscode.ThemeColor(enabled ? "testing.iconPassed" : "disabledForeground"));
}

/** Provider cards and Token Usage share labels, precision and optional throughput. */
export function runtimeMetricItems(id: string, metrics: ProviderRuntimeMetrics | undefined, openCommand?: vscode.Command, contextKey = "context"): QuickAccessItem[] {
	const running = metrics?.phase === "running";
	const precision = metrics?.estimated ? "Estimated values; updated when the provider reports usage" : "Provider-reported values";
	const items = [
		new QuickAccessItem(`${id}.tokens`, running ? "Tokens (live)" : "Tokens (last)", {
			description: formatProviderTokens(metrics), icon: new vscode.ThemeIcon("symbol-numeric"), command: openCommand,
			tooltip: running ? `Input and output tokens for the active request. ${precision}` : "Input and output tokens for the last completed request",
		}),
		new QuickAccessItem(`${id}.cache`, "Prompt Cache", {
			description: formatProviderCache(metrics), icon: new vscode.ThemeIcon("database"), command: openCommand,
			tooltip: running ? `Cache-read tokens for the active request. ${precision}` : "Cache-read tokens divided by input tokens for the last completed request",
		}),
		new QuickAccessItem(`${id}.${contextKey}`, "Context", {
			description: formatProviderContext(metrics), icon: new vscode.ThemeIcon("pie-chart"), command: openCommand,
			tooltip: [metrics?.contextDetail, running ? precision : undefined].filter(Boolean).join(". ") || "Current context usage and the provider-reported model window",
		}),
	];
	if (metrics?.throughputTokensPerSecond !== undefined) {
		items.push(new QuickAccessItem(`${id}.throughput`, "Throughput", { description: `${metrics.throughputTokensPerSecond.toFixed(1)} tok/s`, icon: new vscode.ThemeIcon("dashboard"), command: openCommand }));
	}
	return items;
}