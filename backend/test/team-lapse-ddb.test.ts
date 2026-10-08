// The lapsed-team job's data calls (data/team-lapse.ts) against DynamoDB Local
// (skipped without DYNAMODB_ENDPOINT; `npm run test:ddb` runs it): the
// operators' index listings, the records' conditions, and a closure the purge
// then lists and deletes.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  claimLapseNotice,
  claimLapseRun,
  closeLapsedTeam,
  authorizeTeam,
  createTeam,
  LAPSE_CHECKOUT_GUARD_HOURS,
  LAPSE_PURGE_DELAY_HOURS,
  LAPSED_CLOSER,
  linkStripeCustomer,
  listLapseCandidates,
  listOwnerEmails,
  listTeamsToPurge,
  purgeTeam,
  readLapseTeam,
  recordWarning,
  releaseLapseRun,
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
    // Nor once an owner has linked a Stripe customer (starting Checkout, a day and more ago), which moves the version
    const customer = `cus_${randomUUID().replaceAll("-", "")}`;
    const dayAgo = new Date(now.getTime() - (LAPSE_CHECKOUT_GUARD_HOURS + 1) * 3_600_000);
    await linkStripeCustomer(table.db, context, customer, dayAgo);
    expect(await closeLapsedTeam(table.db, read as { teamId: string; version: number }, now)).toBe(false);
    const linked = await readLapseTeam(table.db, team.teamId);
    // With when, so the job skips a team an owner is in Checkout for before calling Stripe (supply-checkout-8jc.45)
    expect(linked).toMatchObject({ stripeCustomerId: customer, version: 2, stripeCheckoutAt: dayAgo.toISOString() });
    // Every checkout links it again, moving the version, and nothing closes the team within a Checkout Session's life of it
    await linkStripeCustomer(table.db, context, customer, now);
    expect(await closeLapsedTeam(table.db, linked as { teamId: string; version: number }, now)).toBe(false);
    const recent = await readLapseTeam(table.db, team.teamId);
    expect(recent).toMatchObject({ version: 3, stripeCheckoutAt: now.toISOString() });
    expect(await closeLapsedTeam(table.db, recent as { teamId: string; version: number }, now)).toBe(false);
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).toMatchObject({ stripeCheckoutAt: now.toISOString() });
    // Once that's past: closed
    await linkStripeCustomer(table.db, context, customer, dayAgo);
    const again = await readLapseTeam(table.db, team.teamId);
    expect(again).toMatchObject({ stripeCustomerId: customer, version: 4 });
    expect(await closeLapsedTeam(table.db, again as { teamId: string; version: number }, now)).toBe(true);
    // Deleted a day later, not at once, so a closure made by mistake can still be reopened
    const purgeAfter = new Date(now.getTime() + LAPSE_PURGE_DELAY_HOURS * 3_600_000).toISOString();
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).toMatchObject({ closedAt: now.toISOString(), closedBy: LAPSED_CLOSER, purgeAfter, GSI1SK: `${purgeAfter}#${team.teamId}`, version: 5 });
    // Closed: not listed again, and closing twice does nothing
    expect(await listLapseCandidates(table.db, now)).not.toContain(team.teamId);
    expect(await closeLapsedTeam(table.db, { teamId: team.teamId, version: 5 }, now)).toBe(false);
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

  it("lets one run hold the lease at a time, until it gives it up or it runs out", async () => {
    // The lease is one item for the whole table: start from a time after any other test's lease
    const t0 = new Date(Date.now() + 365 * DAY);
    const lease = 6 * 60_000;
    expect(await claimLapseRun(table.db, t0, lease)).toBe(true);
    expect(await claimLapseRun(table.db, new Date(t0.getTime() + 60_000), lease)).toBe(false);
    // Only the holder gives it up
    await releaseLapseRun(table.db, new Date(t0.getTime() + 60_000));
    expect(await claimLapseRun(table.db, new Date(t0.getTime() + 120_000), lease)).toBe(false);
    await releaseLapseRun(table.db, t0);
    const t1 = new Date(t0.getTime() + 180_000);
    expect(await claimLapseRun(table.db, t1, lease)).toBe(true);
    // Not given up (the run died): free once it runs out
    expect(await claimLapseRun(table.db, new Date(t1.getTime() + lease - 1000), lease)).toBe(false);
    expect(await claimLapseRun(table.db, new Date(t1.getTime() + lease + 2000), lease)).toBe(true);
  });
});
