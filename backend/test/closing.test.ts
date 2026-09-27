// Closing a team, deleting an account's rows and purging closed teams,
// against DynamoDB Local (skipped without DYNAMODB_ENDPOINT; `npm run
// test:ddb` runs it locally). The handlers' side is in
// account-deletion-api.test.ts; this checks the expressions, conditions and
// index queries against the real thing, and that the data is gone after the
// stated period.

import { randomUUID } from "node:crypto";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  acceptInvite,
  authorizeTeam,
  cancelAccountDeletion,
  CLOSED_TEAM_RETENTION_DAYS,
  closeTeam,
  ConflictError,
  createInvite,
  createTeam,
  deleteInviteForEmail,
  deleteUserRows,
  ForbiddenError,
  getTeam,
  InvalidInputError,
  LastOwnerError,
  linkStripeCustomer,
  listInvitesForEmail,
  listTeamsForUser,
  listTeamsToPurge,
  liveUpdateRecipients,
  NotFoundError,
  purgeTeam,
  removeMember,
  setDocument,
  setMemberRole,
  startAccountDeletion,
  TeamClosedError,
} from "../src/data/index.js";
import { connection } from "../src/data/client.js";
import { endpoint, newUser, rawItem, useTable } from "./helpers.js";

const DAY = 86400_000;

