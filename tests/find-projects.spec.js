// Finding a project on the project list (supply-checkout-005.5): a search over client, who
// prepared it and items; finished projects grouped by month under year headings, with counts
// and, for owners, total charges; and a year filter that also scopes the owner's projects CSV.
import AxeBuilder from "@axe-core/playwright";
import { test, expect, openApp } from "./helpers.js";
import { modal, waitUntilConnected, goToInventory, openProject } from "./ui/index.js";

const Y = String(new Date().getFullYear()), OLD = String(Number(Y) - 1);
const line = (name, price, out, returned = 0) => ({ code: "", name, price, out, returned });
const closed = (client, date, who, items = {}) => ({ client, date, ...who, createdAt: `${date || "2020-01-01"}T12:00:00Z`, status: "closed", items });
const seed = {
  "products/towels": { code: "", name: "Towels", price: 10, stock: 5 },
  "projects/a": closed("Alpha Plumbing", `${Y}-09-10`, { createdByName: "Riley" }, { towels: line("Towels", 10, 3, 1) }),
  "projects/b": closed("Bravo Bakery", `${Y}-09-02`, { createdBy: "u_test" }, { cloth: line("Drop cloth", 4, 2) }),
  "projects/c": closed("Charlie Cafe", `${Y}-03-15`, { createdByName: "Sam" }, { roller: line("Paint roller", 5, 1) }),
  "projects/d": closed("Delta Dental", `${OLD}-12-20`, { createdByName: "Riley" }, { gloves: line("Nitrile gloves", 2, 5) }),
  "projects/e": closed("Echo Old", `${OLD}-06-05`, { createdByName: "Sam" }),
  "projects/n": closed("Nodate Co", "", { createdByName: "Sam" }),
  "projects/adhoc-1": { ...closed("", `${Y}-08-01`, { createdByName: "Sam" }, { towels: line("Towels", 10, 1) }), kind: "adhoc" },
  "projects/f": { client: "Foxtrot <Flooring>", date: `${Y}-09-28`, createdByName: "Riley", status: "open", items: { tape: line("Tape", 3, 2) } },
  "projects/adhoc-2": { kind: "adhoc", client: "", date: `${Y}-09-30`, createdByName: "Sam", status: "open", items: { mop: line("Mop", 0, 1) } },
};

async function open(page, opts = {}) {
  await openApp(page, { seed, ...opts });
  await waitUntilConnected(page);
}
const search = (page) => page.getByRole("searchbox", { name: "Search projects" });
const cards = (page) => page.locator("#main .project-card:visible h3");
const toggle = (page, year) => page.locator(`.year-toggle[data-year="${year}"]`);
const months = (page, year) => page.locator(`.year-group:has(.year-toggle[data-year="${year}"]) .month-head`);
const returned = (page) => page.getByRole("button", { name: "Returned", exact: true }).click();

test("search finds projects by client, who prepared them and their items, in each filter", { tag: ["@J6.1"] }, async ({ page }) => {
  await open(page);
  // Out now: the General Use card and the open client project; a search hides what doesn't match
  await expect(cards(page)).toHaveText(["General Use (no job)", "Foxtrot <Flooring>"]);
  await search(page).fill("foxtrot");
  await expect(cards(page)).toHaveText(["Foxtrot <Flooring>"]);
  await search(page).fill("  GENERAL use ");
  await expect(cards(page)).toHaveText(["General Use (no job)"]);

  await returned(page);
  // The finished General Use project matches "General Use" too
  await expect(cards(page)).toHaveText(["General Use (no job)"]);
  await search(page).fill("bravo");
  await expect(cards(page)).toHaveText(["Bravo Bakery"]);
  // Who prepared it: a typed name, or a user's profile name. Last year's group opens to show its match.
  await search(page).fill("riley");
  await expect(cards(page)).toHaveText(["Alpha Plumbing", "Delta Dental"]);
  await search(page).fill("test user");
  await expect(cards(page)).toHaveText(["Bravo Bakery"]);
  // An item on the project
  await search(page).fill("GLOVES");
  await expect(cards(page)).toHaveText(["Delta Dental"]);

  // All: the open projects too
  await page.getByRole("button", { name: "All", exact: true }).click();
  await search(page).fill("riley");
  await expect(cards(page)).toHaveText(["Foxtrot <Flooring>", "Alpha Plumbing", "Delta Dental"]);

  // Nothing matches: it says so, with the search as typed (escaped)
  await search(page).fill("<b>zzz</b>");
  await expect(page.locator("#main .empty")).toHaveText("No projects match “<b>zzz</b>”.");
  await expect(page.locator("#main .year-group")).toHaveCount(0);

  // The search stays when a project is opened and closed
  await search(page).fill("charlie");
  await openProject(page, "Charlie Cafe");
  await page.getByRole("button", { name: "← All projects" }).click();
  await expect(search(page)).toHaveValue("charlie");
  await expect(cards(page)).toHaveText(["Charlie Cafe"]);
  // and after the Inventory, which draws the list afresh
  await goToInventory(page);
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(search(page)).toHaveValue("charlie");
  await expect(cards(page)).toHaveText(["Charlie Cafe"]);
});

