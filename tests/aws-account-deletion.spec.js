// The web build's runtime (src/aws/): leaving a team from the team bar, an owner closing a
// team, a closed team's read-only notice, reopening it, and deleting your account (src/aws/account.js,
// members.js, delete-account.js), against the fake backend in tests/fake-aws.js. The
// server's side is in backend/test/account-deletion-api.test.ts and closing.test.ts.
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./helpers.js";
import { currentBuild } from "../scripts/builds.mjs";
import { FakeBackend, TEAM, USER, AUTH, openAws, connected } from "./fake-aws.js";

test.skip(currentBuild() !== "web", "The AWS runtime is only in the web build");
// The modal's entrance animation fades it in; axe must see its final colors
test.use({ reducedMotion: "reduce" });

const JOINED = "2026-09-01T00:00:00.000Z";
const ME = { userId: USER.id, email: USER.email, role: "owner", joinedAt: JOINED };
const SAM = { userId: "u-sam", email: "sam@example.com", role: "contributor", joinedAt: JOINED };
const CLOSED = { closedAt: "2026-09-26T12:00:00.000Z", deletesAt: "2026-10-26T12:00:00.000Z" };
const dialog = (page) => page.locator("#modal");
const bar = (page) => page.locator(".teambar");
const account = (page) => page.locator("#account");
const error = (status, code, extra = {}) => ({ status, body: { error: { code, message: code, ...extra } } });

async function expectAccessible(page, include) {
  let axe = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  if (include) axe = axe.include(include);
  const { violations } = await axe.analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
}

async function open(page, backend) {
  await openAws(page, backend);
  await connected(page);
  return backend;
}

test.describe("leaving a team", () => {
  test("a contributor leaves from the team bar with two taps, and the team is forgotten", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, role: "contributor" }], members: { t1: [{ ...ME, role: "owner", userId: "u-owner" }, { ...SAM, userId: USER.id }] } }));
    await expect(bar(page).getByRole("button", { name: "Members" })).toHaveCount(0);
    await bar(page).getByRole("button", { name: "Leave team" }).click();
    expect(backend.requests("DELETE", `/teams/t1/members/${USER.id}`)).toHaveLength(0);
    await bar(page).getByRole("button", { name: "Tap again to leave" }).click();
    await expect(page.getByRole("heading", { name: "Your access changed" })).toBeVisible();
    await expect(account(page)).toContainText(`You left ${TEAM.name}.`);
    expect(backend.requests("DELETE", `/teams/t1/members/${USER.id}`)).toHaveLength(1);
    expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.team"))).toBeNull();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect.poll(() => backend.pageLoads).toBe(2);
  });

  test("a leave that fails says so, and can be tried again", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, role: "viewer" }] }));
    backend.on("DELETE", `/teams/t1/members/${USER.id}`, { abort: true });
    await bar(page).getByRole("button", { name: "Leave team" }).click();
    await bar(page).getByRole("button", { name: "Tap again to leave" }).click();
    await expect(page.locator("#toast")).toHaveText("Couldn't leave the team. Check your connection and try again.");
    await expect(bar(page).getByRole("button", { name: "Leave team" })).toBeEnabled();
    await expect(page.getByRole("heading", { name: "Your access changed" })).toHaveCount(0);
  });
});

test.describe("closing a team", () => {
  test("an owner types the team's name to close it, and starts again", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ members: { t1: [ME, SAM] }, teamInvites: { t1: [] } }));
    await bar(page).getByRole("button", { name: "Members" }).click();
    const name = dialog(page).getByLabel(`Type the team's name, ${TEAM.name}, to close it`);
    const close = dialog(page).getByRole("button", { name: "Close team" });
    await expect(close).toBeDisabled();
    await name.fill("Echo");
    await expect(close).toBeDisabled();
    await name.fill("  echo cleaning ");
    await expect(close).toBeEnabled();
    await expectAccessible(page, "#modal");
    await close.click();
    await expect(page.getByRole("heading", { name: "Your access changed" })).toBeVisible();
    await expect(account(page)).toContainText(`You closed ${TEAM.name}. It's read-only now, and everything in it will be deleted on`);
    expect(backend.requests("POST", "/teams/t1/close").map((c) => c.body)).toEqual([{ name: "  echo cleaning " }]);
    await expect(page.locator("#overlay")).toBeHidden();
    // Still the team to open next time, now closed
    expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.team"))).toBe("t1");
  });

  test("says why closing was refused, and lets the owner try again", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ members: { t1: [ME] } }));
    await bar(page).getByRole("button", { name: "Members" }).click();
    await dialog(page).getByLabel(/to close it/).fill(TEAM.name);
    const close = dialog(page).getByRole("button", { name: "Close team" });
    const fail = dialog(page).locator("#closeFail");
    for (const [answer, text] of [
      [error(400, "bad_request"), "Type the team's name as it's shown."],
      [error(409, "aborted"), "Someone else changed the team just now. Try again."],
      [error(403, "permission_denied", { reason: "owners_only" }), "Only the team's owners can close it."],
      [{ abort: true }, "Couldn't close the team. Check your connection and try again."],
    ]) {
      backend.on("POST", "/teams/t1/close", answer);
      await close.click();
      await expect(fail).toHaveText(text);
      await expect(close).toBeEnabled();
    }
  });
});

