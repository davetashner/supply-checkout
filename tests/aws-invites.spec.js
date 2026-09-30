// Invites on the web build's members screen (src/aws/members.js): owners invite an
// address with a role, see each invite as pending, failed ("Couldn't deliver", with why)
// or expired, and resend or revoke it, against the fake backend in tests/fake-aws.js.
// Joining from the emailed link is in tests/aws-account.spec.js; the server's side (the
// email, the single-use token, rate limits, the role checks) is in
// backend/test/invites-api.test.ts and roles.test.ts.
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./helpers.js";
import { currentBuild } from "../scripts/builds.mjs";
import { FakeBackend, USER, openAws, connected } from "./fake-aws.js";

test.skip(currentBuild() !== "web", "The AWS runtime is only in the web build");
// The modal's entrance animation fades it in; axe must see its final colors
test.use({ reducedMotion: "reduce" });

const PATH = "/teams/t1/invites";
const JOINED = "2026-09-01T00:00:00.000Z";
const ME = { userId: USER.id, email: USER.email, role: "owner", joinedAt: JOINED };
const SAM = { userId: "u-sam", email: "sam@example.com", role: "contributor", joinedAt: JOINED };
const NOEMAIL = { userId: "u-anon", email: null, role: "viewer", joinedAt: JOINED };
const invite = (id, email, extra = {}) => ({ id, email, role: "contributor", createdAt: "2026-09-26T12:00:00.000Z", expiresAt: "2026-10-03T12:00:00.000Z", inviteStatus: "pending", failureReason: null, failedAt: null, ...extra });
const failed = (id, email, failureReason) => invite(id, email, { inviteStatus: "failed", failureReason, failedAt: "2026-09-26T12:05:00.000Z" });
const dialog = (page) => page.locator("#modal");
const invites = (page) => dialog(page).locator(".invite-row");
const row = (page, text) => dialog(page).locator(".invite-row", { hasText: text });
const fail = (page) => page.locator("#invitesFail");
const error = (status, code, extra = {}) => ({ status, body: { error: { code, message: code, ...extra } } });

