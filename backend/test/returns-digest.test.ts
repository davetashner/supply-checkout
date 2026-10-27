// The daily returns digest (src/ops/returns-digest-handler.ts, supply-checkout-phhw)
// against the in-memory table, each call passing only what its role allows
// (digestPolicy in ops-policy.ts), with a fake mailer. The returned projects
// are stored the way documents.ts stores them (projectItem), so the index keys
// are the real ones.

import { beforeEach, describe, expect, it } from "vitest";
import { createTeam, projectItem, setDocument } from "../src/data/index.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { renderEmail } from "../src/email/templates.js";
import { RETURNS_DIGEST_MAX_LISTED } from "../src/ops/names.js";
import { createReturnsDigestHandler, digestWindow } from "../src/ops/returns-digest-handler.js";
import { fakeMailer, REGION } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";
import { digestPolicy } from "./ops-policy.js";

const HOUR = 3_600_000;
// The run: 22:05 UTC on 2026-10-26, so the window is 2026-10-25T22:00Z to 2026-10-26T22:00Z
const NOW = Date.parse("2026-10-26T22:05:00.000Z");
const FROM = "2026-10-25T22:00:00.000Z";
const TO = "2026-10-26T22:00:00.000Z";

let table: MemoryTable;
let denied: { command: string; input: Record<string, unknown> }[];
let mails: ReturnType<typeof fakeMailer>;
let counts: [string, number, Record<string, unknown>][];
let gauges: Record<string, number>;
let logs: [string, string, Record<string, unknown>][];

function obs(): Observability {
  const log = (level: string) => (message: string, data: Record<string, unknown> = {}) => logs.push([level, message, data]);
  return {
    region: REGION,
    logger: { info: log("info"), warn: log("warn"), error: log("error"), addContext: () => {} } as unknown as Observability["logger"],
    count: (metric, value = 1, metadata = {}) => counts.push([metric, value, metadata as Record<string, unknown>]),
    gauge: (metric, value) => {
      gauges[metric] = value;
    },
    flush: () => {},
  };
}

/** A team with two owners (one without an address), a contributor and a viewer, in the table and the operators' index. */
function team(teamId: string, fields: Record<string, unknown> = {}) {
  table.put({ PK: `TEAM#${teamId}`, SK: "META", GSI3PK: "OPS#TEAMS", GSI3SK: teamId, type: "team", teamId, name: `Name of ${teamId}`, status: "active", owners: 2, version: 3, createdAt: "2026-01-01T00:00:00.000Z", ...fields });
  table.put({ PK: `TEAM#${teamId}`, SK: "MEMBER#owner-1", GSI3PK: `OPS#OWNERS#${teamId}`, GSI3SK: "owner-1", type: "member", role: "owner", userId: "owner-1", email: `owner1.${teamId}@example.com` });
  table.put({ PK: `TEAM#${teamId}`, SK: "MEMBER#owner-2", GSI3PK: `OPS#OWNERS#${teamId}`, GSI3SK: "owner-2", type: "member", role: "owner", userId: "owner-2", email: `owner2.${teamId}@example.com` });
  table.put({ PK: `TEAM#${teamId}`, SK: "MEMBER#crew", type: "member", role: "contributor", userId: "crew", email: `crew.${teamId}@example.com` });
  table.put({ PK: `TEAM#${teamId}`, SK: "MEMBER#viewer", type: "member", role: "viewer", userId: "viewer", email: `viewer.${teamId}@example.com` });
}

/** A project in the team, stored as the documents code stores it. */
function project(teamId: string, projectId: string, data: Record<string, unknown>) {
  table.put(projectItem(teamId, projectId, { client: `Client ${projectId}`, date: "2026-10-20", items: {}, ...data }, 1));
}

