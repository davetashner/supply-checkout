// Saving on a slow or flaky connection: a form shows it's saving and can't be sent twice or
// closed meanwhile, nothing shows as saved before it is, a failed save keeps what was entered
// and offers Try again, and going offline and back says so (saving() in src/main.js). The web
// build's operation IDs and lost answers are in tests/aws-save-states.spec.js.
import { test, expect, openApp, enterBarcode, modal, lineRow, createSheet } from "./helpers.js";
import { usedState } from "./fixtures.js";

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

test("a slow checkout says it's saving, can't be sent twice or closed, and shows saved only once it is", { tag: ["@J4.2"] }, async ({ page }) => {
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

test("a slow return says it's saving and counts once", { tag: ["@J4.3"] }, async ({ page }) => {
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

test("a checkout that didn't save keeps what was entered, says so, and saves once on Try again", { tag: ["@J4.2"] }, async ({ page }) => {
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

// A save whose answer was lost: the artifact's write carries a mark for the action, which Try
// again finds, so it counts once (src/moves.js). The web build's commands do this with operation
// IDs (tests/aws-save-states.spec.js).
const loseWrites = (page, prefix) => mock(page, (p) => { window.__mock.loseWrites = p; }, prefix);
test("a checkout whose answer was lost counts once on Try again, on the line and in storage", { tag: ["@J4.2"] }, async ({ page }) => {
  // The line already has as many marks as it keeps: the oldest goes
  const old = Array.from({ length: 10 }, (_, i) => `o${i}`);
  const s1 = usedState.seed["sheets/s1"];
  await openEcho(page, { ...usedState, seed: { ...usedState.seed, "sheets/s1": { ...s1, items: { ...s1.items, SKU1: { ...s1.items.SKU1, ops: old } } } } });
  await enterBarcode(page, "SKU1");
  await loseWrites(page, "sheets/");
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
  const lost = (await doc(page, "sheets/s1")).items.SKU1;
  expect(lost.out).toBe(4);
  expect(lost.ops).toEqual([...old.slice(1), expect.any(String)]);
  await loseWrites(page, null);
  await hideToast(page);
  await modal(page).getByRole("button", { name: "Try again" }).click();
  await expect(toast(page)).toHaveText("Checked out 1 × Paper towels, 6 roll");
  await expect(lineRow(page, "Paper towels").locator("td").nth(2)).toHaveText("4");
  await expect.poll(() => doc(page, "products/SKU1").then((p) => p.stock)).toBe(9);
  expect((await doc(page, "sheets/s1")).items.SKU1).toEqual(lost);
});

test("a return whose answer was lost counts once on Try again", { tag: ["@J4.3"] }, async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "SKU1");
  await loseWrites(page, "sheets/");
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(modal(page).getByRole("button", { name: "Try again" })).toBeVisible();
  expect((await doc(page, "sheets/s1")).items.SKU1.returned).toBe(2);
  await loseWrites(page, null);
  await hideToast(page);
  await modal(page).getByRole("button", { name: "Try again" }).click();
  await expect(toast(page)).toHaveText("1 returned · 2 of 3 back");
  await expect.poll(() => doc(page, "products/SKU1").then((p) => p.stock)).toBe(11);
  expect((await doc(page, "sheets/s1")).items.SKU1.returned).toBe(2);
});

// The artifact writes the sheet line, then the storage count. If the storage count fails, the
// form stays open with its quantity fixed, and Try again writes only the storage count, with a
// mark on the item so it counts once (src/moves.js). (In the web build's mock runtime too.)
const OWING = "Saved on the sheet, but the storage count didn't save. Tap Try again to finish; nothing is counted twice. Cancel leaves storage as it is.";
const qtyLocked = async (page, id) => {
  await expect(modal(page).locator("#" + id)).toBeDisabled();
  await expect(modal(page).getByRole("button", { name: "More" })).toBeDisabled();
  await expect(modal(page).getByRole("button", { name: "Fewer" })).toBeDisabled();
};
test("a checkout whose storage count didn't save keeps the form open, and Try again counts storage once", { tag: ["@J4.2"] }, async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "SKU1");
  await failWrites(page, { prefix: "products/", code: "unavailable" });
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(failedNote(page)).toHaveText(OWING);
  await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
  await qtyLocked(page, "fQty");
  const line = (await doc(page, "sheets/s1")).items.SKU1;
  expect(line.out).toBe(4);
  expect((await doc(page, "products/SKU1")).stock).toBe(10);
  await failWrites(page, null);
  await hideToast(page);
  const before = await writes(page);
  await modal(page).getByRole("button", { name: "Try again" }).click();
  await expect(toast(page)).toHaveText("Checked out 1 × Paper towels, 6 roll");
  await expect(modal(page)).toBeEmpty();
  const item = await doc(page, "products/SKU1");
  expect(item.stock).toBe(9);
  expect(item.ops).toEqual([line.ops.at(-1)]);
  // Only the storage count was written again; the line is as it was
  expect(await writes(page)).toBe(before + 1);
  expect((await doc(page, "sheets/s1")).items.SKU1).toEqual(line);
});

// Closing the form then would leave storage uncounted, so only Cancel closes it, on a second tap
test("a checkout whose storage count is owed warns before Cancel closes it", { tag: ["@J4.2"] }, async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "SKU1");
  await failWrites(page, { prefix: "products/", code: "unavailable" });
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(failedNote(page)).toHaveText(OWING);
  // Escape and a tap outside don't close it
  await page.keyboard.press("Escape");
  await page.locator("#overlay").click({ position: { x: 5, y: 5 } });
  await expect(failedNote(page)).toBeVisible();
  const cancel = modal(page).locator("#cancel");
  await cancel.click();
  await expect(cancel).toHaveText("Tap again to leave storage as it is");
  await expect(failedNote(page)).toBeVisible();
  await cancel.click();
  await expect(page.locator("#overlay")).toBeHidden();
  // On the sheet, and storage as it was
  expect((await doc(page, "sheets/s1")).items.SKU1.out).toBe(4);
  expect((await doc(page, "products/SKU1")).stock).toBe(10);
});

