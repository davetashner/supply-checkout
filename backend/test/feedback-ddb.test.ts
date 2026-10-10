// Reports (supply-checkout-bmsh.1, data/feedback.ts) against DynamoDB Local:
// the transaction, its conditions, the status index and the team purge,
// with the real expressions. Skipped unless DYNAMODB_ENDPOINT is set (CI sets
// it; `npm run test:ddb` runs it locally). test/feedback-api.test.ts has the
// route and its validation.

import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  acceptInvite,
  CLOSED_TEAM_RETENTION_DAYS,
  closeTeam,
  createInvite,
  createTeam,
  FEEDBACK_PER_USER_PER_DAY,
  FeedbackLimitError,
  feedbackInput,
  feedbackIdFor,
  NotFoundError,
  purgeTeam,
  sendFeedback,
  TeamDeletingError,
  InvalidInputError,
  ForbiddenError,
  startAccountDeletion,
  teamContextForEmailEvent,
} from "../src/data/index.js";
import { connection } from "../src/data/client.js";
import { ConflictError } from "../src/data/errors.js";
import { dismissFeedback, getFeedback, listFeedback, recordFeedbackBead } from "../src/data/feedback-owner.js";
import { endpoint, newUser, rawItem, useTable } from "./helpers.js";

const DAY = 86_400_000;
const input = (message = "The scanner froze", extra: Record<string, unknown> = {}) => feedbackInput({ category: "bug", message, ...extra });