test("typing in the search keeps focus and the caret while the list redraws", { tag: ["@J6.1"] }, async ({ page }) => {
  await open(page);
  await returned(page);
  await search(page).click();
  await page.keyboard.type("rly");
  // Put the caret between r and l, then let another user's change redraw the list
  await search(page).evaluate((el) => el.setSelectionRange(1, 1));
  await page.evaluate(() => { window.__mock.docs.set("projects/g", { client: "Golf Club", date: "2020-01-01", status: "open", items: {} }); window.__mock.notify(); });
  await expect(page.getByRole("button", { name: "Out now (3)" })).toBeVisible();
  await page.keyboard.type("i");
  await expect(search(page)).toBeFocused();
  await expect(search(page)).toHaveValue("rily");
  expect(await search(page).evaluate((el) => el.selectionStart)).toBe(2);
  await search(page).evaluate((el) => el.setSelectionRange(4, 4));
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("ley");
  await expect(search(page)).toHaveValue("riley");
  await expect(cards(page)).toHaveText(["Alpha Plumbing", "Delta Dental"]);
});

test("Returned groups projects by month under year headings, with counts and the owner's totals", { tag: ["@J6.1"] }, async ({ page }) => {
  await open(page);
  await returned(page);
  await expect(page.locator(".year-head")).toHaveText([`${Y}4 projects · $33.00`, `${OLD}2 projects · $10.00`, "No date1 project · $0.00"]);
  // This year is open; older years are closed
  await expect(toggle(page, Y)).toHaveAttribute("aria-expanded", "true");
  await expect(toggle(page, OLD)).toHaveAttribute("aria-expanded", "false");
  await expect(toggle(page, "No date")).toHaveAttribute("aria-expanded", "false");
  // Newest month first; the General Use project counts but is never charged
  await expect(months(page, Y)).toHaveText(["September2 projects · $28.00", "August1 project · $0.00", "March1 project · $5.00"]);
  await expect(cards(page)).toHaveText(["Alpha Plumbing", "Bravo Bakery", "General Use (no job)", "Charlie Cafe"]);
  await expect(page.locator(".project-card:visible").nth(2)).not.toContainText("$");

  // By keyboard: Enter opens last year, Space closes this year
  await toggle(page, OLD).focus();
  await page.keyboard.press("Enter");
  await expect(toggle(page, OLD)).toHaveAttribute("aria-expanded", "true");
  await expect(months(page, OLD)).toHaveText(["December1 project · $10.00", "June1 project · $0.00"]);
  await expect(toggle(page, OLD)).toBeFocused();
  await toggle(page, Y).focus();
  await page.keyboard.press(" ");
  await expect(toggle(page, Y)).toHaveAttribute("aria-expanded", "false");
  await expect(cards(page)).toHaveText(["Delta Dental", "Echo Old"]);
  await toggle(page, "No date").click();
  await expect(months(page, "No date")).toHaveText(["No date1 project · $0.00"]);
  await expect(cards(page)).toHaveText(["Delta Dental", "Echo Old", "Nodate Co"]);

  // Remembered for the session: on Out now and back, and after a project
  await page.getByRole("button", { name: /^Out now/ }).click();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(cards(page)).toHaveText(["General Use (no job)", "Foxtrot <Flooring>", "Delta Dental", "Echo Old", "Nodate Co"]);
  await expect(toggle(page, Y)).toHaveAttribute("aria-expanded", "false");
  await openProject(page, "Delta Dental");
  await page.getByRole("button", { name: "← All projects" }).click();
  await expect(toggle(page, OLD)).toHaveAttribute("aria-expanded", "true");

  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
});

