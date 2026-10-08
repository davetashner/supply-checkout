// The web build's runtime (src/aws/), part 2: the app's db calls on the data API
// (docs/api/openapi.yaml) and live updates (docs/api/realtime.md), against the fake
// backend in tests/fake-aws.js.
import { test, expect } from "./helpers.js";
import { modal, goToInventory, goToProjects, createProject, enterBarcode, addToProject, startReturn, saveReturn, finishReturn, lineRow, startAddItem, inventoryRow, continueReview, addItem } from "./ui/index.js";
import { usedState } from "./fixtures.js";
import { FakeBackend, TEAM, USER, openAws, connected, sockets, emit, receive, dropSocket, setVisible } from "./fake-aws.js";


const seeded = () => Object.fromEntries(Object.entries(usedState.seed).map(([k, v]) => [`t1/${k}`, v]));
// How many times each collection has been listed (first pages only)
const lists = (backend) => Object.fromEntries(["products", "projects"].map((c) => [c, backend.requests("GET", `/teams/t1/${c}`).filter((r) => !r.query.cursor).length]));
const card = (page, name) => page.getByRole("button", { name: new RegExp(name) });
// The day the page lists projects from at start (recentSince in src/aws/db.js)
const SINCE = (() => { const now = new Date(); return `${new Date(now.getFullYear(), now.getMonth() - 6, 1).getFullYear()}-01-01`; })();

// Opens the app and waits for both lists: the first load, and the re-list after subscribing
async function open(page, backend = new FakeBackend({ docs: seeded() }), opts) {
  await openAws(page, backend, opts);
  await connected(page);
  if (!opts) await expect.poll(() => lists(backend)).toEqual({ products: 2, projects: 2 });
  return backend;
}

