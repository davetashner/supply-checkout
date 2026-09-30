// Saving on a slow or flaky connection in the web build (saving() in src/main.js, against the
// fake backend): one request per checkout however it's tapped, a request that times out is
// tried again with the same operation ID, offline sends nothing and the latest shows when the
// connection is back, and a new sheet or item whose answer was lost is saved once. The same
// states on the mock runtime are in tests/save-states.spec.js.
import { test, expect, enterBarcode, modal, lineRow, inventoryRow } from "./helpers.js";
import { currentBuild } from "../scripts/builds.mjs";
import { usedState } from "./fixtures.js";
import { FakeBackend, openAws, connected, sockets } from "./fake-aws.js";
import { TIMEOUT } from "../src/aws/http.js";

test.skip(currentBuild() !== "web", "The AWS runtime is only in the web build");

const CHECKOUT = "/teams/t1/sheets/s1/checkout", RETURN = "/teams/t1/sheets/s1/return";
const seeded = () => Object.fromEntries(Object.entries(usedState.seed).map(([k, v]) => [`t1/${k}`, v]));
const lists = (backend) => backend.requests("GET", "/teams/t1/sheets").filter((r) => !r.query.cursor).length;
const toast = (page) => page.locator("#toast");
const failedNote = (page) => modal(page).locator(".save-failed");

async function openEcho(page) {
  const backend = new FakeBackend({ docs: seeded() });
  await openAws(page, backend);
  await connected(page);
  // The first list, and the re-list once subscribed
  await expect.poll(() => lists(backend)).toBe(2);
  await page.getByRole("button", { name: /Echo Studio/ }).click();
  return backend;
}

test("a slow checkout is one request however it's tapped, and shows saved once the server answers", { tag: ["@J4.2"] }, async ({ page }) => {
  const backend = await openEcho(page);
  const release = backend.hold("POST", CHECKOUT);
  await enterBarcode(page, "SKU1");
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  const go = modal(page).getByRole("button", { name: "Saving…" });
  await expect(go).toBeDisabled();
  await go.dispatchEvent("click");
  await modal(page).locator("form").evaluate((f) => { f.requestSubmit(); f.requestSubmit(); });
  await page.keyboard.press("Escape");
  await expect.poll(() => backend.requests("POST", CHECKOUT).length).toBe(1);
  await expect(toast(page)).toBeHidden();
  await expect(lineRow(page, "Paper towels").locator("td").nth(2)).toHaveText("3");
  release();
  await expect(toast(page)).toHaveText("Checked out 1 × Paper towels, 6 roll");
  await expect(lineRow(page, "Paper towels").locator("td").nth(2)).toHaveText("4");
  expect(backend.requests("POST", CHECKOUT)).toHaveLength(1);
  expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(9);
});

test("a return that times out, though the server saved it, counts once on Try again", { tag: ["@J4.3"] }, async ({ page }) => {
  await page.clock.install();
  const backend = await openEcho(page);
  await page.getByRole("button", { name: "Return", exact: true }).click();
  // The server gets the return but doesn't answer in time
  const release = backend.hold("POST", RETURN);
  await enterBarcode(page, "SKU1");
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(modal(page).getByRole("button", { name: "Saving…" })).toBeDisabled();
  await expect.poll(() => backend.requests("POST", RETURN).length).toBe(1);
  await page.clock.fastForward(TIMEOUT - 1000);
  await expect(modal(page).getByRole("button", { name: "Saving…" })).toBeDisabled();
  await page.clock.fastForward(1000);
  await expect(failedNote(page)).toHaveText("Not saved. Check your connection, then tap Try again.");
  // It arrives after the page gave up on it: saved, but the answer is lost
  release();
  await expect.poll(() => backend.doc("t1", "sheets", "s1").data.items.SKU1.returned).toBe(2);

  await modal(page).getByRole("button", { name: "Try again" }).click();
  await expect(toast(page)).toHaveText("1 returned · 2 of 3 back");
  const [first, retry] = backend.requests("POST", RETURN).map((r) => r.body);
  expect(retry).toEqual(first);
  expect(backend.operations.size).toBe(1);
  expect(backend.doc("t1", "sheets", "s1").data.items.SKU1).toMatchObject({ out: 3, returned: 2 });
  expect(backend.doc("t1", "products", "SKU1").data.stock).toBe(11);
});

