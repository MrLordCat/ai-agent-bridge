/**
 * Set by the composite provider when a different model served the chat last. The
 * receiving provider must start from the shared transcript: its own live or saved
 * session predates the other model's work and any compaction it did.
 */
export const PROVIDER_SWITCH_OPTION = "_aabProviderSwitched";

export function isProviderSwitch(modelOptions: Readonly<Record<string, unknown>> | undefined): boolean {
	return typeof modelOptions?.[PROVIDER_SWITCH_OPTION] === "string";
}