test.describe("data", () => {
  test("maps the app's writes onto the data routes", { tag: ["@J4"] }, async ({ page }) => {
    const backend = await open(page);
    await createProject(page, "Foxtrot Dental");
    const put = backend.requests("PUT", /^\/teams\/t1\/projects\//)[0];
    const id = put.path.split("/").pop();
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    // Each write names the version it was made against: 0 for a new document
    expect(put.body).toEqual({ data: { client: "Foxtrot Dental", date: expect.any(String), createdBy: "u-pat", createdAt: expect.any(String), status: "open", items: {} }, expectedVersion: 0 });

    // Checkout: one command that adds the line and takes it off stock (docs/api/commands.md)
    await enterBarcode(page, "SKU1");
    await addToProject(page);
    await expect(lineRow(page, "Paper towels")).toBeVisible();
    await expect(page.locator("#toast")).toHaveText("Checked out 1 × Paper towels, 6 roll");
    const [checkout] = backend.requests("POST", `/teams/t1/projects/${id}/checkout`);
    expect(checkout.body).toEqual({ operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), productKey: "SKU1", quantity: 1 });
    expect(backend.doc("t1", "projects", id)).toMatchObject({ version: 2, data: { items: { SKU1: { code: "SKU1", name: "Paper towels, 6 roll", price: 8.5, out: 1, returned: 0 } } } });
    expect(backend.doc("t1", "products", "SKU1")).toMatchObject({ version: 2, data: { stock: 9 } });

    // Return, as another command with its own operation ID
    await startReturn(page);
    await enterBarcode(page, "SKU1");
    await saveReturn(page);
    await expect(page.locator("#toast")).toHaveText("1 returned · 1 of 1 back");
    const [ret] = backend.requests("POST", `/teams/t1/projects/${id}/return`);
    expect(ret.body).toEqual({ operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), productKey: "SKU1", quantity: 1 });
    expect(ret.body.operationId).not.toBe(checkout.body.operationId);
    expect(backend.doc("t1", "products", "SKU1")).toMatchObject({ version: 3, data: { stock: 10 } });
    // The stock moved on the server only: no project PATCH, and no read-then-write of the count
    expect(backend.requests("PATCH", /^\/teams\/t1\//)).toEqual([]);

    // A key with characters that need encoding in a path
    await goToInventory(page);
    await addItem(page, { barcode: "x:y@z+1", name: "Odd code" });
    await expect(inventoryRow(page, "Odd code")).toBeVisible();
    expect(backend.requests("PUT", "/teams/t1/products/x%3Ay%40z%2B1")).toHaveLength(1);
    expect(backend.doc("t1", "products", "x:y@z+1").data.name).toBe("Odd code");

    // Delete
    await goToProjects(page);
    await card(page, "Foxtrot Dental").click();
    await page.getByRole("button", { name: "Delete project" }).click();
    await page.getByRole("button", { name: "Tap again to delete" }).click();
    await expect(card(page, "Foxtrot Dental")).toHaveCount(0);
    expect(backend.requests("DELETE", `/teams/t1/projects/${id}`).map((r) => r.query)).toEqual([{ expectedVersion: "3" }]);
    expect(backend.doc("t1", "projects", id)).toBeUndefined();
  });

  // Each document's writes go one at a time (src/aws/db.js), so the second names the version
  // the first made. A change from someone else still conflicts ("a conflicting edit is refused", below).
  test("two quick edits to one project from the same page both save", { tag: ["@J4"] }, async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    const release = backend.hold("PATCH", "/teams/t1/projects/s1");
    await finishReturn(page);
    await expect.poll(() => backend.requests("PATCH", "/teams/t1/projects/s1").length).toBe(1);
    await page.getByRole("button", { name: "Edit details" }).click();
    await page.getByLabel("Client", { exact: true }).fill("Echo Studio West");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(modal(page).getByRole("button", { name: "Saving…" })).toBeDisabled();
    // Not sent until the first has answered
    expect(backend.requests("PATCH", "/teams/t1/projects/s1")).toHaveLength(1);
    release();
    await expect(page.locator("#toast")).toHaveText("Saved");
    await expect(modal(page)).toBeEmpty();
    expect(backend.requests("PATCH", "/teams/t1/projects/s1").map((r) => r.body.expectedVersion)).toEqual([1, 2]);
    expect(backend.doc("t1", "projects", "s1")).toMatchObject({ version: 3, data: { client: "Echo Studio West", status: "closed" } });
    await expect(page.getByRole("heading", { name: "Echo Studio West" })).toBeVisible();
    await expect(page.locator("#projectHead .pill")).toHaveText("Returned");
  });

  test("follows cursors to list every document", async ({ page }) => {
    const docs = seeded();
    for (let i = 1; i <= 5; i++) docs[`t1/products/p${i}`] = { code: `p${i}`, name: `Item ${i}`, price: i };
    const backend = new FakeBackend({ docs });
    backend.pageSize = 2;
    await open(page, backend);
    await goToInventory(page);
    await expect(page.locator("#main tbody tr")).toHaveCount(7);
    // Twice: the first load, and the re-list after subscribing
    expect(backend.requests("GET", "/teams/t1/products").map((c) => c.query.cursor)).toEqual([undefined, "2", "4", "6", undefined, "2", "4", "6"]);
  });

  test("passes the API's error codes to the app", async ({ page }) => {
    const backend = await open(page);
    const tryCreate = async (answer) => {
      backend.on("PUT", /^\/teams\/t1\/projects\//, answer);
      await page.getByRole("button", { name: "+ New project" }).click();
      await page.getByLabel("Client", { exact: true }).fill("Nope");
      await page.getByRole("button", { name: "Create project" }).click();
    };
    const error = (status, code) => ({ status, body: { error: { code, message: code } } });
    await tryCreate(error(413, "quota_exceeded"));
    await expect(page.locator("#toast")).toHaveText("Storage is full. Delete old projects or items to make room.");
    for (const answer of [error(400, "bad_request"), { status: 502, body: "<html>Bad gateway</html>" }, { abort: true }]) {
      await page.locator("#toast").evaluate((t) => { t.hidden = true; });
      backend.on("PUT", /^\/teams\/t1\/projects\//, answer);
      // Try again after the first failure that trying again could fix
      await page.getByRole("button", { name: /^(Create project|Try again)$/ }).click();
      await expect(page.locator("#toast")).toHaveText("That didn't save. Check your connection and try again.");
    }
    // A viewer's write (403 permission_denied, reason view_only): the app switches to view-only
    backend.on("PUT", /^\/teams\/t1\/projects\//, { status: 403, body: { error: { code: "permission_denied", message: "x", reason: "view_only" } } });
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator("#notice")).toContainText("You have view-only access.");
    expect(backend.requests("PUT", /^\/teams\/t1\/projects\//)).toHaveLength(5);
  });

  test("a conflicting edit is refused, and the latest values show with a clear message", { tag: ["@J4"] }, async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    await lineRow(page, "Paper towels").click();
    await modal(page).getByLabel("Taken").fill("7");
    // Meanwhile someone else checks out more of the same line, and this page hasn't heard yet
    const theirs = structuredClone(usedState.seed["projects/s1"]);
    theirs.items.SKU1.out = 9;
    backend.write("t1", "projects", "s1", theirs);
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#toast")).toHaveText("Someone else changed this just now, so your change wasn't saved. The latest is showing; make your change again if it's still needed.");
    await expect(modal(page)).toBeEmpty();
    await expect(lineRow(page, "Paper towels").locator("td").nth(2)).toHaveText("9");
    expect(backend.requests("PATCH", "/teams/t1/projects/s1").map((r) => r.body.expectedVersion)).toEqual([1]);
    expect(backend.doc("t1", "projects", "s1")).toMatchObject({ version: 2, data: { items: { SKU1: { out: 9 } } } });

    // Made again on the latest, it saves
    await lineRow(page, "Paper towels").click();
    await modal(page).getByLabel("Taken").fill("10");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#toast")).toHaveText("Saved");
    expect(backend.requests("PATCH", "/teams/t1/projects/s1").map((r) => r.body.expectedVersion)).toEqual([1, 2]);
    expect(backend.doc("t1", "projects", "s1").data.items.SKU1.out).toBe(10);

    // A delete that races someone else's delete: the project is gone either way
    backend.docs.delete("t1/projects/s1");
    await page.getByRole("button", { name: "Delete project" }).click();
    await page.getByRole("button", { name: "Tap again to delete" }).click();
    await expect(page.locator("#toast")).toHaveText("Someone else deleted this project, so your change wasn't saved.");
    await expect(card(page, "Echo Studio")).toHaveCount(0);
  });

  test("a first load that fails reports a lost connection", async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    backend.on("GET", "/teams/t1/products", { status: 500, body: { error: { code: "internal", message: "boom" } } });
    await openAws(page, backend);
    await expect(page.locator("#toast")).toHaveText("Lost connection to shared storage. Reload the page.");
    await expect(page.locator("#notice")).toHaveText("Connecting to shared storage… If this doesn't clear, reload the page.");
  });

  test("CSV downloads are saved by the browser", { tag: ["@J6.2"] }, async ({ page }) => {
    await page.clock.install();
    await open(page);
    await card(page, "Echo Studio").click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download CSV" }).click();
    expect((await download).suggestedFilename()).toBe("Echo Studio 2026-09-24.csv");
    // The file's object URL is released afterwards
    await page.clock.fastForward(10e3);
  });

  test("an owner exports 1,000 projects, listed page by page, as a JSON download", { tag: ["@J6", "@J10.2"] }, async ({ page }) => {
    const docs = seeded();
    // Finished long ago, so the page doesn't list them at start (supply-checkout-1dg.11): the export does
    for (let i = 0; i < 1000; i++) {
      const items = {};
      for (let j = 0; j < 20; j++) items[`k${j}`] = { code: `C${j}`, name: `Item ${j}`, price: j, out: 3, returned: 1 };
      docs[`t1/projects/b${i}`] = { client: `Client ${i}`, date: "2023-09-01", status: "closed", items };
    }
    const backend = new FakeBackend({ docs });
    backend.pageSize = 100;
    const start = Date.now();
    await open(page, backend);
    // Both lists at start were the recent projects only: one page each
    expect(backend.requests("GET", "/teams/t1/projects").map((r) => r.query)).toEqual([{ since: SINCE }, { since: SINCE }]);
    await page.getByRole("button", { name: "Export data" }).click();
    await expect(modal(page)).toContainText("1001 projects and 2 inventory items");
    const download = page.waitForEvent("download");
    await modal(page).getByRole("button", { name: "Everything (JSON)" }).click();
    const file = await download;
    expect(Date.now() - start).toBeLessThan(30e3);
    expect(file.suggestedFilename()).toMatch(/^Supply Checkout export \d{4}-\d{2}-\d{2}\.json$/);
    const json = JSON.parse(await (await import("node:fs/promises")).readFile(await file.path(), "utf8"));
    expect(json.projects).toHaveLength(1001);
    expect(json.projects.find((s) => s.id === "b7").totals).toEqual({ taken: 60, returned: 20, used: 40, charge: 380 });
    // Every project, page by page, once
    expect(backend.requests("GET", "/teams/t1/projects").slice(2).map((r) => r.query.since)).toEqual(Array(11).fill(undefined));
  });

  test("a tap survives the redraw when a re-list's pages arrive", { tag: ["@J4"] }, async ({ page }) => {
    const docs = seeded();
    for (let i = 0; i < 30; i++) docs[`t1/projects/b${i}`] = { client: `Client ${i}`, date: "2026-09-01", status: "open", items: {} };
    const backend = new FakeBackend({ docs });
    backend.pageSize = 10;
    await open(page, backend);
    const first = await card(page, "Client 0").elementHandle();
    // A re-list is held while a project is added that it will pick up
    const release = backend.hold("GET", "/teams/t1/projects");
    backend.write("t1", "projects", "late", { client: "Late job", date: "2026-08-01", status: "open", items: {} });
    await setVisible(page, true);
    await expect.poll(() => lists(backend).projects).toBe(3);
    // Press Export data, and let the re-list page in and redraw the list before letting go
    const box = await page.getByRole("button", { name: "Export data" }).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    release();
    await expect(card(page, "Late job")).toBeVisible();
    expect(await first.evaluate((el) => el.isConnected)).toBe(true);
    await page.mouse.up();
    await expect(modal(page)).toContainText("32 projects and 2 inventory items");
  });

  test("members who aren't owners get no Export data", { tag: ["@J6"] }, async ({ page }) => {
    await open(page, new FakeBackend({ teams: [{ ...TEAM, role: "contributor" }], docs: seeded() }));
    await expect(card(page, "Echo Studio")).toBeVisible();
    await expect(page.getByRole("button", { name: "Export data" })).toHaveCount(0);
  });

  test("the rest of the runtime's surface", async ({ page }) => {
    const backend = await open(page, new FakeBackend({
      docs: {
        ...seeded(),
        "t1/projects/a": { client: "A", date: "2026-09-01" },
        "t1/projects/b": { client: "B", date: "2026-09-01" },
        "t1/projects/c": { client: "C" },
        "t1/notes/n1": { text: "hi" },
      },
    }));
    backend.on("GET", "/teams/t1/projects/broken", { status: 500, body: { error: { code: "internal", message: "boom" } } });
    const result = await page.evaluate(async () => {
      const db = await window.claude.use("db"), user = await window.claude.use("user");
      const got = await db.doc("projects/a").get(), missing = await db.collection("projects").doc("zz").get();
      const broken = await db.doc("projects/broken").get().then(() => "resolved", (e) => e.code);
      const asc = (await db.collection("projects").orderBy("date").get()).docs.map((d) => d.id);
      const byId = await db.collection("projects").get();
      const added = await db.collection("notes").add({ text: "new" });
      // Listening for one document, and a second listener on a loaded collection
      const one = await new Promise((resolve) => { const stop = db.doc("projects/a").onSnapshot((s) => { stop(); resolve(s); }); });
      const again = await new Promise((resolve) => { const stop = db.collection("products").onSnapshot((s) => { stop(); resolve(s.size); }); });
      return {
        got: [got.exists, got.id, got.data().client], missing: [missing.exists, missing.data()], broken, asc,
        byId: [byId.size, byId.empty, byId.docChanges().length, byId.metadata.fromCache], added: added.id.length,
        one: [one.exists, one.data().client], again,
        can: [await user.can("data.write"), await user.can("billing.manage")], id: await user.id(),
        profiles: await user.profiles(["u-pat", "u-other"]),
        sample: typeof (await window.claude.use("sample")).json, other: await window.claude.use("clipboard"),
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
      sample: "function", other: null,
    });
    expect(backend.requests("PUT", /^\/teams\/t1\/notes\//)).toHaveLength(1);
  });

  test("the user's name falls back to their email", { tag: ["@J4"] }, async ({ page }) => {
    await open(page, new FakeBackend({ claims: { email: "pat@example.com" }, docs: { "t1/projects/m": { client: "Mine", date: "2026-09-25", createdBy: "u-pat", status: "open", items: {} } } }));
    await expect(card(page, "Mine")).toContainText("pat@example.com");
  });
});

test.describe("checkout and return commands", { tag: ["@J4"] }, () => {
  const CHECKOUT = "/teams/t1/projects/s1/checkout", RETURN = "/teams/t1/projects/s1/return";
  const toast = (page) => page.locator("#toast");
  const hideToast = (page) => toast(page).evaluate((t) => { t.hidden = true; });
  const scanOut = async (page, qty) => {
    await enterBarcode(page, "SKU1");
    for (let i = 1; i < qty; i++) await modal(page).getByRole("button", { name: "More" }).click();
    await modal(page).getByRole("button", { name: `Add ${qty} to project` }).click();
  };

  test("two people checking out the same item at once leave the line and the stock right", { tag: ["@J4.2"] }, async ({ page }) => {
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
    expect(backend.doc("t1", "projects", "s1").data.items.SKU1).toMatchObject({ out: 3 + 2 + 3, returned: 1 });
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(10 - 2 - 3);
    const ids = backend.requests("POST", CHECKOUT).map((r) => r.body.operationId);
    expect(new Set(ids).size).toBe(2);
    expect(backend.requests("PATCH", /^\/teams\/t1\//)).toEqual([]);
    // The one answered last has both
    await expect(lineRow(other, "Paper towels").locator("td").nth(2)).toHaveText("8");
    await other.close();
  });

  test("a retry after a lost answer sends the same operation ID, so it counts once", { tag: ["@J4.2"] }, async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    // The API saves the checkout, but the answer never arrives
    backend.on("POST", CHECKOUT, { lost: true });
    await scanOut(page, 1);
    await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(9);
    // Tapping again retries the same action
    await hideToast(page);
    await modal(page).getByRole("button", { name: "Try again" }).click();
    await expect(toast(page)).toHaveText("Checked out 1 × Paper towels, 6 roll");
    const [first, retry] = backend.requests("POST", CHECKOUT).map((r) => r.body);
    expect(retry).toEqual(first);
    expect(backend.operations.size).toBe(1);
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(9);
    expect(backend.doc("t1", "projects", "s1").data.items.SKU1.out).toBe(4);
    await expect(lineRow(page, "Paper towels").locator("td").nth(2)).toHaveText("4");

    // A request changed after a failure is a new operation
    await startReturn(page);
    backend.on("POST", RETURN, { status: 503, body: { error: { code: "unavailable", message: "try again" } } });
    await enterBarcode(page, "SKU1");
    await saveReturn(page);
    await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
    await modal(page).getByRole("button", { name: "More" }).click();
    await modal(page).getByRole("button", { name: "Try again" }).click();
    await expect(toast(page)).toHaveText("2 returned · 3 of 4 back");
    const [failed, changed] = backend.requests("POST", RETURN).map((r) => r.body);
    expect([failed.quantity, changed.quantity]).toEqual([1, 2]);
    expect(changed.operationId).not.toBe(failed.operationId);
    expect(backend.doc("t1", "projects", "s1").data.items.SKU1.returned).toBe(3);
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(11);
  });

  test("a retried return is the same request even after a live update changed the line", { tag: ["@J4.3"] }, async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    await startReturn(page);
    // 3 out, 1 back: return the other 2, and the answer is lost
    backend.on("POST", RETURN, { lost: true });
    await enterBarcode(page, "SKU1");
    await modal(page).getByRole("button", { name: "More" }).click();
    await saveReturn(page);
    await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
    // The saved return's live update arrives while the form is still open
    await emit(page, { v: 1, eventId: "e1", collection: "projects", id: "s1", op: "put", version: backend.doc("t1", "projects", "s1").version });
    await expect(lineRow(page, "Paper towels")).toContainText("3");
    await hideToast(page);
    await modal(page).getByRole("button", { name: "Try again" }).click();
    await expect(toast(page)).toHaveText("2 returned · 3 of 3 back");
    const [first, retry] = backend.requests("POST", RETURN).map((r) => r.body);
    expect(retry).toEqual(first);
    expect(first.quantity).toBe(2);
    expect(backend.operations.size).toBe(1);
    expect(backend.doc("t1", "projects", "s1").data.items.SKU1).toMatchObject({ out: 3, returned: 3 });
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(12);
  });

  test("a retried checkout of a new item saves the item once", { tag: ["@J4.2"] }, async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    backend.on("POST", CHECKOUT, { lost: true });
    await enterBarcode(page, "NEW1");
    await modal(page).getByLabel("Item name").fill("Wax");
    await addToProject(page);
    await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
    // Someone else edits the new item meanwhile: saving it again would conflict
    backend.write("t1", "products", "NEW1", { code: "NEW1", name: "Floor wax", price: 0 });
    await hideToast(page);
    await modal(page).getByRole("button", { name: "Try again" }).click();
    await expect(toast(page)).toHaveText("Checked out 1 × Wax");
    expect(backend.requests("PUT", "/teams/t1/products/NEW1")).toHaveLength(1);
    expect(backend.operations.size).toBe(1);
    expect(backend.doc("t1", "projects", "s1").data.items.NEW1).toMatchObject({ out: 1 });
  });

  for (const kind of ["checkout", "return"]) {
    test(`a ${kind} by someone made a viewer meanwhile is refused, and the app switches to view-only`, { tag: ["@J9.1"] }, async ({ page }) => {
      const backend = await open(page);
      await card(page, "Echo Studio").click();
      if (kind === "return") await page.getByRole("button", { name: "Return", exact: true }).click();
      await enterBarcode(page, "SKU1");
      backend.teams[0].role = "viewer";
      await modal(page).getByRole("button", { name: kind === "return" ? "Save return" : "Add 1 to project" }).click();
      await expect(page.locator("#notice")).toContainText("You have view-only access.");
      expect(backend.requests("POST", `/teams/t1/projects/s1/${kind}`)).toHaveLength(1);
      expect(backend.operations.size).toBe(0);
      expect(backend.doc("t1", "projects", "s1").version).toBe(1);
    });
  }

  test("a return on a project deleted as it saves still says what came back", async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    await startReturn(page);
    await enterBarcode(page, "SKU1");
    backend.on("POST", RETURN, { status: 200, body: { operationId: "x", replayed: false, result: { quantity: 1 }, project: null, product: null } });
    await saveReturn(page);
    await expect(toast(page)).toHaveText("1 returned · 0 of 0 back");
    await expect(card(page, "Echo Studio")).toHaveCount(0);
  });

  // A 409 (a busy line on the server, say) is sent again once with the same operation ID: the
  // server adds the quantity to the line as it is then (src/aws/db.js command)
  test("a checkout refused once as a conflict is sent again and saves, with no conflict message", async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    backend.on("POST", CHECKOUT, { status: 409, body: { error: { code: "aborted", message: "busy" } } });
    await scanOut(page, 2);
    await expect(toast(page)).toHaveText("Checked out 2 × Paper towels, 6 roll");
    await expect(lineRow(page, "Paper towels").locator("td").nth(2)).toHaveText("5");
    const [first, again] = backend.requests("POST", CHECKOUT).map((r) => r.body);
    expect(again).toEqual(first);
    expect(backend.doc("t1", "projects", "s1").data.items.SKU1.out).toBe(5);
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(8);
  });

  test("a return refused as a conflict twice shows the conflict message", async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    await startReturn(page);
    await enterBarcode(page, "SKU1");
    backend.on("POST", RETURN, { status: 409, body: { error: { code: "aborted", message: "busy" } } }, 2);
    await saveReturn(page);
    await expect(toast(page)).toContainText("Someone else changed this just now");
    await expect(modal(page)).toBeEmpty();
    const [first, again] = backend.requests("POST", RETURN).map((r) => r.body);
    expect(again).toEqual(first);
    expect(backend.doc("t1", "projects", "s1").data.items.SKU1.returned).toBe(1);
  });

  test("a project closed meanwhile refuses a checkout, and the latest project and item show", async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    await enterBarcode(page, "SKU1");
    // Someone else finishes the return and recounts storage, and this page hasn't heard yet
    backend.write("t1", "projects", "s1", { ...usedState.seed["projects/s1"], status: "closed" });
    backend.write("t1", "products", "SKU1", { ...usedState.seed["products/SKU1"], stock: 4 });
    await addToProject(page);
    await expect(toast(page)).toContainText("Someone else changed this just now");
    await expect(modal(page)).toBeEmpty();
    await expect(page.locator("#projectHead .pill")).toHaveText("Returned");
    // Sent again once, as a 409 is, and refused again
    expect(backend.requests("POST", CHECKOUT)).toHaveLength(2);
    expect(backend.requests("GET", "/teams/t1/projects/s1")).toHaveLength(1);
    expect(backend.requests("GET", "/teams/t1/products/SKU1")).toHaveLength(1);
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(4);
  });

  test("a return of more than are left now shows the API's reason and the latest line, not a connection problem", async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    await startReturn(page);
    // 3 out, 1 back: the form offers the other 2
    await enterBarcode(page, "SKU1");
    await modal(page).getByRole("button", { name: "More" }).click();
    // Someone else returns 1 of them, and this page hasn't heard yet
    const seed = usedState.seed["projects/s1"];
    backend.write("t1", "projects", "s1", { ...seed, items: { ...seed.items, SKU1: { ...seed.items.SKU1, returned: 2 } } });
    await saveReturn(page);
    await expect(toast(page)).toHaveText("Only 1 of this item is left to return. The latest is showing.");
    await expect(modal(page)).toBeEmpty();
    expect(backend.requests("GET", "/teams/t1/projects/s1")).toHaveLength(1);
    expect(backend.requests("GET", "/teams/t1/products/SKU1")).toHaveLength(1);
    // Returning again offers the 1 that's left
    await enterBarcode(page, "SKU1");
    await expect(modal(page)).toContainText("3 taken · 2 back");
    await saveReturn(page);
    await expect(toast(page)).toHaveText("1 returned · 3 of 3 back");
  });

  test("a return of a line removed meanwhile says it isn't on the project", async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    await startReturn(page);
    await enterBarcode(page, "SKU1");
    const rest = Object.fromEntries(Object.entries(usedState.seed["projects/s1"].items).filter(([k]) => k !== "SKU1"));
    backend.write("t1", "projects", "s1", { ...usedState.seed["projects/s1"], items: rest });
    await saveReturn(page);
    await expect(toast(page)).toHaveText("This item isn't on this project. The latest is showing.");
    await expect(modal(page)).toBeEmpty();
    await expect(lineRow(page, "Paper towels")).toHaveCount(0);
  });

  test("a checkout on a project deleted meanwhile says so and the project goes", async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    await enterBarcode(page, "SKU1");
    backend.docs.delete("t1/projects/s1");
    await addToProject(page);
    await expect(toast(page)).toHaveText("No such project. The latest is showing.");
    await expect(modal(page)).toBeEmpty();
    await expect(card(page, "Echo Studio")).toHaveCount(0);
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(10);
  });

  // Whether or not this page has heard of the delete yet, a write to the project says it was
  // deleted, never recreates it, and doesn't switch the page to view-only
  for (const heard of [false, true]) {
    test(`editing a line on a project deleted meanwhile says so${heard ? ", after hearing of it" : ""}`, async ({ page }) => {
      const backend = await open(page);
      await card(page, "Echo Studio").click();
      await lineRow(page, "Paper towels").click();
      backend.docs.delete("t1/projects/s1");
      if (heard) {
        await emit(page, { v: 1, eventId: "d1", collection: "projects", id: "s1", op: "delete", version: 2, at: Date.now() });
        await expect(card(page, "Echo Studio")).toHaveCount(0);
      }
      await modal(page).getByRole("button", { name: "Save" }).click();
      await expect(toast(page)).toHaveText("Someone else deleted this project, so your change wasn't saved.");
      await expect(modal(page)).toBeEmpty();
      await expect(card(page, "Echo Studio")).toHaveCount(0);
      await expect(page.locator("#notice")).toBeHidden();
      expect(backend.requests("PATCH", "/teams/t1/projects/s1").map((r) => r.body.expectedVersion)).toEqual([heard ? 0 : 1]);
      expect(backend.doc("t1", "projects", "s1")).toBeUndefined();
    });

    test(`removing a line from a project deleted meanwhile doesn't make it again${heard ? ", after hearing of it" : ""}`, async ({ page }) => {
      const backend = await open(page);
      await card(page, "Echo Studio").click();
      await lineRow(page, "Paper towels").click();
      backend.docs.delete("t1/projects/s1");
      if (heard) {
        await emit(page, { v: 1, eventId: "d1", collection: "projects", id: "s1", op: "delete", version: 2, at: Date.now() });
        await expect(card(page, "Echo Studio")).toHaveCount(0);
      }
      await modal(page).getByRole("button", { name: "Remove" }).click();
      await modal(page).getByRole("button", { name: "Tap to remove" }).click();
      await expect(toast(page)).toHaveText("Someone else deleted this project, so your change wasn't saved.");
      await expect(page.locator("#notice")).toBeHidden();
      expect(backend.requests("PUT", "/teams/t1/projects/s1")).toEqual([]);
      expect(backend.doc("t1", "projects", "s1")).toBeUndefined();
    });
  }

  test("removing a line saves the project as the server has it, without the line", async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    await lineRow(page, "Paper towels").click();
    await modal(page).getByRole("button", { name: "Remove" }).click();
    await modal(page).getByRole("button", { name: "Tap to remove" }).click();
    await expect(toast(page)).toHaveText("Removed");
    await expect(lineRow(page, "Paper towels")).toHaveCount(0);
    const [put] = backend.requests("PUT", "/teams/t1/projects/s1");
    expect(put.body.expectedVersion).toBe(1);
    expect(Object.keys(put.body.data.items)).toEqual(["nb-bins"]);
  });

  // The answer's project may have no items, or no longer have the line (removed by someone
  // else right after): the return still saved, so it says what came back
  for (const [what, data] of [["no items", {}], ["no such line", { items: { SKU2: { out: 1, returned: 0 } } }]]) {
    test(`a saved return whose answer has ${what} still says what came back`, async ({ page }) => {
      const backend = await open(page);
      await card(page, "Echo Studio").click();
      await startReturn(page);
      await enterBarcode(page, "SKU1");
      backend.on("POST", RETURN, { status: 200, body: { operationId: "x", replayed: false, result: { quantity: 1 }, project: { id: "s1", version: 9, data: { ...usedState.seed["projects/s1"], items: undefined, ...data } }, product: null } });
      await saveReturn(page);
      await expect(toast(page)).toHaveText("1 returned · 0 of 0 back");
      await expect(modal(page)).toBeEmpty();
    });
  }

  test("an item that isn't saved to inventory sends its name and price for the line", async ({ page }) => {
    const backend = await open(page);
    await card(page, "Echo Studio").click();
    await page.getByRole("button", { name: "Add item without a barcode" }).click();
    await modal(page).getByRole("button", { name: "+ New item" }).click();
    await modal(page).getByLabel("Item name").fill("Ladder rental");
    await modal(page).getByLabel("Price each ($)").fill("12.35");
    await modal(page).getByLabel("Save to inventory for next time").uncheck();
    await addToProject(page);
    await expect(lineRow(page, "Ladder rental")).toBeVisible();
    const [{ body }] = backend.requests("POST", CHECKOUT);
    expect(body).toEqual({ operationId: expect.any(String), productKey: expect.stringMatching(/^nb-/), quantity: 1, name: "Ladder rental", price: 12.35, code: "" });
    expect(backend.requests("PUT", /^\/teams\/t1\/products\//)).toEqual([]);
    expect(backend.doc("t1", "projects", "s1").data.items[body.productKey]).toEqual({ code: "", name: "Ladder rental", price: 12.35, out: 1, returned: 0 });
  });
});

