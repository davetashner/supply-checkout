// The closed-team purge (supply-checkout-b1h), run on a schedule in the
// primary region.
//
// An owner closing a team (data/teams.ts, closeTeam) leaves it read-only for
// CLOSED_TEAM_RETENTION_DAYS, so it can be exported, and lists it in GSI1's
// closed-teams partition by when it's due. Each run reads the teams that are
// due, earliest first, and deletes each one (data/team-purge.ts): its whole
// partition, its members' team-switcher rows and its Stripe link, the META
// item last. It starts no new team after PURGE_BUDGET_MS, and a team it
// didn't finish (the timeout) is still listed, so the next run carries on.
// One team's failure is logged and counted, and the others still go.
// Every run that could read the index, even one where teams fail, sends the
// ClosedTeamsOverdue gauge: the closed teams still there
// PURGE_OVERDUE_AFTER_HOURS after their deletion date, so the privacy
// deadline has its own alarm. It's counted with a count query on the index
// (countTeamsDueBefore), not from the listing, so it isn't capped at the
// listing's limit. A run that can't read the index sends no gauge, and
// neither does a purge that doesn't run at all: "Deletion job not running"
// alarms when the gauge's samples stop.
//
// Before deleting a team, it writes the team's deletion record (the team ID,
// the time, and its Stripe customer and subscription IDs, deletions/records.ts),
// so a restore from an older backup can delete it again, and its Stripe
// customer can still be found once the table's link to it is gone; a team
// whose record can't be written isn't deleted this run.
//
// Then, for a team with a Stripe customer, it deletes the customer in Stripe
// (billing/closing.ts, deleteStripeCustomer): its name, email, address and
// cards, and any subscription still on it. The team's data is deleted on
// schedule even when Stripe can't do that (supply-checkout-8jc.42, the
// owner's decision on supply-checkout-8jc.19: the deletion deadline never
// depends on Stripe being up). On any failure (Stripe down, a timeout, a rate
// limit, a key that can't be read) it queues the customer's deletion in the
// table (data/stripe-deletions.ts: the team and customer IDs and when) before
// any of the team's items go, counts it (StripeCustomerDeletionsQueued) and
// purges the team; only a queue entry that can't be written leaves the team
// for the next run. After STRIPE_FAILURES_BEFORE_QUEUEING failures in a row it
// stops calling Stripe for the rest of the run and queues straight away, so an
// outage's timeouts can't slow the purge. A held team purged after its grace
// period (below) goes the same way. After the purge, every run retries the
// queued deletions, oldest first, within the same budget, removing each one
// Stripe confirms, and sends two gauges: how many are still queued
// (StripeCustomerDeletionsPending) and how long the oldest has waited
// (StripeCustomerDeletionOldestHours, "Stripe customer deletion retrying" at a
// day, P2, and "stuck" at a week, P1). The team's deletion record keeps the
// same Stripe IDs for 400 days, so the customer can be found by hand from it.
// A queue that can't be read or cleared fails the run. A customer
// Stripe says is already gone is taken as deleted (a run that stopped after
// deleting it), but it's also what a Stripe key or mode mismatch looks like,
// with the real customer and any subscription left alone, so it's warned of
// and counted (StripeCustomersAlreadyDeleted, the "Stripe customer already
// deleted" alarm, supply-checkout-8jc.37).
//
// A team set aside for its current closure (below) isn't purged until a
// person deals with it (supply-checkout-8jc.37), or until HELD_PURGE_GRACE_DAYS
// after its deletion date (supply-checkout-8jc.40): listTeamsToPurge leaves it
// out and purgeTeam holds it, so a subscription Stripe couldn't find (maybe
// the same mismatch) isn't followed straight away by deleting the team. A held
// team past its deletion date still counts in ClosedTeamsOverdue: its data is
// being kept past the date its owners were told, so "Deletion overdue" fires
// for it too, and the responder clears the set-aside so the purge can run.
// Each run also logs how many held teams are past that line ("Closed teams
// held past their deletion date"). Once the grace period is over, both list
// and purge it like any other team (the owner's decision: its data isn't kept
// indefinitely), its Stripe IDs kept in its deletion record, and the run logs
// it as an error ("Held team purged with its subscription unresolved", with
// the team ID, the Stripe IDs and the set-aside reason only) and counts it
// (HeldTeamsPurged, its own P2 alarm), so a person ends the subscription by
// hand in Stripe.
//
// Before any purging, each run ends closed teams' Stripe subscriptions
// (supply-checkout-t0en): closing a team doesn't call Stripe, so the closure
// itself is the pending cancellation, and this is where it's carried out and
// retried. For every closed team whose subscription isn't yet recorded as set
// to end for its closure (listClosedTeamsToEnd), it re-reads the team, fetches
// the subscription, sets it to cancel at the period's end (or cancels it, if
// nothing is being paid for; endSubscriptionForClosedTeam), and records that
// (markSubscriptionEnding). It lists at most CLOSED_TEAMS_TO_END_PER_RUN,
// soonest due first, and warns when it lists that many. It starts no new team
// after half of PURGE_BUDGET_MS, so a slow Stripe can't starve the purge. A
// team that fails is logged, left unrecorded for the next run, and fails the
// run (the Functions failing alarm). Three kinds of team are set aside for a
// person instead (markSubscriptionSetAside, with the reason, counted in
// ClosedTeamSubscriptionsSetAside) and left out of later listings, rather
// than failing every run and filling the listing ahead of newer closures
// (supply-checkout-8jc.17, supply-checkout-8jc.36):
// - CustomerMismatch: the subscription belongs to another customer, so it
//   won't ever end here.
// - NotFound: Stripe doesn't have it, also counted
//   (ClosedTeamSubscriptionsNotFound, the "Closed-team subscription not found
//   in Stripe" alarm). Usually it went with its customer, but a Stripe key or
//   mode mismatch looks like that for every team, so it isn't recorded as
//   done: once the key is fixed, removing `stripeSetAsideFor` lists it again.
// - PermanentError: Stripe refused it with an error retrying won't change
//   (isPermanentStripeError: an invalid-request error about the object, never
//   a key, mode, permission, rate-limit or connection error). A bug in our
//   request would get that for every team, so a team is set aside for it only
//   when the same run had Stripe accept the same request (the retrieve, the
//   cancel_at_period_end update or the cancel) for another team; until then
//   it fails the run like any other error and stays listed.
// Every run then counts the teams set aside for their current closure, sends
// the ClosedTeamsSetAside gauge (the "Closed-team subscription set aside"
// alarm, on while it's above 0) and logs up to MAX_LOGGED_SET_ASIDE of them by
// ID; a run that can't count them fails. A subscription that renewed after its team closed
// (the team closed within an hour of a renewal) is logged as a warning and
// counted (ClosedTeamRenewalsCharged, the "Closed team charged" alarm) for a
// refund by hand. A team reopened while Stripe was being called had its
// subscription set to end for a closure that's over, maybe after the
// reopen's resync already ran (billing/reopening.ts, supply-checkout-85qp):
// if the team is open and the subscription was set to cancel at the period's
// end, the purge resumes it at once (resumeSubscription, counted in
// ReopenedTeamSubscriptionsResumed) and warns. Otherwise (cancelled at once,
// closed again, gone, or the resume failed) it's logged as an error, counted
// in ReopenedTeamSubscriptionsEnded, and fails the run. If recording it fails
// after Stripe took the change, the team may have been reopened with nothing
// to see it, so that's counted in ReopenedTeamSubscriptionsEnded too, logged
// as an error, and fails the run (supply-checkout-8jc.30). The billing worker
// usually sets a closed team's subscription to cancel within seconds of the
// closure (billing/worker.ts, endAtClose): the purge then finds it already
// set to cancel for this closure, sends Stripe nothing, and records it.
//
// Logs have team, subscription and customer IDs and counts, never names,
// emails or Stripe's messages. The function's role may delete whole items
// and name only TEAM_PURGE_ATTRIBUTES, put, list and delete the queued Stripe
// customer deletions naming only STRIPE_DELETION_ATTRIBUTES in their one
// partition, and read only the Stripe secret key
// (infra/lib/observability/ops-checks.ts).

