// Saving on a slow or flaky connection: a form shows it's saving and can't be sent twice or
// closed meanwhile, nothing shows as saved before it is, a failed save keeps what was entered
// and offers Try again, and going offline and back says so (saving() in src/main.js). The web
// build's operation IDs and lost answers are in tests/aws-save-states.spec.js.
import { test, expect, openApp, enterBarcode, modal, lineRow, createSheet } from "./helpers.js";
import { usedState } from "./fixtures.js";
import { currentBuild } from "../scripts/builds.mjs";

const toast = (page) => page.locator("#toast");
const failedNote = (page) => modal(page).locator(".save-failed");
const mock = (page, fn, arg) => page.evaluate(fn, arg);
const hold = (page) => mock(page, () => window.__mock.hold());
const release = (page) => mock(page, () => window.__mock.release());
const failWrites = (page, code) => mock(page, (c) => { window.__mock.failWrites = c; }, code);
const doc = (page, path) => mock(page, (p) => window.__mock.docs.get(p), path);
const writes = (page) => mock(page, () => window.__mock.writes);
const hideToast = (page) => page.locator("#toast").evaluate((t) => { t.hidden = true; });

async function openEcho(page, opts = usedState) {
  await openApp(page, opts);
  await page.getByRole("button", { name: /Echo Studio/ }).click();
  await expect(page.getByRole("heading", { name: "Echo Studio" })).toBeVisible();
}

test("a slow checkout says it's saving, can't be sent twice or closed, and shows saved only once it is", async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "SKU1");
  await hold(page);
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  const go = modal(page).getByRole("button", { name: "Saving…" });
  await expect(go).toBeDisabled();
  await expect(modal(page).getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(modal(page).getByRole("button", { name: "More" })).toBeDisabled();
  await expect(modal(page).locator("#fQty")).toBeDisabled();
  // A second tap, a second submit that gets through, Escape and a tap outside do nothing
  await go.dispatchEvent("click");
  await modal(page).locator("form").evaluate((f) => { f.requestSubmit(); f.requestSubmit(); });
  await page.keyboard.press("Escape");
  await page.locator("#overlay").click({ position: { x: 5, y: 5 } });
  await expect(go).toBeVisible();
  // Nothing says it saved yet
  await expect(toast(page)).toBeHidden();
  await expect(lineRow(page, "Paper towels").locator("td").nth(2)).toHaveText("3");
  expect(await writes(page)).toBe(1);

  await release(page);
  await expect(toast(page)).toHaveText("Checked out 1 × Paper towels, 6 roll");
  await expect(modal(page)).toBeEmpty();
  await expect(lineRow(page, "Paper towels").locator("td").nth(2)).toHaveText("4");
  // The line once, and the storage count once
  await expect.poll(() => doc(page, "products/SKU1").then((p) => p.stock)).toBe(9);
  expect((await doc(page, "sheets/s1")).items.SKU1.out).toBe(4);
  expect(await writes(page)).toBe(2);
});

test("a slow return says it's saving and counts once", async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "SKU1");
  await hold(page);
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(modal(page).getByRole("button", { name: "Saving…" })).toBeDisabled();
  await modal(page).locator("form").evaluate((f) => f.requestSubmit());
  await expect(toast(page)).toBeHidden();
  await release(page);
  await expect(toast(page)).toHaveText("1 returned · 2 of 3 back");
  await expect.poll(() => doc(page, "products/SKU1").then((p) => p.stock)).toBe(11);
  expect((await doc(page, "sheets/s1")).items.SKU1.returned).toBe(2);
});