// Recent projects first (supply-checkout-1dg.11): the page lists open projects and the finished
// ones from SINCE on, and the older ones when someone asks for them
test.describe("older projects", { tag: ["@J6"] }, () => {
  const Y = SINCE.slice(0, 4), OLD = String(Number(Y) - 2);
  const older = () => {
    const docs = seeded();
    docs["t1/projects/old"] = { client: "Oldfield Co", date: `${OLD}-05-01`, status: "closed", closedAt: `${OLD}-05-03T10:00:00Z`, items: {} };
    docs["t1/projects/long"] = { client: "Long Job", date: `${Number(Y) - 3}-03-01`, status: "open", items: {} };
    docs["t1/projects/late"] = { client: "Late Return", date: `${OLD}-07-01`, status: "closed", closedAt: `${Y}-02-01T10:00:00Z`, items: {} };
    docs["t1/projects/new"] = { client: "Newton Inc", date: `${Y}-02-10`, status: "closed", items: {} };
    return new FakeBackend({ docs });
  };
  const returned = (page) => page.getByRole("button", { name: "Returned", exact: true }).click();
  // An older year's group starts closed: its heading shows
  const yearGroup = (page, y) => page.locator(`.year-toggle[data-year="${y}"]`);
  const fullLists = (backend) => backend.requests("GET", "/teams/t1/projects").filter((r) => !r.query.since).length;

  test("starts with open and recent projects; Show older projects lists the rest", async ({ page }) => {
    const backend = await open(page, older());
    expect(backend.requests("GET", "/teams/t1/projects").every((r) => r.query.since === SINCE)).toBe(true);
    // Out now has every open project, however old, and no note about older ones
    await expect(card(page, "Long Job")).toBeVisible();
    await expect(page.locator(".older-row")).toHaveCount(0);
    await returned(page);
    await expect(card(page, "Newton Inc")).toBeVisible();
    // Finished since the day, though dated before it: the only one in its year, for now
    await expect(yearGroup(page, OLD)).toContainText("1 project");
    await yearGroup(page, OLD).click();
    await expect(card(page, "Late Return")).toBeVisible();
    await expect(card(page, "Oldfield Co")).toHaveCount(0);
    await expect(page.locator(".older-row")).toContainText(`Projects returned before ${Y} aren't shown yet.`);
    // While they're listed it says so, and the button goes
    const release = backend.hold("GET", (path, call) => path === "/teams/t1/projects" && !call.query.since);
    await page.getByRole("button", { name: "Show older projects" }).click();
    await expect(page.locator(".older-row")).toHaveText("Loading older projects…");
    release();
    await expect(yearGroup(page, OLD)).toContainText("2 projects");
    await expect(page.locator(".older-row")).toHaveCount(0);
    expect(fullLists(backend)).toBe(1);
    // From now on a re-list is of every project
    await setVisible(page, true);
    await expect.poll(() => fullLists(backend)).toBe(2);
    await expect(card(page, "Oldfield Co")).toBeVisible();
  });

  test("a search lists the older projects, once", async ({ page }) => {
    const backend = await open(page, older());
    const box = page.getByRole("searchbox", { name: "Search projects" });
    // A space isn't a search
    await box.fill(" ");
    await returned(page);
    expect(fullLists(backend)).toBe(0);
    await box.fill("oldf");
    await expect(card(page, "Oldfield Co")).toBeVisible();
    await box.fill("oldfi");
    await box.fill("");
    await expect(card(page, "Newton Inc")).toBeVisible();
    expect(fullLists(backend)).toBe(1);
  });

  test("the year filter offers the years before, which lists them", async ({ page }) => {
    const backend = await open(page, older());
    const year = page.getByRole("combobox", { name: "Year" });
    await returned(page);
    // This year's projects need nothing more; Before <year> lists the older ones and shows all years
    await year.selectOption(Y);
    await year.selectOption("");
    expect(fullLists(backend)).toBe(0);
    await year.selectOption({ label: `Before ${Y}` });
    await expect(yearGroup(page, OLD)).toContainText("2 projects");
    await expect(year).toHaveValue("");
    await expect(year.locator("option")).toHaveText(["All years", Y, OLD, String(Number(Y) - 3)]);
    expect(fullLists(backend)).toBe(1);
  });

  test("picking a year before the day, which an open project has, lists the older projects", async ({ page }) => {
    const backend = await open(page, older());
    await returned(page);
    await page.getByRole("combobox", { name: "Year" }).selectOption(String(Number(Y) - 3));
    await expect.poll(() => fullLists(backend)).toBe(1);
  });

  test("Export data lists the older projects first, and says so if it can't", async ({ page }) => {
    const backend = await open(page, older());
    backend.on("GET", (path, call) => path === "/teams/t1/projects" && !call.query.since, { status: 500, body: { error: { code: "internal", message: "boom" } } });
    await page.getByRole("button", { name: "Export data" }).click();
    await expect(page.locator("#toast")).toHaveText("Couldn't load older projects. Check the connection and try again.");
    await expect(modal(page)).toBeHidden();
    // A second tap while the first is still listing waits for that listing, and lists nothing more
    const release = backend.hold("GET", (path, call) => path === "/teams/t1/projects" && !call.query.since);
    await page.getByRole("button", { name: "Export data" }).click();
    await expect.poll(() => fullLists(backend)).toBe(2);
    await page.getByRole("button", { name: "Export data" }).click();
    release();
    await expect(modal(page)).toContainText("5 projects and 2 inventory items");
    expect(fullLists(backend)).toBe(2);
  });

  test("Export data tapped while a search is listing the older projects waits for it, then opens", async ({ page }) => {
    const backend = await open(page, older());
    const release = backend.hold("GET", (path, call) => path === "/teams/t1/projects" && !call.query.since);
    await page.getByRole("searchbox", { name: "Search projects" }).fill("oldf");
    await expect.poll(() => fullLists(backend)).toBe(1);
    await page.getByRole("button", { name: "Export data" }).click();
    await page.waitForTimeout(100);
    await expect(modal(page)).toBeHidden();
    release();
    await expect(modal(page)).toContainText("5 projects and 2 inventory items");
    expect(fullLists(backend)).toBe(1);
  });

  test("an older project someone else edits stays open across re-lists", async ({ page }) => {
    const backend = await open(page, older());
    const v = backend.write("t1", "projects", "old", { ...backend.doc("t1", "projects", "old").data, client: "Oldfield & Sons" });
    await emit(page, { v: 1, eventId: "o1", collection: "projects", id: "old", op: "put", version: v });
    await returned(page);
    await expect(yearGroup(page, OLD)).toContainText("2 projects");
    await yearGroup(page, OLD).click();
    await card(page, "Oldfield & Sons").click();
    await expect(page.locator(".project-head")).toContainText("Oldfield & Sons");
    // A re-list of the recent projects doesn't have it, and the page keeps it
    await setVisible(page, true);
    await expect.poll(() => lists(backend).projects).toBe(3);
    await page.waitForTimeout(100);
    await expect(page.locator(".project-head")).toContainText("Oldfield & Sons");
    await page.getByRole("button", { name: "← All projects" }).click();
    await expect(yearGroup(page, OLD)).toContainText("2 projects");
    // Deleted by someone else: gone, and not kept
    backend.docs.delete("t1/projects/old");
    await emit(page, { v: 1, eventId: "o2", collection: "projects", id: "old", op: "delete", version: v });
    await expect(yearGroup(page, OLD)).toContainText("1 project");
    await setVisible(page, true);
    await expect.poll(() => lists(backend).projects).toBe(4);
    await expect(yearGroup(page, OLD)).toContainText("1 project");
    // Once every project is listed, the list is all there is
    await page.getByRole("button", { name: "Show older projects" }).click();
    await expect(page.locator(".older-row")).toHaveCount(0);
    expect(fullLists(backend)).toBe(1);
  });

  test("a live update to an older project not listed yet shows it, as someone reopens it", async ({ page }) => {
    const backend = await open(page, older());
    const v = backend.write("t1", "projects", "old", { ...backend.doc("t1", "projects", "old").data, status: "open" });
    await emit(page, { v: 1, eventId: "r1", collection: "projects", id: "old", op: "put", version: v });
    await expect(card(page, "Oldfield Co")).toBeVisible();
    expect(fullLists(backend)).toBe(0);
  });
});