test.describe("a closed team", () => {
  test("is read-only with a notice for its owner, who can still export, remove people and leave", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...CLOSED }], members: { t1: [ME, SAM] } }));
    await expect(bar(page).locator(".closed-note")).toHaveText("This team was closed on September 26, 2026. It's read-only, and everything in it will be deleted on October 26, 2026. Use Export data to keep a copy.");
    await expect(bar(page).getByRole("button", { name: "Import CSV" })).toHaveCount(0);
    await expect(page.locator("#notice")).toContainText("view-only");
    await expectAccessible(page);
    await bar(page).getByRole("button", { name: "Members" }).click();
    await expect(dialog(page)).toContainText("This team is closed: you can remove people or leave it, but not invite anyone or change roles.");
    await expect(dialog(page).locator("#inviteForm")).toHaveCount(0);
    await expect(dialog(page).locator("#closeForm")).toHaveCount(0);
    await expect(dialog(page).getByRole("combobox")).toHaveCount(2);
    for (const select of await dialog(page).getByRole("combobox").all()) await expect(select).toBeDisabled();
    await expect(dialog(page)).not.toContainText("A team needs at least one owner.");
    // Removing someone doesn't touch invites (there are none)
    const sam = dialog(page).locator(".member", { hasText: "sam@example.com" });
    await sam.getByRole("button", { name: "Remove" }).click();
    await sam.getByRole("button", { name: "Tap again to remove" }).click();
    await expect(page.locator("#toast")).toHaveText("Removed sam@example.com from the team");
    // The last owner can leave a closed team
    const me = dialog(page).locator(".member", { hasText: "(you)" });
    await me.getByRole("button", { name: "Leave" }).click();
    await me.getByRole("button", { name: "Tap again to leave" }).click();
    await expect(account(page)).toContainText(`You left ${TEAM.name}.`);
    expect(backend.requests("DELETE", `/teams/t1/members/${USER.id}`)).toHaveLength(1);
  });

  test("tells a contributor when it'll be deleted, without the export hint or a way to reopen it", async ({ page }) => {
    await open(page, new FakeBackend({ teams: [{ ...TEAM, ...CLOSED, role: "contributor" }] }));
    await expect(bar(page).locator(".closed-note")).toHaveText("This team was closed on September 26, 2026. It's read-only, and everything in it will be deleted on October 26, 2026.");
    await expect(bar(page).getByRole("button", { name: "Leave team" })).toBeVisible();
    await expect(bar(page).getByRole("button", { name: "Reopen team" })).toHaveCount(0);
  });

  test("an owner types the team's name to reopen it, and starts again with it open", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...CLOSED }], members: { t1: [ME, SAM] } }));
    await bar(page).getByRole("button", { name: "Reopen team" }).click();
    await expect(dialog(page).getByRole("heading", { name: `Reopen ${TEAM.name}` })).toBeVisible();
    await expect(dialog(page)).toContainText("Invites that were cancelled when it closed stay cancelled");
    const name = dialog(page).getByLabel(`Type the team's name, ${TEAM.name}, to reopen it`);
    const go = dialog(page).getByRole("button", { name: "Reopen team" });
    await expect(name).toBeFocused();
    await expect(go).toBeDisabled();
    await name.fill("Echo");
    await expect(go).toBeDisabled();
    await name.fill(" ECHO cleaning ");
    await expect(go).toBeEnabled();
    await expectAccessible(page, "#modal");
    await go.click();
    await expect(page.getByRole("heading", { name: "Your access changed" })).toBeVisible();
    await expect(account(page)).toContainText(`You reopened ${TEAM.name}. Its members can change it again, and it won't be deleted.`);
    expect(backend.requests("POST", "/teams/t1/reopen").map((c) => c.body)).toEqual([{ name: " ECHO cleaning " }]);
    await expect(page.locator("#overlay")).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.team"))).toBe("t1");
    // Continue loads the page again, and /me then has the team open
    expect(backend.teams[0]).toMatchObject({ id: "t1", closedAt: null, deletesAt: null });
    await page.getByRole("button", { name: "Continue" }).click();
    await expect.poll(() => backend.pageLoads).toBe(2);
  });

  test("says why reopening was refused, lets the owner try again, and Cancel closes it", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...CLOSED }], members: { t1: [ME] } }));
    await bar(page).getByRole("button", { name: "Reopen team" }).click();
    await dialog(page).getByLabel(/to reopen it/).fill(TEAM.name);
    const go = dialog(page).getByRole("button", { name: "Reopen team" });
    const fail = dialog(page).locator("#reopenFail");
    for (const [answer, text] of [
      [error(409, "aborted", { reason: "team_deleting" }), "This team is about to be deleted, so it can't be reopened any more."],
      [error(400, "bad_request"), "Type the team's name as it's shown."],
      [error(429, "quota_exceeded"), "This team has been reopened as many times as it can be today. Try again tomorrow."],
      [error(409, "aborted"), "Someone else changed the team just now. Try again."],
      [error(403, "permission_denied", { reason: "not_member" }), "Only the team's owners can reopen it."],
      [{ abort: true }, "Couldn't reopen the team. Check your connection and try again."],
    ]) {
      backend.on("POST", "/teams/t1/reopen", answer);
      await go.click();
      await expect(fail).toHaveText(text);
      await expect(go).toBeEnabled();
    }
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    await expect(bar(page).locator(".closed-note")).toBeVisible();
  });

  test("closed by another owner meanwhile: a refused write switches the app to view-only", async ({ page }) => {
    const backend = await open(page, new FakeBackend());
    backend.on("PUT", /^\/teams\/t1\/sheets\//, error(403, "permission_denied", { reason: "team_closed" }));
    await page.getByRole("button", { name: "+ New sheet" }).click();
    await page.getByLabel("Client", { exact: true }).fill("Delta");
    await page.getByRole("button", { name: "Create sheet" }).click();
    await expect(page.locator("#notice")).toContainText("view-only");
    await expect(page.getByRole("heading", { name: /no longer in/ })).toHaveCount(0);
  });
});

