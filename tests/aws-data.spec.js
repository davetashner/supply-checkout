// The web build's runtime (src/aws/), part 2: the app's db calls on the data API
// (docs/api/openapi.yaml) and live updates (docs/api/realtime.md), against the fake
// backend in tests/fake-aws.js.
import { test, expect, createSheet, enterBarcode, modal, lineRow, inventoryRow } from "./helpers.js";
import { currentBuild } from "../scripts/builds.mjs";
import { usedState } from "./fixtures.js";
import { FakeBackend, TEAM, openAws, connected, sockets, emit, receive, dropSocket, setVisible } from "./fake-aws.js";

test.skip(currentBuild() !== "web", "The AWS runtime is only in the web build");

const seeded = () => Object.fromEntries(Object.entries(usedState.seed).map(([k, v]) => [`t1/${k}`, v]));
// How many times each collection has been listed (first pages only)
const lists = (backend) => Object.fromEntries(["products", "sheets"].map((c) => [c, backend.requests("GET", `/teams/t1/${c}`).filter((r) => !r.query.cursor).length]));
const card = (page, name) => page.getByRole("button", { name: new RegExp(name) });

// Opens the app and waits for both lists: the first load, and the re-list after subscribing
async function open(page, backend = new FakeBackend({ docs: seeded() }), opts) {
  await openAws(page, backend, opts);
  await connected(page);
  if (!opts) await expect.poll(() => lists(backend)).toEqual({ products: 2, sheets: 2 });
  return backend;
}