const closed = (closedAt: string, extra: Record<string, unknown> = {}) => ({ status: "closed", closedAt, ...extra });
const run = (at = NOW) => createReturnsDigestHandler({ db: table.guarded(digestPolicy(denied)), obs: obs(), mailer: mails.mailer, now: () => at })();
const counted = (metric: string) => counts.filter(([m]) => m === metric).reduce((n, [, v]) => n + v, 0);
const digests = () => mails.sent.map((m) => m.input as Extract<(typeof mails.sent)[number]["input"], { kind: "returnsDigest" }>);

beforeEach(() => {
  table = new MemoryTable();
  denied = [];
  mails = fakeMailer();
  counts = [];
  gauges = {};
  logs = [];
});

describe("the window", () => {
  it("is the 24 hours ending at the latest 22:00 UTC, whenever the run starts", () => {
    const w = (iso: string) => {
      const { from, to } = digestWindow(new Date(iso));
      return [from.toISOString(), to.toISOString()];
    };
    expect(w("2026-10-26T22:05:00.000Z")).toEqual([FROM, TO]);
    // A late or retried run: the same window
    expect(w("2026-10-26T22:00:00.000Z")).toEqual([FROM, TO]);
    expect(w("2026-10-27T03:00:00.000Z")).toEqual([FROM, TO]);
    expect(w("2026-10-27T21:59:59.999Z")).toEqual([FROM, TO]);
    // The next one starts exactly where this ended
    expect(w("2026-10-27T22:05:00.000Z")).toEqual([TO, "2026-10-27T22:00:00.000Z"]);
    // A run before the slot, across a month's end
    expect(w("2026-11-01T01:00:00.000Z")).toEqual(["2026-10-30T22:00:00.000Z", "2026-10-31T22:00:00.000Z"]);
  });
});

describe("a quiet day", () => {
  it("sends nothing when no project was returned in the window, and still reports it ran", async () => {
    team("quiet");
    project("quiet", "open-one", { status: "open" });
    // Returned just outside the window on either side
    project("quiet", "before", closed("2026-10-25T21:59:59.999Z"));
    project("quiet", "after", closed(TO));
    expect(await run()).toMatchObject({ from: FROM, to: TO, teams: 0, sent: 0, failed: 0 });
    expect(mails.sent).toEqual([]);
    expect(gauges[BusinessMetric.ReturnsDigestTeams]).toBe(0);
    expect(counted(BusinessMetric.ReturnsDigests)).toBe(0);
    expect(denied).toEqual([]);
  });
});