test("a checkout that didn't save keeps what was entered, says so, and saves once on Try again", async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "NEW1");
  await modal(page).getByLabel("Item name").fill("Wax");
  await modal(page).getByLabel("Price each ($)").fill("4.25");
  await modal(page).getByRole("button", { name: "More" }).click();
  await modal(page).getByRole("button", { name: "More" }).click();
  await failWrites(page, "unavailable");
  await modal(page).getByRole("button", { name: "Add 3 to sheet" }).click();
  await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
  await expect(failedNote(page)).toHaveText("Not saved. Check your connection, then tap Try again.");
  const again = modal(page).getByRole("button", { name: "Try again" });
  await expect(again).toBeFocused();
  await expect(again).toHaveAttribute("aria-describedby", "saveFailed");
  await expect(modal(page).getByLabel("Item name")).toHaveValue("Wax");
  await expect(modal(page).getByLabel("Item name")).toBeEnabled();
  await expect(modal(page).getByLabel("Price each ($)")).toHaveValue("4.25");
  await expect(modal(page).locator("#fQty")).toHaveValue("3");
  await expect(lineRow(page, "Wax")).toHaveCount(0);

  // Still failing: the same state again
  await hideToast(page);
  await again.click();
  await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
  await expect(failedNote(page)).toHaveCount(1);
  await expect(again).toBeVisible();

  await failWrites(page, null);
  await again.click();
  await expect(toast(page)).toHaveText("Checked out 3 × Wax");
  await expect(lineRow(page, "Wax").locator("td").nth(2)).toHaveText("3");
  expect((await doc(page, "sheets/s1")).items.NEW1).toMatchObject({ name: "Wax", price: 4.25, out: 3 });
});

test("changing the quantity after a failure names the new request on the button", async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "SKU1");
  await failWrites(page, "unavailable");
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(modal(page).getByRole("button", { name: "Try again" })).toBeVisible();
  await modal(page).getByRole("button", { name: "More" }).click();
  await failWrites(page, "quota_exceeded");
  await modal(page).getByRole("button", { name: "Add 2 to sheet" }).click();
  // Storage is full: trying again won't help, so no Try again, and the form is as it was
  await expect(toast(page)).toHaveText("Storage is full. Delete old sheets or items to make room.");
  await expect(failedNote(page)).toHaveCount(0);
  await expect(modal(page).getByRole("button", { name: "Add 2 to sheet" })).toBeEnabled();
  await expect(modal(page).locator("#fQty")).toHaveValue("2");
});

test("a failure after a Try again that trying again won't fix goes back to the form's own button", async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "SKU1");
  await failWrites(page, "unavailable");
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await failWrites(page, "quota_exceeded");
  await modal(page).getByRole("button", { name: "Try again" }).click();
  await expect(toast(page)).toHaveText("Storage is full. Delete old sheets or items to make room.");
  await expect(modal(page).getByRole("button", { name: "Save return" })).toBeEnabled();
  await expect(failedNote(page)).toHaveCount(0);
});

test("offline, nothing is sent and the form says so; back online, Try again saves it once", async ({ page, context }) => {
  await openEcho(page);
  const notice = page.locator("#notice");
  await context.setOffline(true);
  await expect(notice).toHaveText("You're offline. Nothing can be saved until the connection is back.");
  await context.setOffline(false);
  await expect(notice).toBeHidden();

  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "SKU1");
  await modal(page).getByRole("button", { name: "More" }).click();
  await context.setOffline(true);
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(toast(page)).toHaveText("You're offline, so that wasn't saved. Try again when you're back online.");
  await expect(failedNote(page)).toHaveText("Not saved: you're offline. Tap Try again when you're back online.");
  await expect(notice).toBeVisible();
  expect(await writes(page)).toBe(0);

  await context.setOffline(false);
  await expect(notice).toBeHidden();
  await expect(failedNote(page)).toHaveText("Not saved yet. You're back online: tap Try again.");
  await expect(modal(page).locator("#fRet")).toHaveValue("2");
  await modal(page).getByRole("button", { name: "Try again" }).click();
  await expect(toast(page)).toHaveText("2 returned · 3 of 3 back");
  expect((await doc(page, "sheets/s1")).items.SKU1.returned).toBe(3);
  await expect.poll(() => doc(page, "products/SKU1").then((p) => p.stock)).toBe(12);
});

test("a new sheet that didn't save is the same sheet on Try again", async ({ page }) => {
  await openApp(page, usedState);
  await page.getByRole("button", { name: "+ New sheet" }).click();
  await page.getByLabel("Client", { exact: true }).fill("Golf Clinic");
  await failWrites(page, "unavailable");
  await page.getByRole("button", { name: "Create sheet" }).click();
  await expect(failedNote(page)).toBeVisible();
  await failWrites(page, null);
  await hold(page);
  await modal(page).getByRole("button", { name: "Try again" }).click();
  await expect(modal(page).getByRole("button", { name: "Saving…" })).toBeDisabled();
  await expect(modal(page).getByLabel("Client", { exact: true })).toBeDisabled();
  await release(page);
  await expect(page.getByRole("heading", { name: "Golf Clinic" })).toBeVisible();
  const sheets = await mock(page, () => [...window.__mock.docs.keys()].filter((k) => k.startsWith("sheets/")));
  expect(sheets).toHaveLength(2);
});

