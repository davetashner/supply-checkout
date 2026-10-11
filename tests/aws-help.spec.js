// Help in the web build's bar under the header (src/aws/help.js, supply-checkout-vrm7): a link to
// the how-to lesson on the website for the screen the person is on, opened in a new tab, at the
// app's domain without "app.". The lessons themselves are tests/how-to.spec.js.
import { test, expect } from "./helpers.js";
import { goToInventory, openProject } from "./ui/index.js";
import { usedState } from "./fixtures.js";
import { FakeBackend, ORIGIN, openAws, connected } from "./fake-aws.js";

const seeded = () => Object.fromEntries(Object.entries(usedState.seed).map(([k, v]) => [`t1/${k}`, v]));
const help = (page) => page.locator(".teambar").getByRole("link", { name: "Help" });
// The tests' app is at supply-checkout.test, with no "app.": its site is the same host
const SITE = `${ORIGIN}/how-to/`;

// Opens Help and returns the address the new tab opened
async function follow(page) {
  const popup = page.waitForEvent("popup");
  await help(page).click();
  const tab = await popup;
  await tab.waitForLoadState();
  const url = tab.url();
  await tab.close();
  return url;
}

test("Help opens the lesson for the screen in a new tab: the list, Inventory and a project", async ({ page, context }) => {
  // The new tab gets a stand-in page: the lessons are the site's, not the app's
  await context.route(`${SITE}**`, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Lesson</title>" }));
  await openAws(page, new FakeBackend({ docs: seeded() }));
  await connected(page);
  await expect(help(page)).toHaveAttribute("href", SITE);
  await expect(help(page)).toHaveAttribute("target", "_blank");
  await expect(help(page)).toHaveAttribute("rel", "noopener");
  expect(await follow(page)).toBe(SITE);

  await goToInventory(page);
  // Focusing it is enough to point it at the screen's lesson, for a look at where it goes
  await help(page).focus();
  await expect(help(page)).toHaveAttribute("href", `${SITE}inventory-and-import/`);
  expect(await follow(page)).toBe(`${SITE}inventory-and-import/`);

  await page.locator("#tab-projects").click();
  await openProject(page, "Echo Studio");
  await help(page).hover();
  await expect(help(page)).toHaveAttribute("href", `${SITE}check-out-and-return/`);
  expect(await follow(page)).toBe(`${SITE}check-out-and-return/`);
});