describe("a day with returns", () => {
  it("emails each owner once, with only that team's projects, oldest first, and no one else", async () => {
    team("a");
    team("b");
    project("a", "p1", closed("2026-10-26T15:00:00.000Z", { client: "Zeta Roofing", date: "2026-10-24", createdByName: "Dana" }));
    project("a", "p2", closed("2026-10-26T09:00:00.000Z", { client: "Alpha Siding" }));
    project("b", "p3", closed("2026-10-26T12:00:00.000Z", { client: "Beta Build" }));
    // The window's first instant is in; its last isn't
    project("b", "edge-in", closed(FROM, { client: "Edge In" }));
    project("b", "edge-out", closed(TO, { client: "Edge Out" }));
    expect(await run()).toEqual({ from: FROM, to: TO, teams: 2, sent: 4, failed: 0 });
    expect(denied).toEqual([]);
    const a = mails.sent.filter((m) => m.tags.teamId === "a");
    expect(a.map((m) => m.to).sort()).toEqual(["owner1.a@example.com", "owner2.a@example.com"]);
    for (const m of a) {
      expect(m.input).toEqual({
        kind: "returnsDigest",
        teamName: "Name of a",
        windowEnd: TO,
        total: 2,
        projects: [{ client: "Alpha Siding", date: "2026-10-20" }, { client: "Zeta Roofing", date: "2026-10-24", preparedBy: "Dana" }],
      });
    }
    const b = mails.sent.filter((m) => m.tags.teamId === "b");
    expect(b.map((m) => m.to).sort()).toEqual(["owner1.b@example.com", "owner2.b@example.com"]);
    expect((b[0]?.input as unknown as { projects: { client: string }[] }).projects.map((p) => p.client)).toEqual(["Edge In", "Beta Build"]);
    // Contributors and viewers aren't emailed, and no address appears in another team's mail
    expect(mails.sent.some((m) => m.to.startsWith("crew.") || m.to.startsWith("viewer."))).toBe(false);
    expect(JSON.stringify(a.map((m) => m.input))).not.toContain("Beta Build");
    expect(JSON.stringify(b.map((m) => m.input))).not.toContain("Zeta Roofing");
    expect(counted(BusinessMetric.ReturnsDigests)).toBe(4);
    expect(gauges[BusinessMetric.ReturnsDigestTeams]).toBe(2);
  });

  it("sends nothing twice: a second run for the same window finds every owner claimed", async () => {
    team("a");
    project("a", "p1", closed("2026-10-26T15:00:00.000Z"));
    await run();
    await run(NOW + 30 * 60_000);
    await run(NOW + 20 * HOUR);
    expect(mails.sent).toHaveLength(2);
    // The next day's window is new: a project returned in it is sent
    project("a", "p2", closed("2026-10-27T10:00:00.000Z"));
    await run(NOW + 24 * HOUR);
    expect(mails.sent).toHaveLength(4);
    expect(digests().slice(2).map((d) => d.projects.length)).toEqual([1, 1]);
  });

  it("ignores a stray index entry: wrong status, wrong team in the key, or a closedAt outside the window", async () => {
    team("a");
    team("b");
    const good = projectItem("a", "p1", { client: "Mine", date: "2026-10-20", ...closed("2026-10-26T10:00:00.000Z") }, 1);
    table.put(good);
    // Reopened, but the index entry is left over
    table.put({ ...projectItem("a", "reopened", { client: "Reopened", date: "2026-10-20", ...closed("2026-10-26T11:00:00.000Z") }, 1), status: "open" });
    // An index entry claiming another team's project
    table.put({ ...projectItem("b", "forged", { client: "Forged", date: "2026-10-20", ...closed("2026-10-26T12:00:00.000Z") }, 1), GSI2SK: `2026-10-26T12:00:00.000Z#a#forged` });
    // A closedAt that disagrees with its index entry
    table.put({ ...projectItem("b", "moved", { client: "Moved", date: "2026-10-20", ...closed("2026-10-26T13:00:00.000Z") }, 1), closedAt: "2026-10-26T14:00:00.000Z" });
    // Not a project item
    table.put({ PK: "TEAM#b", SK: "PRODUCT#x", GSI2PK: "RETURNED#2026-10-26", GSI2SK: "2026-10-26T15:00:00.000Z#b#x", status: "closed", closedAt: "2026-10-26T15:00:00.000Z" });
    // Not a valid team
    table.put({ PK: "TEAM#bad id", SK: "PROJECT#x", GSI2PK: "RETURNED#2026-10-26", GSI2SK: "2026-10-26T16:00:00.000Z#bad id#x", status: "closed", closedAt: "2026-10-26T16:00:00.000Z" });
    await run();
    expect(digests().map((d) => [d.teamName, d.projects.map((p) => p.client)])).toEqual([["Name of a", ["Mine"]], ["Name of a", ["Mine"]]]);
  });

  it("lists the first projects by name and counts the rest", async () => {
    team("a");
    for (let i = 0; i < RETURNS_DIGEST_MAX_LISTED + 5; i++) project("a", `p${String(i).padStart(2, "0")}`, closed(`2026-10-26T10:${String(i).padStart(2, "0")}:00.000Z`));
    await run();
    const [first] = digests();
    expect(first?.total).toBe(RETURNS_DIGEST_MAX_LISTED + 5);
    expect(first?.projects).toHaveLength(RETURNS_DIGEST_MAX_LISTED);
    expect(first?.projects[0]?.client).toBe("Client p00");
  });

  it("reads the window across the day boundary (two index partitions)", async () => {
    team("a");
    project("a", "late", closed("2026-10-25T23:30:00.000Z", { client: "Last night" }));
    project("a", "early", closed("2026-10-26T00:10:00.000Z", { client: "This morning" }));
    await run();
    expect(digests()[0]?.projects.map((p) => p.client)).toEqual(["Last night", "This morning"]);
  });
});

