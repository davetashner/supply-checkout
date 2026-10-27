// The daily returns digest's data calls (data/returns-digest.ts) against
// DynamoDB Local (skipped without DYNAMODB_ENDPOINT; `npm run test:ddb` runs
// it): the returns index GSI2 as projects are closed and reopened, the
// window's bounds, and the once-only claims.

import { describe, expect, it } from "vitest";
import {
  claimDigest,
  createProject,
  createTeam,
  listOwnerEmails,
  listReturnedProjects,
  ownerLanguage,
  readDigestTeam,
  releaseDigest,
  setDocument,
  setPreferences,
  updateDocument,
  updateProject,
} from "../src/data/index.js";
import { endpoint, newUser, rawItem, useTable } from "./helpers.js";

const at = (iso: string) => new Date(iso);

describe.skipIf(!endpoint)("the returns digest's data (DynamoDB Local)", () => {
  const table = useTable();

  it("lists a project from the moment a document write closes it until it's reopened, only inside the window", async () => {
    const owner = newUser();
    const a = await createTeam(table.db, { userId: owner, email: `owner.${owner}@example.com` }, { name: "A Co" }, at("2026-10-20T00:00:00.000Z"));
    const b = await createTeam(table.db, { userId: newUser() }, { name: "B Co" }, at("2026-10-20T00:00:00.000Z"));
    const from = at("2026-10-25T22:00:00.000Z");
    const to = at("2026-10-26T22:00:00.000Z");
    const close = (ctx: typeof a.context, id: string, client: string, now: string, extra: Record<string, unknown> = {}) =>
      setDocument(table.db, ctx, "projects", id, { client, date: "2026-10-20", status: "closed", items: {}, ...extra }, { now: at(now) });

    await close(a.context, "late", "Last night", "2026-10-25T23:00:00.000Z", { createdByName: "Dana" });
    await close(a.context, "early", "This morning", "2026-10-26T01:00:00.000Z");
    await close(a.context, "edge-in", "At the start", "2026-10-25T22:00:00.000Z");
    await close(a.context, "edge-out", "At the end", "2026-10-26T22:00:00.000Z");
    await close(a.context, "before", "Before", "2026-10-25T21:59:59.999Z");
    await close(b.context, "other", "Another team", "2026-10-26T12:00:00.000Z");
    await setDocument(table.db, a.context, "projects", "open-one", { client: "Still open", date: "2026-10-20", status: "open", items: {} });

    const listed = await listReturnedProjects(table.db, from, to);
    expect(listed.get(a.team.teamId)?.map((p) => p.projectId).sort()).toEqual(["early", "edge-in", "late"]);
    expect(listed.get(a.team.teamId)?.find((p) => p.projectId === "late")).toEqual({ projectId: "late", client: "Last night", date: "2026-10-20", closedAt: "2026-10-25T23:00:00.000Z", preparedBy: "Dana" });
    expect(listed.get(b.team.teamId)?.map((p) => p.client)).toEqual(["Another team"]);
    expect(await rawItem(table.db, `TEAM#${a.team.teamId}`, "PROJECT#late")).toMatchObject({ GSI2PK: "RETURNED#2026-10-25", GSI2SK: `2026-10-25T23:00:00.000Z#${a.team.teamId}#late` });
    expect(await rawItem(table.db, `TEAM#${a.team.teamId}`, "PROJECT#open-one")).not.toHaveProperty("GSI2PK");
    // An empty or backwards window lists nothing
    expect((await listReturnedProjects(table.db, to, from)).size).toBe(0);
    expect((await listReturnedProjects(table.db, from, from)).size).toBe(0);

    // A merge update that reopens it drops it from the index
    await updateDocument(table.db, a.context, "projects", "early", { status: "open" });
    expect(await rawItem(table.db, `TEAM#${a.team.teamId}`, "PROJECT#early")).not.toHaveProperty("GSI2PK");
    expect((await listReturnedProjects(table.db, from, to)).get(a.team.teamId)?.map((p) => p.projectId).sort()).toEqual(["edge-in", "late"]);
  });

  it("follows updateProject closing and reopening", async () => {
    const made = await createTeam(table.db, { userId: newUser() }, { name: "C Co" }, at("2026-10-20T00:00:00.000Z"));
    const project = await createProject(table.db, made.context, { client: "Echo", date: "2026-10-20" });
    expect(await rawItem(table.db, `TEAM#${made.team.teamId}`, `PROJECT#${project.id}`)).not.toHaveProperty("GSI2PK");
    const closed = await updateProject(table.db, made.context, project.id, { status: "closed" }, project.version);
    const raw = await rawItem(table.db, `TEAM#${made.team.teamId}`, `PROJECT#${project.id}`);
    expect(raw).toMatchObject({ GSI2PK: `RETURNED#${(closed.closedAt as string).slice(0, 10)}`, GSI2SK: `${closed.closedAt}#${made.team.teamId}#${project.id}` });
    const from = new Date(Date.parse(closed.closedAt as string) - 1000);
    const to = new Date(Date.parse(closed.closedAt as string) + 1000);
    expect((await listReturnedProjects(table.db, from, to)).get(made.team.teamId)?.map((p) => p.projectId)).toEqual([project.id]);
    const reopened = await updateProject(table.db, made.context, project.id, { status: "open" }, closed.version);
    expect(await rawItem(table.db, `TEAM#${made.team.teamId}`, `PROJECT#${project.id}`)).not.toHaveProperty("GSI2PK");
    expect((await listReturnedProjects(table.db, from, to)).get(made.team.teamId)).toBeUndefined();
    // A change that isn't a status leaves the index alone
    const renamed = await updateProject(table.db, made.context, project.id, { client: "Echo 2" }, reopened.version);
    expect(renamed.client).toBe("Echo 2");
  });

  it("reads a team, its owners and an owner's language, and claims a digest once", async () => {
    const owner = newUser();
    const made = await createTeam(table.db, { userId: owner, email: `owner.${owner}@example.com` }, { name: "D Co" }, at("2026-10-20T00:00:00.000Z"));
    expect(await readDigestTeam(table.db, made.team.teamId)).toMatchObject({ teamId: made.team.teamId, name: "D Co", status: "trialing" });
    expect(await readDigestTeam(table.db, "no-such-team")).toBeUndefined();
    expect(await listOwnerEmails(table.db, made.team.teamId)).toEqual([{ userId: owner, email: `owner.${owner}@example.com` }]);
    expect(await ownerLanguage(table.db, owner)).toBeUndefined();
    await setPreferences(table.db, owner, { language: "es" });
    expect(await ownerLanguage(table.db, owner)).toBe("es");

    const end = at("2026-10-26T22:00:00.000Z");
    const now = at("2026-10-26T22:05:00.000Z");
    expect(await claimDigest(table.db, made.team.teamId, end, owner, now)).toBe(true);
    expect(await claimDigest(table.db, made.team.teamId, end, owner, now)).toBe(false);
    // Another window, owner or team is its own claim
    expect(await claimDigest(table.db, made.team.teamId, at("2026-10-27T22:00:00.000Z"), owner, now)).toBe(true);
    expect(await claimDigest(table.db, made.team.teamId, end, "someone-else", now)).toBe(true);
    expect(await rawItem(table.db, `DIGEST#${made.team.teamId}`, `SENT#${end.toISOString()}#${owner}`)).toMatchObject({ type: "returnsDigest", sentAt: now.toISOString() });
    await releaseDigest(table.db, made.team.teamId, end, owner);
    expect(await claimDigest(table.db, made.team.teamId, end, owner, now)).toBe(true);
  });
});
