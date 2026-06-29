export const DEFAULT_ENV_SOURCE = ".env";
export const DEFAULT_ENV_FALLBACK = ".env.example";
export const DEFAULT_REVIEW_LABEL = "agent:review";
export const DEFAULT_SERVICE_TIMEOUT_MS = 15_000;
// Conservative default for parallel issue provisioning. Port picks are race-safe
// (in-process semaphore + cross-process reservations), so this just caps how many
// worktrees set up at once. Ship a small constant rather than auto-detecting N.
export const DEFAULT_LAUNCH_CONCURRENCY = 4;
