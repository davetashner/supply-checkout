// The one-time artifact import (src/data/artifact-import.ts) and its CLI
// (scripts/import-artifact.ts). The fixture is a fictional export made with
// the artifact's own exporter (allJson in src/export.js), legacy values
// included: prices and costs with more than two decimals, a stock stored as
// text, marks of recent saves, a "constructor" key, and claude.ai user IDs.
// The parsing tests run anywhere; the ones that write run against DynamoDB
// Local (CI; locally, npm run test:ddb -- test/artifact-import.test.ts).

import { readFileSync } from "node:fs";
import { GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { authorizeTeam, closeTeam, ConflictError, createTeam, type Db, ForbiddenError, getDocument, InvalidInputError, listDocuments, listMovements, quickTake, setDocument, TeamClosedError, type TeamContext } from "../src/data/index.js";
import { connection, dbFromConnection } from "../src/data/client.js";
import { keys } from "../src/data/keys.js";
import { legacy } from "../src/data/legacy-sheets.js";
import {
  applyArtifactImport,
  MAX_EXPORT_BYTES,
  MAX_EXPORT_PRODUCTS,
  MAX_EXPORT_PROJECTS,
  parseArtifactExport,
  planArtifactImport,
  projectTotals,
  verifyArtifactImport,
} from "../src/data/artifact-import.js";
import { main, readExportFile, USAGE } from "../scripts/import-artifact.js";
import { contextFor, endpoint, newUser, offlineDb, REGION, useTable } from "./helpers.js";

const FIXTURE = readFileSync(new URL("./fixtures/artifact-export.json", import.meta.url), "utf8");
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test data
const fixture = (): Json => JSON.parse(FIXTURE);
const edited = (edit: (doc: Json) => void) => {
  const doc = fixture();
  edit(doc);
  return JSON.stringify(doc);
};

describe("parseArtifactExport", () => {
  it("maps the fixture per ADR 0014 and checks every project against its exported totals", () => {
    const p = parseArtifactExport(FIXTURE);
    expect(p.errors).toEqual([]);
    expect(p.exportedAt).toBe("2026-08-03T09:00:00.000Z");
    expect(p.products).toHaveLength(10);
    expect(p.projects).toHaveLength(4);
    const byKey = Object.fromEntries(p.products.map((x) => [x.key, x]));
    // Money rounded to cents, halves up (2.499 → 2.5, 9.989 → 9.99, 3.333 → 3.33)
    expect(byKey["070382000181"]).toEqual({ key: "070382000181", code: "070382000181", name: "Microfiber cloths, 12 pack", price: 2.5, stock: 40, updatedAt: "2026-08-01T15:04:05.000Z" });
    expect(byKey["041167066218"]).toMatchObject({ price: 12.5, cost: 9.99, packSize: 1, stock: 0 });
    // A stock stored as text is no count (hasStock), and the marks of recent saves are gone
    expect(byKey["p-legacy-stock"]).toEqual({ key: "p-legacy-stock", code: "", name: "Sponges, 3 pack", price: 3.33, updatedAt: "2026-08-01T15:04:05.000Z" });
    expect(byKey["012345678905"]).not.toHaveProperty("ops");
    expect(byKey.constructor).toMatchObject({ code: "constructor", stock: 2 });
    expect(p.ignoredFields).toEqual({});

    const [first, second, third] = p.projects;
    expect(first).toMatchObject({ id: "Sh7Qm2XkP1aB9cD3eF4g", status: "closed", closedAt: "2026-07-14T21:00:00.000Z", createdByName: "Pat Example" });
    expect(first).not.toHaveProperty("createdBy");
    expect(first?.items["012345678905"]).toEqual({ code: "012345678905", name: "All-purpose cleaner, 32 oz", price: 4.99, cost: 3.25, out: 4, returned: 1 });
    expect(second).toMatchObject({ createdByName: "Jordan", status: "open" });
    expect(third).toMatchObject({ source: { store: "Corner Hardware", receiptDate: "2026-07-27" } });
    expect(third?.items["one-off-ladder-rental"]?.price).toBe(35.01);
    expect(third).not.toHaveProperty("savedReceipts");
    expect(p.totals.get("Sh7Qm2XkP1aB9cD3eF4g")).toEqual({ taken: 9, returned: 3, used: 6, chargeCents: 2247 });
    expect(p.totals.get("Tq9Ps4MmC7dE1fG5hJ8k")).toEqual({ taken: 4, returned: 0, used: 4, chargeCents: 7251 });
    expect(p.droppedCreatedBy).toBe(3);
    expect(p.projectsWithoutTotals).toBe(0);
  });

  it.each([
    [42, /the file's text/],
    ["{", /isn't JSON/],
    ["[]", /isn't a Supply Checkout export/],
    [JSON.stringify({ app: "Other", inventory: [], projects: [] }), /isn't a Supply Checkout export/],
    [JSON.stringify({ app: "Supply Checkout", inventory: {}, projects: [] }), /isn't a Supply Checkout export/],
    [JSON.stringify({ app: "Supply Checkout", inventory: [], projects: [], exportedAt: "yesterday" }), /exportedAt/],
    [JSON.stringify({ app: "Supply Checkout", inventory: new Array(MAX_EXPORT_PRODUCTS + 1).fill(0), projects: [] }), /more than 5000 items/],
    [JSON.stringify({ app: "Supply Checkout", inventory: [], projects: new Array(MAX_EXPORT_PROJECTS + 1).fill(0) }), /more than 5000 projects/],
    [" ".repeat(MAX_EXPORT_BYTES + 1), /larger than 20 MB/],
  ])("refuses a file that isn't an export: %#", (text, message) => {
    expect(() => parseArtifactExport(text)).toThrow(InvalidInputError);
    expect(() => parseArtifactExport(text)).toThrow(message);
  });

  it("reads an export from before the rename, with its projects under sheets, the same way (supply-checkout-005.6)", () => {
    const old = edited((doc) => {
      doc.sheets = doc.projects;
      delete doc.projects;
    });
    const p = parseArtifactExport(old);
    const now = parseArtifactExport(FIXTURE);
    expect(p).toEqual(now);
    // Problems and ignored fields are named under the file's own key
    const bad = parseArtifactExport(
      JSON.stringify({ app: "Supply Checkout", inventory: [], sheets: [{ id: "s1", date: "2026-01-02", extra: 1, items: { k: { price: 1, color: "red" } } }, { id: "s1", date: "2026-01-02" }] }),
    );
    expect(bad.errors).toEqual([{ at: 'sheets[1] id "s1"', message: "has the same id as sheets[0]" }]);
    expect(bad.ignoredFields).toEqual({ '"sheets.extra"': 1, '"sheets.items.color"': 1 });
    expect(parseArtifactExport(JSON.stringify({ app: "Supply Checkout", inventory: [], sheets: [] }))).toMatchObject({ projects: [], errors: [] });
  });

  it.each([
    [{ projects: [], sheets: [] }, /both projects and sheets/],
    [{ projects: [], sheets: null }, /both projects and sheets/],
    [{ projects: null, sheets: [] }, /both projects and sheets/],
    [{ sheets: {} }, /isn't a Supply Checkout export/],
    [{ sheets: new Array(MAX_EXPORT_PROJECTS + 1).fill(0) }, /more than 5000 projects/],
  ])("refuses a file with both lists, or a bad old one: %#", (lists, message) => {
    expect(() => parseArtifactExport(JSON.stringify({ app: "Supply Checkout", inventory: [], ...lists }))).toThrow(message);
  });

  it("accepts an empty export, and one without exportedAt", () => {
    const p = parseArtifactExport(JSON.stringify({ app: "Supply Checkout", inventory: [], projects: [] }));
    expect(p).toMatchObject({ products: [], projects: [], errors: [] });
    expect(p).not.toHaveProperty("exportedAt");
  });

  it("lists every problem in the documents, by position, key or ID, and not their contents", () => {
    const p = parseArtifactExport(
      edited((doc) => {
        const inv = doc.inventory;
        inv[0].price = -1;
        inv[1].price = "11.97";
        delete inv[2].price;
        inv[3].cost = 1e7;
        inv[4].packSize = 0;
        inv[5].stock = 2.5;
        inv[6].key = inv[7].key;
        inv[8].name = "x".repeat(201);
        inv[9].code = 12;
        inv.push("not an item", { key: "__proto__", price: 1 }, { key: "t", price: 1, updatedAt: "soon" }, { key: "big", price: 1, name: "n", notes: "y".repeat(400_000) });
        const [s0, s1, s2, s3] = doc.projects;
        s0.items["012345678905"].returned = 9;
        s0.items["070382000181"].out = -1;
        s1.date = "07/20/2026";
        s2.status = "done";
        s3.id = "s-dup";
        doc.projects.splice(3, 0, { ...s3, id: "bad id" });
        doc.projects.push(
          { id: "s-dup", date: "2026-01-01" },
          { id: "s-client", client: 5, date: "2026-01-01" },
          { id: "s-items", date: "2026-01-01", items: [] },
          { id: "s-source", date: "2026-01-01", source: "shop" },
          { id: "s-totals", date: "2026-01-01", totals: 3 },
          { id: "s-charge", date: "2026-01-01", totals: { taken: 0, returned: 0, used: 0, charge: "0" } },
          { id: "s-off", date: "2026-01-01", items: { a: { name: "A", price: 1.5, out: 2, returned: 0 } }, totals: { taken: 2, returned: 0, used: 2, charge: 4 } },
          { id: "s-line", date: "2026-01-01", items: { a: "line" } },
          { id: "s-name", date: "2026-01-01", preparedBy: 7 },
          { id: "s-closed", date: "2026-01-01", closedAt: 5 },
          { id: "s-nodate", client: "c" },
          7,
          { id: "s-big", date: "2026-01-01", items: Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`k${i}`, { code: "c".repeat(256), name: "n".repeat(200), price: 1, out: 0, returned: 0 }])) },
        );
      }),
    );
    const messages = p.errors.map((e) => `${e.at}: ${e.message}`);
    expect(messages).toEqual([
      'inventory[0] key "012345678905": price must be an amount from 0 to 1000000',
      'inventory[1] key "p-no-stock": price must be an amount from 0 to 1000000',
      'inventory[2] key "HVAC-20x25": price must be an amount from 0 to 1000000',
      'inventory[3] key "constructor": cost must be an amount from 0 to 1000000',
      'inventory[4] key "070382000181": packSize must be a whole number from 1 to 10000',
      'inventory[5] key "p-mop-heads": stock must be a whole number from 0 to 1000000',
      'inventory[7] key "036000291452": has the same key as inventory[6]',
      'inventory[8] key "p-legacy-stock": name is longer than 200 characters',
      'inventory[9] key "041167066218": code isn\'t text',
      "inventory[10]: isn't an object",
      'inventory[11] key "__proto__": key isn\'t a valid item key',
      'inventory[12] key "t": updatedAt isn\'t a date and time',
      'projects[0] id "Sh7Qm2XkP1aB9cD3eF4g".items["012345678905"]: returned is more than out',
      'projects[0] id "Sh7Qm2XkP1aB9cD3eF4g".items["070382000181"]: out must be a whole number from 0 to 1000000',
      'projects[0] id "Sh7Qm2XkP1aB9cD3eF4g": has lines with problems (listed separately)',
      "projects[1] id \"Rk3Lw8NnT5uV0yZ2aB6c\": date isn't YYYY-MM-DD",
      'projects[2] id "Tq9Ps4MmC7dE1fG5hJ8k": status must be "open" or "closed"',
      "projects[3] id \"bad id\": id isn't a valid project ID",
      'projects[5] id "s-dup": has the same id as projects[4]',
      "projects[6] id \"s-client\": client isn't text",
      "projects[7] id \"s-items\": items isn't an object",
      "projects[8] id \"s-source\": source isn't an object",
      "projects[9] id \"s-totals\": totals isn't an object",
      "projects[10] id \"s-charge\": totals.charge isn't an amount",
      'projects[11] id "s-off": its lines add up to taken 2, returned 0, used 2, charge 3.00, not the exported taken 2, returned 0, used 2, charge 4.00',
      'projects[12] id "s-line".items["a"]: isn\'t an object',
      'projects[12] id "s-line": has lines with problems (listed separately)',
      "projects[13] id \"s-name\": preparedBy isn't text",
      "projects[14] id \"s-closed\": closedAt isn't a date and time",
      'projects[15] id "s-nodate": date is missing',
      "projects[16]: isn't an object",
      'projects[17] id "s-big": is too large to save',
    ]);
    // Neither names nor clients appear
    expect(messages.join("\n")).not.toMatch(/Harbor|Oak Lane|Pat Example|Jordan|cleaner/);
    expect(p.ignoredFields).toEqual({ '"inventory.notes"': 1 });
    // Documents with problems aren't imported; the rest are
    expect(p.projects.map((s) => s.id)).toEqual(["s-dup"]);
    expect(p.products.map((x) => x.key)).toEqual(["036000291452", "big"]);
  });

  it("defaults what the artifact leaves out, keeps a project's own name, and names ignored fields", () => {
    const p = parseArtifactExport(
      JSON.stringify({
        app: "Supply Checkout",
        inventory: [{ key: "k", price: 1, cost: null, packSize: null, stock: null, unit: "box" }],
        projects: [
          { id: "s1", date: "2026-01-02", status: null, createdByName: "Sam", source: { store: "Shop" }, items: { k: { price: 1, code: null, cost: null, color: "red" } }, extra: 1 },
          { id: "s2", date: "2026-01-02", items: null, createdBy: "" },
        ],
      }),
    );
    expect(p.errors).toEqual([]);
    expect(p.products).toEqual([{ key: "k", code: "", name: "", price: 1 }]);
    expect(p.projects).toEqual([
      { id: "s1", client: "", date: "2026-01-02", status: "open", createdByName: "Sam", source: { store: "Shop", receiptDate: "" }, items: { k: { name: "", price: 1, out: 0, returned: 0 } } },
      { id: "s2", client: "", date: "2026-01-02", status: "open", items: {} },
    ]);
    expect(p.ignoredFields).toEqual({ '"inventory.unit"': 1, '"projects.items.color"': 1, '"projects.extra"': 1 });
    expect(p.droppedCreatedBy).toBe(0);
    expect(p.projectsWithoutTotals).toBe(2);
  });

  it("keeps a product's brand by the document routes' rules, from the web app's export (supply-checkout-005.9)", () => {
    const p = parseArtifactExport(
      JSON.stringify({
        app: "Supply Checkout",
        inventory: [
          { key: "a", price: 1, brand: " Glad " },
          { key: "b", price: 1, brand: "" },
          { key: "c", price: 1, brand: null },
          { key: "d", price: 1, brand: "x".repeat(101) },
          { key: "e", price: 1, brand: "Glad\u001b[2J" },
          { key: "f", price: 1, brand: 7 },
        ],
        sheets: [],
      }),
    );
    expect(p.products).toEqual([
      { key: "a", code: "", name: "", brand: "Glad", price: 1 },
      { key: "b", code: "", name: "", price: 1 },
      { key: "c", code: "", name: "", price: 1 },
    ]);
    // Problems say where and what, never the brand itself
    expect(p.errors).toEqual([
      { at: 'inventory[3] key "d"', message: "brand is longer than 100 characters" },
      { at: 'inventory[4] key "e"', message: "brand has a control character in it" },
      { at: 'inventory[5] key "f"', message: "brand must be text" },
    ]);
    expect(p.ignoredFields).toEqual({});
  });

  it("refuses two items with one barcode, as the CSV import does", () => {
    const p = parseArtifactExport(
      JSON.stringify({
        app: "Supply Checkout",
        inventory: [{ key: "a", code: "123", price: 1 }, { key: "b", code: " 123 ", price: 1 }, { key: "c", code: "", price: 1 }, { key: "d", code: "", price: 1 }],
        projects: [],
      }),
    );
    expect(p.errors).toEqual([{ at: 'inventory[1] key "b"', message: "has the same barcode as inventory[0]" }]);
    // Items without a barcode don't clash
    expect(p.products.map((x) => x.key)).toEqual(["a", "c", "d"]);
  });

  it("escapes control characters from the file in everything it reports, so it can't put escape sequences on a terminal", () => {
    const p = parseArtifactExport(
      JSON.stringify({
        app: "Supply Checkout",
        inventory: [{ key: "k\u009b31m", price: -1, "x\u001b[2Jy": 1, "z\u009b0m": 2 }],
        projects: [{ id: "s1", date: "2026-01-01", createdAt: "2026-01-01\u009b" }],
      }),
    );
    expect(p.errors).toEqual([
      { at: 'inventory[0] key "k\\u009b31m"', message: "price must be an amount from 0 to 1000000" },
      { at: 'projects[0] id "s1"', message: "createdAt isn't a date and time" },
    ]);
    expect(Object.keys(p.ignoredFields)).toEqual(['"inventory.x\\u001b[2Jy"', '"inventory.z\\u009b0m"']);
    // eslint-disable-next-line no-control-regex -- checking for control characters is the point
    expect(JSON.stringify([p.errors, p.ignoredFields])).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(() => parseArtifactExport(JSON.stringify({ app: "Supply Checkout", inventory: [], projects: [], exportedAt: "2026-01-01\u009b" }))).toThrow(/exportedAt/);
  });

  it("adds totals as project-math.js does: row charges in whole cents", () => {
    expect(projectTotals({ a: { name: "", price: 0.1, out: 3, returned: 0 }, b: { name: "", price: 1.15, out: 7, returned: 2 } })).toEqual({ taken: 10, returned: 2, used: 8, chargeCents: 605 });
  });
});

describe("the import's role and team checks", () => {
  const parsed = parseArtifactExport(FIXTURE);

  it("is for owners only", async () => {
    for (const role of ["viewer", "contributor"] as const) {
      const ctx = await contextFor(role);
      await expect(planArtifactImport(offlineDb(), ctx, parsed)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(applyArtifactImport(offlineDb(), ctx, { products: [], projects: [], productsPresent: 0, projectsPresent: 0, conflicts: [] })).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("writes nothing while there are conflicts", async () => {
    const ctx = await contextFor("owner");
    await expect(applyArtifactImport(offlineDb(), ctx, { products: [], projects: [], productsPresent: 0, projectsPresent: 0, conflicts: [{ at: "x", message: "y" }] })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("parseArtifactExport: General Use projects (ADR 0017)", () => {
  it("keeps a General Use project's kind, only on an adhoc-<n> ID", () => {
    const adhoc = (id: string, kind: unknown) => ({ id, kind, client: "", date: "2026-09-30", status: "open", items: {} });
    const p = parseArtifactExport(edited((doc) => doc.projects.push(adhoc("adhoc-1", "adhoc"), adhoc("adhoc-x", "adhoc"), adhoc("s-9", "adhoc"), adhoc("adhoc-2", "job"), adhoc("adhoc-3", null))));
    expect(p.projects.find((s) => s.id === "adhoc-1")?.kind).toBe("adhoc");
    expect(p.projects.find((s) => s.id === "adhoc-3")).toBeUndefined();
    expect(p.errors.map((e) => e.message)).toEqual([...Array(3).fill('kind must be "adhoc", on a project whose id is adhoc-<n>'), 'an id starting "adhoc-" is a General Use project\'s, which needs kind "adhoc"']);
  });

  it("refuses a file with more than one open General Use project", () => {
    const adhoc = (id: string, status: string) => ({ id, kind: "adhoc", client: "", date: "2026-09-30", status, items: {} });
    const p = parseArtifactExport(edited((doc) => doc.projects.push(adhoc("adhoc-1", "open"), adhoc("adhoc-2", "closed"), adhoc("adhoc-3", "open"))));
    expect(p.errors).toEqual([{ at: 'project id "adhoc-3"', message: 'is a second open General Use project ("adhoc-1" is open too); finish all but one first' }]);
  });
});

describe.skipIf(!endpoint)("the artifact import (DynamoDB Local)", () => {
  const table = useTable();
  let db: Db;

  async function team(): Promise<{ ctx: TeamContext; owner: string }> {
    db = table.db;
    const owner = newUser();
    return { ctx: (await createTeam(db, { userId: owner }, { name: "Maple Street Cleaning" })).context, owner };
  }

  async function run(ctx: TeamContext, text = FIXTURE) {
    const parsed = parseArtifactExport(text);
    const plan = await planArtifactImport(db, ctx, parsed);
    const result = await applyArtifactImport(db, ctx, plan);
    return { parsed, plan, result, check: await verifyArtifactImport(db, ctx, parsed) };
  }

  it("imports every item and project with its stock and totals, and a re-run writes nothing", async () => {
    const { ctx, owner } = await team();
    const { plan, result, check } = await run(ctx);
    expect(plan).toMatchObject({ productsPresent: 0, projectsPresent: 0, conflicts: [] });
    expect(result).toMatchObject({ productsCreated: 10, projectsCreated: 4, movements: 7, alreadyThere: 0 });
    expect(check).toEqual({ productsChecked: 10, projectsChecked: 4, stockBefore: 81, stockAfter: 81, chargeBeforeCents: 2247 + 11569 + 7251, chargeAfterCents: 2247 + 11569 + 7251, mismatches: [] });

    // Stored as the app's documents, with the ADR 0014 mapping
    expect((await getDocument(db, ctx, "products", "070382000181"))?.data).toEqual({ code: "070382000181", name: "Microfiber cloths, 12 pack", price: 2.5, stock: 40, updatedAt: "2026-08-01T15:04:05.000Z" });
    expect((await getDocument(db, ctx, "products", "constructor"))?.data).toMatchObject({ code: "constructor", stock: 2 });
    expect((await getDocument(db, ctx, "products", "p-legacy-stock"))?.data).not.toHaveProperty("stock");
    const project = await getDocument(db, ctx, "projects", "Rk3Lw8NnT5uV0yZ2aB6c");
    expect(project).toMatchObject({ version: 1, data: { client: "Oak Lane Dental", date: "2026-07-20", status: "open", createdByName: "Jordan" } });
    expect(project?.data.items).toMatchObject({ constructor: { name: "Glass cleaner, 1 gal", price: 18, out: 1, returned: 0 } });
    expect(project?.data).not.toHaveProperty("totals");
    expect(project?.data).not.toHaveProperty("preparedBy");
    // In date order through GSI1, as the app lists them
    const byDate = await listDocuments(db, ctx, "projects", { orderBy: "date", descending: true });
    expect(byDate.items.map((s) => s.id)).toEqual(["Vb2Nc6Xz0Aq4Ws8Ed1Rf", "Tq9Ps4MmC7dE1fG5hJ8k", "Rk3Lw8NnT5uV0yZ2aB6c", "Sh7Qm2XkP1aB9cD3eF4g"]);

    // Each count is an import movement from 0, by the owner
    expect((await listMovements(db, ctx, "012345678905")).items).toEqual([expect.objectContaining({ reason: "import", delta: 18, count: 18, tracked: true, userId: owner, operationId: result.operationId })]);
    expect((await listMovements(db, ctx, "041167066218")).items).toEqual([expect.objectContaining({ reason: "import", delta: 0, count: 0 })]);
    expect((await listMovements(db, ctx, "p-mop-heads")).items).toEqual([]);

    const again = await run(ctx);
    expect(again.plan).toMatchObject({ products: [], projects: [], productsPresent: 10, projectsPresent: 4, conflicts: [] });
    expect(again.result).toMatchObject({ productsCreated: 0, projectsCreated: 0, movements: 0 });
    expect(again.check.mismatches).toEqual([]);
    expect((await listMovements(db, ctx, "012345678905")).items).toHaveLength(1);
  });

  it("sets the team's ad hoc pointer from the General Use projects it imports, so the next quick take adds to the open one", async () => {
    const { ctx } = await team();
    const text = edited((doc) =>
      doc.projects.push(
        { id: "adhoc-1", kind: "adhoc", client: "", date: "2026-09-01", status: "closed", items: {} },
        { id: "adhoc-2", kind: "adhoc", client: "", date: "2026-09-20", status: "open", items: { tape: { code: "", name: "Tape", price: 3, out: 2, returned: 0 } } },
      ),
    );
    const { result } = await run(ctx, text);
    expect(result).toMatchObject({ projectsCreated: 6, adhocOpen: "adhoc-2" });
    const pointer = async () => (await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.adhoc(ctx.teamId) }))).Item;
    expect(await pointer()).toMatchObject({ type: "adhoc", count: 2, open: "adhoc-2", version: 1 });
    expect((await getDocument(db, ctx, "projects", "adhoc-2"))?.data).toMatchObject({ kind: "adhoc" });
    // A re-run leaves it as it is
    expect((await run(ctx, text)).result).toMatchObject({ projectsCreated: 0, adhocOpen: "adhoc-2" });
    expect(await pointer()).toMatchObject({ version: 1 });
    const taken = await quickTake(db, ctx, { operationId: "0f8fad5b-d9cb-469f-a165-70867728950e", productKey: "tape", quantity: 1, name: "Tape", price: 3 });
    expect(taken.result.projectId).toBe("adhoc-2");
    // A file whose open General Use project would be a second one in the team is a conflict
    const third = edited((doc) => doc.projects.push({ id: "adhoc-3", kind: "adhoc", client: "", date: "2026-09-25", status: "open", items: {} }));
    const blocked = await planArtifactImport(db, ctx, parseArtifactExport(third));
    expect(blocked.conflicts).toContainEqual({ at: 'project id "adhoc-3"', message: 'the team already has an open General Use project, "adhoc-2"; finish one of them first' });
    // And if one slips in anyway, the pointer isn't left naming one of two
    await connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: { ...legacy.sheetKey(ctx.teamId, "adhoc-4"), type: "sheet", id: "adhoc-4", kind: "adhoc", client: "", date: "2026-09-26", status: "open", items: {}, version: 1 } }));
    await expect(applyArtifactImport(db, ctx, { products: [], projects: [], productsPresent: 0, projectsPresent: 0, conflicts: [] })).rejects.toThrow("more than one open General Use project");
    // An import with no General Use projects leaves no pointer
    const other = await team();
    expect((await run(other.ctx)).result).not.toHaveProperty("adhocOpen");
  });

  it("finishes an import that stopped part-way", async () => {
    const { ctx } = await team();
    const parsed = parseArtifactExport(FIXTURE);
    const plan = await planArtifactImport(db, ctx, parsed);
    // As if the first run stopped after three items and one project
    await applyArtifactImport(db, ctx, { ...plan, products: plan.products.slice(0, 3), projects: plan.projects.slice(0, 1) });
    const partial = await verifyArtifactImport(db, ctx, parsed);
    expect(partial.mismatches).toHaveLength(7 + 3);
    expect(partial.mismatches[0]?.message).toBe("isn't in the team");

    const { plan: rest, result, check } = await run(ctx);
    expect(rest).toMatchObject({ productsPresent: 3, projectsPresent: 1 });
    expect(result).toMatchObject({ productsCreated: 7, projectsCreated: 3 });
    expect(check.mismatches).toEqual([]);
  });

  it("refuses, and writes nothing, when the team has other values under the same keys or barcodes", async () => {
    const { ctx } = await team();
    await setDocument(db, ctx, "products", "036000291452", { code: "036000291452", name: "Paper towels", price: 10 });
    await setDocument(db, ctx, "products", "towels-2", { code: "HVAC-20x25", name: "Filter", price: 1 });
    await setDocument(db, ctx, "projects", "Sh7Qm2XkP1aB9cD3eF4g", { client: "Someone else", date: "2026-07-14", status: "open", items: {} });
    const plan = await planArtifactImport(db, ctx, parseArtifactExport(FIXTURE));
    expect(plan.conflicts).toEqual([
      { at: 'item key "HVAC-20x25"', message: 'the team already has an item with this barcode, under key "towels-2"' },
      { at: 'item key "036000291452"', message: "the team already has an item with this key, with other values" },
      { at: 'project id "Sh7Qm2XkP1aB9cD3eF4g"', message: "the team already has a project with this ID, with other content" },
    ]);
    await expect(applyArtifactImport(db, ctx, plan)).rejects.toBeInstanceOf(ConflictError);
    expect((await listDocuments(db, ctx, "products")).items).toHaveLength(2);
    expect((await listDocuments(db, ctx, "projects")).items).toHaveLength(1);
  });

  it("finds what a race wrote between the plan and the write: the same values are fine, others stop it", async () => {
    const { ctx } = await team();
    const parsed = parseArtifactExport(FIXTURE);
    const plan = await planArtifactImport(db, ctx, parsed);
    // Another run of the same import got there first
    await applyArtifactImport(db, ctx, { ...plan, products: plan.products.slice(0, 2), projects: plan.projects.slice(0, 2) });
    const result = await applyArtifactImport(db, ctx, plan);
    expect(result).toMatchObject({ productsCreated: 8, projectsCreated: 2, alreadyThere: 4 });

    const { ctx: other } = await team();
    const otherPlan = await planArtifactImport(db, other, parsed);
    await setDocument(db, other, "products", otherPlan.products[0]?.key as string, { code: "", name: "Changed", price: 1 });
    await expect(applyArtifactImport(db, other, otherPlan)).rejects.toThrow(/was added with other values while importing/);

    const { ctx: third } = await team();
    const thirdPlan = await planArtifactImport(db, third, parsed);
    await setDocument(db, third, "projects", thirdPlan.projects[0]?.id as string, { client: "Changed", date: "2026-01-01", items: {} });
    await expect(applyArtifactImport(db, third, { ...thirdPlan, products: [] })).rejects.toThrow(/was added with other content while importing/);
  });

  it("reports a stock count or project total that doesn't match after the import", async () => {
    const { ctx } = await team();
    const { parsed } = await run(ctx);
    const put = (Item: Record<string, unknown>) => connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item }));
    await put({ ...keys.product(ctx.teamId, "p-gloves-m"), type: "product", key: "p-gloves-m", code: "", name: "Nitrile gloves (M), box", price: 9, stock: 2, version: 3 });
    await put({ ...keys.product(ctx.teamId, "p-mop-heads"), type: "product", key: "p-mop-heads", code: "", name: "Mop heads", price: 7.25, stock: 4, version: 3 });
    await put({ ...keys.project(ctx.teamId, "Vb2Nc6Xz0Aq4Ws8Ed1Rf"), type: "project", id: "Vb2Nc6Xz0Aq4Ws8Ed1Rf", items: { a: { name: "A", price: 1, out: 1, returned: 0 } }, version: 2 });
    await put({ ...keys.project(ctx.teamId, "Tq9Ps4MmC7dE1fG5hJ8k"), type: "project", id: "Tq9Ps4MmC7dE1fG5hJ8k", version: 2 });
    const check = await verifyArtifactImport(db, ctx, parsed);
    expect(check.mismatches).toEqual([
      { at: 'item key "p-mop-heads"', message: "stock is 4, not not tracked" },
      { at: 'item key "p-gloves-m"', message: "stock is 2, not 3" },
      { at: 'project id "Tq9Ps4MmC7dE1fG5hJ8k"', message: "totals are taken 0, returned 0, used 0, charge 0.00, not taken 4, returned 0, used 4, charge 72.51" },
      { at: 'project id "Vb2Nc6Xz0Aq4Ws8Ed1Rf"', message: "totals are taken 1, returned 0, used 1, charge 1.00, not taken 0, returned 0, used 0, charge 0.00" },
    ]);
    expect(check).toMatchObject({ stockBefore: 81, stockAfter: 84 });
  });

  it("stops writing when the team is closed part-way through, and leaves what it wrote", async () => {
    const { ctx } = await team();
    const plan = await planArtifactImport(db, ctx, parseArtifactExport(FIXTURE));
    await applyArtifactImport(db, ctx, { ...plan, products: plan.products.slice(0, 2), projects: [] });
    await closeTeam(db, ctx, { confirmName: "Maple Street Cleaning" });
    // The context was issued while the team was open, as for a run that was already going
    await expect(applyArtifactImport(db, ctx, { ...plan, products: plan.products.slice(2) })).rejects.toBeInstanceOf(TeamClosedError);
    await expect(applyArtifactImport(db, ctx, { ...plan, products: [] })).rejects.toThrow("The team was closed while importing");
    expect((await listDocuments(db, ctx, "products")).items).toHaveLength(2);
    expect((await listDocuments(db, ctx, "projects")).items).toHaveLength(0);
  });

  it("refuses a closed team", async () => {
    const { ctx, owner } = await team();
    await closeTeam(db, ctx, { confirmName: "Maple Street Cleaning" });
    const closed = await authorizeTeam(db, owner, ctx.teamId);
    await expect(planArtifactImport(db, closed, parseArtifactExport(FIXTURE))).rejects.toBeInstanceOf(TeamClosedError);
  });

  describe("the CLI", () => {
    const cli = async (args: string[], files: Record<string, string> = { "export.json": FIXTURE }, env: NodeJS.ProcessEnv = {}) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(
        args,
        (l) => out.push(l),
        (l) => err.push(l),
        {
          callerAccount: () => Promise.reject(new Error("not used")),
          connect: () => db,
          readExport: async (path) => {
            if (!(path in files)) throw new Error("ENOENT: no such file");
            return files[path] as string;
          },
        },
        env,
      );
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    const args = (teamId: string, owner: string, ...more: string[]) => ["--file", "export.json", "--team", teamId, "--owner", owner, "--table", db.tableName, "--region", REGION, "--endpoint", endpoint as string, ...more];

    it("dry-runs, imports, checks, and finds nothing to do the second time", async () => {
      const { ctx, owner } = await team();
      const dry = await cli(args(ctx.teamId, owner));
      expect(dry).toMatchObject({ code: 0, err: "" });
      expect(dry.out).toContain(`import into team ${ctx.teamId} on ${db.tableName} in ${REGION} at ${endpoint} (dry run)`);
      expect(dry.out).toContain("Export of 2026-08-03T09:00:00.000Z: 10 items (7 counted, 81 eaches in storage), 4 projects (charges 210.67)");
      expect(dry.out).toContain("projects whose claude.ai user ID is replaced by the name the artifact showed: 3");
      expect(dry.out).toContain("Items: 10 to add, 0 already in the team");
      expect(dry.out).toContain("Dry run: nothing was written.");
      expect((await listDocuments(db, ctx, "products")).items).toEqual([]);

      const applied = await cli(args(ctx.teamId, owner, "--apply"));
      expect(applied).toMatchObject({ code: 0, err: "" });
      expect(applied.out).toMatch(/Added 10 items \(7 stock counts recorded as import movements, operation [0-9a-f-]{36}\) and 4 projects/);
      expect(applied.out).toContain("Stock: 81 eaches in the team for the 10 items, 81 in the export");
      expect(applied.out).toContain("Project charges: 210.67 in the team for the 4 projects, 210.67 in the export");
      expect(applied.out).toContain("Done: every stock count and project total matches the export.");
      // No names or clients in anything it prints
      expect(`${dry.out}\n${applied.out}`).not.toMatch(/Harbor|Oak Lane|Pat Example|Jordan|cleaner/);

      const again = await cli(args(ctx.teamId, owner, "--apply"));
      expect(again.out).toContain("Items: 0 to add, 10 already in the team");
      expect(again.out).toContain("Added 0 items");
    });

    it("stops on problems in the export or conflicts, and writes nothing", async () => {
      const { ctx, owner } = await team();
      const bad = edited((doc) => {
        doc.inventory[0].price = "free";
        doc.inventory[1].unit = "roll";
      });
      const refused = await cli(args(ctx.teamId, owner, "--apply"), { "export.json": bad });
      expect(refused.code).toBe(1);
      expect(refused.out).toContain('fields left out: "inventory.unit" (1)');
      expect(refused.err).toContain('Problems in the export: 1\n  inventory[0] key "012345678905": price must be an amount from 0 to 1000000\nNothing was written.');

      await setDocument(db, ctx, "products", "036000291452", { code: "036000291452", name: "Other", price: 1 });
      const conflict = await cli(args(ctx.teamId, owner, "--apply"));
      expect(conflict.code).toBe(1);
      expect(conflict.err).toContain('Conflicts with the team\'s data: 1\n  item key "036000291452": the team already has an item with this key, with other values');
      expect((await listDocuments(db, ctx, "products")).items).toHaveLength(1);
    });

    it("lists at most MAX_ISSUES problems", async () => {
      const { ctx, owner } = await team();
      const many = JSON.stringify({ app: "Supply Checkout", inventory: Array.from({ length: 205 }, (_, i) => ({ key: `k${i}` })), projects: [] });
      const result = await cli(args(ctx.teamId, owner), { "export.json": many });
      expect(result.err).toContain("Problems in the export: 205");
      expect(result.err).toContain("… and 5 more");
    });

    it("refuses someone who isn't an owner, and reports a file it can't read", async () => {
      const { ctx } = await team();
      const stranger = await cli(args(ctx.teamId, newUser()));
      expect(stranger).toMatchObject({ code: 1, err: "Failed: ForbiddenError: Not a member of this team" });
      const missing = await cli(args(ctx.teamId, newUser()), {});
      expect(missing).toMatchObject({ code: 1, err: "Can't read the export: ENOENT: no such file" });
    });

    it("reports differences found after the import, and exits 1", async () => {
      const { ctx, owner } = await team();
      // A Db that, right after each product is created, has someone count it again
      const real = connection(db);
      const doc = {
        send: async (command: unknown) => {
          const answer = await real.doc.send(command as never);
          if (command instanceof TransactWriteCommand) {
            const put = (command.input.TransactItems?.[0]?.Put?.Item ?? {}) as Record<string, unknown>;
            await real.doc.send(new PutCommand({ TableName: db.tableName, Item: { ...put, stock: 999, version: 2 } }));
          }
          return answer;
        },
      } as unknown as typeof real.doc;
      const racing = dbFromConnection({ ...real, doc });
      const text = JSON.stringify({ app: "Supply Checkout", inventory: [{ key: "k1", price: 1, stock: 4 }], projects: [] });
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(args(ctx.teamId, owner, "--apply"), (l) => out.push(l), (l) => err.push(l), { callerAccount: () => Promise.reject(new Error("not used")), connect: () => racing, readExport: async () => text }, {});
      expect(code).toBe(1);
      expect(out.join("\n")).toContain("Stock: 999 eaches in the team for the 1 items, 4 in the export");
      expect(err.join("\n")).toBe('Differences after the import: 1\n  item key "k1": stock is 999, not 4');
    });
  });
});

describe("the import CLI's arguments", () => {
  const deps = (account = "acct-test") => ({
    callerAccount: async () => account,
    connect: () => offlineDb(),
    readExport: async () => FIXTURE,
  });
  const run = async (args: string[], env: NodeJS.ProcessEnv = {}, d = deps()) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args, (l) => out.push(l), (l) => err.push(l), d, env);
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const base = ["--file", "e.json", "--team", "t1", "--owner", "u1", "--region", REGION];

  it("prints the usage for --help", async () => {
    expect(await run(["--help"])).toEqual({ code: 0, out: USAGE, err: "" });
  });

  it.each([
    [["--nope"], /Unknown option/],
    [["--file", "e.json"], /are required/],
    [[...base, "--table", "supply-checkout-prod-app", "--team", "bad id"], /must be IDs/],
    [[...base, "--table", "supply-checkout-prod-app"], /--profile is required/],
    [[...base, "--table", "other-table", "--profile", "p"], /--table must be an app table/],
  ])("refuses %j", async (args, message) => {
    const result = await run(args);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(message);
  });

  it("names the account before it reads the team, and refuses another account than the expected one", async () => {
    const args = [...base, "--table", "supply-checkout-prod-app", "--profile", "supply-prod"];
    const wrong = await run(args, { SUPPLY_CHECKOUT_EXPECTED_ACCOUNT: "acct-other" });
    expect(wrong).toMatchObject({ code: 1, out: "" });
    expect(wrong.err).toContain("not SUPPLY_CHECKOUT_EXPECTED_ACCOUNT (acct-other). Nothing was read or written.");

    const failing = await run(args, {}, { ...deps(), callerAccount: () => Promise.reject(Object.assign(new Error("token expired"), { name: "ExpiredToken" })) });
    expect(failing).toMatchObject({ code: 1, err: "Failed to identify the profile's account: ExpiredToken: token expired" });

    // The right account: it says so, then fails at the (offline) team read without writing
    const right = await run(args, { SUPPLY_CHECKOUT_EXPECTED_ACCOUNT: "acct-test" });
    expect(right.out.split("\n")[0]).toBe(`import into team t1 on supply-checkout-prod-app in ${REGION} in account acct-test (profile supply-prod) (dry run)`);
    expect(right).toMatchObject({ code: 1, err: "Failed: Error: unexpected DynamoDB call" });
  });

  it("reads the export file, and refuses one over the limit before loading it", async () => {
    const path = new URL("./fixtures/artifact-export.json", import.meta.url).pathname;
    expect(await readExportFile(path)).toBe(FIXTURE);
    await expect(readExportFile(path, 100)).rejects.toThrow("The file is larger than 0.0001 MB");
    await expect(readExportFile(`${path}.missing`)).rejects.toThrow(/ENOENT/);
  });

  it("reads a bad file before it signs in", async () => {
    const result = await run([...base, "--table", "supply-checkout-prod-app", "--profile", "p"], {}, { ...deps(), callerAccount: () => Promise.reject(new Error("must not sign in")), readExport: async () => "nope" });
    expect(result).toMatchObject({ code: 1, err: "Can't read the export: The file isn't JSON. Use the artifact's Export, Everything (JSON)" });
  });
});
