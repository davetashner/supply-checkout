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
// Before deleting a team, it writes the team's deletion record (the team ID and
// the time, deletions/records.ts), so a restore from an older backup can delete
// it again; a team whose record can't be written isn't deleted this run.
//
// Then, for a team with a Stripe customer, it deletes the customer in Stripe
// (billing/closing.ts, deleteStripeCustomer): its name, email, address and
// cards, and any subscription still on it. A team whose customer can't be
// deleted isn't deleted this run either, so its data never goes while the
// customer stays; after a day of that, "Deletion overdue" alarms.
//
// Before any purging, each run ends closed teams' Stripe subscriptions
// (supply-checkout-t0en): closing a team doesn't call Stripe, so the closure
// itself is the pending cancellation, and this is where it's carried out and
// retried. For every closed team whose subscription isn't yet recorded as set
// to end for its closure (listClosedTeamsToEnd), it re-reads the team, fetches
// the subscription, sets it to cancel at the period's end (or cancels it, if
// nothing is being paid for; endSubscriptionForClosedTeam), and records that
// (markSubscriptionEnding). It starts no new team after half of
// PURGE_BUDGET_MS, so a slow Stripe can't starve the purge. A team that fails
// is logged, left unrecorded for the next run, and fails the run (the
// Functions failing alarm). A subscription that renewed after its team closed
// (the team closed within an hour of a renewal) is logged as a warning for a
// refund by hand. A team reopened while Stripe was being called is logged as
// an error: its subscription was set to end, and an owner or operator must
// resume it (supply-checkout-85qp).
//
// Logs have team, subscription and customer IDs and counts, never names,
// emails or Stripe's messages. The function's role may delete whole items
// and name only TEAM_PURGE_ATTRIBUTES, and read only the Stripe secret key
// (infra/lib/observability/ops-checks.ts).

import { customerOf, deleteStripeCustomer, endSubscriptionForClosedTeam, type PurgeStripe } from "../billing/closing.js";
import { stripeErrorFields } from "../billing/stripe.js";
import { closedTeamToEnd, countTeamsDueBefore, type Db, listClosedTeamsToEnd, listTeamsToPurge, markSubscriptionEnding, purgeTeam } from "../data/index.js";
import type { DeletionLog } from "../deletions/records.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { PURGE_BUDGET_MS, PURGE_OVERDUE_AFTER_HOURS } from "./names.js";

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

/** The share of the run's budget ending subscriptions may take before the purge starts. */
const END_BUDGET_MS = PURGE_BUDGET_MS / 2;

