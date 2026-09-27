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
  createTeam,
  endComp,
  getOpsTeam,
  listOperatorAudit,
  listOpsTeams,
  listStuckImportsForOps,
  listSupportActions,
  listTeamsToPurge,
  reopenOpsTeam,
  reopenTeam,
  setComp,
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
});
