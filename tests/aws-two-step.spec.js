// Two-step sign-in in the web build (src/aws/mfa.js, delete-account.js, account.js): Account
// says whether it's on and sets it up, and billing refused for want of it opens the setup,
// against the fake backend in tests/fake-aws.js. The server's side is in
// backend/test/account-api.test.ts and billing-api.test.ts (supply-checkout-8jc.12).
import { test, expect, modalViolations } from "./helpers.js";
import { FakeBackend, TEAM, USER, ORIGIN, AUTH, openAws, connected } from "./fake-aws.js";

test.use({ reducedMotion: "reduce" });

const PORTAL = "/teams/t1/billing/portal";
const CHECKOUT = "/teams/t1/billing/checkout";
const PAYING = { plan: "starter", status: "active", billingAccount: true };
const SECRET = "JBSWY3DPEHPK3PXP";
const bar = (page) => page.locator(".teambar");
const dialog = (page) => page.locator("#modal");
const fail = (page) => dialog(page).locator("#twoStepFail");
const error = (status, code, extra = {}) => ({ status, body: { error: { code, message: code, ...extra } } });

async function open(page, backend) {
  await openAws(page, backend);
  await connected(page);
  return backend;
}

async function expectAccessible(page) {
  expect(await modalViolations(page)).toEqual([]);
}

test("an owner sets a password and an authenticator app up from Account, and signs in again", { tag: ["@J0"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend({ user: { ...USER, mfa: "off" } }));
  await bar(page).getByRole("button", { name: "Account" }).click();
  await expect(dialog(page).locator("#twoStepState")).toHaveText("Owners need two-step sign-in to manage billing. You'll sign in with a password and a code from an authenticator app on your phone.");
  await dialog(page).getByRole("button", { name: "Set up two-step sign-in" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Two-step sign-in" })).toBeVisible();
  await expect(dialog(page).getByLabel("New password")).toBeFocused();
  await expectAccessible(page);

  // Nothing typed; a password the policy refuses; a wrong current one; a lost answer
  const next = dialog(page).getByRole("button", { name: "Continue" });
  await next.click();
  await expect(fail(page)).toHaveText("Choose a password.");
  await dialog(page).getByLabel("New password").fill("short");
  await next.click();
  await expect(fail(page)).toHaveText("Choose a password of at least 12 characters, with upper and lower case letters, a number and a symbol.");
  await dialog(page).getByLabel("New password").fill("Correct-Horse-9");
  await dialog(page).getByLabel("Current password").fill("wrong");
  await next.click();
  await expect(fail(page)).toHaveText("That current password isn't right. If you've only signed in with an email code or a passkey, leave it empty.");
  await dialog(page).getByLabel("Current password").fill("");
  backend.on("POST", "/me/password", { abort: true });
  await next.click();
  await expect(fail(page)).toHaveText("Couldn't set the password. Check your connection and try again.");
  await next.click();
  // Wait for the retry to be sent: Firefox can still be sending it when the click returns
  await expect.poll(() => backend.requests("POST", "/me/password").map((c) => c.body)).toEqual([
    { password: "short" },
    { password: "Correct-Horse-9", currentPassword: "wrong" },
    { password: "Correct-Horse-9" },
    { password: "Correct-Horse-9" },
  ]);

  // The app's secret, as a QR code, a key and a link
  const code = dialog(page).getByLabel("Code from the app");
  await expect(code).toBeFocused();
  await expect(fail(page)).toBeHidden();
  await expect(dialog(page).locator("#totpKey")).toHaveText("JBSW Y3DP EHPK 3PXP");
  await expect(dialog(page).getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  await expect(dialog(page).getByRole("link", { name: "Open in an authenticator app on this device" })).toHaveAttribute("href", `otpauth://totp/Supply%20Checkout%3Apat%40example.com?secret=${SECRET}&issuer=Supply+Checkout`);
  await expectAccessible(page);

  // A code that isn't six digits isn't sent; a wrong one; then the right one
  const turnOn = dialog(page).getByRole("button", { name: "Turn on" });
  await code.fill("12345");
  await turnOn.click();
  await expect(fail(page)).toHaveText("Enter the 6-digit code from the app.");
  await code.fill("111 111");
  await turnOn.click();
  await expect(fail(page)).toHaveText("That code isn't right. Check the app and try the newest code.");
  await code.fill("654 321");
  await turnOn.click();
  await expect(page.getByRole("heading", { name: "Two-step sign-in is on" })).toBeVisible();
  await expect(page.locator("#overlay")).toBeHidden();
  expect(backend.requests("POST", "/me/mfa/totp/verify").map((c) => c.body)).toEqual([{ code: "111111" }, { code: "654321" }]);
  // Signed out of Managed Login too; the team and the owner mark are kept for the same person
  expect(await page.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toMatch(/^https:\/\/auth\.supply-checkout\.test\/logout\?/);
  expect(await page.evaluate(() => [localStorage.getItem("supplyCheckout.team"), localStorage.getItem("supplyCheckout.owner")])).toEqual(["t1", USER.id]);
});

test("billing refused for want of two-step sign-in opens the setup, saying why", { tag: ["@J0", "@J7"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING }], user: { ...USER, mfa: "off" } }));
  backend.on("POST", PORTAL, error(403, "permission_denied", { reason: "mfa_required" }));
  await bar(page).getByRole("button", { name: "Billing" }).click();
  await expect(dialog(page).locator(".two-step-why")).toHaveText("To manage billing, turn on two-step sign-in first. It keeps someone who gets hold of your email from changing how your team pays.");
  await expect(page.locator("#toast")).toBeHidden();
  await expect(bar(page).getByRole("button", { name: "Billing" })).toBeEnabled();
  // Keeping the current password goes straight to the app; a setup that can't start says so
  backend.on("POST", "/me/mfa/totp", { abort: true });
  await dialog(page).getByRole("button", { name: "Keep my current password" }).click();
  await expect(fail(page)).toHaveText("Couldn't start the setup. Check your connection and try again.");
  await expect(dialog(page).getByLabel("New password")).toBeVisible();
  await dialog(page).getByRole("button", { name: "Keep my current password" }).click();
  await expect(dialog(page).getByLabel("Code from the app")).toBeFocused();
  expect(backend.requests("POST", "/me/password")).toEqual([]);
  // Cancel leaves everything as it was
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#overlay")).toBeHidden();
});

