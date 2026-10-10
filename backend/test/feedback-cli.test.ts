// npm run feedback (scripts/feedback.ts, supply-checkout-bmsh.3): argument and
// text checks without a table, and the commands against DynamoDB Local
// (skipped unless DYNAMODB_ENDPOINT is set; `npm run test:ddb` sets it). The
// bead is made by a fake, never by `bd`.

import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/data/index.js";
import { connection } from "../src/data/client.js";
import { createLocalTable, deleteLocalTable } from "../src/data/local-table.js";
import { getFeedback } from "../src/data/feedback-owner.js";
import type { PoolUser } from "../src/identity/cognito-admin.js";
import { type BeadRequest, type Deps, listLine, main, quotesReport, showReport, unsafeText, USAGE, VERBATIM_RUN } from "../scripts/feedback.js";
import { endpoint, rawItem, REGION } from "./helpers.js";

const FULL = "0123456789abcdef0123456789abcdef";
const TABLE = "supply-checkout-clitest-app";

/** Runs the CLI and collects what it prints. */
async function run(argv: string[], deps: Deps = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, (l) => out.push(l), (l) => err.push(l), deps);
  return { code, out, err, text: [...out, ...err].join("\n") };
}

const WHERE = ["--table", TABLE, "--region", REGION, "--endpoint", "http://localhost:1"];

describe("the text a bead may carry", () => {
  it.each([
    ["an email address", "Customer jane.doe@gmail.com can't scan"], // public-safety: allow
    ["an email address", "support@supplycheckout.com is mentioned"],
    ["a 12-digit number (an AWS account ID?)", "Failed in 123456789012"],
    ["an SSO URL", "see https://d-1234567890.awsapps.com/start"], // public-safety: allow
    ["something check-public-safety refuses (AWS access key)", "key AKIAABCDEFGHIJKLMNOP leaked"], // public-safety: allow
  ])("refuses %s", (why, text) => {
    expect(unsafeText(text)).toBe(why);
  });

  it("passes a plain summary", () => {
    expect(unsafeText("Scanner freezes on the receipt screen after the second photo")).toBeUndefined();
  });

  it("finds the report's own words: equal, a whole message, or a long run", () => {
    const report = { message: "The barcode scanner stops responding when I scan a second item and I have to reload the whole page to get it back again. Please fix it soon because we lose time.", expected: "It should keep scanning" };
    expect(quotesReport("  THE barcode scanner stops responding\nwhen I scan a second item and I have to reload the whole page to get it back again. please fix it soon because we lose time.", report)).toBe(true);
    expect(quotesReport(`Summary: ${report.message.slice(20, 20 + VERBATIM_RUN)}`, report)).toBe(true);
    expect(quotesReport("Scanner hangs after the second scan", report)).toBe(false);
    expect(quotesReport("it should keep scanning", report)).toBe(true);
    expect(quotesReport("Title: It should keep scanning, says user", { message: "x", expected: "It should keep scanning" })).toBe(false); // 23 characters, under the whole-message floor
    expect(quotesReport("", report)).toBe(false);
    expect(quotesReport("anything", { message: "Hi", expected: "" })).toBe(false);
  });
});

