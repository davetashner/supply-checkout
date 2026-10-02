// The operator functions (ADR 0015) against DynamoDB Local, with GSI3's real
// INCLUDE projection: the index hands back the account record and nothing
// else. Skipped unless DYNAMODB_ENDPOINT is set (CI sets it).

import { describe, expect, it } from "vitest";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { connection } from "../src/data/client.js";
import {
  CLOSED_TEAM_RETENTION_DAYS,
  clearStuckImport,
  closeTeam,
  countBilledMembers,
  createTeam,
  endComp,
  getBillingTeam,
  getOpsTeam,
  listOperatorAudit,
  listOpsTeams,
  listStuckImportsForOps,
  listSupportActions,
  listTeamsToPurge,
  listTeamsToReconcile,
  linkStripeCustomer,
  reopenOpsTeam,
  recordCompDiscount,
  reopenTeam,
  setComp,
  teamContextForStripeCustomer,
  TeamDeletingError,
} from "../src/data/index.js";
import { endpoint, newUser, rawItem, useTable } from "./helpers.js";

describe.skipIf(!endpoint)("operators (ADR 0015) on DynamoDB Local", () => {
  const table = useTable();
  const op = { sub: "op-sub-ddb" };
  const now = new Date();

  /** Every page of a team list, following cursors: a search reads a bounded number of teams per request. */
  async function allPages(options: { q?: string; limit?: number }) {
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await listOpsTeams(table.db, op, { ...options, cursor });
      pages.push(page.teams.map((t) => t.teamId));
      cursor = page.cursor;
    } while (cursor);
    return pages;
  }

  it("lists and reads a team from the index only, comps it and ends the comp, audited", async () => {
    const ownerId = newUser();
    const { team } = await createTeam(table.db, { userId: ownerId, email: "owner@example.com" }, { name: `Ops Local ${ownerId}` }, now);
    expect((await allPages({ q: ownerId.slice(5) })).flat()).toEqual([team.teamId]);
    const listed = (await listOpsTeams(table.db, op, { q: team.teamId })).teams;
    expect(listed.map((t) => t.teamId)).toEqual([team.teamId]);
    // Only what GSI3 projects: never homeRegion
    expect((listed[0] as unknown as Record<string, unknown>).homeRegion).toBeUndefined();

    const { team: record, owners } = await getOpsTeam(table.db, op, team.teamId, now);
    expect(record).toMatchObject({ teamId: team.teamId, plan: "trial", status: "trialing", version: 1 });
    expect(owners).toEqual([{ userId: ownerId, email: "owner@example.com", joinedAt: team.createdAt }]);

    const until = new Date(now.getTime() + 30 * 86_400_000).toISOString();
    const later = (s: number) => new Date(now.getTime() + s * 1000);
    const set = await setComp(table.db, op, team.teamId, { plan: "free", until, reason: "Pilot", expectedVersion: 1, idempotencyKey: "ddb-comp-0001" }, later(1));
    expect(set).toMatchObject({ replayed: false, version: 2 });
    const again = await setComp(table.db, op, team.teamId, { plan: "free", until, reason: "Pilot", expectedVersion: 1, idempotencyKey: "ddb-comp-0001" }, later(2));
    expect(again).toEqual({ ...set, replayed: true });
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).toMatchObject({ compPlan: "free", compUntil: until, compBy: op.sub, plan: "trial", status: "trialing", version: 2 });

    await expect(setComp(table.db, op, team.teamId, { plan: "free", until, reason: "Pilot", expectedVersion: 1, idempotencyKey: "ddb-comp-0002" }, later(3))).rejects.toThrow(/changed/);
    await endComp(table.db, op, team.teamId, { reason: "Over", expectedVersion: 2, idempotencyKey: "ddb-end-0001" }, later(4));
    expect((await rawItem(table.db, `TEAM#${team.teamId}`, "META"))?.compPlan).toBeUndefined();

    const audit = await listOperatorAudit(table.db, op, { teamId: team.teamId });
    expect(audit.items.map((e) => e.action)).toEqual(["ops.comp.end", "ops.comp.set", "ops.team.read"]);
    const month = await listOperatorAudit(table.db, op, { month: now.toISOString().slice(0, 7), limit: 100 });
    expect(month.items.filter((e) => e.teamId === team.teamId)).toHaveLength(3);
  });

  it("comps for a number of months, which the billing worker reads and audits the discount of, and the end removes (supply-checkout-6e4b)", async () => {
    const ownerId = newUser();
    const { team, context } = await createTeam(table.db, { userId: ownerId, email: "owner@example.com" }, { name: `Ops Months ${ownerId}` }, now);
    const customer = `cus_${team.teamId.slice(0, 20).replace(/[^A-Za-z0-9]/g, "")}m`;
    await linkStripeCustomer(table.db, context, customer);
    const set = await setComp(table.db, op, team.teamId, { plan: "starter", months: 2, reason: "Two months on us", expectedVersion: 1, idempotencyKey: "ddb-months-0001" }, now);
    expect(set).toMatchObject({ months: 2, version: 2 });
    const meta = await rawItem(table.db, `TEAM#${team.teamId}`, "META");
    expect(meta).toMatchObject({ compMonths: 2, compPlan: "starter" });
    // Not in the operators' index: GSI3 projects no compMonths (it has no room), so the record shows the comp's end only
    const { team: record } = await getOpsTeam(table.db, op, team.teamId, now);
    expect((record as unknown as Record<string, unknown>).compMonths).toBeUndefined();
    expect(record.compUntil).toBe(meta?.compUntil);

    // The billing worker's view (a system context from the customer's link): the comp's months and end, live
    const ctx = await teamContextForStripeCustomer(table.db, customer);
    if (!ctx) throw new Error("no context");
    expect(await getBillingTeam(table.db, ctx, now)).toMatchObject({ compMonths: 2, compUntil: meta?.compUntil, compLive: true });
    const eventId = await recordCompDiscount(table.db, ctx, "seats-ddb-1", { outcome: "applied", subscriptionId: "sub_1", before: null, coupon: "supply-checkout-comp-2m", until: String(meta?.compUntil) }, now);
    const audit = await listOperatorAudit(table.db, op, { teamId: team.teamId });
    expect(audit.items.find((e) => e.eventId === eventId)).toMatchObject({ action: "ops.comp.discount", operatorSub: "system-billing-worker", after: { outcome: "applied", coupon: "supply-checkout-comp-2m" } });
    // Only billing's own context may write one
    await expect(recordCompDiscount(table.db, context, "seats-ddb-2", { outcome: "applied", subscriptionId: null, before: null, coupon: null, until: null }, now)).rejects.toThrow(/Only billing/);
    // Owners see it as support's, with no actor
    expect((await listSupportActions(table.db, context, {})).items.map((a) => a.action)).toContain("ops.comp.discount");

    await endComp(table.db, op, team.teamId, { reason: "Over", expectedVersion: 2, idempotencyKey: "ddb-months-0002" }, now);
    expect((await rawItem(table.db, `TEAM#${team.teamId}`, "META"))?.compMonths).toBeUndefined();
  });

  it("pages the team list and a search with cursors made from the index's own keys (supply-checkout-6uw.8)", async () => {
    const tag = newUser().slice(5);
    const made: string[] = [];
    for (let n = 0; n < 23; n++) made.push((await createTeam(table.db, { userId: newUser() }, { name: `Paging ${tag} ${n}` }, now)).team.teamId);
    // Every team in the table, 7 a page: each exactly once, in ID order
    const pages = await allPages({ limit: 7 });
    const all = pages.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual([...all].sort());
    expect(all).toEqual(expect.arrayContaining(made));
    expect(pages.slice(0, -1).every((p) => p.length === 7)).toBe(true);
    // A search that stops part-way through a read goes on from the right team
    const found = await allPages({ q: `paging ${tag}`, limit: 4 });
    expect(found.flat().sort()).toEqual([...made].sort());
  });

  it("sees a closed team closed (no comps), and a reopened one open again (comps allowed)", async () => {
    const ownerId = newUser();
    const { team, context } = await createTeam(table.db, { userId: ownerId, email: "owner@example.com" }, { name: `Ops Reopen ${ownerId}` }, now);
    const { team: closed } = await closeTeam(table.db, context, { confirmName: team.name }, now);
    const until = new Date(now.getTime() + 30 * 86_400_000).toISOString();
    expect((await getOpsTeam(table.db, op, team.teamId, now)).team.closedAt).toBe(closed.closedAt);
    await expect(setComp(table.db, op, team.teamId, { plan: "free", until, reason: "Pilot", expectedVersion: 2, idempotencyKey: "ddb-reopen-0001" }, now)).rejects.toThrow(/closed/);
    const { team: reopened } = await reopenTeam(table.db, context, { confirmName: team.name }, now);
    const { team: record } = await getOpsTeam(table.db, op, team.teamId, now);
    expect(record.closedAt).toBeUndefined();
    expect(record.version).toBe(reopened.version);
    expect(await setComp(table.db, op, team.teamId, { plan: "free", until, reason: "Pilot", expectedVersion: reopened.version, idempotencyKey: "ddb-reopen-0002" }, now)).toMatchObject({ replayed: false });
  });

  it("reopens a closed team for an operator, in its last hour too, audited for the owners (supply-checkout-6uw.6)", async () => {
    const ownerId = newUser();
    const name = `Ops Operator Reopen ${ownerId}`;
    const { team, context } = await createTeam(table.db, { userId: ownerId, email: "owner@example.com" }, { name }, now);
    // Closed long enough ago that its purge is 30 minutes away: past the owners' cutoff
    const closedAt = new Date(now.getTime() - CLOSED_TEAM_RETENTION_DAYS * 86_400_000 + 30 * 60_000);
    const { team: closed } = await closeTeam(table.db, context, { confirmName: name }, closedAt);
    const later = new Date(now.getTime() + 60 * 86_400_000);
    expect((await listTeamsToPurge(table.db, later, 1000)).map((t) => t.teamId)).toContain(team.teamId);
    await expect(reopenTeam(table.db, context, { confirmName: name }, now)).rejects.toBeInstanceOf(TeamDeletingError);

    const input = { reason: "Disputed closure", expectedVersion: closed.version, idempotencyKey: "ddb-ops-reopen-0001" };
    const outcome = await reopenOpsTeam(table.db, op, team.teamId, input, now);
    expect(outcome).toMatchObject({ replayed: false, version: closed.version + 1 });
    expect(await reopenOpsTeam(table.db, op, team.teamId, input, now)).toEqual({ ...outcome, replayed: true });
    const meta = await rawItem(table.db, `TEAM#${team.teamId}`, "META");
    for (const field of ["closedAt", "closedBy", "purgeAfter", "GSI1PK", "GSI1SK"]) expect(meta?.[field], field).toBeUndefined();
    // The billing worker resyncs its Stripe subscription from this closure (supply-checkout-85qp)
    expect(meta).toMatchObject({ stripeResyncFor: closed.closedAt, stripeReopenedAt: now.toISOString() });
    expect((await listTeamsToPurge(table.db, later, 1000)).map((t) => t.teamId)).not.toContain(team.teamId);
    expect((await getOpsTeam(table.db, op, team.teamId, now)).team.closedAt).toBeUndefined();
    const actions = await listSupportActions(table.db, context, {});
    expect(actions.items).toEqual(expect.arrayContaining([expect.objectContaining({ action: "ops.team.reopen", reason: "Disputed closure", before: { closedAt: closed.closedAt, purgeAfter: closed.purgeAfter }, after: null })]));

    // Closed again, 2 minutes from its purge: too late even for an operator
    const { team: again } = await closeTeam(table.db, context, { confirmName: name }, new Date(now.getTime() - CLOSED_TEAM_RETENTION_DAYS * 86_400_000 + 2 * 60_000));
    await expect(reopenOpsTeam(table.db, op, team.teamId, { ...input, expectedVersion: again.version, idempotencyKey: "ddb-ops-reopen-0002" }, now)).rejects.toBeInstanceOf(TeamDeletingError);
    expect((await rawItem(table.db, `TEAM#${team.teamId}`, "META"))?.closedAt).toBe(again.closedAt);
  });

  it("lists a stuck import and takes it out of the check, audited", async () => {
    const teamId = `team-${newUser()}`;
    const started = new Date(now.getTime() - 3 * 3600_000).toISOString();
    await connection(table.db).doc.send(
      new PutCommand({
        TableName: table.db.tableName,
        Item: { PK: `TEAM#${teamId}`, SK: "IMPORT#imp-1", GSI1PK: "IMPORTS#COMMITTING", GSI1SK: `${started}#imp-1`, type: "import", status: "committing", committed: 1, total: 2 },
      }),
    );
    const cutoff = new Date(now.getTime() - 3600_000);
    expect((await listStuckImportsForOps(table.db, op, cutoff)).filter((j) => j.teamId === teamId)).toEqual([{ teamId, importId: "imp-1", startedAt: started, committed: 1, total: 2 }]);
    await clearStuckImport(table.db, op, teamId, "imp-1", { reason: "Owner re-imported it", idempotencyKey: "ddb-clear-0001", startedBefore: cutoff }, now);
    expect(await rawItem(table.db, `TEAM#${teamId}`, "IMPORT#imp-1")).toMatchObject({ status: "committing", committed: 1, total: 2 });
    expect((await rawItem(table.db, `TEAM#${teamId}`, "IMPORT#imp-1"))?.GSI1PK).toBeUndefined();
    expect((await listStuckImportsForOps(table.db, op, cutoff)).filter((j) => j.teamId === teamId)).toEqual([]);
    expect((await listOperatorAudit(table.db, op, { teamId })).items.map((e) => e.action)).toEqual(["ops.import.clear"]);
  });

  it("lists the open teams with a Stripe customer for the seat reconciliation, from the index alone, and counts billed members (supply-checkout-l50)", async () => {
    const make = async (label: string) => {
      const ownerId = newUser();
      return { ownerId, ...(await createTeam(table.db, { userId: ownerId, email: "owner@example.com" }, { name: `Seats ${label} ${ownerId}` }, now)) };
    };
    const linked = await make("linked");
    const unlinked = await make("unlinked");
    const closed = await make("closed");
    await linkStripeCustomer(table.db, linked.context, `cus_${linked.team.teamId.slice(0, 20).replace(/[^A-Za-z0-9]/g, "")}`);
    await linkStripeCustomer(table.db, closed.context, `cus_${closed.team.teamId.slice(0, 20).replace(/[^A-Za-z0-9]/g, "")}c`);
    await closeTeam(table.db, closed.context, { confirmName: closed.team.name }, now);
    const ours = new Set([linked.team.teamId, unlinked.team.teamId, closed.team.teamId]);
    const listed = (await listTeamsToReconcile(table.db)).filter((t) => ours.has(t.teamId));
    expect(listed).toEqual([{ teamId: linked.team.teamId, stripeCustomerId: `cus_${linked.team.teamId.slice(0, 20).replace(/[^A-Za-z0-9]/g, "")}` }]);
    // Two viewers don't count; the owner and an editor do
    const put = (userId: string, role: string) => connection(table.db).doc.send(new PutCommand({ TableName: table.db.tableName, Item: { PK: `TEAM#${linked.team.teamId}`, SK: `MEMBER#${userId}`, type: "member", teamId: linked.team.teamId, userId, role } }));
    await put(newUser(), "viewer");
    await put(newUser(), "viewer");
    await put(newUser(), "contributor");
    expect(await countBilledMembers(table.db, linked.context)).toBe(2);
  });
});