test("editing a sheet, a line or an item says it's saving", async ({ page }) => {
  await openEcho(page);
  await hold(page);
  await page.getByRole("button", { name: "Edit details" }).click();
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(modal(page).getByRole("button", { name: "Saving…" })).toBeDisabled();
  await release(page);
  await expect(toast(page)).toHaveText("Saved");

  await hold(page);
  await lineRow(page, "Paper towels").click();
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(modal(page).getByRole("button", { name: "Saving…" })).toBeDisabled();
  await expect(modal(page).getByRole("button", { name: "Remove" })).toBeDisabled();
  await release(page);
  await expect(modal(page)).toBeEmpty();

  await page.getByRole("button", { name: "← All sheets" }).click();
  await createSheet(page, "Hotel Nine");
  await page.getByRole("button", { name: "Inventory" }).click();
  await page.getByRole("button", { name: "+ Add item" }).click();
  await modal(page).getByLabel("Item name").fill("Sponges");
  await failWrites(page, "unavailable");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(failedNote(page)).toBeVisible();
  await failWrites(page, null);
  await modal(page).getByRole("button", { name: "Try again" }).click();
  await expect(modal(page)).toBeEmpty();
  // One item, not one per attempt
  const items = await mock(page, () => [...window.__mock.docs.values()].filter((d) => d.name === "Sponges"));
  expect(items).toHaveLength(1);
});

// Finishing, reopening and deleting a sheet, and removing a line or deleting an item, send one
// write however they're tapped, and say they're saving meanwhile (once() and busy() in src/main.js)
test("finishing and reopening a sheet say they're saving, and a second tap sends nothing", async ({ page }) => {
  await openEcho(page);
  await hold(page);
  await page.getByRole("button", { name: "Finished Return" }).click();
  const saving = page.getByRole("button", { name: "Saving…" });
  await expect(saving).toBeDisabled();
  await expect(saving).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("button", { name: "Delete sheet" })).toBeDisabled();
  await saving.dispatchEvent("click");
  await page.locator("#delSheet").dispatchEvent("click");
  // A redraw meanwhile (another user's change) keeps it saving
  await mock(page, () => { window.__mock.docs.get("sheets/s1").client = "Echo Studio 2"; window.__mock.notify(); });
  await expect(page.getByRole("heading", { name: "Echo Studio 2" })).toBeVisible();
  await expect(saving).toBeDisabled();
  expect(await writes(page)).toBe(1);
  await release(page);
  await expect(toast(page)).toHaveText("Return finished");
  await expect(page.getByRole("button", { name: "Delete sheet" })).toBeEnabled();

  await hold(page);
  await page.getByRole("button", { name: "Reopen" }).click();
  await expect(saving).toBeDisabled();
  await saving.dispatchEvent("click");
  expect(await writes(page)).toBe(2);
  await release(page);
  await expect(toast(page)).toHaveText("Sheet reopened");
  await expect(page.getByRole("button", { name: "Finished Return" })).toBeEnabled();
  expect((await doc(page, "sheets/s1")).status).toBe("open");
});

test("deleting a sheet sends one delete, and a tap after a failed one arms it again", async ({ page }) => {
  await openEcho(page);
  await failWrites(page, "unavailable");
  await page.getByRole("button", { name: "Delete sheet" }).click();
  await page.getByRole("button", { name: "Tap again to delete" }).click();
  await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
  // The second tap disarmed it: another tap asks again rather than deleting
  const del = page.getByRole("button", { name: "Delete sheet" });
  await expect(del).toBeEnabled();
  await failWrites(page, null);
  await del.click();
  await hold(page);
  await page.getByRole("button", { name: "Tap again to delete" }).click();
  await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await page.locator("#delSheet").dispatchEvent("click");
  await page.locator("#delSheet").dispatchEvent("click");
  expect(await writes(page)).toBe(2);
  await release(page);
  await expect(toast(page)).toHaveText("Sheet deleted");
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
  expect(await doc(page, "sheets/s1")).toBeUndefined();
  expect(await writes(page)).toBe(2);
});

