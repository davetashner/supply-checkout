// The lapsed-team job (supply-checkout-qdx), run every LAPSE_EVERY_HOURS in
// the primary region. It carries out what the billing access rules
// (billingAccess, data/model.ts; ADR 0009; Terms 4, 5.6 and 6) promise but no
// Stripe event triggers:
//
// 1. An app trial (trialing, no Stripe subscription) ending within
//    LAPSE_TRIAL_NOTICE_DAYS: each owner gets the trial-ending email, once
//    per trial end. (A Stripe trial's comes from the billing worker, on
//    Stripe's trial_will_end.)
// 2. An app trial that ended (`trial_ended`): the read-only email, with the
//    deletion date, once per trial end.
// 3. A past-due payment whose 7-day grace ended (`payment_overdue`): the
//    read-only email, saying to pay, once per grace end. (`unpaid` and an
//    ended subscription get theirs from the worker, on Stripe's event.)
// 4. A team with a deletion date (`deleteAfter`: a trial or subscription that
//    ended READ_ONLY_RETENTION_DAYS before, rounded up by deletionTime to the
//    end of that date everywhere) within LAPSE_WARNING_DAYS + 1 (WARN_AHEAD_MS,
//    so the first run in the window still gives the full notice): the deletion
//    warning. It's recorded (recordWarning) only once at least one owner was
//    sent it; until then each UTC day tries again, and a run that sends none,
//    or finds no owner to send it to, counts the team in LapseFailures. The
//    time it's closed (`deletesAt`, closesAt) is `deleteAfter`, or, if the
//    warning went out less than LAPSE_WARNING_DAYS before it, deletionTime of
//    the warning's time plus LAPSE_WARNING_DAYS: so a team
//    found already past its date (one comped until recently, or from before
//    this job) still gets a full LAPSE_WARNING_DAYS' notice. Every email
//    states deletionLastDay of it, a date that has ended everywhere by then.
// 5. Once that time has passed: at most LAPSE_MAX_CLOSURES_PER_RUN teams a
//    run go on (the rest are held for the next run and counted in
//    LapseClosuresHeld, which alarms), and Stripe is asked again (never only
//    our record of it). The team's recorded subscription must be `canceled`
//    or `incomplete_expired` and the customer's, none of the customer's
//    subscriptions may be anything else (a resubscription, an unpaid or
//    paused one, one being paid), and the customer may have no open Checkout
//    Session (an owner subscribing now: left, uncounted, for the next run).
//    Then closeLapsedTeam closes it, on the condition its version is the one
//    read, with `purgeAfter` LAPSE_PURGE_DELAY_HOURS on (reopenable until
//    then), and the hourly
//    purge (team-purge-handler.ts) deletes it as it deletes a team an owner
//    closed: its deletion record first, then its Stripe customer (or that
//    deletion queued), then its data. Stripe disagreeing, or failing,
//    leaves the team for the next run and counts it in LapseFailures.
//
// Never touched: a team with a live comp (billingAccess gives it full access,
// and the listing leaves it out), a closed team (so one set aside or held by
// the purge too), one being purged, and an `unpaid` or overdue team (no
// deletion date: Stripe cancels the subscription once its retries fail, and
// the 30 days start then).
//
// Each owner email is claimed first (claimLapseNotice), so a run that's
// retried or overlaps never sends it twice; a send that fails is counted
// (LapseNoticeFailures) and, except for the deletion warning, not retried.
// Every run that can list the teams sends LapseTeamsChecked (its absence is
// "Lapsed-team job not running"), LapseTeamsReadOnly and LapseTeamsUnstarted
// (the teams it had no time for: it starts at a random place in the list, so
// the same teams aren't always the ones left). One team's failure is logged
// and counted, and the others still go; a run that can't list fails.
//
// Logged: team, subscription and customer IDs, statuses, reasons and dates.
// Never a name, an email, or Stripe's messages. Its role
// (infra/lib/observability/ops-checks.ts) may name only the LAPSE_*
// attribute lists in data/schema.ts, send the app's email, and read the
// Stripe secret key.