describe("what it prints", () => {
  const report = {
    type: "feedback", reportId: FULL, shortId: "01234567", teamId: "team-a", userId: "u1", role: "viewer", createdAt: "2026-10-09T12:00:00.000Z", category: "bug",
    message: `  The scanner\n\u001b[31mfroze\u001b[0m again and again, over and over, on the receipt screen of the app today`, expected: "A scan\nof the item", contactOk: false,
    context: { build: "1.11.1", screen: "scan", browser: "chrome" }, status: "new", beadId: "", expiresAt: 1,
  } as const;

  it("lists a report on one line, 60 characters of its text, with no control characters", () => {
    const line = listLine(report as never);
    expect(line.startsWith("01234567  2026-10-09  bug  team-a  viewer  1.11.1  The scanner ")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
    expect(Array.from(line).some((c) => (c.codePointAt(0) as number) < 0x20)).toBe(false);
    expect(line.split("  ").at(-1)).toHaveLength(61);
    expect(listLine({ ...report, context: {}, message: "Short" } as never)).toBe("01234567  2026-10-09  bug  team-a  viewer  -  Short");
  });

  it("shows the whole report; the email line only with contact OK", () => {
    const shown = showReport({ ...report, contactOk: true } as never, { line: "Email (verified): a@example.com" });
    expect(shown).toContain("Email (verified): a@example.com");
    expect(shown.join("\n")).not.toContain("\u001b");
    expect(shown).toContain("What was expected:");
    expect(showReport(report as never, { line: "Email (verified): a@example.com" }).join("\n")).not.toContain("Email");
    const done = showReport({ ...report, status: "triaged", beadId: "supply-checkout-x.1", expected: "", dismissReason: "dup\nlicate" } as never);
    expect(done).toContain("Status: triaged (bead supply-checkout-x.1) (reason: dup licate)");
    expect(done).not.toContain("What was expected:");
    expect(showReport({ ...report, context: {} } as never)).toContain("App build: -  Screen: -  Browser: -");
  });
});

describe("arguments", () => {
  const cases: [string, string[], string][] = [
    ["no command", [], "No command given"],
    ["an unknown command", ["frobnicate"], "Unknown command: frobnicate"],
    ["a bad option", ["list", "--nope"], "Unknown option"],
    ["list with an argument", ["list", "x", ...WHERE], "list takes no arguments"],
    ["a bad status", ["list", "--status", "old", ...WHERE], "--status must be"],
    ["a bad limit", ["list", "--limit", "101", ...WHERE], "--limit must be"],
    ["no report", ["show", ...WHERE], "show takes"],
    ["a bad report ID", ["show", "team-a", "xyz", ...WHERE], "must be the 32-character ID"],
    ["a bad team ID", ["show", "team a", FULL, ...WHERE], "isn't a team ID"],
    ["two teams", ["show", "team-a", FULL, "--team", "team-b", ...WHERE], "another team"],
    ["an option of another command", ["show", FULL, "--title", "x", ...WHERE], "--title isn't an option of show"],
    ["no title", ["bead", FULL, ...WHERE], "--title is required"],
    ["a long title", ["bead", FULL, "--title", "x".repeat(201), ...WHERE], "at most 200"],
    ["a long summary", ["bead", FULL, "--title", "t", "--summary", "x".repeat(1001), ...WHERE], "at most 1000"],
    ["a bad type", ["bead", FULL, "--title", "t", "--type", "epic", ...WHERE], "--type must be"],
    ["a bad priority", ["bead", FULL, "--title", "t", "--priority", "5", ...WHERE], "--priority must be"],
    ["an email in the title", ["bead", FULL, "--title", "Fix for pat@example.com", ...WHERE], "Refused: --title has an email address"],
    ["an account ID in the summary", ["bead", FULL, "--title", "t", "--summary", "account 123456789012", ...WHERE], "Refused: --summary has a 12-digit"], // public-safety: allow
    ["record without a bead", ["record", FULL, ...WHERE], "--bead must be"],
    ["dismiss without a reason", ["dismiss", FULL, ...WHERE], "--reason is required"],
    ["a long reason", ["dismiss", FULL, "--reason", "x".repeat(201), ...WHERE], "at most 200"],
    ["an email in the reason", ["dismiss", FULL, "--reason", "from pat@example.com", ...WHERE], "Refused: --reason has an email address"],
    ["no table", ["list", "--region", REGION, "--endpoint", "http://localhost:1"], "--table and --region are required"],
    ["no profile or endpoint", ["list", "--table", TABLE, "--region", REGION], "--profile is required"],
    ["a table that isn't an app table", ["list", "--table", "other-table", "--region", REGION, "--profile", "p"], "--table must be an app table"],
    ["an account ID that isn't one", ["list", ...WHERE, "--expect-account", "abc"], "--expect-account takes"],
  ];
  it.each(cases)("refuses %s with exit 2, before reading or creating anything", async (_name, argv, message) => {
    let touched = false;
    const { code, text } = await run(argv, { connect: () => ((touched = true), undefined as never), createBead: () => ((touched = true), "x") });
    expect(code).toBe(2);
    expect(text).toContain(message);
    expect(touched).toBe(false);
  });

  it("prints the usage for --help", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toEqual([USAGE]);
  });

  it("stops before reading unless the profile is in the expected account, and when the account can't be found", async () => {
    let connected = false;
    const deps: Deps = { callerAccount: async () => "111111111111", connect: () => ((connected = true), undefined as never) };
    const wrong = await run(["list", "--table", TABLE, "--region", REGION, "--profile", "p", "--expect-account", "222222222222"], deps);
    expect(wrong.code).toBe(1);
    expect(wrong.err.join()).toContain("not 222222222222");
    const failing = await run(["list", "--table", TABLE, "--region", REGION, "--profile", "p"], { ...deps, callerAccount: async () => Promise.reject(new Error("no credentials")) });
    expect(failing.code).toBe(1);
    expect(failing.err.join()).toContain("Failed to identify the profile's account");
    expect(connected).toBe(false);
  });
});

