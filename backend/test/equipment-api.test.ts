// Company equipment through the data API's handler (ADR 0017), against the
// in-memory table (memory-table.ts): the item's kind, equipment lines on a
// project, lost or broken, Finished Return's refusal while equipment is out,
// equipment bought for a client at the team's markup, and the team settings
// that hold the markup, readable and writable by owners only.
// equipment.test.ts runs the transactions against DynamoDB Local.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createDataHandler, type DataEvent } from "../src/api/data-handler.js";
import { DATA_ROUTES, routeKey } from "../src/api/routes.js";
import { InvalidInputError } from "../src/data/index.js";
import { MAX_NEW_LINES } from "../src/data/documents.js";
import type { Observability } from "../src/observability/index.js";
import { MemoryTable } from "./memory-table.js";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const OWNER = "user-owner";
const CONTRIBUTOR = "user-contributor";
const VIEWER = "user-viewer";

let table: MemoryTable;
let clock: number;
let counts: Record<string, number>;
let handler: ReturnType<typeof createDataHandler>;

beforeEach(() => {
  table = new MemoryTable();
  table.seedTeam("team-a", { [OWNER]: "owner", [CONTRIBUTOR]: "contributor", [VIEWER]: "viewer" });
  counts = {};
  clock = NOW;
  const obs = {
    region: "test-local-1",
    logger: { info: () => {}, warn: () => {}, error: () => {}, addContext: () => {} },
    count: (metric: string, value = 1) => {
      counts[metric] = (counts[metric] ?? 0) + value;
    },
    flush: () => {},
  } as unknown as Observability;
  handler = createDataHandler({
    dbForTeam: (teamId) => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(teamId)) throw new InvalidInputError("Invalid team ID");
      return table.dataDb(teamId);
    },
    obs,
    now: () => clock,
  });
});

function event(method: string, path: string, user: string, body?: unknown, query?: Record<string, string>): DataEvent {
  const segments = path.split("/");
  const route = DATA_ROUTES.find((r) => {
    const parts = r.path.split("/");
    return r.method === method && parts.length === segments.length && parts.every((p, i) => p.startsWith("{") || p === segments[i]);
  });
  const pathParameters: Record<string, string> = {};
  route?.path.split("/").forEach((p, i) => {
    if (p.startsWith("{")) pathParameters[p.slice(1, -1)] = decodeURIComponent(segments[i] as string);
  });
  return {
    version: "2.0",
    routeKey: route ? routeKey(route) : `${method} ${path}`,
    rawPath: path,
    rawQueryString: "",
    headers: {},
    queryStringParameters: query,
    pathParameters,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" },
      authorizer: { principalId: "", integrationLatency: 0, jwt: { claims: { sub: user, token_use: "access", exp: String(NOW / 1000 + 600) }, scopes: null } },
    },
  } as unknown as DataEvent;
}

async function call(method: string, path: string, body?: unknown, user = CONTRIBUTOR, query?: Record<string, string>) {
  const response = await handler(event(method, path, user, body, query));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined, text: response.body ?? "" };
}

const op = () => randomUUID();
type Line = Record<string, unknown>;
const ladder = { code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120, stock: 4 };
const gloves = { code: "0123", name: "Nitrile gloves", price: 12.5, cost: 9.99, stock: 10 };

function product(key: string, data: Record<string, unknown>, version = 1) {
  table.put({ PK: "TEAM#team-a", SK: `PRODUCT#${key}`, type: "product", key, version, ...data });
}
function project(data: Record<string, unknown> = {}, id = "s1") {
  table.put({ PK: "TEAM#team-a", SK: `PROJECT#${id}`, type: "project", id, version: 1, client: "Echo", date: "2026-10-01", status: "open", items: {}, ...data });
}
function seed() {
  product("ladder", ladder);
  product("0123", gloves);
  project();
}
const items = (id = "s1") => table.get("TEAM#team-a", `PROJECT#${id}`)?.items as Record<string, Line>;
const projectVersion = (id = "s1") => table.get("TEAM#team-a", `PROJECT#${id}`)?.version as number;
const stockOf = (key: string) => table.get("TEAM#team-a", `PRODUCT#${key}`)?.stock;
const movements = () => [...table.items.values()].filter((i) => String(i.SK).startsWith("MOVE#"));
const audits = () => [...table.items.values()].filter((i) => String(i.SK).startsWith("AUDIT#"));
const settingsItem = () => table.get("TEAM#team-a", "SETTINGS");
const setMarkup = (equipmentMarkup: number, version = 1) => table.put({ PK: "TEAM#team-a", SK: "SETTINGS", type: "settings", equipmentMarkup, version });

const CHECKOUT = "/teams/team-a/projects/s1/checkout";
const RETURN = "/teams/team-a/projects/s1/return";
const LOST = "/teams/team-a/projects/s1/lost";
const LINES = "/teams/team-a/projects/s1/lines";
const SETTINGS = "/teams/team-a/settings";
const patchProject = (data: Record<string, unknown>, user = CONTRIBUTOR) => call("PATCH", "/teams/team-a/projects/s1", { data, expectedVersion: projectVersion() }, user);

describe("items: a supply or company equipment", () => {
  it("saves equipment without a price, its value in cost, and refuses any other kind", async () => {
    const saved = await call("PUT", "/teams/team-a/products/mat", { data: { code: "", name: "Cutting mat", kind: "equipment", cost: 35 }, expectedVersion: 0 });
    expect(saved).toMatchObject({ status: 200, body: { data: { name: "Cutting mat", kind: "equipment", cost: 35 } } });
    expect(saved.body.data.price).toBeUndefined();
    expect(await call("PUT", "/teams/team-a/products/rags", { data: { code: "", name: "Rags", kind: "supply", price: 2 }, expectedVersion: 0 })).toMatchObject({ status: 200 });
    for (const kind of ["tool", "", null, "Equipment"]) {
      expect(await call("PUT", "/teams/team-a/products/odd", { data: { name: "Odd", kind }, expectedVersion: 0 })).toMatchObject({ status: 400, body: { error: { message: 'kind is "supply" or "equipment"' } } });
    }
  });

  it("keeps the `:bought` ending for lines bought for a client: no new item may have it", async () => {
    expect(await call("PUT", "/teams/team-a/products/ladder%3Abought", { data: { name: "Ladder" }, expectedVersion: 0 })).toMatchObject({ status: 400, body: { error: { message: 'An item\'s key can\'t end in ":bought"' } } });
    // One stored before the rule can still be edited
    product("old:bought", { name: "Legacy", price: 1 });
    expect(await call("PATCH", "/teams/team-a/products/old%3Abought", { data: { name: "Legacy 2" }, expectedVersion: 1 })).toMatchObject({ status: 200 });
  });
});

