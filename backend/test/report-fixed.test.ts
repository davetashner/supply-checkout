// The "your report is fixed" email (src/email/report-fixed-handler.ts,
// supply-checkout-7id1) against the in-memory table, each call passing only
// what the function's role allows (reportFixedPolicy in ops-policy.ts), with a
// fake mailer and a fake app pool. The once-only mark's expressions also run
// against DynamoDB Local in report-fixed-ddb.test.ts.

import { beforeEach, describe, expect, it } from "vitest";
import { claimFixedNotice, listFixedReports, recordFixedRefused, releaseFixedNotice } from "../src/data/index.js";
import { createReportFixedHandler } from "../src/email/report-fixed-handler.js";
import { REPORT_FIXED_MAX_PER_RUN } from "../src/email/names.js";
import type { FindAccount, PoolAccount } from "../src/identity/cognito-accounts.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { fakeDb, fakeMailer, REGION } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";
import { reportFixedPolicy } from "./ops-policy.js";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const RESOLVED = "2026-10-27T10:00:00.000Z";
const TEAM = "team-a";
const SENDER = "4f1c2b7e-9a3d-4e5f-8b6a-1c2d3e4f5a6b";
const OTHER = "9a3d4f1c-2b7e-4e5f-8b6a-6b5a4f3e2d1c";
const MESSAGE = "PRIVATE the scan button does nothing";
const ADDRESS = "sender.private@example.com";

let table: MemoryTable;
let denied: { command: string; input: Record<string, unknown> }[];
let mails: ReturnType<typeof fakeMailer>;
let counts: [string, number, Record<string, unknown>][];
let logs: [string, string, Record<string, unknown>][];
let accounts: Map<string, PoolAccount | Error>;
let lookups: string[];

function obs(): Observability {
  const log = (level: string) => (message: string, data: Record<string, unknown> = {}) => logs.push([level, message, data]);
  return {
    region: REGION,
    logger: { info: log("info"), warn: log("warn"), error: log("error"), addContext: () => {} } as unknown as Observability["logger"],
    count: (metric, value = 1, metadata = {}) => counts.push([metric, value, metadata as Record<string, unknown>]),
    gauge: () => {},
    flush: () => {},
  };
}

const findAccount: FindAccount = async (sub) => {
  lookups.push(sub);
  const found = accounts.get(sub);
  if (found instanceof Error) throw found;
  return found;
};

const account = (extra: Partial<PoolAccount> = {}): PoolAccount => ({ username: "u", email: ADDRESS, emailVerified: true, emailVerifiedInCognito: true, totpEnabled: false, ...extra });

/** A resolved report, stored the way resolveFeedback leaves it, with its team and the sender's membership. */
function report(reportId: string, fields: Record<string, unknown> = {}, options: { team?: Record<string, unknown> | false; member?: boolean } = {}) {
  const teamId = (fields.teamId as string | undefined) ?? TEAM;
  table.put({
    PK: `FEEDBACK#${teamId}`,
    SK: `REPORT#${reportId}`,
    GSI1PK: "FEEDBACK#STATUS#resolved",
    GSI1SK: `2026-10-20T00:00:00.000Z#${reportId}`,
    type: "feedback",
    reportId,
    shortId: reportId.slice(0, 8),
    teamId: TEAM,
    userId: SENDER,
    role: "contributor",
    createdAt: "2026-10-20T00:00:00.000Z",
    category: "bug",
    message: MESSAGE,
    expected: "SECRET expected text",
    contactOk: true,
    context: { build: "1.0.0" },
    status: "resolved",
    beadId: "supply-checkout-abc",
    statusAt: RESOLVED,
    resolvedAt: RESOLVED,
    release: "1.22.0",
    expiresAt: 1_900_000_000,
    ...fields,
  });
  if (options.team !== false) table.put({ PK: `TEAM#${teamId}`, SK: "META", type: "team", teamId, name: "Echo", status: "active", ...options.team });
  if (options.member !== false) table.put({ PK: `TEAM#${teamId}`, SK: `MEMBER#${(fields.userId as string | undefined) ?? SENDER}`, type: "member", role: "contributor", email: "stored.private@example.com" });
}