test.describe("live updates", { tag: ["@J4"] }, () => {
  test("another user's changes arrive as events and are fetched", async ({ page }) => {
    const backend = await open(page);
    const gets = (id) => backend.requests("GET", `/teams/t1/projects/${id}`).length;

    // A new project
    const v = backend.write("t1", "projects", "s2", { client: "Golf Club", date: "2026-09-25", status: "open", items: {} });
    await emit(page, { v: 1, eventId: "e1", collection: "projects", id: "s2", op: "put", version: v, at: Date.now() });
    await expect(card(page, "Golf Club")).toBeVisible();
    // The same version again, or an older one: nothing to fetch
    await emit(page, { v: 1, eventId: "e1", collection: "projects", id: "s2", op: "put", version: v });
    await emit(page, { v: 1, eventId: "e0", collection: "projects", id: "s2", op: "put", version: v - 1 });
    // A product's stock changes without a new version, so the same version is fetched
    backend.doc("t1", "products", "SKU1").data.stock = 4;
    await emit(page, { v: 1, eventId: "e2", collection: "products", id: "SKU1", op: "put", version: 1 });
    await goToInventory(page);
    await expect(page.locator("#main tbody tr", { hasText: "Paper towels" })).toContainText("4");
    await goToProjects(page);
    expect(gets("s2")).toBe(1);
    expect(backend.requests("GET", "/teams/t1/products/SKU1")).toHaveLength(1);

    // Deleted: dropped without a fetch
    backend.docs.delete("t1/projects/s2");
    await emit(page, { v: 1, eventId: "e3", collection: "projects", id: "s2", op: "delete", version: v });
    await expect(card(page, "Golf Club")).toHaveCount(0);
    expect(gets("s2")).toBe(1);

    // Gone by the time it's fetched; a fetch that fails; things to ignore
    await emit(page, { v: 1, eventId: "e4", collection: "projects", id: "s3", op: "put", version: 1 });
    backend.on("GET", "/teams/t1/projects/s4", { status: 500, body: { error: { code: "internal", message: "boom" } } });
    await emit(page, { v: 1, eventId: "e5", collection: "projects", id: "s4", op: "put", version: 1 });
    await emit(page, "not json");
    await emit(page, { v: 2, collection: "projects", id: "s5", op: "put", version: 1 });
    await emit(page, { v: 1, collection: "notes", id: "n1", op: "put", version: 1 });
    // The server's old-named copy of a project's event, for clients from before the rename
    await emit(page, { v: 1, eventId: "e5#sheets", collection: "sheets", id: "s8", op: "put", version: 1 });
    // Names an object has without owning them: no error (the page fixture fails on one)
    await emit(page, { v: 1, collection: "constructor", id: "c1", op: "put", version: 1 });
    await emit(page, { v: 1, collection: "__proto__", id: "p1", op: "delete", version: 1 });
    // Another team's change (the user's channel carries all their teams): not this page's
    await emit(page, { v: 1, teamId: "t2", collection: "projects", id: "s7", op: "put", version: 1 });
    await receive(page, { type: "data", id: "another-subscription", event: JSON.stringify({ v: 1, collection: "projects", id: "s6", op: "put", version: 1 }) });
    await receive(page, { type: "connection_error", errors: [] });
    await expect.poll(() => gets("s3") + gets("s4")).toBe(2);
    expect(gets("s5") + gets("s6") + gets("s7") + gets("s8")).toBe(0);
    expect(backend.requests("GET", /\/sheets/)).toHaveLength(0);
    await expect(card(page, "Echo Studio")).toBeVisible();
  });

  test("events for one document are fetched one at a time, and never go backwards", async ({ page }) => {
    const backend = await open(page);
    const release = backend.hold("GET", "/teams/t1/projects/s1");
    for (const client of ["One", "Two", "Three"]) {
      const version = backend.write("t1", "projects", "s1", { ...usedState.seed["projects/s1"], client });
      await emit(page, { v: 1, collection: "projects", id: "s1", op: "put", version });
    }
    await expect.poll(() => backend.requests("GET", "/teams/t1/projects/s1").length).toBe(1);
    release();
    await expect(card(page, "Three")).toBeVisible();
    expect(backend.requests("GET", "/teams/t1/projects/s1")).toHaveLength(2);

    // A stale answer (an older version than the one held) is ignored
    backend.on("GET", "/teams/t1/projects/s1", { status: 200, body: { id: "s1", version: 1, data: { ...usedState.seed["projects/s1"], client: "Stale" } } });
    await emit(page, { v: 1, collection: "projects", id: "s1", op: "put", version: 9 });
    await expect.poll(() => backend.requests("GET", "/teams/t1/projects/s1").length).toBe(3);
    await setVisible(page, false);
    await expect(card(page, "Three")).toBeVisible();
    await expect(card(page, "Stale")).toHaveCount(0);
  });

  test("a 200-row import is one re-list for each client, not 200 fetches", async ({ page }) => {
    const backend = await open(page);
    const productGets = () => backend.requests("GET", /^\/teams\/t1\/products\/./).length;
    // The import's 200 items, and the events for them, arriving together
    const events = Array.from({ length: 200 }, (_, i) => {
      const id = `IMP${String(i).padStart(3, "0")}`;
      return { v: 1, teamId: "t1", collection: "products", id, op: "put", version: backend.write("t1", "products", id, { name: `Imported ${i}`, price: 1, stock: i }) };
    });
    await page.evaluate((evs) => evs.forEach((e) => window.__sockets.at(-1).event(e)), events);
    await expect.poll(() => lists(backend).products).toBe(3);
    // The first few are fetched before it's clear this is a burst; the rest come with the re-list
    expect(productGets()).toBe(10);
    await goToInventory(page);
    await expect(page.locator("#main tbody tr", { hasText: "Imported 199" })).toBeVisible();
    await expect(page.locator("#main tbody tr", { hasText: "Imported 150" })).toBeVisible();
    expect(lists(backend)).toEqual({ products: 3, projects: 2 });
    expect(productGets()).toBe(10);
  });

  test("a burst that goes on is re-listed every 2 seconds, and single events are fetched again once it's over", async ({ page }) => {
    await page.clock.install();
    const backend = await open(page);
    await page.clock.pauseAt(new Date(Date.now() + 60e3));
    const productGets = () => backend.requests("GET", /^\/teams\/t1\/products\/./).length;
    let n = 0;
    const burst = (count) => page.evaluate((evs) => evs.forEach((e) => window.__sockets.at(-1).event(e)),
      Array.from({ length: count }, () => ({ v: 1, teamId: "t1", collection: "products", id: `B${n++}`, op: "put", version: 1 })));

    // Ten are fetched; the eleventh is held
    await burst(11);
    await expect.poll(productGets).toBe(10);
    // Events keep coming, never 300 ms apart: the re-list waits no more than 2 seconds
    for (let i = 0; i < 7; i++) {
      await page.clock.runFor(250);
      await burst(1);
    }
    expect(lists(backend).products).toBe(2);
    await page.clock.runFor(250);
    await expect.poll(() => lists(backend).products).toBe(3);
    // The re-list used up the fetch budget, so the next event is held too, until 300 ms of quiet
    await burst(1);
    await page.clock.runFor(299);
    expect(lists(backend).products).toBe(3);
    await page.clock.runFor(1);
    await expect.poll(() => lists(backend).products).toBe(4);
    // A second later, one event is one fetch again
    await page.clock.runFor(1000);
    await burst(1);
    await expect.poll(productGets).toBe(11);
    expect(lists(backend)).toEqual({ products: 4, projects: 2 });
  });

  test("a collection event from the consumer re-lists at once, in place of a burst being held", async ({ page }) => {
    const backend = await open(page);
    const productGets = () => backend.requests("GET", /^\/teams\/t1\/products\/./).length;
    // An import the consumer sent as one event: no document named, so re-list
    for (let i = 0; i < 12; i++) backend.write("t1", "products", `IMP${i}`, { name: `Imported ${i}`, price: 1, stock: i });
    await emit(page, { v: 2, eventId: "i1~i12", collection: "products", op: "list", changes: 12, at: Date.now() });
    await expect.poll(() => lists(backend).products).toBe(3);
    await goToInventory(page);
    await expect(page.locator("#main tbody tr", { hasText: "Imported 11" })).toBeVisible();
    expect(productGets()).toBe(0);
    // The re-list used up the second's fetches, so more events are held for a re-list when they go quiet.
    // A collection event meanwhile re-lists at once, and there's no second re-list when they do
    await page.evaluate((evs) => evs.forEach((e) => window.__sockets.at(-1).event(e)),
      Array.from({ length: 3 }, (_, i) => ({ v: 1, teamId: "t1", collection: "products", id: `IMP${i}`, op: "put", version: 9 })));
    await emit(page, { v: 2, eventId: "i13~i30", collection: "products", op: "list", changes: 18 });
    await expect.poll(() => lists(backend).products).toBe(4);
    await page.waitForTimeout(500);
    expect(lists(backend)).toEqual({ products: 4, projects: 2 });
    expect(productGets()).toBe(0);
    // A v 2 event that isn't a re-list, or for another team, is ignored
    await emit(page, { v: 2, eventId: "odd", collection: "products", op: "put", id: "IMP1" });
    await emit(page, { v: 2, teamId: "t2", eventId: "other", collection: "products", op: "list", changes: 20 });
    await page.waitForTimeout(100);
    expect(lists(backend)).toEqual({ products: 4, projects: 2 });
  });

  test("an event sent again by a retried batch is applied once", async ({ page }) => {
    const backend = await open(page);
    const gets = () => backend.requests("GET", "/teams/t1/projects/s9").length;
    let v = backend.write("t1", "projects", "s9", { client: "Retry job", date: "2026-09-26", status: "open", items: {} });
    await emit(page, { v: 1, eventId: "x1", collection: "projects", id: "s9", op: "put", version: v });
    await expect(card(page, "Retry job")).toBeVisible();
    // The same event again, even naming a newer version: already seen
    v = backend.write("t1", "projects", "s9", { client: "Retry job 2", date: "2026-09-26", status: "open", items: {} });
    await emit(page, { v: 1, eventId: "x1", collection: "projects", id: "s9", op: "put", version: v });
    // An event without an ID always goes through
    await emit(page, { v: 1, eventId: "", collection: "projects", id: "s9", op: "put", version: v });
    await expect(card(page, "Retry job 2")).toBeVisible();
    expect(gets()).toBe(2);
    // Only the last 500 IDs are remembered
    await page.evaluate(() => { for (let i = 0; i < 500; i++) window.__sockets.at(-1).event({ v: 1, teamId: "t2", eventId: `other-${i}`, collection: "projects", id: "z", op: "put", version: 1 }); });
    v = backend.write("t1", "projects", "s9", { client: "Retry job 3", date: "2026-09-26", status: "open", items: {} });
    await emit(page, { v: 1, eventId: "x1", collection: "projects", id: "s9", op: "put", version: v });
    await expect(card(page, "Retry job 3")).toBeVisible();
    expect(gets()).toBe(3);
    // A collection event already seen doesn't re-list again
    await emit(page, { v: 2, eventId: "a~b", collection: "projects", op: "list", changes: 11 });
    await expect.poll(() => lists(backend).projects).toBe(3);
    await emit(page, { v: 2, eventId: "a~b", collection: "projects", op: "list", changes: 11 });
    await emit(page, { v: 2, eventId: "c~d", collection: "projects", op: "list", changes: 11 });
    await expect.poll(() => lists(backend).projects).toBe(4);
    await page.waitForTimeout(200);
    expect(lists(backend).projects).toBe(4);
  });

  test("a re-list keeps changes that arrive while it's being read", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ docs: { ...seeded(), "t1/projects/old": { client: "Old job", date: "2026-09-01", status: "open", items: {} } } }));
    const before = lists(backend);
    // The re-list answers with the projects as they were when it started
    let release;
    const wait = new Promise((r) => { release = r; });
    backend.on("GET", "/teams/t1/projects", { wait, status: 200, body: { documents: [
      { id: "s1", version: 1, data: usedState.seed["projects/s1"] },
      { id: "old", version: 1, data: { client: "Old job", date: "2026-09-01", status: "open", items: {} } },
    ] } });
    await setVisible(page, true);
    await expect.poll(() => lists(backend).projects).toBe(before.projects + 1);
    // Meanwhile a project is added and another deleted
    const v = backend.write("t1", "projects", "new", { client: "New job", date: "2026-09-26", status: "open", items: {} });
    backend.docs.delete("t1/projects/old");
    await emit(page, { v: 1, collection: "projects", id: "new", op: "put", version: v });
    await emit(page, { v: 1, collection: "projects", id: "old", op: "delete", version: 1 });
    await expect(card(page, "New job")).toBeVisible();
    await expect(card(page, "Old job")).toHaveCount(0);
    release();
    await expect.poll(() => lists(backend).products).toBe(before.products + 1);
    await expect(card(page, "Old job")).toHaveCount(0);
    await expect(card(page, "New job")).toBeVisible();

    // A re-list asked for while one is running runs once more afterwards, not twice
    const hold = backend.hold("GET", "/teams/t1/projects");
    await setVisible(page, true);
    await setVisible(page, true);
    await setVisible(page, true);
    await expect.poll(() => lists(backend).products).toBe(before.products + 4);
    expect(lists(backend).projects).toBe(before.projects + 2);
    hold();
    await expect.poll(() => lists(backend).projects).toBe(before.projects + 3);
    await setVisible(page, false);
    expect(lists(backend).projects).toBe(before.projects + 3);
  });

  test("reconnects with backoff, and re-lists after every subscribe", async ({ page }) => {
    await page.clock.install();
    const backend = await open(page);
    await expect.poll(() => lists(backend)).toEqual({ products: 2, projects: 2 });

    // The server closes the socket: a new one within a second, then a re-list
    await dropSocket(page);
    await page.clock.fastForward(1000);
    await expect.poll(async () => (await sockets(page)).length).toBe(2);
    await expect.poll(() => lists(backend)).toEqual({ products: 3, projects: 3 });

    // Keep-alives: the socket is closed if none arrives within connectionTimeoutMs
    await page.clock.fastForward(200e3);
    await receive(page, { type: "ka" });
    await page.clock.fastForward(200e3);
    expect((await sockets(page)).map((s) => s.closed)).toEqual([true, false]);
    await page.clock.fastForward(100e3);
    await expect.poll(async () => (await sockets(page))[1].closed).toBe(true);

    // Back online: reconnect now instead of waiting
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(async () => (await sockets(page)).length).toBe(3);
    await expect.poll(() => lists(backend)).toEqual({ products: 4, projects: 4 });
    // Back online with a socket that looks open: it may have died without closing, and events
    // sent while offline are gone, so a new socket and a re-list
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(async () => (await sockets(page)).map((s) => s.closed)).toEqual([true, true, true, false]);
    await expect.poll(() => lists(backend)).toEqual({ products: 5, projects: 5 });

    // Every 10 minutes while connected, and when the tab is shown again
    await page.clock.fastForward(600e3);
    await expect.poll(() => lists(backend)).toEqual({ products: 6, projects: 6 });
    await setVisible(page, false);
    await setVisible(page, true);
    await expect.poll(() => lists(backend)).toEqual({ products: 7, projects: 7 });
  });

  test("an acknowledgement without a timeout keeps the default keep-alive", async ({ page }) => {
    await page.clock.install();
    await open(page, undefined, { ws: { ack: false } });
    await receive(page, { type: "connection_ack" });
    expect((await sockets(page))[0].sent.map((m) => m.type)).toEqual(["connection_init", "subscribe"]);
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
    // Shown again: a re-list
    await setVisible(page, true);
    await expect.poll(() => lists(backend).products).toBe(start.products + 4);

    // The socket is tried again every 2 minutes; this time it closes before opening. The
    // hidden-tab poll is due too.
    await page.evaluate(() => { window.__wsMode = { open: false }; });
    await page.clock.fastForward(120e3);
    await expect.poll(() => lists(backend).products).toBe(start.products + 5);
    // Wait for it to close before the mode changes, then run its close handler, which
    // schedules the next try, so the next fast-forward reaches that try
    await expect.poll(async () => (await sockets(page)).map((s) => s.closed)).toEqual([true, true, true, true]);
    await page.clock.runFor(1);
    // Then it works: one more poll is due first, then polling stops after one re-list
    await page.evaluate(() => { window.__wsMode = { open: true, ack: true, subscribe: "success" }; });
    await page.clock.fastForward(120e3);
    await expect.poll(async () => (await sockets(page)).length).toBe(5);
    await expect.poll(async () => (await sockets(page))[4].sent.length).toBe(2);
    await expect.poll(() => lists(backend).products).toBe(start.products + 7);
    await page.clock.fastForward(60e3);
    expect(lists(backend).products).toBe(start.products + 7);
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

  test("a member removed before a write finds out from the refused write", async ({ page }) => {
    const backend = await open(page);
    backend.teams = [];
    await page.getByRole("button", { name: "+ New project" }).click();
    await page.getByLabel("Client", { exact: true }).fill("Foxtrot Dental");
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("heading", { name: "You're no longer in Echo Cleaning" })).toBeVisible();
    expect(backend.requests("PUT", /^\/teams\/t1\/projects\//)).toHaveLength(1);
  });

  test("a member removed while connected finds out from the next fetch", async ({ page }) => {
    const backend = await open(page);
    backend.teams = [];
    await emit(page, { v: 1, collection: "projects", id: "s1", op: "put", version: 5 });
    await emit(page, { v: 1, collection: "projects", id: "s1", op: "put", version: 6 });
    await expect(page.getByRole("heading", { name: "You're no longer in Echo Cleaning" })).toBeVisible();
    expect((await sockets(page)).at(-1).closed).toBe(true);
  });
});

test.describe("inventory edits", { tag: ["@J2.3"] }, () => {
  // ADR 0014: the edit form replaces the whole item, so it must carry what it doesn't show
  test("an edit sends the item's cost, pack size and other fields back", async ({ page }) => {
    const docs = seeded();
    docs["t1/products/SKU1"] = { ...docs["t1/products/SKU1"], cost: 6.25, packSize: 12, note: "keep me" };
    const backend = await open(page, new FakeBackend({ docs }));
    await goToInventory(page);
    await inventoryRow(page, "Paper towels").click();
    await modal(page).getByLabel("Price each ($)").fill("9");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(inventoryRow(page, "Paper towels").locator("td").nth(2)).toHaveText("$9.00");
    expect(backend.requests("PUT", "/teams/t1/products/SKU1")[0].body).toEqual({
      data: { code: "SKU1", name: "Paper towels, 6 roll", price: 9, cost: 6.25, packSize: 12, note: "keep me", updatedAt: expect.any(String) },
      expectedVersion: 1,
    });
    // Without stock in the body, the server keeps the stock it has
    expect(backend.doc("t1", "products", "SKU1").data).toMatchObject({ cost: 6.25, packSize: 12, note: "keep me", stock: 10 });
    // The count didn't change, so there's no stock command
    expect(backend.requests("POST", "/teams/t1/products/SKU1/stock")).toEqual([]);
  });
});

// docs/api/commands.md: stock outside a project changes only through the stock command, which
// records why. The document routes keep the stored stock, so a PUT never carries it.
test.describe("stock commands", { tag: ["@J2"] }, () => {
  const STOCK = "/teams/t1/products/SKU1/stock";
  const toast = (page) => page.locator("#toast");
  const hideToast = (page) => toast(page).evaluate((t) => { t.hidden = true; });
  const editStock = async (page, value) => {
    await goToInventory(page);
    await inventoryRow(page, "Paper towels").click();
    await modal(page).getByLabel("Single items in storage now").fill(value);
    await modal(page).getByRole("button", { name: "Save" }).click();
  };
  const stockCell = (page, name) => inventoryRow(page, name).locator("td").nth(1);

  test("a new count in the inventory form is a count command, not a document write", async ({ page }) => {
    const backend = await open(page);
    await editStock(page, "7");
    await expect(toast(page)).toHaveText("Saved");
    await expect(stockCell(page, "Paper towels")).toHaveText("7");
    // Nothing else changed, so there's no PUT, only the count
    expect(backend.requests("PUT", "/teams/t1/products/SKU1")).toEqual([]);
    expect(backend.requests("POST", STOCK).map((r) => r.body)).toEqual([{ operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), reason: "count", count: 7, expectedStock: 10 }]);
    expect(backend.doc("t1", "products", "SKU1")).toMatchObject({ version: 2, data: { stock: 7 } });
    expect([...backend.operations.values()][0].result).toMatchObject({ reason: "count", count: 7, stockDelta: -3 });
  });

  test("an edit with a new count saves the item without stock, then counts", async ({ page }) => {
    const backend = await open(page);
    await goToInventory(page);
    await inventoryRow(page, "Paper towels").click();
    await modal(page).getByLabel("Price each ($)").fill("9");
    await modal(page).getByLabel("Single items in storage now").fill("7");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(toast(page)).toHaveText("Saved");
    expect(backend.requests("PUT", "/teams/t1/products/SKU1").map((r) => r.body)).toEqual([
      { data: { code: "SKU1", name: "Paper towels, 6 roll", price: 9, updatedAt: expect.any(String) }, expectedVersion: 1 },
    ]);
    expect(backend.doc("t1", "products", "SKU1")).toMatchObject({ version: 3, data: { price: 9, stock: 7 } });
  });

  test("saving again after a count's answer was lost counts once, without a conflict", async ({ page }) => {
    const backend = await open(page);
    backend.on("POST", STOCK, { lost: true });
    await goToInventory(page);
    await inventoryRow(page, "Paper towels").click();
    await modal(page).getByLabel("Price each ($)").fill("9");
    await modal(page).getByLabel("Single items in storage now").fill("7");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
    expect(backend.doc("t1", "products", "SKU1")).toMatchObject({ version: 3, data: { price: 9, stock: 7 } });
    // One more save finishes it: the item is saved already, so the count is sent again, and
    // the server answers it from its record
    await hideToast(page);
    await modal(page).getByRole("button", { name: "Try again" }).click();
    await expect(toast(page)).toHaveText("Saved");
    expect(backend.requests("PUT", "/teams/t1/products/SKU1")).toHaveLength(1);
    const [lost, again] = backend.requests("POST", STOCK).map((r) => r.body);
    expect(again).toEqual(lost);
    expect(backend.operations.size).toBe(1);
    expect(backend.doc("t1", "products", "SKU1")).toMatchObject({ version: 3, data: { price: 9, stock: 7 } });
    await expect(stockCell(page, "Paper towels")).toHaveText("7");
  });

  test("a new item counted in the form is saved without stock, then counted", async ({ page }) => {
    const backend = await open(page);
    await goToInventory(page);
    await startAddItem(page);
    await modal(page).getByLabel("Barcode (optional)").fill("MOP1");
    await modal(page).getByLabel("Item name").fill("Mop heads");
    await modal(page).getByLabel("Single items in storage now").fill("5");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(stockCell(page, "Mop heads")).toHaveText("5");
    const key = backend.requests("PUT", /^\/teams\/t1\/products\//)[0].path.split("/").pop();
    const [put] = backend.requests("PUT", `/teams/t1/products/${key}`);
    expect(put.body.data).not.toHaveProperty("stock");
    expect(put.body.expectedVersion).toBe(0);
    expect(backend.requests("POST", `/teams/t1/products/${key}/stock`).map((r) => r.body)).toEqual([{ operationId: expect.any(String), reason: "count", count: 5, expectedStock: null }]);
    expect(backend.doc("t1", "products", key).data.stock).toBe(5);
  });

  test("a count by someone made a viewer meanwhile switches the app to view-only", async ({ page }) => {
    const backend = await open(page);
    backend.on("POST", STOCK, { status: 403, body: { error: { code: "permission_denied", message: "x", reason: "view_only" } } });
    await editStock(page, "7");
    await expect(page.locator("#notice")).toContainText("You have view-only access.");
    expect(backend.requests("POST", STOCK)).toHaveLength(1);
  });

  test("clearing the count of a counted item stops counting it, with an uncount command", async ({ page }) => {
    const backend = await open(page);
    await editStock(page, "");
    await expect(toast(page)).toHaveText("Saved");
    expect(backend.requests("PUT", "/teams/t1/products/SKU1")).toEqual([]);
    expect(backend.requests("POST", STOCK).map((r) => r.body)).toEqual([{ operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), reason: "uncount", expectedStock: 10 }]);
    expect(backend.doc("t1", "products", "SKU1").version).toBe(2);
    expect(backend.doc("t1", "products", "SKU1").data).not.toHaveProperty("stock");
    expect([...backend.operations.values()][0].result).toMatchObject({ reason: "uncount", stockDelta: -10 });
    await expect(stockCell(page, "Paper towels")).toHaveText("—");
    // Opened again, the form shows it isn't counted
    await goToInventory(page);
    await inventoryRow(page, "Paper towels").click();
    await expect(modal(page).getByLabel("Single items in storage now")).toHaveValue("");
  });

  test("saving again after an uncount's answer was lost stops counting once, without a conflict", async ({ page }) => {
    const backend = await open(page);
    backend.on("POST", STOCK, { lost: true });
    await goToInventory(page);
    await inventoryRow(page, "Paper towels").click();
    await modal(page).getByLabel("Price each ($)").fill("9");
    await modal(page).getByLabel("Single items in storage now").fill("");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
    await hideToast(page);
    await modal(page).getByRole("button", { name: "Try again" }).click();
    await expect(toast(page)).toHaveText("Saved");
    expect(backend.requests("PUT", "/teams/t1/products/SKU1")).toHaveLength(1);
    const [lost, again] = backend.requests("POST", STOCK).map((r) => r.body);
    expect(again).toEqual(lost);
    expect(backend.operations.size).toBe(1);
    expect(backend.doc("t1", "products", "SKU1")).toMatchObject({ version: 3, data: { price: 9 } });
    expect(backend.doc("t1", "products", "SKU1").data).not.toHaveProperty("stock");
  });

  // Someone else's checkout takes the stock from 10 to 8 while the form is open
  const checkedOutMeanwhile = async (page, backend) => {
    await goToInventory(page);
    await inventoryRow(page, "Paper towels").click();
    await expect(modal(page).getByLabel("Single items in storage now")).toHaveValue("10");
    const version = backend.write("t1", "products", "SKU1", { ...backend.doc("t1", "products", "SKU1").data, stock: 8 });
    await page.evaluate((e) => window.__sockets.at(-1).event(e), { v: 1, teamId: "t1", collection: "products", id: "SKU1", op: "put", version });
    await expect(stockCell(page, "Paper towels")).toHaveText("8");
  };

  test("an edit that doesn't touch the count leaves a stock change made while the form was open", async ({ page }) => {
    const backend = await open(page);
    await checkedOutMeanwhile(page, backend);
    // The form still shows the 10 it opened with; only the price changes
    await expect(modal(page).getByLabel("Single items in storage now")).toHaveValue("10");
    await modal(page).getByLabel("Price each ($)").fill("9");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(toast(page)).toHaveText("Saved");
    expect(backend.requests("POST", STOCK)).toEqual([]);
    expect(backend.doc("t1", "products", "SKU1").data).toMatchObject({ price: 9, stock: 8 });
    await expect(stockCell(page, "Paper towels")).toHaveText("8");
  });

  test("a new count over stock that moved while the form was open is refused, saying what it is now", async ({ page }) => {
    const backend = await open(page);
    await checkedOutMeanwhile(page, backend);
    await modal(page).getByLabel("Price each ($)").fill("9");
    await modal(page).getByLabel("Single items in storage now").fill("12");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(toast(page)).toHaveText("The count changed while you were editing: it's now 8, so your count wasn't saved. The latest is showing.");
    await expect(page.locator("#overlay")).toBeHidden();
    expect(backend.requests("POST", STOCK).map((r) => r.body)).toEqual([{ operationId: expect.any(String), reason: "count", count: 12, expectedStock: 10 }]);
    // The price saved; the stock is as the checkout left it
    expect(backend.doc("t1", "products", "SKU1").data).toMatchObject({ price: 9, stock: 8 });
    await expect(stockCell(page, "Paper towels")).toHaveText("8");
  });

  test("a new count over stock that moved still saves when it's what the stock is now", async ({ page }) => {
    const backend = await open(page);
    await checkedOutMeanwhile(page, backend);
    await modal(page).getByLabel("Single items in storage now").fill("8");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(toast(page)).toHaveText("Saved");
    // The server decides: it's what's stored, so it changes nothing
    expect(backend.requests("POST", STOCK).map((r) => r.body)).toEqual([{ operationId: expect.any(String), reason: "count", count: 8, expectedStock: 10 }]);
    expect([...backend.operations.values()][0].result).toMatchObject({ reason: "count", count: 8, stockDelta: 0 });
    await expect(page.locator("#overlay")).toBeHidden();
    // Opened again, a count of 6 over the 8 it shows saves
    await editStock(page, "6");
    await expect(toast(page)).toHaveText("Saved");
    expect(backend.requests("POST", STOCK).map((r) => r.body).at(-1)).toEqual({ operationId: expect.any(String), reason: "count", count: 6, expectedStock: 8 });
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(6);
  });

  test("a new count that matches this page's copy is still refused when the server's stock moved on", async ({ page }) => {
    const backend = await open(page);
    await checkedOutMeanwhile(page, backend);
    // Another checkout takes it to 7, and this page hasn't heard yet: it still shows 8
    backend.write("t1", "products", "SKU1", { ...backend.doc("t1", "products", "SKU1").data, stock: 7 });
    await modal(page).getByLabel("Single items in storage now").fill("8");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(toast(page)).toHaveText("The count changed while you were editing: it's now 7, so your count wasn't saved. The latest is showing.");
    expect(backend.requests("POST", STOCK).map((r) => r.body)).toEqual([{ operationId: expect.any(String), reason: "count", count: 8, expectedStock: 10 }]);
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(7);
    await expect(stockCell(page, "Paper towels")).toHaveText("7");
  });

  test("a blank count on an item that isn't counted sends no stock command", async ({ page }) => {
    const docs = seeded();
    docs["t1/products/SKU1"] = { ...docs["t1/products/SKU1"], stock: undefined };
    const backend = await open(page, new FakeBackend({ docs }));
    await editStock(page, "");
    await expect(toast(page)).toHaveText("Saved");
    expect(backend.requests("POST", STOCK)).toEqual([]);
  });

  test("a price edit to an item someone counted while the form was open leaves their count alone", async ({ page }) => {
    const docs = seeded();
    docs["t1/products/SKU1"] = { ...docs["t1/products/SKU1"], stock: undefined };
    const backend = await open(page, new FakeBackend({ docs }));
    await goToInventory(page);
    await inventoryRow(page, "Paper towels").click();
    await expect(modal(page).getByLabel("Single items in storage now")).toHaveValue("");
    // Someone else counts it at 50, and the live update arrives while the form is open
    const item = { ...docs["t1/products/SKU1"] }; delete item.stock;
    const version = backend.write("t1", "products", "SKU1", { ...item, stock: 50 });
    await page.evaluate((e) => window.__sockets.at(-1).event(e), { v: 1, teamId: "t1", collection: "products", id: "SKU1", op: "put", version });
    await expect.poll(() => backend.requests("GET", "/teams/t1/products/SKU1").length).toBe(1);
    await expect(stockCell(page, "Paper towels")).toHaveText("50");
    // This form showed no count, so its blank count isn't a request to stop counting
    await modal(page).getByLabel("Price each ($)").fill("9");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(toast(page)).toHaveText("Saved");
    expect(backend.requests("POST", STOCK)).toEqual([]);
    expect(backend.doc("t1", "products", "SKU1").data).toMatchObject({ price: 9, stock: 50 });
    await expect(stockCell(page, "Paper towels")).toHaveText("50");
  });

  test("clearing a count someone else already stopped while the form was open sends nothing", async ({ page }) => {
    const backend = await open(page);
    await goToInventory(page);
    await inventoryRow(page, "Paper towels").click();
    await expect(modal(page).getByLabel("Single items in storage now")).toHaveValue("10");
    const item = { ...backend.doc("t1", "products", "SKU1").data }; delete item.stock;
    const version = backend.write("t1", "products", "SKU1", item);
    await page.evaluate((e) => window.__sockets.at(-1).event(e), { v: 1, teamId: "t1", collection: "products", id: "SKU1", op: "put", version });
    await expect(stockCell(page, "Paper towels")).toHaveText("—");
    await modal(page).getByLabel("Single items in storage now").fill("");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(toast(page)).toHaveText("Saved");
    expect(backend.requests("POST", STOCK)).toEqual([]);
  });

  test("counting an item that wasn't counted starts its stock", async ({ page }) => {
    const docs = seeded();
    docs["t1/products/SKU1"] = { ...docs["t1/products/SKU1"], stock: undefined };
    const backend = await open(page, new FakeBackend({ docs }));
    await editStock(page, "6");
    await expect(stockCell(page, "Paper towels")).toHaveText("6");
    expect(backend.requests("PUT", "/teams/t1/products/SKU1")).toEqual([]);
    expect([...backend.operations.values()][0].result).toMatchObject({ reason: "count", count: 6, stockDelta: 6 });
  });

  test("a count that failed is sent again with the same operation ID", async ({ page }) => {
    const backend = await open(page);
    backend.on("POST", STOCK, { status: 503, body: { error: { code: "unavailable", message: "try again" } } });
    await editStock(page, "7");
    await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(10);
    await hideToast(page);
    await modal(page).getByRole("button", { name: "Try again" }).click();
    await expect(toast(page)).toHaveText("Saved");
    const [first, retry] = backend.requests("POST", STOCK).map((r) => r.body);
    expect(retry).toEqual(first);
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(7);
    // A new edit is a new count
    await editStock(page, "4");
    await expect(stockCell(page, "Paper towels")).toHaveText("4");
    expect(backend.requests("POST", STOCK).at(-1).body.operationId).not.toBe(first.operationId);
  });

  test("a count refused because the item changed meanwhile shows the latest", async ({ page }) => {
    const backend = await open(page);
    backend.on("POST", STOCK, { status: 409, body: { error: { code: "aborted", message: "busy" } } });
    await editStock(page, "7");
    await expect(toast(page)).toContainText("Someone else changed this just now");
    expect(backend.requests("GET", "/teams/t1/products/SKU1")).toHaveLength(1);
  });

  const draftLine = (o) => ({ name: "", raw: "", qty: 1, price: 0, dest: "stock", code: "", match: "", suggested: false, useName: "inv", usePrice: "receipt", ...o });
  const openDraft = (page, backend, lines, draft) => open(page, backend, {
    // Pat's draft for this team (src/aws/session.js)
    storage: { local: { "supplyCheckout.owner": USER.id, "supplyCheckout.receiptDraft.t1": JSON.stringify({ store: "", receiptDate: "2026-09-20", date: "2026-09-25", subtotal: null, tax: null, total: null, savePrices: true, by: "", dests: [{ id: "d1", projectId: "", client: "" }], lines, ...draft }) } },
  });

  test("a receipt's general-inventory lines are receipt commands, one per line", { tag: ["@J5.3"] }, async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    await openDraft(page, backend, [
      draftLine({ id: "l1", name: "Paper towels", qty: 2, price: 7.994, match: "SKU1" }),
      draftLine({ id: "l2", name: "Paper towels", qty: 3, price: 8.25, match: "SKU1" }),
      draftLine({ id: "l3", name: "Mop heads", qty: 4, price: 4.5 }),
    ]);
    await connected(page);
    await continueReview(page);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page)).toHaveText("9 added to storage");
    // The item keeps its stock; each line adds its eaches at its price each
    expect(backend.requests("PUT", "/teams/t1/products/SKU1")[0].body.data).not.toHaveProperty("stock");
    expect(backend.requests("POST", STOCK).map((r) => r.body)).toEqual([
      { operationId: expect.any(String), reason: "receipt", quantity: 2, unitCost: 7.99 },
      { operationId: expect.any(String), reason: "receipt", quantity: 3, unitCost: 8.25 },
    ]);
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(15);
    const put = backend.requests("PUT", /^\/teams\/t1\/products\/nb-/)[0], key = put.path.split("/").pop();
    expect(put.body.data).not.toHaveProperty("stock");
    expect(backend.requests("POST", `/teams/t1/products/${key}/stock`).map((r) => r.body)).toEqual([{ operationId: expect.any(String), reason: "receipt", quantity: 4, unitCost: 4.5 }]);
    expect(backend.doc("t1", "products", key).data.stock).toBe(4);
    expect(backend.requests("PATCH", /^\/teams\/t1\//)).toEqual([]);
  });

  test("a receipt's cases are stock commands in eaches at the cost of one each", { tag: ["@J5.3"] }, async ({ page }) => {
    const docs = { ...seeded(), "t1/products/SKU1": { ...usedState.seed["products/SKU1"], cost: 7, packSize: 6 } };
    const backend = new FakeBackend({ docs });
    await openDraft(page, backend, [draftLine({ id: "l1", name: "Paper towels", qty: 2, price: 45, match: "SKU1", usePrice: "" })]);
    await connected(page);
    await continueReview(page);
    await expect(page.locator(".rline [data-note]")).toHaveText("12 each, cost $7.50 each");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page)).toHaveText("12 added to storage");
    // The client price is kept (it was above the cost), and the cost is the receipt's
    expect(backend.requests("PUT", "/teams/t1/products/SKU1")[0].body.data).toMatchObject({ price: 8.5, cost: 7.5, packSize: 6 });
    expect(backend.requests("POST", STOCK).map((r) => r.body)).toEqual([{ operationId: expect.any(String), reason: "receipt", quantity: 12, unitCost: 7.5 }]);
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(22);
  });

  test("saving a receipt again after a failed line adds each line once", { tag: ["@J5.3"] }, async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    await openDraft(page, backend, [
      draftLine({ id: "l1", name: "Paper towels", qty: 2, price: 8, match: "SKU1" }),
      draftLine({ id: "l2", name: "Paper towels", qty: 3, price: 8, match: "SKU1" }),
    ]);
    await connected(page);
    await continueReview(page);
    // The first line is saved, but its answer is lost
    backend.on("POST", STOCK, { lost: true });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(12);
    // Saving again doesn't save the item again (its price and name are saved already), so it
    // doesn't meet the version that line gave it: the same two operations go, and the first is
    // answered from the server's record
    await hideToast(page);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(toast(page)).toHaveText("5 added to storage");
    expect(backend.requests("PUT", "/teams/t1/products/SKU1")).toHaveLength(1);
    const [lost, again1, again2] = backend.requests("POST", STOCK).map((r) => r.body);
    expect(again1).toEqual(lost);
    expect(again2.operationId).not.toBe(lost.operationId);
    expect(backend.operations.size).toBe(2);
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(15);
  });

  // A receipt's lines for a client on a project that exists: the addLines command (src/moves.js)
  const LINES = "/teams/t1/projects/s1/lines";
  const toEcho = (page, backend, lines) => openDraft(page, backend, lines, { savePrices: false, dests: [{ id: "d1", projectId: "s1", client: "" }] });
  const saveReceipt = async (page) => {
    await continueReview(page);
    await page.getByRole("button", { name: "Save", exact: true }).click();
  };

  test("a receipt's lines for an existing project are one command, whose retry after a lost answer adds nothing twice", { tag: ["@J5.3"] }, async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    await toEcho(page, backend, [draftLine({ id: "l1", name: "Paper towels", qty: 2, price: 8, match: "SKU1", dest: "d1" }), draftLine({ id: "l2", name: "Mop heads", qty: 1, price: 4.5, dest: "d1" })]);
    backend.on("POST", LINES, { lost: true });
    await saveReceipt(page);
    await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
    expect(backend.doc("t1", "projects", "s1").data.items.SKU1.out).toBe(5);
    // Locked until it's saved: a changed line would be a new operation, adding the lines again
    await expect(page.locator("#rLocked")).toBeVisible();
    await expect(page.locator(".rline").first().getByLabel("Qty")).toBeDisabled();
    await expect(page.getByRole("button", { name: "+ Add item" })).toBeDisabled();
    await hideToast(page);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(toast(page)).toHaveText("Saved to 1 project");
    await expect(lineRow(page, "Paper towels").locator("td").nth(2)).toHaveText("5");
    const [lost, again] = backend.requests("POST", LINES).map((r) => r.body);
    expect(again).toEqual(lost);
    expect(lost.lines).toEqual([
      { productKey: "SKU1", quantity: 2, code: "SKU1", name: "Paper towels, 6 roll", price: 8, cost: 8 },
      { productKey: expect.stringMatching(/^nb-/), quantity: 1, code: "", name: "Mop heads", price: 4.5, cost: 4.5 },
    ]);
    // The existing line keeps its copy; no stock moves, and no document write
    expect(backend.doc("t1", "projects", "s1").data.items.SKU1).toEqual({ code: "SKU1", name: "Paper towels, 6 roll", price: 8.5, out: 5, returned: 1 });
    expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(10);
    expect(backend.requests("PATCH", /^\/teams\/t1\//)).toEqual([]);
    expect(backend.operations.size).toBe(1);
  });

  test("a receipt with more than 40 lines for a project goes as one command per 40", { tag: ["@J5.3"] }, async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    await toEcho(page, backend, Array.from({ length: 41 }, (_, i) => draftLine({ id: `l${i}`, name: `Item ${i}`, qty: 1, price: 1, dest: "d1" })));
    await saveReceipt(page);
    await expect(toast(page)).toHaveText("Saved to 1 project");
    expect(backend.requests("POST", LINES).map((r) => r.body.lines.length)).toEqual([40, 1]);
    expect(Object.keys(backend.doc("t1", "projects", "s1").data.items)).toHaveLength(43);
  });

  test("a receipt's lines refused, or for a project that's gone or closed, show why and the latest", { tag: ["@J5.3"] }, async ({ page }) => {
    const backend = new FakeBackend({ docs: seeded() });
    await toEcho(page, backend, [draftLine({ id: "l1", name: "Mop heads", qty: 1, price: 4.5, dest: "d1" })]);
    backend.on("POST", LINES, { status: 400, body: { error: { code: "bad_request", message: "Each line must be an object." } } });
    await saveReceipt(page);
    await expect(toast(page)).toHaveText("Each line must be an object. The latest is showing.");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    // Refused, so nothing was saved: the review can be changed
    await expect(page.locator("#rLocked")).toHaveCount(0);
    await expect(page.locator(".rline").first().getByLabel("Qty")).toBeEnabled();
    backend.write("t1", "projects", "s1", { ...usedState.seed["projects/s1"], status: "closed" });
    await hideToast(page);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page)).toContainText("Someone else changed this just now");
    backend.docs.delete("t1/projects/s1");
    await hideToast(page);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page)).toHaveText("Someone else deleted this project, so your change wasn't saved.");
    // Each fetched the project again
    expect(backend.requests("GET", "/teams/t1/projects/s1")).toHaveLength(3);
  });
});