import { customerOf } from "../billing/closing.js";
import { stripeErrorFields } from "../billing/stripe.js";
import type { SubscriptionLike } from "../billing/subscription.js";
import {
  billingAccess,
  claimLapseNotice,
  claimLapseRun,
  closeLapsedTeam,
  type Db,
  deletionTime,
  hasStopped,
  LAPSE_TRIAL_NOTICE_DAYS,
  LAPSE_WARNING_DAYS,
  type LapseTeam,
  listLapseCandidates,
  listOwnerEmails,
  readLapseTeam,
  recordWarning,
  releaseLapseRun,
  trialEnd,
  warnedAt,
} from "../data/index.js";
import { EmailNotSentError, type Mailer, sendTeamNotice } from "../email/mailer.js";
import type { TeamNoticeInput } from "../email/templates.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { LAPSE_BUDGET_MS, LAPSE_LEASE_MS, LAPSE_MAX_CLOSURES_PER_RUN } from "./names.js";

/** What the job needs from the Stripe client. */
export interface LapseStripe {
  readonly subscriptions: {
    retrieve(id: string): PromiseLike<SubscriptionLike>;
    list(params: { customer: string; status: "all"; limit: number }): PromiseLike<{ readonly data: readonly SubscriptionLike[]; readonly has_more?: boolean }>;
  };
  readonly checkout: {
    readonly sessions: {
      list(params: { customer: string; status: "open"; limit: number }): PromiseLike<{ readonly data: readonly { readonly id: string }[] }>;
    };
  };
}

export interface TeamLapseDeps {
  readonly db: Db;
  readonly obs: Observability;
  readonly mailer: Mailer;
  /** The Stripe client, read from Secrets Manager the first time a team needs it. */
  readonly stripe: () => Promise<LapseStripe>;
  readonly now?: () => number;
  /** A number in [0, 1) for where in the list a run starts (Math.random). */
  readonly random?: () => number;
}

/** What the job did with one team. */
export type LapseOutcome = "closed" | "waiting" | "held" | "nothing" | "failed" | "gone";

/** Why Stripe wouldn't let a lapsed team close. */
export type StripeDisagreement = "SubscriptionLive" | "CustomerMismatch" | "SubscriptionNotFound" | "CustomerNotFound" | "TooManySubscriptions" | "CheckoutOpen";

/** How many of a customer's subscriptions the check lists, newest first. */
const SUBSCRIPTIONS_LISTED = 10;
const DAY_MS = 86_400_000;

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * How long before `deleteAfter` the deletion warning goes out: a day more than
 * LAPSE_WARNING_DAYS, so the first run in the window (an hour or so after it
 * opens) still warns LAPSE_WARNING_DAYS ahead, and the warning states the
 * same date as the read-only email and /me (closesAt keeps `deleteAfter`).
 */
const WARN_AHEAD_MS = (LAPSE_WARNING_DAYS + 1) * DAY_MS;

/**
 * When a team with deletion time `deleteAfter` (epoch ms, a deletionTime) is
 * closed if its warning went out at `warned`: then, if that's at least
 * LAPSE_WARNING_DAYS after the warning; otherwise LAPSE_WARNING_DAYS after it,
 * rounded up the same way (deletionTime).
 */
function closesAt(deleteAfter: number, warned: number): number {
  const floor = warned + LAPSE_WARNING_DAYS * DAY_MS;
  return floor <= deleteAfter ? deleteAfter : deletionTime(floor);
}

const errorName = (error: unknown) => (error as { name?: string } | null)?.name ?? "Unknown";
const isMissing = (error: unknown) => (error as { code?: unknown } | null)?.code === "resource_missing";