const mark = (reportId: string, teamId = TEAM) => table.get(`FEEDBACK#${teamId}`, `REPORT#${reportId}`) as Record<string, unknown>;
const run = (at = NOW, options: { testMailDomain?: string } = {}) => createReportFixedHandler({ db: table.guarded(reportFixedPolicy(denied)), obs: obs(), mailer: mails.mailer, findAccount, now: () => at, ...options })();
const counted = (metric: string) => counts.filter(([m]) => m === metric).reduce((n, [, v]) => n + v, 0);
const failures = () => counts.filter(([m]) => m === BusinessMetric.ReportFixedEmailFailures).map(([, , meta]) => meta.reason);

beforeEach(() => {
  table = new MemoryTable();
  denied = [];
  mails = fakeMailer();
  counts = [];
  logs = [];
  accounts = new Map([[SENDER, account()]]);
  lookups = [];
});

/** No address, report text or sender ID, in any case, anywhere in the logs or metrics. */
function expectNothingPersonal() {
  const text = JSON.stringify({ logs, counts });
  expect(text).not.toMatch(/example\.com|private|secret expected/i);
  expect(text).not.toContain(SENDER);
}

describe("telling the sender", () => {
  it("emails the sender once, at the pool's current verified address, with their own text and the release, and marks the report", async () => {
    report("report-0001");
    expect(await run()).toEqual({ candidates: 1, sent: 1, skipped: 0, failed: 0 });
    expect(mails.sent).toEqual([{ to: ADDRESS, input: { kind: "reportUpdate", stage: "resolved", message: MESSAGE, release: "1.22.0" }, tags: { teamId: TEAM } }]);
    expect(mark("report-0001")).toMatchObject({ notifiedResolvedAt: new Date(NOW).toISOString(), notifiedResolvedOutcome: "sent", status: "resolved" });
    expect(counted(BusinessMetric.ReportFixedEmails)).toBe(1);
    expect(counts.find(([m]) => m === BusinessMetric.ReportFixedEmails)?.[2]).toEqual({ teamId: TEAM, stage: "resolved" });
    expect(denied).toEqual([]);
    expectNothingPersonal();
    // A second run, and a third later, send nothing more
    expect(await run()).toMatchObject({ candidates: 0, sent: 0 });
    expect(await run(NOW + 3_600_000)).toMatchObject({ candidates: 0, sent: 0 });
    expect(mails.sent).toHaveLength(1);
    // The address is looked up, never read from the report or the member item
    expect(JSON.stringify(table.get(`FEEDBACK#${TEAM}`, "REPORT#report-0001"))).not.toContain("example.com");
  });

  it("sends the address normalized, and in Spanish when the sender chose it", async () => {
    accounts.set(SENDER, account({ email: "  Sender.Private@Example.COM " }));
    table.put({ PK: `USER#${SENDER}`, SK: "PREFERENCES", language: "es", email: "must.not.read@example.com" });
    report("report-0001");
    await run();
    expect(mails.sent[0]?.to).toBe(ADDRESS);
    expect(mails.sent[0]?.input).toMatchObject({ kind: "reportUpdate", language: "es" });
    expect(denied).toEqual([]);
  });

  it("sends in English when the language can't be read", async () => {
    report("report-0001");
    const base = reportFixedPolicy(denied);
    const handler = createReportFixedHandler({ db: table.guarded((command, input) => !(command === "GetCommand" && String((input.Key as { PK: string }).PK).startsWith("USER#")) && base(command, input)), obs: obs(), mailer: mails.mailer, findAccount, now: () => NOW });
    expect(await handler()).toMatchObject({ sent: 1 });
    expect(mails.sent[0]?.input).not.toHaveProperty("language");
    expect(logs.some(([level, message]) => level === "warn" && message === "Report email language not read")).toBe(true);
  });

  it("tells each sender of several reports, oldest first, and a sender of two reports twice (one email per report)", async () => {
    accounts.set(OTHER, account({ email: "other.private@example.com" }));
    report("report-0001");
    report("report-0002", { GSI1SK: "2026-10-19T00:00:00.000Z#report-0002", userId: OTHER, message: "Other text" });
    report("report-0003", {});
    await run();
    expect(mails.sent.map((m) => (m.input as { message: string }).message)).toEqual(["Other text", MESSAGE, MESSAGE]);
    expect(mails.sent[0]?.to).toBe("other.private@example.com");
  });

  it("tells at most REPORT_FIXED_MAX_PER_RUN a run, and carries on at the next", async () => {
    for (let i = 0; i < REPORT_FIXED_MAX_PER_RUN + 3; i++) report(`report-${String(i).padStart(4, "0")}`, { GSI1SK: `2026-10-20T00:00:00.000Z#${i}` });
    expect(await run()).toMatchObject({ candidates: REPORT_FIXED_MAX_PER_RUN, sent: REPORT_FIXED_MAX_PER_RUN });
    expect(await run()).toMatchObject({ candidates: 3, sent: 3 });
    expect(mails.sent).toHaveLength(REPORT_FIXED_MAX_PER_RUN + 3);
  });

  it("leaves a test account's email out of ReportFixedEmails (it is counted with test: true)", async () => {
    accounts.set(SENDER, account({ email: "tester@example.org" }));
    report("report-0001");
    await run(NOW, { testMailDomain: "example.org" });
    expect(counts.find(([m]) => m === BusinessMetric.ReportFixedEmails)?.[2]).toEqual({ teamId: TEAM, stage: "resolved", test: true });
  });
});

