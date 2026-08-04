export const PROVIDER_DURABLE_SESSION_TTL_MS = 7 * 24 * 60 * 60_000;

/** How long an in-memory provider session stays alive without user activity. */
export const PROVIDER_ACTIVE_SESSION_IDLE_MS = 24 * 60 * 60_000;

/** How long a suspended native-tool continuation may wait before it is dropped. */
export const PROVIDER_CONTINUATION_TTL_MS = 24 * 60 * 60_000;

/** How long an armed "Continue Latest" rollover intent stays valid. */
export const PROVIDER_PENDING_ROLLOVER_TTL_MS = 24 * 60 * 60_000;