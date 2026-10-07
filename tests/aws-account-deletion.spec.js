// The web build's runtime (src/aws/): leaving a team from the team bar, an owner closing a
// team, a closed team's read-only notice, reopening it, and deleting your account (src/aws/account.js,
// members.js, delete-account.js), against the fake backend in tests/fake-aws.js. The
// server's side is in backend/test/account-deletion-api.test.ts and closing.test.ts.
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./helpers.js";
import { FakeBackend, TEAM, USER, AUTH, openAws, connected } from "./fake-aws.js";

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

test.describe("leaving a team", { tag: ["@J11"] }, () => {
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

test.describe("closing a team", { tag: ["@J11.2"] }, () => {
  test("an owner types the team's name to close it, and starts again", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ members: { t1: [ME, SAM] }, teamInvites: { t1: [] } }));
    await bar(page).getByRole("button", { name: "Members" }).click();
    const name = dialog(page).getByLabel(`Type the team's name, ${TEAM.name}, to close it`);
    const close = dialog(page).getByRole("button", { name: "Close team" });
    // An annual plan closed mid-term isn't refunded, apart from the 14-day window (Terms section 7), and the dialog says so
    await expect(dialog(page)).toContainText("If the team pays yearly, closing it doesn't refund the unused months, except within 14 days of a yearly charge (see the Terms).");
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

test.describe("a closed team", { tag: ["@J11"] }, () => {
  test("is read-only with a notice for its owner, who can still export, remove people and leave", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...CLOSED }], members: { t1: [ME, SAM] } }));
    await expect(bar(page).locator(".closed-note")).toHaveText("This team was closed on September 26, 2026. It's read-only, and everything in it will be deleted on October 26, 2026. Use Export data to keep a copy.");
    await expect(bar(page).getByRole("button", { name: "Import CSV" })).toHaveCount(0);
    // Why it's read-only: the team is closed, not the owner's role
    await expect(page.locator("#notice")).toHaveText("This team is closed, so nothing in it can be changed.");
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
    await expect(page.locator("#notice")).toHaveText("This team is closed, so nothing in it can be changed.");
  });

  test.describe("reopening has a deadline", () => {
    test.use({ timezoneId: "America/New_York" });
    // Owners can reopen it until an hour before it's deleted (reopenBy, from /me)
    const SOON = { ...CLOSED, reopenBy: "2026-10-26T11:00:00.000Z" };

    test("an owner sees when reopening stops, and the button goes then", async ({ page }) => {
      await page.clock.install({ time: new Date("2026-10-26T10:30:00.000Z") });
      await open(page, new FakeBackend({ teams: [{ ...TEAM, ...SOON }], members: { t1: [ME] } }));
      await expect(bar(page).locator(".closed-note")).toContainText("Use Export data to keep a copy.");
      await expect(bar(page).locator("#reopenBy")).toHaveText(/^ Reopen by October 26, 2026,? (at )?7:00\sAM EDT to keep it\.$/);
      await expect(bar(page).getByRole("button", { name: "Reopen team" })).toBeVisible();
      await expectAccessible(page);
      await page.clock.fastForward(29 * 60e3);
      await expect(bar(page).getByRole("button", { name: "Reopen team" })).toBeVisible();
      await page.clock.fastForward(2 * 60e3);
      await expect(bar(page).getByRole("button", { name: "Reopen team" })).toHaveCount(0);
      await expect(bar(page).locator("#reopenBy")).toHaveText(" It's too close to being deleted to reopen now.");
    });

    test("a page left open for days checks again each day", async ({ page }) => {
      await page.clock.install({ time: new Date("2026-10-24T10:00:00.000Z") });
      await open(page, new FakeBackend({ teams: [{ ...TEAM, ...SOON }], members: { t1: [ME] } }));
      await page.clock.fastForward(86400e3);
      await expect(bar(page).getByRole("button", { name: "Reopen team" })).toBeVisible();
      await page.clock.fastForward(86400e3);
      await page.clock.fastForward(86400e3);
      await expect(bar(page).getByRole("button", { name: "Reopen team" })).toHaveCount(0);
    });

    test("past the deadline, the owner can't reopen it", async ({ page }) => {
      await page.clock.install({ time: new Date("2026-10-26T11:30:00.000Z") });
      await open(page, new FakeBackend({ teams: [{ ...TEAM, ...SOON }], members: { t1: [ME] } }));
      await expect(bar(page).locator(".closed-note")).toHaveText("This team was closed on September 26, 2026. It's read-only, and everything in it will be deleted on October 26, 2026. Use Export data to keep a copy. It's too close to being deleted to reopen now.");
      await expect(bar(page).getByRole("button", { name: "Reopen team" })).toHaveCount(0);
    });

    test("a contributor isn't told a deadline that isn't theirs", async ({ page }) => {
      await page.clock.install({ time: new Date("2026-10-26T10:30:00.000Z") });
      await open(page, new FakeBackend({ teams: [{ ...TEAM, ...SOON, role: "contributor" }] }));
      await expect(bar(page).locator(".closed-note")).toHaveText("This team was closed on September 26, 2026. It's read-only, and everything in it will be deleted on October 26, 2026.");
    });
  });

  test("an owner types the team's name to reopen it, and starts again with it open", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...CLOSED }], members: { t1: [ME, SAM] } }));
    await bar(page).getByRole("button", { name: "Reopen team" }).click();
    await expect(dialog(page).getByRole("heading", { name: `Reopen ${TEAM.name}` })).toBeVisible();
    await expect(dialog(page)).toContainText("Invites that were cancelled when it closed stay cancelled");
    // Billing comes back as it was, or the owner is told to subscribe again (supply-checkout-85qp)
    await expect(dialog(page)).toContainText("If closing the team set its subscription to end, reopening keeps it going. A subscription that has already ended doesn't come back: the team stays read-only until you subscribe again.");
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

  test.describe("closed by another owner meanwhile", () => {
    const MEANWHILE = "An owner closed this team, so nothing in it can be changed now. Reload the page to see when it will be deleted.";
    // A write the API refuses because the team is closed now
    async function refusedWrite(page, backend) {
      backend.on("PUT", /^\/teams\/t1\/projects\//, error(403, "permission_denied", { reason: "team_closed" }));
      await page.getByRole("button", { name: "+ New project" }).click();
      await page.getByLabel("Client", { exact: true }).fill("Delta");
      await page.getByRole("button", { name: "Create project" }).click();
    }

    test("a refused write reloads /me and shows the team bar as a closed team's, without a page reload", async ({ page }) => {
      const backend = await open(page, new FakeBackend({ members: { t1: [ME] } }));
      await expect(bar(page).getByRole("button", { name: "Import CSV" })).toBeVisible();
      await expect(bar(page).locator(".closed-note")).toHaveCount(0);
      const before = backend.requests("GET", "/me").length;
      backend.teams[0] = { ...backend.teams[0], ...CLOSED };
      await refusedWrite(page, backend);
      const closed = "This team is closed, so nothing in it can be changed.";
      await expect(page.locator("#toast")).toHaveText(closed);
      await expect(page.locator("#notice")).toHaveText(closed);
      await expect(bar(page)).toHaveCount(1);
      await expect(bar(page).locator(".closed-note")).toContainText("This team was closed on September 26, 2026. It's read-only, and everything in it will be deleted on October 26, 2026. Use Export data to keep a copy.");
      await expect(bar(page).getByRole("button", { name: "Import CSV" })).toHaveCount(0);
      await expect(bar(page).getByRole("button", { name: "Reopen team" })).toBeVisible();
      await expect.poll(() => backend.requests("GET", "/me").length).toBe(before + 1);
      expect(backend.pageLoads).toBe(1);
      await expect(page.getByRole("heading", { name: /no longer in/ })).toHaveCount(0);
      // The members screen is a closed team's now too (once the refused project's form is closed)
      await page.keyboard.press("Escape");
      await expect(page.locator("#overlay")).toBeHidden();
      await bar(page).getByRole("button", { name: "Members" }).click();
      await expect(dialog(page)).toContainText("This team is closed: you can remove people or leave it, but not invite anyone or change roles.");
    });

    test("if /me doesn't list the team as closed yet, says to reload", async ({ page }) => {
      const backend = await open(page, new FakeBackend());
      await refusedWrite(page, backend);
      await expect(page.locator("#toast")).toHaveText(MEANWHILE);
      await expect(page.locator("#notice")).toHaveText(MEANWHILE);
      await expect(bar(page).getByRole("button", { name: "Import CSV" })).toBeVisible();
      await expect(page.getByRole("heading", { name: /no longer in/ })).toHaveCount(0);
    });

    test("if /me doesn't load, says to reload", async ({ page }) => {
      const backend = await open(page, new FakeBackend());
      backend.on("GET", "/me", { abort: true });
      await refusedWrite(page, backend);
      await expect(page.locator("#notice")).toHaveText(MEANWHILE);
      await expect(bar(page).locator(".closed-note")).toHaveCount(0);
    });

    test("if /me no longer lists the team, says to reload", async ({ page }) => {
      const backend = await open(page, new FakeBackend());
      backend.on("GET", "/me", { status: 200, body: { user: USER, teams: [], invites: [] } });
      await refusedWrite(page, backend);
      await expect(page.locator("#notice")).toHaveText(MEANWHILE);
      await expect(bar(page).locator(".closed-note")).toHaveCount(0);
    });
  });
});

test.describe("deleting an account", { tag: ["@J11.1"] }, () => {
  test("from the team bar: typed DELETE, the server's reason when it refuses, then signed out for good", { tag: ["@J11.2"] }, async ({ page }) => {
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
