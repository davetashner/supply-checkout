// node --test scripts/journeys/test/ (part of npm run test:scripts): the prod fixtures' console
// error allowances and the screen description a failed sign-in step reports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROD } from "../lib/config.mjs";
import { consoleFailure, isDocumentNotFound, isExpectedConsoleError, isExpectedPageError } from "../lib/console.mjs";
import { createMasker } from "../lib/mask.mjs";
import { formatScreen, isPasswordChoice } from "../lib/screen.mjs";

const NOT_FOUND = "Failed to load resource: the server responded with a status of 404 ()";

test("a 404 for one project or item is a warning, not expected; any other 404 is a failure", () => {
  for (const url of [`${PROD.api}/teams/t1/products/e2e-1-201`, `${PROD.api}/teams/t%201/projects/p-1`]) {
    assert.equal(isDocumentNotFound(NOT_FOUND, url), true, url);
    assert.equal(isExpectedConsoleError(NOT_FOUND, url), false, url);
  }
  for (const url of [
    `${PROD.api}/teams/t1/products`,
    `${PROD.api}/teams/t1/settings`,
    `${PROD.api}/teams/t1/receipts/usage`,
    `${PROD.api}/teams/t1/products/a/b`,
    `${PROD.api}/teams/t1/products/a?expectedVersion=1`,
    `${PROD.api}/me`,
    `${PROD.app}/teams/t1/products/a`,
    "https://api.example.com/teams/t1/products/a",
    "",
    undefined,
    "not a url",
  ]) {
    assert.equal(isExpectedConsoleError(NOT_FOUND, url), false, String(url));
    assert.equal(isDocumentNotFound(NOT_FOUND, url), false, String(url));
  }
  // Another status for the same document is a failure
  for (const status of [400, 403, 409, 500]) {
    assert.equal(isDocumentNotFound(`Failed to load resource: the server responded with a status of ${status} ()`, `${PROD.api}/teams/t1/products/a`), false, String(status));
    assert.equal(isExpectedConsoleError(`Failed to load resource: the server responded with a status of ${status} ()`, `${PROD.api}/teams/t1/products/a`), false, String(status));
  }
});

test("the RUM aborts and the refresh's 401 before sign-in stay expected", () => {
  assert.equal(isExpectedConsoleError("Failed to load resource: net::ERR_FAILED", "https://dataplane.rum.us-east-1.amazonaws.com/appmonitors/x"), true);
  assert.equal(isExpectedConsoleError("Failed to load resource: the server responded with a status of 401 ()", `${PROD.api}/auth/refresh`), true);
  assert.equal(isExpectedConsoleError("Failed to load resource: the server responded with a status of 401 ()", `${PROD.api}/me`), false);
  assert.equal(isExpectedConsoleError("TypeError: x is undefined", `${PROD.app}/assets/app.js`), false);
});

test("J11.2's refused account deletion (409 on /me) is expected, and nothing else on /me or 409 elsewhere", () => {
  const status = (n) => `Failed to load resource: the server responded with a status of ${n} ()`;
  assert.equal(isExpectedConsoleError(status(409), `${PROD.api}/me`), true);
  assert.equal(isExpectedConsoleError(status(4090), `${PROD.api}/me`), false);
  for (const n of [400, 403, 404, 500]) assert.equal(isExpectedConsoleError(status(n), `${PROD.api}/me`), false, String(n));
  assert.equal(isExpectedConsoleError(status(409), `${PROD.api}/teams/t1/close`), false);
  assert.equal(isExpectedConsoleError(status(409), `${PROD.api}/me/preferences`), false);
  assert.equal(isExpectedConsoleError(status(409), "https://api.example.com/me"), false);
});

test("a screen is described by its path, headings, alerts, labels and controls, redacted", () => {
  const masker = createMasker({ github: false });
  masker.remember("Journeys desktop secret");
  const line = formatScreen({
    url: `${PROD.auth}/login/continue?client_id=abc&state=s3cr3t&redirect_uri=x`,
    headings: ["Sign in", "  Choose a sign-in   method ", "Sign in"],
    alerts: [],
    fields: ["Email address (email)"],
    controls: ["radio Password", "radio Email message", "button Next", "link Signed in as crew.member@example.com", "button Journeys desktop secret"],
  }, masker.redact);
  assert.ok(line.startsWith(`page ${PROD.auth}/login/continue; `), line);
  assert.doesNotMatch(line, /client_id|state|s3cr3t|redirect_uri/);
  assert.match(line, /headings "Sign in", "Choose a sign-in method";/);
  assert.match(line, /alerts none;/);
  assert.match(line, /controls "radio Password", "radio Email message", "button Next"/);
  assert.doesNotMatch(line, /crew\.member@/);
  assert.match(line, /cre…@example\.com/);
  assert.doesNotMatch(line, /Journeys desktop secret/);
});

test("a screen description stays short", () => {
  const many = Array.from({ length: 20 }, (_, i) => `button ${i} ${"x".repeat(200)}`);
  const line = formatScreen({ url: "nonsense", controls: many });
  assert.match(line, /^page \(no URL\);/);
  assert.match(line, /and 8 more$/);
  assert.ok(line.length < 1500);
  assert.equal(formatScreen(undefined), "page (no URL); headings none; alerts none; fields none; controls none");
});

test("only WebKit's report of the RUM client's Cognito request cut off is an expected page error", () => {
  for (const m of [
    "/cognito-identity.us-east-1.amazonaws.com/ due to access control checks.",
    "Fetch API cannot load https://cognito-identity.us-west-2.amazonaws.com/ due to access control checks.",
  ]) assert.equal(isExpectedPageError(m), true, m);
  for (const m of [
    "TypeError: Load failed",
    // Handled by the app now (src/aws/rum.js): a failure if it's ever uncaught again
    "Error: CWR: Failed to retrieve Cognito identity: TypeError: Load failed",
    "Error: CWR: something else",
    "Error: CWR: Failed to retrieve Cognito identity: TypeError: Load failed; and then something else",
    "Error: CWR: Failed to retrieve Cognito identity: TypeError: x is undefined",
    `Fetch API cannot load ${PROD.api}/me due to access control checks.`,
    "Fetch API cannot load https://cognito-identity.us-east-1.amazonaws.com.evil.test/ due to access control checks.",
    "",
    undefined,
  ]) assert.equal(isExpectedPageError(m), false, String(m));
});

test("a console failure names the resource's path without its query", () => {
  assert.equal(consoleFailure(NOT_FOUND, `${PROD.api}/teams/t1/settings?token=abc#x`), `console: ${NOT_FOUND} (${PROD.api}/teams/t1/settings)`);
  assert.equal(consoleFailure("TypeError: boom", ""), "console: TypeError: boom");
  assert.equal(consoleFailure("TypeError: boom", undefined), "console: TypeError: boom");
  assert.equal(consoleFailure("x", "data:text/plain,secret"), "console: x");
});

test("only a control named for the password itself is the password choice", () => {
  for (const name of ["Password", " password ", "PASSWORD", "Use password", "Use a password", "Use your password", "Sign in with password", "Sign in with your  password"]) {
    assert.equal(isPasswordChoice(name), true, name);
  }
  for (const name of ["Email one-time password", "One-time password", "Email password", "Show password", "Forgot your password?", "Forgot password?", "Reset password", "Change password", "Passwordless", "Password reset", "Sign in with a passkey", "Email message", "", undefined]) {
    assert.equal(isPasswordChoice(name), false, String(name));
  }
});