export function createTeamPurgeHandler(deps: TeamPurgeDeps) {
  const { db, obs } = deps;
  const now = deps.now ?? Date.now;
  /** Ends closed teams' subscriptions (see the top). Returns how many teams failed. */
  async function endSubscriptions(started: number): Promise<number> {
    let teams;
    try {
      teams = await listClosedTeamsToEnd(db);
    } catch (error) {
      obs.logger.error("Closed teams' subscriptions not listed", { error: errorName(error) });
      return 1;
    }
    let ended = 0;
    let failed = 0;
    for (const listed of teams) {
      if (now() - started > END_BUDGET_MS) break;
      const { teamId } = listed;
      try {
        // The index may lag: the team as it is now, still closed, still not done
        const team = await closedTeamToEnd(db, teamId);
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
        if (!sub) {
          if (await markSubscriptionEnding(db, team)) obs.logger.warn("Closed team's subscription not found in Stripe", { teamId, subscriptionId: team.stripeSubscriptionId });
          continue;
        }
        if (customerOf(sub) !== team.stripeCustomerId) throw Object.assign(new Error("The team's subscription belongs to another customer"), { name: "CustomerMismatch" });
        const action = await endSubscriptionForClosedTeam(stripe, sub, team);
        // Charged for a period that began after the team closed: a person refunds it
        const periodStart = sub.items.data[0]?.current_period_start;
        if (sub.status === "active" && typeof periodStart === "number" && periodStart * 1000 > Date.parse(team.closedAt)) {
          obs.logger.warn("Closed team's subscription renewed after it closed", { teamId, subscriptionId: sub.id, closedAt: team.closedAt });
        }
        if (!(await markSubscriptionEnding(db, team))) {
          obs.logger.error("Team reopened while its subscription was being ended", { teamId, subscriptionId: sub.id, action });
          failed++;
          continue;
        }
        if (action !== "none") {
          ended++;
          obs.count(BusinessMetric.ClosedTeamSubscriptionsEnded, 1, { teamId, action });
        }
        obs.logger.info("Closed team's subscription ended", { teamId, subscriptionId: sub.id, status: sub.status, action });
      } catch (error) {
        failed++;
        obs.logger.error("Closed team's subscription not ended", { teamId, error: errorName(error), ...stripeFields(error) });
      }
    }
    obs.logger.info("Ended closed teams' subscriptions", { listed: teams.length, ended, failed });
    return failed;
  }

  /** Deletes a purged team's Stripe customer, before any of its items go. */
  async function deleteCustomer(teamId: string, customerId: string): Promise<void> {
    const result = await deleteStripeCustomer(await deps.stripe(), customerId);
    if (result === "deleted") obs.count(BusinessMetric.StripeCustomersDeleted, 1, { teamId });
    obs.logger.info("Stripe customer deleted", { teamId, customerId, result });
  }

  return async (): Promise<{ purged: number; failed: number; due: number; overdue: number }> => {
    const started = now();
    const endFailures = await endSubscriptions(started);
    const overdueBefore = new Date(started - PURGE_OVERDUE_AFTER_HOURS * 3_600_000).toISOString();
    // Counted before the listing, from the same index: every overdue team is also due, and they list first
    const overdueAtStart = await countTeamsDueBefore(db, new Date(overdueBefore));
    const due = await listTeamsToPurge(db, new Date(started));
    let purged = 0;
    let failed = 0;
    // Teams this run deleted, or found weren't due after all
    const done = new Set<string>();
    for (const team of due) {
      if (now() - started > PURGE_BUDGET_MS) break;
      try {
        const at = new Date(now());
        const result = await purgeTeam(db, team.teamId, at, {
          beforeDelete: () => deps.deletions.record({ kind: "team", id: team.teamId, deletedAt: at.toISOString() }),
          deleteStripeCustomer: (customerId) => deleteCustomer(team.teamId, customerId),
        });
        done.add(team.teamId);
        if (result.skipped) continue;
        purged++;
        obs.logger.info("Team purged", { teamId: team.teamId, purgeAfter: team.purgeAfter, items: result.deleted });
      } catch (error) {
        failed++;
        obs.logger.error("Team purge failed", { teamId: team.teamId, error: errorName(error), ...stripeFields(error) });
      }
    }
    if (purged) obs.count(BusinessMetric.TeamsPurged, purged);
    // The overdue teams at the start less those this run deleted (or found weren't due). Not a
    // count after the run: the index is eventually consistent, and a team just deleted could still
    // be counted. ISO timestamps compare as strings.
    const cleared = due.filter((t) => t.purgeAfter < overdueBefore && done.has(t.teamId)).length;
    const overdue = Math.max(0, overdueAtStart - cleared);
    obs.gauge(BusinessMetric.ClosedTeamsOverdue, overdue);
    obs.logger.info("Purged closed teams", { due: due.length, purged, failed, overdue });
    // A run that failed anywhere fails, so the Lambda errors alarm sees it
    if (failed) throw new Error(`${failed} of ${due.length} closed teams weren't purged`);
    if (endFailures) throw new Error(`${endFailures} closed teams' subscriptions weren't ended`);
    return { purged, failed, due: due.length, overdue };
  };
}