// Low-stock alerts (supply-checkout-005.8): the acknowledgment is a PATCH of the item, shared by
// the team, and a restock above the reorder level ends it on the server (backend/src/data/reorder.ts)
test.describe("low-stock alerts", { tag: ["@J15"] }, () => {
  test("acknowledges with a PATCH, and a count above the reorder level ends it", { tag: ["@J15.3"] }, async ({ page }) => {
    const backend = await open(page, new FakeBackend({ docs: { ...seeded(), "t1/products/GLV": { code: "GLV", name: "Nitrile gloves", price: 12.5, stock: 2, reorderAt: 5, reorderQty: 24 } } }), {});
    await expect(page.locator("#tab-prices")).toHaveAccessibleName("Inventory, 1 running low");
    await page.locator("#tab-prices").click();
    await page.getByRole("button", { name: "Running low (1)" }).click();
    await page.getByRole("button", { name: "Acknowledge Nitrile gloves" }).click();
    await expect(page.getByRole("button", { name: "Running low", exact: true })).toBeVisible();
    expect(backend.requests("PATCH", "/teams/t1/products/GLV").map((r) => r.body)).toEqual([{ data: { ackedAtStock: 2 }, expectedVersion: 1 }]);
    expect(backend.doc("t1", "products", "GLV").data).toMatchObject({ stock: 2, ackedAtStock: 2 });

    // Restocked: counted at 10, above the level, so the acknowledgment ends
    await inventoryRow(page, "Nitrile gloves").click();
    await modal(page).getByLabel("Single items in storage now").fill("10");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#main")).toContainText("Nothing is running low.");
    expect(backend.doc("t1", "products", "GLV").data).not.toHaveProperty("ackedAtStock");
    // And down to the level again: it's flagged again, though it's above where it was acknowledged
    await page.getByRole("button", { name: "All", exact: true }).click();
    await inventoryRow(page, "Nitrile gloves").click();
    await modal(page).getByLabel("Single items in storage now").fill("4");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Running low (1)" })).toBeVisible();
    await expect(inventoryRow(page, "Nitrile gloves").locator(".low-badge")).toHaveText("Low");
  });
});