export function createTeamLapseHandler(deps: TeamLapseDeps) {
  const { db, obs } = deps;
  const clock = deps.now ?? Date.now;

  /** Emails each owner `input` once for (`kind`, `anchor`). Returns how many owners the index has, how many it claimed now, and sent to. */
  async function notify(team: LapseTeam, kind: string, anchor: string, input: TeamNoticeInput, now: Date): Promise<{ owners: number; claimed: number; sent: number }> {
    const owners = await listOwnerEmails(db, team.teamId);
    let sent = 0;
    let claimed = 0;
    const failures: string[] = [];
    for (const owner of owners) {
      if (!(await claimLapseNotice(db, team.teamId, kind, anchor, owner.userId, now))) continue;
      claimed++;
      try {
        if (!owner.email) throw new EmailNotSentError("NoAddress");
        await sendTeamNotice(deps.mailer, owner.email, team.teamId, input);
        sent++;
      } catch (error) {
        failures.push(error instanceof EmailNotSentError ? error.code : errorName(error));
      }
    }
    if (sent) obs.count(BusinessMetric.LapseNotices, sent, { teamId: team.teamId, kind: input.kind });
    if (failures.length) {
      obs.count(BusinessMetric.LapseNoticeFailures, failures.length, { teamId: team.teamId, kind: input.kind });
      obs.logger.warn("Lapse emails not sent", { teamId: team.teamId, kind: input.kind, failed: failures.length, codes: [...new Set(failures)].join(",") });
    }
    return { owners: owners.length, claimed, sent };
  }

  /** Whether Stripe agrees the team has nothing live: true, or why not. Throws on a Stripe failure. */
  async function stripeAgrees(team: LapseTeam): Promise<true | { readonly why: StripeDisagreement; readonly subscriptionId?: string; readonly status?: string }> {
    if (!team.stripeCustomerId && !team.stripeSubscriptionId) return true;
    if (!team.stripeCustomerId) return { why: "CustomerMismatch" };
    const stripe = await deps.stripe();
    if (team.stripeSubscriptionId) {
      let sub: SubscriptionLike;
      try {
        sub = await stripe.subscriptions.retrieve(team.stripeSubscriptionId);
      } catch (error) {
        if (isMissing(error)) return { why: "SubscriptionNotFound", subscriptionId: team.stripeSubscriptionId };
        throw error;
      }
      if (customerOf(sub) !== team.stripeCustomerId) return { why: "CustomerMismatch", subscriptionId: sub.id };
      if (!hasStopped(sub.status)) return { why: "SubscriptionLive", subscriptionId: sub.id, status: sub.status };
    }
    let page: { readonly data: readonly SubscriptionLike[]; readonly has_more?: boolean };
    try {
      page = await stripe.subscriptions.list({ customer: team.stripeCustomerId, status: "all", limit: SUBSCRIPTIONS_LISTED });
    } catch (error) {
      if (isMissing(error)) return { why: "CustomerNotFound" };
      throw error;
    }
    const live = page.data.find((s) => !hasStopped(s.status));
    if (live) return { why: "SubscriptionLive", subscriptionId: live.id, status: live.status };
    // More than a page: a live one could be further down, so a person looks
    if (page.has_more === true) return { why: "TooManySubscriptions" };
    // An owner in Checkout now: paying would make a subscription for a team about to be deleted
    const open = await stripe.checkout.sessions.list({ customer: team.stripeCustomerId, status: "open", limit: 1 });
    return open.data.length ? { why: "CheckoutOpen" } : true;
  }

  /** One team (see the top). Throws on a failure, for the caller to count. */
  async function handle(teamId: string, now: Date, tally: { readOnly: number; closed: number }): Promise<LapseOutcome> {
    const team = await readLapseTeam(db, teamId);
    if (!team || team.closedAt !== undefined || team.purging !== undefined) return "gone";
    const access = billingAccess(team, now);
    const at = now.getTime();
    if (!access.readOnly) {
      // 1: an app trial ending soon
      const end = trialEnd(team);
      if (team.status === "trialing" && !team.stripeSubscriptionId && Number.isFinite(end) && end > at && end - at <= LAPSE_TRIAL_NOTICE_DAYS * DAY_MS) {
        await notify(team, "trialEnding", iso(end), { kind: "trialEnding", teamName: team.name, trialEndsAt: iso(end) }, now);
      }
      return "nothing";
    }
    tally.readOnly++;
    // When the team is closed for deletion (closesAt): its deleteAfter, or LAPSE_WARNING_DAYS after the warning (sent
    // now, if it hasn't been) rounded up as deleteAfter is, if that's later. Read first, so the read-only email states it too
    let deletesAt: number | undefined;
    let warned: string | undefined;
    if (access.deleteAfter) {
      const deleteAfter = Date.parse(access.deleteAfter);
      if (at >= deleteAfter - WARN_AHEAD_MS) warned = await warnedAt(db, teamId, access.deleteAfter);
      deletesAt = closesAt(deleteAfter, warned ? Date.parse(warned) : at);
      // A warning time that doesn't parse (a record this job didn't write) never lets a team close, or reach an email: a person looks
      if (!Number.isFinite(deletesAt)) {
        obs.count(BusinessMetric.LapseFailures, 1, { teamId, step: "badDate" });
        obs.logger.warn("Lapsed team's deletion time isn't a date, so it can't be closed safely", { teamId, deleteAfter: access.deleteAfter });
        return "failed";
      }
    }
    // 2 and 3: the read-only emails no Stripe event sends
    if (access.reason === "trial_ended" && access.readOnlyFrom) {
      await notify(team, "trialEnded", access.readOnlyFrom, { kind: "readOnly", teamName: team.name, reason: "trial_ended", ...(deletesAt !== undefined ? { deletesAt: iso(deletesAt) } : {}) }, now);
    }
    if (access.reason === "payment_overdue" && team.status === "past_due" && access.readOnlyFrom) {
      await notify(team, "paymentOverdue", access.readOnlyFrom, { kind: "readOnly", teamName: team.name, reason: "payment_overdue" }, now);
    }
    if (!access.deleteAfter || deletesAt === undefined) {
      // A canceled or expired subscription with no date it ended is never deleted: the nightly entitlement check should
      // have recorded it, so a person looks, rather than its data being kept past the Terms' 30 days with nothing said
      if (access.reason === "subscription_ended") {
        obs.count(BusinessMetric.LapseFailures, 1, { teamId, step: "undated" });
        obs.logger.warn("Lapsed team has no date its subscription ended", { teamId, status: team.status ?? "", subscriptionId: team.stripeSubscriptionId ?? "" });
        return "failed";
      }
      return "nothing";
    }
    const deleteAfter = Date.parse(access.deleteAfter);
    if (at < deleteAfter - WARN_AHEAD_MS) return "nothing";
    if (!warned) {
      // 4: retried each UTC day until an owner gets it; recorded only then
      const { owners, claimed, sent } = await notify(team, `deletionWarning-${now.toISOString().slice(0, 10).replaceAll("-", "")}`, access.deleteAfter, { kind: "deletionWarning", teamName: team.name, deletesAt: iso(deletesAt) }, now);
      // Nobody to warn: never closed unwarned, so a person looks (an index entry missing, or a team without owners)
      if (!owners) {
        obs.count(BusinessMetric.LapseFailures, 1, { teamId, step: "noOwners" });
        obs.logger.warn("Lapsed team has no owners to warn", { teamId, deleteAfter: access.deleteAfter });
        return "failed";
      }
      // Every owner already claimed today, by a run that counted its failures or stopped before recording: tomorrow's tries again
      if (!claimed) return "waiting";
      if (!sent) {
        obs.count(BusinessMetric.LapseFailures, 1, { teamId, step: "warning" });
        obs.logger.warn("Lapsed team's deletion warning not delivered", { teamId, deleteAfter: access.deleteAfter });
        return "failed";
      }
      warned = await recordWarning(db, teamId, access.deleteAfter, now);
      obs.logger.info("Lapsed team warned of deletion", { teamId, reason: access.reason ?? "", deleteAfter: access.deleteAfter, deletesAt: iso(closesAt(deleteAfter, Date.parse(warned))) });
      return "waiting";
    }
    if (at < deletesAt) return "waiting";
    // 5: no more than the cap a run (a bug or bad data can't delete teams en masse), then Stripe again, then the closure
    if (tally.closed >= LAPSE_MAX_CLOSURES_PER_RUN) {
      obs.count(BusinessMetric.LapseClosuresHeld, 1, { teamId });
      return "held";
    }
    const agrees = await stripeAgrees(team);
    if (agrees !== true && agrees.why === "CheckoutOpen") {
      // An owner paying now isn't a fault: the session completes (the team becomes active) or expires within a day
      obs.logger.info("Lapsed team not closed: an owner has Checkout open", { teamId, customerId: team.stripeCustomerId ?? "" });
      return "waiting";
    }
    if (agrees !== true) {
      obs.count(BusinessMetric.LapseFailures, 1, { teamId, step: "stripe", why: agrees.why });
      obs.logger.warn("Lapsed team not closed: Stripe disagrees", {
        teamId,
        why: agrees.why,
        status: team.status ?? "",
        recordedSubscriptionId: team.stripeSubscriptionId ?? "",
        customerId: team.stripeCustomerId ?? "",
        ...(agrees.subscriptionId ? { subscriptionId: agrees.subscriptionId } : {}),
        ...(agrees.status ? { stripeStatus: agrees.status } : {}),
      });
      return "failed";
    }
    if (team.version < 0) {
      obs.count(BusinessMetric.LapseFailures, 1, { teamId, step: "noVersion" });
      obs.logger.warn("Lapsed team has no version, so it can't be closed safely", { teamId });
      return "failed";
    }
    if (!(await closeLapsedTeam(db, team, now))) {
      obs.logger.info("Lapsed team changed before it was closed: left for the next run", { teamId });
      return "waiting";
    }
    tally.closed++;
    obs.count(BusinessMetric.LapsedTeamsClosed, 1, { teamId, reason: access.reason ?? "" });
    obs.logger.info("Lapsed team closed for deletion", { teamId, reason: access.reason ?? "", deleteAfter: access.deleteAfter, warnedAt: warned, subscriptionId: team.stripeSubscriptionId ?? "" });
    return "closed";
  }

  /** One run, holding the lease (see the run below). */
  async function runOnce(started: number, now: Date): Promise<{ checked: number; closed: number; failed: number; held: number }> {
    const listed = await listLapseCandidates(db, now);
    // From a random place, so a run out of time doesn't leave the same teams every time
    const from = Math.floor((deps.random ?? Math.random)() * listed.length) % Math.max(1, listed.length);
    const teams = [...listed.slice(from), ...listed.slice(0, from)];
    const tally = { readOnly: 0, closed: 0 };
    let failed = 0;
    let held = 0;
    let unstarted = 0;
    for (const teamId of teams) {
      if (clock() - started > LAPSE_BUDGET_MS) {
        unstarted++;
        continue;
      }
      try {
        const outcome = await handle(teamId, now, tally);
        if (outcome === "failed") failed++;
        if (outcome === "held") held++;
      } catch (error) {
        failed++;
        obs.count(BusinessMetric.LapseFailures, 1, { teamId, step: "error" });
        obs.logger.error("Lapsed team check failed", { teamId, error: errorName(error), ...stripeErrorFields(error) });
      }
    }
    obs.gauge(BusinessMetric.LapseTeamsChecked, teams.length - unstarted);
    obs.gauge(BusinessMetric.LapseTeamsReadOnly, tally.readOnly);
    obs.gauge(BusinessMetric.LapseTeamsUnstarted, unstarted);
    if (unstarted) obs.logger.warn("Lapsed-team job ran out of time: the rest wait for the next run", { unstarted });
    if (held) obs.logger.warn("Lapsed-team job held teams at its closure cap: the rest wait for the next run", { held, cap: LAPSE_MAX_CLOSURES_PER_RUN });
    obs.logger.info("Lapsed-team job ran", { listed: teams.length, closed: tally.closed, failed, held, readOnly: tally.readOnly, unstarted });
    return { checked: teams.length - unstarted, closed: tally.closed, failed, held };
  }

  // One run at a time (claimLapseRun): a retried, duplicate or hand-started invocation while another runs does
  // nothing, so the closure cap holds per hour, not per invocation. The function has no async retries either.
  return async (): Promise<{ checked: number; closed: number; failed: number; held: number; skipped?: true }> => {
    const started = clock();
    const now = new Date(started);
    if (!(await claimLapseRun(db, now, LAPSE_LEASE_MS))) {
      obs.logger.warn("Lapsed-team job skipped: another run holds the lease");
      return { checked: 0, closed: 0, failed: 0, held: 0, skipped: true };
    }
    try {
      return await runOnce(started, now);
    } finally {
      await releaseLapseRun(db, now);
    }
  };
}
