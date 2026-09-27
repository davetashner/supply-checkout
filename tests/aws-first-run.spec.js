// The web build's first-run checklist (src/first-run.js, src/aws/account.js): after an owner
// names a new team, a short list gets the empty team ready, ticks itself off, and shows until
// it's finished or dismissed, remembered per team. Against the fake backend in tests/fake-aws.js.
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./helpers.js";
import { currentBuild } from "../scripts/builds.mjs";
import { FakeBackend, TEAM, openAws, connected } from "./fake-aws.js";

test.skip(currentBuild() !== "web", "The AWS runtime is only in the web build");
// The modal's entrance animation fades it in; axe must see its final colors
test.use({ reducedMotion: "reduce" });

const checklist = (page) => page.locator("#firstRun");
const modal = (page) => page.locator("#modal");
const stored = (page, team) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), `supplyCheckout.firstRun.${team}`);
const KEY = "supplyCheckout.firstRun.t1";

async function expectAccessible(page) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function createTeam(page, backend, name = "Bravo Co") {
  await openAws(page, backend);
  await page.getByLabel("Team name").fill(name);
  await page.getByRole("button", { name: "Create team" }).click();
  await connected(page);
  return backend.teams[0].id;
}

test("a new owner is guided through the checklist to a team ready to use", async ({ page }) => {
  const backend = new FakeBackend({ teams: [] });
  const team = await createTeam(page, backend);
  const list = checklist(page);
  await expect(list.getByRole("heading", { name: "Get your team started" })).toBeVisible();
  await expect(list).toContainText("0 of 3 done");
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expectAccessible(page);
  expect(await stored(page, team)).toEqual({});

  // Supplies, by hand: the inventory opens with a new item
  await list.getByRole("button", { name: "Add an item" }).click();
  await expect(page.locator("#tab-prices")).toHaveAttribute("aria-pressed", "true");
  await modal(page).getByLabel("Item name").fill("Nitrile gloves");
  await modal(page).getByLabel("Price each ($)").fill("13");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(list).toContainText("1 of 3 done");
  await expect(list.getByRole("heading", { name: "Done: Add your supplies" })).toBeVisible();
  await expect(list.getByRole("button", { name: "Add an item" })).toHaveCount(0);

  // The crew, from the members screen
  await list.getByRole("button", { name: "Invite people" }).click();
  await modal(page).getByLabel("Email").fill("sam@example.com");
  await modal(page).getByRole("button", { name: "Send invite" }).click();
  await expect(page.locator("#toast")).toHaveText("Invite sent to sam@example.com");
  await modal(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(list).toContainText("2 of 3 done");
  expect(await stored(page, team)).toEqual({ invited: true });

  // A first sheet: it opens, and the checklist waits behind it
  await list.getByRole("button", { name: "Create a sheet" }).click();
  await page.getByLabel("Client", { exact: true }).fill("Foxtrot Dental");
  await page.getByRole("button", { name: "Create sheet" }).click();
  await expect(page.locator("#sheetView")).toBeVisible();
  await expect(list).toBeHidden();
  expect(await stored(page, team)).toEqual({ invited: true, done: true });
  await page.getByRole("button", { name: "← All sheets" }).click();
  await expect(list.getByRole("heading", { name: "You're all set" })).toBeVisible();
  await expectAccessible(page);
  await list.getByRole("button", { name: "Close" }).click();
  await expect(list).toBeHidden();
});

test("a finished or dismissed checklist stays away", async ({ page }) => {
  await openAws(page, new FakeBackend(), { storage: { local: { [KEY]: JSON.stringify({ done: true }) } } });
  await connected(page);
  await expect(page.locator(".teambar")).toContainText("Team: Echo Cleaning");
  await expect(checklist(page)).toHaveCount(0);
});

test("the checklist offers the CSV import with its template, and fits a phone in dark mode", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.emulateMedia({ colorScheme: "dark" });
  const backend = new FakeBackend({ teams: [] });
  await createTeam(page, backend, "A team with a rather long name for a small screen");
  const list = checklist(page);
  await expect(list).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await expectAccessible(page);
  await list.getByRole("button", { name: "Import a CSV file" }).click();
  await expect(modal(page).getByRole("heading", { name: "Import inventory" })).toBeVisible();
  const download = page.waitForEvent("download");
  await modal(page).getByRole("button", { name: "Download a template" }).click();
  expect((await download).suggestedFilename()).toBe("inventory-template.csv");
  await modal(page).getByRole("button", { name: "Cancel" }).click();
  await expect(list).toContainText("0 of 3 done");
});

test("dismissing it is remembered for the team", async ({ page }) => {
  const backend = new FakeBackend();
  await openAws(page, backend, { storage: { local: { [KEY]: "{}" } } });
  await connected(page);
  const list = checklist(page);
  await expect(list).toContainText("0 of 3 done");
  // A tap on its text does nothing
  await list.getByText("Invite the people who take supplies to jobs.").click();
  await expect(page.locator("#overlay")).toBeHidden();
  // Not over a sheet or a receipt: only the sheet list and inventory
  await page.locator("#tab-prices").click();
  await expect(list).toBeVisible();
  await list.getByRole("button", { name: "Dismiss the getting started checklist" }).click();
  await expect(list).toBeHidden();
  expect(await stored(page, "t1")).toEqual({ done: true });
  await page.locator("#tab-sheets").click();
  await expect(list).toBeHidden();
});

test("an invite sent from the team bar's Members ticks the step too", async ({ page }) => {
  const backend = new FakeBackend();
  await openAws(page, backend, { storage: { local: { [KEY]: "{}" } } });
  await connected(page);
  await page.locator(".teambar").getByRole("button", { name: "Members" }).click();
  await modal(page).getByLabel("Email").fill("sam@example.com");
  await modal(page).getByRole("button", { name: "Send invite" }).click();
  await expect(page.locator("#toast")).toHaveText("Invite sent to sam@example.com");
  await modal(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(checklist(page)).toContainText("1 of 3 done");
  await expect(checklist(page).getByRole("heading", { name: "Done: Invite your crew" })).toBeVisible();
});

for (const [what, team] of [
  ["a contributor", { ...TEAM, role: "contributor" }],
  ["the owner of a closed team", { ...TEAM, closedAt: "2026-09-01T12:00:00.000Z", deletesAt: "2026-10-01T12:00:00.000Z" }],
]) {
  test(`${what} doesn't see it, even with one started`, async ({ page }) => {
    await openAws(page, new FakeBackend({ teams: [team] }), { storage: { local: { [KEY]: "{}" } } });
    await connected(page);
    await expect(page.locator(".teambar")).toContainText("Team: Echo Cleaning");
    await expect(checklist(page)).toHaveCount(0);
  });
}

test("an owner's existing team with none started doesn't get one", async ({ page }) => {
  await openAws(page, new FakeBackend());
  await connected(page);
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
  await expect(checklist(page)).toHaveCount(0);
});

test("a new team gets the checklist even when storage is blocked", async ({ page }) => {
  await page.addInitScript(() => {
    for (const m of ["getItem", "setItem"]) {
      const real = Storage.prototype[m];
      Storage.prototype[m] = function (...args) {
        if (this === window.localStorage) throw new DOMException("Blocked", "SecurityError");
        return real.apply(this, args);
      };
    }
  });
  const backend = new FakeBackend({ teams: [] });
  await createTeam(page, backend);
  await expect(checklist(page)).toContainText("0 of 3 done");
});
