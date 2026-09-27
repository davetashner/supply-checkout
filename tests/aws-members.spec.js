// The web build's members screen (src/aws/members.js): owners see the team's members and
// roles, change roles and remove members, and the last owner can't step down or leave,
// against the fake backend in tests/fake-aws.js. The server's side (the role checks and
// the atomic owner count) is tested in backend/test/members-api.test.ts and roles.test.ts.
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./helpers.js";
import { currentBuild } from "../scripts/builds.mjs";
import { FakeBackend, TEAM, USER, openAws, connected } from "./fake-aws.js";

test.skip(currentBuild() !== "web", "The AWS runtime is only in the web build");
// The modal's entrance animation fades it in; axe must see its final colors
test.use({ reducedMotion: "reduce" });

const PATH = "/teams/t1/members";
const JOINED = "2026-09-01T00:00:00.000Z";
const ME = { userId: USER.id, email: USER.email, role: "owner", joinedAt: JOINED };
const SAM = { userId: "u-sam", email: "sam@example.com", role: "contributor", joinedAt: JOINED };
const NOEMAIL = { userId: "u-anon", email: null, role: "viewer", joinedAt: JOINED };
const dialog = (page) => page.locator("#modal");
const row = (page, text) => dialog(page).locator(".member", { hasText: text });
const fail = (page) => page.locator("#membersFail");
const error = (status, code, extra = {}) => ({ status, body: { error: { code, message: code, ...extra } } });

async function openMembers(page, backend) {
  await openAws(page, backend);
  await connected(page);
  await page.locator(".teambar").getByRole("button", { name: "Members" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Members" })).toBeVisible();
  return backend;
}

test("an owner sees the members and roles, changes a role and removes a member", async ({ page }) => {
  const backend = new FakeBackend({ members: { t1: [ME, SAM, NOEMAIL] } });
  await openMembers(page, backend);
  await expect(dialog(page).locator(".member")).toHaveCount(3);
  await expect(row(page, "pat@example.com")).toContainText("(you)");
  await expect(row(page, "sam@example.com").getByRole("combobox")).toHaveValue("contributor");
  await expect(row(page, "without an email").getByRole("combobox")).toHaveValue("viewer");
  // The only owner can't step down or leave
  await expect(row(page, "pat@example.com").getByRole("combobox")).toBeDisabled();
  await expect(row(page, "pat@example.com").getByRole("button", { name: "Leave" })).toBeDisabled();
  await expect(dialog(page)).toContainText("A team needs at least one owner.");
  const { violations } = await new AxeBuilder({ page }).include("#modal").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);

  await row(page, "sam@example.com").getByRole("combobox").selectOption("owner");
  await expect(page.locator("#toast")).toHaveText("sam@example.com is now an owner");
  expect(backend.requests("PATCH", `${PATH}/u-sam`).map((c) => c.body)).toEqual([{ role: "owner" }]);
  // Two owners now: either can step down
  await expect(row(page, "pat@example.com").getByRole("combobox")).toBeEnabled();
  await expect(dialog(page)).not.toContainText("A team needs at least one owner.");

  await row(page, "without an email").getByRole("combobox").selectOption("contributor");
  await expect(page.locator("#toast")).toHaveText("The member is now a contributor");

  // Removing takes a second tap
  const remove = row(page, "sam@example.com").getByRole("button", { name: "Remove" });
  await remove.click();
  await expect(row(page, "sam@example.com").getByRole("button", { name: "Tap again to remove" })).toBeVisible();
  expect(backend.requests("DELETE", `${PATH}/u-sam`)).toHaveLength(0);
  await row(page, "sam@example.com").getByRole("button", { name: "Tap again to remove" }).click();
  await expect(row(page, "sam@example.com")).toHaveCount(0);
  await expect(page.locator("#toast")).toHaveText("Removed sam@example.com from the team");
  await row(page, "without an email").getByRole("button", { name: "Remove" }).click();
  await row(page, "without an email").getByRole("button", { name: "Tap again to remove" }).click();
  await expect(page.locator("#toast")).toHaveText("Removed the member from the team");
  expect(backend.members.t1.map((m) => m.userId)).toEqual([USER.id]);

  await dialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("#overlay")).toBeHidden();
});

