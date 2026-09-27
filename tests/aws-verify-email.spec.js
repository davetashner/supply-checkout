// Verifying the signed-in user's email address in the web build (src/aws/verify-email.js):
// the prompt on the account screens and the team bar, sending a code, entering it, Cognito's
// refusals, the resend countdown, and the refresh and /me that confirm it, against the fake
// backend in tests/fake-aws.js. The server's side is in backend/test/account-api.test.ts
// and account-db.test.ts.
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./helpers.js";
import { currentBuild } from "../scripts/builds.mjs";
import { usedState } from "./fixtures.js";
import { FakeBackend, USER, openAws, connected } from "./fake-aws.js";

test.skip(currentBuild() !== "web", "The AWS runtime is only in the web build");
// The modal's entrance animation fades it in; axe must see its final colors
test.use({ reducedMotion: "reduce" });

const UNVERIFIED = { ...USER, emailVerified: false };
const INVITE = { id: "i1", teamName: "Bravo Co", role: "contributor", expiresAt: "2026-10-03T12:00:00.000Z" };
const inviteLink = { session: { "supplyCheckout.invite": JSON.stringify({ id: "i1", token: "tok" }) } };
const seeded = Object.fromEntries(Object.entries(usedState.seed).map(([k, v]) => [`t1/${k}`, v]));
const account = (page) => page.locator("#account");
const dialog = (page) => page.locator("#modal");
const fail = (page) => page.locator("#verifyFail");
const error = (status, code, reason) => ({ status, body: { error: { code, message: code, ...(reason ? { reason } : {}) } } });

async function expectAccessible(page) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function sendCode(page) {
  await dialog(page).getByRole("button", { name: "Send code" }).click();
  await expect(dialog(page).getByLabel("Code from the email")).toBeFocused();
}

async function enter(page, code) {
  await dialog(page).getByLabel("Code from the email").fill(code);
  await dialog(page).getByRole("button", { name: "Verify" }).click();
}