describe("checking equipment out", () => {
  it("snapshots the kind and value, not a price, and records who took it and when, moving stock as for a supply", async () => {
    seed();
    const res = await call("POST", CHECKOUT, { operationId: op(), productKey: "ladder", quantity: 2 });
    expect(res).toMatchObject({ status: 200, body: { result: { lineCreated: true, stockDelta: -2, snapshot: { code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120 } } } });
    expect(res.body.result.snapshot.price).toBeUndefined();
    expect(items().ladder).toEqual({ code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120, out: 2, returned: 0, takenBy: CONTRIBUTOR, takenAt: "2026-10-01T12:00:00.000Z" });
    expect(stockOf("ladder")).toBe(2);

    // A later checkout names the latest person to take more; the snapshot stays
    clock += 60_000;
    product("ladder", { ...ladder, stock: 2, name: "Renamed ladder", kind: "supply", price: 9 }, 5);
    await call("POST", CHECKOUT, { operationId: op(), productKey: "ladder", quantity: 1 }, OWNER);
    expect(items().ladder).toEqual({ code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120, out: 3, returned: 0, takenBy: OWNER, takenAt: "2026-10-01T12:01:00.000Z" });
    expect(movements().map((m) => [m.reason, m.delta, m.userId])).toEqual([
      ["checkout", -2, CONTRIBUTOR],
      ["checkout", -1, OWNER],
    ]);
  });

  it("leaves a supply line as it was: a price, no kind, no taker", async () => {
    seed();
    await call("POST", CHECKOUT, { operationId: op(), productKey: "0123", quantity: 1 });
    await call("POST", CHECKOUT, { operationId: op(), productKey: "0123", quantity: 1 });
    expect(items()["0123"]).toEqual({ code: "0123", name: "Nitrile gloves", price: 12.5, cost: 9.99, out: 2, returned: 0 });
  });

  it("refuses a line bought for the client: it never came from storage", async () => {
    seed();
    expect(await call("POST", CHECKOUT, { operationId: op(), productKey: "ladder:bought", quantity: 1 })).toMatchObject({ status: 400, body: { error: { message: "Items bought for the client aren't checked out from storage" } } });
  });
});

describe("returns", () => {
  it("take back at most what's neither returned nor lost", async () => {
    seed();
    project({ items: { ladder: { name: "Step ladder", kind: "equipment", out: 3, returned: 1, lost: 1 } } });
    expect(await call("POST", RETURN, { operationId: op(), productKey: "ladder", quantity: 2 })).toMatchObject({ status: 400, body: { error: { message: "Only 1 of this item is left to return" } } });
    expect(await call("POST", RETURN, { operationId: op(), productKey: "ladder", quantity: 1 })).toMatchObject({ status: 200, body: { result: { stockDelta: 1 } } });
    expect(items().ladder).toMatchObject({ out: 3, returned: 2, lost: 1 });
    expect(stockOf("ladder")).toBe(5);
  });

  it("refuse a line bought for the client, which doesn't come back", async () => {
    seed();
    project({ items: { "ladder:bought": { name: "Step ladder", price: 150, cost: 120, purchased: true, priceSet: "markup", out: 1, returned: 0 } } });
    expect(await call("POST", RETURN, { operationId: op(), productKey: "ladder:bought", quantity: 1 })).toMatchObject({ status: 400, body: { error: { message: "This was bought for the client, so it doesn't come back" } } });
    expect(stockOf("ladder")).toBe(4);
  });

  it("don't count a lost piece that a concurrent write recorded between the read and the transaction", async () => {
    seed();
    project({ items: { ladder: { name: "Step ladder", kind: "equipment", out: 2, returned: 0 } } });
    let once = false;
    table.beforeTransactWrite = () => {
      if (once) return;
      once = true;
      const s = table.get("TEAM#team-a", "PROJECT#s1") as Record<string, unknown>;
      table.put({ ...s, items: { ladder: { name: "Step ladder", kind: "equipment", out: 2, returned: 0, lost: 2 } } });
    };
    expect(await call("POST", RETURN, { operationId: op(), productKey: "ladder", quantity: 1 })).toMatchObject({ status: 400, body: { error: { message: "Only 0 of this item are left to return" } } });
    expect(stockOf("ladder")).toBe(4);
  });
});

describe("lost or broken", () => {
  beforeEach(() => {
    seed();
    project({ items: { ladder: { code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120, out: 3, returned: 0 }, "0123": { name: "Nitrile gloves", price: 12.5, out: 2, returned: 0 } } });
  });

  it("adds to lost and the client's charge, records a lost movement, and leaves stock alone", async () => {
    const id = op();
    const res = await call("POST", LOST, { operationId: id, productKey: "ladder", quantity: 1, charge: 0.1 });
    expect(res).toMatchObject({
      status: 200,
      body: {
        replayed: false,
        result: { command: "lost", reason: "lost", productKey: "ladder", projectId: "s1", quantity: 1, stockDelta: 0, charge: 0.1, userId: CONTRIBUTOR },
        project: { version: 2 },
        product: { data: { stock: 4 } },
      },
    });
    expect(items().ladder).toMatchObject({ out: 3, returned: 0, lost: 1, lostCharge: 0.1 });
    // Several lost records add up, in whole cents (0.1 + 0.2 is 0.3)
    await call("POST", LOST, { operationId: op(), productKey: "ladder", quantity: 1, charge: 0.2 });
    expect(items().ladder).toMatchObject({ lost: 2, lostCharge: 0.3 });
    // Without a charge, only lost moves
    await call("POST", LOST, { operationId: op(), productKey: "ladder", quantity: 1 });
    expect(items().ladder).toMatchObject({ lost: 3, lostCharge: 0.3 });
    expect(stockOf("ladder")).toBe(4);
    expect(movements().map((m) => ({ reason: m.reason, delta: m.delta, tracked: m.tracked, quantity: m.quantity, charge: m.charge, projectId: m.projectId }))).toEqual([
      { reason: "lost", delta: 0, tracked: true, quantity: 1, charge: 0.1, projectId: "s1" },
      { reason: "lost", delta: 0, tracked: true, quantity: 1, charge: 0.2, projectId: "s1" },
      { reason: "lost", delta: 0, tracked: true, quantity: 1, charge: undefined, projectId: "s1" },
    ]);
    // A retry changes nothing and returns the first result
    const again = await call("POST", LOST, { operationId: id, productKey: "ladder", quantity: 1, charge: 0.1 });
    expect(again.body).toMatchObject({ replayed: true, result: res.body.result });
    expect(items().ladder).toMatchObject({ lost: 3 });
    expect(counts.Writes).toBe(3);
  });

  it("records a charge of 0 as a charge, on the line as in the movement", async () => {
    expect(await call("POST", LOST, { operationId: op(), productKey: "ladder", quantity: 1, charge: 0 })).toMatchObject({ status: 200, body: { result: { charge: 0 } } });
    expect(items().ladder).toMatchObject({ lost: 1, lostCharge: 0 });
    expect(movements()[0]).toMatchObject({ reason: "lost", charge: 0 });
    await call("POST", LOST, { operationId: op(), productKey: "ladder", quantity: 1, charge: 12.5 });
    await call("POST", LOST, { operationId: op(), productKey: "ladder", quantity: 1, charge: 0 });
    expect(items().ladder).toMatchObject({ lost: 3, lostCharge: 12.5 });
  });

  it("takes at most what's still out, equipment only, on an open project, and a charge only for a client", async () => {
    await call("POST", RETURN, { operationId: op(), productKey: "ladder", quantity: 2 });
    expect(await call("POST", LOST, { operationId: op(), productKey: "ladder", quantity: 2 })).toMatchObject({ status: 400, body: { error: { message: "Only 1 of this item is still out" } } });
    expect(await call("POST", LOST, { operationId: op(), productKey: "0123", quantity: 1 })).toMatchObject({ status: 400, body: { error: { message: "Only company equipment is recorded as lost or broken" } } });
    expect(await call("POST", LOST, { operationId: op(), productKey: "mat", quantity: 1 })).toMatchObject({ status: 400, body: { error: { message: "This item isn't on this project" } } });
    for (const charge of [-1, 1.005, "5", 1_000_001]) expect((await call("POST", LOST, { operationId: op(), productKey: "ladder", quantity: 1, charge })).status).toBe(400);
    expect((await call("POST", LOST, { operationId: op(), productKey: "ladder", quantity: 0 })).status).toBe(400);
    expect((await call("POST", LOST, { operationId: op(), productKey: "ladder", quantity: 1, note: "x" })).status).toBe(400);
    expect((await call("POST", "/teams/team-a/projects/nope/lost", { operationId: op(), productKey: "ladder", quantity: 1 })).status).toBe(404);
    project({ kind: "adhoc", items: { ladder: { name: "Step ladder", kind: "equipment", out: 1, returned: 0 } } }, "adhoc-1");
    expect(await call("POST", "/teams/team-a/projects/adhoc-1/lost", { operationId: op(), productKey: "ladder", quantity: 1, charge: 5 })).toMatchObject({ status: 400, body: { error: { message: "This project has no client to charge" } } });
    expect(await call("POST", "/teams/team-a/projects/adhoc-1/lost", { operationId: op(), productKey: "ladder", quantity: 1 })).toMatchObject({ status: 200 });
    project({ status: "closed", items: { ladder: { name: "Step ladder", kind: "equipment", out: 1, returned: 0 } } });
    expect(await call("POST", LOST, { operationId: op(), productKey: "ladder", quantity: 1 })).toMatchObject({ status: 409, body: { error: { code: "aborted" } } });
    expect(await call("POST", LOST, { operationId: op(), productKey: "ladder", quantity: 1 }, VIEWER)).toMatchObject({ status: 403, body: { error: { reason: "view_only" } } });
  });

  it("refuses a line whose stored counts or charge aren't usable, and a total charge over the limit", async () => {
    project({ items: { ladder: { name: "Step ladder", kind: "equipment", out: 2, returned: 0, lostCharge: "lots" } } });
    expect(await call("POST", LOST, { operationId: op(), productKey: "ladder", quantity: 1, charge: 1 })).toMatchObject({ status: 400, body: { error: { message: "This line's charge isn't an amount; correct the line first" } } });
    project({ items: { ladder: { name: "Step ladder", kind: "equipment", out: 2, returned: 0, lost: 0.5 } } });
    expect(await call("POST", LOST, { operationId: op(), productKey: "ladder", quantity: 1 })).toMatchObject({ status: 400, body: { error: { message: expect.stringMatching(/whole numbers/) } } });
    project({ items: { ladder: { name: "Step ladder", kind: "equipment", out: 2, returned: 0, lost: 1, lostCharge: 999_999.5 } } });
    expect(await call("POST", LOST, { operationId: op(), productKey: "ladder", quantity: 1, charge: 1 })).toMatchObject({ status: 400, body: { error: { message: "A line's charge can't be more than 1000000" } } });
  });

  it("adds to the charge a concurrent record left, not the one it read", async () => {
    let once = false;
    table.beforeTransactWrite = () => {
      if (once) return;
      once = true;
      const s = table.get("TEAM#team-a", "PROJECT#s1") as Record<string, unknown>;
      table.put({ ...s, version: 2, items: { ...(s.items as object), ladder: { code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120, out: 3, returned: 0, lost: 1, lostCharge: 40 } } });
    };
    expect(await call("POST", LOST, { operationId: op(), productKey: "ladder", quantity: 1, charge: 60 })).toMatchObject({ status: 200 });
    expect(items().ladder).toMatchObject({ lost: 2, lostCharge: 100 });
  });
});

