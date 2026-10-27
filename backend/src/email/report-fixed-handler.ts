// The emails to a report's sender (supply-checkout-7id1, supply-checkout-c8vj.1):
// for a report whose sender ticked contact OK, one email at each of three
// stages, each at most once per report: received (the report is `new`: we got
// it, and will write again), being looked at (`triaged`: never the bead ID, the
// dismiss reason or any internal text), and fixed (`resolved`, by `npm run
// feedback -- resolve`, supply-checkout-lxbs: with the release). A dismissed
// report gets none. A report is mailed at the stage it is in when a run reaches
// it: one that went from new to resolved within an interval gets only the fixed
// email, never the earlier two. The POST route sends nothing, so the API
// function's IAM is unchanged; the received email follows within an interval.
//
// A scheduled function (every REPORT_FIXED_EVERY_MINUTES) rather than the
// owner's CLI: the CLI runs on a laptop with the owner's own credentials, which
// must not also hold the right to email users, and a scheduled run retries a
// failed send by itself. Its own narrow role (schema.ts, REPORT_FIXED_*): it
// is not the ops role, which returns messages and user IDs broadly.
//
// Each run lists the reports not yet marked for their stage (listFixedReports:
// contact OK, the stage began within REPORT_FIXED_MAX_AGE_DAYS, at most
// REPORT_FIXED_MAX_PER_RUN places in a run, used by reports sent, claimed or marked; one left for a later run (closed team, no verified address, failed lookup) uses none, so a pile of stuck reports cannot starve newer ones). For each, at send time:
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
// A fixed report whose release isn't a well-formed version is not sent (the template refuses
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

    const fail = (report: Pick<FixedReport, "teamId" | "reportId" | "stage">, reason: string, code: string) => {
      failed++;
      obs.count(BusinessMetric.ReportFixedEmailFailures, 1, { teamId: report.teamId, reason, stage: report.stage });
      obs.logger.warn("Report email not sent", { teamId: report.teamId, reportId: report.reportId, stage: report.stage, reason, code });
    };
    /** Marks a report nobody can be told about, so later runs don't look it up again. */
    const skip = async (report: FixedReport, reason: string) => {
      skipped++;
      obs.logger.info("Report email skipped", { teamId: report.teamId, reportId: report.reportId, stage: report.stage, reason });
      await claimFixedNotice(db, report, "skipped", now);
    };

    /** Whether the report used up a place in the run: false for one left for a later run (closed team, no verified address, lookup failed), which would otherwise starve newer ones of the cap. */
    async function tell(report: FixedReport): Promise<boolean> {
      const team = await readFixedTeam(db, report.teamId);
      if (!team || team.purging) return skip(report, "team_gone").then(() => true);
      if (team.closed) {
        // It may reopen: not marked, a later run looks again (until the report is too old)
        skipped++;
        obs.logger.info("Report email skipped", { teamId: report.teamId, reportId: report.reportId, stage: report.stage, reason: "team_closed" });
        return false;
      }
      if (!(await isReportTeamMember(db, report.teamId, report.userId))) return skip(report, "not_member").then(() => true);

      let account: Awaited<ReturnType<FindAccount>>;
      try {
        account = await deps.findAccount(report.userId);
      } catch (error) {
        fail(report, "lookup_failed", errorName(error));
        retry = true;
        return false;
      }
      if (!account) return skip(report, "user_gone").then(() => true);
      let to: string | undefined;
      try {
        to = account.emailVerified && account.email ? normalizeEmail(account.email) : undefined;
      } catch {
        to = undefined;
      }
      if (!to) {
        // Not marked: they may verify an address before the report is too old
        skipped++;
        obs.logger.info("Report email skipped", { teamId: report.teamId, reportId: report.reportId, stage: report.stage, reason: "no_address" });
        return false;
      }

      let language: Awaited<ReturnType<typeof ownerLanguage>>;
      try {
        language = await ownerLanguage(db, report.userId);
      } catch (error) {
        // Their language is a nicety: send in English rather than not at all
        obs.logger.warn("Report email language not read", { teamId: report.teamId, code: errorName(error) });
      }

      if (!(await claimFixedNotice(db, report, "sent", now))) return true; // told by another run, or no longer in this stage
      try {
        await deps.mailer.send(to, { kind: "reportUpdate", stage: report.stage, message: report.message, ...(report.stage === "resolved" ? { release: report.release } : {}), ...(language ? { language } : {}) }, { teamId: report.teamId });
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
          obs.logger.error("Report email mark not updated", { teamId: report.teamId, reportId: report.reportId, stage: report.stage, code: errorName(mark) });
        }
        return true;
      }
      sent++;
      obs.count(BusinessMetric.ReportFixedEmails, 1, { teamId: report.teamId, stage: report.stage, ...testMark(isTestAccount(account, deps.testMailDomain)) });
      obs.logger.info("Report email sent", { teamId: report.teamId, reportId: report.reportId, stage: report.stage });
      return true;
    }

    const { reports, invalid } = await listFixedReports(db, now);
    if (invalid > 0) obs.logger.warn("Report emails: reports skipped as malformed", { invalid });
    let used = 0;
    for (const report of reports) {
      if (used >= REPORT_FIXED_MAX_PER_RUN) break;
      try {
        if (await tell(report)) used++;
      } catch (error) {
        fail(report, "error", errorName(error));
        retry = true;
      }
    }
    const result = { candidates: reports.length, sent, skipped, failed };
    obs.logger.info("Report emails", result);
    // Fail the run so it shows as an error; the marks leave out whoever was already told, and the next run carries on
    if (retry) throw new Error("Report emails: some sends failed and will be tried again");
    return result;
  };
}