test("an unverified user verifies their email before naming a team, and then sees their invites", async ({ page }) => {
  const backend = new FakeBackend({ teams: [], user: UNVERIFIED });
  backend.pendingInvites = [INVITE];
  await openAws(page, backend);
  await expect(account(page).getByRole("heading", { name: "Name your team" })).toBeVisible();
  await expect(account(page)).toContainText("Your email address, pat@example.com, isn't verified yet.");
  await account(page).getByRole("button", { name: "Verify email" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Verify your email address" })).toBeVisible();
  await expect(dialog(page)).toContainText("We'll email a 6-digit code to pat@example.com.");
  await expectAccessible(page);

  await sendCode(page);
  expect(backend.requests("POST", "/me/email/code")).toHaveLength(1);
  expect(backend.requests("POST", "/me/email/code")[0].headers.authorization).toBe("Bearer at-1");
  await expect(dialog(page)).toContainText("We sent a code to pat@example.com.");
  await expect(dialog(page).getByRole("button", { name: /Resend code in \d+s/ })).toBeDisabled();

  // A wrong code says so, and nothing changes
  await enter(page, "111111");
  await expect(fail(page)).toHaveText("That code isn't right. Check the email and try again.");
  expect(backend.user.emailVerified).toBe(false);

  // The right one, typed with a space: new tokens, then /me, then it says so
  await enter(page, "123 456");
  await expect(dialog(page).locator("#verifyDone")).toHaveText("pat@example.com is verified.");
  await expect(fail(page)).toBeHidden();
  expect(backend.requests("POST", "/me/email/verify").map((c) => c.body)).toEqual([{ code: "111111" }, { code: "123456" }]);
  expect(backend.requests("POST", "/auth/refresh")).toHaveLength(2);
  expect(backend.requests("GET", "/me")).toHaveLength(2);
  // The screen behind starts again with the new /me: the invite is listed, the prompt gone,
  // and the modal keeps the focus
  await expect(account(page)).toContainText("Bravo Co invited you as a contributor.");
  await expect(account(page).locator("#verifyPrompt")).toBeHidden();
  const done = dialog(page).getByRole("button", { name: "Done" });
  await expect(done).toBeFocused();
  await expectAccessible(page);
  await done.click();
  await expect(page.locator("#overlay")).toBeHidden();
  // Neither the code nor the token is kept anywhere
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/123456|"at-\d"/);
});

test("explains a short, expired or refused code, too many tries, and a lost connection", async ({ page }) => {
  const backend = new FakeBackend({ teams: [], user: UNVERIFIED });
  backend.on("POST", "/me/email/code", error(429, "quota_exceeded"));
  backend.on("POST", "/me/email/code", { abort: true });
  await openAws(page, backend);
  await account(page).getByRole("button", { name: "Verify email" }).click();
  const send = dialog(page).getByRole("button", { name: "Send code" });
  await send.click();
  await expect(fail(page)).toHaveText("Too many tries for now. Wait a few minutes, then try again.");
  await send.click();
  await expect(fail(page)).toHaveText("Couldn't send the code. Check your connection and try again.");
  await sendCode(page);
  await expect(fail(page)).toBeHidden();

  await enter(page, "123");
  await expect(fail(page)).toHaveText("Enter the 6-digit code from the email.");
  expect(backend.requests("POST", "/me/email/verify")).toHaveLength(0);

  for (const [answer, text] of [
    [error(400, "bad_request", "code_expired"), "That code has expired. Send a new one."],
    [error(409, "aborted", "email_in_use"), "Another account already uses this email address, so it can't be verified here."],
    [error(429, "quota_exceeded"), "Too many tries for now. Wait a few minutes, then try again."],
    [{ abort: true }, "Couldn't check the code. Check your connection and try again."],
  ]) {
    backend.on("POST", "/me/email/verify", answer);
    await enter(page, "123456");
    await expect(fail(page)).toHaveText(text);
  }
  expect(backend.user.emailVerified).toBe(false);
  await enter(page, "123456");
  await expect(dialog(page).locator("#verifyDone")).toBeVisible();
});

test("an address that changed while a code was sent starts over at sending, with the new address", async ({ page }) => {
  const backend = new FakeBackend({ teams: [], user: UNVERIFIED });
  backend.rewriteEmail = "pat.lee@example.com";
  await openAws(page, backend);
  await account(page).getByRole("button", { name: "Verify email" }).click();
  const send = dialog(page).getByRole("button", { name: "Send code" });
  await send.click();
  await expect(fail(page)).toHaveText("Your email address changed; send a new code.");
  await expect(dialog(page)).toContainText("We'll email a 6-digit code to pat.lee@example.com.");
  await expect(dialog(page).getByLabel("Code from the email")).toBeHidden();
  await expect(send).toBeFocused();
  expect(backend.requests("GET", "/me")).toHaveLength(2);
  await expectAccessible(page);

  // Sending again works, for the new address, and its code verifies it
  await sendCode(page);
  await expect(fail(page)).toBeHidden();
  await expect(dialog(page)).toContainText("We sent a code to pat.lee@example.com.");
  await enter(page, "123456");
  await expect(dialog(page).locator("#verifyDone")).toHaveText("pat.lee@example.com is verified.");
  expect(backend.user).toMatchObject({ email: "pat.lee@example.com", emailVerified: true });
});

test("a code checked after the address changed starts over at sending, and the countdown is dropped", async ({ page }) => {
  await page.clock.install();
  const backend = new FakeBackend({ teams: [], user: UNVERIFIED });
  await openAws(page, backend);
  await account(page).getByRole("button", { name: "Verify email" }).click();
  await sendCode(page);
  await expect(dialog(page).getByRole("button", { name: "Resend code in 60s" })).toBeDisabled();
  // A provider rewrote the address after the code was sent
  backend.user = { ...UNVERIFIED, email: "pat.lee@example.com" };
  await enter(page, "123456");
  await expect(fail(page)).toHaveText("Your email address changed; send a new code.");
  const send = dialog(page).getByRole("button", { name: "Send code", exact: true });
  await expect(send).toBeEnabled();
  await expect(send).toBeFocused();
  await expect(dialog(page)).toContainText("We'll email a 6-digit code to pat.lee@example.com.");
  await expect(dialog(page).getByLabel("Code from the email")).toBeHidden();
  await page.clock.runFor(5e3);
  await expect(send).toHaveText("Send code");
  expect(backend.user.emailVerified).toBe(false);

  // The old code is spent; a new one for the new address verifies it
  await sendCode(page);
  await expect(dialog(page).getByLabel("Code from the email")).toHaveValue("");
  await enter(page, "123456");
  await expect(dialog(page).locator("#verifyDone")).toHaveText("pat.lee@example.com is verified.");
  expect(backend.requests("POST", "/me/email/verify")).toHaveLength(2);
});

test("an address change still starts over when /me can't be loaded, keeping the address shown", async ({ page }) => {
  const backend = new FakeBackend({ teams: [], user: UNVERIFIED });
  await openAws(page, backend);
  await account(page).getByRole("button", { name: "Verify email" }).click();
  await sendCode(page);
  backend.on("POST", "/me/email/verify", error(409, "aborted", "email_changed"));
  backend.on("GET", "/me", { abort: true });
  await enter(page, "123456");
  await expect(fail(page)).toHaveText("Your email address changed; send a new code.");
  await expect(dialog(page)).toContainText("We'll email a 6-digit code to pat@example.com.");
  await sendCode(page);
  await enter(page, "123456");
  await expect(dialog(page).locator("#verifyDone")).toHaveText("pat@example.com is verified.");
});

test("a new code can be asked for once a minute", async ({ page }) => {
  await page.clock.install();
  const backend = new FakeBackend({ teams: [], user: UNVERIFIED });
  await openAws(page, backend);
  await account(page).getByRole("button", { name: "Verify email" }).click();
  await sendCode(page);
  await expect(dialog(page).getByRole("button", { name: "Resend code in 60s" })).toBeDisabled();
  await page.clock.runFor(30e3);
  await expect(dialog(page).getByRole("button", { name: "Resend code in 30s" })).toBeDisabled();
  await page.clock.runFor(31e3);
  const resend = dialog(page).getByRole("button", { name: "Resend code", exact: true });
  await expect(resend).toBeEnabled();
  await resend.click();
  await expect(dialog(page).getByRole("button", { name: "Resend code in 60s" })).toBeDisabled();
  expect(backend.requests("POST", "/me/email/code")).toHaveLength(2);
  // Closed some other way, the countdown stops
  await page.keyboard.press("Escape");
  await expect(page.locator("#overlay")).toBeHidden();
  await page.clock.runFor(5e3);
  // And Cancel closes it too
  await account(page).getByRole("button", { name: "Verify email" }).click();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#overlay")).toBeHidden();
});

test("an address that was verified meanwhile is taken as done, whether sending or checking", async ({ page }) => {
  const backend = new FakeBackend({ teams: [], user: UNVERIFIED });
  await openAws(page, backend);
  await account(page).getByRole("button", { name: "Verify email" }).click();
  // Verified in another tab: asking for a code finds it done
  backend.user = { ...USER };
  await dialog(page).getByRole("button", { name: "Send code" }).click();
  await expect(dialog(page).locator("#verifyDone")).toHaveText("pat@example.com is verified.");
  expect(backend.requests("POST", "/me/email/code")).toHaveLength(1);
  await dialog(page).getByRole("button", { name: "Done" }).click();
  await expect(account(page).getByRole("button", { name: "Verify email" })).toBeHidden();
});

test("checking a code that another tab already used is taken as done", async ({ page }) => {
  const backend = new FakeBackend({ teams: [], user: UNVERIFIED });
  await openAws(page, backend);
  await account(page).getByRole("button", { name: "Verify email" }).click();
  await sendCode(page);
  backend.user = { ...USER };
  await enter(page, "123456");
  await expect(dialog(page).locator("#verifyDone")).toBeVisible();
});

test("a code accepted before the account catches up can be tried again", async ({ page }) => {
  const backend = new FakeBackend({ teams: [], user: UNVERIFIED });
  await openAws(page, backend);
  await account(page).getByRole("button", { name: "Verify email" }).click();
  await sendCode(page);
  // The refresh fails, then /me still says unverified (a linked user's trigger hadn't recorded it)
  backend.on("POST", "/auth/refresh", error(503, "internal"));
  backend.on("GET", "/me", { status: 200, body: { user: UNVERIFIED, teams: [], invites: [] } });
  await enter(page, "123456");
  const again = dialog(page).getByRole("button", { name: "Try again" });
  await expect(fail(page)).toHaveText("Your code was accepted, but your account hasn't caught up yet. Try again in a moment, or sign out and sign in again.");
  await again.click();
  await expect.poll(() => backend.requests("GET", "/me").length).toBe(2);
  await expect(fail(page)).toBeVisible();
  await again.click();
  await expect(dialog(page).locator("#verifyDone")).toBeVisible();
  await expect(again).toBeHidden();
  expect(backend.requests("POST", "/me/email/verify")).toHaveLength(1);
});

test("the team bar offers it while the team is open, and drops the button once verified", async ({ page }) => {
  const backend = new FakeBackend({ user: UNVERIFIED, docs: seeded });
  await openAws(page, backend);
  await connected(page);
  const verify = page.locator(".teambar").getByRole("button", { name: "Verify email" });
  await verify.click();
  await sendCode(page);
  await enter(page, "123456");
  await dialog(page).getByRole("button", { name: "Done" }).click();
  await expect(verify).toHaveCount(0);
  await expect(page.locator(".teambar")).toContainText("Team: Echo Cleaning");
});

test("a verified user sees no prompt", async ({ page }) => {
  const backend = new FakeBackend({ docs: seeded });
  await openAws(page, backend);
  await connected(page);
  await expect(page.getByRole("button", { name: "Verify email" })).toHaveCount(0);
});

test("joining from an invite link: verify first, then join", async ({ page }) => {
  const backend = new FakeBackend({ teams: [], user: UNVERIFIED });
  backend.pendingInvites = [INVITE];
  await openAws(page, backend, { storage: inviteLink });
  await expect(account(page).getByRole("heading", { name: "Join a team" })).toBeVisible();
  await account(page).getByRole("button", { name: "Verify email" }).click();
  await sendCode(page);
  await enter(page, "123456");
  // The screen starts again: now the invite is known by name
  await expect(account(page).getByRole("heading", { name: "Join Bravo Co" })).toBeVisible();
  await dialog(page).getByRole("button", { name: "Done" }).click();
  await account(page).getByRole("button", { name: "Join" }).click();
  await expect(page.locator(".teambar")).toContainText("Team: Bravo Co");
});

test("a join refused for an unverified email shows the prompt, when there's an address", async ({ page }) => {
  const backend = new FakeBackend({ teams: [], invites: [INVITE] });
  backend.on("POST", "/invites/i1/accept", error(403, "permission_denied"));
  await openAws(page, backend, { storage: inviteLink });
  const prompt = account(page).locator("#verifyPrompt");
  await expect(prompt).toBeHidden();
  await account(page).getByRole("button", { name: "Join" }).click();
  await expect(page.locator("#accountError")).toHaveText("Your email address isn't verified yet. Verify it, then join.");
  await expect(prompt).toBeVisible();
});

test("a join refused for a user with no address has nothing to verify", async ({ page }) => {
  const backend = new FakeBackend({ teams: [], user: { ...USER, email: null, emailVerified: false }, invites: [INVITE] });
  backend.on("POST", "/invites/i1/accept", error(403, "permission_denied"));
  await openAws(page, backend, { storage: inviteLink });
  await account(page).getByRole("button", { name: "Join" }).click();
  await expect(page.locator("#accountError")).toHaveText("Your email address isn't verified yet. Verify it, then join.");
  await expect(page.getByRole("button", { name: "Verify email" })).toHaveCount(0);
});
