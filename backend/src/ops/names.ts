// Names the scheduled operations checks and the CDK app share
// (infra/lib/observability/ops-checks.ts imports this file), so the functions,
// their schedule and the alarms that read their metrics can't drift apart.
// No imports.

/** How often each check runs. The alarms on their gauges read 15-minute periods. */
export const CHECK_EVERY_MINUTES = 10;

/** An import still committing this long after it started is stuck (a healthy one takes seconds). */
export const STUCK_IMPORT_AFTER_MINUTES = 60;

/** The most stuck imports one run logs by ID; the gauge counts them all. */
export const MAX_LOGGED_STUCK_IMPORTS = 25;

/**
 * How often the closed-team purge runs. A team is deleted within this long
 * after its read-only period ends, and a run that stops part-way (a big team,
 * the timeout) carries on at the next.
 */
export const PURGE_EVERY_HOURS = 1;

/** How long one purge run may start new teams for; the function's timeout is a minute more. */
export const PURGE_BUDGET_MS = 4 * 60_000;

/** Functions the observability stack names. */
export const opsResourceNames = (envName: string) => ({
  stuckImportsFunction: `supply-checkout-${envName}-stuck-imports`,
  emailQuotaFunction: `supply-checkout-${envName}-email-quota`,
  teamPurgeFunction: `supply-checkout-${envName}-team-purge`,
});

/** Environment variables the checks read. */
export const OPS_ENV = {
  /** The app table (the stuck-import check and the team purge). */
  tableName: "TABLE_NAME",
} as const;