describe("Finished Return with equipment out", () => {
  beforeEach(() => {
    seed();
    project({ items: { ladder: { name: "Step ladder", kind: "equipment", out: 2, returned: 1 }, "0123": { name: "Nitrile gloves", price: 12.5, out: 2, returned: 0 } } });
  });

  it("is refused with 409 equipment_out while any piece is still out, and isn't counted as a write conflict", async () => {
    const res = await patchProject({ status: "closed", closedAt: "2026-10-01T12:00:00.000Z" });
    expect(res).toMatchObject({ status: 409, body: { error: { code: "aborted", reason: "equipment_out", message: "Equipment is still out on this project" } } });
    expect(table.get("TEAM#team-a", "PROJECT#s1")?.status).toBe("open");
    expect(counts.ConditionalWriteConflicts).toBeUndefined();
    // A PUT closing it is refused the same way
    const { PK, SK, type, id, version, ...whole } = table.get("TEAM#team-a", "PROJECT#s1") as Record<string, unknown>;
    void [PK, SK, type, id, version];
    expect(await call("PUT", "/teams/team-a/projects/s1", { data: { ...whole, status: "closed" }, expectedVersion: 1 })).toMatchObject({ status: 409, body: { error: { reason: "equipment_out" } } });
  });

  it("closes once each piece is back or lost; unreturned supplies don't stop it", async () => {
    await call("POST", LOST, { operationId: op(), productKey: "ladder", quantity: 1, charge: 80 });
    expect(await patchProject({ status: "closed" })).toMatchObject({ status: 200, body: { data: { status: "closed" } } });
  });

  it("refuses an edit to a closed project that puts more equipment out, but not other edits to one that already had some out", async () => {
    // Closed before the rule (an imported artifact project, say)
    project({ status: "closed", items: { ladder: { name: "Step ladder", kind: "equipment", out: 2, returned: 1 } } });
    expect(await patchProject({ client: "Echo Ltd" })).toMatchObject({ status: 200 });
    // Its counts stay the commands' (below); a line the write adds can't put more out
    expect(await patchProject({ items: { drill: { name: "Drill", kind: "equipment", out: 1, returned: 0 } } })).toMatchObject({ status: 400, body: { error: { message: expect.stringMatching(/^A new equipment line has nothing out/) } } });
    expect(await patchProject({ items: { drill: { name: "Drill", kind: "equipment", out: 1, returned: 1 } } })).toMatchObject({ status: 200 });
  });
});

