// Every entity in ADR 0005, against DynamoDB Local. CI runs DynamoDB Local as a
// service container and sets DYNAMODB_ENDPOINT; without it these are skipped
// locally and fail in CI.

import { describe, expect, it } from "vitest";
import {
  acceptInvite,
  adjustStock,
  authorizeTeam,
  ConflictError,
  countEmailCode,
  clearCodeSent,
  codeSentHash,
  provenEmailHash,
  recordCodeSent,
  recordVerifiedEmail,
  verifiedEmailHash,
  createInvite,
  createProduct,
  createSheet,
  createTeam,
  deleteProduct,
  deleteSheet,
  EMAIL_CODES_PER_USER_PER_DAY,
  findInvite,
  findInviteForEmail,
  ForbiddenError,
  getInvite,
  getMember,
  getProduct,
  getReceiptUsage,
  getSheet,
  getTeam,
  hashEmail,
  InvalidInputError,
  inviteLimitKey,
  INVITES_PER_ADDRESS_PER_DAY,
  INVITES_PER_TEAM_ADDRESS_PER_DAY,
  INVITES_PER_TEAM_PER_DAY,
  LastOwnerError,
  LimitReachedError,
  linkStripeCustomer,
  listAudit,
  listInvites,
  listInvitesForEmail,
  listMembers,
  listProducts,
  listSheets,
  listSheetsByDate,
  listTeamsForUser,
  markInviteFailed,
  markInviteNotSent,
  markWebhookProcessed,
  MAX_TEAMS_PER_USER,
  MEMBERS_PER_TEAM,
  MEMBERS_PER_TRIAL_TEAM,
  NotFoundError,
  recordAudit,
  recordReceiptRead,
  removeMember,
  removeSheetLine,
  resendInvite,
  revokeInvite,
  setMemberRole,
  setSheetLine,
  teamContextForEmailEvent,
  teamContextForStripeCustomer,
  TeamFullError,
  teamIdForRequest,
  TEAMS_PER_USER_PER_DAY,
  TRIAL_DAYS,
  updateProduct,
  updateSheet,
  updateTeam,
  type Db,
  type Invite,
  type TeamContext,
} from "../src/data/index.js";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { connection } from "../src/data/client.js";
import { endpoint, newUser, rawItem, REGION, useTable } from "./helpers.js";

/** Writes a raw item, for a state the API can't make (an invite for an address that has since joined). */
const connectionPut = (db: Db, item: Record<string, unknown>) => connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: item }));

/** Changes a team's META item behind the data layer's back: a billing status, or a team from before the member count. */
const rawMeta = (db: Db, teamId: string, update: string, names: Record<string, string>, values?: Record<string, unknown>) =>
  connection(db).doc.send(
    new UpdateCommand({ TableName: db.tableName, Key: { PK: `TEAM#${teamId}`, SK: "META" }, UpdateExpression: update, ExpressionAttributeNames: names, ExpressionAttributeValues: values }),
  );

describe("DynamoDB Local", () => {
  it.runIf(process.env.CI)("is configured in CI", () => {
    expect(endpoint, "Set DYNAMODB_ENDPOINT to DynamoDB Local").toBeTruthy();
  });
});

