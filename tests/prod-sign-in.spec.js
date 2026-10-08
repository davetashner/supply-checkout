// The prod journey suite's Managed Login steps (managedLogin in tests/prod/fixtures.mjs), on
// stand-ins for the shapes Managed Login's choice-based sign-in can take after the email: the
// password straight away (an account with MFA), a choice of sign-in method (radios, or buttons),
// a code sent by email with "Try another way" (what prod shows crew and viewer) or "Other sign-in options", and a page with no way to a password, which
// fails saying what the page showed, without any value typed into it.
import { expect, test } from "@playwright/test";
import { TooManyRequests, managedLogin } from "./prod/fixtures.mjs";

const account = { email: "crew.member@example.com", password: "not-a-real-password-1" };

// Each stand-in: the email page, then `after` (HTML) once Next is pressed. A password page records
// what was typed and the button pressed on it in window.done.
const passwordPage = `<h1>Enter your password</h1><label>Password <input type="password" id="pw"></label>
  <button type="button" aria-label="Show password">👁</button><a href="#">Forgot password?</a>
  <button type="button" onclick="window.done = document.getElementById('pw').value">Sign in</button>`;
// Managed Login's pages as prod shows them to crew and viewer. The password page's "Show
// password" checkbox and "Forgot your password?" link record a touch, which fails the test.
const prodPasswordPage = `<h1>Enter your password</h1><label for="pw">Password</label><input type="password" id="pw" placeholder="Enter password">
  <label><input type="checkbox" onchange="window.touched = 'show password'"> Show password</label>
  <a href="#" onclick="window.touched = 'forgot'; return false">Forgot your password?</a>
  <button type="button" onclick="window.done = document.getElementById('pw').value">Continue</button><button type="button">Back</button>`;
const chooseMethod = `<h1>Choose a sign-in method</h1><fieldset><legend>Sign-in method</legend>
  <label><input type="radio" name="method" value="otp" checked> Email one-time password</label>
  <label><input type="radio" name="method" value="pw"> Password</label></fieldset>
  <button type="button" onclick="show(document.querySelector('input[value=pw]').checked ? window.prodPasswordPage : window.verifyCode)">Continue</button><button type="button">Back</button>`;
const verifyCode = `<h1>Check your email</h1>
  <p role="alert">Enter the code that we sent to the email address c***@e***. The code expires in 15 minutes.</p>
  <label>Verification code <input id="code" autocomplete="one-time-code"></label>
  <button type="button">Continue</button><button type="button">Back</button><p>Or</p>
  <button type="button" onclick="show(window.chooseMethod)">Try another way</button>`;
const shapes = {
  "the password straight away": passwordPage,
  "a choice of radios, then Next": `<h1>Choose a sign-in method</h1><fieldset><legend>Sign in with</legend>
    <label><input type="radio" name="m" value="otp"> Email message</label>
    <label><input type="radio" name="m" value="pw"> Password</label></fieldset>
    <button type="button" onclick="if (document.querySelector('input[value=pw]').checked) show(window.passwordPage)">Next</button>`,
  "a choice of buttons": `<h1>Sign in</h1><button type="button">Email message</button>
    <button type="button" onclick="show(window.passwordPage)">Sign in with password</button>`,
  // What prod shows an account without MFA (the owner's screenshots, 2026-10-08): the email code
  // first, then behind "Try another way" a choice with the email code already selected (choosing
  // it goes back to the code), then the password page
  "Managed Login's \"Check your email\", then Try another way and the Password radio": "window.verifyCode",
  // The same page drawn in two steps, its alert before its buttons: an alert seen before the
  // buttons turn up mustn't end the wait (the race that failed this suite in CI)
  "\"Check your email\" with its alert drawn before Try another way": `<h1>Check your email</h1>
    <p role="alert">Enter the code that we sent to the email address c***@e***.</p><div id="later"></div>
    <img src="data:," onerror="setTimeout(() => { document.getElementById('later').innerHTML = window.verifyCode; }, 400)">`,
  "a code by email first, other options behind a link": `<h1>Enter the code we emailed you</h1><label>Code <input id="code"></label>
    <a href="#" onclick="show('<h1>Other ways</h1><a href=&quot;#&quot; onclick=&quot;show(window.passwordPage)&quot;>Password</a>'); return false">Other sign-in options</a>`,
};

const standIn = (after) => `<!doctype html><title>Sign in</title><main id="m">
  <label>Email address <input type="email" id="email"></label>
  <button type="button" onclick="window.email = document.getElementById('email').value; show(window.after)">Next</button></main>
  <script>window.passwordPage = ${JSON.stringify(passwordPage)}; window.prodPasswordPage = ${JSON.stringify(prodPasswordPage)};
  window.chooseMethod = ${JSON.stringify(chooseMethod)}; window.verifyCode = ${JSON.stringify(verifyCode)};
  window.after = ${after === "window.verifyCode" ? "window.verifyCode" : JSON.stringify(after)};
  function show(html) { setTimeout(() => { document.getElementById("m").innerHTML = html; }, 50); }</script>`;

for (const [shape, after] of Object.entries(shapes)) {
  test(`managedLogin reaches the password from ${shape}`, async ({ page }) => {
    await page.setContent(standIn(after));
    await managedLogin(page, account, null, { timeout: 5_000 });
    await expect.poll(() => page.evaluate(() => [window.email, window.done, window.touched])).toEqual([account.email, account.password, undefined]);
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

test("managedLogin never takes the email code's option, even with no Password option beside it", async ({ page }) => {
  await page.setContent(standIn(`<h1>Choose a sign-in method</h1>
    <label><input type="radio" name="method" checked> Email one-time password</label>
    <button type="button">Email one-time password</button><a href="#">Sign in with an email password code</a>
    <button type="button" onclick="window.continued = true">Continue</button>`));
  const err = await managedLogin(page, account, null, { timeout: 1_500 }).catch((e) => e);
  expect(err.message).toContain("Managed Login showed no password field after the email (tried: nothing)");
  expect(await page.evaluate(() => window.continued)).toBeUndefined();
});

test("managedLogin reports Managed Login's request limit as TooManyRequests, for signIn to back off", async ({ page }) => {
  await page.setContent(standIn(`<h1>Sign in</h1><div role="alert">Too many requests: You have exceeded the request limit. Please try again later</div>`));
  const err = await managedLogin(page, account, null, { timeout: 4_000 }).catch((e) => e);
  expect(err).toBeInstanceOf(TooManyRequests);
  expect(err.message).toContain("Managed Login refused the sign-in");
  // Any other alert is an ordinary failure
  await page.setContent(standIn(`<h1>Sign in</h1><div role="alert">Incorrect username or password.</div>`));
  const other = await managedLogin(page, account, null, { timeout: 4_000 }).catch((e) => e);
  expect(other).not.toBeInstanceOf(TooManyRequests);
});
