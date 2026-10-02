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
//    ended READ_ONLY_RETENTION_DAYS before) within LAPSE_WARNING_DAYS: the
//    deletion warning. It's recorded (recordWarning) only once at least one
//    owner was sent it; until then each UTC day tries again, and a run that
//    sends none counts the team in LapseFailures. The date it states, and
//    the earliest the team is closed, is the later of `deleteAfter` and the
//    warning's time plus LAPSE_WARNING_DAYS: so a team found already past its
//    date (one comped until recently, or from before this job) still gets a
//    full LAPSE_WARNING_DAYS' notice.
// 5. Once that date has passed: Stripe is asked again (never only our record
//    of it). The team's recorded subscription must be `canceled` or
//    `incomplete_expired` and the customer's, and none of the customer's
//    subscriptions may be anything else (a resubscription, an unpaid or
//    paused one, one being paid). Then closeLapsedTeam closes it, on the
//    condition its version is the one read, with `purgeAfter` now, and the
//    hourly purge (team-purge-handler.ts) deletes it as it deletes a team an
//    owner closed: its deletion record first, then its Stripe customer (or
//    that deletion queued), then its data. Stripe disagreeing, or failing,
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
// "Lapsed-team job not running") and LapseTeamsReadOnly. One team's failure is
// logged and counted, and the others still go; a run that can't list fails.
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
  closeLapsedTeam,
  type Db,
  hasStopped,
  LAPSE_TRIAL_NOTICE_DAYS,
  LAPSE_WARNING_DAYS,
  type LapseTeam,
  listLapseCandidates,
  listOwnerEmails,
  readLapseTeam,
  recordWarning,
  trialEnd,
  warnedAt,
} from "../data/index.js";
import { EmailNotSentError, type Mailer, sendTeamNotice } from "../email/mailer.js";
import type { TeamNoticeInput } from "../email/templates.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { LAPSE_BUDGET_MS } from "./names.js";

/** What the job needs from the Stripe client. */
export interface LapseStripe {
  readonly subscriptions: {
    retrieve(id: string): PromiseLike<SubscriptionLike>;
    list(params: { customer: string; status: "all"; limit: number }): PromiseLike<{ readonly data: readonly SubscriptionLike[]; readonly has_more?: boolean }>;
  };
}

export interface TeamLapseDeps {
  readonly db: Db;
  readonly obs: Observability;
  readonly mailer: Mailer;
  /** The Stripe client, read from Secrets Manager the first time a team needs it. */
  readonly stripe: () => Promise<LapseStripe>;
  readonly now?: () => number;
}

/** What the job did with one team. */
export type LapseOutcome = "closed" | "waiting" | "nothing" | "failed" | "gone";

/** Why Stripe wouldn't let a lapsed team close. */
export type StripeDisagreement = "SubscriptionLive" | "CustomerMismatch" | "SubscriptionNotFound" | "CustomerNotFound" | "TooManySubscriptions";

/** How many of a customer's subscriptions the check lists, newest first. */
const SUBSCRIPTIONS_LISTED = 10;
const DAY_MS = 86_400_000;

const iso = (ms: number) => new Date(ms).toISOString();
const errorName = (error: unknown) => (error as { name?: string } | null)?.name ?? "Unknown";
const isMissing = (error: unknown) => (error as { code?: unknown } | null)?.code === "resource_missing";