describe("the stages", () => {
  const staged = (reportId: string, stage: "new" | "triaged" | "resolved", fields: Record<string, unknown> = {}, options: Parameters<typeof report>[2] = {}) =>
    report(reportId, { status: stage, GSI1PK: `FEEDBACK#STATUS#${stage}`, ...(stage === "resolved" ? {} : { release: undefined, resolvedAt: undefined }), ...fields }, options);
  const stageMail = () => mails.sent.map((m) => (m.input as { stage: string }).stage);

  it("tells a new report we got it, quoting it, with no release, and marks only that stage", async () => {
    staged("report-0001", "new");
    expect(await run()).toMatchObject({ candidates: 1, sent: 1 });
    expect(mails.sent).toEqual([{ to: ADDRESS, input: { kind: "reportUpdate", stage: "received", message: MESSAGE }, tags: { teamId: TEAM } }]);
    expect(mark("report-0001")).toMatchObject({ notifiedReceivedAt: new Date(NOW).toISOString(), notifiedReceivedOutcome: "sent" });
    expect(mark("report-0001")).not.toHaveProperty("notifiedTriagedAt");
    expect(counts.find(([m]) => m === BusinessMetric.ReportFixedEmails)?.[2]).toEqual({ teamId: TEAM, stage: "received" });
    expect(await run()).toMatchObject({ candidates: 0 });
    expect(mails.sent).toHaveLength(1);
    expectNothingPersonal();
  });

  it("then tells it it's being looked at, with nothing internal, and then that it's fixed: one email per stage, each once", async () => {
    staged("report-0001", "new", { beadId: "" });
    await run();
    // The owner triages it: the bead ID and a reason the owner wrote are on the report, and in no email
    table.put({ ...mark("report-0001"), status: "triaged", GSI1PK: "FEEDBACK#STATUS#triaged", beadId: "supply-checkout-secret.1", dismissReason: "INTERNAL NOTE", statusAt: "2026-10-27T11:00:00.000Z" });
    await run(NOW + 60_000);
    await run(NOW + 120_000);
    table.put({ ...mark("report-0001"), status: "resolved", GSI1PK: "FEEDBACK#STATUS#resolved", resolvedAt: RESOLVED, release: "1.22.0" });
    await run(NOW + 180_000);
    await run(NOW + 240_000);
    expect(stageMail()).toEqual(["received", "triaged", "resolved"]);
    expect(JSON.stringify(mails.sent)).not.toMatch(/secret|INTERNAL/);
    expect(mails.sent[1]?.input).toEqual({ kind: "reportUpdate", stage: "triaged", message: MESSAGE });
    expect(mark("report-0001")).toMatchObject({ notifiedReceivedOutcome: "sent", notifiedTriagedOutcome: "sent", notifiedResolvedOutcome: "sent" });
    expectNothingPersonal();
  });

  it("sends only the latest stage to a report that moved on between runs", async () => {
    staged("report-0001", "resolved");
    await run();
    expect(stageMail()).toEqual(["resolved"]);
    expect(mark("report-0001")).not.toHaveProperty("notifiedReceivedAt");
    expect(mark("report-0001")).not.toHaveProperty("notifiedTriagedAt");
  });

  it("tells each stage's reports in one run, received first", async () => {
    staged("report-0003", "resolved");
    staged("report-0002", "triaged");
    staged("report-0001", "new");
    await run();
    expect(stageMail()).toEqual(["received", "triaged", "resolved"]);
  });

  it("stops at the run's limit, with the earlier stage first", async () => {
    for (let i = 0; i < REPORT_FIXED_MAX_PER_RUN; i++) staged(`new-${String(i).padStart(4, "0")}`, "new");
    staged("report-late", "resolved");
    expect(await run()).toMatchObject({ candidates: REPORT_FIXED_MAX_PER_RUN, sent: REPORT_FIXED_MAX_PER_RUN });
    expect(stageMail().every((stage) => stage === "received")).toBe(true);
    expect(await run()).toMatchObject({ candidates: 1 });
    expect(stageMail().at(-1)).toBe("resolved");
  });

  it("tells nobody about a dismissed report, or a new or triaged one whose sender did not tick contact OK", async () => {
    report("report-0001", { status: "dismissed", GSI1PK: "FEEDBACK#STATUS#dismissed", beadId: "" });
    staged("report-0002", "new", { contactOk: false });
    staged("report-0003", "triaged", { contactOk: false });
    expect(await run()).toMatchObject({ candidates: 0 });
    expect(lookups).toEqual([]);
    expect(mails.sent).toEqual([]);
  });

  it("leaves a stage that began too long ago, and takes the age from that stage's own time", async () => {
    staged("report-0001", "new", { createdAt: "2026-10-12T11:59:59.999Z" });
    staged("report-0002", "triaged", { statusAt: "2026-10-12T11:59:59.999Z" });
    staged("report-0003", "new", { createdAt: "2026-10-13T12:00:00.000Z" });
    // Created long ago but triaged lately: told it's being looked at
    staged("report-0004", "triaged", { createdAt: "2026-09-01T00:00:00.000Z", statusAt: RESOLVED });
    await run();
    expect(mails.sent.map((m) => (m.input as { stage: string }).stage).sort()).toEqual(["received", "triaged"]);
  });

  it("does not mail a stage twice when a mark of another stage is there, and does when only that stage is marked", async () => {
    staged("report-0001", "triaged", { notifiedReceivedAt: "2026-10-26T00:00:00.000Z", notifiedReceivedOutcome: "sent" });
    staged("report-0002", "triaged", { notifiedTriagedAt: "2026-10-26T00:00:00.000Z", notifiedTriagedOutcome: "sent" });
    await run();
    expect(mails.sent).toHaveLength(1);
    expect(mark("report-0001")).toMatchObject({ notifiedTriagedOutcome: "sent" });
  });

  it("counts a failure with its stage, and a stage's skip marks only that stage", async () => {
    staged("report-0001", "new", {}, { member: false });
    await run();
    expect(mark("report-0001")).toMatchObject({ notifiedReceivedOutcome: "skipped" });
    expect(mark("report-0001")).not.toHaveProperty("notifiedTriagedOutcome");
    staged("report-0002", "triaged");
    mails.state.fail = "InvalidRecipient";
    await run();
    expect(counts.find(([m]) => m === BusinessMetric.ReportFixedEmailFailures)?.[2]).toEqual({ teamId: TEAM, reason: "refused", stage: "triaged" });
    expect(mark("report-0002")).toMatchObject({ notifiedTriagedOutcome: "refused" });
  });

  it("sends nothing for a stage whose report moved on between listing and claiming", async () => {
    staged("report-0001", "new");
    const base = reportFixedPolicy(denied);
    const handler = createReportFixedHandler({
      db: table.guarded((command, input) => {
        if (command === "GetCommand" && String((input.Key as { PK: string }).PK).startsWith("USER#")) table.put({ ...mark("report-0001"), status: "dismissed", GSI1PK: "FEEDBACK#STATUS#dismissed" });
        return base(command, input);
      }),
      obs: obs(),
      mailer: mails.mailer,
      findAccount,
      now: () => NOW,
    });
    expect(await handler()).toMatchObject({ sent: 0 });
    expect(mails.sent).toEqual([]);
  });
});