describe.skipIf(!endpoint)("reports on DynamoDB Local", () => {
  const table = useTable();

  async function partition(pk: string) {
    const { Items } = await connection(table.db).doc.send(
      new QueryCommand({ TableName: table.db.tableName, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true }),
    );
    return Items ?? [];
  }

  /** A team (paying, so today's contexts aren't read-only) with an owner and a viewer. */
  async function team(now: Date) {
    const db = table.db;
    const ownerId = newUser();
    const { team: created, context: owner } = await createTeam(db, { userId: ownerId, email: `owner.${ownerId}@example.com` }, { name: "Echo Cleaning" }, now);
    await connection(db).doc.send(
      new UpdateCommand({ TableName: db.tableName, Key: { PK: `TEAM#${created.teamId}`, SK: "META" }, UpdateExpression: "SET #status = :active", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":active": "active" } }),
    );
    const email = `viewer.${ownerId}@example.com`;
    const made = await createInvite(db, owner, { email, role: "viewer" }, now);
    const viewerId = newUser();
    const viewer = await acceptInvite(db, { userId: viewerId, verifiedEmail: email }, made.invite, made.token, now);
    return { teamId: created.teamId, owner, ownerId, viewer, viewerId };
  }

  it("stores a report from a viewer, once per Idempotency-Key, with the day's count", async () => {
    const now = new Date("2026-10-09T12:00:00.000Z");
    const { teamId, viewer, viewerId } = await team(now);
    const sent = await sendFeedback(table.db, viewer, input("Nothing happens", { expected: "A scan", contactOk: true, context: { build: "1.11.1", screen: "scan", browser: "chrome" } }), "ddb-report-0001", now);
    expect(sent).toEqual({ reportId: feedbackIdFor(teamId, viewerId, "ddb-report-0001"), shortId: sent.reportId.slice(0, 8), created: true });
    expect(await rawItem(table.db, `FEEDBACK#${teamId}`, `REPORT#${sent.reportId}`)).toEqual({
      PK: `FEEDBACK#${teamId}`,
      SK: `REPORT#${sent.reportId}`,
      GSI1PK: "FEEDBACK#STATUS#new",
      GSI1SK: `${now.toISOString()}#${sent.reportId}`,
      type: "feedback",
      reportId: sent.reportId,
      shortId: sent.shortId,
      teamId,
      userId: viewerId,
      role: "viewer",
      createdAt: now.toISOString(),
      category: "bug",
      message: "Nothing happens",
      expected: "A scan",
      contactOk: true,
      context: { build: "1.11.1", screen: "scan", browser: "chrome" },
      status: "new",
      beadId: "",
      expiresAt: Math.floor(now.getTime() / 1000) + 730 * 86_400,
    });
    const again = await sendFeedback(table.db, viewer, input("Another text"), "ddb-report-0001", new Date(now.getTime() + 1000));
    expect(again).toEqual({ ...sent, created: false });
    expect((await partition(`FEEDBACK#${teamId}`)).map((i) => i.message)).toEqual(["Nothing happens"]);
    expect(await rawItem(table.db, `USER#${viewerId}`, "LIMIT#FEEDBACK#2026-10-09")).toMatchObject({ count: 1, type: "feedbackSent", expiresAt: Math.floor(now.getTime() / 1000) + 2 * 86_400 });
    // Nothing of it in the team's own partition
    expect((await partition(`TEAM#${teamId}`)).filter((i) => String(i.SK).includes("REPORT")).length).toBe(0);
  });

  it("allows 5 a user a day and no more, and a retry at the limit still answers", async () => {
    const now = new Date("2026-10-09T23:59:00.000Z");
    const { viewer, owner } = await team(now);
    for (let i = 0; i < FEEDBACK_PER_USER_PER_DAY; i++) expect((await sendFeedback(table.db, viewer, input(`Report ${i}`), `ddb-limit-${i}-0000`, now)).created).toBe(true);
    await expect(sendFeedback(table.db, viewer, input("One too many"), "ddb-limit-9-0000", now)).rejects.toBeInstanceOf(FeedbackLimitError);
    expect((await sendFeedback(table.db, viewer, input("Retry"), "ddb-limit-0-0000", now)).created).toBe(false);
    // Another user, and the next UTC day
    expect((await sendFeedback(table.db, owner, input("Mine"), "ddb-limit-own-00", now)).created).toBe(true);
    expect((await sendFeedback(table.db, viewer, input("Tomorrow"), "ddb-limit-9-0000", new Date(now.getTime() + 2 * 60_000))).created).toBe(true);
  });

  it("refuses a system context, a team being purged and an account being deleted, and writes nothing", async () => {
    const now = new Date("2026-10-09T12:00:00.000Z");
    const { teamId, viewer, viewerId, owner } = await team(now);
    await expect(sendFeedback(table.db, viewer, input(), "bad key", now)).rejects.toBeInstanceOf(InvalidInputError);
    const system = await teamContextForEmailEvent(table.db, teamId);
    expect(system).toBeDefined();
    await expect(sendFeedback(table.db, system as NonNullable<typeof system>, input(), "ddb-system-0001", now)).rejects.toBeInstanceOf(ForbiddenError);
    await startAccountDeletion(table.db, viewerId, now);
    await expect(sendFeedback(table.db, viewer, input(), "ddb-deleting-001", now)).rejects.toThrow("Your account is being deleted");
    // Closed teams take reports, until the purge marks them
    const closed = await closeTeam(table.db, owner, { confirmName: "Echo Cleaning" }, now);
    expect(closed.closedNow).toBe(true);
    expect((await sendFeedback(table.db, owner, input("Why was it closed?"), "ddb-closed-00001", now)).created).toBe(true);
    const after = new Date(now.getTime() + CLOSED_TEAM_RETENTION_DAYS * DAY + 1000);
    // Marked `purging` but not deleted: the purge's mark, the first thing it does
    await connection(table.db).doc.send(
      new UpdateCommand({ TableName: table.db.tableName, Key: { PK: `TEAM#${teamId}`, SK: "META" }, UpdateExpression: "SET purging = :now", ExpressionAttributeValues: { ":now": after.toISOString() } }),
    );
    await expect(sendFeedback(table.db, owner, input("Too late"), "ddb-purging-0001", after)).rejects.toBeInstanceOf(TeamDeletingError);
    expect((await partition(`FEEDBACK#${teamId}`)).map((i) => i.message)).toEqual(["Why was it closed?"]);
  });

  it("is deleted with the team by the purge, and only that team's", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    const mine = await team(now);
    const other = await team(now);
    await sendFeedback(table.db, mine.viewer, input("Mine one"), "ddb-purge-00001", now);
    await sendFeedback(table.db, mine.owner, input("Mine two"), "ddb-purge-00002", now);
    await sendFeedback(table.db, other.viewer, input("Theirs"), "ddb-purge-00003", now);
    await closeTeam(table.db, mine.owner, { confirmName: "Echo Cleaning" }, now);
    expect(await partition(`FEEDBACK#${mine.teamId}`)).toHaveLength(2);
    const after = new Date(now.getTime() + CLOSED_TEAM_RETENTION_DAYS * DAY + 1000);
    const result = await purgeTeam(table.db, mine.teamId, after);
    expect(result.skipped).toBe(false);
    expect(await partition(`FEEDBACK#${mine.teamId}`)).toEqual([]);
    expect(await partition(`TEAM#${mine.teamId}`)).toEqual([]);
    expect(await partition(`FEEDBACK#${other.teamId}`)).toHaveLength(1);
    // The status index follows: only the other team's report is left in it
    const listed = await listFeedback(table.db, { status: "new", limit: 100 });
    expect(listed.items.filter((r) => r.teamId === mine.teamId)).toEqual([]);
    expect(listed.items.filter((r) => r.teamId === other.teamId).map((r) => r.message)).toEqual(["Theirs"]);
  });

  it("lists new reports across teams, oldest first, and moves one out of `new` when it's triaged or dismissed", async () => {
    const t0 = new Date("2026-10-09T10:00:00.000Z");
    const a = await team(t0);
    const b = await team(t0);
    const at = (m: number) => new Date(t0.getTime() + m * 60_000);
    const second = await sendFeedback(table.db, b.viewer, input("Second", { category: "idea" }), "ddb-list-0000002", at(2));
    const first = await sendFeedback(table.db, a.owner, input("First"), "ddb-list-0000001", at(1));
    const third = await sendFeedback(table.db, a.viewer, input("Third", { category: "question" }), "ddb-list-0000003", at(3));
    const mine = new Set([first.reportId, second.reportId, third.reportId]);
    const all = async (status: "new" | "triaged" | "dismissed") => {
      const out = [];
      let cursor: string | undefined;
      do {
        const page = await listFeedback(table.db, { status, limit: 2, cursor });
        out.push(...page.items);
        cursor = page.cursor;
      } while (cursor);
      return out.filter((r) => mine.has(r.reportId));
    };
    expect((await all("new")).map((r) => [r.message, r.category, r.teamId === a.teamId ? "a" : "b"])).toEqual([["First", "bug", "a"], ["Second", "idea", "b"], ["Third", "question", "a"]]);
    // Whole reports, and no key attributes
    const [one] = await all("new");
    expect(one).toMatchObject({ reportId: first.reportId, shortId: first.shortId, userId: a.ownerId, role: "owner", status: "new", beadId: "" });
    expect(one).not.toHaveProperty("PK");
    expect(one).not.toHaveProperty("GSI1PK");
    await expect(listFeedback(table.db, { status: "other" as never })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(listFeedback(table.db, { limit: 0 })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(listFeedback(table.db, { cursor: "garbage" })).rejects.toBeInstanceOf(InvalidInputError);

    const linked = await recordFeedbackBead(table.db, a.teamId, first.reportId, "supply-checkout-abc.1", at(10));
    expect(linked).toMatchObject({ status: "triaged", beadId: "supply-checkout-abc.1", statusAt: at(10).toISOString(), message: "First" });
    const dismissed = await dismissFeedback(table.db, b.teamId, second.reportId, { reason: "Duplicate", at: at(11) });
    expect(dismissed).toMatchObject({ status: "dismissed", beadId: "", dismissReason: "Duplicate" });
    expect((await all("new")).map((r) => r.message)).toEqual(["Third"]);
    expect((await all("triaged")).map((r) => r.message)).toEqual(["First"]);
    expect((await all("dismissed")).map((r) => r.message)).toEqual(["Second"]);
    expect(await getFeedback(table.db, a.teamId, first.reportId)).toMatchObject({ status: "triaged", beadId: "supply-checkout-abc.1", message: "First" });
    expect(await getFeedback(table.db, a.teamId, second.reportId)).toBeUndefined();
    await expect(recordFeedbackBead(table.db, a.teamId, "0".repeat(32), "supply-checkout-abc.2")).rejects.toBeInstanceOf(NotFoundError);
    await expect(dismissFeedback(table.db, a.teamId, "0".repeat(32))).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordFeedbackBead(table.db, a.teamId, first.reportId, "not a bead!")).rejects.toBeInstanceOf(InvalidInputError);
    // The send's idempotent replay of a triaged report doesn't put it back to new
    expect((await sendFeedback(table.db, a.owner, input("First"), "ddb-list-0000001", at(20))).created).toBe(false);
    expect((await getFeedback(table.db, a.teamId, first.reportId))?.status).toBe("triaged");
  });

  it("moves a report once: dismissing a triaged report keeps its bead, and triaging again can't replace it", async () => {
    const now = new Date("2026-10-09T10:00:00.000Z");
    const t = await team(now);
    const a = await sendFeedback(table.db, t.viewer, input("Triage me"), "ddb-once-0000001", now);
    const b = await sendFeedback(table.db, t.owner, input("Dismiss me"), "ddb-once-0000002", now);
    await recordFeedbackBead(table.db, t.teamId, a.reportId, "supply-checkout-abc.1", now);
    await expect(dismissFeedback(table.db, t.teamId, a.reportId, { reason: "Oops", at: now })).rejects.toBeInstanceOf(ConflictError);
    await expect(recordFeedbackBead(table.db, t.teamId, a.reportId, "supply-checkout-abc.2", now)).rejects.toBeInstanceOf(ConflictError);
    expect(await getFeedback(table.db, t.teamId, a.reportId)).toMatchObject({ status: "triaged", beadId: "supply-checkout-abc.1" });
    expect(await rawItem(table.db, `FEEDBACK#${t.teamId}`, `REPORT#${a.reportId}`)).toMatchObject({ GSI1PK: "FEEDBACK#STATUS#triaged", beadId: "supply-checkout-abc.1" });
    // The same bead again is a repeat, not a conflict
    expect(await recordFeedbackBead(table.db, t.teamId, a.reportId, "supply-checkout-abc.1", now)).toMatchObject({ status: "triaged" });
    await dismissFeedback(table.db, t.teamId, b.reportId, { reason: "Not a defect", at: now });
    await expect(recordFeedbackBead(table.db, t.teamId, b.reportId, "supply-checkout-abc.3", now)).rejects.toBeInstanceOf(ConflictError);
    expect(await getFeedback(table.db, t.teamId, b.reportId)).toMatchObject({ status: "dismissed", beadId: "", dismissReason: "Not a defect" });
    // Another team's ID can't reach it
    const other = await team(now);
    await expect(dismissFeedback(table.db, other.teamId, b.reportId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await getFeedback(table.db, other.teamId, b.reportId)).toBeUndefined();
  });
});