import { type ClosingAction, closingAction, customerOf, deleteStripeCustomer, endSubscriptionForClosedTeam, type PurgeStripe, resumeSubscription } from "../billing/closing.js";
import { isPermanentStripeError, stripeErrorFields } from "../billing/stripe.js";
import {
  type ClosedTeamToEnd,
  closedTeamToEnd,
  countTeamsDueBefore,
  type Db,
  isTeamOpen,
  isTeamPurgedOrPurging,
  listClosedTeamsToEnd,
  listSetAsideTeams,
  listStripeCustomerDeletions,
  listTeamsToPurge,
  markSubscriptionEnding,
  markSubscriptionSetAside,
  purgeTeam,
  queueStripeCustomerDeletion,
  removeStripeCustomerDeletion,
  type SetAsideReason,
  type StripeDeletion,
} from "../data/index.js";
import type { DeletionLog } from "../deletions/records.js";
import { BusinessMetric, type Observability, testMark } from "../observability/index.js";
import {
  CLOSED_TEAMS_TO_END_PER_RUN,
  HELD_PURGE_GRACE_DAYS,
  MAX_LOGGED_SET_ASIDE,
  PURGE_BUDGET_MS,
  PURGE_OVERDUE_AFTER_HOURS,
  STRIPE_DELETION_RETRY_ALARM_HOURS,
  STRIPE_FAILURES_BEFORE_QUEUEING,
} from "./names.js";