describe.skipIf(!endpoint)("access patterns (ADR 0005)", () => {
  const table = useTable();
  let db: Db;

  /** A new team with an owner, plus a contributor and a viewer. */
  async function team(name = "Echo Cleaning") {
    db = table.db;
    const ownerId = newUser();
    const { team: created, context: owner } = await createTeam(db, { userId: ownerId, email: "owner@example.com" }, { name });
    const join = async (role: "contributor" | "viewer") => {
      // An address per team: each address can be sent only so many invites a day
      const email = `${role}.${ownerId}@example.com`;
      const { invite, token } = await createInvite(db, owner, { email, role });
      return acceptInvite(db, { userId: newUser(), verifiedEmail: email }, invite, token);
    };
    return { team: created, owner, contributor: await join("contributor"), viewer: await join("viewer") };
  }

  describe("Team", () => {
    it("is created with the owner, the reverse lookup, and the local region as its home region", async () => {
      const { team: t, owner } = await team();
      expect(t.homeRegion).toBe(REGION);
      expect(owner.homeRegion).toBe(REGION);
      expect(await rawItem(db, `TEAM#${t.teamId}`, "META")).toMatchObject({ type: "team", name: "Echo Cleaning", homeRegion: REGION, version: 1 });
      expect(await getTeam(db, owner)).toMatchObject({ teamId: t.teamId, homeRegion: REGION, status: "trialing" });
    });

    it("counts a user's email verification codes per UTC day, up to the limit", async () => {
      db = table.db;
      const userId = newUser();
      const now = new Date("2026-09-26T12:00:00.000Z");
      for (let i = 0; i < EMAIL_CODES_PER_USER_PER_DAY; i++) await countEmailCode(db, userId, now);
      await expect(countEmailCode(db, userId, now)).rejects.toThrow(LimitReachedError);
      await countEmailCode(db, newUser(), now);
      await countEmailCode(db, userId, new Date("2026-09-27T00:00:00.000Z"));
    });

    it("keeps the hash of the address a user's code went to and the one they proved, in their own partition", async () => {
      db = table.db;
      const userId = newUser();
      const at = new Date("2026-09-26T12:00:00.000Z");
      const hash = verifiedEmailHash("pat@example.com");
      expect(await provenEmailHash(db, userId)).toBeUndefined();
      expect(await codeSentHash(db, userId, at)).toBeUndefined();
      // No code sent for it: nothing is recorded
      expect(await recordVerifiedEmail(db, userId, "pat@example.com", at)).toBe(false);
      expect(await rawItem(db, `USER#${userId}`, "VERIFIED_EMAIL")).toBeUndefined();
      await recordCodeSent(db, userId, " Pat@Example.com ", at);
      expect(await rawItem(db, `USER#${userId}`, "EMAIL_CODE_SENT")).toEqual({
        PK: `USER#${userId}`,
        SK: "EMAIL_CODE_SENT",
        type: "emailCodeSent",
        sentEmailHash: hash,
        sentAt: at.toISOString(),
        expiresAt: at.getTime() / 1000 + 2 * 86400,
      });
      expect(await codeSentHash(db, userId, at)).toBe(hash);
      // A code sent to one address doesn't prove another
      expect(await recordVerifiedEmail(db, userId, "pat.other@example.com", at)).toBe(false);
      expect(await recordVerifiedEmail(db, userId, "pat@example.com", at)).toBe(true);
      expect(await rawItem(db, `USER#${userId}`, "EMAIL_CODE_SENT")).toBeUndefined();
      expect(await rawItem(db, `USER#${userId}`, "VERIFIED_EMAIL")).toEqual({ PK: `USER#${userId}`, SK: "VERIFIED_EMAIL", type: "verifiedEmail", verifiedEmailHash: hash, verifiedAt: at.toISOString() });
      expect(await provenEmailHash(db, userId, { timeoutMs: 5_000, now: () => at.getTime() })).toBe(hash);
      expect(await provenEmailHash(db, userId)).toBeUndefined();
      // Used once
      expect(await recordVerifiedEmail(db, userId, "pat@example.com", at)).toBe(false);
      await recordCodeSent(db, userId, "pat@example.com", at);
      await clearCodeSent(db, userId);
      expect(await codeSentHash(db, userId, at)).toBeUndefined();
      await expect(provenEmailHash(db, "USER#x")).rejects.toThrow(InvalidInputError);
    });

    it("starts a trial, and makes one team per request key however often it's sent", async () => {
      db = table.db;
      const userId = newUser();
      const now = new Date("2026-09-26T12:00:00.000Z");
      const first = await createTeam(db, { userId }, { name: "Echo", requestKey: "key-00000001" }, now);
      expect(first.created).toBe(true);
      expect(first.team).toMatchObject({ teamId: teamIdForRequest(userId, "key-00000001"), plan: "trial", status: "trialing", homeRegion: REGION });
      expect(Date.parse(first.team.trialEndsAt as string) - now.getTime()).toBe(TRIAL_DAYS * 86400_000);
      // A double-click: both requests at once, then a retry
      const [a, b] = await Promise.all([1, 2].map(() => createTeam(db, { userId }, { name: "Echo", requestKey: "key-00000002" }, now)));
      const again = await createTeam(db, { userId }, { name: "Echo", requestKey: "key-00000002" }, now);
      expect(new Set([a?.team.teamId, b?.team.teamId, again.team.teamId]).size).toBe(1);
      expect([a?.created, b?.created, again.created].filter(Boolean)).toHaveLength(1);
      expect(again.context).toMatchObject({ role: "owner", userId });
      expect((await listTeamsForUser(db, userId)).map((t) => t.teamId).sort()).toEqual([first.team.teamId, again.team.teamId].sort());
      // The same key from someone else is a different team, which they own
      const other = await createTeam(db, { userId: newUser() }, { name: "Echo", requestKey: "key-00000001" }, now);
      expect(other.created).toBe(true);
      expect(other.team.teamId).not.toBe(first.team.teamId);
      await expect(createTeam(db, { userId }, { name: "Echo", requestKey: "short" }, now)).rejects.toThrow(InvalidInputError);
      // The same key for a differently named team is a mistake, not a retry
      await expect(createTeam(db, { userId }, { name: "Foxtrot", requestKey: "key-00000001" }, now)).rejects.toThrow(ConflictError);
    });

    it("limits how many teams a user creates a day, and a replay isn't one more", async () => {
      db = table.db;
      const userId = newUser();
      const day = new Date("2026-09-26T08:00:00.000Z");
      for (let i = 0; i < TEAMS_PER_USER_PER_DAY; i++) await createTeam(db, { userId }, { name: `Team ${i}`, requestKey: `limit-key-${i}` }, day);
      await expect(createTeam(db, { userId }, { name: "One more", requestKey: "limit-key-x" }, day)).rejects.toThrow(LimitReachedError);
      expect((await createTeam(db, { userId }, { name: "Team 0", requestKey: "limit-key-0" }, day)).created).toBe(false);
      expect(await listTeamsForUser(db, userId)).toHaveLength(TEAMS_PER_USER_PER_DAY);
      expect(await rawItem(db, `USER#${userId}`, "LIMIT#TEAMS#2026-09-26")).toMatchObject({ count: TEAMS_PER_USER_PER_DAY });
      // The next day, and other users, aren't affected
      expect((await createTeam(db, { userId }, { name: "Tomorrow", requestKey: "limit-key-x" }, new Date("2026-09-27T08:00:00.000Z"))).created).toBe(true);
      expect((await createTeam(db, { userId: newUser() }, { name: "Else" }, day)).created).toBe(true);
    });

    it("is renamed by owners with a version check; plan and status only by the billing system", async () => {
      const { owner, contributor } = await team();
      const renamed = await updateTeam(db, owner, { name: "Echo Clean Co" }, 1);
      expect(renamed).toMatchObject({ name: "Echo Clean Co", version: 2 });
      await expect(updateTeam(db, owner, { name: "Stale" }, 1)).rejects.toThrow(ConflictError);
      await expect(updateTeam(db, contributor, { name: "Nope" }, 2)).rejects.toThrow(ForbiddenError);
      await expect(updateTeam(db, owner, { plan: "pro" }, 2)).rejects.toThrow(ForbiddenError);
      await expect(updateTeam(db, owner, { name: " " }, 2)).rejects.toThrow(InvalidInputError);
    });
  });

  describe("Member and user's teams", () => {
    it("authorizes members with their role and home region, and nobody else", async () => {
      const { team: t, owner, viewer } = await team();
      const again = await authorizeTeam(db, owner.userId, t.teamId);
      expect(again).toMatchObject({ teamId: t.teamId, userId: owner.userId, role: "owner", homeRegion: REGION });
      expect((await authorizeTeam(db, viewer.userId, t.teamId)).role).toBe("viewer");
      await expect(authorizeTeam(db, newUser(), t.teamId)).rejects.toThrow(ForbiddenError);
      await expect(authorizeTeam(db, owner.userId, "no-such-team")).rejects.toThrow(ForbiddenError);
      await expect(authorizeTeam(db, owner.userId, "TEAM#x")).rejects.toThrow(InvalidInputError);
    });

    it("lists members and each user's teams for the switcher", async () => {
      const { team: t, owner, contributor, viewer } = await team();
      const members = await listMembers(db, viewer);
      expect(members.map((m) => [m.userId, m.role]).sort()).toEqual(
        [[owner.userId, "owner"], [contributor.userId, "contributor"], [viewer.userId, "viewer"]].sort(),
      );
      const { team: second } = await createTeam(db, { userId: owner.userId }, { name: "Second Co" });
      const mine = await listTeamsForUser(db, owner.userId);
      expect(mine.map((r) => r.teamId).sort()).toEqual([t.teamId, second.teamId].sort());
      expect(mine.find((r) => r.teamId === t.teamId)).toMatchObject({ teamName: "Echo Cleaning", role: "owner" });
    });

    it("changes roles and removes members in both places at once", async () => {
      const { owner, contributor, viewer } = await team();
      await setMemberRole(db, owner, viewer.userId, "contributor");
      expect((await getMember(db, owner, viewer.userId))?.role).toBe("contributor");
      expect((await listTeamsForUser(db, viewer.userId))[0]?.role).toBe("contributor");
      await setMemberRole(db, owner, viewer.userId, "contributor"); // no change, no write
      await expect(setMemberRole(db, contributor, viewer.userId, "owner")).rejects.toThrow(ForbiddenError);
      await expect(setMemberRole(db, owner, newUser(), "viewer")).rejects.toThrow(ConflictError);
      await expect(setMemberRole(db, owner, viewer.userId, "system" as "owner")).rejects.toThrow(InvalidInputError);

      await removeMember(db, owner, viewer.userId);
      expect(await getMember(db, owner, viewer.userId)).toBeUndefined();
      expect(await listTeamsForUser(db, viewer.userId)).toEqual([]);
      await expect(authorizeTeam(db, viewer.userId, owner.teamId)).rejects.toThrow(ForbiddenError);
      await expect(removeMember(db, owner, viewer.userId)).rejects.toThrow(ConflictError);
      // A contributor can leave, but can't remove anyone else
      await expect(removeMember(db, contributor, owner.userId)).rejects.toThrow(ForbiddenError);
      await removeMember(db, contributor, contributor.userId);
      expect((await listMembers(db, owner)).map((m) => m.userId)).toEqual([owner.userId]);
    });
  });

  describe("at least one owner", () => {
    /** The stored owner count, and the owners actually in the team. */
    async function owners(ctx: TeamContext) {
      const meta = await rawItem(db, `TEAM#${ctx.teamId}`, "META");
      const actual = (await listMembers(db, ctx)).filter((m) => m.role === "owner").length;
      return { counted: meta?.owners as number, actual };
    }

    it("keeps the last owner from leaving or demoting themselves", async () => {
      const { owner } = await team();
      expect(await owners(owner)).toEqual({ counted: 1, actual: 1 });
      // DynamoDB's cancellation reasons say which condition failed: the owner count
      await expect(removeMember(db, owner, owner.userId)).rejects.toThrow(LastOwnerError);
      await expect(setMemberRole(db, owner, owner.userId, "contributor")).rejects.toThrow(LastOwnerError);
      expect(await owners(owner)).toEqual({ counted: 1, actual: 1 });
      expect((await getMember(db, owner, owner.userId))?.role).toBe("owner");
    });

    it("counts promotions, demotions, owner invites and removals", async () => {
      const { owner, contributor, viewer } = await team();
      await setMemberRole(db, owner, contributor.userId, "owner");
      expect(await owners(owner)).toEqual({ counted: 2, actual: 2 });
      // With another owner, an owner can demote themselves...
      await setMemberRole(db, owner, owner.userId, "viewer");
      expect(await owners(contributor)).toEqual({ counted: 1, actual: 1 });
      // ...and the one left can't
      const second = await authorizeTeam(db, contributor.userId, contributor.teamId);
      await expect(setMemberRole(db, second, second.userId, "viewer")).rejects.toThrow(ConflictError);
      await expect(removeMember(db, second, second.userId)).rejects.toThrow(ConflictError);

      const { invite, token } = await createInvite(db, second, { email: "co-owner@example.com", role: "owner" });
      const third = await acceptInvite(db, { userId: newUser(), verifiedEmail: "co-owner@example.com" }, invite, token);
      expect(third.role).toBe("owner");
      expect(await owners(second)).toEqual({ counted: 2, actual: 2 });
      await removeMember(db, third, third.userId);
      await removeMember(db, second, viewer.userId);
      expect(await owners(second)).toEqual({ counted: 1, actual: 1 });
    });

    it("refuses an owner acting on a context from before they were demoted", async () => {
      const { owner, contributor, viewer } = await team();
      await setMemberRole(db, owner, contributor.userId, "owner");
      await setMemberRole(db, owner, viewer.userId, "owner");
      const stale = await authorizeTeam(db, contributor.userId, contributor.teamId);
      await setMemberRole(db, owner, stale.userId, "viewer");
      expect(await owners(owner)).toEqual({ counted: 2, actual: 2 });
      // `stale` still says owner and two owners remain, but the write re-checks the caller's MEMBER item
      await expect(removeMember(db, stale, viewer.userId)).rejects.toThrow(ConflictError);
      await expect(setMemberRole(db, stale, viewer.userId, "contributor")).rejects.toThrow(ConflictError);
      // That's someone changing the team, not the last owner
      await expect(removeMember(db, stale, viewer.userId)).rejects.not.toThrow(LastOwnerError);
      expect(await owners(owner)).toEqual({ counted: 2, actual: 2 });
    });

    it("keeps an owner when two owners remove each other at the same time", async () => {
      for (let round = 0; round < 5; round++) {
        const { owner: a, contributor } = await team();
        await setMemberRole(db, a, contributor.userId, "owner");
        const b = await authorizeTeam(db, contributor.userId, contributor.teamId);
        const results = await Promise.allSettled([removeMember(db, a, b.userId), removeMember(db, b, a.userId)]);
        const failed = results.filter((r) => r.status === "rejected");
        // At most one wins; a loser fails with ConflictError, never half-applied
        expect(failed.length).toBeGreaterThanOrEqual(1);
        for (const r of failed) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
        // Whoever wasn't removed can still read the team
        const left = await owners(results[1].status === "fulfilled" ? b : a);
        expect(left.actual).toBeGreaterThanOrEqual(1);
        expect(left.counted).toBe(left.actual);
      }
    });
  });

  describe("member cap", () => {
    /** The stored member count, and the MEMBER items actually in the team. */
    async function members(ctx: TeamContext) {
      const meta = await rawItem(db, `TEAM#${ctx.teamId}`, "META");
      return { counted: meta?.members as number | undefined, actual: (await listMembers(db, ctx)).length };
    }
    const setStatus = (teamId: string, status: string) => rawMeta(db, teamId, "SET #s = :s", { "#s": "status" }, { ":s": status });
    const forgetCount = (teamId: string) => rawMeta(db, teamId, "REMOVE #m", { "#m": "members" });
    let n = 0;
    /** An invite for a new address and the user who'll accept it. */
    async function invited(owner: TeamContext, role: "viewer" | "owner" = "viewer") {
      const email = `cap-${++n}-${owner.teamId.slice(0, 8)}@example.com`;
      const made = await createInvite(db, owner, { email, role });
      return { ...made, user: { userId: newUser(), verifiedEmail: email } };
    }
    const accept = (i: Awaited<ReturnType<typeof invited>>) => acceptInvite(db, i.user, i.invite, i.token);

    it("counts members as they join, are removed and leave", async () => {
      const { owner, contributor, viewer } = await team();
      expect(await members(owner)).toEqual({ counted: 3, actual: 3 });
      await removeMember(db, owner, viewer.userId);
      expect(await members(owner)).toEqual({ counted: 2, actual: 2 });
      await removeMember(db, contributor, contributor.userId);
      expect(await members(owner)).toEqual({ counted: 1, actual: 1 });
      // A refused removal (the last owner) leaves the count alone
      await expect(removeMember(db, owner, owner.userId)).rejects.toThrow(LastOwnerError);
      const joined = await accept(await invited(owner, "owner"));
      expect(await members(owner)).toEqual({ counted: 2, actual: 2 });
      await removeMember(db, owner, joined.userId);
      expect(await members(owner)).toEqual({ counted: 1, actual: 1 });
      expect((await rawItem(db, `TEAM#${owner.teamId}`, "META"))?.owners).toBe(1);
    });

    it(`refuses the ${MEMBERS_PER_TRIAL_TEAM + 1}th member of a trial team, and the invite that would make it`, async () => {
      const { owner } = await team();
      const pending = await Promise.all(Array.from({ length: MEMBERS_PER_TRIAL_TEAM - 3 }, () => invited(owner)));
      // Members and live invites fill the cap: no more invites
      await expect(createInvite(db, owner, { email: "eleventh@example.com", role: "viewer" })).rejects.toThrow(TeamFullError);
      for (const i of pending) await accept(i);
      expect(await members(owner)).toEqual({ counted: MEMBERS_PER_TRIAL_TEAM, actual: MEMBERS_PER_TRIAL_TEAM });
      await expect(createInvite(db, owner, { email: "eleventh@example.com", role: "viewer" })).rejects.toThrow(TeamFullError);

      // An invite from before the team filled up (a paid team that lapsed) is refused at accept, and kept
      await setStatus(owner.teamId, "active");
      const late = await invited(owner);
      await setStatus(owner.teamId, "canceled");
      await expect(accept(late)).rejects.toThrow(TeamFullError);
      expect(await findInvite(db, late.token)).toMatchObject({ inviteId: late.invite.inviteId });
      expect(await members(owner)).toEqual({ counted: MEMBERS_PER_TRIAL_TEAM, actual: MEMBERS_PER_TRIAL_TEAM });
      // Once someone leaves there's room, and the same invite works
      const [someone] = (await listMembers(db, owner)).filter((m) => m.role === "viewer");
      await removeMember(db, owner, someone?.userId as string);
      await accept(late);
      expect(await members(owner)).toEqual({ counted: MEMBERS_PER_TRIAL_TEAM, actual: MEMBERS_PER_TRIAL_TEAM });
    });

    it(`lets a paying team have ${MEMBERS_PER_TEAM} members`, async () => {
      const { owner } = await team();
      await setStatus(owner.teamId, "active");
      // Past the trial cap, and the count is what the write checks: set it near the paid cap
      for (let i = 0; i < 2; i++) await accept(await invited(owner));
      expect(await members(owner)).toEqual({ counted: 5, actual: 5 });
      await rawMeta(db, owner.teamId, "SET #m = :m", { "#m": "members" }, { ":m": MEMBERS_PER_TEAM - 1 });
      const [last, over] = [await invited(owner), await invited(owner)];
      await accept(last);
      await expect(accept(over)).rejects.toThrow(TeamFullError);
      expect((await members(owner)).counted).toBe(MEMBERS_PER_TEAM);
    });

    it("lets only one of two people accepting for the last place join", async () => {
      for (let round = 0; round < 5; round++) {
        const { owner } = await team();
        // Invites made while the team was paying; then it's back on the trial cap with one place left
        await setStatus(owner.teamId, "active");
        // Three members already, two racers, and enough others to leave one place
        const invites = await Promise.all(Array.from({ length: MEMBERS_PER_TRIAL_TEAM - 2 }, () => invited(owner)));
        for (const i of invites.slice(2)) await accept(i);
        await setStatus(owner.teamId, "trialing");
        expect(await members(owner)).toEqual({ counted: MEMBERS_PER_TRIAL_TEAM - 1, actual: MEMBERS_PER_TRIAL_TEAM - 1 });

        const results = await Promise.allSettled([accept(invites[0] as never), accept(invites[1] as never)]);
        const joined = results.filter((r) => r.status === "fulfilled");
        const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        expect(joined).toHaveLength(1);
        // The loser failed the count's condition, or lost the race for the item: never half-applied
        expect(refused).toHaveLength(1);
        expect(refused[0]?.reason).toBeInstanceOf(refused[0]?.reason instanceof TeamFullError ? TeamFullError : ConflictError);
        expect(await members(owner)).toEqual({ counted: MEMBERS_PER_TRIAL_TEAM, actual: MEMBERS_PER_TRIAL_TEAM });
      }
    });

    it("sets the count on a team from before it, on the next change, and keeps it right when two changes race", async () => {
      const { owner, contributor, viewer } = await team();
      await forgetCount(owner.teamId);
      expect(await members(owner)).toEqual({ counted: undefined, actual: 3 });
      await removeMember(db, owner, viewer.userId);
      expect(await members(owner)).toEqual({ counted: 2, actual: 2 });

      await forgetCount(owner.teamId);
      await accept(await invited(owner));
      expect(await members(owner)).toEqual({ counted: 3, actual: 3 });

      // The last owner still can't leave a team without a count
      await forgetCount(owner.teamId);
      await expect(removeMember(db, owner, owner.userId)).rejects.toThrow(LastOwnerError);
      // A full team without a count is still full
      await setStatus(owner.teamId, "active");
      const more = await Promise.all(Array.from({ length: MEMBERS_PER_TRIAL_TEAM - 3 + 1 }, () => invited(owner)));
      await setStatus(owner.teamId, "trialing");
      for (const i of more.slice(1)) await accept(i);
      await forgetCount(owner.teamId);
      await expect(accept(more[0] as never)).rejects.toThrow(TeamFullError);

      // Two changes that both find no count: one sets it, the other must retry
      await removeMember(db, owner, contributor.userId);
      for (const m of (await listMembers(db, owner)).filter((x) => x.role === "viewer").slice(0, 4)) await removeMember(db, owner, m.userId);
      for (let round = 0; round < 3; round++) {
        await forgetCount(owner.teamId);
        const [a, b] = [await invited(owner), await invited(owner)];
        const results = await Promise.allSettled([accept(a), accept(b)]);
        for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ConflictError);
        const now = await members(owner);
        expect(now.counted).toBe(now.actual);
        // Make room again for the next round
        for (const m of (await listMembers(db, owner)).filter((x) => x.role === "viewer").slice(0, 2)) await removeMember(db, owner, m.userId);
      }
    });
  });

  describe("Invite", () => {
    it("stores only the token's hash, finds the invite by it, and works once", async () => {
      const { owner } = await team();
      const { invite, token } = await createInvite(db, owner, { email: "New@Example.com", role: "viewer" });
      const stored = await rawItem(db, `TEAM#${owner.teamId}`, `INVITE#${invite.inviteId}`);
      expect(JSON.stringify(stored)).not.toContain(token);
      expect(stored).toMatchObject({ email: "new@example.com", GSI1SK: "INVITE" });
      expect(stored?.expiresAt).toBeGreaterThan(Date.now() / 1000);
      expect((await listInvites(db, owner)).map((i) => i.inviteId)).toEqual([invite.inviteId]);
      expect(await findInvite(db, token)).toMatchObject({ inviteId: invite.inviteId, teamId: owner.teamId });

      const userId = newUser();
      const found = (await findInvite(db, token)) as Invite;
      const joined = await acceptInvite(db, { userId, verifiedEmail: "NEW@example.com" }, found, token);
      expect(joined).toMatchObject({ teamId: owner.teamId, role: "viewer" });
      expect(await getMember(db, owner, userId)).toMatchObject({ role: "viewer", email: "new@example.com" });
      expect(await listInvites(db, owner)).toEqual([]);
      expect(await findInvite(db, token)).toBeUndefined();
      await expect(acceptInvite(db, { userId: newUser(), verifiedEmail: "new@example.com" }, found, token)).rejects.toThrow(NotFoundError);
    });

    it("is listed and found by the invitee's verified email, across teams", async () => {
      const { owner: a } = await team("Alpha Co");
      const { owner: b } = await team("Bravo Co");
      const fromA = await createInvite(db, a, { email: "Pat@Example.com", role: "contributor" });
      const fromB = await createInvite(db, b, { email: "pat@example.com", role: "viewer" });
      await createInvite(db, b, { email: "someone@example.com", role: "viewer" });
      expect(await rawItem(db, `TEAM#${a.teamId}`, `INVITE#${fromA.invite.inviteId}`)).toMatchObject({ GSI2SK: `INVITE#${fromA.invite.inviteId}` });
      const mine = await listInvitesForEmail(db, " PAT@example.com ");
      expect(mine.map((i) => [i.teamName, i.role]).sort()).toEqual([["Alpha Co", "contributor"], ["Bravo Co", "viewer"]]);
      expect(mine.every((i) => !("GSI2PK" in i) && !("PK" in i))).toBe(true);
      expect(await findInviteForEmail(db, "pat@example.com", fromB.invite.inviteId)).toMatchObject({ teamId: b.teamId });
      // Another address can't see or find them
      expect(await listInvitesForEmail(db, "mallory@example.com")).toEqual([]);
      expect(await findInviteForEmail(db, "mallory@example.com", fromB.invite.inviteId)).toBeUndefined();
      // Expired ones are left out even before TTL removes them
      const later = new Date(Date.now() + 8 * 86400_000);
      expect(await listInvitesForEmail(db, "pat@example.com", later)).toEqual([]);
      expect(await findInviteForEmail(db, "pat@example.com", fromB.invite.inviteId, later)).toBeUndefined();
    });

    it("is accepted only with the invited email and the link's token, before it expires, and once", async () => {
      // An address no other test in this file (and so this table) invites
      const { owner } = await team();
      const { invite, token } = await createInvite(db, owner, { email: "quinn@example.com", role: "viewer", ttlDays: 1 });
      // Another team's invite to the same address
      const { owner: elsewhere } = await team("Elsewhere Co");
      const other = await createInvite(db, elsewhere, { email: "quinn@example.com", role: "viewer" });
      const pat = newUser();
      const as = (verifiedEmail: string) => ({ userId: pat, verifiedEmail });
      await expect(acceptInvite(db, as("mallory@example.com"), invite, token)).rejects.toThrow(ForbiddenError);
      // A forged invite object naming another address still has to match the stored item
      await expect(acceptInvite(db, as("mallory@example.com"), { ...invite, email: "mallory@example.com" }, token)).rejects.toThrow(NotFoundError);
      // The right address, but no token, a wrong one, or another invite's
      for (const wrong of ["", "short", "x".repeat(43), other.token]) {
        await expect(acceptInvite(db, as("quinn@example.com"), invite, wrong), wrong).rejects.toThrow(NotFoundError);
      }
      await expect(acceptInvite(db, as("quinn@example.com"), invite, token, new Date(Date.now() + 2 * 86400_000))).rejects.toThrow(NotFoundError);
      await expect(acceptInvite(db, as("quinn@example.com"), { ...invite, role: "owner" }, token)).rejects.toThrow(NotFoundError);
      await expect(authorizeTeam(db, pat, owner.teamId)).rejects.toThrow(ForbiddenError);
      expect(await acceptInvite(db, as("quinn@example.com"), invite, token)).toMatchObject({ teamId: owner.teamId, role: "viewer" });
      expect((await listInvitesForEmail(db, "quinn@example.com")).map((i) => i.inviteId)).toEqual([other.invite.inviteId]);
      await expect(acceptInvite(db, { userId: newUser(), verifiedEmail: "quinn@example.com" }, invite, token)).rejects.toThrow(NotFoundError);
    });

    it("matches addresses after NFKC, so a Kelvin sign is a K", async () => {
      const { owner } = await team();
      // U+212A KELVIN SIGN, which NFKC folds to a plain K
      const { invite, token } = await createInvite(db, owner, { email: "\u212Aelvin@example.com", role: "viewer" });
      expect(invite.email).toBe("kelvin@example.com");
      expect((await listInvitesForEmail(db, "KELVIN@example.com")).map((i) => i.inviteId)).toEqual([invite.inviteId]);
      expect(await acceptInvite(db, { userId: newUser(), verifiedEmail: "Kelvin@example.com" }, invite, token)).toMatchObject({ teamId: owner.teamId });
    });

    it("stops at the most teams one account can be in", async () => {
      db = table.db;
      const userId = newUser();
      const day = (i: number) => new Date(Date.UTC(2026, 0, 1 + Math.floor(i / TEAMS_PER_USER_PER_DAY), 12));
      for (let i = 0; i < MAX_TEAMS_PER_USER; i++) await createTeam(db, { userId }, { name: `Team ${i}`, requestKey: `cap-key-${i}` }, day(i));
      const later = day(MAX_TEAMS_PER_USER + TEAMS_PER_USER_PER_DAY);
      await expect(createTeam(db, { userId }, { name: "One more", requestKey: "cap-key-x" }, later)).rejects.toThrow(LimitReachedError);
      // A replay of one they already made still answers
      expect((await createTeam(db, { userId }, { name: "Team 0", requestKey: "cap-key-0" }, later)).created).toBe(false);
      const { owner } = await team();
      const { invite, token } = await createInvite(db, owner, { email: "busy@example.com", role: "viewer" });
      await expect(acceptInvite(db, { userId, verifiedEmail: "busy@example.com" }, invite, token)).rejects.toThrow(LimitReachedError);
    });

    it("ignores expired, revoked and unknown tokens, and only owners invite", async () => {
      const { owner, contributor } = await team();
      const expiring = await createInvite(db, owner, { email: "a@example.com", role: "viewer", ttlDays: 1 });
      expect(await findInvite(db, expiring.token)).toBeDefined();
      expect(await findInvite(db, expiring.token, new Date(Date.now() + 2 * 86400_000))).toBeUndefined();
      const revoked = await createInvite(db, owner, { email: "b@example.com", role: "viewer" });
      await revokeInvite(db, owner, revoked.invite.inviteId);
      expect(await findInvite(db, revoked.token)).toBeUndefined();
      expect(await findInvite(db, "short")).toBeUndefined();
      expect(await findInvite(db, "x".repeat(43))).toBeUndefined();
      await expect(createInvite(db, contributor, { email: "c@example.com", role: "viewer" })).rejects.toThrow(ForbiddenError);
      await expect(createInvite(db, owner, { email: "not-an-email", role: "viewer" })).rejects.toThrow(InvalidInputError);
      await expect(createInvite(db, owner, { email: "d@example.com", role: "system" as "viewer" })).rejects.toThrow(InvalidInputError);
    });

    it("lasts 1 to 30 days, and takes the team name from the team", async () => {
      const { owner } = await team("Stored Name Co");
      for (const ttlDays of [0, -1, 31, 1.5, Number.NaN]) {
        await expect(createInvite(db, owner, { email: "e@example.com", role: "viewer", ttlDays })).rejects.toThrow(InvalidInputError);
      }
      const now = Date.now() / 1000;
      const month = await createInvite(db, owner, { email: "e@example.com", role: "viewer", ttlDays: 30 });
      expect(month.invite.expiresAt).toBeGreaterThanOrEqual(Math.floor(now) + 30 * 86400);
      expect(month.invite.expiresAt).toBeLessThanOrEqual(Math.ceil(now) + 30 * 86400 + 5);
      const week = await createInvite(db, owner, { email: "f@example.com", role: "viewer" });
      expect(week.invite.expiresAt - Math.floor(now)).toBeLessThanOrEqual(7 * 86400 + 5);
      // A caller-supplied name is ignored: the type doesn't take one, and the stored team's name is used
      const spoofed = await createInvite(db, owner, { email: "g@example.com", role: "viewer", teamName: "Evil Co" } as Parameters<typeof createInvite>[2]);
      expect(spoofed.invite.teamName).toBe("Stored Name Co");
      expect(await findInvite(db, spoofed.token)).toMatchObject({ teamName: "Stored Name Co" });
    });

    it("rejects an invite for someone who is already a member", async () => {
      const { owner, viewer } = await team();
      const { invite, token } = await createInvite(db, owner, { email: "v@example.com", role: "contributor" });
      await expect(acceptInvite(db, { userId: viewer.userId, verifiedEmail: "v@example.com" }, invite, token)).rejects.toThrow(ConflictError);
      // The failed transaction left the invite in place
      expect(await findInvite(db, token)).toBeDefined();
    });
    it("is marked failed when its email bounces, for its own address only, and owners see it", async () => {
      const { team: t, owner } = await team();
      const { invite, token } = await createInvite(db, owner, { email: "bounce@example.com", role: "viewer" });
      const system = await teamContextForEmailEvent(db, t.teamId);
      if (!system) throw new Error("no context");
      const at = new Date("2026-09-27T08:00:00.000Z");
      // Another address's bounce, or an invite that's gone, changes nothing
      expect(await markInviteFailed(db, system, { inviteId: invite.inviteId, emailHash: hashEmail("other@example.com"), reason: "bounced", at })).toBe(false);
      expect(await markInviteFailed(db, system, { inviteId: "no-such-invite", emailHash: hashEmail("bounce@example.com"), reason: "bounced", at })).toBe(false);
      expect(await markInviteFailed(db, system, { inviteId: invite.inviteId, emailHash: hashEmail("bounce@example.com"), reason: "bounced", at })).toBe(true);
      const listed = (await listInvites(db, owner)).find((i) => i.inviteId === invite.inviteId);
      expect(listed).toMatchObject({ inviteStatus: "failed", failureReason: "bounced", failedAt: at.toISOString() });
      await expect(markInviteFailed(db, owner, { inviteId: invite.inviteId, emailHash: hashEmail("bounce@example.com"), reason: "bounced", at })).rejects.toThrow(ForbiddenError);
      // A failed invite keeps its keys, so it can still be revoked
      expect(await findInvite(db, token)).toBeDefined();
      await revokeInvite(db, owner, invite.inviteId);
      expect(await markInviteFailed(db, system, { inviteId: invite.inviteId, emailHash: hashEmail("bounce@example.com"), reason: "complained", at })).toBe(false);
      expect(await rawItem(db, `TEAM#${t.teamId}`, `INVITE#${invite.inviteId}`)).toBeUndefined();
    });
  });

  describe("Invite limits and re-sending", () => {
    it("re-sends with a new ID and token, the same address and role, and no failure", async () => {
      const { team: t, owner, contributor } = await team();
      const first = await createInvite(db, owner, { email: "resend@example.com", role: "contributor" });
      const system = await teamContextForEmailEvent(db, t.teamId);
      if (!system) throw new Error("no context");
      await markInviteFailed(db, system, { inviteId: first.invite.inviteId, emailHash: hashEmail("resend@example.com"), reason: "bounced", at: new Date() });
      await expect(resendInvite(db, contributor, first.invite.inviteId)).rejects.toThrow(ForbiddenError);
      const again = await resendInvite(db, owner, first.invite.inviteId);
      expect(again.invite).toMatchObject({ email: "resend@example.com", role: "contributor", teamId: t.teamId });
      expect(again.invite.inviteId).not.toBe(first.invite.inviteId);
      expect(again.token).not.toBe(first.token);
      expect(await rawItem(db, `TEAM#${t.teamId}`, `INVITE#${first.invite.inviteId}`)).toBeUndefined();
      const stored = await rawItem(db, `TEAM#${t.teamId}`, `INVITE#${again.invite.inviteId}`);
      expect(stored).not.toHaveProperty("inviteStatus");
      expect(stored).not.toHaveProperty("failureReason");
      expect(stored).not.toHaveProperty("failedAt");
      expect(await getInvite(db, owner, again.invite.inviteId)).toMatchObject({ inviteId: again.invite.inviteId });
      expect(await getInvite(db, owner, first.invite.inviteId)).toBeUndefined();
      // A late bounce for the first message names the old ID, so it changes nothing
      expect(await markInviteFailed(db, system, { inviteId: first.invite.inviteId, emailHash: hashEmail("resend@example.com"), reason: "bounced", at: new Date() })).toBe(false);
      expect(await findInvite(db, first.token)).toBeUndefined();
      expect(await findInvite(db, again.token)).toMatchObject({ inviteId: again.invite.inviteId });
      await expect(resendInvite(db, owner, first.invite.inviteId)).rejects.toThrow(NotFoundError);
      // Not sent: owners mark it, and see it
      await expect(markInviteNotSent(db, contributor, again.invite.inviteId)).rejects.toThrow(ForbiddenError);
      expect(await markInviteNotSent(db, owner, again.invite.inviteId, new Date("2026-09-26T12:00:00.000Z"))).toBe(true);
      expect(await getInvite(db, owner, again.invite.inviteId)).toMatchObject({ inviteStatus: "failed", failureReason: "not_sent", failedAt: "2026-09-26T12:00:00.000Z" });
      expect(await markInviteNotSent(db, owner, "no-such-invite")).toBe(false);
    });

    it("refuses a member's address and a second live invite to one address", async () => {
      const { owner } = await team();
      const members = await listMembers(db, owner);
      const viewerEmail = members.find((m) => m.role === "viewer")?.email as string;
      await expect(createInvite(db, owner, { email: viewerEmail.toUpperCase(), role: "owner" })).rejects.toThrow(ConflictError);
      await createInvite(db, owner, { email: "twice@example.com", role: "viewer" });
      await expect(createInvite(db, owner, { email: "Twice@example.com", role: "owner" })).rejects.toThrow(ConflictError);
      // After it expires, a new one is fine
      expect((await createInvite(db, owner, { email: "twice@example.com", role: "viewer" }, new Date(Date.now() + 8 * 86400_000))).invite.email).toBe("twice@example.com");
    });

    it(`stops a team at ${INVITES_PER_TEAM_PER_DAY} invites a UTC day, re-sends included`, async () => {
      const { owner } = await team();
      // A paying team: a trial team's member cap is below the day's invite limit
      await rawMeta(db, owner.teamId, "SET #s = :s", { "#s": "status" }, { ":s": "active" });
      const day = new Date("2031-01-01T10:00:00.000Z");
      let last: Awaited<ReturnType<typeof createInvite>> | undefined;
      for (let i = 0; i < INVITES_PER_TEAM_PER_DAY; i++) last = await createInvite(db, owner, { email: `team-limit-${i}@example.com`, role: "viewer" }, day);
      await expect(createInvite(db, owner, { email: "team-limit-x@example.com", role: "viewer" }, day)).rejects.toThrow(LimitReachedError);
      await expect(resendInvite(db, owner, (last as { invite: Invite }).invite.inviteId, {}, day)).rejects.toThrow(LimitReachedError);
      // The refused re-send left the invite as it was
      expect(await getInvite(db, owner, (last as { invite: Invite }).invite.inviteId)).toBeDefined();
      expect((await listInvites(db, owner)).length).toBe(INVITES_PER_TEAM_PER_DAY);
      expect(await rawItem(db, `TEAM#${owner.teamId}`, "LIMIT#INVITES#2031-01-01")).toMatchObject({ count: INVITES_PER_TEAM_PER_DAY, expiresAt: day.getTime() / 1000 + 2 * 86400 });
      await createInvite(db, owner, { email: "team-limit-x@example.com", role: "viewer" }, new Date("2031-01-02T00:00:00.000Z"));
    });

    it(`caps one team at ${INVITES_PER_TEAM_ADDRESS_PER_DAY} invites to an address a day, and all teams at ${INVITES_PER_ADDRESS_PER_DAY}`, async () => {
      const count = INVITES_PER_ADDRESS_PER_DAY / INVITES_PER_TEAM_ADDRESS_PER_DAY;
      const owners = (await Promise.all(Array.from({ length: count + 1 }, (_, i) => team(`Limit ${i}`)))).map((x) => x.owner);
      const day = new Date("2031-02-01T10:00:00.000Z");
      for (const [i, owner] of owners.slice(0, count).entries()) {
        // A +tag is the same mailbox, for the limits
        let current = await createInvite(db, owner, { email: i % 2 ? "flooded+x@example.com" : "flooded@example.com", role: "viewer" }, day);
        for (let n = 1; n < INVITES_PER_TEAM_ADDRESS_PER_DAY; n++) current = await resendInvite(db, owner, current.invite.inviteId, {}, day);
        if (i === 0) await expect(resendInvite(db, owner, current.invite.inviteId, {}, day)).rejects.toThrow(LimitReachedError);
      }
      const last = owners[count] as TeamContext;
      await expect(createInvite(db, last, { email: "FLOODED@example.com", role: "viewer" }, day)).rejects.toThrow(LimitReachedError);
      expect(await rawItem(db, `INVITELIMIT#${inviteLimitKey("flooded@example.com")}`, "LIMIT#INVITES#2031-02-01")).toMatchObject({ count: INVITES_PER_ADDRESS_PER_DAY });
      expect(await listInvites(db, last)).toEqual([]);
      expect((await createInvite(db, last, { email: "flooded@example.com", role: "viewer" }, new Date("2031-02-02T10:00:00.000Z"))).invite.email).toBe("flooded@example.com");
    });

    it("revokes a removed member's other invites to the team, and only theirs", async () => {
      const { owner, contributor } = await team();
      const member = (await getMember(db, owner, contributor.userId)) as { email: string };
      // An invite for their address that they hadn't used (made before they joined)
      const { invite: spare, token } = await createInvite(db, owner, { email: "spare@example.com", role: "owner" });
      await connectionPut(db, { ...(await rawItem(db, `TEAM#${owner.teamId}`, `INVITE#${spare.inviteId}`)), email: member.email });
      const keep = await createInvite(db, owner, { email: "keep@example.com", role: "viewer" });
      await removeMember(db, owner, contributor.userId);
      expect(await getInvite(db, owner, spare.inviteId)).toBeUndefined();
      expect(await findInvite(db, token)).toBeUndefined();
      expect(await getInvite(db, owner, keep.invite.inviteId)).toBeDefined();
    });
  });

  describe("Product", () => {
    it("is created, listed, read, edited with a version check, and deleted", async () => {
      const { owner, contributor, viewer } = await team();
      const created = await createProduct(db, contributor, "0123456789", { code: "0123456789", name: "Glass cleaner", price: 4.5 }, 3);
      expect(created).toMatchObject({ key: "0123456789", stock: 3, version: 1 });
      await expect(createProduct(db, contributor, "0123456789", { code: "", name: "Dup", price: 1 })).rejects.toThrow(ConflictError);
      await createProduct(db, owner, "no-barcode-sponge", { code: "", name: "Sponge", price: 1 });
      expect((await listProducts(db, viewer)).map((p) => p.key).sort()).toEqual(["0123456789", "no-barcode-sponge"]);

      const edited = await updateProduct(db, contributor, "0123456789", { code: "0123456789", name: "Glass cleaner 1L", price: 5 }, 1);
      expect(edited).toMatchObject({ name: "Glass cleaner 1L", price: 5, stock: 3, version: 2 });
      await expect(updateProduct(db, contributor, "0123456789", { code: "", name: "Stale", price: 5 }, 1)).rejects.toThrow(ConflictError);
      await expect(updateProduct(db, contributor, "missing", { code: "", name: "x", price: 5 }, 1)).rejects.toThrow(ConflictError);
      await expect(updateProduct(db, viewer, "0123456789", { code: "", name: "x", price: 5 }, 2)).rejects.toThrow(ForbiddenError);
      await expect(createProduct(db, contributor, "bad", { code: "", name: "x", price: -1 })).rejects.toThrow(InvalidInputError);
      await expect(createProduct(db, contributor, "bad", { code: "1".repeat(257), name: "x", price: 1 })).rejects.toThrow(InvalidInputError);
      await expect(createProduct(db, contributor, "bad", { code: 123 as unknown as string, name: "x", price: 1 })).rejects.toThrow(InvalidInputError);

      await expect(deleteProduct(db, contributor, "0123456789", 1)).rejects.toThrow(ConflictError);
      await deleteProduct(db, contributor, "0123456789", 2);
      await deleteProduct(db, contributor, "no-barcode-sponge");
      expect(await getProduct(db, viewer, "0123456789")).toBeUndefined();
    });

    it("changes stock only by atomic ADD, which never conflicts with an edit", async () => {
      const { contributor } = await team();
      await createProduct(db, contributor, "towels", { code: "", name: "Towels", price: 2 }, 10);
      // Ten checkouts at once all land: no lost updates
      await Promise.all(Array.from({ length: 10 }, () => adjustStock(db, contributor, "towels", -1)));
      expect((await getProduct(db, contributor, "towels"))?.stock).toBe(0);
      expect(await adjustStock(db, contributor, "towels", 4)).toBe(4);
      // Every stock change is a new version, so an edit opened before the count changes conflicts
      await expect(updateProduct(db, contributor, "towels", { code: "", name: "Bath towels", price: 2 }, 1)).rejects.toThrow(ConflictError);
      expect(await updateProduct(db, contributor, "towels", { code: "", name: "Bath towels", price: 2 }, 12)).toMatchObject({ stock: 4, version: 13 });
      await expect(adjustStock(db, contributor, "missing", 1)).rejects.toThrow(ConflictError);
      await expect(adjustStock(db, contributor, "towels", 0.5)).rejects.toThrow(InvalidInputError);
    });
  });

  describe("Sheet", () => {
    const line = (out: number, returned = 0) => ({ name: "Towels", price: 2, out, returned });

    it("keeps every field the app writes: each line's barcode, the preparer's name and the receipt", async () => {
      const { contributor, viewer } = await team();
      const gloves = { code: "0123456789", name: "Gloves", price: 12.5, out: 3, returned: 0 };
      const rags = { code: "", name: "Rags", price: 1, out: 1, returned: 0 };
      const sheet = await createSheet(db, contributor, {
        client: "Smith house",
        date: "2026-09-25",
        createdByName: "Dana",
        source: { store: "Hardware Co", receiptDate: "2026-09-24" },
        items: { "0123456789": gloves, "nb-1": rags },
      });
      let s = await getSheet(db, viewer, sheet.id);
      expect(s).toMatchObject({ createdByName: "Dana", source: { store: "Hardware Co", receiptDate: "2026-09-24" }, items: { "0123456789": gloves, "nb-1": rags } });
      s = await setSheetLine(db, contributor, sheet.id, "0123456789", { ...gloves, returned: 2 }, 1);
      expect(s.items["0123456789"]).toEqual({ ...gloves, returned: 2 });
      expect((await getSheet(db, viewer, sheet.id))?.items["0123456789"]?.code).toBe("0123456789");

      const long = { ...gloves, code: "1".repeat(257) };
      await expect(setSheetLine(db, contributor, sheet.id, "x", long, s.version)).rejects.toThrow(InvalidInputError);
      await expect(setSheetLine(db, contributor, sheet.id, "x", { ...gloves, code: 5 as unknown as string }, s.version)).rejects.toThrow(InvalidInputError);
      expect((await setSheetLine(db, contributor, sheet.id, "x", { ...gloves, code: "1".repeat(256) }, s.version)).items.x?.code).toHaveLength(256);
      // A line's cost each (ADR 0014) is kept, and has to be an amount in whole cents
      s = await setSheetLine(db, contributor, sheet.id, "x", { ...gloves, cost: 9.99 }, s.version + 1);
      expect(s.items.x).toEqual({ ...gloves, cost: 9.99 });
      const costed = await createSheet(db, contributor, { client: "x", date: "2026-09-25", items: { a: { ...rags, cost: 0 } } });
      expect((await getSheet(db, viewer, costed.id))?.items.a).toEqual({ ...rags, cost: 0 });
      for (const cost of [-0.01, Number.NaN, "1" as unknown as number, 1.234, 1_000_001]) {
        await expect(setSheetLine(db, contributor, sheet.id, "x", { ...gloves, cost }, s.version)).rejects.toThrow(InvalidInputError);
        await expect(createSheet(db, contributor, { client: "x", date: "2026-09-25", items: { a: { ...rags, cost } } })).rejects.toThrow(InvalidInputError);
      }
      await expect(createSheet(db, contributor, { client: "x", date: "2026-09-25", source: null as unknown as { store: string; receiptDate: string } })).rejects.toThrow(InvalidInputError);
      await expect(createSheet(db, contributor, { client: "x", date: "2026-09-25", source: { store: 1 as unknown as string, receiptDate: "" } })).rejects.toThrow(InvalidInputError);
      await expect(createSheet(db, contributor, { client: "x", date: "2026-09-25", createdByName: "x".repeat(201) })).rejects.toThrow(InvalidInputError);
    });

    it("is keyed by an immutable ID and read by ID alone", async () => {
      const { contributor, viewer } = await team();
      const sheet = await createSheet(db, contributor, { client: "Smith house", date: "2026-09-25", items: { towels: line(2) } });
      const stored = await rawItem(db, `TEAM#${contributor.teamId}`, `SHEET#${sheet.id}`);
      expect(stored).toMatchObject({ GSI1PK: `TEAM#${contributor.teamId}#SHEETS`, GSI1SK: `2026-09-25#${sheet.id}`, status: "open", createdBy: contributor.userId });
      expect(await getSheet(db, viewer, sheet.id)).toMatchObject({ id: sheet.id, client: "Smith house", items: { towels: line(2) }, version: 1 });
      await expect(createSheet(db, viewer, { client: "x", date: "2026-09-25" })).rejects.toThrow(ForbiddenError);
      await expect(createSheet(db, contributor, { client: "x", date: "Sept 25" })).rejects.toThrow(InvalidInputError);
      await expect(createSheet(db, contributor, { client: "x", date: "2026-09-25", items: { t: line(1, 2) } })).rejects.toThrow(InvalidInputError);
    });

    it("changes date in one update, keeping its ID, lines and place in date order", async () => {
      const { contributor, viewer } = await team();
      const a = await createSheet(db, contributor, { client: "A", date: "2026-09-01" });
      const b = await createSheet(db, contributor, { client: "B", date: "2026-09-10" });
      const c = await createSheet(db, contributor, { client: "C", date: "2026-09-20", items: { towels: line(1) } });
      const moved = await updateSheet(db, contributor, c.id, { date: "2026-08-15", client: "C (moved)" }, 1);
      expect(moved).toMatchObject({ id: c.id, date: "2026-08-15", client: "C (moved)", items: { towels: line(1) }, version: 2 });
      expect(await getSheet(db, viewer, c.id)).toMatchObject({ date: "2026-08-15" });

      const newestFirst = await listSheetsByDate(db, viewer);
      expect(newestFirst.items.map((s) => s.id)).toEqual([b.id, a.id, c.id]);
      const oldestFirst = await listSheetsByDate(db, viewer, { oldestFirst: true });
      expect(oldestFirst.items.map((s) => s.id)).toEqual([c.id, a.id, b.id]);
      const september = await listSheetsByDate(db, viewer, { from: "2026-09-01", to: "2026-09-30" });
      expect(september.items.map((s) => s.id)).toEqual([b.id, a.id]);
      expect((await listSheetsByDate(db, viewer, { from: "2026-09-05" })).items.map((s) => s.id)).toEqual([b.id]);

      // Pages follow on with the cursor
      const first = await listSheetsByDate(db, viewer, { limit: 2 });
      expect(first.items).toHaveLength(2);
      const rest = await listSheetsByDate(db, viewer, { limit: 2, cursor: first.cursor });
      expect([...first.items, ...rest.items].map((s) => s.id)).toEqual([b.id, a.id, c.id]);
      expect(rest.cursor).toBeUndefined();

      expect((await listSheets(db, viewer)).map((s) => s.id).sort()).toEqual([a.id, b.id, c.id].sort());
    });

    it("sets, returns and removes lines, closes and reopens, with a version check on each", async () => {
      const { contributor } = await team();
      const sheet = await createSheet(db, contributor, { client: "Smith house", date: "2026-09-25" });
      let s = await setSheetLine(db, contributor, sheet.id, "towels", line(3), 1);
      s = await setSheetLine(db, contributor, sheet.id, "glass cleaner #2", { name: "Glass", price: 4, out: 1, returned: 0 }, s.version);
      s = await setSheetLine(db, contributor, sheet.id, "towels", line(3, 2), s.version);
      expect(s.items).toEqual({ towels: line(3, 2), "glass cleaner #2": { name: "Glass", price: 4, out: 1, returned: 0 } });
      await expect(setSheetLine(db, contributor, sheet.id, "towels", line(4), 1)).rejects.toThrow(ConflictError);

      s = await removeSheetLine(db, contributor, sheet.id, "glass cleaner #2", s.version);
      expect(Object.keys(s.items)).toEqual(["towels"]);

      s = await updateSheet(db, contributor, sheet.id, { status: "closed" }, s.version);
      expect(s.status).toBe("closed");
      expect(s.closedAt).toBeTruthy();
      s = await updateSheet(db, contributor, sheet.id, { status: "open", createdByName: "Dana" }, s.version);
      expect(s).toMatchObject({ status: "open", createdByName: "Dana" });
      await expect(updateSheet(db, contributor, sheet.id, { status: "lost" as "open" }, s.version)).rejects.toThrow(InvalidInputError);

      await expect(deleteSheet(db, contributor, sheet.id, 1)).rejects.toThrow(ConflictError);
      await deleteSheet(db, contributor, sheet.id, s.version);
      expect(await getSheet(db, contributor, sheet.id)).toBeUndefined();
      const other = await createSheet(db, contributor, { client: "x", date: "2026-09-26" });
      await deleteSheet(db, contributor, other.id);
      expect(await listSheets(db, contributor)).toEqual([]);
    });
  });

  describe("Receipt usage", () => {
    it("counts atomically per month and stops at the limit", async () => {
      const { contributor, viewer } = await team();
      const counts = await Promise.all(Array.from({ length: 5 }, () => recordReceiptRead(db, contributor, "2026-09", 5)));
      expect(counts.sort()).toEqual([1, 2, 3, 4, 5]);
      await expect(recordReceiptRead(db, contributor, "2026-09", 5)).rejects.toThrow(LimitReachedError);
      expect(await getReceiptUsage(db, viewer, "2026-09")).toBe(5);
      expect(await getReceiptUsage(db, viewer, "2026-10")).toBe(0);
      expect(await recordReceiptRead(db, contributor, "2026-10", 5)).toBe(1);
      await expect(recordReceiptRead(db, viewer, "2026-10", 5)).rejects.toThrow(ForbiddenError);
      await expect(recordReceiptRead(db, contributor, "2026-10", -1)).rejects.toThrow(InvalidInputError);
    });
  });

  describe("Audit event", () => {
    it("records who did what, with a TTL, and lists newest first for owners", async () => {
      const { owner, viewer } = await team();
      const t0 = new Date("2026-09-25T10:00:00Z");
      await recordAudit(db, owner, { action: "sheet.create", target: "s1" }, t0);
      await recordAudit(db, viewer, { action: "sheet.export", target: "s1" }, new Date(t0.getTime() + 1000));
      const latest = await recordAudit(db, owner, { action: "product.delete", target: "p1", detail: { name: "Towels" } }, new Date(t0.getTime() + 2000));
      expect(latest.expiresAt).toBe(Math.floor(t0.getTime() / 1000) + 2 + 365 * 86400);

      const page1 = await listAudit(db, owner, { limit: 2 });
      expect(page1.items.map((e) => e.action)).toEqual(["product.delete", "sheet.export"]);
      expect(page1.items[1]?.userId).toBe(viewer.userId);
      const page2 = await listAudit(db, owner, { limit: 2, cursor: page1.cursor });
      expect(page2.items.map((e) => e.action)).toEqual(["sheet.create"]);
      await expect(listAudit(db, viewer)).rejects.toThrow(ForbiddenError);
      await expect(recordAudit(db, owner, { action: "Bad Action!" })).rejects.toThrow(InvalidInputError);
    });
  });

  describe("Stripe link and processed webhook", () => {
    it("maps a Stripe customer to one team, for webhooks acting as the system", async () => {
      const { owner, contributor } = await team();
      const customerId = `cus_${owner.teamId.slice(0, 8)}`;
      await expect(linkStripeCustomer(db, contributor, customerId)).rejects.toThrow(ForbiddenError);
      await linkStripeCustomer(db, owner, customerId);
      await linkStripeCustomer(db, owner, customerId); // idempotent
      expect(await rawItem(db, `STRIPE#${customerId}`, "TEAM")).toMatchObject({ teamId: owner.teamId });

      const system = (await teamContextForStripeCustomer(db, customerId)) as TeamContext;
      expect(system).toMatchObject({ teamId: owner.teamId, role: "system", homeRegion: REGION });
      const updated = await updateTeam(db, system, { plan: "starter", seats: 5, status: "active" }, 1);
      expect(updated).toMatchObject({ plan: "starter", seats: 5, status: "active", stripeCustomerId: customerId });
      expect(await teamContextForStripeCustomer(db, "cus_unknown")).toBeUndefined();

      // Neither the customer nor the team can be re-linked elsewhere
      const other = await team("Other Co");
      await expect(linkStripeCustomer(db, other.owner, customerId)).rejects.toThrow(ConflictError);
      await expect(linkStripeCustomer(db, owner, `${customerId}x`)).rejects.toThrow(ConflictError);
    });

    it("processes each webhook event once, with a 30-day TTL", async () => {
      db = table.db;
      const eventId = `evt_${newUser()}`;
      const now = new Date("2026-09-25T00:00:00Z");
      expect(await markWebhookProcessed(db, eventId, now)).toBe(true);
      expect(await markWebhookProcessed(db, eventId, now)).toBe(false);
      expect((await rawItem(db, `WEBHOOK#${eventId}`, "DONE"))?.expiresAt).toBe(now.getTime() / 1000 + 30 * 86400);
    });
  });

  describe("team isolation", () => {
    it("never shows or changes one team's data through another team's context", async () => {
      const a = await team("Team A");
      const b = await team("Team B");
      const sheet = await createSheet(db, a.contributor, { client: "A's client", date: "2026-09-25" });
      await createProduct(db, a.contributor, "shared-key", { code: "", name: "A's towels", price: 1 }, 5);
      await createProduct(db, b.contributor, "shared-key", { code: "", name: "B's towels", price: 1 }, 1);

      expect(await getSheet(db, b.owner, sheet.id)).toBeUndefined();
      expect(await listSheets(db, b.owner)).toEqual([]);
      expect((await listSheetsByDate(db, b.owner)).items).toEqual([]);
      expect((await listProducts(db, b.owner)).map((p) => p.name)).toEqual(["B's towels"]);
      await expect(updateSheet(db, b.owner, sheet.id, { client: "hijack" }, 1)).rejects.toThrow(ConflictError);
      await adjustStock(db, b.contributor, "shared-key", -1);
      expect((await getProduct(db, a.viewer, "shared-key"))?.stock).toBe(5);
      expect((await listMembers(db, b.owner)).some((m) => m.userId === a.owner.userId)).toBe(false);

      // A cursor from team A's listing is refused in team B
      await createSheet(db, a.contributor, { client: "A2", date: "2026-09-26" });
      const pageA = await listSheetsByDate(db, a.viewer, { limit: 1 });
      await expect(listSheetsByDate(db, b.viewer, { limit: 1, cursor: pageA.cursor })).rejects.toThrow(InvalidInputError);
    });
  });
});
