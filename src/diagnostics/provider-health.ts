export type HealthCheckStatus = "pass" | "warning" | "fail" | "info";

export interface HealthCheckItem {
	id: string;
	label: string;
	status: HealthCheckStatus;
	detail: string;
}

export interface ProviderHealthSourceReport {
	key: string;
	label: string;
	serverUrl: string;
	modelIds: string[];
	checks: HealthCheckItem[];
}

export interface ProviderHealthReport {
	generatedAt: string;
	extensionVersion: string;
	vscodeVersion: string;
	overallStatus: Exclude<HealthCheckStatus, "info">;
	configurationChecks: HealthCheckItem[];
	sources: ProviderHealthSourceReport[];
}

export function calculateOverallHealth(items: readonly HealthCheckItem[]): ProviderHealthReport["overallStatus"] {
	if (items.some(item => item.status === "fail")) {
		return "fail";
	}
	if (items.some(item => item.status === "warning")) {
		return "warning";
	}
	return "pass";
}