describe("who is not told", () => {
  it("nobody who did not tick contact OK, and never looks them up", async () => {
    report("report-0001", { contactOk: false });
    report("report-0002", { contactOk: "true" });
    expect(await run()).toMatchObject({ candidates: 0 });
    expect(mails.sent).toEqual([]);
    expect(lookups).toEqual([]);
    expect(mark("report-0001")).not.toHaveProperty("notifiedResolvedAt");
  });

  it("nothing dismissed, was told already, was resolved long ago, or has a release that isn't a version", async () => {
    report("report-0001", { status: "dismissed", GSI1PK: "FEEDBACK#STATUS#dismissed" });
    report("report-0002", { notifiedResolvedAt: "2026-10-26T00:00:00.000Z", notifiedResolvedOutcome: "sent" });
    report("report-0003", { resolvedAt: "2026-10-12T11:59:59.999Z" });
    report("report-0004", { release: "1.22.0\nWin a prize at evil.example" });
    expect(await run()).toMatchObject({ candidates: 0, sent: 0 });
    // Exactly the cutoff is still in
    report("report-0005", { resolvedAt: "2026-10-13T12:00:00.000Z" });
    expect(await run()).toMatchObject({ candidates: 1, sent: 1 });
    expect(logs.some(([level, message, data]) => level === "warn" && message.includes("malformed") && data.invalid === 1)).toBe(true);
    expect(mails.sent).toHaveLength(1);
  });

  it("nothing for an item whose keys or sender do not hold together", async () => {
    report("report-0001");
    // The item's partition says team-a but its own teamId says another
    table.put({ PK: `FEEDBACK#${TEAM}`, SK: "REPORT#report-0002", GSI1PK: "FEEDBACK#STATUS#resolved", GSI1SK: "z", type: "feedback", reportId: "report-0002", teamId: "team-b", userId: SENDER, contactOk: true, status: "resolved", resolvedAt: RESOLVED, release: "1.22.0", message: MESSAGE });
    // A sender that is not a Cognito sub (an address, say)
    report("report-0003", { userId: "someone@example.com" });
    // No resolvedAt, a bad one, a missing id
    report("report-0004", { resolvedAt: undefined });
    report("report-0005", { resolvedAt: "yesterday" });
    table.put({ PK: `FEEDBACK#${TEAM}`, SK: "REPORT#report-0006", GSI1PK: "FEEDBACK#STATUS#resolved", GSI1SK: "y", type: "feedback", teamId: TEAM, userId: SENDER, contactOk: true, status: "resolved", resolvedAt: RESOLVED, release: "1.22.0" });
    table.put({ PK: "FEEDBACK#bad team", SK: "REPORT#report-0007", GSI1PK: "FEEDBACK#STATUS#resolved", GSI1SK: "x", type: "feedback", reportId: "report-0007", teamId: "bad team", userId: SENDER, contactOk: true, status: "resolved", resolvedAt: RESOLVED, release: "1.22.0" });
    // A different item type in the same partition
    table.put({ PK: `FEEDBACK#${TEAM}`, SK: "REPORT#report-0008", GSI1PK: "FEEDBACK#STATUS#resolved", GSI1SK: "w", type: "other", reportId: "report-0008", teamId: TEAM, userId: SENDER, contactOk: true, status: "resolved", resolvedAt: RESOLVED, release: "1.22.0" });
    expect(await run()).toMatchObject({ candidates: 1 });
    // Only the first report, whose own keys agree, was told
    expect(mails.sent).toHaveLength(1);
  });

  it("nobody who has left the team, and marks the report so it is not looked up again", async () => {
    report("report-0001", {}, { member: false });
    expect(await run()).toEqual({ candidates: 1, sent: 0, skipped: 1, failed: 0 });
    expect(mark("report-0001")).toMatchObject({ notifiedResolvedOutcome: "skipped" });
    expect(lookups).toEqual([]);
    expect(await run()).toMatchObject({ candidates: 0 });
    expect(mails.sent).toEqual([]);
    expect(failures()).toEqual([]);
  });

  it("nobody in a team that is gone or being purged (marked), and nobody in a closed team until it reopens (not marked)", async () => {
    report("report-0001", {}, { team: false });
    report("report-0002", { teamId: "team-p" }, { team: { purging: "2026-10-27T00:00:00.000Z" } });
    report("report-0003", { teamId: "team-c" }, { team: { closedAt: "2026-10-26T00:00:00.000Z" } });
    expect(await run()).toMatchObject({ candidates: 3, sent: 0, skipped: 3 });
    expect(mark("report-0001")).toMatchObject({ notifiedResolvedOutcome: "skipped" });
    expect(mark("report-0002", "team-p")).toMatchObject({ notifiedResolvedOutcome: "skipped" });
    expect(mark("report-0003", "team-c")).not.toHaveProperty("notifiedResolvedAt");
    expect(lookups).toEqual([]);
    // Reopened: the next run tells them
    table.put({ PK: "TEAM#team-c", SK: "META", type: "team", teamId: "team-c", name: "Echo", status: "active" });
    expect(await run()).toMatchObject({ candidates: 1, sent: 1 });
    expect(mark("report-0003", "team-c")).toMatchObject({ notifiedResolvedOutcome: "sent" });
  });

  it("nobody whose account is gone (marked)", async () => {
    accounts.delete(SENDER);
    report("report-0001");
    expect(await run()).toMatchObject({ sent: 0, skipped: 1 });
    expect(mark("report-0001")).toMatchObject({ notifiedResolvedOutcome: "skipped" });
    expect(mails.sent).toEqual([]);
    expectNothingPersonal();
  });

  it("nobody without a verified address (not marked: they may verify one), then them when they do", async () => {
    for (const bad of [account({ emailVerified: false }), account({ email: undefined }), account({ email: "not an address" })]) {
      accounts.set(SENDER, bad);
      report("report-0001");
      expect(await run()).toMatchObject({ sent: 0, skipped: 1, failed: 0 });
      expect(mark("report-0001")).not.toHaveProperty("notifiedResolvedAt");
    }
    expect(mails.sent).toEqual([]);
    accounts.set(SENDER, account());
    expect(await run()).toMatchObject({ sent: 1 });
  });
});

