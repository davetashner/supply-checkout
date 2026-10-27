// The "your report is fixed" email (supply-checkout-7id1): when the owner
// resolves a report (`npm run feedback -- resolve`, supply-checkout-lxbs) and
// its sender ticked contact OK, the sender is emailed once that it's fixed and
// in which release.
//
// A scheduled function (every REPORT_FIXED_EVERY_MINUTES) rather than the
// owner's CLI: the CLI runs on a laptop with the owner's own credentials, which
// must not also hold the right to email users, and a scheduled run retries a
// failed send by itself. Its own narrow role (schema.ts, REPORT_FIXED_*): it
// is not the ops role, which returns messages and user IDs broadly.
//
// Each run lists the resolved reports not yet marked (listFixedReports: contact
// OK, resolved within REPORT_FIXED_MAX_AGE_DAYS, the oldest first, at most
// REPORT_FIXED_MAX_PER_RUN). For each, at send time:
//
// - the team must still be there and not be purging (a closed team is left for
//   a later run: it may reopen), and the sender must still be on it; if not,
//   the report is marked skipped and nobody is told;
// - the sender is looked up in the app pool by their sub (cognitoAccounts); a
//   user who is gone is skipped and marked; one with no verified address is
//   skipped and logged, not marked (they may verify later). The address is
//   the pool's current one, never stored on the report, never logged;
// - their chosen language (English if none);
// - the report's mark is claimed by a conditional write (claimFixedNotice) just
//   before sending: still resolved, still contact OK, no mark. So a retry, an
//   overlapping run or a second report never sends twice. A send that fails
//   gives the claim back so the next run sends it; SES refusing the message
//   (an address it won't send to) keeps the mark (outcome `refused`) and is
//   counted, since trying again won't change SES's mind.
//
// A release that isn't a well-formed version is not sent (the template refuses
// it too). The email shows the report's own text, capped and defanged, and only
// a link to the app; it goes only to that report's sender.
//
// Logs and metrics carry team and report IDs, counts, outcomes and error names:
// never a message, an address or a name. (The sender's sub is not logged either.)

import { claimFixedNotice, type Db, type FixedReport, isReportTeamMember, isTestAccount, listFixedReports, normalizeEmail, ownerLanguage, readFixedTeam, recordFixedRefused, releaseFixedNotice } from "../data/index.js";
import type { FindAccount } from "../identity/cognito-accounts.js";
import { BusinessMetric, type Observability, testMark } from "../observability/index.js";
import { EmailNotSentError, type Mailer } from "./mailer.js";
import { REPORT_FIXED_MAX_PER_RUN } from "./names.js";

export interface ReportFixedDeps {
  /** The app pool (ListUsers and AdminGetUser only). */
  readonly findAccount: FindAccount;
  /** The app table, as the function's role reaches it (REPORT_FIXED_* in schema.ts). */
  readonly db: Db;
  readonly mailer: Mailer;
  readonly obs: Observability;
  /** The test mail domain (data/test-accounts.ts): a test account's email is left out of ReportFixedEmails. */
  readonly testMailDomain?: string;
  readonly now?: () => number;
}

/** What a run did, for the log line and the tests. */
export interface ReportFixedResult {
  readonly candidates: number;
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
}

/** SES refusals that trying again won't change: the address, the message, or the account (a throttle or an outage isn't one, and is tried again). */
const PERMANENT = new Set(["InvalidRecipient", "RenderFailed", "MessageRejected", "AccountSuspendedException", "SendingPausedException", "MailFromDomainNotVerifiedException", "NotFoundException", "BadRequestException"]);

const errorName = (error: unknown) => (error instanceof EmailNotSentError ? error.code : ((error as { name?: string } | null)?.name ?? "Unknown"));

