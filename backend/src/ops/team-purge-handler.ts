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
// cards, and any subscription still on it. A team whose customer can't be
// deleted isn't deleted this run either, so its data never goes while the
// customer stays; after a day of that, "Deletion overdue" alarms. A customer
// Stripe says is already gone is taken as deleted (a run that stopped after
// deleting it), but it's also what a Stripe key or mode mismatch looks like,
// with the real customer and any subscription left alone, so it's warned of
// and counted (StripeCustomersAlreadyDeleted, the "Stripe customer already
// deleted" alarm, supply-checkout-8jc.37).
//
// A team set aside for its current closure (below) isn't purged at all until
// a person deals with it (supply-checkout-8jc.37): listTeamsToPurge leaves it
// out and purgeTeam holds it, so a subscription Stripe couldn't find (maybe
// the same mismatch) isn't followed by deleting the team and every trace of
// its Stripe IDs. A held team past its deletion date still counts in
// ClosedTeamsOverdue: its data is being kept past the date its owners were
// told, so "Deletion overdue" fires for it too, and the responder clears the
// set-aside so the purge can run. Each run also logs how many held teams are
// past that line ("Closed teams held past their deletion date").
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
// in ReopenedTeamSubscriptionsEnded, and fails the run.
//
// Logs have team, subscription and customer IDs and counts, never names,
// emails or Stripe's messages. The function's role may delete whole items
// and name only TEAM_PURGE_ATTRIBUTES, and read only the Stripe secret key
// (infra/lib/observability/ops-checks.ts).

import { type ClosingAction, closingAction, customerOf, deleteStripeCustomer, endSubscriptionForClosedTeam, type PurgeStripe, resumeSubscription } from "../billing/closing.js";
import { isPermanentStripeError, stripeErrorFields } from "../billing/stripe.js";
import {
  type ClosedTeamToEnd,
  closedTeamToEnd,
  countTeamsDueBefore,
  type Db,
  isTeamOpen,
  listClosedTeamsToEnd,
  listSetAsideTeams,
  listTeamsToPurge,
  markSubscriptionEnding,
  markSubscriptionSetAside,
  purgeTeam,
  type SetAsideReason,
} from "../data/index.js";
import type { DeletionLog } from "../deletions/records.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { CLOSED_TEAMS_TO_END_PER_RUN, MAX_LOGGED_SET_ASIDE, PURGE_BUDGET_MS, PURGE_OVERDUE_AFTER_HOURS } from "./names.js";

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
      obs.count(BusinessMetric.ClosedTeamSubscriptionsSetAside, 1, { teamId: team.teamId, reason });
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
            obs.count(BusinessMetric.ClosedTeamSubscriptionsNotFound, 1, { teamId });
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
        const planned = closingAction(sub);
        if (planned !== "none") request = planned;
        const action = await endSubscriptionForClosedTeam(stripe, sub, team);
        if (action !== "none") worked[action]++;
        // Charged for a period that began after the team closed: a person refunds it
        const periodStart = sub.items.data[0]?.current_period_start;
        if (sub.status === "active" && typeof periodStart === "number" && periodStart * 1000 > Date.parse(team.closedAt)) {
          obs.logger.warn("Closed team's subscription renewed after it closed", { teamId, subscriptionId: sub.id, closedAt: team.closedAt });
          obs.count(BusinessMetric.ClosedTeamRenewalsCharged, 1, { teamId });
        }
        if (!(await markSubscriptionEnding(db, team))) {
          // Reopened meanwhile: undo a cancellation at the period's end, which the reopen's resync may have missed
          if (action === "cancel_at_period_end" && (await resumedAfterReopen(stripe, team, sub.id))) {
            obs.count(BusinessMetric.ReopenedTeamSubscriptionsResumed, 1, { teamId, source: "purge" });
            obs.logger.warn("Team reopened while its subscription was being ended: resumed", { teamId, subscriptionId: sub.id, action });
            continue;
          }
          if (action !== "none") obs.count(BusinessMetric.ReopenedTeamSubscriptionsEnded, 1, { teamId, action });
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

  /** Deletes a purged team's Stripe customer, before any of its items go. */
  async function deleteCustomer(teamId: string, customerId: string): Promise<void> {
    const result = await deleteStripeCustomer(await deps.stripe(), customerId);
    if (result === "deleted") obs.count(BusinessMetric.StripeCustomersDeleted, 1, { teamId });
    else {
      // A run that stopped after deleting it, or a Stripe key or mode mismatch: the IDs are in the deletion record
      obs.count(BusinessMetric.StripeCustomersAlreadyDeleted, 1, { teamId });
      obs.logger.warn("Stripe customer already deleted", { teamId, customerId });
    }
    obs.logger.info("Stripe customer deleted", { teamId, customerId, result });
  }

  return async (): Promise<{ purged: number; failed: number; due: number; overdue: number }> => {
    const started = now();
    const overdueBefore = new Date(started - PURGE_OVERDUE_AFTER_HOURS * 3_600_000).toISOString();
    const ended = await endSubscriptions(started);
    const endFailures = ended + (await gaugeSetAside(new Date(overdueBefore)));
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
          beforeDelete: (stripeIds) => deps.deletions.record({ kind: "team", id: team.teamId, deletedAt: at.toISOString(), ...stripeIds }),
          deleteStripeCustomer: (customerId) => deleteCustomer(team.teamId, customerId),
        });
        if (result.held) {
          // Set aside since the listing (or since purgeTeam read it): the set-aside gauge counts it from the next run
          obs.logger.warn("Closed team not purged: its subscription is set aside", { teamId: team.teamId, purgeAfter: team.purgeAfter });
          continue;
        }
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
    // The overdue teams at the start less those this run deleted (or found weren't due). Held
    // teams stay counted: their data is kept past its date. Not a count after the run: the index
    // is eventually consistent, and a team just deleted could still be counted. ISO timestamps
    // compare as strings.
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