/** What one run keeps track of across teams. */
interface RunState {
  /** Stripe customer deletions that failed in a row: at STRIPE_FAILURES_BEFORE_QUEUEING, the run stops asking Stripe. */
  stripeFailures: number;
  /** Customer deletions this run queued. */
  queued: number;
}

export interface TeamPurgeDeps {
  readonly db: Db;
  readonly obs: Observability;
  /** Where each team's deletion record goes, before anything of it is deleted (deletions/records.ts). */
  readonly deletions: DeletionLog;
  /** The Stripe client, read from Secrets Manager the first time a team needs it. */
  readonly stripe: () => Promise<PurgeStripe>;
  readonly now?: () => number;
}

const isMissing = (error: unknown) => (error as { code?: unknown } | null)?.code === "resource_missing";
const errorName = (error: unknown) => (error as { name?: string } | null)?.name ?? "Unknown";

/** A Stripe error's safe fields (type, code, status, request ID), and nothing for any other error. */
function stripeFields(error: unknown): Record<string, string | number> {
  const fields = stripeErrorFields(error);
  return "type" in fields ? fields : {};
}

/** A request the purge makes of Stripe for a closed team's subscription. */
type StripeRequest = "retrieve" | Exclude<ClosingAction, "none">;

/** The share of the run's budget ending subscriptions may take before the purge starts. */
const END_BUDGET_MS = PURGE_BUDGET_MS / 2;

