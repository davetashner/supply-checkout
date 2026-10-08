// Resetting a forgotten password from the sign-in screen in the web build
// (src/aws/reset-password.js, account.js), against the fake backend in tests/fake-aws.js
// (supply-checkout-6uw.26). The server's side (the routes, the limits, the code or the help
// email) is in backend/test/password-reset.test.ts.
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./helpers.js";
import { FakeBackend, AUTH, openAws } from "./fake-aws.js";

const account = (page) => page.locator("#account");
const alert = (page) => page.locator("#accountError");
const status = (page) => page.locator("#resetStatus");
const PASSWORD = "Correct-Horse-9";

async function expectAccessible(page) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

// Signed out, on the reset screen
async function openReset(page) {
  const backend = new FakeBackend({ signedIn: false });
  await openAws(page, backend);
  await account(page).getByRole("button", { name: "Forgot your password?" }).click();
  await expect(account(page).getByRole("heading", { name: "Reset your password" })).toBeVisible();
  return backend;
}

async function askFor(page, email) {
  await account(page).getByLabel("Email address").fill(email);
  await account(page).getByRole("button", { name: "Send code" }).click();
  await expect(account(page).getByRole("heading", { name: "Check your email" })).toBeVisible();
}

async function fill(page, code, password = PASSWORD, again = password) {
  await account(page).getByLabel("Code from the email").fill(code);
  await account(page).getByLabel("New password", { exact: true }).fill(password);
  await account(page).getByLabel("Confirm new password").fill(again);
}
const save = (page) => account(page).getByRole("button", { name: "Set password" }).click();

test("someone who forgot their password asks for a code, sets a new one and signs in", { tag: ["@J0"] }, async ({ page }) => {
  const backend = await openReset(page);
  await expect(account(page).getByLabel("Email address")).toBeFocused();
  await expect(account(page).locator("#resetForm")).toHaveAttribute("method", "post");
  await expectAccessible(page);

  await askFor(page, "  pat@example.com ");
  expect(backend.requests("POST", "/auth/password-reset").map((c) => c.body)).toEqual([{ email: "pat@example.com" }]);
  // The same words whether or not there's an account, with what to try when no code comes
  await expect(account(page)).toContainText("If there's an account for pat@example.com, we've emailed it a code. The code works for an hour.");
  await expect(account(page).locator("#resetNothing")).toContainText("You may have signed up with a different email address, or with Google or Apple, or not have an account yet");
  const signUp = new URL(await account(page).getByRole("link", { name: "Sign in or create an account" }).getAttribute("href"));
  expect(signUp.origin + signUp.pathname).toBe(AUTH + "/oauth2/authorize");
  await expect(account(page).getByLabel("Code from the email")).toBeFocused();
  // A password manager sees whose password it is, and that it's a new one
  expect(await account(page).locator("input[autocomplete]").evaluateAll((els) => els.map((e) => [e.name, e.autocomplete]))).toEqual([
    ["username", "username"], ["code", "one-time-code"], ["new-password", "new-password"], ["confirm-password", "new-password"],
  ]);
  await expect(account(page).getByText("At least 12 characters, with upper and lower case letters, a number and a symbol.")).toBeVisible();
  await expectAccessible(page);

  await fill(page, " 123 456 ");
  await save(page);
  await expect(account(page).getByRole("heading", { name: "Your password is reset" })).toBeVisible();
  expect(backend.requests("POST", "/auth/password-reset/confirm").map((c) => c.body)).toEqual([{ email: "pat@example.com", code: "123456", password: PASSWORD }]);
  // Nothing keeps the password in the page
  expect(await page.locator("input[type=password]").count()).toBe(0);
  const link = account(page).getByRole("link", { name: "Sign in" });
  await expect(link).toBeFocused();
  const url = new URL(await link.getAttribute("href"));
  expect(url.origin + url.pathname).toBe(AUTH + "/oauth2/authorize");
  await link.click();
  await expect.poll(() => backend.authRequests).toEqual([url.href]);
});