test("removing a line or deleting an item keeps the form busy and writes once", async ({ page }) => {
  await openEcho(page);
  await lineRow(page, "Paper towels").click();
  await modal(page).getByRole("button", { name: "Remove" }).click();
  await hold(page);
  await modal(page).getByRole("button", { name: "Tap to remove" }).click();
  const remove = modal(page).getByRole("button", { name: "Remove" });
  await expect(remove).toBeDisabled();
  await expect(modal(page).getByRole("button", { name: "Save" })).toBeDisabled();
  await remove.dispatchEvent("click");
  await remove.dispatchEvent("click");
  await page.keyboard.press("Escape");
  await expect(remove).toBeVisible();
  expect(await writes(page)).toBe(1);
  await release(page);
  await expect(toast(page)).toHaveText("Removed");
  await expect(modal(page)).toBeEmpty();
  await expect(lineRow(page, "Paper towels")).toHaveCount(0);

  await page.getByRole("button", { name: "Inventory" }).click();
  await page.locator("#main tbody tr", { hasText: "Paper towels" }).click();
  await failWrites(page, "unavailable");
  await modal(page).getByRole("button", { name: "Delete" }).click();
  await modal(page).getByRole("button", { name: "Tap to delete" }).click();
  await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
  // Still open, and usable again
  await expect(modal(page).getByRole("button", { name: "Delete" })).toBeEnabled();
  await expect(modal(page).getByLabel("Item name")).toBeEnabled();
  await failWrites(page, null);
  await hold(page);
  await modal(page).getByRole("button", { name: "Delete" }).click();
  await modal(page).getByRole("button", { name: "Tap to delete" }).click();
  await expect(modal(page).getByRole("button", { name: "Delete" })).toBeDisabled();
  await modal(page).getByRole("button", { name: "Delete" }).dispatchEvent("click");
  await release(page);
  await expect(toast(page)).toHaveText("Item deleted");
  expect(await doc(page, "products/SKU1")).toBeUndefined();
  expect(await writes(page)).toBe(3);
});

// claude.ai's db has no timeout, so the artifact gives up on a write after 20 s (write() in
// src/main.js). The web build's requests time out themselves (tests/aws-save-states.spec.js).
const WRITE_TIMEOUT = 20e3;
test("in the artifact, a write that never answers fails after 20 seconds and can be tried again", async ({ page }) => {
  test.skip(currentBuild() === "web", "The web build's requests have their own timeout");
  await page.clock.install();
  await openEcho(page);
  await hold(page);
  await page.getByRole("button", { name: "Edit details" }).click();
  await modal(page).getByLabel("Client", { exact: true }).fill("Echo Two");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(modal(page).getByRole("button", { name: "Saving…" })).toBeDisabled();
  await page.clock.fastForward(WRITE_TIMEOUT - 1000);
  await expect(modal(page).getByRole("button", { name: "Saving…" })).toBeDisabled();
  await page.clock.fastForward(1000);
  await expect(failedNote(page)).toHaveText("Not saved. Check your connection, then tap Try again.");
  await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
  await expect(modal(page).getByLabel("Client", { exact: true })).toHaveValue("Echo Two");
  // It goes through after the page gave up on it; trying again saves the same edit
  await release(page);
  await expect.poll(() => doc(page, "sheets/s1").then((s) => s.client)).toBe("Echo Two");
  await modal(page).getByRole("button", { name: "Try again" }).click();
  await expect(toast(page)).toHaveText("Saved");
  await expect(modal(page)).toBeEmpty();
  await expect(page.getByRole("heading", { name: "Echo Two" })).toBeVisible();
});

test("in the artifact, a sheet action that never answers gives its button back after 20 seconds", async ({ page }) => {
  test.skip(currentBuild() === "web", "The web build's requests have their own timeout");
  await page.clock.install();
  await openEcho(page);
  await hold(page);
  await page.getByRole("button", { name: "Finished Return" }).click();
  await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await page.clock.fastForward(WRITE_TIMEOUT);
  await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
  await expect(page.getByRole("button", { name: "Finished Return" })).toBeEnabled();
});
