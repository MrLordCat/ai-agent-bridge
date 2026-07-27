type SubagentProvider = "local" | "deepseek" | "codex" | "claude";

export interface SubagentModelProfile {
	id: string;
	label: string;
	provider: SubagentProvider;
	defaultEffort?: string;
	useWhen: string;
	availability?: "available" | "unavailable" | "unknown";
	availabilityReason?: string;
	availabilityCheckedAt?: number;
	unavailableUntil?: string;
}

const catalogs = new Map<SubagentProvider, SubagentModelProfile[]>();
const excludedSubagentModels = new Map<SubagentProvider, ReadonlySet<string>>([
	["codex", new Set(["gpt-5.6-sol"])],
]);

function isEligibleSubagentProfile(profile: SubagentModelProfile): boolean {
	const modelId = profile.id.toLowerCase().split("::").at(-1) ?? profile.id.toLowerCase();
	return !excludedSubagentModels.get(profile.provider)?.has(modelId);
}

export function setSubagentModelProfiles(
	provider: SubagentProvider,
	profiles: readonly SubagentModelProfile[]
): void {
	const unique = new Map(profiles
		.filter(isEligibleSubagentProfile)
		.map(profile => [profile.id, profile]));
	catalogs.set(provider, [...unique.values()].sort((left, right) => left.label.localeCompare(right.label)));
}

export function getSubagentModelProfiles(): SubagentModelProfile[] {
	return ["local", "deepseek", "codex", "claude"]
		.flatMap(provider => catalogs.get(provider as SubagentProvider) ?? []);
}

function isSubagentToolName(name: string): boolean {
	const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
	return normalized === "runsubagent"
		|| normalized === "executionsubagent"
		|| normalized === "exploresubagent";
}

interface ToolWithInputSchema {
	name: string;
	inputSchema?: object;
}

/**
 * Makes subagent model routing explicit at schema level. Description-only guidance
 * is not reliable enough for local and subscription models, which may otherwise
 * omit `model` and silently inherit the expensive parent model.
 */
export function withRequiredSubagentModel<T extends ToolWithInputSchema>(definition: T): T {
	if (!isSubagentToolName(definition.name)) {
		return definition;
	}
	const sourceSchema = definition.inputSchema && typeof definition.inputSchema === "object"
		? definition.inputSchema as Record<string, unknown>
		: {};
	const sourceProperties = sourceSchema.properties && typeof sourceSchema.properties === "object"
		? sourceSchema.properties as Record<string, unknown>
		: {};
	const modelSchema = sourceProperties.model && typeof sourceProperties.model === "object"
		? sourceProperties.model
		: {
			type: "string",
			description: "Exact model-picker label from the advertised subagent catalog.",
		};
	const required = Array.isArray(sourceSchema.required)
		? sourceSchema.required.filter((value): value is string => typeof value === "string")
		: [];

	return {
		...definition,
		inputSchema: {
			...sourceSchema,
			type: "object",
			properties: { ...sourceProperties, model: modelSchema },
			required: [...new Set([...required, "model"])],
		},
	} as T;
}

function buildBudgetRoutingPolicy(profiles: readonly SubagentModelProfile[]): string {
	const has = (provider: SubagentProvider): boolean => profiles.some(profile => profile.provider === provider);
	const tiers: string[] = [];
	if (has("local")) {
		tiers.push("cheapest — local models (e.g. Qwen 3.6 27B) for narrow, mechanical, independently verifiable subtasks (workspace search, single-file reads, grep triage, format/lint checks, visual inspection, and verifying another model's output). Local models have no token or rate limits — prefer them for any task they can handle reliably");
	}
	if (has("deepseek")) {
		tiers.push("mid — DeepSeek (e.g. DeepSeek V4 Pro) for focused multi-step reasoning a local model cannot complete reliably, code analysis across files, and architecture decisions");
	}
	if (has("codex") || has("claude")) {
		const premiumModels: string[] = [];
		if (has("claude")) {
			premiumModels.push("Claude Opus 5");
		}
		if (has("codex")) {
			premiumModels.push("GPT-5.6 Luna/Terra (Sol is excluded from subagent use to conserve premium quota)");
		}
		tiers.push(`premium — ${premiumModels.join(" and ")} subscription models only for repository-wide, cross-file, or high-stakes reasoning the cheaper tiers cannot satisfy, because they consume limited subscription budget`);
	}
	if (tiers.length <= 1) {
		return "";
	}
	return `Budget routing policy — pick the cheapest capable tier and escalate only when it is genuinely insufficient: ${tiers.join("; ")}.`;
}

let _cachedGuidance: string | undefined;
let _cachedProfileIds: string | undefined;

export function buildSubagentToolGuidance(): string {
	const profiles = getSubagentModelProfiles();
	const profileIds = profiles.map(p => p.id).join(",");
	if (_cachedGuidance !== undefined && _cachedProfileIds === profileIds) {
		return _cachedGuidance;
	}
	_cachedProfileIds = profileIds;
	const hasLocal = profiles.some(profile => profile.provider === "local");
	const profileText = profiles.length > 0
		? profiles.map(profile => {
			const effort = profile.defaultEffort ? `, ${profile.defaultEffort} thinking` : "";
			return `model="${profile.label}"${effort}: ${profile.useWhen}.`;
		}).join(" ")
		: `model="Qwen 3.6 27B (Local)": narrow economical tasks, visual inspection, unlimited tokens. model="DeepSeek V4 Pro (DeepSeek)", high thinking: focused complex multi-step reasoning. model="GPT-5.6 Luna (Codex)", high thinking: repository-wide coding (Sol excluded from subagents to conserve premium quota). model="Opus 5 (Claude)", high thinking: highest-capability complex analysis.`;
	const budgetPolicy = buildBudgetRoutingPolicy(profiles);
	const visionDelegation = hasLocal
		? "Vision delegation: when you need visual inspection (screenshots, UI layouts, images, Unity scene captures) that you cannot see directly, delegate to a local-model subagent. The subagent has access to view_image and terminal tools — it can capture screenshots, inspect images, and report what it sees. Use agentName 'Explore' or any available agent type with a local model — the agent type does not limit which tools the subagent can use."
		: "";
	const guidance = [
		"Subagent model routing (use model= value exactly as shown):",
		profileText,
		...(budgetPolicy ? [budgetPolicy] : []),
		...(visionDelegation ? [visionDelegation] : []),
		"Mandatory: set runSubagent.model to one of the quoted model= strings listed above, e.g. `\"GPT-5.6 Luna (Codex)\"`. Copy the exact string inside the quotes — do NOT guess or paraphrase. Never omit runSubagent.model.",
		"Availability is enforced when the subagent starts; if the selected model is rejected, route to another available model from this catalog.",
		"Qwen 3.6 27B runs locally with unlimited tokens and no rate limits — prefer it for any subagent task it can handle, especially large-output operations like log analysis, full-file reads, and exhaustive search.",
		"agentName selects behaviour/custom instructions independently of model.",
		"Require one bounded, independently verifiable task, explicit allowed files, and expected output.",
	].join(" ");
	_cachedGuidance = guidance;
	return guidance;
}

export function enhanceSubagentToolDescription(name: string, description: string): string {
	if (!isSubagentToolName(name)) {
		return description;
	}
	return `${description}\n\n${buildSubagentToolGuidance()}`;
}