test("an address that isn't one is refused before it's sent, and the API's refusal is shown", { tag: ["@J0"] }, async ({ page }) => {
  const backend = await openReset(page);
  await account(page).getByRole("button", { name: "Send code" }).click();
  await expect(alert(page)).toHaveText("Enter your email address, like name@example.com.");
  await expect(account(page).getByLabel("Email address")).toBeFocused();
  expect(backend.requests("POST", "/auth/password-reset")).toEqual([]);
  // One the app takes but the API doesn't
  backend.on("POST", "/auth/password-reset", { status: 400, body: { error: { code: "bad_request", message: "bad" } } });
  await account(page).getByLabel("Email address").fill("pat@example");
  await account(page).getByRole("button", { name: "Send code" }).click();
  await expect(alert(page)).toHaveText("Enter your email address, like name@example.com.");
  await expect(account(page).getByRole("button", { name: "Send code" })).toBeEnabled();
  // The API can't be reached
  backend.on("POST", "/auth/password-reset", { abort: true });
  await account(page).getByRole("button", { name: "Send code" }).click();
  await expect(alert(page)).toHaveText("Couldn't send that. Check your connection and try again.");
  await expect(account(page).getByRole("heading", { name: "Reset your password" })).toBeVisible();
});

test("the code and the new password are checked, and each refusal says what to do", { tag: ["@J0"] }, async ({ page }) => {
  const backend = await openReset(page);
  await askFor(page, "pat@example.com");
  const confirms = () => backend.requests("POST", "/auth/password-reset/confirm");

  await fill(page, "12345");
  await save(page);
  await expect(alert(page)).toHaveText("Enter the 6-digit code from the email.");
  await expect(account(page).getByLabel("Code from the email")).toBeFocused();
  await fill(page, "123456", "");
  await save(page);
  await expect(alert(page)).toHaveText("Choose a password.");
  await fill(page, "123456", PASSWORD, "Something-Else-1");
  await save(page);
  await expect(alert(page)).toHaveText("The new passwords don't match. Type the new one again.");
  await expect(account(page).getByLabel("Confirm new password")).toBeFocused();
  expect(confirms()).toEqual([]);

  await fill(page, "654321");
  await save(page);
  await expect(alert(page)).toHaveText("That code isn't right, or it has expired. Check the email, or send a new code.");
  await fill(page, "123456", "short");
  await save(page);
  await expect(alert(page)).toHaveText("Choose a password of at least 12 characters, with upper and lower case letters, a number and a symbol, that you haven't used before.");
  backend.on("POST", "/auth/password-reset/confirm", { status: 429, body: { error: { code: "quota_exceeded", message: "slow down" } } });
  await fill(page, "123456");
  await save(page);
  await expect(alert(page)).toHaveText("Too many tries for now. Wait a few minutes, then try again.");
  backend.on("POST", "/auth/password-reset/confirm", { abort: true });
  await save(page);
  await expect(alert(page)).toHaveText("Couldn't set the password. Check your connection and try again.");
  await expect(account(page).getByRole("button", { name: "Set password" })).toBeEnabled();
  expect(confirms()).toHaveLength(4);
});

test("a new code can be sent, and the way back leads to sign-in", { tag: ["@J0"] }, async ({ page }) => {
  const backend = await openReset(page);
  await askFor(page, "pat@example.com");
  await account(page).getByRole("button", { name: "Send a new code" }).click();
  await expect(status(page)).toHaveText("If there's an account for this address, we've emailed it a new code. Use the newest one.");
  expect(backend.requests("POST", "/auth/password-reset").map((c) => c.body)).toEqual([{ email: "pat@example.com" }, { email: "pat@example.com" }]);
  backend.on("POST", "/auth/password-reset", { abort: true });
  await account(page).getByRole("button", { name: "Send a new code" }).click();
  await expect(alert(page)).toHaveText("Couldn't send that. Check your connection and try again.");
  await expect(status(page)).toHaveText("");

  await account(page).getByRole("button", { name: "Back to sign in" }).click();
  await expect(account(page).getByRole("heading", { name: "Sign in" })).toBeVisible();
  await account(page).getByRole("button", { name: "Forgot your password?" }).click();
  await account(page).getByRole("button", { name: "Back to sign in" }).click();
  await expect(account(page).getByRole("link", { name: "Sign in" })).toBeVisible();
});

test("a sign-in that didn't finish says so until the person asks to reset their password", { tag: ["@J0"] }, async ({ page }) => {
  await openAws(page, new FakeBackend({ signedIn: false }), { path: "/?error=access_denied" });
  await expect(alert(page)).toHaveText("Sign-in didn't finish. Please try again.");
  await account(page).getByRole("button", { name: "Forgot your password?" }).click();
  await account(page).getByRole("button", { name: "Back to sign in" }).click();
  await expect(account(page).getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(alert(page)).toBeHidden();
});
