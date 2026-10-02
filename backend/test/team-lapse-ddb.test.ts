// The lapsed-team job's data calls (data/team-lapse.ts) against DynamoDB Local
// (skipped without DYNAMODB_ENDPOINT; `npm run test:ddb` runs it): the
// operators' index listings, the records' conditions, and a closure the purge
// then lists and deletes.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  claimLapseNotice,
  closeLapsedTeam,
  authorizeTeam,
  createTeam,
  LAPSE_PURGE_DELAY_HOURS,
  LAPSED_CLOSER,
  linkStripeCustomer,
  listLapseCandidates,
  listOwnerEmails,
  listTeamsToPurge,
  purgeTeam,
  readLapseTeam,
  recordWarning,
  reopenTeam,
  warnedAt,
} from "../src/data/index.js";
import { endpoint, newUser, rawItem, useTable } from "./helpers.js";

const DAY = 86_400_000;

describe.skipIf(!endpoint)("the lapsed-team job's data (DynamoDB Local)", () => {
  const table = useTable();

  it("lists a lapsed trial from the index, reads it, and closes it only at the version read, for the purge to delete", async () => {
    const made = new Date(Date.now() - 60 * DAY);
    const ownerId = newUser();
    const { team, context } = await createTeam(table.db, { userId: ownerId, email: `owner.${ownerId}@example.com` }, { name: "Lapsed Co" }, made);
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

    // A change since the read: not closed
    expect(await closeLapsedTeam(table.db, { teamId: team.teamId, version: 0 }, now)).toBe(false);
    expect(await closeLapsedTeam(table.db, { teamId: "no-such-team", version: 1 }, now)).toBe(false);
    // Nor once an owner has linked a Stripe customer (starting Checkout), which moves the version
    const customer = `cus_${randomUUID().replaceAll("-", "")}`;
    await linkStripeCustomer(table.db, context, customer);
    expect(await closeLapsedTeam(table.db, read as { teamId: string; version: number }, now)).toBe(false);
    const linked = await readLapseTeam(table.db, team.teamId);
    expect(linked).toMatchObject({ stripeCustomerId: customer, version: 2 });
    // Linking the same customer again (a retried Checkout) moves it again, and that's all
    await linkStripeCustomer(table.db, context, customer);
    expect(await closeLapsedTeam(table.db, linked as { teamId: string; version: number }, now)).toBe(false);
    const again = await readLapseTeam(table.db, team.teamId);
    expect(again).toMatchObject({ stripeCustomerId: customer, version: 3 });
    expect(await closeLapsedTeam(table.db, again as { teamId: string; version: number }, now)).toBe(true);
    // Deleted a day later, not at once, so a closure made by mistake can still be reopened
    const purgeAfter = new Date(now.getTime() + LAPSE_PURGE_DELAY_HOURS * 3_600_000).toISOString();
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).toMatchObject({ closedAt: now.toISOString(), closedBy: LAPSED_CLOSER, purgeAfter, GSI1SK: `${purgeAfter}#${team.teamId}`, version: 4 });
    // Closed: not listed again, and closing twice does nothing
    expect(await listLapseCandidates(table.db, now)).not.toContain(team.teamId);
    expect(await closeLapsedTeam(table.db, { teamId: team.teamId, version: 4 }, now)).toBe(false);
    expect((await listTeamsToPurge(table.db, new Date(now.getTime() + 1000))).map((t) => t.teamId)).not.toContain(team.teamId);

    // Reopened within the day (by an owner here; an operator can too): open again, and listed as lapsing again
    expect((await reopenTeam(table.db, await authorizeTeam(table.db, ownerId, team.teamId), { confirmName: "Lapsed Co" }, now)).reopenedNow).toBe(true);
    expect(await listLapseCandidates(table.db, now)).toContain(team.teamId);
    const reopened = (await readLapseTeam(table.db, team.teamId)) as { teamId: string; version: number };
    expect(await closeLapsedTeam(table.db, reopened, now)).toBe(true);

    // The purge takes it from there, once the day is up
    const later = new Date(Date.parse(purgeAfter) + 1000);
    expect((await listTeamsToPurge(table.db, later)).map((t) => t.teamId)).toContain(team.teamId);
    expect(await purgeTeam(table.db, team.teamId, later)).toMatchObject({ skipped: false });
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).toBeUndefined();
  });
});
