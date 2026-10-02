// The lapsed-team job's data calls (data/team-lapse.ts) against DynamoDB Local
// (skipped without DYNAMODB_ENDPOINT; `npm run test:ddb` runs it): the
// operators' index listings, the records' conditions, and a closure the purge
// then lists and deletes.

import { describe, expect, it } from "vitest";
import {
  claimLapseNotice,
  closeLapsedTeam,
  createTeam,
  LAPSED_CLOSER,
  listLapseCandidates,
  listOwnerEmails,
  listTeamsToPurge,
  purgeTeam,
  readLapseTeam,
  recordWarning,
  warnedAt,
} from "../src/data/index.js";
import { endpoint, newUser, rawItem, useTable } from "./helpers.js";

const DAY = 86_400_000;

describe.skipIf(!endpoint)("the lapsed-team job's data (DynamoDB Local)", () => {
  const table = useTable();

  it("lists a lapsed trial from the index, reads it, and closes it only at the version read, for the purge to delete", async () => {
    const made = new Date(Date.now() - 60 * DAY);
    const ownerId = newUser();
    const { team } = await createTeam(table.db, { userId: ownerId, email: `owner.${ownerId}@example.com` }, { name: "Lapsed Co" }, made);
    const fresh = await createTeam(table.db, { userId: newUser() }, { name: "Fresh Co" });
    const now = new Date();
    const listed = await listLapseCandidates(table.db, now);
    expect(listed).toContain(team.teamId);
    expect(listed).not.toContain(fresh.team.teamId);
    const read = await readLapseTeam(table.db, team.teamId);
    expect(read).toMatchObject({ teamId: team.teamId, name: "Lapsed Co", status: "trialing", trialEndsAt: team.trialEndsAt, version: 1 });
    expect(await readLapseTeam(table.db, "no-such-team")).toBeUndefined();
    expect(await listOwnerEmails(table.db, team.teamId)).toEqual([{ userId: ownerId, email: `owner.${ownerId}@example.com` }]);

    // Its records: once each
    expect(await claimLapseNotice(table.db, team.teamId, "trialEnded", team.trialEndsAt as string, ownerId, now)).toBe(true);
    expect(await claimLapseNotice(table.db, team.teamId, "trialEnded", team.trialEndsAt as string, ownerId, now)).toBe(false);
    const deleteAfter = new Date(now.getTime() + DAY).toISOString();
    expect(await warnedAt(table.db, team.teamId, deleteAfter)).toBeUndefined();
    expect(await recordWarning(table.db, team.teamId, deleteAfter, now)).toBe(now.toISOString());
    expect(await recordWarning(table.db, team.teamId, deleteAfter, new Date(now.getTime() + DAY))).toBe(now.toISOString());

    // A change since the read: not closed. Nor once an owner has linked a Stripe customer (Checkout), which moves no version
    expect(await closeLapsedTeam(table.db, { teamId: team.teamId, version: 0 }, now)).toBe(false);
    expect(await closeLapsedTeam(table.db, { teamId: team.teamId, version: 1, stripeCustomerId: "cus_x" }, now)).toBe(false);
    expect(await closeLapsedTeam(table.db, { teamId: team.teamId, version: 1, stripeSubscriptionId: "sub_x" }, now)).toBe(false);
    expect(await closeLapsedTeam(table.db, { teamId: "no-such-team", version: 1 }, now)).toBe(false);
    expect(await closeLapsedTeam(table.db, read as { teamId: string; version: number }, now)).toBe(true);
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).toMatchObject({ closedAt: now.toISOString(), closedBy: LAPSED_CLOSER, purgeAfter: now.toISOString(), version: 2 });
    // Closed: not listed again, and closing twice does nothing
    expect(await listLapseCandidates(table.db, now)).not.toContain(team.teamId);
    expect(await closeLapsedTeam(table.db, { teamId: team.teamId, version: 2 }, now)).toBe(false);

    // The purge takes it from there
    const later = new Date(now.getTime() + 1000);
    expect((await listTeamsToPurge(table.db, later)).map((t) => t.teamId)).toContain(team.teamId);
    expect(await purgeTeam(table.db, team.teamId, later)).toMatchObject({ skipped: false });
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).toBeUndefined();
  });
});
