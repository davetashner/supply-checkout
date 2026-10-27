// The daily returns digest (supply-checkout-phhw), run once a day in the
// primary region (RETURNS_DIGEST_HOUR_UTC in names.ts). Each owner of a team
// that had a project returned (closed) in the past day gets one email listing
// them, clearly labeled as a daily digest, the way an owner asked for after
// "email me when an inventory list is returned": a digest, not one email per
// project.
//
// The window: the 24 hours ending at the most recent RETURNS_DIGEST_HOUR_UTC
// o'clock (digestWindow), a project's `closedAt` from its start (included) to
// its end (excluded). A run that is late or tried again computes the same
// window, and consecutive windows meet exactly.
//
// What it reads: every team's returns in the window, from GSI2's
// `RETURNED#<day>` partitions (listReturnedProjects: no scan, no team
// partition), then for each team that had any: its META item (a closed or
// purging team, or one read-only for billing, is skipped), its current owners
// and their addresses (the operators' index), and each owner's chosen
// language (English if none). A team with no return in the window is never
// read, and no email goes out on a quiet day.
//
// Once: before sending to an owner it claims that owner's digest for the
// window (claimDigest), so a retry or overlapping run never sends it twice. A
// send that fails (not SES refusing the address) gives its claim back and the
// run fails at its end, so Lambda tries it again and only the owners not yet
// sent are sent. SES refusing the message (a suppressed address) is counted
// and not retried.
//
// Isolation: a team's email lists only the projects whose own item keys name
// that team (listReturnedProjects), and goes only to that team's current
// owners (the index of its owners' partition).
//
// Logged and counted: team IDs and counts, outcomes, error names. Never a
// name, an email, a client or a project.

import { billingAccess, claimDigest, type Db, type DigestTeam, listOwnerEmails, listReturnedProjects, ownerLanguage, readDigestTeam, releaseDigest, type ReturnedProject } from "../data/index.js";
import { EmailNotSentError, type Mailer, sendTeamNotice } from "../email/mailer.js";
import { BusinessMetric, type Observability, testMark } from "../observability/index.js";
import { RETURNS_DIGEST_HOUR_UTC, RETURNS_DIGEST_MAX_LISTED, RETURNS_DIGEST_WINDOW_MS } from "./names.js";

export interface ReturnsDigestDeps {
  readonly db: Db;
  readonly obs: Observability;
  readonly mailer: Mailer;
  readonly now?: () => number;
}

/** What a run did, for the log line and the tests. */
export interface ReturnsDigestResult {
  /** The window the run reported, as ISO times: `from` included, `to` excluded. */
  readonly from: string;
  readonly to: string;
  /** Teams with a return in the window. */
  readonly teams: number;
  readonly sent: number;
  readonly failed: number;
}

/** The window one run reports: the 24 hours ending at the latest RETURNS_DIGEST_HOUR_UTC o'clock at or before `now`. */
export function digestWindow(now: Date): { readonly from: Date; readonly to: Date } {
  const slot = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), RETURNS_DIGEST_HOUR_UTC);
  const to = slot > now.getTime() ? slot - 86_400_000 : slot;
  return { from: new Date(to - RETURNS_DIGEST_WINDOW_MS), to: new Date(to) };
}

/** SES refusals that trying again won't change: the address, the message, or the account (a throttle or an outage isn't one, and is tried again). */
const PERMANENT = new Set(["InvalidRecipient", "RenderFailed", "MessageRejected", "AccountSuspendedException", "SendingPausedException", "MailFromDomainNotVerifiedException", "NotFoundException", "BadRequestException"]);

const errorName = (error: unknown) => (error instanceof EmailNotSentError ? error.code : ((error as { name?: string } | null)?.name ?? "Unknown"));

