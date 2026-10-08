// The web build's members screen (src/aws/members.js): owners see the team's members and
// roles, change roles and remove members, and the last owner can't step down or leave,
// against the fake backend in tests/fake-aws.js. The server's side (the role checks and
// the atomic owner count) is tested in backend/test/members-api.test.ts and roles.test.ts.
import { test, expect, modalViolations } from "./helpers.js";
import { FakeBackend, TEAM, USER, openAws, connected } from "./fake-aws.js";

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

test("an owner sees the members and roles, changes a role and removes a member", { tag: ["@J3"] }, async ({ page }) => {
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
  expect(await modalViolations(page)).toEqual([]);

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

test("an owner stepping down or leaving starts again, since their access changed", { tag: ["@J3"] }, async ({ page }) => {
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

test("an owner leaving forgets the team", { tag: ["@J3"] }, async ({ page }) => {
  const backend = new FakeBackend({ members: { t1: [ME, { ...SAM, role: "owner" }] } });
  await openMembers(page, backend);
  await row(page, "pat@example.com").getByRole("button", { name: "Leave" }).click();
  await row(page, "pat@example.com").getByRole("button", { name: "Tap again to leave" }).click();
  await expect(page.locator("#account")).toContainText(`You left ${TEAM.name}.`);
  expect(backend.requests("DELETE", `${PATH}/${USER.id}`)).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.team"))).toBeNull();
});

test("says why a change was refused, and puts the role back", { tag: ["@J3"] }, async ({ page }) => {
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

test("says so when the members don't load", { tag: ["@J3"] }, async ({ page }) => {
  const backend = new FakeBackend({ members: { t1: [ME] } });
  backend.on("GET", PATH, error(500, "internal"));
  await openMembers(page, backend);
  await expect(fail(page)).toHaveText("Couldn't load the members. Check your connection and try again.");
  await expect(dialog(page).locator(".member")).toHaveCount(0);
});

test("only owners see Members", { tag: ["@J3"] }, async ({ page }) => {
  await openAws(page, new FakeBackend({ teams: [{ ...TEAM, role: "contributor" }] }));
  await connected(page);
  await expect(page.locator(".teambar")).toContainText("Team: Echo Cleaning");
  await expect(page.getByRole("button", { name: "Members" })).toHaveCount(0);
});

test("fits a 320px screen", { tag: ["@J3"] }, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openMembers(page, new FakeBackend({ members: { t1: [ME, { ...SAM, email: "a-very-long-address-for-someone@example.com" }] } }));
  await expect(dialog(page).locator(".member")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  expect(await page.locator("#modal").evaluate((m) => m.scrollWidth - m.clientWidth)).toBeLessThanOrEqual(0);
});

// supply-checkout-lx7: the name from each member's account, with their email under it
test("shows each member's name with their email, and names them in toasts", { tag: ["@J3"] }, async ({ page }) => {
  const backend = new FakeBackend({
    members: {
      t1: [
        { ...ME, name: "Pat Lee" },
        { ...SAM, name: "Sam <b>Ortiz</b>" },
        { userId: "u-named", name: "Nia Noemail", email: null, role: "viewer", joinedAt: JOINED },
        NOEMAIL,
      ],
    },
  });
  await openMembers(page, backend);
  await expect(dialog(page).locator(".member")).toHaveCount(4);
  const me = row(page, "Pat Lee");
  await expect(me).toContainText("(you)");
  await expect(me.locator(".member-email")).toHaveText("pat@example.com");
  // A name is text, never markup
  const sam = row(page, "Sam <b>Ortiz</b>");
  await expect(sam.locator("b")).toHaveCount(0);
  await expect(sam.locator(".member-email")).toHaveText("sam@example.com");
  await expect(row(page, "Nia Noemail").locator(".member-email")).toHaveText("No email address");
  // Without a name, the email as before
  await expect(row(page, "without an email").locator(".member-email")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Role for Sam <b>Ortiz</b>" })).toHaveValue("contributor");
  expect(await modalViolations(page)).toEqual([]);

  await sam.getByRole("combobox").selectOption("viewer");
  await expect(page.locator("#toast")).toHaveText("Sam <b>Ortiz</b> is now a viewer");
  await row(page, "Nia Noemail").getByRole("button", { name: "Remove" }).click();
  await row(page, "Nia Noemail").getByRole("button", { name: "Tap again to remove" }).click();
  await expect(page.locator("#toast")).toHaveText("Removed Nia Noemail from the team");
});

test("names fit a 320px screen in dark mode", { tag: ["@J3"] }, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ colorScheme: "dark" });
  const long = "Bartholomew-Alexander Wolfeschlegelsteinhausenbergerdorff Montgomery-Smythe";
  await openMembers(page, new FakeBackend({ members: { t1: [{ ...ME, name: "Pat Lee" }, { ...SAM, name: long, email: "a-very-long-address-for-someone@example.com" }] } }));
  await expect(row(page, long).locator(".member-email")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  expect(await page.locator("#modal").evaluate((m) => m.scrollWidth - m.clientWidth)).toBeLessThanOrEqual(0);
  expect(await modalViolations(page)).toEqual([]);
});

test.describe("seats", { tag: ["@J7.3"] }, () => {
  const DAY = 86400e3;
  const invite = (id, email, expiresIn, extra = {}) => ({ id, email, role: "contributor", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + expiresIn).toISOString(), inviteStatus: "pending", failureReason: null, failedAt: null, ...extra });
  const seats = (page) => dialog(page).locator("#seats");
  const send = (page) => dialog(page).getByRole("button", { name: "Send invite" });
  const full = (page) => dialog(page).locator("#teamFull");

  test("shows how many seats are used, and turns Send invite off once members and invites fill them", async ({ page }) => {
    const backend = new FakeBackend({
      teams: [{ ...TEAM, members: 2, memberCap: 4 }],
      members: { t1: [ME, SAM] },
      // An expired invite doesn't count; a failed one that hasn't expired does, as the server counts it
      teamInvites: { t1: [invite("inv-old", "old@example.com", -DAY, { inviteStatus: "expired" }), invite("inv-f", "bounced@example.com", DAY, { inviteStatus: "failed", failureReason: "bounced" })] },
    });
    await openMembers(page, backend);
    await expect(seats(page)).toHaveText("2 of 4 members");
    await expect(send(page)).toBeEnabled();
    await expect(full(page)).toBeHidden();
    expect(await modalViolations(page)).toEqual([]);

    await dialog(page).getByLabel("Email").fill("new@example.com");
    await send(page).click();
    await expect(page.locator("#toast")).toHaveText("Invite sent to new@example.com");
    // Two members and two invites waiting: full
    await expect(send(page)).toBeDisabled();
    await expect(full(page)).toHaveText("The team is full, counting invites waiting. Remove someone or revoke an invite to invite someone else.");
    await expect(seats(page)).toHaveText("2 of 4 members");

    // Removing a member makes room
    await row(page, "sam@example.com").getByRole("button", { name: "Remove" }).click();
    await row(page, "sam@example.com").getByRole("button", { name: "Tap again to remove" }).click();
    await expect(seats(page)).toHaveText("1 of 4 members");
    await expect(send(page)).toBeEnabled();
    await expect(full(page)).toBeHidden();
  });

  test("a team whose members fill it can't invite anyone until someone goes", async ({ page }) => {
    const backend = new FakeBackend({ teams: [{ ...TEAM, members: 2, memberCap: 2 }], members: { t1: [ME, SAM] }, teamInvites: { t1: [] } });
    await openMembers(page, backend);
    await expect(seats(page)).toHaveText("2 of 2 members");
    await expect(send(page)).toBeDisabled();
    await expect(full(page)).toBeVisible();
  });

  test("a closed team still shows its seats", async ({ page }) => {
    await openMembers(page, new FakeBackend({ teams: [{ ...TEAM, closedAt: "2026-09-26T12:00:00.000Z", deletesAt: "2026-10-26T12:00:00.000Z", memberCap: 10 }], members: { t1: [ME, SAM] } }));
    await expect(seats(page)).toHaveText("2 of 10 members");
  });

  test("asks /me for the cap each time the screen opens, so a plan change shows without a reload", async ({ page }) => {
    const backend = new FakeBackend({ teams: [{ ...TEAM, members: 2, memberCap: 2 }], members: { t1: [ME, SAM] }, teamInvites: { t1: [] } });
    await openMembers(page, backend);
    await expect(seats(page)).toHaveText("2 of 2 members");
    await expect(send(page)).toBeDisabled();
    const before = backend.requests("GET", "/me").length;
    await dialog(page).getByRole("button", { name: "Close", exact: true }).click();
    // The plan changed: more seats
    backend.teams[0].memberCap = 5;
    await page.locator(".teambar").getByRole("button", { name: "Members" }).click();
    await expect(seats(page)).toHaveText("2 of 5 members");
    await expect(send(page)).toBeEnabled();
    await expect(full(page)).toBeHidden();
    await expect.poll(() => backend.requests("GET", "/me").length).toBe(before + 1);
    expect(backend.pageLoads).toBe(1);
    await dialog(page).getByRole("button", { name: "Close", exact: true }).click();
    // A plan without a cap: no count
    delete backend.teams[0].memberCap;
    await page.locator(".teambar").getByRole("button", { name: "Members" }).click();
    await expect(dialog(page).locator(".member")).toHaveCount(2);
    await expect.poll(() => backend.requests("GET", "/me").length).toBe(before + 2);
    await expect(seats(page)).toBeHidden();
    await expect(send(page)).toBeEnabled();
  });

  test("a cap or members that arrive after the screen closed change nothing", async ({ page }) => {
    const backend = new FakeBackend({ teams: [{ ...TEAM, members: 2, memberCap: 4 }], members: { t1: [ME, SAM] }, teamInvites: { t1: [] } });
    await openAws(page, backend);
    await connected(page);
    const me = backend.hold("GET", "/me"), members = backend.hold("GET", PATH);
    await page.locator(".teambar").getByRole("button", { name: "Members" }).click();
    await expect(dialog(page).getByRole("heading", { name: "Members" })).toBeVisible();
    await expect.poll(() => backend.requests("GET", "/me").length + backend.requests("GET", PATH).length).toBe(2);
    await dialog(page).getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    // The page fixture fails the test on the uncaught error a missing seat count would throw
    me();
    members();
    await page.waitForTimeout(300);
    await expect(page.locator("#overlay")).toBeHidden();
    await expect(page.locator("#seats")).toHaveCount(0);
  });

  test("keeps the cap it has when /me doesn't load or doesn't list the team", async ({ page }) => {
    const backend = new FakeBackend({ teams: [{ ...TEAM, members: 2, memberCap: 4 }], members: { t1: [ME, SAM] }, teamInvites: { t1: [] } });
    await openAws(page, backend);
    await connected(page);
    backend.teams[0].memberCap = 9;
    let before = backend.requests("GET", "/me").length;
    backend.on("GET", "/me", { abort: true });
    await page.locator(".teambar").getByRole("button", { name: "Members" }).click();
    await expect(seats(page)).toHaveText("2 of 4 members");
    await expect.poll(() => backend.requests("GET", "/me").length).toBe(before + 1);
    await expect(seats(page)).toHaveText("2 of 4 members");
    await dialog(page).getByRole("button", { name: "Close", exact: true }).click();
    before = backend.requests("GET", "/me").length;
    backend.on("GET", "/me", { status: 200, body: { user: USER, teams: [], invites: [] } });
    await page.locator(".teambar").getByRole("button", { name: "Members" }).click();
    await expect.poll(() => backend.requests("GET", "/me").length).toBe(before + 1);
    await expect(dialog(page).locator(".member")).toHaveCount(2);
    await expect(seats(page)).toHaveText("2 of 4 members");
  });

  test("an API without the cap shows no count and leaves inviting to the server", async ({ page }) => {
    await openMembers(page, new FakeBackend({ members: { t1: [ME, SAM] } }));
    await expect(dialog(page).locator(".member")).toHaveCount(2);
    await expect(seats(page)).toBeHidden();
    await expect(send(page)).toBeEnabled();
  });
});

test.describe("support activity", () => {
  const SUPPORT = "/teams/t1/support-actions";
  const action = (n, act, extra = {}) => ({ eventId: `e${n}`, ts: new Date(Date.UTC(2026, 8, 20, 15, 4) - n * 3600e3).toISOString(), actor: "Supply Checkout support", action: act, ...extra });
  const list = (page) => dialog(page).locator("#supportList");
  const items = (page) => list(page).locator(".support-action");

  test("an owner sees what support did to the team, newest first, with why", async ({ page }) => {
    const backend = new FakeBackend({
      members: { t1: [ME] },
      supportActions: {
        t1: [
          action(0, "ops.comp.set", { reason: "Goodwill after the outage", before: null, after: { plan: "team", seats: null, until: "2026-12-31T12:00:00.000Z", reason: "Goodwill after the outage" } }),
          action(1, "ops.comp.set", { before: null, after: null }),
          action(2, "ops.comp.end", { reason: "Paid now" }),
          action(3, "ops.team.read", { reason: "Ticket 1234" }),
          action(4, "ops.import.clear", { reason: "Stuck import" }),
          action(5, "ops.something.new"),
          action(6, "ops.comp.discount", { before: { coupon: null }, after: { outcome: "applied", coupon: "supply-checkout-comp-2m", until: "2026-11-20T12:00:00.000Z", subscriptionId: "sub_1" } }),
          action(7, "ops.comp.discount", { before: { coupon: "supply-checkout-comp-2m" }, after: { outcome: "removed", coupon: null, until: null, subscriptionId: "sub_1" } }),
          action(8, "ops.comp.discount", { before: null, after: null }),
        ],
      },
    });
    await openMembers(page, backend);
    await expect(items(page)).toHaveCount(9);
    await expect(items(page).nth(0)).toContainText("Gave the team a free plan until Dec 31, 2026");
    await expect(items(page).nth(0)).toContainText("Reason: Goodwill after the outage");
    await expect(items(page).nth(1)).toContainText("Gave the team a free plan");
    await expect(items(page).nth(1)).not.toContainText("until");
    await expect(items(page).nth(1)).not.toContainText("Reason");
    await expect(items(page).nth(2)).toContainText("Ended the team's free plan");
    await expect(items(page).nth(3)).toContainText("Looked at the team's account");
    await expect(items(page).nth(3)).toContainText("Reason: Ticket 1234");
    await expect(items(page).nth(4)).toContainText("Cleared an import that didn't finish");
    await expect(items(page).nth(5)).toContainText("Changed the team's account");
    await expect(items(page).nth(6)).toContainText("Made the team's bills free for its free plan's months");
    await expect(items(page).nth(7)).toContainText("Took the free plan's discount off the team's bills");
    await expect(items(page).nth(8)).toContainText("Checked the team's bills for its free plan");
    await expect(items(page).nth(0)).toContainText("2026");
    await expect(dialog(page).getByRole("button", { name: "Show more" })).toBeHidden();
    expect(backend.requests("GET", SUPPORT).map((c) => c.query)).toEqual([{ limit: "20" }]);
    expect(await modalViolations(page)).toEqual([]);
  });

  test("shows more a page at a time, and says so when a page doesn't load", async ({ page }) => {
    const backend = new FakeBackend({ members: { t1: [ME] }, supportActions: { t1: Array.from({ length: 45 }, (_, i) => action(i, "ops.team.read")) } });
    await openMembers(page, backend);
    await expect(items(page)).toHaveCount(20);
    const more = dialog(page).getByRole("button", { name: "Show more" });
    backend.on("GET", SUPPORT, { abort: true });
    await more.click();
    await expect(dialog(page).locator("#supportFail")).toHaveText("Couldn't load what support did. Check your connection and try again.");
    // What was shown stays, and it can be tried again
    await expect(items(page)).toHaveCount(20);
    await more.click();
    await expect(items(page)).toHaveCount(40);
    await expect(dialog(page).locator("#supportFail")).toBeHidden();
    await more.click();
    await expect(items(page)).toHaveCount(45);
    await expect(more).toBeHidden();
    expect(backend.requests("GET", SUPPORT).map((c) => c.query.cursor)).toEqual([undefined, "20", "20", "40"]);
  });

  test("says when support hasn't done anything, or when it doesn't load, with Try again", async ({ page }) => {
    const backend = new FakeBackend({ members: { t1: [ME] } });
    backend.on("GET", SUPPORT, error(500, "internal"));
    await openMembers(page, backend);
    await expect(dialog(page).locator("#supportFail")).toHaveText("Couldn't load what support did. Check your connection and try again.");
    const retry = list(page).getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "Show more" })).toBeHidden();
    expect(await modalViolations(page)).toEqual([]);
    // Fails again: still offered
    backend.on("GET", SUPPORT, { abort: true });
    await retry.click();
    await expect(retry).toBeVisible();
    await expect.poll(() => backend.requests("GET", SUPPORT).length).toBe(2);
    await list(page).getByRole("button", { name: "Try again" }).click();
    await expect(list(page)).toHaveText("Supply Checkout support hasn't done anything to this team.");
    await expect(dialog(page).locator("#supportFail")).toBeHidden();
    await expect.poll(() => backend.requests("GET", SUPPORT).length).toBe(3);
    expect(backend.pageLoads).toBe(1);
  });

  test("Try again loads the first page and then pages on from it", async ({ page }) => {
    const backend = new FakeBackend({ members: { t1: [ME] }, supportActions: { t1: Array.from({ length: 25 }, (_, i) => action(i, "ops.team.read")) } });
    backend.on("GET", SUPPORT, { abort: true });
    await openMembers(page, backend);
    await list(page).getByRole("button", { name: "Try again" }).click();
    await expect(items(page)).toHaveCount(20);
    await dialog(page).getByRole("button", { name: "Show more" }).click();
    await expect(items(page)).toHaveCount(25);
    await expect.poll(() => backend.requests("GET", SUPPORT).map((c) => c.query.cursor)).toEqual([undefined, undefined, "20"]);
  });
});

// A team that's read-only for billing (its trial or subscription ended, or a payment is
// overdue, supply-checkout-qdx): owners can remove members, revoke invites and close it, but
// not invite anyone or change roles, and the screen says so rather than failing generically
test.describe("read-only for billing", { tag: ["@J3", "@J7"] }, () => {
  const ENDED = { status: "trialing", plan: "trial", subscriptionEnded: true, readOnlyReason: "trial_ended" };
  const pending = { id: "inv-1", email: "new@example.com", role: "contributor", createdAt: "2026-09-26T12:00:00.000Z", expiresAt: "2099-10-03T12:00:00.000Z", inviteStatus: "pending", failureReason: null, failedAt: null };
  const refused = (message) => error(403, "permission_denied", { reason: "subscription_ended", message });

  test("an owner can remove members and revoke invites, but not invite or change roles", async ({ page }) => {
    const backend = new FakeBackend({ teams: [{ ...TEAM, ...ENDED }], members: { t1: [ME, SAM] }, teamInvites: { t1: [pending] } });
    await openMembers(page, backend);
    await expect(dialog(page).locator("#endedMembers")).toHaveText("This team is read-only until an owner subscribes or pays: you can remove people, leave, revoke invites or close the team, but not invite anyone or change roles.");
    await expect(dialog(page).getByRole("button", { name: "Send invite" })).toBeHidden();
    await expect(row(page, "sam@example.com").getByRole("combobox")).toBeDisabled();
    const invite = dialog(page).locator(".invite-row");
    await expect(invite.getByRole("button", { name: "Resend" })).toHaveCount(0);
    await expect(dialog(page).getByRole("button", { name: "Close team" })).toBeVisible();
    expect(await modalViolations(page)).toEqual([]);
    await invite.getByRole("button", { name: "Revoke" }).click();
    await invite.getByRole("button", { name: "Tap again to revoke" }).click();
    await expect(page.locator("#toast")).toHaveText("Revoked the invite to new@example.com");
    await row(page, "sam@example.com").getByRole("button", { name: "Remove" }).click();
    await row(page, "sam@example.com").getByRole("button", { name: "Tap again to remove" }).click();
    await expect(page.locator("#toast")).toHaveText("Removed sam@example.com from the team");
  });

  test("an invite or role change refused because the team became read-only meanwhile says why", async ({ page }) => {
    const backend = new FakeBackend({ members: { t1: [ME, SAM] }, teamInvites: { t1: [] } });
    await openMembers(page, backend);
    const why = "This team's free trial ended, so it's read-only. An owner can subscribe to make changes.";
    backend.on("POST", "/teams/t1/invites", refused(why));
    await dialog(page).getByLabel("Email").fill("new@example.com");
    await dialog(page).getByRole("button", { name: "Send invite" }).click();
    await expect(dialog(page).locator("#invitesFail")).toHaveText(why);
    backend.on("PATCH", `${PATH}/u-sam`, refused(why));
    await row(page, "sam@example.com").getByRole("combobox").selectOption("viewer");
    await expect(fail(page)).toHaveText(why);
    await expect(row(page, "sam@example.com").getByRole("combobox")).toHaveValue("contributor");
  });
});
