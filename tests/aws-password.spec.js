// Changing the password from Account in the web build (src/aws/password.js, delete-account.js,
// account.js), against the fake backend in tests/fake-aws.js (supply-checkout-6uw.28). The
// server's side (POST /me/password and /me/sign-out-everywhere, and the security notice) is
// in backend/test/account-api.test.ts.
import { test, expect, modalViolations } from "./helpers.js";
import { FakeBackend, USER, openAws, connected } from "./fake-aws.js";

test.use({ reducedMotion: "reduce" });

const bar = (page) => page.locator(".teambar");
const dialog = (page) => page.locator("#modal");
const fail = (page) => dialog(page).locator("#passwordFail");
const error = (status, code, extra = {}) => ({ status, body: { error: { code, message: code, ...extra } } });
const NEW = "Correct-Horse-9";

async function openChange(page, user = { ...USER, mfa: "off" }) {
  const backend = new FakeBackend({ user });
  await openAws(page, backend);
  await connected(page);
  await bar(page).getByRole("button", { name: "Account" }).click();
  await dialog(page).getByRole("button", { name: "Change password" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Change password" })).toBeVisible();
  return backend;
}

async function fill(page, current, password = NEW, again = password) {
  await dialog(page).getByLabel("Current password").fill(current);
  await dialog(page).getByLabel("New password", { exact: true }).fill(password);
  await dialog(page).getByLabel("Confirm new password").fill(again);
}
const save = (page) => dialog(page).getByRole("button", { name: "Change password" }).click();

test("a signed-in user changes their password from Account, and is signed out everywhere", { tag: ["@J0"] }, async ({ page }) => {
  const backend = new FakeBackend({ user: { ...USER, mfa: "off" } });
  await openAws(page, backend);
  await connected(page);
  await bar(page).getByRole("button", { name: "Account" }).click();
  await expect(dialog(page).locator("#passwordState")).toHaveText("Change the password you sign in with, or set one if you've only signed in with an email code or a passkey.");
  await dialog(page).getByRole("button", { name: "Change password" }).click();

  // The current password first, then the new one twice, so a password manager reads it as a
  // change; the rules up front; signing out everywhere on by default
  await expect(dialog(page).getByLabel("Current password")).toBeFocused();
  expect(await dialog(page).locator("input[autocomplete]").evaluateAll((els) => els.map((e) => [e.name, e.autocomplete, e.required]))).toEqual([
    ["username", "username", false], ["current-password", "current-password", false], ["new-password", "new-password", false], ["confirm-password", "new-password", false],
  ]);
  await expect(dialog(page).getByText("At least 12 characters, with upper and lower case letters, a number and a symbol.")).toBeVisible();
  await expect(dialog(page).getByLabel("Sign out everywhere")).toBeChecked();
  expect(await modalViolations(page)).toEqual([]);

  // How to get in without the current password
  await dialog(page).getByText("Forgot your current password?").click();
  await expect(dialog(page).getByText("Sign out, then on the sign-in page choose to reset your password")).toBeVisible();

  await fill(page, "Old-Password-1");
  await save(page);
  await expect(page.getByRole("heading", { name: "Your password is changed" })).toBeVisible();
  await expect(page.getByText("You've been signed out everywhere, here too. Sign in again with your new password.")).toBeVisible();
  await expect(page.locator("#overlay")).toBeHidden();
  expect(backend.requests("POST", "/me/password").map((c) => c.body)).toEqual([{ password: NEW, currentPassword: "Old-Password-1" }]);
  expect(backend.requests("POST", "/me/sign-out-everywhere")).toHaveLength(1);
  // Signed out of Managed Login too; the team and the owner mark are kept for the same person
  expect(await page.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toMatch(/^https:\/\/auth\.supply-checkout\.test\/logout\?/);
  expect(await page.evaluate(() => [localStorage.getItem("supplyCheckout.team"), localStorage.getItem("supplyCheckout.owner")])).toEqual(["t1", USER.id]);
});

test("with signing out everywhere off, the user stays signed in", { tag: ["@J0"] }, async ({ page }) => {
  const backend = await openChange(page);
  await dialog(page).getByLabel("Sign out everywhere").uncheck();
  // Someone who has only used email codes or passkeys sets one, with no current password
  await fill(page, "");
  await save(page);
  await expect(page.locator("#toast")).toHaveText("Your password is changed.");
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(bar(page)).toBeVisible();
  expect(backend.requests("POST", "/me/password").map((c) => c.body)).toEqual([{ password: NEW }]);
  expect(backend.requests("POST", "/me/sign-out-everywhere")).toEqual([]);
});

test("what's wrong with a password change is said, and nothing is changed", { tag: ["@J0"] }, async ({ page }) => {
  const backend = await openChange(page);
  // Nothing typed; new passwords that don't match; one the policy refuses; a wrong current one
  await save(page);
  await expect(fail(page)).toHaveText("Choose a password.");
  await expect(dialog(page).getByLabel("New password", { exact: true })).toBeFocused();
  await fill(page, "Old-Password-1", NEW, "Correct-Horse-8");
  await save(page);
  await expect(fail(page)).toHaveText("The new passwords don't match. Type the new one again.");
  await expect(dialog(page).getByLabel("Confirm new password")).toBeFocused();
  await fill(page, "Old-Password-1", "short");
  await save(page);
  await expect(fail(page)).toHaveText("Choose a password of at least 12 characters, with upper and lower case letters, a number and a symbol.");
  await fill(page, "wrong");
  await save(page);
  await expect(fail(page)).toHaveText("That current password isn't right. If you've only signed in with an email code or a passkey, leave it empty.");
  expect(await modalViolations(page)).toEqual([]);
  // Too many tries; a Google or Apple account (the API refuses it); a lost answer
  backend.on("POST", "/me/password", error(429, "quota_exceeded"));
  await save(page);
  await expect(fail(page)).toHaveText("Too many tries for now. Wait a few minutes, then try again.");
  backend.on("POST", "/me/password", error(409, "aborted", { reason: "federated_sign_in" }));
  await save(page);
  await expect(fail(page)).toHaveText("You sign in with Google or Apple, so there's no Supply Checkout password to change.");
  backend.on("POST", "/me/password", { abort: true });
  await save(page);
  await expect(fail(page)).toHaveText("Couldn't change the password. Check your connection and try again.");
  await expect(dialog(page).getByRole("button", { name: "Change password" })).toBeEnabled();
  expect(backend.requests("POST", "/me/sign-out-everywhere")).toEqual([]);
  // Cancel leaves everything as it was
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#overlay")).toBeHidden();
});

test("with two-step sign-in on, the current password is required", { tag: ["@J0"] }, async ({ page }) => {
  const backend = await openChange(page, { ...USER, mfa: "totp" });
  await expect(dialog(page).getByLabel("Current password")).toHaveAttribute("required", "");
  await expect(dialog(page).getByText("The password you sign in with now.")).toBeVisible();
  await fill(page, "");
  await save(page);
  await expect(fail(page)).toHaveText("Enter your current password.");
  await expect(dialog(page).getByLabel("Current password")).toBeFocused();
  await fill(page, "wrong");
  await save(page);
  await expect(fail(page)).toHaveText("That current password isn't right.");
  expect(backend.requests("POST", "/me/password").map((c) => c.body)).toEqual([{ password: NEW, currentPassword: "wrong" }]);
});

test("when the other sessions couldn't be signed out, the dialog says the password changed and finishes that", { tag: ["@J0"] }, async ({ page }) => {
  const backend = await openChange(page);
  backend.on("POST", "/me/sign-out-everywhere", error(503, "internal", { reason: "signout_failed" }));
  await fill(page, "Old-Password-1");
  await save(page);
  await expect(fail(page)).toHaveText("Your password is changed, but you weren't signed out everywhere yet. Try again, or close this to stay signed in.");
  const finish = dialog(page).getByRole("button", { name: "Sign out everywhere" });
  await expect(finish).toBeFocused();
  await expect(dialog(page).getByLabel("Current password")).toBeHidden();
  await expect(dialog(page).getByRole("button", { name: "Close" })).toBeVisible();
  backend.on("POST", "/me/sign-out-everywhere", { abort: true });
  await finish.click();
  await expect(finish).toBeEnabled();
  await expect(fail(page)).toHaveText("Your password is changed, but you weren't signed out everywhere yet. Try again, or close this to stay signed in.");
  await finish.click();
  await expect(page.getByRole("heading", { name: "Your password is changed" })).toBeVisible();
  expect(backend.requests("POST", "/me/password")).toHaveLength(1);
  await expect.poll(() => backend.requests("POST", "/me/sign-out-everywhere").length).toBe(3);
});

test("a Google or Apple user sees a note instead of the form", { tag: ["@J0"] }, async ({ page }) => {
  await openAws(page, new FakeBackend({ user: { ...USER, mfa: "provider" } }));
  await connected(page);
  await bar(page).getByRole("button", { name: "Account" }).click();
  await expect(dialog(page).locator("#passwordState")).toHaveText("You sign in with Google or Apple, so there's no Supply Checkout password to change. Change your password with Google or Apple.");
  await expect(dialog(page).getByRole("button", { name: "Change password" })).toHaveCount(0);
});

test("Change password fits a 320px phone in dark mode", { tag: ["@J0"] }, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ colorScheme: "dark" });
  await openChange(page, { ...USER, email: "a-rather-long-address-for-a-small-screen@example.com", mfa: "off" });
  await dialog(page).getByText("Forgot your current password?").click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  expect(await modalViolations(page)).toEqual([]);
});