test("offline, nothing is sent; back online, the latest shows and Try again checks out once", { tag: ["@J4.2"] }, async ({ page, context }) => {
  const backend = await openEcho(page);
  await enterBarcode(page, "SKU1");
  await modal(page).getByRole("button", { name: "More" }).click();
  await context.setOffline(true);
  await modal(page).getByRole("button", { name: "Add 2 to sheet" }).click();
  await expect(failedNote(page)).toHaveText("Not saved: you're offline. Tap Try again when you're back online.");
  await expect(page.locator("#notice")).toHaveText("You're offline. Nothing can be saved until the connection is back.");
  expect(backend.requests("POST", CHECKOUT)).toHaveLength(0);

  // Someone else checks one out meanwhile; this page misses the event
  const sheet = structuredClone(backend.doc("t1", "sheets", "s1").data);
  sheet.items.SKU1.out = 4;
  backend.write("t1", "sheets", "s1", sheet);
  const before = (await sockets(page)).length;
  await context.setOffline(false);
  await expect(page.locator("#notice")).toBeHidden();
  // A new socket and a re-list bring the latest
  await expect.poll(async () => (await sockets(page)).length).toBe(before + 1);
  await expect(lineRow(page, "Paper towels").locator("td").nth(2)).toHaveText("4");
  await expect(failedNote(page)).toHaveText("Not saved yet. You're back online: tap Try again.");

  await modal(page).getByRole("button", { name: "Try again" }).click();
  await expect(toast(page)).toHaveText("Checked out 2 × Paper towels, 6 roll");
  expect(backend.requests("POST", CHECKOUT)).toHaveLength(1);
  expect(backend.doc("t1", "sheets", "s1").data.items.SKU1.out).toBe(6);
  await expect(lineRow(page, "Paper towels").locator("td").nth(2)).toHaveText("6");
});

test("a new sheet whose answer was lost is saved once on Try again", { tag: ["@J4.1"] }, async ({ page }) => {
  const backend = await openEcho(page);
  await page.getByRole("button", { name: "← All sheets" }).click();
  backend.on("PUT", /^\/teams\/t1\/sheets\//, { lost: true });
  await page.getByRole("button", { name: "+ New sheet" }).click();
  await page.getByLabel("Client", { exact: true }).fill("Golf Clinic");
  await page.getByRole("button", { name: "Create sheet" }).click();
  await expect(failedNote(page)).toBeVisible();
  await modal(page).getByRole("button", { name: "Try again" }).click();
  await expect(toast(page)).toHaveText("Sheet created");
  await expect(page.getByRole("heading", { name: "Golf Clinic" })).toBeVisible();
  const [first, again] = backend.requests("PUT", /^\/teams\/t1\/sheets\//);
  expect(again.path).toBe(first.path);
  expect(again.body.data).toEqual(first.body.data);
  expect([...backend.docs.keys()].filter((k) => k.startsWith("t1/sheets/"))).toHaveLength(2);
});

test("a new sheet saved again over someone else's copy of it still says so", { tag: ["@J4.1"] }, async ({ page }) => {
  const backend = await openEcho(page);
  await page.getByRole("button", { name: "← All sheets" }).click();
  backend.on("PUT", /^\/teams\/t1\/sheets\//, { lost: true });
  await page.getByRole("button", { name: "+ New sheet" }).click();
  await page.getByLabel("Client", { exact: true }).fill("Golf Clinic");
  await page.getByRole("button", { name: "Create sheet" }).click();
  await expect(failedNote(page)).toBeVisible();
  // Changed before the retry arrives: it isn't this page's to overwrite
  const id = backend.requests("PUT", /^\/teams\/t1\/sheets\//)[0].path.split("/").pop();
  backend.write("t1", "sheets", id, { ...backend.doc("t1", "sheets", id).data, client: "Golf Clinic East" });
  await modal(page).getByRole("button", { name: "Try again" }).click();
  await expect(toast(page)).toHaveText("Someone else changed this just now, so your change wasn't saved. The latest is showing; make your change again if it's still needed.");
  expect(backend.doc("t1", "sheets", id).data.client).toBe("Golf Clinic East");
});

test("a new item without a barcode whose answer was lost is saved once on Try again", { tag: ["@J4.2"] }, async ({ page }) => {
  const backend = await openEcho(page);
  await page.getByRole("button", { name: "Inventory" }).click();
  backend.on("PUT", /^\/teams\/t1\/products\//, { lost: true });
  await page.getByRole("button", { name: "+ Add item" }).click();
  await modal(page).getByLabel("Item name").fill("Sponges");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(failedNote(page)).toBeVisible();
  await modal(page).getByRole("button", { name: "Try again" }).click();
  await expect(toast(page)).toHaveText("Saved");
  await expect(inventoryRow(page, "Sponges")).toHaveCount(1);
  const [first, again] = backend.requests("PUT", /^\/teams\/t1\/products\//);
  expect(again.path).toBe(first.path);
  expect([...backend.docs.values()].filter((d) => d.data.name === "Sponges")).toHaveLength(1);
});