describe.skipIf(!endpoint)("closing teams and deleting accounts (DynamoDB Local)", () => {
  const table = useTable();

  /** Everything in a partition, keys included. */
  async function partition(pk: string) {
    const { Items } = await connection(table.db).doc.send(
      new QueryCommand({ TableName: table.db.tableName, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true }),
    );
    return Items ?? [];
  }

  /** A team with an owner, a contributor and some data; the contributor joined by invite. */
  async function team(now: Date) {
    const db = table.db;
    const ownerId = newUser();
    const { team: created, context: owner } = await createTeam(db, { userId: ownerId, email: `owner.${ownerId}@example.com` }, { name: "Echo Cleaning" }, now);
    const email = `crew.${ownerId}@example.com`;
    const made = await createInvite(db, owner, { email, role: "contributor" }, now);
    const crewId = newUser();
    const crew = await acceptInvite(db, { userId: crewId, verifiedEmail: email }, made.invite, made.token, now);
    await setDocument(db, owner, "products", "0123", { code: "0123", name: "Gloves", price: 1 }, { expectedVersion: 0 });
    await setDocument(db, crew, "sheets", "s1", { client: "Echo", date: "2026-09-26", items: {} }, { expectedVersion: 0 });
    await createInvite(db, owner, { email: `pending.${ownerId}@example.com`, role: "viewer" }, now);
    return { teamId: created.teamId, owner, ownerId, crew, crewId };
  }

  it("closes a team: read-only, no invites, no live updates, in the purge index, and idempotent", async () => {
    const now = new Date("2026-09-26T12:00:00.000Z");
    const { teamId, owner, crew, crewId } = await team(now);
    await expect(closeTeam(table.db, owner, { confirmName: "Bravo" }, now)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(closeTeam(table.db, crew, { confirmName: "Echo Cleaning" }, now)).rejects.toBeInstanceOf(ForbiddenError);
    const { team: closed, closedNow } = await closeTeam(table.db, owner, { confirmName: " echo cleaning " }, now);
    expect(closedNow).toBe(true);
    const purgeAfter = new Date(now.getTime() + CLOSED_TEAM_RETENTION_DAYS * DAY).toISOString();
    expect(closed).toMatchObject({ closedAt: now.toISOString(), purgeAfter, closedBy: owner.userId, version: 2 });
    expect(await rawItem(table.db, `TEAM#${teamId}`, "META")).toMatchObject({ GSI1PK: "TEAMS#CLOSED", GSI1SK: `${purgeAfter}#${teamId}` });
    expect((await partition(`TEAM#${teamId}`)).filter((i) => String(i.SK).startsWith("INVITE#"))).toEqual([]);
    expect(await liveUpdateRecipients(table.db, teamId)).toEqual([]);
    // Read-only for everyone, owners included
    const fresh = await authorizeTeam(table.db, owner.userId, teamId);
    expect(fresh.closed).toBe(true);
    await expect(setDocument(table.db, fresh, "products", "0999", { code: "", name: "New", price: 1 }, { expectedVersion: 0 })).rejects.toBeInstanceOf(TeamClosedError);
    await expect(setMemberRole(table.db, fresh, crewId, "viewer")).rejects.toBeInstanceOf(TeamClosedError);
    await expect(createInvite(table.db, fresh, { email: "late@example.com", role: "viewer" })).rejects.toBeInstanceOf(TeamClosedError);
    // Again: nothing changes
    const again = await closeTeam(table.db, fresh, { confirmName: "whatever" }, new Date(now.getTime() + DAY));
    expect(again).toEqual({ team: closed, closedNow: false });
  });

  it("refuses to close for an owner demoted since their context was issued", async () => {
    const now = new Date();
    const { teamId, owner, crewId } = await team(now);
    await setMemberRole(table.db, owner, crewId, "owner");
    const crewOwner = await authorizeTeam(table.db, crewId, teamId);
    await setMemberRole(table.db, crewOwner, owner.userId, "viewer");
    await expect(closeTeam(table.db, owner, { confirmName: "Echo Cleaning" }, now)).rejects.toBeInstanceOf(ConflictError);
    expect((await getTeam(table.db, crewOwner)).closedAt).toBeUndefined();
  });

  it("lets everyone leave a closed team, the last owner too, moving the counts; an open team keeps its last owner", async () => {
    const now = new Date();
    const { teamId, owner, crew, ownerId, crewId } = await team(now);
    await expect(removeMember(table.db, owner, ownerId)).rejects.toBeInstanceOf(LastOwnerError);
    await closeTeam(table.db, owner, { confirmName: "Echo Cleaning" }, now);
    const closedOwner = await authorizeTeam(table.db, ownerId, teamId);
    await removeMember(table.db, crew, crewId, { reason: "account_deleted" }, now);
    await removeMember(table.db, closedOwner, ownerId, {}, now);
    expect(await rawItem(table.db, `TEAM#${teamId}`, "META")).toMatchObject({ members: 0, owners: 0 });
    expect(await listTeamsForUser(table.db, ownerId)).toEqual([]);
    const audit = (await partition(`TEAM#${teamId}`)).filter((i) => String(i.SK).startsWith("AUDIT#"));
    expect(audit).toHaveLength(3);
    expect(audit.map((a) => [a.action, a.target, a.detail])).toEqual(
      expect.arrayContaining([
        ["member.left", crewId, { reason: "account_deleted" }],
        ["member.left", ownerId, undefined],
        ["team.closed", undefined, undefined],
      ]),
    );
  });

  it("refuses new members once closed, and joins or new teams while the account is being deleted", async () => {
    const now = new Date();
    const { teamId, owner } = await team(now);
    const email = `late.${randomUUID()}@example.com`;
    const made = await createInvite(table.db, owner, { email, role: "viewer" }, now);
    const userId = newUser();
    await startAccountDeletion(table.db, userId, now);
    await startAccountDeletion(table.db, userId, new Date(now.getTime() + 1000));
    expect(await rawItem(table.db, `USER#${userId}`, "DELETING")).toMatchObject({ startedAt: now.toISOString() });
    await expect(acceptInvite(table.db, { userId, verifiedEmail: email }, made.invite, made.token, now)).rejects.toThrow("This account is being deleted");
    await expect(createTeam(table.db, { userId }, { name: "New", requestKey: "key-00000001" }, now)).rejects.toThrow("This account is being deleted");
    await cancelAccountDeletion(table.db, userId);
    await closeTeam(table.db, owner, { confirmName: "Echo Cleaning" }, now);
    await expect(acceptInvite(table.db, { userId, verifiedEmail: email }, made.invite, made.token, now)).rejects.toBeInstanceOf(NotFoundError);
    expect(await rawItem(table.db, `TEAM#${teamId}`, `MEMBER#${userId}`)).toBeUndefined();
  });

  it("deletes a user's rows but the mark, and invites to their address", async () => {
    const now = new Date();
    const { owner } = await team(now);
    const userId = newUser();
    const email = `gone.${userId}@example.com`;
    await createInvite(table.db, owner, { email, role: "viewer" }, now);
    await createTeam(table.db, { userId }, { name: "Mine", requestKey: "key-00000002" }, now);
    await startAccountDeletion(table.db, userId, now);
    const invites = await listInvitesForEmail(table.db, email, new Date(now.getTime() + 30 * DAY), { includeExpired: true });
    expect(invites).toHaveLength(1);
    for (const invite of invites) await deleteInviteForEmail(table.db, email, invite);
    await deleteInviteForEmail(table.db, email, invites[0] as { teamId: string; inviteId: string });
    expect(await listInvitesForEmail(table.db, email, now, { includeExpired: true })).toEqual([]);
    // The team row and the day's team counter
    expect(await deleteUserRows(table.db, userId)).toBe(2);
    expect((await partition(`USER#${userId}`)).map((i) => i.SK)).toEqual(["DELETING"]);
  });

  it("purges a closed team once its 30 days are over, and not before; everything it had is gone", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    const { teamId, owner, ownerId, crewId } = await team(now);
    const other = await team(now);
    await linkStripeCustomer(table.db, owner, `cus_${teamId.slice(0, 8)}`);
    await closeTeam(table.db, owner, { confirmName: "Echo Cleaning" }, now);
    const before = new Date(now.getTime() + (CLOSED_TEAM_RETENTION_DAYS - 1) * DAY);
    expect((await listTeamsToPurge(table.db, before)).map((t) => t.teamId)).not.toContain(teamId);
    expect(await purgeTeam(table.db, teamId, before)).toEqual({ deleted: 0, skipped: true });
    expect((await partition(`TEAM#${teamId}`)).length).toBeGreaterThan(5);

    const after = new Date(now.getTime() + CLOSED_TEAM_RETENTION_DAYS * DAY + 1000);
    const due = await listTeamsToPurge(table.db, after);
    expect(due).toContainEqual({ teamId, purgeAfter: new Date(now.getTime() + CLOSED_TEAM_RETENTION_DAYS * DAY).toISOString() });
    const result = await purgeTeam(table.db, teamId, after);
    expect(result.skipped).toBe(false);
    expect(await partition(`TEAM#${teamId}`)).toEqual([]);
    expect(await rawItem(table.db, `STRIPE#cus_${teamId.slice(0, 8)}`, "TEAM")).toBeUndefined();
    expect(await listTeamsForUser(table.db, ownerId)).toEqual([]);
    expect(await listTeamsForUser(table.db, crewId)).toEqual([]);
    expect((await listTeamsToPurge(table.db, after)).map((t) => t.teamId)).not.toContain(teamId);
    // Running it again is harmless, and the other team is untouched
    expect(await purgeTeam(table.db, teamId, after)).toEqual({ deleted: 0, skipped: true });
    expect((await partition(`TEAM#${other.teamId}`)).length).toBeGreaterThan(5);
    expect(await listTeamsForUser(table.db, other.ownerId)).toHaveLength(1);
  });
});