test("billing refused for a session from before two-step sign-in asks to sign in again, keeping the team and drafts", { tag: ["@J0", "@J7"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING }], user: { ...USER, mfa: "totp" } }));
  await page.evaluate(() => localStorage.setItem("supplyCheckout.receiptDraft.t1", JSON.stringify({ vendor: "Costco", items: [] })));
  backend.on("POST", PORTAL, error(403, "permission_denied", { reason: "mfa_sign_in_again" }));
  await bar(page).getByRole("button", { name: "Billing" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Sign in again" })).toBeVisible();
  await expect(dialog(page).getByText("To manage billing, sign in again with your email, your password and a code from your authenticator app. This session began before two-step sign-in was turned on.")).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "Sign in again" })).toBeFocused();
  await expect(page.locator("#toast")).toBeHidden();
  await expectAccessible(page);
  // Cancel leaves everything as it was
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#overlay")).toBeHidden();
  expect(backend.requests("POST", "/auth/sign-out")).toEqual([]);
  // The API can't be reached: still signed in, and says so
  backend.on("POST", PORTAL, error(403, "permission_denied", { reason: "mfa_sign_in_again" }));
  await bar(page).getByRole("button", { name: "Billing" }).click();
  backend.on("POST", "/auth/sign-out", { abort: true });
  await dialog(page).getByRole("button", { name: "Sign in again" }).click();
  await expect(page.locator("#toast")).toHaveText("Couldn't sign out. Try again.");
  expect(backend.authRequests).toEqual([]);
  // Signed out here and of Managed Login, whose session would otherwise sign straight back in
  await dialog(page).getByRole("button", { name: "Sign in again" }).click();
  await expect.poll(() => backend.authRequests).toEqual([`${AUTH}/logout?client_id=test-client&logout_uri=${encodeURIComponent(ORIGIN + "/")}`]);
  expect(backend.requests("POST", "/auth/sign-out")).toHaveLength(2);
  expect(await page.evaluate(() => ["supplyCheckout.team", "supplyCheckout.owner", "supplyCheckout.receiptDraft.t1"].map((k) => localStorage.getItem(k) !== null))).toEqual([true, true, true]);
});

test("invoices refused for a session from before two-step sign-in ask to sign in again", { tag: ["@J7.3"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING }], user: { ...USER, mfa: "totp" } }));
  backend.on("GET", "/teams/t1/billing/invoices", error(403, "permission_denied", { reason: "mfa_sign_in_again" }));
  await bar(page).getByRole("button", { name: "Invoices" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Sign in again" })).toBeVisible();
  await expect(dialog(page).locator("#invoiceList")).toHaveCount(0);
});