describe("teams it leaves out", () => {
  it("skips a closed team, one being purged, one read-only for billing, one with no owners and one that's gone", async () => {
    team("closed", { closedAt: "2026-10-26T20:00:00.000Z" });
    team("purging", { purging: "2026-10-26T20:00:00.000Z" });
    team("readonly", { status: "canceled", subscriptionEndedAt: "2026-09-01T00:00:00.000Z" });
    team("ownerless");
    table.delete("TEAM#ownerless", "MEMBER#owner-1");
    table.delete("TEAM#ownerless", "MEMBER#owner-2");
    team("ok");
    for (const id of ["closed", "purging", "readonly", "ownerless", "ok", "gone"]) project(id, "p", closed("2026-10-26T10:00:00.000Z"));
    expect(await run()).toMatchObject({ teams: 6, sent: 2, failed: 0 });
    expect([...new Set(mails.sent.map((m) => m.tags.teamId))]).toEqual(["ok"]);
    expect(denied).toEqual([]);
  });

  it("counts an owner without an address", async () => {
    team("a");
    table.put({ PK: "TEAM#a", SK: "MEMBER#owner-2", GSI3PK: "OPS#OWNERS#a", GSI3SK: "owner-2", type: "member", role: "owner", userId: "owner-2" });
    project("a", "p1", closed("2026-10-26T10:00:00.000Z"));
    expect(await run()).toMatchObject({ sent: 1, failed: 1 });
    expect(counts.filter(([m]) => m === BusinessMetric.ReturnsDigestFailures).map(([, , md]) => md.reason)).toEqual(["no_address"]);
  });

  it("tags a test team's metrics", async () => {
    team("t", { test: true });
    project("t", "p1", closed("2026-10-26T10:00:00.000Z"));
    await run();
    expect(counts.filter(([m]) => m === BusinessMetric.ReturnsDigests).every(([, , md]) => md.test === true)).toBe(true);
  });
});

describe("language", () => {
  it("uses each owner's own choice, and English when they made none or it can't be read", async () => {
    team("a");
    table.put({ PK: "USER#owner-1", SK: "PREFERENCES", language: "es" });
    table.put({ PK: "USER#owner-2", SK: "PREFERENCES", language: "klingon" });
    project("a", "p1", closed("2026-10-26T10:00:00.000Z"));
    await run();
    const language = Object.fromEntries(mails.sent.map((m) => [m.to, (m.input as { language?: string }).language]));
    expect(language).toEqual({ "owner1.a@example.com": "es", "owner2.a@example.com": undefined });
    expect(denied).toEqual([]);
  });

  it("sends in English when the preference can't be read", async () => {
    team("a");
    project("a", "p1", closed("2026-10-26T10:00:00.000Z"));
    // Make only the preferences read fail
    table.failingGets = (key) => key.SK === "PREFERENCES";
    await run();
    expect(mails.sent).toHaveLength(2);
    expect(logs.some(([level, message]) => level === "warn" && message === "Returns digest language not read")).toBe(true);
  });
});