test.describe("deleting an account", () => {
  test("from the team bar: typed DELETE, the server's reason when it refuses, then signed out for good", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ members: { t1: [ME, SAM] } }));
    await bar(page).getByRole("button", { name: "Account" }).click();
    await expect(dialog(page)).toContainText(`Signed in as ${USER.email}.`);
    const confirm = dialog(page).getByLabel("Type DELETE to confirm");
    const remove = dialog(page).getByRole("button", { name: "Delete account" });
    await expect(confirm).toBeFocused();
    await expect(remove).toBeDisabled();
    await confirm.fill("delet");
    await expect(remove).toBeDisabled();
    await confirm.fill(" delete ");
    await expect(remove).toBeEnabled();
    await expectAccessible(page, "#modal");
    // The only owner of a team Sam is still in
    await remove.click();
    await expect(dialog(page).locator("#deleteFail")).toHaveText(`You're the only owner of ${TEAM.name}. Make someone else an owner, or close the team, before you delete your account.`);
    await expect(remove).toBeEnabled();
    for (const [answer, text] of [
      [error(400, "bad_request"), "Type DELETE to confirm."],
      [{ abort: true }, "Couldn't delete your account. Check your connection and try again. Anything already done stays done."],
    ]) {
      backend.on("DELETE", "/me", answer);
      await remove.click();
      await expect(dialog(page).locator("#deleteFail")).toHaveText(text);
    }
    backend.members.t1 = [ME];
    await remove.click();
    await expect(page.getByRole("heading", { name: "Your account is deleted" })).toBeVisible();
    expect(backend.requests("DELETE", "/me").at(-1).body).toEqual({ confirm: "delete" });
    await expect(page.locator("#overlay")).toBeHidden();
    // Everything this device kept is forgotten, and the refresh cookie is cleared by a refused refresh
    expect(await page.evaluate(() => [localStorage.getItem("supplyCheckout.team"), localStorage.getItem("supplyCheckout.owner")])).toEqual([null, null]);
    await expect.poll(() => backend.requests("POST", "/auth/refresh").length).toBeGreaterThan(1);
    const done = page.getByRole("link", { name: "Done" });
    expect(await done.getAttribute("href")).toMatch(/^https:\/\/auth\.supply-checkout\.test\/logout\?client_id=test-client&logout_uri=/);
    expect(AUTH).toBe("https://auth.supply-checkout.test");
  });

  test("from the first screen, before any team, for a user without an email, and Cancel closes it", async ({ page }) => {
    const backend = new FakeBackend({ teams: [], user: { ...USER, email: null, emailVerified: false } });
    await openAws(page, backend);
    await expect(page.getByRole("heading", { name: "Name your team" })).toBeVisible();
    await account(page).getByRole("button", { name: "Delete account" }).click();
    await expect(dialog(page)).toContainText("Signed in as you.");
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    await account(page).getByRole("button", { name: "Delete account" }).click();
    await dialog(page).getByLabel("Type DELETE to confirm").fill("DELETE");
    await dialog(page).getByRole("button", { name: "Delete account" }).click();
    await expect(page.getByRole("heading", { name: "Your account is deleted" })).toBeVisible();
    expect(backend.deleted).toBe(true);
    await expectAccessible(page);
  });
});
