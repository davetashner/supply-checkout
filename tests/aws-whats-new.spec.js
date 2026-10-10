// The What's New banner (src/aws/whats-new.js, supply-checkout-005.17) in the web build,
// against the fake backend: shown at most once a day per user and only with notes from the
// last 14 days, recorded on the server (PATCH /me/preferences) so it follows the user, turned
// off and on in Account, and never in the way: not a modal, no focus taken, and checkout
// works with it showing (J4). The notes are src/whats-new.json, so the dates here come from it.
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./helpers.js";
import { openProject, enterBarcode, addToProject } from "./ui/index.js";
import { usedState } from "./fixtures.js";
import { FakeBackend, USER, openAws, connected } from "./fake-aws.js";

const { releases } = JSON.parse(readFileSync(new URL("../src/whats-new.json", import.meta.url), "utf8"));
const NEWEST = releases[0].date;
const DAY = 864e5;
const shift = (ymd, days) => new Date(Date.parse(`${ymd}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
// The notes a day shows: releases dated in the 14 days up to it
const notesOn = (ymd) => releases.filter((r) => r.date >= shift(ymd, -13) && r.date <= ymd).flatMap((r) => r.notes);

// Every test runs in one time zone, at noon there on `today`. No motion: the modal's rise
// animation would still be part-way when axe checks its contrast
test.use({ timezoneId: "America/New_York", reducedMotion: "reduce" });

const banner = (page) => page.locator("#whatsNew");
const dialog = (page) => page.locator("#modal");
const bar = (page) => page.locator(".teambar");
const seeded = () => Object.fromEntries(Object.entries(usedState.seed).map(([k, v]) => [`t1/${k}`, v]));
const patches = (backend) => backend.requests("PATCH", "/me/preferences").map((r) => r.body);

async function open(page, { today = shift(NEWEST, 1), preferences = { whatsNew: true, whatsNewLastShown: null }, teams, docs = {} } = {}) {
  await page.clock.install({ time: new Date(`${today}T16:00:00Z`) });
  // null: an API from before the preferences
  const user = preferences === null ? USER : { ...USER, preferences };
  const backend = new FakeBackend({ user, docs, ...(teams ? { teams } : {}) });
  await openAws(page, backend);
  if (!teams) await connected(page);
  return backend;
}

async function expectAccessible(page) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test.describe("What's New", () => {
  test("shows the last 14 days' notes under the team bar once, records today, and takes no focus", async ({ page }) => {
    const today = shift(NEWEST, 1), notes = notesOn(today);
    const backend = await open(page, { today });
    await expect(banner(page).getByRole("heading", { name: "What's new" })).toBeVisible();
    // Not a modal, and the focus wasn't moved into it
    await expect(page.locator("#overlay")).toBeHidden();
    expect(await page.evaluate(() => !!document.activeElement.closest("#whatsNew"))).toBe(false);
    // Right under the team bar, above the app
    expect(await page.evaluate(() => document.querySelector(".teambar").nextElementSibling.id)).toBe("whatsNew");
    // The first three, then the rest behind Show all
    const shown = banner(page).locator(".whats-new-list").first().locator("li");
    await expect(shown).toHaveCount(3);
    for (const [i, n] of notes.slice(0, 3).entries()) await expect(shown.nth(i)).toHaveText(`${n.title} ${n.text}`);
    const more = banner(page).locator("summary");
    await expect(more).toHaveText(`Show all ${notes.length}`);
    await expect(banner(page).getByText(notes.at(-1).title, { exact: true })).toBeHidden();
    await more.click();
    await expect(banner(page).getByText(notes.at(-1).title, { exact: true })).toBeVisible();
    await expect(banner(page).getByRole("status")).toHaveText("What's new in Supply Checkout from the last two weeks, below the team bar.");
    await expect(banner(page)).toContainText("Turn these off in Account.");
    await expect.poll(() => patches(backend)).toEqual([{ whatsNewLastShown: today }]);
    await expectAccessible(page);
  });

  test("Dismiss takes it away and leaves the focus on Account", async ({ page }) => {
    await open(page);
    await banner(page).getByRole("button", { name: "Dismiss What's new" }).focus();
    await page.keyboard.press("Enter");
    await expect(banner(page)).toHaveCount(0);
    await expect(bar(page).getByRole("button", { name: /Account/ })).toBeFocused();
  });

  test("not again the same day, on any device: the server says it was shown today", async ({ page }) => {
    const today = shift(NEWEST, 1);
    const backend = await open(page, { today, preferences: { whatsNew: true, whatsNewLastShown: today } });
    await expect(bar(page)).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    expect(patches(backend)).toEqual([]);
  });

  test("the next day, only if something came out since it was last shown", async ({ page }) => {
    // Shown the day after the newest release; two days after it, nothing is newer
    const backend = await open(page, { today: shift(NEWEST, 2), preferences: { whatsNew: true, whatsNewLastShown: shift(NEWEST, 1) } });
    await expect(bar(page)).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    expect(patches(backend)).toEqual([]);
  });

  test("shown again for a release on the day it was last shown, since it may have come after", async ({ page }) => {
    const backend = await open(page, { today: shift(NEWEST, 1), preferences: { whatsNew: true, whatsNewLastShown: NEWEST } });
    await expect(banner(page)).toBeVisible();
    await expect.poll(() => patches(backend)).toEqual([{ whatsNewLastShown: shift(NEWEST, 1) }]);
  });

  test("nothing from the last 14 days: no banner", async ({ page }) => {
    const backend = await open(page, { today: shift(NEWEST, 14) });
    await expect(bar(page)).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    expect(patches(backend)).toEqual([]);
  });

  test("a release dated after today isn't shown yet", async ({ page }) => {
    // The day of an earlier release with notes: the newest with notes isn't out yet (a
    // release may have no notes, and two may share a date)
    const noted = releases.filter((r) => r.notes.length), newest = noted[0];
    const today = noted.find((r) => r.date < newest.date).date, notes = notesOn(today);
    await open(page, { today });
    await expect(banner(page)).toBeVisible();
    await expect(banner(page).getByText(newest.notes[0].title, { exact: true })).toHaveCount(0);
    await expect(banner(page).locator("li")).toHaveCount(notes.length);
    await expect(banner(page).locator("summary")).toHaveText(`Show all ${notes.length}`);
  });

  test("shown even if recording it fails", async ({ page }) => {
    await page.clock.install({ time: new Date(`${shift(NEWEST, 1)}T16:00:00Z`) });
    const backend = new FakeBackend({ user: { ...USER, preferences: { whatsNew: true, whatsNewLastShown: null } } });
    backend.on("PATCH", "/me/preferences", { status: 500, body: { error: { code: "internal", message: "internal" } } });
    await openAws(page, backend);
    await connected(page);
    await expect(banner(page)).toBeVisible();
    await expect.poll(() => backend.requests("PATCH", "/me/preferences").length).toBe(1);
    await expect(banner(page)).toBeVisible();
  });

  test("an API from before the preferences shows nothing, and Account has no setting", async ({ page }) => {
    const backend = await open(page, { preferences: null });
    await expect(bar(page)).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    await bar(page).getByRole("button", { name: /Account/ }).click();
    await expect(dialog(page)).toContainText("Signed in as");
    await expect(dialog(page).getByRole("checkbox")).toHaveCount(0);
    expect(patches(backend)).toEqual([]);
  });

  test("Account turns it off, which hides it at once, and on again, saved for every device", async ({ page }) => {
    const backend = await open(page);
    await expect(banner(page)).toBeVisible();
    await expect.poll(() => patches(backend).length).toBe(1);
    await bar(page).getByRole("button", { name: /Account/ }).click();
    const box = dialog(page).getByRole("checkbox", { name: "Show what's new after an update, at most once a day" });
    await expect(box).toBeChecked();
    await expectAccessible(page);
    await box.uncheck();
    await expect(banner(page)).toHaveCount(0);
    await expect(box).not.toBeChecked();
    await expect(box).toBeEnabled();
    expect(backend.user.preferences.whatsNew).toBe(false);
    await box.check();
    await expect(box).toBeEnabled();
    expect(backend.user.preferences.whatsNew).toBe(true);
    expect(patches(backend).slice(1)).toEqual([{ whatsNew: false }, { whatsNew: true }]);
    // Shown today already: it stays away until tomorrow
    await expect(banner(page)).toHaveCount(0);
  });

  test("turned off, there's no banner, and Account shows it off", async ({ page }) => {
    const backend = await open(page, { preferences: { whatsNew: false, whatsNewLastShown: null } });
    await expect(bar(page)).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    expect(patches(backend)).toEqual([]);
    await bar(page).getByRole("button", { name: /Account/ }).click();
    await expect(dialog(page).getByRole("checkbox")).not.toBeChecked();
    // Turning it off when it isn't showing
    await dialog(page).getByRole("checkbox").check();
    await dialog(page).getByRole("checkbox").uncheck();
    await expect(dialog(page).getByRole("checkbox")).toBeEnabled();
    expect(patches(backend)).toEqual([{ whatsNew: true }, { whatsNew: false }]);
  });

  test("a change that couldn't be saved goes back, and says so", async ({ page }) => {
    const backend = await open(page);
    await expect.poll(() => patches(backend).length).toBe(1);
    await bar(page).getByRole("button", { name: /Account/ }).click();
    backend.on("PATCH", "/me/preferences", { status: 500, body: { error: { code: "internal", message: "internal" } } });
    const box = dialog(page).getByRole("checkbox");
    await box.click();
    await expect(dialog(page).getByRole("alert").filter({ hasText: "Couldn't save that." })).toHaveText("Couldn't save that. Check your connection and try again.");
    await expect(box).toBeChecked();
    await expect(banner(page)).toBeVisible();
  });

  test("before a team is open, Account can turn it off too", async ({ page }) => {
    const backend = await open(page, { teams: [] });
    await expect(page.getByRole("heading", { name: "Name your team" })).toBeVisible();
    await page.locator("#accountDelete").click();
    await dialog(page).getByRole("checkbox").uncheck();
    await expect.poll(() => patches(backend)).toEqual([{ whatsNew: false }]);
    await expect(dialog(page).getByRole("checkbox")).toBeEnabled();
  });

  test("fits a phone, in dark mode too", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.emulateMedia({ colorScheme: "dark" });
    await open(page);
    await expect(banner(page)).toBeVisible();
    await banner(page).locator("summary").click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await expectAccessible(page);
  });

  test("checkout works with it showing, without dismissing it", { tag: ["@J4.2"] }, async ({ page }) => {
    const backend = await open(page, { docs: seeded() });
    await expect(banner(page)).toBeVisible();
    await openProject(page, "Echo Studio");
    await enterBarcode(page, "SKU1");
    await addToProject(page);
    await expect.poll(() => backend.requests("POST", "/teams/t1/projects/s1/checkout").length).toBe(1);
    await expect(banner(page)).toBeVisible();
  });
});