describe("failures", () => {
  it("gives the claim back and fails the run when a send fails, so the retry sends only what's missing", async () => {
    team("a");
    project("a", "p1", closed("2026-10-26T10:00:00.000Z"));
    mails.state.fail = "ThrottlingException";
    await expect(run()).rejects.toThrow(/tried again/);
    expect(mails.sent).toEqual([]);
    expect(counted(BusinessMetric.ReturnsDigestFailures)).toBe(2);
    mails.state.fail = undefined;
    expect(await run(NOW + 60_000)).toMatchObject({ sent: 2, failed: 0 });
    expect(mails.sent).toHaveLength(2);
    // And nothing more on a third try
    await run(NOW + 120_000);
    expect(mails.sent).toHaveLength(2);
  });

  it("keeps the claim and doesn't retry when SES refuses the address", async () => {
    team("a");
    project("a", "p1", closed("2026-10-26T10:00:00.000Z"));
    mails.state.fail = "MessageRejected";
    expect(await run()).toMatchObject({ sent: 0, failed: 2 });
    expect(counts.filter(([m]) => m === BusinessMetric.ReturnsDigestFailures).map(([, , md]) => md.reason)).toEqual(["refused", "refused"]);
    mails.state.fail = undefined;
    await run(NOW + 60_000);
    expect(mails.sent).toEqual([]);
  });

  it("counts a team it couldn't read and still sends the others, then fails the run", async () => {
    team("a");
    team("b");
    project("a", "p1", closed("2026-10-26T10:00:00.000Z"));
    project("b", "p2", closed("2026-10-26T11:00:00.000Z"));
    table.failingGets = (key) => key.PK === "TEAM#a";
    await expect(run()).rejects.toThrow(/tried again/);
    expect([...new Set(mails.sent.map((m) => m.tags.teamId))]).toEqual(["b"]);
    expect(counts.some(([m, , md]) => m === BusinessMetric.ReturnsDigestFailures && md.teamId === "a" && md.reason === "error")).toBe(true);
  });

  it("logs team IDs and counts only, never a name or an address", async () => {
    team("a");
    project("a", "p1", closed("2026-10-26T10:00:00.000Z", { client: "Secret Client", createdByName: "Dana Private" }));
    mails.state.fail = "ThrottlingException";
    await run().catch(() => undefined);
    const text = JSON.stringify([logs, counts]);
    for (const secret of ["Secret Client", "Dana Private", "example.com", "Name of a"]) expect(text).not.toContain(secret);
  });
});

describe("what the index holds", () => {
  it("is set when a document write closes a project and gone when it's reopened", async () => {
    const db = table.db();
    const made = await createTeam(db, { userId: "owner-x", email: "owner.x@example.com" }, { name: "Acme" }, new Date("2026-10-20T00:00:00.000Z"));
    const { teamId } = made.team;
    const ctx = made.context;
    const at = new Date("2026-10-26T10:00:00.000Z");
    await setDocument(db, ctx, "projects", "p1", { client: "C", date: "2026-10-20", status: "closed", items: {} }, { now: at });
    expect(table.get(`TEAM#${teamId}`, "PROJECT#p1")).toMatchObject({ GSI2PK: "RETURNED#2026-10-26", GSI2SK: `${at.toISOString()}#${teamId}#p1`, closedAt: at.toISOString() });
    // Another edit while closed keeps its time and entry
    await setDocument(db, ctx, "projects", "p1", { client: "C2", date: "2026-10-20", status: "closed", items: {} }, { now: new Date("2026-10-26T12:00:00.000Z") });
    expect(table.get(`TEAM#${teamId}`, "PROJECT#p1")).toMatchObject({ GSI2SK: `${at.toISOString()}#${teamId}#p1` });
    await setDocument(db, ctx, "projects", "p1", { client: "C2", date: "2026-10-20", status: "open", items: {} }, { now: new Date("2026-10-26T13:00:00.000Z") });
    expect(table.get(`TEAM#${teamId}`, "PROJECT#p1")).not.toHaveProperty("GSI2PK");
    expect(table.get(`TEAM#${teamId}`, "PROJECT#p1")).not.toHaveProperty("GSI2SK");
    // Closed again: the new time
    const again = new Date("2026-10-26T14:00:00.000Z");
    await setDocument(db, ctx, "projects", "p1", { client: "C2", date: "2026-10-20", status: "closed", items: {} }, { now: again });
    expect(table.get(`TEAM#${teamId}`, "PROJECT#p1")).toMatchObject({ GSI2SK: `${again.toISOString()}#${teamId}#p1` });
    expect(await run()).toMatchObject({ teams: 1, sent: 1 });
    expect(mails.sent[0]?.to).toBe("owner.x@example.com");
  });

  it("is left out for a closedAt that isn't a time", () => {
    expect(projectItem("a", "p", { status: "closed", closedAt: "yesterday", date: "2026-10-01" }, 1)).not.toHaveProperty("GSI2PK");
    expect(projectItem("a", "p", { status: "closed", date: "2026-10-01" }, 1)).not.toHaveProperty("GSI2PK");
    expect(projectItem("a", "p", { status: "open", closedAt: "2026-10-26T10:00:00.000Z", date: "2026-10-01" }, 1)).not.toHaveProperty("GSI2PK");
  });
});