test.describe("orders", { tag: ["@J15.4"] }, () => {
  test("marks an item ordered with a PUT of the item without its acknowledgment, and a count above the level ends the order", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ docs: { ...seeded(), "t1/products/GLV": { code: "GLV", name: "Nitrile gloves", price: 12.5, stock: 2, reorderAt: 5, reorderQty: 24, ackedAtStock: 2 } } }), {});
    await page.locator("#tab-prices").click();
    await page.getByRole("button", { name: "Running low", exact: true }).click();
    await page.getByRole("button", { name: "Mark ordered: Nitrile gloves" }).click();
    await modal(page).getByLabel("Ordered on").fill("2026-10-01");
    await modal(page).getByRole("button", { name: "Mark ordered" }).click();
    await expect(page.getByRole("button", { name: "Cancel the order of Nitrile gloves" })).toBeVisible();
    expect(backend.requests("PUT", "/teams/t1/products/GLV").map((r) => r.body)).toEqual([
      { data: { code: "GLV", name: "Nitrile gloves", price: 12.5, stock: 2, reorderAt: 5, reorderQty: 24, orderedQty: 24, orderedOn: "2026-10-01" }, expectedVersion: 1 },
    ]);

    await inventoryRow(page, "Nitrile gloves").click();
    await modal(page).getByLabel("Single items in storage now").fill("30");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#main")).toContainText("Nothing is running low.");
    expect(backend.doc("t1", "products", "GLV").data).not.toHaveProperty("orderedQty");
    expect(backend.doc("t1", "products", "GLV").data).not.toHaveProperty("orderedOn");
  });
});