export function createTeamLapseHandler(deps: TeamLapseDeps) {
  const { db, obs } = deps;
  const clock = deps.now ?? Date.now;

  /** Emails each owner `input` once for (`kind`, `anchor`). Returns how many owners it claimed now, and sent to. */
  async function notify(team: LapseTeam, kind: string, anchor: string, input: TeamNoticeInput, now: Date): Promise<{ claimed: number; sent: number }> {
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
    return { claimed, sent };
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
    return page.has_more === true ? { why: "TooManySubscriptions" } : true;
  }

  /** One team (see the top). Throws on a failure, for the caller to count. */
  async function handle(teamId: string, now: Date, readOnly: { count: number }): Promise<LapseOutcome> {
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
    readOnly.count++;
    // The date the team is closed for deletion: its deleteAfter, or LAPSE_WARNING_DAYS after the warning
    // (sent now, if it hasn't been), whichever is later. Read first, so the read-only email states it too
    let deletesAt: number | undefined;
    let warned: string | undefined;
    if (access.deleteAfter) {
      const deleteAfter = Date.parse(access.deleteAfter);
      if (at >= deleteAfter - LAPSE_WARNING_DAYS * DAY_MS) warned = await warnedAt(db, teamId, access.deleteAfter);
      deletesAt = Math.max(deleteAfter, (warned ? Date.parse(warned) : at) + LAPSE_WARNING_DAYS * DAY_MS);
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
    if (at < deleteAfter - LAPSE_WARNING_DAYS * DAY_MS) return "nothing";
    if (!warned) {
      // 4: retried each UTC day until an owner gets it; recorded only then
      const { claimed, sent } = await notify(team, `deletionWarning-${now.toISOString().slice(0, 10).replaceAll("-", "")}`, access.deleteAfter, { kind: "deletionWarning", teamName: team.name, deletesAt: iso(deletesAt) }, now);
      // Every owner already claimed today, by a run that counted its failures or stopped before recording: tomorrow's tries again
      if (!claimed && !sent) return "waiting";
      if (!sent) {
        obs.count(BusinessMetric.LapseFailures, 1, { teamId, step: "warning" });
        obs.logger.warn("Lapsed team's deletion warning not delivered", { teamId, deleteAfter: access.deleteAfter });
        return "failed";
      }
      warned = await recordWarning(db, teamId, access.deleteAfter, now);
      obs.logger.info("Lapsed team warned of deletion", { teamId, reason: access.reason ?? "", deleteAfter: access.deleteAfter, deletesAt: iso(Math.max(deleteAfter, Date.parse(warned) + LAPSE_WARNING_DAYS * DAY_MS)) });
      return "waiting";
    }
    if (at < deletesAt) return "waiting";
    // 5: Stripe again, then the closure
    const agrees = await stripeAgrees(team);
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
    obs.count(BusinessMetric.LapsedTeamsClosed, 1, { teamId, reason: access.reason ?? "" });
    obs.logger.info("Lapsed team closed for deletion", { teamId, reason: access.reason ?? "", deleteAfter: access.deleteAfter, warnedAt: warned, subscriptionId: team.stripeSubscriptionId ?? "" });
    return "closed";
  }

  return async (): Promise<{ checked: number; closed: number; failed: number }> => {
    const started = clock();
    const now = new Date(started);
    const teams = await listLapseCandidates(db, now);
    const readOnly = { count: 0 };
    let closed = 0;
    let failed = 0;
    let unstarted = 0;
    for (const teamId of teams) {
      if (clock() - started > LAPSE_BUDGET_MS) {
        unstarted++;
        continue;
      }
      try {
        const outcome = await handle(teamId, now, readOnly);
        if (outcome === "closed") closed++;
        if (outcome === "failed") failed++;
      } catch (error) {
        failed++;
        obs.count(BusinessMetric.LapseFailures, 1, { teamId, step: "error" });
        obs.logger.error("Lapsed team check failed", { teamId, error: errorName(error), ...stripeErrorFields(error) });
      }
    }
    obs.gauge(BusinessMetric.LapseTeamsChecked, teams.length - unstarted);
    obs.gauge(BusinessMetric.LapseTeamsReadOnly, readOnly.count);
    if (unstarted) obs.logger.warn("Lapsed-team job ran out of time: the rest wait for the next run", { unstarted });
    obs.logger.info("Lapsed-team job ran", { listed: teams.length, closed, failed, readOnly: readOnly.count, unstarted });
    return { checked: teams.length - unstarted, closed, failed };
  };
}
