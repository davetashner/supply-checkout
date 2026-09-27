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

/** Functions the observability stack names. */
export const opsResourceNames = (envName: string) => ({
  stuckImportsFunction: `supply-checkout-${envName}-stuck-imports`,
  emailQuotaFunction: `supply-checkout-${envName}-email-quota`,
});

/** Environment variables the checks read. */
export const OPS_ENV = {
  /** The app table (the stuck-import check). */
  tableName: "TABLE_NAME",
} as const;
