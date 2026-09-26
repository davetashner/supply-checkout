// Every entity in ADR 0005, against DynamoDB Local. CI runs DynamoDB Local as a
// service container and sets DYNAMODB_ENDPOINT; without it these are skipped
// locally and fail in CI.

import { describe, expect, it } from "vitest";
import {
  acceptInvite,
  adjustStock,
  authorizeTeam,
  ConflictError,
  createInvite,
  createProduct,
  createSheet,
  createTeam,
  deleteProduct,
  deleteSheet,
  findInvite,
  findInviteForEmail,
  ForbiddenError,
  getMember,
  getProduct,
  getReceiptUsage,
  getSheet,
  getTeam,
  InvalidInputError,
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
  markWebhookProcessed,
  MAX_TEAMS_PER_USER,
  NotFoundError,
  recordAudit,
  recordReceiptRead,
  removeMember,
  removeSheetLine,
  revokeInvite,
  setMemberRole,
  setSheetLine,
  teamContextForStripeCustomer,
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
import { endpoint, newUser, rawItem, REGION, useTable } from "./helpers.js";

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
      const { invite, token } = await createInvite(db, owner, { email: `${role}@example.com`, role });
      return acceptInvite(db, { userId: newUser(), verifiedEmail: `${role}@example.com` }, invite, token);
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
      const other = await createInvite(db, owner, { email: "quinn@example.com", role: "viewer" });
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