test("people who aren't owners see the counts but no totals", { tag: ["@J9"] }, async ({ page }) => {
  await open(page, { owner: false, canWrite: false });
  await returned(page);
  await expect(page.locator(".year-head")).toHaveText([`${Y}4 projects`, `${OLD}2 projects`, "No date1 project"]);
  await expect(months(page, Y)).toHaveText(["September2 projects", "August1 project", "March1 project"]);
  await expect(page.getByRole("button", { name: /^Export/ })).toHaveCount(0);
});

test("the year filter scopes the list and the owner's projects CSV", { tag: ["@J6"] }, async ({ page }) => {
  await open(page);
  const year = page.getByRole("combobox", { name: "Year" });
  await expect(year.locator("option")).toHaveText(["All years", Y, OLD]);
  await expect(page.getByRole("button", { name: "Export data" })).toBeVisible();

  await returned(page);
  await year.selectOption(OLD);
  // The year picked is open, though it's an older one
  await expect(page.locator(".year-head")).toHaveText([`${OLD}2 projects · $10.00`]);
  await expect(cards(page)).toHaveText(["Delta Dental", "Echo Old"]);
  await goToInventory(page);
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(year).toHaveValue(OLD);
  await expect(cards(page)).toHaveText(["Delta Dental", "Echo Old"]);
  // Out now has nothing open from then, but the General Use card stays
  await page.getByRole("button", { name: /^Out now/ }).click();
  await expect(cards(page)).toHaveText(["General Use (no job)"]);

  await page.getByRole("button", { name: `Export ${OLD}` }).click();
  await modal(page).getByRole("button", { name: `Projects from ${OLD} (CSV, 2 projects)` }).click();
  await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(1);
  const csv = await page.evaluate(() => window.__mock.saves[0]);
  expect(csv.filename).toMatch(new RegExp(`^Supply Checkout projects ${OLD} \\d{4}-\\d{2}-\\d{2}\\.csv$`));
  expect(csv.data.split("\n").slice(1).map((r) => r.split(",")[0])).toEqual(["Delta Dental", "Echo Old"]);
  // The JSON stays whole
  await modal(page).getByRole("button", { name: "Everything (JSON)" }).click();
  await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(2);
  expect(JSON.parse(await page.evaluate(() => window.__mock.saves[1].data)).projects).toHaveLength(Object.keys(seed).length - 1);
  await page.keyboard.press("Escape");

  // A year whose projects are all deleted meanwhile drops out, and the list shows all years
  await page.evaluate((old) => { for (const [k, v] of window.__mock.docs) if (k.startsWith("projects/") && String(v.date).startsWith(old)) window.__mock.docs.delete(k); window.__mock.notify(); }, OLD);
  await expect(year.locator("option")).toHaveText(["All years", Y]);
  await expect(year).toHaveValue("");
  await expect(page.getByRole("button", { name: "Export data" })).toBeVisible();
  await expect(cards(page)).toHaveText(["General Use (no job)", "Foxtrot <Flooring>"]);
});

test.describe("at 320px", () => {
  test.use({ viewport: { width: 320, height: 640 } });
  test("the grouped list, search and year filter fit without scrolling sideways", { tag: ["@J6.1"] }, async ({ page }) => {
    await open(page);
    await returned(page);
    await toggle(page, OLD).click();
    await search(page).fill("e");
    await expect(page.locator(".year-group")).toHaveCount(3);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test("when this year has no finished projects yet, the newest year is open", { tag: ["@J6.1"] }, async ({ page }) => {
  await openApp(page, { seed: { "projects/d": seed["projects/d"], "projects/e": seed["projects/e"], "projects/n": seed["projects/n"] } });
  await returned(page);
  await expect(toggle(page, OLD)).toHaveAttribute("aria-expanded", "true");
  await expect(toggle(page, "No date")).toHaveAttribute("aria-expanded", "false");
  await expect(cards(page)).toHaveText(["Delta Dental", "Echo Old"]);
});