describe("project documents and the new fields", () => {
  beforeEach(seed);

  it("take an equipment line, and keep a line's kind as it was first saved", async () => {
    expect(await patchProject({ items: { ladder: { name: "Step ladder", kind: "equipment", out: 0, returned: 0 } } })).toMatchObject({ status: 200 });
    expect(await patchProject({ items: { ladder: { kind: "supply" } } })).toMatchObject({ status: 400, body: { error: { message: 'A line\'s kind is "equipment" or left out' } } });
    await call("POST", CHECKOUT, { operationId: op(), productKey: "0123", quantity: 1 });
    expect(await patchProject({ items: { "0123": { kind: "equipment" } } })).toMatchObject({ status: 400, body: { error: { message: "A line's kind can't change" } } });
    // A PUT can't drop it either
    const whole = { client: "Echo", date: "2026-10-01", status: "open", items: { ...items(), ladder: { name: "Step ladder", out: 1, returned: 0 } } };
    expect(await call("PUT", "/teams/team-a/projects/s1", { data: whole, expectedVersion: projectVersion() })).toMatchObject({ status: 400, body: { error: { message: "A line's kind can't change" } } });
  });

  it("allow lost and a charge on equipment lines only, the charge on a client's project only, and check their types", async () => {
    expect(await patchProject({ items: { ladder: { name: "Step ladder", kind: "equipment", out: 2, returned: 1, lost: 1, lostCharge: 25.5 } } })).toMatchObject({ status: 200 });
    expect(await patchProject({ items: { ladder: { lostCharge: 20 } } })).toMatchObject({ status: 200 });
    const refused = [
      [{ drill: { name: "Drill", kind: "equipment", out: 2, returned: 0, lost: 1.5 } }, "lost is a whole number, on company equipment lines only"],
      [{ drill: { name: "Drill", kind: "equipment", out: 2, returned: 0, lost: -1 } }, "lost is a whole number, on company equipment lines only"],
      [{ gloves: { name: "Gloves", price: 1, out: 1, returned: 0, lost: 1 } }, "lost is a whole number, on company equipment lines only"],
      [{ gloves: { name: "Gloves", price: 1, out: 1, returned: 0, lostCharge: 1 } }, "lostCharge is only on company equipment lines of a client project"],
      [{ ladder: { lostCharge: 1.234 } }, "lostCharge must be an amount from 0 to 1000000 with at most two decimals"],
      [{ drill: { name: "Drill", kind: "equipment", out: 2, returned: 2, lost: 1 } }, "A line's returned and lost can't add up to more than its out"],
    ] as const;
    for (const [lines, message] of refused) expect(await patchProject({ items: lines }), message).toMatchObject({ status: 400, body: { error: { message } } });
    project({ kind: "adhoc", items: { ladder: { name: "Step ladder", kind: "equipment", out: 1, returned: 0 } } }, "adhoc-1");
    expect(await call("PATCH", "/teams/team-a/projects/adhoc-1", { data: { items: { drill: { name: "Drill", kind: "equipment", out: 1, returned: 0, lost: 1 } } }, expectedVersion: 1 })).toMatchObject({ status: 200 });
    expect(await call("PATCH", "/teams/team-a/projects/adhoc-1", { data: { items: { ladder: { lostCharge: 5 } } }, expectedVersion: 2 })).toMatchObject({ status: 400 });
  });

  it("leave who took equipment and when to the checkout command: a write may only repeat them", async () => {
    const takenAt = "2026-10-01T12:00:00.000Z";
    for (const [field, value] of [["takenBy", "Sam"], ["takenAt", takenAt], ["priceSetBy", OWNER], ["priceSetAt", takenAt]] as const) {
      expect(await patchProject({ items: { ladder: { name: "Step ladder", kind: "equipment", out: 1, returned: 0, [field]: value } } }), field).toMatchObject({ status: 400, body: { error: { message: `${field} is set by the server` } } });
    }
    await call("POST", CHECKOUT, { operationId: op(), productKey: "ladder", quantity: 1 });
    expect(items().ladder).toMatchObject({ takenBy: CONTRIBUTOR, takenAt });
    expect(await patchProject({ items: { ladder: { takenBy: OWNER } } })).toMatchObject({ status: 400, body: { error: { message: "takenBy is set by the server" } } });
    expect(await patchProject({ items: { ladder: { takenAt: "2026-10-02T08:00:00.000Z" } } })).toMatchObject({ status: 400, body: { error: { message: "takenAt is set by the server" } } });
    // Repeating them (a PATCH of other fields, or a PUT of the project as read) is fine; dropping them isn't
    expect(await patchProject({ items: { ladder: { name: "Ladder", takenBy: CONTRIBUTOR } } })).toMatchObject({ status: 200 });
    const whole = { client: "Echo", date: "2026-10-01", status: "open", items: items() };
    expect(await call("PUT", "/teams/team-a/projects/s1", { data: whole, expectedVersion: projectVersion() })).toMatchObject({ status: 200 });
    const { takenBy, ...dropped } = items().ladder as Line;
    void takenBy;
    expect(await call("PUT", "/teams/team-a/projects/s1", { data: { ...whole, items: { ladder: dropped } }, expectedVersion: projectVersion() })).toMatchObject({ status: 400, body: { error: { message: "takenBy is set by the server" } } });
  });

  it("refuse a line that isn't an object, except null, which removes it, or a legacy value carried over unchanged", async () => {
    const bought = { name: "Step ladder", price: 150, cost: 120, purchased: true, priceSet: "markup", out: 1, returned: 0 };
    project({ items: { "ladder:bought": bought, "0123": { name: "Gloves", price: 1, out: 1, returned: 0 }, odd: "legacy" } });
    for (const value of ["x", 0, true, [], [bought]]) {
      for (const key of ["ladder:bought", "0123", "new"]) {
        expect(await patchProject({ items: { [key]: value } }), `${key} ${JSON.stringify(value)}`).toMatchObject({ status: 400, body: { error: { message: "A line is a JSON object, or null to remove it" } } });
      }
    }
    const whole = () => ({ client: "Echo", date: "2026-10-01", status: "open", items: items() });
    expect(await call("PUT", "/teams/team-a/projects/s1", { data: { ...whole(), items: { ...items(), "0123": "gone" } }, expectedVersion: projectVersion() })).toMatchObject({ status: 400 });
    expect(items()["ladder:bought"]).toEqual(bought);
    // The legacy value, unchanged, doesn't block a PATCH or a PUT; changed, it's refused
    expect(await patchProject({ client: "Echo 2" })).toMatchObject({ status: 200 });
    expect(await call("PUT", "/teams/team-a/projects/s1", { data: whole(), expectedVersion: projectVersion() })).toMatchObject({ status: 200 });
    expect(await patchProject({ items: { odd: "other" } })).toMatchObject({ status: 400 });
    // null removes a line, a bought one too, and isn't stored
    expect(await patchProject({ items: { "ladder:bought": null, odd: null } })).toMatchObject({ status: 200 });
    expect(Object.keys(items())).toEqual(["0123"]);
    // A PUT with a null line (as read before nulls were dropped) leaves it out
    expect(await call("PUT", "/teams/team-a/projects/s1", { data: { ...whole(), items: { ...items(), gone: null } }, expectedVersion: projectVersion() })).toMatchObject({ status: 200 });
    expect(Object.keys(items())).toEqual(["0123"]);
  });

  it("refuse removing an equipment line with something still out, as closing the project is, by PATCH or PUT", async () => {
    project({ items: { ladder: { name: "Step ladder", kind: "equipment", out: 3, returned: 1, lost: 1 }, "0123": { name: "Gloves", price: 1, out: 1, returned: 0 } } });
    const removing = { status: 409, body: { error: { code: "aborted", reason: "equipment_out", message: "Equipment is still out on this line: return it or mark it lost before removing it" } } };
    expect(await patchProject({ items: { ladder: null } })).toMatchObject(removing);
    const { ladder, ...rest } = items();
    const whole = { client: "Echo", date: "2026-10-01", status: "open" };
    expect(await call("PUT", "/teams/team-a/projects/s1", { data: { ...whole, items: rest }, expectedVersion: projectVersion() })).toMatchObject(removing);
    expect(await call("PUT", "/teams/team-a/projects/s1", { data: whole, expectedVersion: projectVersion() })).toMatchObject(removing);
    expect(items().ladder).toEqual(ladder);
    expect(counts.ConditionalWriteConflicts).toBeUndefined();
    // A supply line goes whatever is out; the equipment line once every piece is back or lost
    expect(await patchProject({ items: { "0123": null } })).toMatchObject({ status: 200 });
    expect(await call("POST", RETURN, { operationId: op(), productKey: "ladder", quantity: 1 })).toMatchObject({ status: 200 });
    expect(await patchProject({ items: { ladder: null } })).toMatchObject({ status: 200 });
    expect(items()).toEqual({});
  });

  it("leave an equipment line's counts to the commands: a write may only repeat them, so two writes can't remove or close past what's out", async () => {
    project({ items: { ladder: { name: "Step ladder", kind: "equipment", out: 3, returned: 1, lost: 1 }, drill: { name: "Drill", kind: "equipment", out: 1 }, "0123": { name: "Gloves", price: 1, out: 2, returned: 0 } } });
    const changing = { status: 400, body: { error: { code: "bad_request", message: "An equipment line's out, returned and lost change only through checkout, return, lost and move (POST .../projects/{projectId}/checkout, /return, /lost, /move)" } } };
    const v = projectVersion();
    for (const ladder of [{ out: 1 }, { out: 0 }, { out: 4 }, { returned: 2 }, { returned: 0 }, { lost: 2 }, { lost: 0 }, { lost: null }, { out: 2, returned: 0, lost: 0 }]) {
      expect(await patchProject({ items: { ladder } }), JSON.stringify(ladder)).toMatchObject(changing);
    }
    // A PUT that changes or drops one is refused too
    const whole = () => ({ client: "Echo", date: "2026-10-01", status: "open", items: items() });
    const { lost, ...noLost } = items().ladder as Line;
    void lost;
    expect(await call("PUT", "/teams/team-a/projects/s1", { data: { ...whole(), items: { ...items(), ladder: noLost } }, expectedVersion: v })).toMatchObject(changing);
    expect(await call("PUT", "/teams/team-a/projects/s1", { data: { ...whole(), items: { ...items(), drill: { name: "Drill", kind: "equipment", out: 0 } } }, expectedVersion: v })).toMatchObject(changing);
    // The trick from the #673 review: out 0, then removing or closing, never gets past the first write
    expect(await patchProject({ items: { drill: { out: 0 } } })).toMatchObject(changing);
    expect(await patchProject({ status: "closed" })).toMatchObject({ status: 409, body: { error: { reason: "equipment_out" } } });
    expect(projectVersion()).toBe(v);
    expect(items().ladder).toMatchObject({ out: 3, returned: 1, lost: 1 });
    // Repeating them is fine (the app's PUT of the project as read, or a PATCH of the line's name),
    // and so is 0 for a count stored as missing; a supply line's counts are still edited by hand
    expect(await call("PUT", "/teams/team-a/projects/s1", { data: whole(), expectedVersion: v })).toMatchObject({ status: 200 });
    expect(await patchProject({ items: { ladder: { name: "Ladder", out: 3, returned: 1, lost: 1 }, drill: { returned: 0, lost: 0 } } })).toMatchObject({ status: 200 });
    expect(await patchProject({ items: { "0123": { out: 5, returned: 1 } } })).toMatchObject({ status: 200 });
    expect(items()).toMatchObject({ ladder: { name: "Ladder", out: 3, returned: 1, lost: 1 }, drill: { out: 1, returned: 0, lost: 0 }, "0123": { out: 5, returned: 1 } });
  });

  it("add an equipment line by a write only with nothing out, so equipment goes out only through the commands (supply-checkout-1dg.18)", async () => {
    const adding = { status: 400, body: { error: { code: "bad_request", message: "A new equipment line has nothing out: equipment goes out only through checkout, quick take and move (POST .../projects/{projectId}/checkout, /adhoc/checkout, .../projects/{projectId}/move)" } } };
    const v = projectVersion();
    for (const ladder of [{ out: 1 }, { out: 3, returned: 1 }, { out: 3, returned: 1, lost: 1 }, { out: "1" }, { out: 1.5, returned: 1.5 }, { returned: -1 }, { out: null }, { out: 1, returned: "1" }, {}, { returned: 0 }]) {
      expect(await patchProject({ items: { ladder: { name: "Step ladder", kind: "equipment", ...ladder } } }), JSON.stringify(ladder)).toMatchObject(adding);
    }
    // A PUT, of a new project too
    const whole = { client: "Echo", date: "2026-10-01", status: "open", items: { ladder: { name: "Step ladder", kind: "equipment", out: 2, returned: 0 } } };
    expect(await call("PUT", "/teams/team-a/projects/s1", { data: whole, expectedVersion: v })).toMatchObject(adding);
    expect(await call("PUT", "/teams/team-a/projects/s9", { data: whole, expectedVersion: 0 })).toMatchObject(adding);
    // The phantom stock from the #680 review: nothing out by a write, so a return finds nothing to bring back
    expect(await call("POST", RETURN, { operationId: op(), productKey: "ladder", quantity: 2 })).toMatchObject({ status: 400 });
    expect(stockOf("ladder")).toBe(ladder.stock);
    expect(projectVersion()).toBe(v);
    // Nothing out is fine: zeros, or every piece back or lost; and a supply line's counts are the write's
    for (const [key, line] of [["ladder", { out: 0 }], ["drill", { out: 0, returned: 0, lost: 0 }], ["saw", { out: 3, returned: 2, lost: 1 }]] as const) {
      expect(await patchProject({ items: { [key]: { name: key, kind: "equipment", ...line } } }), key).toMatchObject({ status: 200 });
    }
    expect(await patchProject({ items: { tape: { name: "Tape", price: 2, out: 4, returned: 0 } } })).toMatchObject({ status: 200 });
    // A line removed and written again is a new line
    expect(await patchProject({ items: { drill: null } })).toMatchObject({ status: 200 });
    expect(await patchProject({ items: { drill: { name: "Drill", kind: "equipment", out: 1 } } })).toMatchObject(adding);
    // Taking one is a checkout, which moves stock and records it
    expect(await call("POST", CHECKOUT, { operationId: op(), productKey: "ladder", quantity: 1 })).toMatchObject({ status: 200 });
    expect(items().ladder).toMatchObject({ kind: "equipment", out: 1 });
    expect(stockOf("ladder")).toBe(ladder.stock - 1);
  });

  it("add a line only of its item's kind, so a supply line can't return phantom equipment stock (supply-checkout-1dg.19)", async () => {
    const supplyLine = { status: 400, body: { error: { code: "bad_request", message: "This item is company equipment, so a new line for it is too: it goes on the project through checkout (POST .../projects/{projectId}/checkout)" } } };
    const equipmentLine = { status: 400, body: { error: { code: "bad_request", message: "This item is a supply, so a new line for it has no kind" } } };
    const v = projectVersion();
    // The #690 review: a supply line under the ladder's key, with 2 out, that a return would add to stock
    expect(await patchProject({ items: { ladder: { name: "Step ladder", out: 2, returned: 0 } } })).toMatchObject(supplyLine);
    expect(await patchProject({ items: { ladder: { name: "Step ladder", out: 0 } } })).toMatchObject(supplyLine);
    const whole = { client: "Echo", date: "2026-10-01", status: "open", items: { ladder: { name: "Step ladder", out: 2, returned: 0 } } };
    expect(await call("PUT", "/teams/team-a/projects/s1", { data: whole, expectedVersion: v })).toMatchObject(supplyLine);
    expect(await call("PUT", "/teams/team-a/projects/s9", { data: whole, expectedVersion: 0 })).toMatchObject(supplyLine);
    expect(await call("POST", RETURN, { operationId: op(), productKey: "ladder", quantity: 2 })).toMatchObject({ status: 400 });
    expect(stockOf("ladder")).toBe(ladder.stock);
    // An equipment line under a supply, even with nothing out
    expect(await patchProject({ items: { "0123": { name: "Nitrile gloves", kind: "equipment", out: 0 } } })).toMatchObject(equipmentLine);
    // One bad line refuses the whole write, among many lines read a few at a time
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, n) => [`one-off-${n}`, { name: `One-off ${n}`, price: 1, out: 1, returned: 0 }]));
    expect(await patchProject({ items: { ...many, ladder: { name: "Step ladder", out: 1 } } })).toMatchObject(supplyLine);
    expect(projectVersion()).toBe(v);
    // A supply product with no kind, a key that's no item (a one-off, or deleted), and a key no item could have are fine
    expect(await patchProject({ items: { ...many, "0123": { name: "Nitrile gloves", price: 12.5, out: 3, returned: 0 }, drill: { name: "Drill", kind: "equipment", out: 0 }, ["k".repeat(300)]: { name: "Long", price: 1, out: 1 } } })).toMatchObject({ status: 200 });
    // At most MAX_NEW_LINES added by one write; lines already there don't count
    const lots = (n: number, from = 0) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`bulk-${from + i}`, { name: "Bulk", price: 1, out: 1 }]));
    expect(await patchProject({ items: lots(MAX_NEW_LINES + 1) })).toMatchObject({ status: 400, body: { error: { message: `A write adds at most ${MAX_NEW_LINES} lines to a project` } } });
    expect(await patchProject({ items: lots(MAX_NEW_LINES) })).toMatchObject({ status: 200 });
    expect(await patchProject({ items: { ...lots(MAX_NEW_LINES), ...lots(1, MAX_NEW_LINES) } })).toMatchObject({ status: 200 });
    // An equipment line taken by checkout, then edited by a write, is not new
    expect(await call("POST", CHECKOUT, { operationId: op(), productKey: "ladder", quantity: 1 })).toMatchObject({ status: 200 });
    expect(await patchProject({ items: { ladder: { name: "Ladder (tall)" } } })).toMatchObject({ status: 200 });
  });

  it("keep a line as it was taken when its item's kind changes, and return it by the line (ADR 0017, decision 8)", async () => {
    project({ items: { "0123": { code: "0123", name: "Nitrile gloves", price: 12.5, out: 3, returned: 0 } } });
    product("0123", { ...gloves, kind: "equipment" }, 2);
    // The supply line is already there: a write may still change its counts, and a return puts them back
    expect(await patchProject({ items: { "0123": { out: 4 } } })).toMatchObject({ status: 200 });
    expect(await call("POST", RETURN, { operationId: op(), productKey: "0123", quantity: 2 })).toMatchObject({ status: 200 });
    expect(items()["0123"]).toMatchObject({ out: 4, returned: 2 });
    expect(items()["0123"]?.kind).toBeUndefined();
    expect(stockOf("0123")).toBe(gloves.stock + 2);
  });

  it("don't hold a line the write doesn't change to returned + lost <= out", async () => {
    project({ items: { odd: { name: "Odd", price: 1, out: 1, returned: 3 } } });
    expect(await patchProject({ client: "Echo 2" })).toMatchObject({ status: 200 });
  });

  it("can't set a project's kind: only the server makes a General Use project", async () => {
    expect(await call("PUT", "/teams/team-a/projects/s2", { data: { client: "Van", date: "2026-10-01", kind: "adhoc", items: {} }, expectedVersion: 0 })).toMatchObject({ status: 400, body: { error: { message: "A project's kind is set by the server" } } });
    expect(await patchProject({ kind: "adhoc" })).toMatchObject({ status: 400 });
    project({ kind: "adhoc" }, "adhoc-1");
    expect(await call("PATCH", "/teams/team-a/projects/adhoc-1", { data: { kind: "job" }, expectedVersion: 1 })).toMatchObject({ status: 400 });
    expect(await call("PUT", "/teams/team-a/projects/adhoc-1", { data: { client: "", date: "2026-10-01", items: {} }, expectedVersion: 1 })).toMatchObject({ status: 400 });
    expect(await call("PATCH", "/teams/team-a/projects/adhoc-1", { data: { date: "2026-10-02" }, expectedVersion: 1 })).toMatchObject({ status: 200 });
  });

  it("can't add a line bought for the client, or mark or unmark one; a changed price is recorded as typed", async () => {
    const bought = { name: "Step ladder", price: 150, cost: 120, purchased: true, out: 1, returned: 0 };
    expect(await patchProject({ items: { "ladder:bought": bought } })).toMatchObject({ status: 400, body: { error: { message: expect.stringMatching(/Only a receipt's lines/) } } });
    expect(await patchProject({ items: { other: bought } })).toMatchObject({ status: 400 });
    expect(await patchProject({ items: { "ladder:bought": { ...bought, purchased: undefined } } })).toMatchObject({ status: 400 });
    expect(await call("PUT", "/teams/team-a/projects/s3", { data: { client: "New", date: "2026-10-01", items: { "x:bought": bought } }, expectedVersion: 0 })).toMatchObject({ status: 400 });

    project({ items: { "ladder:bought": { ...bought, priceSet: "markup" }, "0123": { name: "Gloves", price: 1, out: 1, returned: 0 } } });
    expect(await patchProject({ items: { "ladder:bought": { purchased: false } } })).toMatchObject({ status: 400, body: { error: { message: "purchased is true or left out" } } });
    expect(await patchProject({ items: { "0123": { purchased: true } } })).toMatchObject({ status: 400 });
    expect(await patchProject({ items: { "ladder:bought": { kind: "equipment" } } })).toMatchObject({ status: 400 });
    expect(await patchProject({ items: { "0123": { priceSet: "manual" } } })).toMatchObject({ status: 400, body: { error: { message: "priceSet is set by the server, on lines bought for the client" } } });
    expect(await patchProject({ items: { "ladder:bought": { priceSet: "typed" } } })).toMatchObject({ status: 400 });
    // Counts change freely; a priceSet sent without a price change stays the server's
    expect(await patchProject({ items: { "ladder:bought": { out: 2, priceSet: "manual" } } })).toMatchObject({ status: 200, body: { data: { items: { "ladder:bought": { out: 2, priceSet: "markup" } } } } });
    // Nothing of it comes back
    for (const returned of [1, -1, "0", null]) {
      expect(await patchProject({ items: { "ladder:bought": { returned } } }), String(returned)).toMatchObject({ status: 400, body: { error: { message: "Nothing bought for the client comes back, so its returned stays 0" } } });
    }
    // A changed price is a typed one, stamped with who typed it and when
    clock += 60_000;
    expect(await patchProject({ items: { "ladder:bought": { price: 140 } } }, OWNER)).toMatchObject({ status: 200, body: { data: { items: { "ladder:bought": { price: 140, priceSet: "manual", priceSetBy: OWNER, priceSetAt: "2026-10-01T12:01:00.000Z" } } } } });
    expect(await patchProject({ items: { "ladder:bought": { priceSetBy: CONTRIBUTOR } } })).toMatchObject({ status: 400, body: { error: { message: "priceSetBy is set by the server" } } });
    // Typed again by someone else: their name now
    clock += 60_000;
    expect(await patchProject({ items: { "ladder:bought": { price: 141 } } })).toMatchObject({ status: 200, body: { data: { items: { "ladder:bought": { price: 141, priceSetBy: CONTRIBUTOR, priceSetAt: "2026-10-01T12:02:00.000Z" } } } } });
    // Re-saving a price from before the money rule rounds it, but nobody typed it
    project({ items: { "ladder:bought": { name: "Step ladder", price: 150.005, cost: 120, purchased: true, priceSet: "markup", out: 1, returned: 0 } } });
    const legacy = await patchProject({ items: { "ladder:bought": { out: 2 } } });
    expect(legacy.body.data.items["ladder:bought"]).toMatchObject({ price: 150.01, priceSet: "markup", out: 2 });
    expect(legacy.body.data.items["ladder:bought"].priceSetBy).toBeUndefined();
    // One without a priceSet (written before it) stays without one until its price changes
    project({ items: { "ladder:bought": bought } });
    const kept = await patchProject({ items: { "ladder:bought": { out: 3 } } });
    expect(kept.status).toBe(200);
    expect(kept.body.data.items["ladder:bought"].priceSet).toBeUndefined();
  });
});

describe("equipment bought on a receipt for a client", () => {
  beforeEach(() => {
    seed();
    product("mat", { code: "", name: "Cutting mat", kind: "equipment", cost: 30 });
  });
  const boughtLine = (key = "ladder") => items()[`${key}:bought`];

  it("goes on its own charged line at the receipt price plus the team's markup, worked out on the server, and moves no stock", async () => {
    setMarkup(25);
    const res = await call("POST", LINES, { operationId: op(), lines: [{ productKey: "ladder", quantity: 1, name: "Step ladder", code: "LAD-1", cost: 99.99 }, { productKey: "0123", quantity: 2, name: "Gloves", price: 12.5, cost: 9 }] });
    expect(res).toMatchObject({
      status: 200,
      body: {
        result: {
          lines: [
            { productKey: "ladder", quantity: 1, lineCreated: true, lineKey: "ladder:bought", purchased: true },
            { productKey: "0123", quantity: 2, lineCreated: true },
          ],
        },
      },
    });
    // 99.99 × 1.25 = 124.9875, rounded to the cent
    expect(boughtLine()).toEqual({ code: "LAD-1", name: "Step ladder", cost: 99.99, price: 124.99, purchased: true, priceSet: "markup", out: 1, returned: 0 });
    expect(items()["0123"]).toEqual({ code: "", name: "Gloves", price: 12.5, cost: 9, out: 2, returned: 0 });
    expect(items().ladder).toBeUndefined();
    expect(stockOf("ladder")).toBe(4);
    expect(movements()).toEqual([]);
    // Nothing in the response gives the percentage away
    expect(res.text).not.toMatch(/markup"?:\s*25|equipmentMarkup/);
  });

  it("rounds halves up, works from a pack's price each, and bills the receipt price at 0% when no markup was ever set", async () => {
    await call("POST", LINES, { operationId: op(), lines: [{ productKey: "ladder", quantity: 1, name: "Step ladder", cost: 120 }] });
    expect(boughtLine()).toMatchObject({ price: 120, priceSet: "markup" });
    setMarkup(1);
    // 0.5 × 1.01 = 0.505: half a cent, up
    await call("POST", "/teams/team-a/projects/s2/lines", { operationId: op(), lines: [{ productKey: "mat", quantity: 1, name: "Cutting mat", cost: 0.5 }] }).then((r) => expect(r.status).toBe(404));
    project({}, "s2");
    await call("POST", "/teams/team-a/projects/s2/lines", { operationId: op(), lines: [{ productKey: "mat", quantity: 1, name: "Cutting mat", cost: 0.5 }] });
    expect(items("s2")["mat:bought"]).toMatchObject({ price: 0.51, cost: 0.5 });
    // A pack of 12 for $14.76 is 1.23 each (the app divides); 1.23 × 1.25 = 1.5375
    setMarkup(25);
    project({}, "s3");
    await call("POST", "/teams/team-a/projects/s3/lines", { operationId: op(), lines: [{ productKey: "mat", quantity: 12, name: "Cutting mat", cost: 1.23 }] });
    expect(items("s3")["mat:bought"]).toMatchObject({ price: 1.54, cost: 1.23, out: 12 });
  });

  it("saves a typed price as manual, and refuses a price sent as the markup's", async () => {
    setMarkup(25);
    const typed = await call("POST", LINES, { operationId: op(), lines: [{ productKey: "ladder", quantity: 1, name: "Step ladder", cost: 100, price: 135, priceSet: "manual" }] }, OWNER);
    expect(typed.status).toBe(200);
    // Who typed it and when stay on the line after the operation record expires
    expect(boughtLine()).toMatchObject({ price: 135, cost: 100, priceSet: "manual", purchased: true, priceSetBy: OWNER, priceSetAt: "2026-10-01T12:00:00.000Z" });
    const refused = [
      [{ productKey: "mat", quantity: 1, name: "Mat", cost: 30, price: 37.5 }, /leave its price out/],
      [{ productKey: "mat", quantity: 1, name: "Mat", cost: 30, price: 37.5, priceSet: "markup" }, /priceSet is "manual"/],
      [{ productKey: "mat", quantity: 1, name: "Mat", cost: 30, priceSet: "manual" }, /needs its price/],
      [{ productKey: "mat", quantity: 1, name: "Mat" }, /receipt price each, as cost/],
      [{ productKey: "mat:bought", quantity: 1, name: "Mat", cost: 30 }, /own key/],
      [{ productKey: "0123", quantity: 1, name: "Gloves" }, /price must be an amount/],
    ] as const;
    for (const [line, message] of refused) expect(await call("POST", LINES, { operationId: op(), lines: [line] })).toMatchObject({ status: 400, body: { error: { message: expect.stringMatching(message) } } });
    // A typed price on a supply is simply its price
    await call("POST", LINES, { operationId: op(), lines: [{ productKey: "0123", quantity: 1, name: "Gloves", price: 11, priceSet: "manual" }] });
    expect(items()["0123"]).toEqual({ code: "", name: "Gloves", price: 11, out: 1, returned: 0 });
    // A markup price over the money limit is refused rather than stored
    setMarkup(1000);
    expect(await call("POST", LINES, { operationId: op(), lines: [{ productKey: "mat", quantity: 1, name: "Mat", cost: 999_999 }] })).toMatchObject({ status: 400, body: { error: { message: expect.stringMatching(/type a price instead/) } } });
  });

  it("adds a second receipt to the bought line at its first price, apart from the same item on loan", async () => {
    setMarkup(25);
    await call("POST", CHECKOUT, { operationId: op(), productKey: "ladder", quantity: 1 });
    await call("POST", LINES, { operationId: op(), lines: [{ productKey: "ladder", quantity: 1, name: "Step ladder", cost: 100 }] });
    setMarkup(50, 2);
    const second = await call("POST", LINES, { operationId: op(), lines: [{ productKey: "ladder", quantity: 2, name: "Step ladder", cost: 110 }] });
    expect(second.body.result.lines).toEqual([{ productKey: "ladder", quantity: 2, lineCreated: false, lineKey: "ladder:bought", purchased: true }]);
    expect(items().ladder).toMatchObject({ kind: "equipment", out: 1 });
    expect(boughtLine()).toMatchObject({ price: 125, cost: 100, out: 3, purchased: true });
    expect(stockOf("ladder")).toBe(3);
  });

  it("prices with the markup the transaction commits with, when an owner changes it meanwhile", async () => {
    setMarkup(10);
    let once = false;
    table.beforeTransactWrite = () => {
      if (once) return;
      once = true;
      setMarkup(20, 2);
    };
    expect((await call("POST", LINES, { operationId: op(), lines: [{ productKey: "ladder", quantity: 1, name: "Step ladder", cost: 100 }] })).status).toBe(200);
    expect(boughtLine()).toMatchObject({ price: 120 });
  });

  it("follows the item's kind as the transaction commits, when someone changes it meanwhile", async () => {
    let once = false;
    table.beforeTransactWrite = () => {
      if (once) return;
      once = true;
      product("0123", { ...gloves, kind: "equipment" }, 2);
    };
    // Sent as a supply with its price; by the retry it's equipment, priced only by the server
    expect(await call("POST", LINES, { operationId: op(), lines: [{ productKey: "0123", quantity: 1, name: "Gloves", price: 12.5, cost: 9 }] })).toMatchObject({ status: 400, body: { error: { message: expect.stringMatching(/leave its price out/) } } });
    expect(items()).toEqual({});
    once = false;
    table.beforeTransactWrite = () => {
      if (once) return;
      once = true;
      product("ladder", { ...ladder, kind: "supply", price: 5 }, 2);
    };
    expect((await call("POST", LINES, { operationId: op(), lines: [{ productKey: "ladder", quantity: 1, name: "Step ladder", cost: 100, price: 130, priceSet: "manual" }] })).status).toBe(200);
    expect(items()).toEqual({ ladder: { code: "", name: "Step ladder", price: 130, cost: 100, out: 1, returned: 0 } });
  });
});

describe("team settings", () => {
  it("an owner reads 0% until they set it, then saves it with expectedVersion, audited with the old and new value", async () => {
    expect(await call("GET", SETTINGS, undefined, OWNER)).toMatchObject({ status: 200, body: { version: 0, settings: { equipmentMarkup: 0 } } });
    const saved = await call("PUT", SETTINGS, { equipmentMarkup: 25, expectedVersion: 0 }, OWNER);
    expect(saved).toMatchObject({ status: 200, body: { version: 1, settings: { equipmentMarkup: 25 } } });
    expect(settingsItem()).toMatchObject({ type: "settings", equipmentMarkup: 25, version: 1, updatedBy: OWNER, updatedAt: "2026-10-01T12:00:00.000Z" });
    expect(audits()).toEqual([expect.objectContaining({ type: "audit", userId: OWNER, action: "settings.equipment-markup", detail: { from: 0, to: 25 }, ts: "2026-10-01T12:00:00.000Z" })]);
    expect(await call("PUT", SETTINGS, { equipmentMarkup: 30, expectedVersion: 0 }, OWNER)).toMatchObject({ status: 409, body: { error: { code: "aborted" } } });
    expect(await call("PUT", SETTINGS, { equipmentMarkup: 12.75, expectedVersion: 1 }, OWNER)).toMatchObject({ status: 200, body: { version: 2, settings: { equipmentMarkup: 12.75 } } });
    // Saving the same value again isn't a change to audit
    expect(await call("PUT", SETTINGS, { equipmentMarkup: 12.75, expectedVersion: 2 }, OWNER)).toMatchObject({ status: 200, body: { version: 3 } });
    expect(audits().map((a) => a.detail)).toEqual([
      { from: 0, to: 25 },
      { from: 25, to: 12.75 },
    ]);
    expect(await call("GET", SETTINGS, undefined, OWNER)).toMatchObject({ body: { version: 3, settings: { equipmentMarkup: 12.75 } } });
  });

  it("takes a percentage from 0 to 1,000 with at most two decimals, and nothing else", async () => {
    for (const equipmentMarkup of [-1, 1000.01, 1.234, "25", null, Number.NaN]) {
      expect((await call("PUT", SETTINGS, { equipmentMarkup, expectedVersion: 0 }, OWNER)).status, String(equipmentMarkup)).toBe(400);
    }
    expect((await call("PUT", SETTINGS, { equipmentMarkup: 5 }, OWNER)).status).toBe(400);
    expect((await call("PUT", SETTINGS, { equipmentMarkup: 5, expectedVersion: 0, supplyMarkup: 5 }, OWNER)).status).toBe(400);
    expect(await call("PUT", SETTINGS, { equipmentMarkup: 1000, expectedVersion: 0 }, OWNER)).toMatchObject({ status: 200 });
    expect(await call("PUT", SETTINGS, { equipmentMarkup: 0, expectedVersion: 1 }, OWNER)).toMatchObject({ status: 200 });
  });

  it("reads a stored markup that isn't a usable percentage as 0%", async () => {
    table.put({ PK: "TEAM#team-a", SK: "SETTINGS", type: "settings", equipmentMarkup: "lots", version: 4 });
    expect(await call("GET", SETTINGS, undefined, OWNER)).toMatchObject({ body: { version: 4, settings: { equipmentMarkup: 0 } } });
  });

  it("only owners change it: contributors and viewers get owners_only and nothing is written", async () => {
    for (const user of [CONTRIBUTOR, VIEWER]) {
      expect(await call("PUT", SETTINGS, { equipmentMarkup: 50, expectedVersion: 0 }, user)).toMatchObject({ status: 403, body: { error: { code: "permission_denied", reason: "owners_only" } } });
    }
    expect(settingsItem()).toBeUndefined();
    expect(audits()).toEqual([]);
  });

  it("never reaches a contributor or viewer, in any response they get", async () => {
    seed();
    setMarkup(37.77);
    project({ items: { ladder: { name: "Step ladder", kind: "equipment", out: 1, returned: 0 } } });
    const bodies: string[] = [];
    for (const user of [CONTRIBUTOR, VIEWER]) {
      const mine = await call("GET", SETTINGS, undefined, user);
      // Not even the version: whether an owner ever saved them isn't theirs to know
      expect(mine).toMatchObject({ status: 200 });
      expect(mine.body).toEqual({ settings: {} });
      bodies.push(mine.text);
      for (const path of ["/teams/team-a/products", "/teams/team-a/projects", "/teams/team-a/projects/s1", "/teams/team-a/products/ladder", "/teams/team-a/products/ladder/movements"]) {
        bodies.push((await call("GET", path, undefined, user)).text);
      }
    }
    const lines = await call("POST", LINES, { operationId: op(), lines: [{ productKey: "ladder", quantity: 1, name: "Step ladder", cost: 80 }] }, CONTRIBUTOR);
    expect(lines.status).toBe(200);
    bodies.push(lines.text, (await call("POST", LOST, { operationId: op(), productKey: "ladder", quantity: 1 }, CONTRIBUTOR)).text);
    for (const text of bodies) {
      expect(text).not.toContain("equipmentMarkup");
      expect(text).not.toContain("37.77");
    }
    // The price it gave (80 × 1.3777) is everyone's to see, as for any line
    expect(boughtPrice()).toBe(110.22);
  });
});

const boughtPrice = () => items()["ladder:bought"]?.price;
