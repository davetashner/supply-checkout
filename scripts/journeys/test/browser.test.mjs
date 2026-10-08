// node --test scripts/journeys/test/ (part of npm run test:scripts): the prod fixtures' console
// error allowances and the screen description a failed sign-in step reports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROD } from "../lib/config.mjs";
import { isExpectedConsoleError } from "../lib/console.mjs";
import { createMasker } from "../lib/mask.mjs";
import { formatScreen } from "../lib/screen.mjs";

const NOT_FOUND = "Failed to load resource: the server responded with a status of 404 ()";

test("a 404 for one project or item is expected; any other 404 isn't", () => {
  assert.equal(isExpectedConsoleError(NOT_FOUND, `${PROD.api}/teams/t1/products/e2e-1-201`), true);
  assert.equal(isExpectedConsoleError(NOT_FOUND, `${PROD.api}/teams/t%201/projects/p-1`), true);
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
  ]) assert.equal(isExpectedConsoleError(NOT_FOUND, url), false, String(url));
  // Another status for the same document is a failure
  for (const status of [400, 403, 409, 500]) {
    assert.equal(isExpectedConsoleError(`Failed to load resource: the server responded with a status of ${status} ()`, `${PROD.api}/teams/t1/products/a`), false, String(status));
  }
});

test("the RUM aborts and the refresh's 401 before sign-in stay expected", () => {
  assert.equal(isExpectedConsoleError("Failed to load resource: net::ERR_FAILED", "https://dataplane.rum.us-east-1.amazonaws.com/appmonitors/x"), true);
  assert.equal(isExpectedConsoleError("Failed to load resource: the server responded with a status of 401 ()", `${PROD.api}/auth/refresh`), true);
  assert.equal(isExpectedConsoleError("Failed to load resource: the server responded with a status of 401 ()", `${PROD.api}/me`), false);
  assert.equal(isExpectedConsoleError("TypeError: x is undefined", `${PROD.app}/assets/app.js`), false);
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
  assert.match(line, new RegExp(`^page ${PROD.auth.replace(/\./g, "\\.")}/login/continue; `));
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