test("an owner subscribing again without two-step sign-in is sent to set it up", { tag: ["@J0", "@J7"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, status: "canceled", plan: "starter", subscriptionEnded: true }], user: { ...USER, mfa: "off" } }));
  backend.on("POST", CHECKOUT, error(403, "permission_denied", { reason: "mfa_required" }));
  await bar(page).getByRole("button", { name: "Subscribe" }).click();
  await expect(dialog(page).locator(".two-step-why")).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Subscribe" })).toBeEnabled();
});

test("with it on, Account offers to move it to a new phone, with no password step", { tag: ["@J0"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend({ user: { ...USER, mfa: "totp" } }));
  await bar(page).getByRole("button", { name: "Account" }).click();
  await expect(dialog(page).locator("#twoStepState")).toHaveText("Two-step sign-in is on: signing in with your email takes your password and a code from your authenticator app.");
  await dialog(page).getByRole("button", { name: "Move to a new phone" }).click();
  await expect(dialog(page).getByText("Set up the authenticator app on your new phone. Your old phone's codes keep working until this is done.")).toBeVisible();
  await expect(dialog(page).getByLabel("Code from the app")).toBeFocused();
  await expect(dialog(page).getByLabel("New password")).toBeHidden();
  await expect(dialog(page).getByRole("heading", { name: "Your authenticator app" })).toBeVisible();
  // A setup that expired meanwhile, and too many tries
  backend.totpStarted = false;
  await dialog(page).getByLabel("Code from the app").fill("654321");
  await dialog(page).getByRole("button", { name: "Turn on" }).click();
  await expect(fail(page)).toHaveText("This setup expired. Close this and start again.");
  backend.on("POST", "/me/mfa/totp/verify", error(429, "quota_exceeded"));
  await dialog(page).getByRole("button", { name: "Turn on" }).click();
  await expect(fail(page)).toHaveText("Too many tries for now. Wait a few minutes, then try again.");
});

test("when it's on but the other sessions weren't signed out, the dialog finishes that", { tag: ["@J0"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend({ user: { ...USER, mfa: "totp" } }));
  await bar(page).getByRole("button", { name: "Account" }).click();
  await dialog(page).getByRole("button", { name: "Move to a new phone" }).click();
  backend.on("POST", "/me/mfa/totp/verify", error(503, "internal", { reason: "signout_failed" }));
  await dialog(page).getByLabel("Code from the app").fill("654321");
  await dialog(page).getByRole("button", { name: "Turn on" }).click();
  await expect(fail(page)).toHaveText("Two-step sign-in is on, but your other sessions weren't signed out yet. Sign out everywhere to finish.");
  const finish = dialog(page).getByRole("button", { name: "Sign out everywhere" });
  await expect(finish).toBeFocused();
  await expect(dialog(page).getByLabel("Code from the app")).toBeHidden();
  await expect(dialog(page).getByRole("button", { name: "Cancel" })).toBeHidden();
  backend.on("POST", "/me/sign-out-everywhere", error(503, "internal", { reason: "signout_failed" }));
  await finish.click();
  await expect(fail(page)).toHaveText("Couldn't sign you out everywhere. Check your connection and try again.");
  await finish.click();
  await expect(page.getByRole("heading", { name: "Two-step sign-in is on" })).toBeVisible();
  expect(backend.requests("POST", "/me/sign-out-everywhere").map((c) => c.body ?? null)).toEqual([null, null]);
});

test("moving to a new phone that can't start says so", { tag: ["@J0"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend({ user: { ...USER, mfa: "totp" } }));
  backend.on("POST", "/me/mfa/totp", { abort: true });
  await bar(page).getByRole("button", { name: "Account" }).click();
  await dialog(page).getByRole("button", { name: "Move to a new phone" }).click();
  await expect(fail(page)).toHaveText("Couldn't start the setup. Check your connection and try again.");
  await expect(dialog(page).getByLabel("New password")).toBeHidden();
});

test("a Google or Apple user has nothing to set up", { tag: ["@J0"] }, async ({ page }) => {
  await open(page, new FakeBackend({ user: { ...USER, mfa: "provider" } }));
  await bar(page).getByRole("button", { name: "Account" }).click();
  await expect(dialog(page).locator("#twoStepState")).toHaveText("You sign in with Google or Apple, which covers two-step sign-in here.");
  await expect(dialog(page).getByRole("button", { name: /two-step|new phone/ })).toHaveCount(0);
});

test("an API that doesn't say shows nothing about it", { tag: ["@J0"] }, async ({ page }) => {
  await open(page, new FakeBackend());
  await bar(page).getByRole("button", { name: "Account" }).click();
  await expect(dialog(page).getByLabel("Type DELETE to confirm")).toBeFocused();
  await expect(dialog(page).locator("#twoStepState")).toHaveCount(0);
});
