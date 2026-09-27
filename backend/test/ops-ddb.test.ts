// The operator functions (ADR 0015) against DynamoDB Local, with GSI3's real
// INCLUDE projection: the index hands back the account record and nothing
// else. Skipped unless DYNAMODB_ENDPOINT is set (CI sets it).

import { describe, expect, it } from "vitest";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { connection } from "../src/data/client.js";
import { clearStuckImport, createTeam, endComp, getOpsTeam, listOperatorAudit, listOpsTeams, listStuckImportsForOps, setComp } from "../src/data/index.js";
import { endpoint, newUser, rawItem, useTable } from "./helpers.js";

describe.skipIf(!endpoint)("operators (ADR 0015) on DynamoDB Local", () => {
  const table = useTable();
  const op = { sub: "op-sub-ddb" };
  const now = new Date();

  it("lists and reads a team from the index only, comps it and ends the comp, audited", async () => {
    const ownerId = newUser();
    const { team } = await createTeam(table.db, { userId: ownerId, email: "owner@example.com" }, { name: `Ops Local ${ownerId}` }, now);
    const listed = (await listOpsTeams(table.db, op, { q: ownerId.slice(5) })).teams;
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