describe.skipIf(!endpoint)("the commands on DynamoDB Local", () => {
  let db: Db;
  beforeAll(async () => {
    db = createDb({ endpoint, region: REGION, tableName: TABLE, env: {} });
    await createLocalTable(db);
  });
  afterAll(async () => {
    if (db) await deleteLocalTable(db);
  });

  const at = (m: number) => new Date(Date.UTC(2026, 9, 9, 10, m)).toISOString();
  const rid = () => randomUUID().replaceAll("-", "");

  /** A report as sendFeedback stores it. */
  async function put(fields: Partial<Record<string, unknown>> = {}) {
    const reportId = (fields.reportId as string | undefined) ?? rid();
    const teamId = (fields.teamId as string | undefined) ?? `team-${rid().slice(0, 8)}`;
    const createdAt = (fields.createdAt as string | undefined) ?? at(0);
    const status = (fields.status as string | undefined) ?? "new";
    const item = {
      PK: `FEEDBACK#${teamId}`, SK: `REPORT#${reportId}`, GSI1PK: `FEEDBACK#STATUS#${status}`, GSI1SK: `${createdAt}#${reportId}`,
      type: "feedback", reportId, shortId: reportId.slice(0, 8), teamId, userId: "11111111-2222-4333-8444-555555555555", role: "owner", createdAt, category: "bug",
      message: "The scanner froze on the receipt screen", expected: "A scan", contactOk: false, context: { build: "1.11.1", screen: "scan", browser: "chrome" },
      status, beadId: "", expiresAt: 4_000_000_000, ...fields,
    };
    await connection(db).doc.send(new PutCommand({ TableName: TABLE, Item: item }));
    return item as typeof item & { reportId: string; teamId: string; shortId: string };
  }

  const beads: BeadRequest[] = [];
  const deps = (extra: Deps = {}): Deps => ({
    connect: () => db,
    createBead: (request) => {
      beads.push(request);
      return `supply-checkout-t${beads.length}`;
    },
    now: () => new Date("2026-10-10T00:00:00.000Z"),
    ...extra,
  });
  const cli = (argv: string[], extra: Deps = {}) => run([...argv, ...WHERE], deps(extra));

  it("lists one line per new report, oldest first, and pages with --limit and --cursor", async () => {
    const team = `team-list-${rid().slice(0, 6)}`;
    const second = await put({ teamId: team, createdAt: at(2), message: "Second\nreport with a long text that goes on and on and on and on and on and on and on", category: "idea" });
    const first = await put({ teamId: team, createdAt: at(1), message: "First", role: "viewer", context: {} });
    const third = await put({ teamId: team, createdAt: at(3), message: "Third", category: "question" });
    const gone = await put({ teamId: team, createdAt: at(0), status: "dismissed", message: "Gone" });
    const mine = (lines: string[]) => lines.filter((l) => l.includes(team));
    const all = await cli(["list", "--limit", "100"]);
    expect(all.code).toBe(0);
    expect(all.out[0]).toContain(`feedback list on ${TABLE}`);
    expect(mine(all.out)).toEqual([
      `${first.shortId}  2026-10-09  bug  ${team}  viewer  -  First`,
      `${second.shortId}  2026-10-09  idea  ${team}  owner  1.11.1  Second report with a long text that goes on and on and on an…`,
      `${third.shortId}  2026-10-09  question  ${team}  owner  1.11.1  Third`,
    ]);
    const dismissed = await cli(["list", "--status", "dismissed", "--limit", "100"]);
    expect(mine(dismissed.out)).toEqual([`${gone.shortId}  2026-10-09  bug  ${team}  owner  1.11.1  Gone`]);
    // Paging
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await cli(["list", "--limit", "2", ...(cursor ? ["--cursor", cursor] : [])]);
      seen.push(...mine(page.out));
      cursor = page.out.find((l) => l.startsWith("More: --cursor "))?.slice("More: --cursor ".length);
    } while (cursor);
    expect(seen).toEqual(mine(all.out));
    expect((await cli(["list", "--cursor", "garbage"])).code).toBe(1);
  });

  it("shows a report by team and full ID, or by a short ID with --team or alone when it's the only one", async () => {
    const r = await put({ message: "Line one\nLine two", expected: "Something" });
    const full = await cli(["show", r.teamId, r.reportId]);
    expect(full.code).toBe(0);
    expect(full.out).toContain("Line one\nLine two");
    expect(full.out).toContain("Contact OK: no");
    expect(full.text).not.toContain("Email");
    for (const argv of [["show", r.teamId, r.shortId], ["show", r.shortId, "--team", r.teamId], ["show", r.shortId], ["show", r.reportId]]) {
      expect((await cli(argv)).out).toContain("Line one\nLine two");
    }
    const other = await cli(["show", "team-nobody", r.reportId]);
    expect(other.code).toBe(1);
    expect(other.err).toEqual(["No such report"]);
    expect((await cli(["show", "deadbeef"])).err).toEqual(["No such report"]);
  });

  it("refuses an ambiguous short ID and lists the candidates, never their text", async () => {
    const prefix = "abcd1234";
    const a = await put({ reportId: `${prefix}${"a".repeat(24)}`, teamId: "team-amb-1", message: "SECRET ONE" });
    const b = await put({ reportId: `${prefix}${"b".repeat(24)}`, teamId: "team-amb-2", message: "SECRET TWO", status: "dismissed" });
    const c = await put({ reportId: `${prefix}${"c".repeat(24)}`, teamId: "team-amb-1", message: "SECRET THREE" });
    const none = await cli(["show", prefix]);
    expect(none.code).toBe(1);
    expect(none.err[0]).toBe(`3 reports have the short ID ${prefix}: give the team ID and the full report ID of one`);
    expect(none.err).toHaveLength(4);
    for (const r of [a, b, c]) expect(none.err.join("\n")).toContain(r.reportId);
    expect(none.text).not.toContain("SECRET");
    // Within one team it's still two, and the mutations refuse the same way, creating nothing
    const before = beads.length;
    const mut = await cli(["bead", "team-amb-1", prefix, "--title", "Scanner issue"]);
    expect(mut.code).toBe(1);
    expect(mut.err[0]).toContain("2 reports have the short ID");
    expect(beads.length).toBe(before);
    expect((await cli(["dismiss", prefix, "--reason", "Duplicate"])).code).toBe(1);
    expect((await getFeedback(db, "team-amb-1", a.reportId))?.status).toBe("new");
    // The full ID with its team is exact
    expect((await cli(["show", "team-amb-2", b.reportId])).code).toBe(0);
    // The team's other report is told apart by its full ID
    expect((await cli(["show", "team-amb-1", c.reportId])).out).toContain("SECRET THREE");
  });

  it("looks up the user's verified email only with contact OK", async () => {
    const userId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const mk = (extra: Record<string, unknown> = {}) => put({ contactOk: true, userId, message: "Call me", ...extra });
    const pool = { id: "test-local-1_ABC123", name: "supply-checkout-clitest", opsId: "test-local-1_OPS999" };
    const lookups: string[] = [];
    const lookup = (user: PoolUser | undefined, found = pool): Deps => ({
      appPool: async () => found,
      findUser: async (_r, poolId, sub) => {
        lookups.push(`${poolId} ${sub}`);
        return user;
      },
    });
    const verified: PoolUser = { username: userId, status: "CONFIRMED", enabled: true, attributes: { sub: userId, email: "Pat@Example.com", email_verified: "true" } };
    // The table's env: TABLE is supply-checkout-clitest-app
    const r = await mk();
    const ok = await run(["show", r.teamId, r.reportId, ...WHERE], deps(lookup(verified)));
    expect(ok.out).toContain("Email (verified): pat@example.com");
    expect(lookups).toEqual([`test-local-1_ABC123 ${userId}`]);
    // Not asked when contact isn't OK
    const quiet = await put({ contactOk: false, userId });
    lookups.length = 0;
    expect((await run(["show", quiet.teamId, quiet.reportId, ...WHERE], deps(lookup(verified)))).text).not.toContain("example.com");
    expect(lookups).toEqual([]);
    const text = async (d: Deps) => (await run(["show", r.teamId, r.reportId, ...WHERE], deps(d))).out.find((l) => l.startsWith("Email")) ?? "";
    expect(await text(lookup(undefined))).toContain("no such user");
    expect(await text(lookup({ ...verified, attributes: { ...verified.attributes, email_verified: "false" } }))).toContain("no verified address");
    expect(await text(lookup(verified, { ...pool, name: "supply-checkout-clitest-ops" }))).toContain("operator pool");
    expect(await text(lookup(verified, { ...pool, id: "us-west-2_ABC123" }))).toContain("must name the pool supply-checkout-clitest in test-local-1");
    const failing: Deps = { appPool: async () => pool, findUser: async () => Promise.reject(new Error("ListUsers failed: 400 AccessDeniedException")) };
    expect(await text(failing)).toContain("lookup failed (ListUsers failed: 400 AccessDeniedException)");
    expect(await text(failing)).toContain(`User ID: ${userId}`);
    // Against --endpoint with no stand-ins it isn't looked up at all
    expect((await run(["show", r.teamId, r.reportId, ...WHERE], deps())).out.find((l) => l.startsWith("Email"))).toContain("not looked up with --endpoint");
    // And the table must be an app table's for a lookup
    const odd = await run(["show", r.teamId, r.reportId, "--table", "plain-table", "--region", REGION, "--endpoint", "http://localhost:1"], deps(lookup(verified)));
    expect(odd.code).toBe(0);
    expect(odd.out.find((l) => l.startsWith("Email"))).toContain("isn't an app table");
  });

  it("creates the bead from the owner's words, labels it, and marks the report triaged", async () => {
    const r = await put({ category: "idea", message: "Please add dark mode to the whole app, my eyes hurt at night when I check stock in the garage." });
    const before = beads.length;
    const done = await cli(["bead", r.teamId, r.reportId, "--title", "Dark mode request", "--summary", "A user asks for a dark theme.\nSeen in 1.11.1.", "--priority", "3"]);
    expect(done.code).toBe(0);
    expect(beads).toHaveLength(before + 1);
    expect(beads.at(-1)).toEqual({
      title: "Dark mode request",
      type: "feature",
      priority: 3,
      labels: ["feature", "client"],
      notes: `Report ${r.shortId}`,
      description: "A user asks for a dark theme.\nSeen in 1.11.1.",
    });
    expect(done.out.at(-1)).toBe(`Created bead supply-checkout-t${beads.length} for report ${r.shortId}; the report is triaged.`);
    expect(await getFeedback(db, r.teamId, r.reportId)).toMatchObject({ status: "triaged", beadId: `supply-checkout-t${beads.length}`, statusAt: "2026-10-10T00:00:00.000Z" });
    const item = await rawItem(db, `FEEDBACK#${r.teamId}`, `REPORT#${r.reportId}`);
    expect(item?.GSI1PK).toBe("FEEDBACK#STATUS#triaged");
    // The bead's text never held the report's text
    expect(JSON.stringify(beads.at(-1))).not.toContain("garage");
    // Idempotent: a second run makes nothing and names the bead
    const again = await cli(["bead", r.teamId, r.reportId, "--title", "Dark mode request again"]);
    expect(again.code).toBe(0);
    expect(again.out.at(-1)).toBe(`Report ${r.shortId} is already triaged: bead supply-checkout-t${beads.length}. Nothing was done.`);
    expect(beads).toHaveLength(before + 1);
  });

  it("types and labels a bead by the category, and --type overrides the type only", async () => {
    const q = await put({ category: "question" });
    const bug = await put({ category: "bug" });
    await cli(["bead", q.teamId, q.reportId, "--title", "How do receipts work?"]);
    expect(beads.at(-1)).toMatchObject({ type: "task", labels: ["task", "client"], priority: 2, description: "" });
    await cli(["bead", bug.teamId, bug.reportId, "--title", "Scanner freezes", "--type", "task"]);
    expect(beads.at(-1)).toMatchObject({ type: "task", labels: ["bug", "client"] });
  });

  it("refuses a title or summary that quotes the report, or a dismissed report, before creating anything", async () => {
    const message = "The receipt scanner shows a spinner forever whenever I photograph a long receipt from the hardware store, and then the page needs a reload to work again.";
    const r = await put({ message });
    const before = beads.length;
    const whole = await cli(["bead", r.teamId, r.reportId, "--title", message.slice(0, 120)]);
    expect(whole.code).toBe(1);
    expect(whole.err.join()).toContain("--title holds the report's own words");
    expect(whole.text).not.toContain("spinner");
    const sum = await cli(["bead", r.teamId, r.reportId, "--title", "Receipt spinner", "--summary", `User says: ${message}`]);
    expect(sum.code).toBe(1);
    expect(sum.err.join()).toContain("--summary holds the report's own words");
    const gone = await put({ status: "dismissed" });
    const dismissed = await cli(["bead", gone.teamId, gone.reportId, "--title", "Anything"]);
    expect(dismissed.code).toBe(1);
    expect(dismissed.err.join()).toContain("is dismissed, not new");
    expect(beads).toHaveLength(before);
    expect((await getFeedback(db, r.teamId, r.reportId))?.status).toBe("new");
  });

  it("says which bead was made, and the command to record it, when bd or the record fails", async () => {
    const r = await put();
    const noBd = await cli(["bead", r.teamId, r.reportId, "--title", "Scanner freezes"], { createBead: () => { throw new Error("bd create failed (exit 1): no database"); } });
    expect(noBd.code).toBe(1);
    expect(noBd.err).toEqual(["No bead was created: bd create failed (exit 1): no database"]);
    expect((await getFeedback(db, r.teamId, r.reportId))?.status).toBe("new");
    // The record fails after the bead was made
    const created = beads.length;
    const result = await cli(["bead", r.teamId, r.reportId, "--title", "Scanner freezes"], { now: () => { throw new Error("clock"); } });
    expect(result.code).toBe(1);
    const id = `supply-checkout-t${created + 1}`;
    expect(result.err[0]).toBe(`Bead ${id} was created, but the report wasn't marked triaged (Error). Record it with:`);
    expect(result.err[1]).toBe(`  npm run feedback -- record ${r.teamId} ${r.reportId} --bead ${id} --table ${TABLE} --region ${REGION} --endpoint http://localhost:1`);
    // That command, run, finishes the job
    const retry = await cli(["record", r.teamId, r.reportId, "--bead", id]);
    expect(retry.code).toBe(0);
    expect((await getFeedback(db, r.teamId, r.reportId))?.beadId).toBe(id);
  });

  it("records a bead made by hand, once, and dismisses with a reason, once", async () => {
    const r = await put();
    const rec = await cli(["record", r.teamId, r.reportId, "--bead", "supply-checkout-by-hand.1"]);
    expect(rec.out.at(-1)).toBe(`Report ${r.shortId} is triaged with bead supply-checkout-by-hand.1.`);
    // The same bead again is fine; another bead, or dismissing, is refused and changes nothing
    expect((await cli(["record", r.teamId, r.reportId, "--bead", "supply-checkout-by-hand.1"])).code).toBe(0);
    const other = await cli(["record", r.teamId, r.reportId, "--bead", "supply-checkout-other"]);
    expect(other.code).toBe(1);
    expect(other.err[0]).toBe("Failed: ConflictError: This report is already triaged (bead supply-checkout-by-hand.1)");
    const dismiss = await cli(["dismiss", r.teamId, r.reportId, "--reason", "Duplicate"]);
    expect(dismiss.code).toBe(1);
    expect(await getFeedback(db, r.teamId, r.reportId)).toMatchObject({ status: "triaged", beadId: "supply-checkout-by-hand.1" });

    const d = await put({ message: "Nothing works at all in the whole app and I am very upset about it, honestly, please look into it right now, thank you very much" });
    const ok = await cli(["dismiss", d.teamId, d.reportId, "--reason", "Not a defect: user error"]);
    expect(ok.out.at(-1)).toBe(`Report ${d.shortId} is dismissed.`);
    expect(await getFeedback(db, d.teamId, d.reportId)).toMatchObject({ status: "dismissed", beadId: "", dismissReason: "Not a defect: user error" });
    expect((await cli(["dismiss", d.teamId, d.reportId, "--reason", "Again"])).code).toBe(0);
    const quoting = await put({ message: "Nothing works at all in the whole app and I am very upset about it, honestly, please look into it right now, thank you very much" });
    const q = await cli(["dismiss", quoting.teamId, quoting.reportId, "--reason", "Nothing works at all in the whole app and I am very upset about it, honestly, please look into it right now, thank you very much"]);
    expect(q.code).toBe(1);
    expect(q.err).toEqual(["Refused: --reason holds the report's own words. Nothing was changed."]);
    expect((await getFeedback(db, quoting.teamId, quoting.reportId))?.status).toBe("new");
  });

  it("never prints report text in a failure", async () => {
    const r = await put({ message: "PRIVATE-MARKER the scanner broke" });
    const failedRead = await cli(["list", "--cursor", "garbage"]);
    const failedWrite = await cli(["dismiss", r.teamId, r.reportId, "--reason", "x"], { now: () => { throw new Error("clock"); } });
    expect(failedRead.code).toBe(1);
    expect(failedRead.err).toEqual(["Failed: InvalidInputError: Invalid cursor"]);
    expect(failedWrite.err).toEqual(["Failed: Error: clock"]);
    for (const result of [failedRead, failedWrite]) expect(result.text).not.toContain("PRIVATE-MARKER");
    expect((await getFeedback(db, r.teamId, r.reportId))?.status).toBe("new");
  });
});