export function createReportFixedHandler(deps: ReportFixedDeps) {
  const { db, obs } = deps;

  return async (): Promise<ReportFixedResult> => {
    const now = new Date((deps.now ?? Date.now)());
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    let retry = false;

    const fail = (report: Pick<FixedReport, "teamId" | "reportId">, reason: string, code: string) => {
      failed++;
      obs.count(BusinessMetric.ReportFixedEmailFailures, 1, { teamId: report.teamId, reason });
      obs.logger.warn("Report fixed email not sent", { teamId: report.teamId, reportId: report.reportId, reason, code });
    };
    /** Marks a report nobody can be told about, so later runs don't look it up again. */
    const skip = async (report: FixedReport, reason: string) => {
      skipped++;
      obs.logger.info("Report fixed email skipped", { teamId: report.teamId, reportId: report.reportId, reason });
      await claimFixedNotice(db, report, "skipped", now);
    };

    async function tell(report: FixedReport): Promise<void> {
      const team = await readFixedTeam(db, report.teamId);
      if (!team || team.purging) return skip(report, "team_gone");
      if (team.closed) {
        // It may reopen: not marked, a later run looks again (until the report is too old)
        skipped++;
        obs.logger.info("Report fixed email skipped", { teamId: report.teamId, reportId: report.reportId, reason: "team_closed" });
        return;
      }
      if (!(await isReportTeamMember(db, report.teamId, report.userId))) return skip(report, "not_member");

      let account: Awaited<ReturnType<FindAccount>>;
      try {
        account = await deps.findAccount(report.userId);
      } catch (error) {
        fail(report, "lookup_failed", errorName(error));
        retry = true;
        return;
      }
      if (!account) return skip(report, "user_gone");
      let to: string | undefined;
      try {
        to = account.emailVerified && account.email ? normalizeEmail(account.email) : undefined;
      } catch {
        to = undefined;
      }
      if (!to) {
        // Not marked: they may verify an address before the report is too old
        skipped++;
        obs.logger.info("Report fixed email skipped", { teamId: report.teamId, reportId: report.reportId, reason: "no_address" });
        return;
      }

      let language: Awaited<ReturnType<typeof ownerLanguage>>;
      try {
        language = await ownerLanguage(db, report.userId);
      } catch (error) {
        // Their language is a nicety: send in English rather than not at all
        obs.logger.warn("Report fixed email language not read", { teamId: report.teamId, code: errorName(error) });
      }

      if (!(await claimFixedNotice(db, report, "sent", now))) return; // told by another run, or no longer resolved
      try {
        await deps.mailer.send(to, { kind: "reportFixed", message: report.message, release: report.release, ...(language ? { language } : {}) }, { teamId: report.teamId });
      } catch (error) {
        const refused = error instanceof EmailNotSentError && PERMANENT.has(error.code);
        fail(report, refused ? "refused" : "send_failed", errorName(error));
        try {
          if (refused) await recordFixedRefused(db, report, now);
          else {
            // Give the claim back so the next run sends it
            retry = true;
            await releaseFixedNotice(db, report, now);
          }
        } catch (mark) {
          obs.logger.error("Report fixed email mark not updated", { teamId: report.teamId, reportId: report.reportId, code: errorName(mark) });
        }
        return;
      }
      sent++;
      obs.count(BusinessMetric.ReportFixedEmails, 1, { teamId: report.teamId, ...testMark(isTestAccount(account, deps.testMailDomain)) });
      obs.logger.info("Report fixed email sent", { teamId: report.teamId, reportId: report.reportId });
    }

    const { reports, invalid } = await listFixedReports(db, now, REPORT_FIXED_MAX_PER_RUN);
    if (invalid > 0) obs.logger.warn("Report fixed email: resolved reports skipped as malformed", { invalid });
    for (const report of reports) {
      try {
        await tell(report);
      } catch (error) {
        fail(report, "error", errorName(error));
        retry = true;
      }
    }
    const result = { candidates: reports.length, sent, skipped, failed };
    obs.logger.info("Report fixed emails", result);
    // Fail the run so it shows as an error; the marks leave out whoever was already told, and the next run carries on
    if (retry) throw new Error("Report fixed emails: some sends failed and will be tried again");
    return result;
  };
}