describe("once only", () => {
  it("sends one email when two runs overlap", async () => {
    report("report-0001");
    const results = await Promise.all([run(), run(), run()]);
    expect(mails.sent).toHaveLength(1);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
    expect(counted(BusinessMetric.ReportFixedEmails)).toBe(1);
  });

  it("sends nothing when the report changed between listing and claiming", async () => {
    report("report-0001");
    // The owner reopens the report (or another run told it) after the list is read: the claim's condition fails
    const base = reportFixedPolicy(denied);
    const handler = createReportFixedHandler({
      db: table.guarded((command, input) => {
        if (command === "GetCommand" && String((input.Key as { PK: string }).PK).startsWith("USER#")) table.put({ ...mark("report-0001"), status: "triaged" });
        return base(command, input);
      }),
      obs: obs(),
      mailer: mails.mailer,
      findAccount,
      now: () => NOW,
    });
    expect(await handler()).toMatchObject({ sent: 0 });
    expect(mails.sent).toEqual([]);
  });
});

describe("failures", () => {
  it("gives the claim back when SES fails for now, counts it, fails the run, and sends at the next", async () => {
    report("report-0001");
    mails.state.fail = "Throttling";
    await expect(run()).rejects.toThrow("some sends failed");
    expect(failures()).toEqual(["send_failed"]);
    expect(mark("report-0001")).not.toHaveProperty("notifiedResolvedAt");
    expect(mark("report-0001")).not.toHaveProperty("notifiedResolvedOutcome");
    mails.state.fail = undefined;
    expect(await run()).toMatchObject({ sent: 1 });
    expect(mails.sent).toHaveLength(1);
    expectNothingPersonal();
  });

  it("keeps the mark when SES refuses the address, counts it once, and does not fail the run", async () => {
    report("report-0001");
    mails.state.fail = "InvalidRecipient";
    expect(await run()).toMatchObject({ sent: 0, failed: 1 });
    expect(failures()).toEqual(["refused"]);
    expect(mark("report-0001")).toMatchObject({ notifiedResolvedOutcome: "refused" });
    mails.state.fail = undefined;
    expect(await run()).toMatchObject({ candidates: 0 });
    expect(mails.sent).toEqual([]);
    expect(failures()).toEqual(["refused"]);
  });

  it("counts a failed pool lookup and tries again at the next run", async () => {
    report("report-0001");
    accounts.set(SENDER, new Error("ListUsers failed: 400 ThrottlingException"));
    await expect(run()).rejects.toThrow("some sends failed");
    expect(failures()).toEqual(["lookup_failed"]);
    expect(mark("report-0001")).not.toHaveProperty("notifiedResolvedAt");
    accounts.set(SENDER, account());
    expect(await run()).toMatchObject({ sent: 1 });
  });

  it("counts a report whose reads fail, carries on with the others, and fails the run", async () => {
    report("report-0001");
    report("report-0002", { teamId: "team-b" }, {});
    const base = reportFixedPolicy(denied);
    const handler = createReportFixedHandler({
      db: table.guarded((command, input) => !(command === "GetCommand" && (input.Key as { PK: string }).PK === `TEAM#${TEAM}`) && base(command, input)),
      obs: obs(),
      mailer: mails.mailer,
      findAccount,
      now: () => NOW,
    });
    await expect(handler()).rejects.toThrow("some sends failed");
    expect(failures()).toEqual(["error"]);
    expect(mails.sent).toHaveLength(1);
    expect(logs.some(([level, , data]) => level === "warn" && data.code === "AccessDeniedException")).toBe(true);
  });

  it("logs, and still fails the run, when the claim cannot be given back", async () => {
    report("report-0001");
    mails.state.fail = "Throttling";
    const base = reportFixedPolicy(denied);
    // The release (an UpdateItem that removes the mark) is refused
    const handler = createReportFixedHandler({
      db: table.guarded((command, input) => !(command === "UpdateCommand" && String(input.UpdateExpression).startsWith("REMOVE")) && base(command, input)),
      obs: obs(),
      mailer: mails.mailer,
      findAccount,
      now: () => NOW,
    });
    await expect(handler()).rejects.toThrow("some sends failed");
    expect(logs.some(([level, message]) => level === "error" && message === "Report email mark not updated")).toBe(true);
  });
});