async function openInvites(page, backend) {
  await openAws(page, backend);
  await connected(page);
  await page.locator(".teambar").getByRole("button", { name: "Members" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Invite someone" })).toBeVisible();
  return backend;
}

async function sendInvite(page, email, role) {
  await dialog(page).getByLabel("Email").fill(email);
  if (role) await dialog(page).getByLabel("Role", { exact: true }).selectOption(role);
  await dialog(page).getByRole("button", { name: "Send invite" }).click();
}

test("an owner invites someone, resends the invite and revokes it", { tag: ["@J3.1"] }, async ({ page }) => {
  const backend = await openInvites(page, new FakeBackend({ members: { t1: [ME] } }));
  await expect(dialog(page).locator("#invitesList")).toHaveText("No invites waiting.");
  // Contributor is the default role
  await expect(dialog(page).getByLabel("Role", { exact: true })).toHaveValue("contributor");
  await sendInvite(page, "  Pat.Lee@Example.com ", "viewer");
  await expect(page.locator("#toast")).toHaveText("Invite sent to pat.lee@example.com");
  expect(backend.requests("POST", PATH).map((c) => c.body)).toEqual([{ email: "Pat.Lee@Example.com", role: "viewer" }]);
  await expect(invites(page)).toHaveCount(1);
  await expect(row(page, "pat.lee@example.com")).toContainText("as a viewer");
  await expect(row(page, "pat.lee@example.com")).toContainText("Pending, expires");
  // Ready for the next one
  await expect(dialog(page).getByLabel("Email")).toHaveValue("");
  await expect(dialog(page).getByRole("button", { name: "Send invite" })).toBeEnabled();

  await row(page, "pat.lee@example.com").getByRole("button", { name: "Resend" }).click();
  await expect(page.locator("#toast")).toHaveText("Invite sent to pat.lee@example.com");
  expect(backend.requests("POST", `${PATH}/inv-1/resend`)).toHaveLength(1);
  // The re-sent invite replaces the old one
  await expect(invites(page)).toHaveCount(1);
  await expect(page.locator('[data-invite="inv-2"]')).toBeVisible();

  // Revoking takes a second tap
  await row(page, "pat.lee@example.com").getByRole("button", { name: "Revoke" }).click();
  expect(backend.requests("DELETE", `${PATH}/inv-2`)).toHaveLength(0);
  await row(page, "pat.lee@example.com").getByRole("button", { name: "Tap again to revoke" }).click();
  await expect(invites(page)).toHaveCount(0);
  await expect(page.locator("#toast")).toHaveText("Revoked the invite to pat.lee@example.com");
  await expect(dialog(page).locator("#invitesList")).toHaveText("No invites waiting.");
  expect(backend.teamInvites.t1).toEqual([]);
});

test("shows each invite as pending, failed with why, or expired, and is accessible", { tag: ["@J3.1"] }, async ({ page }) => {
  const backend = new FakeBackend({
    members: { t1: [ME] },
    teamInvites: {
      t1: [
        invite("i-pending", "pending@example.com", { role: "owner" }),
        failed("i-bounced", "bounced@example.com", "bounced"),
        failed("i-spam", "spam@example.com", "complained"),
        failed("i-unsent", "unsent@example.com", "not_sent"),
        failed("i-unknown", "unknown@example.com", null),
        invite("i-expired", "expired@example.com", { inviteStatus: "expired", expiresAt: "2026-09-20T12:00:00.000Z" }),
      ],
    },
  });
  await openInvites(page, backend);
  await expect(invites(page)).toHaveCount(6);
  await expect(row(page, "pending@")).toContainText("as an owner");
  await expect(row(page, "pending@")).toContainText("Pending, expires Oct 3, 2026");
  await expect(row(page, "bounced@")).toContainText("Couldn't deliver. The address doesn't take mail. Check it, then revoke this invite and invite the right address.");
  await expect(row(page, "spam@")).toContainText("Couldn't deliver. They marked the invite as spam, so we won't email them again.");
  await expect(row(page, "unsent@")).toContainText("Couldn't deliver. The email couldn't be sent. Try Resend.");
  await expect(row(page, "unknown@")).toContainText("Couldn't deliver. Try Resend, or revoke it.");
  await expect(row(page, "expired@")).toContainText("Expired Sep 20, 2026. Resend it for a new link.");
  const { violations } = await new AxeBuilder({ page }).include("#modal").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
  // A failed invite re-sent is pending again
  await row(page, "bounced@").getByRole("button", { name: "Resend" }).click();
  await expect(row(page, "bounced@")).toContainText("Pending, expires");
  await expect(row(page, "bounced@")).not.toContainText("Couldn't deliver");
});

test("says when the invite email couldn't be sent, and shows the invite as failed", { tag: ["@J3.1"] }, async ({ page }) => {
  const backend = new FakeBackend({ members: { t1: [ME] } });
  backend.on("POST", PATH, { status: 201, body: { invite: failed("i-9", "pat@example.com", "not_sent") } });
  await openInvites(page, backend);
  await sendInvite(page, "pat@example.com");
  await expect(page.locator("#toast")).toHaveText("Couldn't send the invite to pat@example.com");
  await expect(row(page, "pat@example.com")).toContainText("Couldn't deliver. The email couldn't be sent. Try Resend.");
});

test("says why an invite was refused, and keeps what was typed", { tag: ["@J3.1"] }, async ({ page }) => {
  const backend = new FakeBackend({ members: { t1: [ME, SAM] }, teamInvites: { t1: [invite("i-1", "lee@example.com")] } });
  await openInvites(page, backend);
  const email = dialog(page).getByLabel("Email");
  // Checked before anything is sent
  for (const typed of ["", "   ", "not-an-address", "two words@example.com"]) {
    await sendInvite(page, typed);
    await expect(fail(page)).toHaveText("Enter an email address, like name@example.com.");
    await expect(email).toBeFocused();
  }
  expect(backend.requests("POST", PATH)).toHaveLength(0);
  // The server's own words for a member, or someone already invited
  await sendInvite(page, "sam@example.com");
  await expect(fail(page)).toHaveText("They're already a member of this team");
  await sendInvite(page, "lee@example.com");
  await expect(fail(page)).toHaveText("They already have an invite to this team. Resend it instead.");
  await expect(email).toHaveValue("lee@example.com");
  for (const [answer, text] of [
    [error(429, "quota_exceeded", { message: "limit" }), "You've sent as many invites as you can for now. Try again tomorrow."],
    // A full team: the server's words, which say how many members it can have
    [error(429, "quota_exceeded", { reason: "team_full", message: "This team can have 10 members, counting pending invites." }), "This team can have 10 members, counting pending invites."],
    [error(400, "bad_request"), "Enter an email address, like name@example.com."],
    [error(403, "permission_denied", { reason: "owners_only" }), "Only the team's owners can manage invites."],
    [{ abort: true }, "Couldn't send the invite. Check your connection and try again."],
  ]) {
    backend.on("POST", PATH, answer);
    await sendInvite(page, "quinn@example.com");
    await expect(fail(page)).toHaveText(text);
    await expect(dialog(page).getByRole("button", { name: "Send invite" })).toBeEnabled();
  }
  // One that goes clears the message
  await sendInvite(page, "quinn@example.com");
  await expect(fail(page)).toBeHidden();
  await expect(invites(page)).toHaveCount(2);
});

test("says why a resend or revoke didn't work", { tag: ["@J3.1"] }, async ({ page }) => {
  const backend = new FakeBackend({ members: { t1: [ME] }, teamInvites: { t1: [invite("i-1", "pat@example.com"), invite("i-2", "quinn@example.com")] } });
  await openInvites(page, backend);
  // A resend that fails for the connection leaves the invite, ready to try again
  backend.on("POST", `${PATH}/i-1/resend`, { abort: true });
  await row(page, "pat@").getByRole("button", { name: "Resend" }).click();
  await expect(fail(page)).toHaveText("Couldn't resend the invite. Check your connection and try again.");
  await expect(row(page, "pat@").getByRole("button", { name: "Resend" })).toBeEnabled();
  backend.on("POST", `${PATH}/i-1/resend`, error(429, "quota_exceeded"));
  await row(page, "pat@").getByRole("button", { name: "Resend" }).click();
  await expect(fail(page)).toHaveText("You've sent as many invites as you can for now. Try again tomorrow.");
  // Accepted or revoked meanwhile: it's gone from the list
  backend.on("POST", `${PATH}/i-1/resend`, error(404, "not_found"));
  await row(page, "pat@").getByRole("button", { name: "Resend" }).click();
  await expect(fail(page)).toHaveText("That invite was accepted or revoked just now.");
  await expect(row(page, "pat@")).toHaveCount(0);
  // A revoke that fails leaves it, and the button, where they were
  backend.on("DELETE", `${PATH}/i-2`, { abort: true });
  await row(page, "quinn@").getByRole("button", { name: "Revoke" }).click();
  await row(page, "quinn@").getByRole("button", { name: "Tap again to revoke" }).click();
  await expect(fail(page)).toHaveText("Couldn't revoke the invite. Check your connection and try again.");
  await expect(row(page, "quinn@").locator("[data-revoke]")).toBeEnabled();
});

test("says so when the invites don't load", { tag: ["@J3.1"] }, async ({ page }) => {
  const backend = new FakeBackend({ members: { t1: [ME] } });
  backend.on("GET", PATH, error(500, "internal"));
  await openInvites(page, backend);
  await expect(fail(page)).toHaveText("Couldn't load the invites. Check your connection and try again.");
  await expect(invites(page)).toHaveCount(0);
  // The members still show, and inviting still works
  await expect(dialog(page).locator(".member:not(.invite-row)")).toHaveCount(1);
  await sendInvite(page, "lee@example.com");
  await expect(invites(page)).toHaveCount(1);
});

test("removing a member drops their other invites from the list, as the server revokes them", { tag: ["@J3.1"] }, async ({ page }) => {
  const backend = new FakeBackend({
    members: { t1: [ME, SAM, NOEMAIL] },
    teamInvites: { t1: [invite("i-sam", "sam@example.com", { role: "owner" }), invite("i-lee", "lee@example.com")] },
  });
  await openInvites(page, backend);
  const member = (text) => dialog(page).locator(".member:not(.invite-row)", { hasText: text });
  await member("without an email").getByRole("button", { name: "Remove" }).click();
  await member("without an email").getByRole("button", { name: "Tap again to remove" }).click();
  await expect(page.locator("#toast")).toHaveText("Removed the member from the team");
  await expect(invites(page)).toHaveCount(2);
  await member("sam@example.com").getByRole("button", { name: "Remove" }).click();
  await member("sam@example.com").getByRole("button", { name: "Tap again to remove" }).click();
  await expect(page.locator("#toast")).toHaveText("Removed sam@example.com from the team");
  await expect(invites(page)).toHaveCount(1);
  await expect(row(page, "lee@example.com")).toBeVisible();
  expect(backend.teamInvites.t1.map((i) => i.id)).toEqual(["i-lee"]);
});

test("the invites fit a 320px screen", { tag: ["@J3.1"] }, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openInvites(page, new FakeBackend({ members: { t1: [ME] }, teamInvites: { t1: [failed("i-1", "a-very-long-address-for-someone@example.com", "bounced")] } }));
  await expect(invites(page)).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  expect(await page.locator("#modal").evaluate((m) => m.scrollWidth - m.clientWidth)).toBeLessThanOrEqual(0);
});
