// The prod journey suite's Managed Login steps (managedLogin in tests/prod/fixtures.mjs), on
// stand-ins for the shapes Managed Login's choice-based sign-in can take after the email: the
// password straight away (an account with MFA), a choice of sign-in method (radios, or buttons),
// a code sent by email with "Other sign-in options", and a page with no way to a password, which
// fails saying what the page showed, without any value typed into it.
import { expect, test } from "@playwright/test";
import { managedLogin } from "./prod/fixtures.mjs";

const account = { email: "crew.member@example.com", password: "not-a-real-password-1" };

// Each stand-in: the email page, then `after` (HTML) once Next is pressed. A password page records
// what was typed and the button pressed on it in window.done.
const passwordPage = `<h1>Enter your password</h1><label>Password <input type="password" id="pw"></label>
  <button type="button" aria-label="Show password">👁</button><a href="#">Forgot password?</a>
  <button type="button" onclick="window.done = document.getElementById('pw').value">Sign in</button>`;
const shapes = {
  "the password straight away": passwordPage,
  "a choice of radios, then Next": `<h1>Choose a sign-in method</h1><fieldset><legend>Sign in with</legend>
    <label><input type="radio" name="m" value="otp"> Email message</label>
    <label><input type="radio" name="m" value="pw"> Password</label></fieldset>
    <button type="button" onclick="if (document.querySelector('input[value=pw]').checked) show(window.passwordPage)">Next</button>`,
  "a choice of buttons": `<h1>Sign in</h1><button type="button">Email message</button>
    <button type="button" onclick="show(window.passwordPage)">Sign in with password</button>`,
  "a code by email first, other options behind a link": `<h1>Enter the code we emailed you</h1><label>Code <input id="code"></label>
    <a href="#" onclick="show('<h1>Other ways</h1><a href=&quot;#&quot; onclick=&quot;show(window.passwordPage)&quot;>Password</a>'); return false">Other sign-in options</a>`,
};

const standIn = (after) => `<!doctype html><title>Sign in</title><main id="m">
  <label>Email address <input type="email" id="email"></label>
  <button type="button" onclick="window.email = document.getElementById('email').value; show(window.after)">Next</button></main>
  <script>window.passwordPage = ${JSON.stringify(passwordPage)}; window.after = ${JSON.stringify(after)};
  function show(html) { setTimeout(() => { document.getElementById("m").innerHTML = html; }, 50); }</script>`;

for (const [shape, after] of Object.entries(shapes)) {
  test(`managedLogin reaches the password from ${shape}`, async ({ page }) => {
    await page.setContent(standIn(after));
    await managedLogin(page, account, null, { timeout: 5_000 });
    await expect.poll(() => page.evaluate(() => [window.email, window.done])).toEqual([account.email, account.password]);
  });
}

test("managedLogin fails with what the page showed when no password field turns up, without the values typed", async ({ page }) => {
  await page.setContent(standIn(`<h1>Use a passkey</h1><p>Signed in as ${account.email}</p><button type="button">Use passkey</button>`));
  const masked = (s) => s.split("crew.member").join("***");
  const err = await managedLogin(page, account, null, { timeout: 1_500, redact: masked }).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toContain("Managed Login showed no password field after the email (tried: nothing)");
  expect(err.message).toContain('headings "Use a passkey"');
  expect(err.message).toContain('"button Use passkey"');
  expect(err.message).not.toContain("crew.member");
  expect(err.message).not.toContain(account.password);
});

test("managedLogin stops at an alert instead of waiting out the time", async ({ page }) => {
  await page.setContent(standIn(`<h1>Sign in</h1><p role="alert">User does not exist.</p>`));
  const started = Date.now();
  const err = await managedLogin(page, account, null, { timeout: 15_000 }).catch((e) => e);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(err.message).toContain('alerts "User does not exist."');
});
