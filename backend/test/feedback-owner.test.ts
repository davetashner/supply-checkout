// The owner's side of reports (src/data/feedback-owner.ts): that no Lambda can
// reach it, and its status preconditions with scripted answers. The same
// expressions run against DynamoDB Local in feedback-ddb.test.ts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConflictError, InvalidInputError, NotFoundError } from "../src/data/errors.js";
import { DISMISS_REASON_MAX, dismissFeedback, getFeedback, listFeedback, recordFeedbackBead } from "../src/data/feedback-owner.js";
import * as barrel from "../src/data/index.js";
import { fakeDb } from "./helpers.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const TEAM = "team-a";
const REPORT = "a".repeat(32);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("no Lambda bundle can import the owner's report functions", () => {
  it("is imported by no file under src/ (Lambda entries and what they import all live there)", () => {
    const importers = sources(SRC)
      .filter((file) => !file.endsWith("feedback-owner.ts"))
      .filter((file) => /(?:from|import\s*\(|require\s*\()\s*["'][^"']*feedback-owner/.test(readFileSync(file, "utf8")));
    expect(importers.map((f) => f.slice(SRC.length))).toEqual([]);
  });

  it("looks for static, dynamic and CommonJS imports", () => {
    const IMPORT = /(?:from|import\s*\(|require\s*\()\s*["'][^"']*feedback-owner/;
    expect(IMPORT.test('import { listFeedback } from "./feedback-owner.js";')).toBe(true);
    expect(IMPORT.test('const m = await import("../data/feedback-owner.js");')).toBe(true);
    expect(IMPORT.test('// see feedback-owner.ts')).toBe(false);
  });

  it("is not exported from the data module's entry point, nor from feedback.ts", async () => {
    const owner = ["listFeedback", "getFeedback", "recordFeedbackBead", "dismissFeedback", "DISMISS_REASON_MAX"];
    for (const name of owner) expect(barrel).not.toHaveProperty(name);
    const feedback = await import("../src/data/feedback.js");
    for (const name of owner) expect(feedback).not.toHaveProperty(name);
    // The shared constants and the send path stay where they were
    expect(barrel).toHaveProperty("sendFeedback");
    expect(barrel).toHaveProperty("FEEDBACK_STATUSES");
  });
});

/** A Db whose update fails its condition, then reads `current` back (undefined: no such item). */
function conflicting(current: Record<string, unknown> | undefined) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const db = fakeDb(async (command) => {
    const name = (command as unknown as { constructor: { name: string } }).constructor.name;
    sent.push({ name, input: command.input });
    if (name === "UpdateCommand") throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
    return { Item: current };
  });
  return { db, sent };
}

describe("status preconditions", () => {
  it("only moves a report that's still new", async () => {
    const sent: Record<string, unknown>[] = [];
    const db = fakeDb(async (command) => {
      sent.push(command.input);
      return { Attributes: { type: "feedback", reportId: REPORT, status: "triaged", beadId: "supply-checkout-abc.1", PK: "x", SK: "y", GSI1PK: "z" } };
    });
    const done = await recordFeedbackBead(db, TEAM, REPORT, "supply-checkout-abc.1");
    expect(done).toEqual({ type: "feedback", reportId: REPORT, status: "triaged", beadId: "supply-checkout-abc.1" });
    expect(sent[0]).toMatchObject({
      ConditionExpression: "attribute_exists(PK) AND #type = :feedback AND #status = :from",
      ExpressionAttributeValues: expect.objectContaining({ ":from": "new", ":status": "triaged", ":bead": "supply-checkout-abc.1", ":partition": "FEEDBACK#STATUS#triaged" }),
    });
    await dismissFeedback(db, TEAM, REPORT, { reason: "Duplicate of an open bead" });
    expect(sent[1]).toMatchObject({
      UpdateExpression: expect.stringContaining("dismissReason = :reason"),
      ExpressionAttributeValues: expect.objectContaining({ ":from": "new", ":status": "dismissed", ":bead": "", ":reason": "Duplicate of an open bead" }),
    });
    await dismissFeedback(db, TEAM, REPORT);
    expect(sent[2]?.UpdateExpression).not.toContain("dismissReason");
  });

  it("refuses to dismiss a triaged report, or to triage one again with another bead, and names the bead, not the text", async () => {
    const triaged = { type: "feedback", status: "triaged", beadId: "supply-checkout-abc.1", message: "PRIVATE TEXT" };
    const dismiss = conflicting(triaged);
    const error = await dismissFeedback(dismiss.db, TEAM, REPORT, { reason: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toBe("This report is already triaged (bead supply-checkout-abc.1)");
    await expect(recordFeedbackBead(conflicting(triaged).db, TEAM, REPORT, "supply-checkout-abc.2")).rejects.toBeInstanceOf(ConflictError);
    await expect(recordFeedbackBead(conflicting({ ...triaged, status: "dismissed", beadId: "" }).db, TEAM, REPORT, "supply-checkout-abc.2")).rejects.toThrow("This report is already dismissed");
  });

  it("answers a repeat of the same change with the report as it is", async () => {
    const triaged = { type: "feedback", reportId: REPORT, status: "triaged", beadId: "supply-checkout-abc.1" };
    expect(await recordFeedbackBead(conflicting(triaged).db, TEAM, REPORT, "supply-checkout-abc.1")).toEqual(triaged);
    const dismissed = { type: "feedback", reportId: REPORT, status: "dismissed", beadId: "" };
    expect(await dismissFeedback(conflicting(dismissed).db, TEAM, REPORT, { reason: "Again" })).toEqual(dismissed);
  });

  it("says no such report for a missing one, and passes on other failures", async () => {
    await expect(recordFeedbackBead(conflicting(undefined).db, TEAM, REPORT, "supply-checkout-abc.1")).rejects.toBeInstanceOf(NotFoundError);
    await expect(dismissFeedback(conflicting({ type: "other", status: "new" }).db, TEAM, REPORT)).rejects.toBeInstanceOf(NotFoundError);
    const down = Object.assign(new Error("Unavailable"), { name: "ServiceUnavailable" });
    await expect(dismissFeedback(fakeDb(() => Promise.reject(down)), TEAM, REPORT)).rejects.toBe(down);
  });

  it("validates the bead ID and the reason before any call", async () => {
    const never = fakeDb(() => Promise.reject(new Error("must not be called")));
    await expect(recordFeedbackBead(never, TEAM, REPORT, "not a bead!")).rejects.toBeInstanceOf(InvalidInputError);
    await expect(dismissFeedback(never, TEAM, REPORT, { reason: "x".repeat(DISMISS_REASON_MAX + 1) })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(dismissFeedback(never, TEAM, REPORT, { reason: "line\nbreak" })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(recordFeedbackBead(never, "team/../x", REPORT, "supply-checkout-abc.1")).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("listing and reading", () => {
  it("validates status and limit, reads the status partition, and keys a read on team and full report ID", async () => {
    const sent: Record<string, unknown>[] = [];
    const db = fakeDb(async (command) => {
      sent.push(command.input);
      return "Item" in command.input || command.input.Key ? { Item: { type: "feedback", PK: "p", SK: "s", reportId: REPORT } } : { Items: [], LastEvaluatedKey: undefined };
    });
    await listFeedback(db, { status: "triaged", limit: 100 });
    expect(sent[0]).toMatchObject({ IndexName: "GSI1", ExpressionAttributeValues: { ":pk": "FEEDBACK#STATUS#triaged" }, Limit: 100 });
    await expect(listFeedback(db, { limit: 101 })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(listFeedback(db, { status: "gone" as never })).rejects.toBeInstanceOf(InvalidInputError);
    expect(await getFeedback(db, TEAM, REPORT)).toEqual({ type: "feedback", reportId: REPORT });
    expect(sent.at(-1)).toMatchObject({ Key: { PK: `FEEDBACK#${TEAM}`, SK: `REPORT#${REPORT}` }, ConsistentRead: true });
    const other = fakeDb(async () => ({ Item: { type: "team" } }));
    expect(await getFeedback(other, TEAM, REPORT)).toBeUndefined();
  });
});