export function createTeamPurgeHandler(deps: TeamPurgeDeps) {
  const { db, obs } = deps;
  const now = deps.now ?? Date.now;
  /** Ends closed teams' subscriptions (see the top). Returns how many teams failed. */
  async function endSubscriptions(started: number): Promise<number> {
    let teams;
    try {
      teams = await listClosedTeamsToEnd(db, CLOSED_TEAMS_TO_END_PER_RUN);
    } catch (error) {
      obs.logger.error("Closed teams' subscriptions not listed", { error: errorName(error) });
      return 1;
    }
    // More may be waiting behind these: a backlog the hourly runs should work through, or failures piling up
    if (teams.length >= CLOSED_TEAMS_TO_END_PER_RUN) obs.logger.warn("Closed teams' subscriptions listed at the limit", { listed: teams.length, limit: CLOSED_TEAMS_TO_END_PER_RUN });
    let ended = 0;
    let failed = 0;
    let setAside = 0;
    // Requests Stripe accepted this run, by kind: proof the key, the mode and that request work
    const worked: Record<StripeRequest, number> = { retrieve: 0, cancel_at_period_end: 0, cancel_now: 0 };
    // Teams Stripe refused with an error retrying won't change, and the request it refused: set
    // aside below if the same request worked for another team
    const refused: { team: ClosedTeamToEnd; error: unknown; request: StripeRequest }[] = [];
    /** Sets the team aside for a person, counted. False, logged at info, if it was reopened (or closed again) meanwhile. */
    const setTeamAside = async (team: ClosedTeamToEnd, reason: SetAsideReason): Promise<boolean> => {
      if (!(await markSubscriptionSetAside(db, team, reason))) {
        obs.logger.info("Closed team's subscription not set aside: the team was reopened meanwhile", { teamId: team.teamId, subscriptionId: team.stripeSubscriptionId, reason });
        return false;
      }
      setAside++;
      obs.count(BusinessMetric.ClosedTeamSubscriptionsSetAside, 1, { teamId: team.teamId, reason, ...testMark(team.test) });
      return true;
    };
    for (const listed of teams) {
      if (now() - started > END_BUDGET_MS) break;
      const { teamId } = listed;
      let team: ClosedTeamToEnd | undefined;
      let request: StripeRequest = "retrieve";
      try {
        // The index may lag: the team as it is now, still closed, still not done
        team = await closedTeamToEnd(db, teamId);
        if (!team) continue;
        const stripe = await deps.stripe();
        const sub = await stripe.subscriptions.retrieve(team.stripeSubscriptionId).then(
          (found) => found,
          (error: unknown) => {
            // Gone from Stripe (deleted with its customer, say): nothing left to end
            if (isMissing(error)) return undefined;
            throw error;
          },
        );
        if (sub) worked.retrieve++;
        if (!sub) {
          // Set aside, not recorded as done: a Stripe key or mode mismatch would look like this for every
          // closed team, none cancelled, and once it's fixed a person lists them again. Counted for its own alarm
          if (await setTeamAside(team, "NotFound")) {
            obs.count(BusinessMetric.ClosedTeamSubscriptionsNotFound, 1, { teamId, ...testMark(team.test) });
            obs.logger.warn("Closed team's subscription not found in Stripe", { teamId, subscriptionId: team.stripeSubscriptionId });
          }
          continue;
        }
        if (customerOf(sub) !== team.stripeCustomerId) {
          // Retrying won't change whose it is: set aside for a person, so it isn't
          // listed again ahead of newer closures. Untouched in Stripe
          if (await setTeamAside(team, "CustomerMismatch")) {
            obs.logger.error("Closed team's subscription set aside", { teamId, subscriptionId: team.stripeSubscriptionId, error: "CustomerMismatch" });
          }
          continue;
        }
        const planned = closingAction(sub, team.closedAt);
        if (planned !== "none") request = planned;
        const action = await endSubscriptionForClosedTeam(stripe, sub, team);
        if (action !== "none") worked[action]++;
        // Charged for a period that began after the team closed: a person refunds it
        const periodStart = sub.items.data[0]?.current_period_start;
        if (sub.status === "active" && typeof periodStart === "number" && periodStart * 1000 > Date.parse(team.closedAt)) {
          obs.logger.warn("Closed team's subscription renewed after it closed", { teamId, subscriptionId: sub.id, closedAt: team.closedAt });
          obs.count(BusinessMetric.ClosedTeamRenewalsCharged, 1, { teamId, ...testMark(team.test) });
        }
        const mark = testMark(team.test);
        const marked = await markSubscriptionEnding(db, team).catch((error: unknown) => {
          // Set to end, but not recorded: if the team was reopened meanwhile, nothing would see it (supply-checkout-8jc.30)
          if (action !== "none") {
            obs.count(BusinessMetric.ReopenedTeamSubscriptionsEnded, 1, { teamId, action, checked: "no", ...mark });
            obs.logger.error("Closed team's subscription set to end, but the team wasn't read again", { teamId, subscriptionId: sub.id, action, error: errorName(error) });
          }
          throw error;
        });
        if (!marked) {
          // Reopened meanwhile: undo a cancellation at the period's end, which the reopen's resync may have missed
          if (action === "cancel_at_period_end" && (await resumedAfterReopen(stripe, team, sub.id))) {
            obs.count(BusinessMetric.ReopenedTeamSubscriptionsResumed, 1, { teamId, source: "purge", ...testMark(team.test) });
            obs.logger.warn("Team reopened while its subscription was being ended: resumed", { teamId, subscriptionId: sub.id, action });
            continue;
          }
          if (action !== "none") obs.count(BusinessMetric.ReopenedTeamSubscriptionsEnded, 1, { teamId, action, ...testMark(team.test) });
          obs.logger.error("Team reopened while its subscription was being ended", { teamId, subscriptionId: sub.id, action });
          failed++;
          continue;
        }
        if (action !== "none") {
          ended++;
          obs.count(BusinessMetric.ClosedTeamSubscriptionsEnded, 1, { teamId, action, ...testMark(team.test) });
        }
        obs.logger.info("Closed team's subscription ended", { teamId, subscriptionId: sub.id, status: sub.status, action });
      } catch (error) {
        if (team && isPermanentStripeError(error)) {
          refused.push({ team, error, request });
          continue;
        }
        failed++;
        obs.logger.error("Closed team's subscription not ended", { teamId, error: errorName(error), ...stripeFields(error) });
      }
    }
    for (const { team, error, request } of refused) {
      const { teamId } = team;
      // Only once Stripe took the same request for another team this run: a bad key, the wrong mode
      // or a bug in that request would refuse every team, and those stay listed and fail the run instead
      const vouched = worked[request] > 0;
      try {
        if (vouched && (await setTeamAside(team, "PermanentError"))) {
          obs.logger.error("Closed team's subscription set aside", { teamId, subscriptionId: team.stripeSubscriptionId, error: "PermanentError", request, ...stripeFields(error) });
        } else if (!vouched) {
          failed++;
          obs.logger.error("Closed team's subscription not ended", { teamId, error: errorName(error), request, ...stripeFields(error) });
        }
      } catch (markError) {
        failed++;
        obs.logger.error("Closed team's subscription not ended", { teamId, error: errorName(markError), request, ...stripeFields(error) });
      }
    }
    obs.logger.info("Ended closed teams' subscriptions", { listed: teams.length, ended, failed, setAside });
    return failed;
  }

  /**
   * Resumes the subscription the purge just set to cancel for `team`'s closure, if the team
   * is open now: true if it did. False for a team closed again (that closure keeps it
   * ending) or gone, and when Stripe or the read fails, logged, so the caller alarms.
   */
  async function resumedAfterReopen(stripe: PurgeStripe, team: ClosedTeamToEnd, subscriptionId: string): Promise<boolean> {
    try {
      if (!(await isTeamOpen(db, team.teamId))) return false;
      await resumeSubscription(stripe, subscriptionId, team, "purge");
      return true;
    } catch (error) {
      obs.logger.warn("Reopened team's subscription not resumed", { teamId: team.teamId, subscriptionId, error: errorName(error), ...stripeFields(error) });
      return false;
    }
  }

  /**
   * Sends the ClosedTeamsSetAside gauge and logs the first of them by ID, and
   * how many of them (held from the purge) are due before `overdueBefore`.
   * Returns 1 if they couldn't be counted, else 0.
   */
  async function gaugeSetAside(overdueBefore: Date): Promise<number> {
    let found;
    try {
      found = await listSetAsideTeams(db, MAX_LOGGED_SET_ASIDE, overdueBefore);
    } catch (error) {
      obs.logger.error("Closed teams set aside not counted", { error: errorName(error) });
      return 1;
    }
    obs.gauge(BusinessMetric.ClosedTeamsSetAside, found.count);
    for (const team of found.teams) obs.logger.warn("Closed team's subscription still set aside", { teamId: team.teamId, reason: team.reason ?? "Unknown" });
    if (found.count) obs.logger.warn("Closed teams' subscriptions set aside", { count: found.count, logged: found.teams.length });
    // Counted in ClosedTeamsOverdue like any other overdue team: held past the date the owners were told
    if (found.overdue) obs.logger.warn("Closed teams held past their deletion date", { count: found.overdue });
    return 0;
  }

  /**
   * Counts and logs a Stripe customer deletion Stripe confirmed, from the purge or a retry. `mark` is the
   * team's test mark, from the purge (a retry's team is gone, so it has none).
   */
  function customerDeleted(teamId: string, customerId: string, result: "deleted" | "already_deleted", source: "purge" | "retry", mark: { readonly test?: true } = {}): void {
    if (result === "deleted") obs.count(BusinessMetric.StripeCustomersDeleted, 1, { teamId, source, ...mark });
    else {
      // A run that stopped after deleting it, a retry whose first try reached Stripe, or a Stripe key or
      // mode mismatch: the IDs are in the deletion record
      obs.count(BusinessMetric.StripeCustomersAlreadyDeleted, 1, { teamId, source, ...mark });
      obs.logger.warn("Stripe customer already deleted", { teamId, customerId, ...(source === "retry" ? { source } : {}) });
    }
    obs.logger.info("Stripe customer deleted", { teamId, customerId, result, ...(source === "retry" ? { source } : {}) });
  }

  /**
   * Deletes a purged team's Stripe customer, before any of its items go. When Stripe can't
   * (down, a timeout, a rate limit, a key that can't be read, any error), or this run has
   * stopped asking it, queues the deletion for later runs instead (supply-checkout-8jc.42):
   * the team's data still goes on schedule. Only a queue entry that can't be written stops
   * the team, which then fails and is tried again next run, nothing of it deleted.
   */
  async function deleteCustomer(run: RunState, teamId: string, customerId: string, at: Date, mark: { readonly test?: true }): Promise<void> {
    let failure: unknown;
    if (run.stripeFailures < STRIPE_FAILURES_BEFORE_QUEUEING) {
      try {
        const result = await deleteStripeCustomer(await deps.stripe(), customerId);
        run.stripeFailures = 0;
        customerDeleted(teamId, customerId, result, "purge", mark);
        // Best effort: an entry an earlier, stopped run queued would otherwise be retried and found
        // already deleted, a false sign of a key or mode mismatch
        await removeStripeCustomerDeletion(db, teamId).catch((error: unknown) => {
          obs.logger.warn("Queued Stripe customer deletion not cleared after the purge deleted it", { teamId, customerId, error: errorName(error) });
        });
        return;
      } catch (error) {
        run.stripeFailures++;
        failure = error;
      }
    }
    await queueStripeCustomerDeletion(db, { teamId, stripeCustomerId: customerId, queuedAt: at.toISOString() });
    run.queued++;
    obs.count(BusinessMetric.StripeCustomerDeletionsQueued, 1, { teamId, ...mark });
    // The error's name and Stripe's safe fields only: never its message
    obs.logger.warn("Stripe customer deletion queued", { teamId, customerId, error: failure === undefined ? "NotTried" : errorName(failure), ...stripeFields(failure) });
  }

  /**
   * Retries the queued Stripe customer deletions, oldest first, until the run's budget is
   * spent or Stripe has failed STRIPE_FAILURES_BEFORE_QUEUEING times in a row, removing each
   * one Stripe confirms. An entry whose team is still there and not being purged is refused,
   * never sent to Stripe, and fails the run like an entry it can't read. Then sends the StripeCustomerDeletionsPending and
   * StripeCustomerDeletionOldestHours gauges (the "Stripe customer deletion retrying" and
   * "stuck" alarms). A deletion Stripe still refuses is only logged: the gauges alarm on it
   * if it keeps failing. Returns how many failed for another reason (the queue couldn't be
   * read or cleared, or holds an entry this app didn't write), which fail the run; when the
   * queue can't be read, no gauge is sent.
   */
  async function retryQueued(run: RunState, started: number): Promise<number> {
    let listed;
    try {
      listed = await listStripeCustomerDeletions(db);
    } catch (error) {
      obs.logger.error("Queued Stripe customer deletions not listed", { error: errorName(error) });
      return 1;
    }
    let failures = listed.invalid;
    if (listed.invalid) obs.logger.error("Queued Stripe customer deletions not readable", { count: listed.invalid });
    const left: StripeDeletion[] = [];
    let deleted = 0;
    for (const queued of listed.deletions) {
      const { teamId, stripeCustomerId: customerId, queuedAt } = queued;
      if (run.stripeFailures >= STRIPE_FAILURES_BEFORE_QUEUEING || now() - started > PURGE_BUDGET_MS) {
        left.push(queued);
        continue;
      }
      // Only for a team that's gone or being purged: an entry naming a team still there is refused
      let purged: boolean;
      try {
        purged = await isTeamPurgedOrPurging(db, teamId);
      } catch (error) {
        failures++;
        left.push(queued);
        obs.logger.error("Queued Stripe customer deletion not checked", { teamId, customerId, error: errorName(error) });
        continue;
      }
      if (!purged) {
        failures++;
        obs.logger.error("Queued Stripe customer deletion refused: the team isn't purged", { teamId, customerId });
        continue;
      }
      let result: "deleted" | "already_deleted";
      try {
        result = await deleteStripeCustomer(await deps.stripe(), customerId);
        run.stripeFailures = 0;
      } catch (error) {
        run.stripeFailures++;
        left.push(queued);
        obs.logger.warn("Queued Stripe customer deletion failed", { teamId, customerId, queuedAt, error: errorName(error), ...stripeFields(error) });
        continue;
      }
      customerDeleted(teamId, customerId, result, "retry");
      try {
        await removeStripeCustomerDeletion(db, teamId);
        deleted++;
      } catch (error) {
        // Deleted in Stripe, still queued: the next run finds it already deleted
        failures++;
        left.push(queued);
        obs.logger.error("Queued Stripe customer deletion not cleared", { teamId, customerId, error: errorName(error) });
      }
    }
    const oldest = left.reduce<string | undefined>((min, d) => (min === undefined || d.queuedAt < min ? d.queuedAt : min), undefined);
    const oldestHours = oldest === undefined ? 0 : Math.max(0, (now() - Date.parse(oldest)) / 3_600_000);
    obs.gauge(BusinessMetric.StripeCustomerDeletionsPending, left.length);
    obs.gauge(BusinessMetric.StripeCustomerDeletionOldestHours, oldestHours);
    if (listed.deletions.length) obs.logger.info("Retried queued Stripe customer deletions", { listed: listed.deletions.length, deleted, left: left.length, oldestHours: Math.floor(oldestHours) });
    if (oldest !== undefined && oldestHours >= STRIPE_DELETION_RETRY_ALARM_HOURS) obs.logger.warn("Queued Stripe customer deletions still failing", { count: left.length, oldestQueuedAt: oldest });
    return failures;
  }

  return async (): Promise<{ purged: number; failed: number; due: number; overdue: number }> => {
    const started = now();
    const run: RunState = { stripeFailures: 0, queued: 0 };
    const overdueBefore = new Date(started - PURGE_OVERDUE_AFTER_HOURS * 3_600_000).toISOString();
    const ended = await endSubscriptions(started);
    const endFailures = ended + (await gaugeSetAside(new Date(overdueBefore)));
    // Counted before the listing, from the same index: every overdue team is also due, and they list first
    const overdueAtStart = await countTeamsDueBefore(db, new Date(overdueBefore));
    // Held teams due at or before this are purged anyway: their grace period is over
    const heldDueBefore = new Date(started - HELD_PURGE_GRACE_DAYS * 86_400_000);
    const due = await listTeamsToPurge(db, new Date(started), undefined, heldDueBefore);
    let purged = 0;
    // Of them, test teams: TeamsPurged is sent for the rest, and logged for these (TEST_SKIPPED_METRICS)
    let testPurged = 0;
    let failed = 0;
    // Teams this run deleted, or found weren't due after all
    const done = new Set<string>();
    for (const team of due) {
      if (now() - started > PURGE_BUDGET_MS) break;
      try {
        const at = new Date(now());
        const result = await purgeTeam(db, team.teamId, at, {
          beforeDelete: (stripeIds) => deps.deletions.record({ kind: "team", id: team.teamId, deletedAt: at.toISOString(), ...stripeIds }),
          deleteStripeCustomer: (customerId, mark) => deleteCustomer(run, team.teamId, customerId, at, mark),
          heldDueBefore,
        });
        if (result.held) {
          // Set aside since the listing (or since purgeTeam read it): the set-aside gauge counts it from the next run
          obs.logger.warn("Closed team not purged: its subscription is set aside", { teamId: team.teamId, purgeAfter: team.purgeAfter });
          continue;
        }
        done.add(team.teamId);
        if (result.skipped) continue;
        purged++;
        if (result.test) testPurged++;
        obs.logger.info("Team purged", { teamId: team.teamId, purgeAfter: team.purgeAfter, items: result.deleted });
        if (result.forced) {
          // Its subscription may still be live (another customer's, or under a Stripe key or mode mismatch): a person ends it by hand
          const { stripeCustomerId, stripeSubscriptionId, reason } = result.forced;
          obs.count(BusinessMetric.HeldTeamsPurged, 1, { teamId: team.teamId, ...testMark(result.test) });
          obs.logger.error("Held team purged with its subscription unresolved", { teamId: team.teamId, customerId: stripeCustomerId, subscriptionId: stripeSubscriptionId, reason: reason ?? "Unknown" });
        }
      } catch (error) {
        failed++;
        obs.logger.error("Team purge failed", { teamId: team.teamId, error: errorName(error), ...stripeFields(error) });
      }
    }
    if (purged > testPurged) obs.count(BusinessMetric.TeamsPurged, purged - testPurged);
    if (testPurged) obs.count(BusinessMetric.TeamsPurged, testPurged, testMark(true));
    // After the purge, so the data deletions have the run's budget first
    const retryFailures = await retryQueued(run, started);
    // The overdue teams at the start less those this run deleted (or found weren't due). Held
    // teams stay counted: their data is kept past its date. Not a count after the run: the index
    // is eventually consistent, and a team just deleted could still be counted. ISO timestamps
    // compare as strings.
    const cleared = due.filter((t) => t.purgeAfter < overdueBefore && done.has(t.teamId)).length;
    const overdue = Math.max(0, overdueAtStart - cleared);
    obs.gauge(BusinessMetric.ClosedTeamsOverdue, overdue);
    obs.logger.info("Purged closed teams", { due: due.length, purged, failed, overdue, ...(run.queued ? { stripeDeletionsQueued: run.queued } : {}) });
    // A run that failed anywhere fails, so the Lambda errors alarm sees it
    if (failed) throw new Error(`${failed} of ${due.length} closed teams weren't purged`);
    if (endFailures) throw new Error(`${endFailures} closed teams' subscriptions weren't ended`);
    if (retryFailures) throw new Error(`${retryFailures} queued Stripe customer deletions couldn't be read, were refused or couldn't be cleared`);
    return { purged, failed, due: due.length, overdue };
  };
}
