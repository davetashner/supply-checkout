// The "your report is fixed" email's data calls (data/feedback-fixed.ts)
// against DynamoDB Local (skipped without DYNAMODB_ENDPOINT; `npm run test:ddb`
// runs it): reports as the app stores them and the owner's CLI resolves them,
// the status index, the filter, and the once-only mark with the real
// expressions.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  claimFixedNotice,
  closeTeam,
  createTeam,
  feedbackInput,
  isReportTeamMember,
  listFixedReports,
  readFixedTeam,
  recordFixedRefused,
  releaseFixedNotice,
  sendFeedback,
} from "../src/data/index.js";
import { recordFeedbackBead, resolveFeedback } from "../src/data/feedback-owner.js";
import { endpoint, rawItem, useTable } from "./helpers.js";

const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-27T12:00:00.000Z");

describe.skipIf(!endpoint)("the report fixed email's data (DynamoDB Local)", () => {
  const table = useTable();

  async function resolvedReport(teamName: string, options: { contactOk: boolean; message?: string; resolvedAt?: string; release?: string }) {
    const ownerId = randomUUID();
    const made = await createTeam(table.db, { userId: ownerId, email: `owner.${ownerId}@example.com` }, { name: teamName }, at("2026-10-20T00:00:00.000Z"));
    const sent = await sendFeedback(table.db, made.context, feedbackInput({ category: "bug", message: options.message ?? "The scan froze", expected: "A scan", contactOk: options.contactOk }), `key-${ownerId}-0001`, at("2026-10-20T01:00:00.000Z"));
    await recordFeedbackBead(table.db, made.team.teamId, sent.reportId, "supply-checkout-abc.1");
    await resolveFeedback(table.db, made.team.teamId, sent.reportId, { release: options.release ?? "1.22.0", at: at(options.resolvedAt ?? "2026-10-27T10:00:00.000Z") });
    return { made, ownerId, report: { teamId: made.team.teamId, reportId: sent.reportId } };
  }

  it("lists only resolved, contact OK, unmarked, recent reports, with the sender's id, text and release, and nothing else", async () => {
    const yes = await resolvedReport("Yes Co", { contactOk: true, message: "Tell me" });
    await resolvedReport("No Co", { contactOk: false });
    await resolvedReport("Old Co", { contactOk: true, resolvedAt: "2026-10-12T11:59:59.999Z" });
    const triaged = await createTeam(table.db, { userId: randomUUID() }, { name: "Triaged Co" }, at("2026-10-20T00:00:00.000Z"));
    const sent = await sendFeedback(table.db, triaged.context, feedbackInput({ category: "bug", message: "Not yet", contactOk: true }), "key-triaged-0001", at("2026-10-20T01:00:00.000Z"));
    await recordFeedbackBead(table.db, triaged.team.teamId, sent.reportId, "supply-checkout-abc.2");

    const listed = await listFixedReports(table.db, NOW, 50);
    expect(listed.invalid).toBe(0);
    expect(listed.reports).toEqual([{ ...yes.report, userId: yes.ownerId, message: "Tell me", release: "1.22.0", resolvedAt: "2026-10-27T10:00:00.000Z" }]);
    // The limit
    expect((await listFixedReports(table.db, NOW, 1)).reports).toHaveLength(1);
  });

  it("marks a report once, gives the mark back only while it is ours, and records a refusal", async () => {
    const { report } = await resolvedReport("Mark Co", { contactOk: true });
    expect(await claimFixedNotice(table.db, report, "sent", NOW)).toBe(true);
    expect(await rawItem(table.db, `FEEDBACK#${report.teamId}`, `REPORT#${report.reportId}`)).toMatchObject({ notifiedAt: NOW.toISOString(), notifyOutcome: "sent", status: "resolved" });
    expect(await claimFixedNotice(table.db, report, "sent", NOW)).toBe(false);
    expect((await listFixedReports(table.db, NOW, 50)).reports).toEqual([]);

    // Someone else's mark (another time) is not given back or changed
    expect(await releaseFixedNotice(table.db, report, at("2026-10-27T11:00:00.000Z"))).toBe(false);
    expect(await recordFixedRefused(table.db, report, at("2026-10-27T11:00:00.000Z"))).toBe(false);
    expect(await recordFixedRefused(table.db, report, NOW)).toBe(true);
    expect(await rawItem(table.db, `FEEDBACK#${report.teamId}`, `REPORT#${report.reportId}`)).toMatchObject({ notifyOutcome: "refused" });
    // A refused report's mark stays
    expect(await releaseFixedNotice(table.db, report, NOW)).toBe(false);
    expect(await claimFixedNotice(table.db, report, "sent", NOW)).toBe(false);
  });

  it("gives the claim back so the next run can claim it", async () => {
    const { report } = await resolvedReport("Release Co", { contactOk: true });
    expect(await claimFixedNotice(table.db, report, "sent", NOW)).toBe(true);
    expect(await releaseFixedNotice(table.db, report, NOW)).toBe(true);
    const raw = await rawItem(table.db, `FEEDBACK#${report.teamId}`, `REPORT#${report.reportId}`);
    expect(raw).not.toHaveProperty("notifiedAt");
    expect(raw).not.toHaveProperty("notifyOutcome");
    expect((await listFixedReports(table.db, NOW, 50)).reports.map((r) => r.reportId)).toContain(report.reportId);
    expect(await claimFixedNotice(table.db, report, "skipped", NOW)).toBe(true);
    // A skipped mark is not given back as if it were a send
    expect(await releaseFixedNotice(table.db, report, NOW)).toBe(false);
  });

  it("claims nothing for a report that is not resolved, did not tick contact OK, or does not exist", async () => {
    const triaged = await createTeam(table.db, { userId: randomUUID() }, { name: "T Co" }, at("2026-10-20T00:00:00.000Z"));
    const sent = await sendFeedback(table.db, triaged.context, feedbackInput({ category: "bug", message: "x", contactOk: true }), "key-claim-0001", at("2026-10-20T01:00:00.000Z"));
    expect(await claimFixedNotice(table.db, { teamId: triaged.team.teamId, reportId: sent.reportId }, "sent", NOW)).toBe(false);
    const { report } = await resolvedReport("NoContact Co", { contactOk: false });
    expect(await claimFixedNotice(table.db, report, "sent", NOW)).toBe(false);
    expect(await claimFixedNotice(table.db, { teamId: "no-such-team", reportId: "no-such-report" }, "sent", NOW)).toBe(false);
    // And nothing was created by the attempt
    expect(await rawItem(table.db, "FEEDBACK#no-such-team", "REPORT#no-such-report")).toBeUndefined();
  });

  it("reads a team's standing and the sender's membership", async () => {
    const { made, ownerId } = await resolvedReport("Standing Co", { contactOk: true });
    expect(await readFixedTeam(table.db, made.team.teamId)).toEqual({ closed: false, purging: false });
    expect(await readFixedTeam(table.db, "no-such-team")).toBeUndefined();
    expect(await isReportTeamMember(table.db, made.team.teamId, ownerId)).toBe(true);
    expect(await isReportTeamMember(table.db, made.team.teamId, randomUUID())).toBe(false);
    await closeTeam(table.db, made.context, { confirmName: "Standing Co", onlyMember: true }, NOW);
    expect(await readFixedTeam(table.db, made.team.teamId)).toEqual({ closed: true, purging: false });
  });
});