describe("the email", () => {
  const OPTS = { appUrl: "https://app.example.com", supportAddress: "support@example.com" };
  const input = (extra: Record<string, unknown> = {}) =>
    ({
      kind: "returnsDigest",
      teamName: "Acme Co",
      windowEnd: TO,
      total: 3,
      projects: [{ client: "Alpha", date: "2026-10-20", preparedBy: "Dana" }, { client: "Beta" }],
      ...extra,
    }) as Parameters<typeof renderEmail>[0];

  it("is labeled a daily digest in the subject and body, and says why they get it", () => {
    const email = renderEmail(input(), OPTS);
    expect(email.kind).toBe("returnsDigest");
    expect(email.subject).toBe("Supply Checkout daily digest: 3 projects returned for Acme Co");
    for (const part of [email.html, email.text]) {
      expect(part).toContain("daily digest for Acme Co");
      expect(part).toContain("past day");
      expect(part).toContain("Alpha (dated October 20, 2026, prepared by Dana)");
      expect(part).toContain("Beta");
      expect(part).toContain(`You get this daily digest because you${part === email.html ? "&#39;" : "'"}re an owner of Acme Co`);
      expect(part).toContain("and 1 more.");
      expect(part).toContain("https://app.example.com/");
    }
    expect(email.html).toContain('<html lang="en"');
    expect(email.html).toContain("•");
    expect(renderEmail(input({ total: 1, projects: [{ client: "Alpha" }] }), OPTS).subject).toBe("Supply Checkout daily digest: 1 project returned for Acme Co");
  });

  it("is in Spanish for an owner who chose it", () => {
    const email = renderEmail(input({ language: "es" }), OPTS);
    expect(email.subject).toBe("Resumen diario de Supply Checkout: 3 proyectos devueltos en Acme Co");
    expect(email.html).toContain('<html lang="es"');
    expect(email.html).toContain("Si el botón no funciona");
    expect(email.text).toContain("Este es el resumen diario de Acme Co");
    expect(email.text).toContain("Alpha (fecha 20 de octubre de 2026, preparado por Dana)");
    expect(email.text).toContain("Recibes este resumen diario porque eres propietario de Acme Co");
    expect(email.text).toContain("y 1 más.");
    expect(renderEmail(input({ language: "es", total: 1, projects: [{ client: "Alpha" }] }), OPTS).subject).toContain("1 proyecto devuelto");
    expect(renderEmail(input({ language: "es", projects: [{ client: "" }] }), OPTS).text).toContain("Proyecto sin nombre");
  });

  it("defangs names and links, escapes markup, and refuses a digest of nothing or a bad date", () => {
    const email = renderEmail(input({ teamName: "<b>Evil</b> evil.example", projects: [{ client: "see https://evil.example/x", date: "2026-13-45", preparedBy: "<i>x</i>" }, { client: "" }], total: 2 }), OPTS);
    expect(email.html).not.toContain("<b>Evil");
    expect(email.html).not.toContain("https://evil.example");
    expect(email.text).toContain("evil[.]example");
    expect(email.text).toContain("Untitled project");
    // A date that doesn't exist isn't shown
    expect(email.text).not.toContain("dated");
    expect(() => renderEmail(input({ total: 0, projects: [] }), OPTS)).toThrow("at least one project");
    expect(() => renderEmail(input({ windowEnd: "soon" }), OPTS)).toThrow();
  });
});