test.describe("data", () => {
  test("maps the app's writes onto the data routes", async ({ page }) => {
    const backend = await open(page);
    await createSheet(page, "Foxtrot Dental");
    const put = backend.requests("PUT", /^\/teams\/t1\/sheets\//)[0];
    const id = put.path.split("/").pop();
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    // Each write names the version it was made against: 0 for a new document
    expect(put.body).toEqual({ data: { client: "Foxtrot Dental", date: expect.any(String), createdBy: "u-pat", createdAt: expect.any(String), status: "open", items: {} }, expectedVersion: 0 });

    // Checkout: one command that adds the line and takes it off stock (docs/api/commands.md)
    await enterBarcode(page, "SKU1");
    await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
    await expect(lineRow(page, "Paper towels")).toBeVisible();
    await expect(page.locator("#toast")).toHaveText("Checked out 1 × Paper towels, 6 roll");
    const [checkout] = backend.requests("POST", `/teams/t1/sheets/${id}/checkout`);
    expect(checkout.body).toEqual({ operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), productKey: "SKU1", quantity: 1 });
    expect(backend.doc("t1", "sheets", id)).toMatchObject({ version: 2, data: { items: { SKU1: { code: "SKU1", name: "Paper towels, 6 roll", price: 8.5, out: 1, returned: 0 } } } });
    expect(backend.doc("t1", "products", "SKU1")).toMatchObject({ version: 2, data: { stock: 9 } });

    // Return, as another command with its own operation ID
    await page.getByRole("button", { name: "Return", exact: true }).click();
    await enterBarcode(page, "SKU1");
    await modal(page).getByRole("button", { name: "Save return" }).click();
    await expect(page.locator("#toast")).toHaveText("1 returned · 1 of 1 back");
    const [ret] = backend.requests("POST", `/teams/t1/sheets/${id}/return`);
    expect(ret.body).toEqual({ operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), productKey: "SKU1", quantity: 1 });
    expect(ret.body.operationId).not.toBe(checkout.body.operationId);
    expect(backend.doc("t1", "products", "SKU1")).toMatchObject({ version: 3, data: { stock: 10 } });
    // The stock moved on the server only: no sheet PATCH, and no read-then-write of the count
    expect(backend.requests("PATCH", /^\/teams\/t1\//)).toEqual([]);

    // A key with characters that need encoding in a path
    await page.getByRole("button", { name: "Inventory" }).click();
    await page.getByRole("button", { name: "+ Add item" }).click();
    await modal(page).getByPlaceholder("Type, scan, or leave blank").fill("x:y@z+1");
    await modal(page).getByLabel("Item name").fill("Odd code");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(inventoryRow(page, "Odd code")).toBeVisible();
    expect(backend.requests("PUT", "/teams/t1/products/x%3Ay%40z%2B1")).toHaveLength(1);
    expect(backend.doc("t1", "products", "x:y@z+1").data.name).toBe("Odd code");

    // Delete
    await page.getByRole("button", { name: "Sheets" }).click();
    await card(page, "Foxtrot Dental").click();
    await page.getByRole("button", { name: "Delete sheet" }).click();
    await page.getByRole("button", { name: "Tap again to delete" }).click();
    await expect(card(page, "Foxtrot Dental")).toHaveCount(0);
    expect(backend.requests("DELETE", `/teams/t1/sheets/${id}`).map((r) => r.query)).toEqual([{ expectedVersion: "3" }]);
    expect(backend.doc("t1", "sheets", id)).toBeUndefined();
  });

  test("follows cursors to list every document", async ({ page }) => {
    const docs = seeded();
    for (let i = 1; i <= 5; i++) docs[`t1/products/p${i}`] = { code: `p${i}`, name: `Item ${i}`, price: i };
    const backend = new FakeBackend({ docs });
    backend.pageSize = 2;
    await open(page, backend);
    await page.getByRole("button", { name: "Inventory" }).click();
    await expect(page.locator("#main tbody tr")).toHaveCount(7);
    // Twice: the first load, and the re-list after subscribing
    expect(backend.requests("GET", "/teams/t1/products").map((c) => c.query.cursor)).toEqual([undefined, "2", "4", "6", undefined, "2", "4", "6"]);
  });

  test("passes the API's error codes to the app", async ({ page }) => {
    const backend = await open(page);
    const tryCreate = async (answer) => {
      backend.on("PUT", /^\/teams\/t1\/sheets\//, answer);
      await page.getByRole("button", { name: "+ New sheet" }).click();
      await page.getByLabel("Client", { exact: true }).fill("Nope");
      await page.getByRole("button", { name: "Create sheet" }).click();
    };
    const error = (status, code) => ({ status, body: { error: { code, message: code } } });
    await tryCreate(error(413, "quota_exceeded"));
    await expect(page.locator("#toast")).toHaveText("Storage is full. Delete old sheets or items to make room.");
    for (const answer of [error(400, "bad_request"), { status: 502, body: "<html>Bad gateway</html>" }, { abort: true }]) {
      await page.locator("#toast").evaluate((t) => { t.hidden = true; });
      backend.on("PUT", /^\/teams\/t1\/sheets\//, answer);
      await page.getByRole("button", { name: "Create sheet" }).click();
      await expect(page.locator("#toast")).toHaveText("That didn't save. Check your connection and try again.");
    }
    // A viewer's write: the app switches to view-only
    backend.on("PUT", /^\/teams\/t1\/sheets\//, error(403, "invalid_argument"));
    await page.getByRole("button", { name: "Create sheet" }).click();
    await expect(page.locator("#notice")).toContainText("You have view-only access.");
    expect(backend.requests("PUT", /^\/teams\/t1\/sheets\//)).toHaveLength(5);
  });

  test("a conflicting edit is refused, and the latest values show with a clear message", async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    await lineRow(page, "Paper towels").click();
    await modal(page).getByLabel("Taken").fill("7");
    // Meanwhile someone else checks out more of the same line, and this page hasn't heard yet
    const theirs = structuredClone(usedState.seed["sheets/s1"]);
    theirs.items.SKU1.out = 9;
    backend.write("t1", "sheets", "s1", theirs);
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#toast")).toHaveText("Someone else changed this just now, so your change wasn't saved. The latest is showing; make your change again if it's still needed.");
    await expect(modal(page)).toBeEmpty();
    await expect(lineRow(page, "Paper towels").locator("td").nth(2)).toHaveText("9");
    expect(backend.requests("PATCH", "/teams/t1/sheets/s1").map((r) => r.body.expectedVersion)).toEqual([1]);
    expect(backend.doc("t1", "sheets", "s1")).toMatchObject({ version: 2, data: { items: { SKU1: { out: 9 } } } });

    // Made again on the latest, it saves
    await lineRow(page, "Paper towels").click();
    await modal(page).getByLabel("Taken").fill("10");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#toast")).toHaveText("Saved");
    expect(backend.requests("PATCH", "/teams/t1/sheets/s1").map((r) => r.body.expectedVersion)).toEqual([1, 2]);
    expect(backend.doc("t1", "sheets", "s1").data.items.SKU1.out).toBe(10);

    // A delete that races someone else's delete: the sheet is gone either way
    backend.docs.delete("t1/sheets/s1");
    await page.getByRole("button", { name: "Delete sheet" }).click();
    await page.getByRole("button", { name: "Tap again to delete" }).click();
    await expect(page.locator("#toast")).toContainText("Someone else changed this just now");
    await expect(card(page, "Echo Studio")).toHaveCount(0);
  });

  test("a first load that fails reports a lost connection", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    backend.on("GET", "/teams/t1/products", { status: 500, body: { error: { code: "internal", message: "boom" } } });
    await openAws(page, backend);
    await expect(page.locator("#toast")).toHaveText("Lost connection to shared storage. Reload the page.");
    await expect(page.locator("#notice")).toHaveText("Connecting to shared storage… If this doesn't clear, reload the page.");
  });

  test("CSV downloads are saved by the browser", async ({ page }) => {
    await page.clock.install();
    await open(page);
    await card(page, "Echo Studio").click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download CSV" }).click();
    expect((await download).suggestedFilename()).toBe("Echo Studio 2026-09-24.csv");
    // The file's object URL is released afterwards
    await page.clock.fastForward(10e3);
  });

  test("an owner exports 1,000 sheets, listed page by page, as a JSON download", async ({ page }) => {
    const docs = seeded();
    for (let i = 0; i < 1000; i++) {
      const items = {};
      for (let j = 0; j < 20; j++) items[`k${j}`] = { code: `C${j}`, name: `Item ${j}`, price: j, out: 3, returned: 1 };
      docs[`t1/sheets/b${i}`] = { client: `Client ${i}`, date: "2026-09-01", status: "open", items };
    }
    const backend = new FakeBackend({ docs });
    backend.pageSize = 100;
    const start = Date.now();
    await open(page, backend);
    await page.getByRole("button", { name: "Export data" }).click();
    await expect(modal(page)).toContainText("1001 sheets and 2 inventory items");
    const download = page.waitForEvent("download");
    await modal(page).getByRole("button", { name: "Everything (JSON)" }).click();
    const file = await download;
    expect(Date.now() - start).toBeLessThan(30e3);
    expect(file.suggestedFilename()).toMatch(/^Supply Checkout export \d{4}-\d{2}-\d{2}\.json$/);
    const json = JSON.parse(await (await import("node:fs/promises")).readFile(await file.path(), "utf8"));
    expect(json.sheets).toHaveLength(1001);
    expect(json.sheets.find((s) => s.id === "b7").totals).toEqual({ taken: 60, returned: 20, used: 40, charge: 380 });
  });

  test("a tap survives the redraw when a re-list's pages arrive", async ({ page }) => {
    const docs = seeded();
    for (let i = 0; i < 30; i++) docs[`t1/sheets/b${i}`] = { client: `Client ${i}`, date: "2026-09-01", status: "open", items: {} };
    const backend = new FakeBackend({ docs });
    backend.pageSize = 10;
    await open(page, backend);
    const first = await card(page, "Client 0").elementHandle();
    // A re-list is held while a sheet is added that it will pick up
    const release = backend.hold("GET", "/teams/t1/sheets");
    backend.write("t1", "sheets", "late", { client: "Late job", date: "2026-08-01", status: "open", items: {} });
    await setVisible(page, true);
    await expect.poll(() => lists(backend).sheets).toBe(3);
    // Press Export data, and let the re-list page in and redraw the list before letting go
    const box = await page.getByRole("button", { name: "Export data" }).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    release();
    await expect(card(page, "Late job")).toBeVisible();
    expect(await first.evaluate((el) => el.isConnected)).toBe(true);
    await page.mouse.up();
    await expect(modal(page)).toContainText("32 sheets and 2 inventory items");
  });

  test("members who aren't owners get no Export data", async ({ page }) => {
    await open(page, new FakeBackend({ teams: [{ ...TEAM, role: "contributor" }], docs: seeded() }));
    await expect(card(page, "Echo Studio")).toBeVisible();
    await expect(page.getByRole("button", { name: "Export data" })).toHaveCount(0);
  });

  test("the rest of the runtime's surface", async ({ page }) => {
    const backend = await open(page, new FakeBackend({
      docs: {
        ...seeded(),
        "t1/sheets/a": { client: "A", date: "2026-09-01" },
        "t1/sheets/b": { client: "B", date: "2026-09-01" },
        "t1/sheets/c": { client: "C" },
        "t1/notes/n1": { text: "hi" },
      },
    }));
    backend.on("GET", "/teams/t1/sheets/broken", { status: 500, body: { error: { code: "internal", message: "boom" } } });
    const result = await page.evaluate(async () => {
      const db = await window.claude.use("db"), user = await window.claude.use("user");
      const got = await db.doc("sheets/a").get(), missing = await db.collection("sheets").doc("zz").get();
      const broken = await db.doc("sheets/broken").get().then(() => "resolved", (e) => e.code);
      const asc = (await db.collection("sheets").orderBy("date").get()).docs.map((d) => d.id);
      const byId = await db.collection("sheets").get();
      const added = await db.collection("notes").add({ text: "new" });
      // Listening for one document, and a second listener on a loaded collection
      const one = await new Promise((resolve) => { const stop = db.doc("sheets/a").onSnapshot((s) => { stop(); resolve(s); }); });
      const again = await new Promise((resolve) => { const stop = db.collection("products").onSnapshot((s) => { stop(); resolve(s.size); }); });
      return {
        got: [got.exists, got.id, got.data().client], missing: [missing.exists, missing.data()], broken, asc,
        byId: [byId.size, byId.empty, byId.docChanges().length, byId.metadata.fromCache], added: added.id.length,
        one: [one.exists, one.data().client], again,
        can: [await user.can("data.write"), await user.can("billing.manage")], id: await user.id(),
        profiles: await user.profiles(["u-pat", "u-other"]),
        sample: await window.claude.use("sample"), other: await window.claude.use("clipboard"),
      };
    });
    expect(result).toMatchObject({
      got: [true, "a", "A"], missing: [false, undefined], broken: "internal",
      // Oldest first; undated first, and the same date by ID
      asc: ["c", "a", "b", "s1"],
      byId: [4, false, 0, false], added: 36,
      one: [true, "A"], again: 2,
      can: [true, false], id: "u-pat",
      profiles: { "u-pat": { id: "u-pat", name: "Pat Lee", isMe: true } },
      sample: null, other: null,
    });
    expect(backend.requests("PUT", /^\/teams\/t1\/notes\//)).toHaveLength(1);
  });

  test("the user's name falls back to their email", async ({ page }) => {
    await open(page, new FakeBackend({ claims: { email: "pat@example.com" }, docs: { "t1/sheets/m": { client: "Mine", date: "2026-09-25", createdBy: "u-pat", status: "open", items: {} } } }));
    await expect(card(page, "Mine")).toContainText("pat@example.com");
  });
});

test.describe("checkout and return commands", () => {
  const CHECKOUT = "/teams/t1/sheets/s1/checkout", RETURN = "/teams/t1/sheets/s1/return";
  const toast = (page) => page.locator("#toast");
  const hideToast = (page) => toast(page).evaluate((t) => { t.hidden = true; });
  const scanOut = async (page, qty) => {
    await enterBarcode(page, "SKU1");
    for (let i = 1; i < qty; i++) await modal(page).getByRole("button", { name: "More" }).click();
    await modal(page).getByRole("button", { name: `Add ${qty} to sheet` }).click();
  };

  test("two people checking out the same item at once leave the line and the stock right", async ({ page }) => {
    const backend = await open(page);
    backend.shareTokens = true;
    // A second device, signed in to the same team
    const other = await page.context().newPage();
    backend.pageLoads = 0;
    await openAws(other, backend);
    await connected(other);
    for (const p of [page, other]) await card(p, "Echo Studio").click();

    // Both checkouts reach the API before either is answered
    const release = backend.hold("POST", CHECKOUT);
    await scanOut(page, 2);
    await scanOut(other, 3);
    await expect.poll(() => backend.requests("POST", CHECKOUT).length).toBe(2);
    release();
    await expect(toast(page)).toHaveText("Checked out 2 × Paper towels, 6 roll");
    await expect(toast(other)).toHaveText("Checked out 3 × Paper towels, 6 roll");
    // Each is added to what's stored, so neither is lost: 3 out before, 10 in storage
    expect(backend.doc("t1", "sheets", "s1").data.items.SKU1).toMatchObject({ out: 3 + 2 + 3, returned: 1 });
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(10 - 2 - 3);
    const ids = backend.requests("POST", CHECKOUT).map((r) => r.body.operationId);
    expect(new Set(ids).size).toBe(2);
    expect(backend.requests("PATCH", /^\/teams\/t1\//)).toEqual([]);
    // The one answered last has both
    await expect(lineRow(other, "Paper towels").locator("td").nth(2)).toHaveText("8");
    await other.close();
  });

  test("a retry after a lost answer sends the same operation ID, so it counts once", async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    // The API saves the checkout, but the answer never arrives
    backend.on("POST", CHECKOUT, { lost: true });
    await scanOut(page, 1);
    await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(9);
    // Tapping again retries the same action
    await hideToast(page);
    await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
    await expect(toast(page)).toHaveText("Checked out 1 × Paper towels, 6 roll");
    const [first, retry] = backend.requests("POST", CHECKOUT).map((r) => r.body);
    expect(retry).toEqual(first);
    expect(backend.operations.size).toBe(1);
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(9);
    expect(backend.doc("t1", "sheets", "s1").data.items.SKU1.out).toBe(4);
    await expect(lineRow(page, "Paper towels").locator("td").nth(2)).toHaveText("4");

    // A request changed after a failure is a new operation
    await page.getByRole("button", { name: "Return", exact: true }).click();
    backend.on("POST", RETURN, { status: 503, body: { error: { code: "unavailable", message: "try again" } } });
    await enterBarcode(page, "SKU1");
    await modal(page).getByRole("button", { name: "Save return" }).click();
    await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
    await modal(page).getByRole("button", { name: "More" }).click();
    await modal(page).getByRole("button", { name: "Save return" }).click();
    await expect(toast(page)).toHaveText("2 returned · 3 of 4 back");
    const [failed, changed] = backend.requests("POST", RETURN).map((r) => r.body);
    expect([failed.quantity, changed.quantity]).toEqual([1, 2]);
    expect(changed.operationId).not.toBe(failed.operationId);
    expect(backend.doc("t1", "sheets", "s1").data.items.SKU1.returned).toBe(3);
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(11);
  });

  test("a retried return is the same request even after a live update changed the line", async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    await page.getByRole("button", { name: "Return", exact: true }).click();
    // 3 out, 1 back: return the other 2, and the answer is lost
    backend.on("POST", RETURN, { lost: true });
    await enterBarcode(page, "SKU1");
    await modal(page).getByRole("button", { name: "More" }).click();
    await modal(page).getByRole("button", { name: "Save return" }).click();
    await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
    // The saved return's live update arrives while the form is still open
    await emit(page, { v: 1, eventId: "e1", collection: "sheets", id: "s1", op: "put", version: backend.doc("t1", "sheets", "s1").version });
    await expect(lineRow(page, "Paper towels")).toContainText("3");
    await hideToast(page);
    await modal(page).getByRole("button", { name: "Save return" }).click();
    await expect(toast(page)).toHaveText("2 returned · 3 of 3 back");
    const [first, retry] = backend.requests("POST", RETURN).map((r) => r.body);
    expect(retry).toEqual(first);
    expect(first.quantity).toBe(2);
    expect(backend.operations.size).toBe(1);
    expect(backend.doc("t1", "sheets", "s1").data.items.SKU1).toMatchObject({ out: 3, returned: 3 });
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(12);
  });

  test("a retried checkout of a new item saves the item once", async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    backend.on("POST", CHECKOUT, { lost: true });
    await enterBarcode(page, "NEW1");
    await modal(page).getByLabel("Item name").fill("Wax");
    await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
    await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
    // Someone else edits the new item meanwhile: saving it again would conflict
    backend.write("t1", "products", "NEW1", { code: "NEW1", name: "Floor wax", price: 0 });
    await hideToast(page);
    await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
    await expect(toast(page)).toHaveText("Checked out 1 × Wax");
    expect(backend.requests("PUT", "/teams/t1/products/NEW1")).toHaveLength(1);
    expect(backend.operations.size).toBe(1);
    expect(backend.doc("t1", "sheets", "s1").data.items.NEW1).toMatchObject({ out: 1 });
  });

  for (const kind of ["checkout", "return"]) {
    test(`a ${kind} by someone made a viewer meanwhile is refused, and the app switches to view-only`, async ({ page }) => {
      const backend = await open(page);
      await card(page, "Echo Studio").click();
      if (kind === "return") await page.getByRole("button", { name: "Return", exact: true }).click();
      await enterBarcode(page, "SKU1");
      backend.teams[0].role = "viewer";
      await modal(page).getByRole("button", { name: kind === "return" ? "Save return" : "Add 1 to sheet" }).click();
      await expect(page.locator("#notice")).toContainText("You have view-only access.");
      expect(backend.requests("POST", `/teams/t1/sheets/s1/${kind}`)).toHaveLength(1);
      expect(backend.operations.size).toBe(0);
      expect(backend.doc("t1", "sheets", "s1").version).toBe(1);
    });
  }

  test("a return on a sheet deleted as it saves still says what came back", async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    await page.getByRole("button", { name: "Return", exact: true }).click();
    await enterBarcode(page, "SKU1");
    backend.on("POST", RETURN, { status: 200, body: { operationId: "x", replayed: false, result: { quantity: 1 }, sheet: null, product: null } });
    await modal(page).getByRole("button", { name: "Save return" }).click();
    await expect(toast(page)).toHaveText("1 returned · 0 of 0 back");
    await expect(card(page, "Echo Studio")).toHaveCount(0);
  });

  test("a sheet closed meanwhile refuses a checkout, and the latest sheet and item show", async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    await enterBarcode(page, "SKU1");
    // Someone else finishes the return and recounts storage, and this page hasn't heard yet
    backend.write("t1", "sheets", "s1", { ...usedState.seed["sheets/s1"], status: "closed" });
    backend.write("t1", "products", "SKU1", { ...usedState.seed["products/SKU1"], stock: 4 });
    await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
    await expect(toast(page)).toContainText("Someone else changed this just now");
    await expect(modal(page)).toBeEmpty();
    await expect(page.locator("#sheetHead .pill")).toHaveText("Returned");
    expect(backend.requests("GET", "/teams/t1/sheets/s1")).toHaveLength(1);
    expect(backend.requests("GET", "/teams/t1/products/SKU1")).toHaveLength(1);
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(4);
  });

  test("an item that isn't saved to inventory sends its name and price for the line", async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    await page.getByRole("button", { name: "Add item without a barcode" }).click();
    await modal(page).getByRole("button", { name: "+ New item" }).click();
    await modal(page).getByLabel("Item name").fill("Ladder rental");
    await modal(page).getByLabel("Price each ($)").fill("12.35");
    await modal(page).getByLabel("Save to inventory for next time").uncheck();
    await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
    await expect(lineRow(page, "Ladder rental")).toBeVisible();
    const [{ body }] = backend.requests("POST", CHECKOUT);
    expect(body).toEqual({ operationId: expect.any(String), productKey: expect.stringMatching(/^nb-/), quantity: 1, name: "Ladder rental", price: 12.35, code: "" });
    expect(backend.requests("PUT", /^\/teams\/t1\/products\//)).toEqual([]);
    expect(backend.doc("t1", "sheets", "s1").data.items[body.productKey]).toEqual({ code: "", name: "Ladder rental", price: 12.35, out: 1, returned: 0 });
  });
});

test.describe("live updates", () => {
  test("another user's changes arrive as events and are fetched", async ({ page }) => {
    const backend = await open(page);
    const gets = (id) => backend.requests("GET", `/teams/t1/sheets/${id}`).length;

    // A new sheet
    const v = backend.write("t1", "sheets", "s2", { client: "Golf Club", date: "2026-09-25", status: "open", items: {} });
    await emit(page, { v: 1, eventId: "e1", collection: "sheets", id: "s2", op: "put", version: v, at: Date.now() });
    await expect(card(page, "Golf Club")).toBeVisible();
    // The same version again, or an older one: nothing to fetch
    await emit(page, { v: 1, eventId: "e1", collection: "sheets", id: "s2", op: "put", version: v });
    await emit(page, { v: 1, eventId: "e0", collection: "sheets", id: "s2", op: "put", version: v - 1 });
    // A product's stock changes without a new version, so the same version is fetched
    backend.doc("t1", "products", "SKU1").data.stock = 4;
    await emit(page, { v: 1, eventId: "e2", collection: "products", id: "SKU1", op: "put", version: 1 });
    await page.getByRole("button", { name: "Inventory" }).click();
    await expect(page.locator("#main tbody tr", { hasText: "Paper towels" })).toContainText("4");
    await page.getByRole("button", { name: "Sheets" }).click();
    expect(gets("s2")).toBe(1);
    expect(backend.requests("GET", "/teams/t1/products/SKU1")).toHaveLength(1);

    // Deleted: dropped without a fetch
    backend.docs.delete("t1/sheets/s2");
    await emit(page, { v: 1, eventId: "e3", collection: "sheets", id: "s2", op: "delete", version: v });
    await expect(card(page, "Golf Club")).toHaveCount(0);
    expect(gets("s2")).toBe(1);

    // Gone by the time it's fetched; a fetch that fails; things to ignore
    await emit(page, { v: 1, eventId: "e4", collection: "sheets", id: "s3", op: "put", version: 1 });
    backend.on("GET", "/teams/t1/sheets/s4", { status: 500, body: { error: { code: "internal", message: "boom" } } });
    await emit(page, { v: 1, eventId: "e5", collection: "sheets", id: "s4", op: "put", version: 1 });
    await emit(page, "not json");
    await emit(page, { v: 2, collection: "sheets", id: "s5", op: "put", version: 1 });
    await emit(page, { v: 1, collection: "notes", id: "n1", op: "put", version: 1 });
    // Names an object has without owning them: no error (the page fixture fails on one)
    await emit(page, { v: 1, collection: "constructor", id: "c1", op: "put", version: 1 });
    await emit(page, { v: 1, collection: "__proto__", id: "p1", op: "delete", version: 1 });
    // Another team's change (the user's channel carries all their teams): not this page's
    await emit(page, { v: 1, teamId: "t2", collection: "sheets", id: "s7", op: "put", version: 1 });
    await receive(page, { type: "data", id: "another-subscription", event: JSON.stringify({ v: 1, collection: "sheets", id: "s6", op: "put", version: 1 }) });
    await receive(page, { type: "connection_error", errors: [] });
    await expect.poll(() => gets("s3") + gets("s4")).toBe(2);
    expect(gets("s5") + gets("s6") + gets("s7")).toBe(0);
    await expect(card(page, "Echo Studio")).toBeVisible();
  });

  test("events for one document are fetched one at a time, and never go backwards", async ({ page }) => {
    const backend = await open(page);
    const release = backend.hold("GET", "/teams/t1/sheets/s1");
    for (const client of ["One", "Two", "Three"]) {
      const version = backend.write("t1", "sheets", "s1", { ...usedState.seed["sheets/s1"], client });
      await emit(page, { v: 1, collection: "sheets", id: "s1", op: "put", version });
    }
    await expect.poll(() => backend.requests("GET", "/teams/t1/sheets/s1").length).toBe(1);
    release();
    await expect(card(page, "Three")).toBeVisible();
    expect(backend.requests("GET", "/teams/t1/sheets/s1")).toHaveLength(2);

    // A stale answer (an older version than the one held) is ignored
    backend.on("GET", "/teams/t1/sheets/s1", { status: 200, body: { id: "s1", version: 1, data: { ...usedState.seed["sheets/s1"], client: "Stale" } } });
    await emit(page, { v: 1, collection: "sheets", id: "s1", op: "put", version: 9 });
    await expect.poll(() => backend.requests("GET", "/teams/t1/sheets/s1").length).toBe(3);
    await setVisible(page, false);
    await expect(card(page, "Three")).toBeVisible();
    await expect(card(page, "Stale")).toHaveCount(0);
  });

  test("a re-list keeps changes that arrive while it's being read", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ docs: { ...seeded(), "t1/sheets/old": { client: "Old job", date: "2026-09-01", status: "open", items: {} } } }));
    const before = lists(backend);
    // The re-list answers with the sheets as they were when it started
    let release;
    const wait = new Promise((r) => { release = r; });
    backend.on("GET", "/teams/t1/sheets", { wait, status: 200, body: { documents: [
      { id: "s1", version: 1, data: usedState.seed["sheets/s1"] },
      { id: "old", version: 1, data: { client: "Old job", date: "2026-09-01", status: "open", items: {} } },
    ] } });
    await setVisible(page, true);
    await expect.poll(() => lists(backend).sheets).toBe(before.sheets + 1);
    // Meanwhile a sheet is added and another deleted
    const v = backend.write("t1", "sheets", "new", { client: "New job", date: "2026-09-26", status: "open", items: {} });
    backend.docs.delete("t1/sheets/old");
    await emit(page, { v: 1, collection: "sheets", id: "new", op: "put", version: v });
    await emit(page, { v: 1, collection: "sheets", id: "old", op: "delete", version: 1 });
    await expect(card(page, "New job")).toBeVisible();
    await expect(card(page, "Old job")).toHaveCount(0);
    release();
    await expect.poll(() => lists(backend).products).toBe(before.products + 1);
    await expect(card(page, "Old job")).toHaveCount(0);
    await expect(card(page, "New job")).toBeVisible();

    // A re-list asked for while one is running runs once more afterwards, not twice
    const hold = backend.hold("GET", "/teams/t1/sheets");
    await setVisible(page, true);
    await setVisible(page, true);
    await setVisible(page, true);
    await expect.poll(() => lists(backend).products).toBe(before.products + 4);
    expect(lists(backend).sheets).toBe(before.sheets + 2);
    hold();
    await expect.poll(() => lists(backend).sheets).toBe(before.sheets + 3);
    await setVisible(page, false);
    expect(lists(backend).sheets).toBe(before.sheets + 3);
  });

  test("reconnects with backoff, and re-lists after every subscribe", async ({ page }) => {
    await page.clock.install();
    const backend = await open(page);
    await expect.poll(() => lists(backend)).toEqual({ products: 2, sheets: 2 });

    // The server closes the socket: a new one within a second, then a re-list
    await dropSocket(page);
    await page.clock.fastForward(1000);
    await expect.poll(async () => (await sockets(page)).length).toBe(2);
    await expect.poll(() => lists(backend)).toEqual({ products: 3, sheets: 3 });

    // Keep-alives: the socket is closed if none arrives within connectionTimeoutMs
    await page.clock.fastForward(200e3);
    await receive(page, { type: "ka" });
    await page.clock.fastForward(200e3);
    expect(await sockets(page)).toHaveLength(2);
    await page.clock.fastForward(100e3);
    await expect.poll(async () => (await sockets(page))[1].closed).toBe(true);

    // Back online: reconnect now instead of waiting
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(async () => (await sockets(page)).length).toBe(3);
    // Already connected: nothing to do
    await expect.poll(() => lists(backend)).toEqual({ products: 4, sheets: 4 });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    expect(await sockets(page)).toHaveLength(3);

    // Every 10 minutes while connected, and when the tab is shown again
    await page.clock.fastForward(600e3);
    await expect.poll(() => lists(backend)).toEqual({ products: 5, sheets: 5 });
    await setVisible(page, false);
    await setVisible(page, true);
    await expect.poll(() => lists(backend)).toEqual({ products: 6, sheets: 6 });
  });

  test("an acknowledgement without a timeout keeps the default keep-alive", async ({ page }) => {
    await page.clock.install();
    await open(page, undefined, { ws: { ack: false } });
    await receive(page, { type: "connection_ack" });
    await page.clock.fastForward(250e3);
    expect((await sockets(page))[0].closed).toBe(false);
    await page.clock.fastForward(60e3);
    await expect.poll(async () => (await sockets(page))[0].closed).toBe(true);
  });

  test("falls back to polling when the socket can't connect, and stops once it can", async ({ page }) => {
    await page.clock.install();
    const backend = await open(page, undefined, { ws: { ack: false } });
    const start = lists(backend);
    // No acknowledgement within 10 seconds, three times (with backoff between)
    for (let i = 1; i <= 3; i++) {
      await page.clock.fastForward(10e3);
      await expect.poll(async () => (await sockets(page))[i - 1].closed).toBe(true);
      if (i < 3) {
        await page.clock.fastForward(30e3);
        await expect.poll(async () => (await sockets(page)).length).toBe(i + 1);
      }
    }
    // Polling: a re-list now, then every 15 seconds while visible
    await expect.poll(() => lists(backend).products).toBe(start.products + 1);
    await page.clock.fastForward(15e3);
    await expect.poll(() => lists(backend).products).toBe(start.products + 2);
    // Every 60 seconds while hidden
    await setVisible(page, false);
    await page.clock.fastForward(15e3);
    await expect.poll(() => lists(backend).products).toBe(start.products + 3);
    await page.clock.fastForward(15e3);
    expect(lists(backend).products).toBe(start.products + 3);
    await setVisible(page, true);

    // The socket is tried again every 2 minutes; this time it closes before opening
    await page.evaluate(() => { window.__wsMode = { open: false }; });
    await page.clock.fastForward(120e3);
    await expect.poll(async () => (await sockets(page)).length).toBe(4);
    // Then it works: polling stops after one re-list
    await page.evaluate(() => { window.__wsMode = { open: true, ack: true, subscribe: "success" }; });
    await page.clock.fastForward(120e3);
    await expect.poll(async () => (await sockets(page)).length).toBe(5);
    await expect.poll(async () => (await sockets(page))[4].sent.length).toBe(2);
    const settled = lists(backend).products;
    await page.clock.fastForward(60e3);
    expect(lists(backend).products).toBe(settled);
  });

  test("a member removed from the team is told, and stops getting updates", async ({ page }) => {
    const backend = await open(page);
    backend.teams = [];
    // The subscription is refused; the re-list confirms they're not a member
    await page.evaluate(() => { window.__wsMode.subscribe = "error"; });
    await dropSocket(page);
    await expect(page.getByRole("heading", { name: "You're no longer in Echo Cleaning" })).toBeVisible({ timeout: 10e3 });
    const count = (await sockets(page)).length;
    // Nothing more: no re-list when shown, no reconnect when back online
    const seen = lists(backend);
    await setVisible(page, true);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    expect(lists(backend)).toEqual(seen);
    expect(await sockets(page)).toHaveLength(count);
    // Continue forgets the team and starts again
    await page.getByRole("button", { name: "Continue" }).click();
    await expect.poll(() => backend.pageLoads).toBe(2);
    expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.team"))).toBeNull();
  });

  test("a member removed while connected finds out from the next fetch", async ({ page }) => {
    const backend = await open(page);
    backend.teams = [];
    await emit(page, { v: 1, collection: "sheets", id: "s1", op: "put", version: 5 });
    await emit(page, { v: 1, collection: "sheets", id: "s1", op: "put", version: 6 });
    await expect(page.getByRole("heading", { name: "You're no longer in Echo Cleaning" })).toBeVisible();
    expect((await sockets(page)).at(-1).closed).toBe(true);
  });
});

test.describe("inventory edits", () => {
  // ADR 0014: the edit form replaces the whole item, so it must carry what it doesn't show
  test("an edit sends the item's cost, pack size and other fields back", async ({ page }) => {
    const docs = seeded();
    docs["t1/products/SKU1"] = { ...docs["t1/products/SKU1"], cost: 6.25, packSize: 12, note: "keep me" };
    const backend = await open(page, new FakeBackend({ docs }));
    await page.getByRole("button", { name: "Inventory" }).click();
    await inventoryRow(page, "Paper towels").click();
    await modal(page).getByLabel("Price each ($)").fill("9");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(inventoryRow(page, "Paper towels").locator("td").nth(2)).toHaveText("$9.00");
    expect(backend.requests("PUT", "/teams/t1/products/SKU1")[0].body).toEqual({
      data: { code: "SKU1", name: "Paper towels, 6 roll", price: 9, cost: 6.25, packSize: 12, stock: 10, note: "keep me", updatedAt: expect.any(String) },
      expectedVersion: 1,
    });
    expect(backend.doc("t1", "products", "SKU1").data).toMatchObject({ cost: 6.25, packSize: 12, note: "keep me" });
  });
});
