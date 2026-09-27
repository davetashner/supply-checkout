// The operators' index (GSI3, ADR 0015): which items the data layer puts in
// it. A team's META item and its owners' MEMBER items, and nothing else, so
// the ops role's index queries can't reach sheets, inventory or invites.

import { describe, expect, it } from "vitest";
import { acceptInvite, authorizeTeam, createInvite, createTeam, removeMember, setMemberRole } from "../src/data/index.js";
import { MemoryTable } from "./memory-table.js";

const NOW = new Date("2026-09-26T12:00:00Z");

describe("the operators' index", () => {
  it("lists a new team and its owner", async () => {
    const table = new MemoryTable();
    const { team } = await createTeam(table.db(), { userId: "user-owner", email: "owner@example.com" }, { name: "Acme" }, NOW);
    expect(table.get(`TEAM#${team.teamId}`, "META")).toMatchObject({ GSI3PK: "OPS#TEAMS", GSI3SK: `2026-09-26T12:00:00.000Z#${team.teamId}` });
    expect(table.get(`TEAM#${team.teamId}`, "MEMBER#user-owner")).toMatchObject({ GSI3PK: `OPS#OWNERS#${team.teamId}`, GSI3SK: "user-owner" });
  });

  it("adds an owner who joins by invite, and not a contributor; moves members in and out as their role changes", async () => {
    const table = new MemoryTable();
    const db = table.db();
    const { team, context } = await createTeam(db, { userId: "user-owner" }, { name: "Acme" }, NOW);
    const asOwner = await createInvite(db, context, { email: "pat@example.com", role: "owner" }, NOW);
    await acceptInvite(db, { userId: "user-pat", verifiedEmail: "pat@example.com" }, asOwner.invite, asOwner.token, NOW);
    const asCrew = await createInvite(db, context, { email: "sam@example.com", role: "contributor" }, NOW);
    await acceptInvite(db, { userId: "user-sam", verifiedEmail: "sam@example.com" }, asCrew.invite, asCrew.token, NOW);
    const member = (u: string) => table.get(`TEAM#${team.teamId}`, `MEMBER#${u}`) as Record<string, unknown>;
    expect(member("user-pat")).toMatchObject({ GSI3PK: `OPS#OWNERS#${team.teamId}`, GSI3SK: "user-pat" });
    expect(member("user-sam").GSI3PK).toBeUndefined();

    const owner = await authorizeTeam(db, "user-owner", team.teamId);
    await setMemberRole(db, owner, "user-sam", "owner");
    expect(member("user-sam")).toMatchObject({ role: "owner", GSI3PK: `OPS#OWNERS#${team.teamId}`, GSI3SK: "user-sam" });
    await setMemberRole(db, owner, "user-pat", "viewer");
    expect(member("user-pat").role).toBe("viewer");
    expect(member("user-pat").GSI3PK).toBeUndefined();
    expect(member("user-pat").GSI3SK).toBeUndefined();
    await removeMember(db, owner, "user-sam");
    expect(table.get(`TEAM#${team.teamId}`, "MEMBER#user-sam")).toBeUndefined();
  });

  it("never lists invites, sheets or anything else in a team's partition", async () => {
    const table = new MemoryTable();
    const db = table.db();
    const { team, context } = await createTeam(db, { userId: "user-owner" }, { name: "Acme" }, NOW);
    await createInvite(db, context, { email: "pat@example.com", role: "owner" }, NOW);
    const indexed = [...table.items.values()].filter((i) => i.GSI3PK !== undefined).map((i) => i.SK);
    expect(indexed.sort()).toEqual(["MEMBER#user-owner", "META"]);
    expect(team.teamId).toBeTruthy();
  });
});
