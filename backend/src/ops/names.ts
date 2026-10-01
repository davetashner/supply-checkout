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

/**
 * The most closed teams one purge run lists to end their Stripe
 * subscriptions, the soonest due first. Teams it sets aside for a person
 * (supply-checkout-8jc.17) aren't listed, so they can't fill it; a run that
 * lists this many logs a warning.
 */
export const CLOSED_TEAMS_TO_END_PER_RUN = 100;

/**
 * A closed team still there this long after its deletion date is overdue:
 * the purge's gauge (ClosedTeamsOverdue) counts them, and the "Deletion
 * overdue" alarm fires on any. A day leaves room for 24 hourly runs to have
 * tried it, well inside the privacy policy's promise.
 */
export const PURGE_OVERDUE_AFTER_HOURS = 24;

/**
 * No ClosedTeamsOverdue sample from the purge for this long alarms ("Deletion
 * job not running"): three hourly runs missed, so one slow or skipped run
 * doesn't page anyone.
 */
export const PURGE_SILENT_ALARM_HOURS = 3;

/**
 * How often the schedule rewrites the operator audit watch's heartbeat item
 * (OPERATOR_AUDIT_HEARTBEAT in data/schema.ts), and how long without one the
 * watch reads before "Operator audit watch silent" fires: two missed
 * heartbeats, so one late write doesn't page anyone.
 */
export const HEARTBEAT_EVERY_MINUTES = 10;
export const HEARTBEAT_SILENT_ALARM_MINUTES = 30;

/**
 * How often the operator group watch compares the operators group with what
 * it saw last (supply-checkout-3sv.5), and how long without a finished run
 * before "Operator group watch silent" fires: three missed runs.
 */
export const GROUP_WATCH_EVERY_MINUTES = 5;
export const GROUP_WATCH_SILENT_ALARM_MINUTES = 15;

/** The SSM parameter where the operator group watch keeps the group as it last saw it. */
export const operatorGroupSnapshotParameter = (envName: string) => `/supply-checkout/${envName}/observability/operator-group-snapshot`;

/** What the CDK app puts in that parameter; the watch counts finding it as a reset, which pages (supply-checkout-3sv.5). */
export const INITIAL_GROUP_SNAPSHOT = "none";

/**
 * When the nightly seat reconciliation runs (supply-checkout-l50): 07:00 UTC,
 * the small hours in the US. It queues one seat sync per open team with a
 * Stripe customer on the seat sync queue (billing/seats.ts), in batches of
 * SEAT_RECONCILE_BATCH, the most SQS takes in one call.
 */
export const SEAT_RECONCILE_HOUR_UTC = 7;
export const SEAT_RECONCILE_BATCH = 10;

/**
 * No SeatReconcileTeams sample for this many days alarms ("Seat
 * reconciliation not running"): two nightly runs missed.
 */
export const SEAT_RECONCILE_SILENT_ALARM_DAYS = 2;

/** Functions the observability stack names. */
export const opsResourceNames = (envName: string) => ({
  stuckImportsFunction: `supply-checkout-${envName}-stuck-imports`,
  emailQuotaFunction: `supply-checkout-${envName}-email-quota`,
  teamPurgeFunction: `supply-checkout-${envName}-team-purge`,
  operatorAuditWatchFunction: `supply-checkout-${envName}-operator-audit-watch`,
  deletionRecordsWatchFunction: `supply-checkout-${envName}-deletion-records-watch`,
  operatorGroupWatchFunction: `supply-checkout-${envName}-operator-group-watch`,
  seatReconcileFunction: `supply-checkout-${envName}-seat-reconcile`,
});

/** Environment variables the checks read. */
export const OPS_ENV = {
  /** The app table (the stuck-import check and the team purge). */
  tableName: "TABLE_NAME",
  /** The operator pool (the operator group watch). */
  opsUserPoolId: "OPS_USER_POOL_ID",
  /** The operator group watch's SSM parameter. */
  groupSnapshotParameter: "GROUP_SNAPSHOT_PARAMETER",
  /** The seat sync queue's URL (the seat reconciliation). */
  seatQueueUrl: "SEAT_QUEUE_URL",
} as const;