describe("the report fixed email's data calls", () => {
  const ref = { stage: "resolved" as const, teamId: TEAM, reportId: "report-0001" };
  const at = new Date(NOW);
  const open = () => table.guarded(() => true);

  it("pages through the status partition until it has enough, and reads an empty answer as none", async () => {
    for (let i = 0; i < 5; i++) report(`report-000${i}`, { GSI1SK: `2026-10-20T00:00:00.000Z#${i}` });
    table.pageItems = 2;
    expect((await listFixedReports(open(), at, 50)).reports).toHaveLength(5);
    expect((await listFixedReports(open(), at, 3)).reports).toHaveLength(3);
    expect((await listFixedReports(fakeDb(async () => ({})), at, 50)).reports).toEqual([]);
  });

  it("reads a report with no text as an empty quote", async () => {
    report("report-0001", { message: undefined });
    expect((await listFixedReports(open(), at, 50)).reports[0]?.message).toBe("");
    await run();
    expect(mails.sent[0]?.input).toMatchObject({ message: "" });
  });

  it("answers false, not an error, for a mark that is not ours, and throws what DynamoDB throws otherwise", async () => {
    report("report-0001");
    expect(await releaseFixedNotice(open(), ref, at)).toBe(false);
    expect(await recordFixedRefused(open(), ref, at)).toBe(false);
    expect(await claimFixedNotice(open(), ref, "sent", at)).toBe(true);
    expect(await claimFixedNotice(open(), ref, "sent", at)).toBe(false);
    const refused = table.guarded(() => false);
    await expect(claimFixedNotice(refused, ref, "sent", at)).rejects.toThrow("not authorized");
    await expect(releaseFixedNotice(refused, ref, at)).rejects.toThrow("not authorized");
    await expect(recordFixedRefused(refused, ref, at)).rejects.toThrow("not authorized");
  });
});