test("a return whose storage count is owed can still be finished after Cancel warns", { tag: ["@J4.3"] }, async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "SKU1");
  await failWrites(page, { prefix: "products/", code: "unavailable" });
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(failedNote(page)).toHaveText(OWING);
  const cancel = modal(page).locator("#cancel");
  await cancel.click();
  await expect(cancel).toHaveText("Tap again to leave storage as it is");
  await failWrites(page, null);
  await modal(page).getByRole("button", { name: "Try again" }).click();
  await expect(toast(page)).toHaveText("1 returned · 2 of 3 back");
  await expect(page.locator("#overlay")).toBeHidden();
  expect((await doc(page, "products/SKU1")).stock).toBe(11);
});

test("a return whose storage count was refused or lost is finished once by trying again", { tag: ["@J4.3"] }, async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "SKU1");
  // Refused for a reason trying again won't fix: no Try again note, but the quantity is fixed
  await failWrites(page, { prefix: "products/", code: "quota_exceeded" });
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(toast(page)).toHaveText("Storage is full. Delete old sheets or items to make room.");
  await expect(failedNote(page)).toHaveCount(0);
  await qtyLocked(page, "fRet");
  expect((await doc(page, "sheets/s1")).items.SKU1.returned).toBe(2);
  // Saved, but the answer is lost
  await failWrites(page, null);
  await loseWrites(page, "products/");
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(failedNote(page)).toHaveText(OWING);
  expect((await doc(page, "products/SKU1")).stock).toBe(11);
  await loseWrites(page, null);
  await hideToast(page);
  const before = await writes(page);
  await modal(page).getByRole("button", { name: "Try again" }).click();
  await expect(toast(page)).toHaveText("1 returned · 2 of 3 back");
  await expect(modal(page)).toBeEmpty();
  // Found the mark: nothing written again
  expect(await writes(page)).toBe(before);
  expect((await doc(page, "products/SKU1")).stock).toBe(11);
  expect((await doc(page, "sheets/s1")).items.SKU1.returned).toBe(2);
});

test("changing the quantity after a failure names the new request on the button", { tag: ["@J4.2"] }, async ({ page }) => {
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

test("a failure after a Try again that trying again won't fix goes back to the form's own button", { tag: ["@J4.2"] }, async ({ page }) => {
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

test("offline, nothing is sent and the form says so; back online, Try again saves it once", { tag: ["@J4.2"] }, async ({ page, context }) => {
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

test("a new sheet that didn't save is the same sheet on Try again", { tag: ["@J4.1"] }, async ({ page }) => {
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

test("editing a sheet, a line or an item says it's saving", { tag: ["@J4"] }, async ({ page }) => {
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
test("finishing and reopening a sheet say they're saving, and a second tap sends nothing", { tag: ["@J4.3"] }, async ({ page }) => {
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

  await hideToast(page);
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

test("deleting a sheet sends one delete, and a tap after a failed one arms it again", { tag: ["@J4"] }, async ({ page }) => {
  await openEcho(page);
  await failWrites(page, "unavailable");
  await page.getByRole("button", { name: "Delete sheet" }).click();
  await page.getByRole("button", { name: "Tap again to delete" }).click();
  await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
  // The second tap disarmed it: another tap asks again rather than deleting
  const del = page.getByRole("button", { name: "Delete sheet" });
  await expect(del).toBeEnabled();
  await failWrites(page, null);
  // The toast would be over the button on a phone
  await hideToast(page);
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

test("removing a line or deleting an item keeps the form busy and writes once", { tag: ["@J4"] }, async ({ page }) => {
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
  await hideToast(page);
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