test("an owner stepping down or leaving starts again, since their access changed", async ({ page }) => {
  const backend = new FakeBackend({ members: { t1: [ME, { ...SAM, role: "owner" }] } });
  await openMembers(page, backend);
  await row(page, "pat@example.com").getByRole("combobox").selectOption("viewer");
  await expect(page.getByRole("heading", { name: "Your access changed" })).toBeVisible();
  await expect(page.locator("#account")).toContainText(`You're now a viewer in ${TEAM.name}.`);
  await expect(page.locator("#overlay")).toBeHidden();
  // The team is kept for the next load
  expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.team"))).toBe("t1");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect.poll(() => backend.pageLoads).toBe(2);
});

test("an owner leaving forgets the team", async ({ page }) => {
  const backend = new FakeBackend({ members: { t1: [ME, { ...SAM, role: "owner" }] } });
  await openMembers(page, backend);
  await row(page, "pat@example.com").getByRole("button", { name: "Leave" }).click();
  await row(page, "pat@example.com").getByRole("button", { name: "Tap again to leave" }).click();
  await expect(page.locator("#account")).toContainText(`You left ${TEAM.name}.`);
  expect(backend.requests("DELETE", `${PATH}/${USER.id}`)).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.team"))).toBeNull();
});

test("says why a change was refused, and puts the role back", async ({ page }) => {
  const backend = new FakeBackend({ members: { t1: [ME, { ...SAM, role: "owner" }, NOEMAIL] } });
  await openMembers(page, backend);
  const sam = row(page, "sam@example.com").getByRole("combobox");
  // The other owner stepped down meanwhile: the server keeps the last owner
  const lastOwner = "A team needs at least one owner. Make someone else an owner first.";
  backend.on("PATCH", `${PATH}/u-sam`, error(409, "aborted", { message: lastOwner, reason: "last_owner" }));
  await sam.selectOption("viewer");
  await expect(fail(page)).toHaveText(lastOwner);
  await expect(sam).toHaveValue("owner");
  await expect(sam).toBeEnabled();
  for (const [answer, text] of [
    [error(409, "aborted"), "Someone else changed the team's members just now. Try again."],
    [error(404, "not_found"), "That person isn't in the team any more."],
    [error(403, "permission_denied", { reason: "owners_only" }), "Only the team's owners can manage members."],
    [{ status: 500, body: "<html>oops</html>" }, "Couldn't change the role. Check your connection and try again."],
  ]) {
    backend.on("PATCH", `${PATH}/u-sam`, answer);
    await sam.selectOption("contributor");
    await expect(fail(page)).toHaveText(text);
    await expect(sam).toHaveValue("owner");
  }
  // A removal that fails leaves the member, and the button, where they were
  backend.on("DELETE", `${PATH}/u-anon`, { abort: true });
  await row(page, "without an email").getByRole("button", { name: "Remove" }).click();
  await row(page, "without an email").getByRole("button", { name: "Tap again to remove" }).click();
  await expect(fail(page)).toHaveText("Couldn't remove them. Check your connection and try again.");
  await expect(row(page, "without an email").locator("[data-remove]")).toBeEnabled();
  // A change that works clears the message
  await row(page, "without an email").getByRole("combobox").selectOption("contributor");
  await expect(fail(page)).toBeHidden();
});

test("says so when the members don't load", async ({ page }) => {
  const backend = new FakeBackend({ members: { t1: [ME] } });
  backend.on("GET", PATH, error(500, "internal"));
  await openMembers(page, backend);
  await expect(fail(page)).toHaveText("Couldn't load the members. Check your connection and try again.");
  await expect(dialog(page).locator(".member")).toHaveCount(0);
});

test("only owners see Members", async ({ page }) => {
  await openAws(page, new FakeBackend({ teams: [{ ...TEAM, role: "contributor" }] }));
  await connected(page);
  await expect(page.locator(".teambar")).toContainText("Team: Echo Cleaning");
  await expect(page.getByRole("button", { name: "Members" })).toHaveCount(0);
});

test("fits a 320px screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openMembers(page, new FakeBackend({ members: { t1: [ME, { ...SAM, email: "a-very-long-address-for-someone@example.com" }] } }));
  await expect(dialog(page).locator(".member")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  expect(await page.locator("#modal").evaluate((m) => m.scrollWidth - m.clientWidth)).toBeLessThanOrEqual(0);
});