export function createReturnsDigestHandler(deps: ReturnsDigestDeps) {
  const { db, obs } = deps;

  async function digestTeam(team: DigestTeam, projects: readonly ReturnedProject[], window: { from: Date; to: Date }, now: Date): Promise<{ sent: number; failed: number; retry: boolean }> {
    const { teamId } = team;
    const mark = testMark(team.test);
    const none = { sent: 0, failed: 0, retry: false };
    if (team.closedAt !== undefined || team.purging !== undefined) {
      obs.logger.info("Returns digest skipped: team is closed", { teamId });
      return none;
    }
    if (billingAccess(team, now).readOnly) {
      obs.logger.info("Returns digest skipped: team is read-only for billing", { teamId });
      return none;
    }
    const owners = await listOwnerEmails(db, teamId);
    if (owners.length === 0) {
      obs.logger.info("Returns digest skipped: team has no owners", { teamId });
      return none;
    }
    const ordered = [...projects].sort((a, b) => (a.closedAt < b.closedAt ? -1 : a.closedAt > b.closedAt ? 1 : a.projectId < b.projectId ? -1 : 1));
    const listed = ordered.slice(0, RETURNS_DIGEST_MAX_LISTED).map(({ client, date, preparedBy }) => ({ client, ...(date ? { date } : {}), ...(preparedBy ? { preparedBy } : {}) }));
    let sent = 0;
    let failed = 0;
    let retry = false;
    const fail = (reason: string, code: string) => {
      failed++;
      obs.count(BusinessMetric.ReturnsDigestFailures, 1, { teamId, reason, ...mark });
      obs.logger.warn("Returns digest not sent", { teamId, reason, code });
    };
    for (const owner of owners) {
      if (!owner.email) {
        fail("no_address", "NoAddress");
        continue;
      }
      let claimed: boolean;
      try {
        claimed = await claimDigest(db, teamId, window.to, owner.userId, now);
      } catch (error) {
        fail("claim_failed", errorName(error));
        retry = true;
        continue;
      }
      if (!claimed) continue;
      let language: Awaited<ReturnType<typeof ownerLanguage>>;
      try {
        language = await ownerLanguage(db, owner.userId);
      } catch (error) {
        // Their language is a nicety: send in English rather than not at all
        obs.logger.warn("Returns digest language not read", { teamId, code: errorName(error) });
      }
      try {
        await sendTeamNotice(deps.mailer, owner.email, teamId, {
          kind: "returnsDigest",
          teamName: team.name,
          ...(language ? { language } : {}),
          windowEnd: window.to.toISOString(),
          total: ordered.length,
          projects: listed,
        });
        sent++;
        obs.count(BusinessMetric.ReturnsDigests, 1, { teamId, ...mark });
      } catch (error) {
        const refused = error instanceof EmailNotSentError && PERMANENT.has(error.code);
        fail(refused ? "refused" : "send_failed", errorName(error));
        // Not refused: give the claim back so the retry sends it. A refused address stays claimed: trying again won't change SES's mind
        if (!refused) {
          retry = true;
          try {
            await releaseDigest(db, teamId, window.to, owner.userId);
          } catch (release) {
            obs.logger.error("Returns digest claim not given up", { teamId, code: errorName(release) });
          }
        }
      }
    }
    return { sent, failed, retry };
  }

  return async (): Promise<ReturnsDigestResult> => {
    const now = new Date((deps.now ?? Date.now)());
    const window = digestWindow(now);
    const returned = await listReturnedProjects(db, window.from, window.to);
    // Every run that could list the day's returns, quiet or not: its absence is "Returns digest not running"
    obs.gauge(BusinessMetric.ReturnsDigestTeams, returned.size);
    let sent = 0;
    let failed = 0;
    let retry = false;
    for (const [teamId, projects] of returned) {
      try {
        const team = await readDigestTeam(db, teamId);
        if (!team) {
          obs.logger.info("Returns digest skipped: team is gone", { teamId });
          continue;
        }
        const result = await digestTeam(team, projects, window, now);
        sent += result.sent;
        failed += result.failed;
        retry ||= result.retry;
      } catch (error) {
        failed++;
        retry = true;
        obs.count(BusinessMetric.ReturnsDigestFailures, 1, { teamId, reason: "error" });
        obs.logger.error("Returns digest failed for a team", { teamId, error: errorName(error) });
      }
    }
    const result = { from: window.from.toISOString(), to: window.to.toISOString(), teams: returned.size, sent, failed };
    obs.logger.info("Returns digest", result);
    // Fail the run so Lambda tries it again: the claims leave out whoever was already sent
    if (retry) throw new Error("Returns digest: some sends failed and will be tried again");
    return result;
  };
}
