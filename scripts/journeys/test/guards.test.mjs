// node --test scripts/journeys/test/ (part of npm run test:scripts): configuration, run IDs,
// addresses, masking and the guards.
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseThrowaway, runBarcode, runName, runOf, throwawayAddress } from "../lib/addresses.mjs";
import { ConfigError, OPT_IN_PHRASE, PROD, assertRunAllowed, checkBaseUrl, isAtTestDomain, readConfig, runDir, runId, secretValues } from "../lib/config.mjs";
import { GuardError, assertDestructiveAllowed, checkMe, isRunScoped } from "../lib/guards.mjs";
import { MASKED_VALUES_FILE, createMasker, maskAddress, readMaskedValues } from "../lib/mask.mjs";
import { at, fakeEnv } from "./helpers.mjs";

test("the base URL guard takes only the prod app", () => {
  assert.equal(checkBaseUrl(PROD.app), PROD.app);
  assert.equal(checkBaseUrl(`${PROD.app}/`), PROD.app);
  for (const bad of [undefined, "", "http://app.supplycheckout.com", `${PROD.app}.evil.test`, `${PROD.app}/x`, "https://supplycheckout.com", "https://app.supplycheckout.co", "http://localhost:5173"]) {
    assert.throws(() => checkBaseUrl(bad), ConfigError, String(bad));
  }
  // localhost only for the harness's own tests, and only plain http on a port
  assert.equal(checkBaseUrl("http://localhost:5173/", { allowLocal: true }), "http://localhost:5173");
  assert.equal(checkBaseUrl("http://127.0.0.1", { allowLocal: true }), "http://127.0.0.1");
  assert.throws(() => checkBaseUrl("http://localhost.evil.test", { allowLocal: true }), ConfigError);
});

test("the suite runs only in GitHub Actions or with the exact opt-in", () => {
  assert.equal(assertRunAllowed({ GITHUB_ACTIONS: "true", CI: "true" }), "ci");
  assert.equal(assertRunAllowed({ JOURNEYS_PROD_OPT_IN: OPT_IN_PHRASE }), "opt-in");
  for (const env of [{}, { CI: "true" }, { GITHUB_ACTIONS: "true" }, { JOURNEYS_PROD_OPT_IN: "yes" }, { JOURNEYS_PROD_OPT_IN: `${OPT_IN_PHRASE} ` }]) {
    assert.throws(() => assertRunAllowed(env), ConfigError);
  }
});

test("run IDs come from the Actions run and attempt, or are made once locally", () => {
  assert.equal(runId({ GITHUB_RUN_ID: "123456", GITHUB_RUN_ATTEMPT: "2" }), "123456-2");
  assert.equal(runId({ GITHUB_RUN_ID: "123456" }), "123456-1");
  assert.equal(runId({ JOURNEYS_RUN_ID: "abc" }), "abc");
  assert.equal(runId({}, 42), "local42");
  for (const bad of ["a/b", "a b", "../x", "a-b-c", "x".repeat(30)]) assert.throws(() => runId({ JOURNEYS_RUN_ID: bad }), ConfigError);
  assert.equal(runDir({ RUNNER_TEMP: "/runner/tmp" }, "1-1"), "/runner/tmp/journeys-1-1");
});

test("the test mail domain matches exactly, as the backend's rule does", () => {
  assert.ok(isAtTestDomain(at("a")));
  assert.ok(isAtTestDomain(`a@${PROD.mailDomain.toUpperCase()}`));
  for (const bad of [`a@x.${PROD.mailDomain}`, `a@${PROD.mailDomain}.example`, `@${PROD.mailDomain}`, `a@b@${PROD.mailDomain}`, `a b@${PROD.mailDomain}`, `a@${PROD.mailDomain}.`, "a@example.com", 7, null]) {
    assert.equal(isAtTestDomain(bad), false, String(bad));
  }
});

test("readConfig checks every secret and names only the variables", () => {
  const config = readConfig(fakeEnv());
  assert.equal(config.accounts.owner.totp, "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
  assert.deepEqual(config.teams, { desktop: "team-desktop-1", phone: "team-phone-2" });
  assert.equal(secretValues(config).length, 11);
  const env = fakeEnv({ JOURNEYS_CREW_EMAIL: "someone@example.com", JOURNEYS_OWNER_TOTP: "not base32!", JOURNEYS_PHONE_TEAM_ID: "team-desktop-1", JOURNEYS_MAIL_BUCKET: "Bad_Bucket", JOURNEYS_VIEWER_PASSWORD: "" });
  const err = assert.throws(() => readConfig(env), (e) => {
    assert.ok(e instanceof ConfigError);
    for (const name of ["JOURNEYS_CREW_EMAIL must", "JOURNEYS_OWNER_TOTP must", "different teams", "JOURNEYS_MAIL_BUCKET is not", "JOURNEYS_VIEWER_PASSWORD is not set"]) assert.match(e.message, new RegExp(name));
    // Never a value
    for (const v of ["someone@example.com", "not base32!", "Bad_Bucket"]) assert.ok(!e.message.includes(v));
    return true;
  });
  void err;
  assert.throws(() => readConfig(fakeEnv({ JOURNEYS_CREW_EMAIL: at("owner-lived") })), /different accounts/);
  assert.throws(() => readConfig(fakeEnv({ JOURNEYS_DESKTOP_TEAM_ID: "a/b" })), /JOURNEYS_DESKTOP_TEAM_ID is not a team ID/);
});

test("throwaway addresses are unguessable, run- and role-scoped, and parse back exactly", () => {
  const a = throwawayAddress("123-1", "owner");
  const b = throwawayAddress("123-1", "owner");
  assert.notEqual(a, b);
  assert.match(a, new RegExp(`^run-123-1-owner-[0-9a-f]{32}@${PROD.mailDomain.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&")}$`));
  assert.deepEqual(parseThrowaway(a), { runId: "123-1", role: "owner" });
  assert.deepEqual(parseThrowaway(throwawayAddress("local9", "crew")), { runId: "local9", role: "crew" });
  const fixed = throwawayAddress("5-1", "crew", { random: () => Buffer.alloc(16, 0xab) });
  assert.equal(fixed, at(`run-5-1-crew-${"ab".repeat(16)}`));
  for (const bad of [at("run-5-1-crew"), at(`run-5-1-crew-${"ab".repeat(15)}`), `run-5-1-crew-${"ab".repeat(16)}@example.com`, at(`xrun-5-1-crew-${"ab".repeat(16)}`), at(`run-5-1-Crew-${"ab".repeat(16)}`), undefined]) {
    assert.equal(parseThrowaway(bad), null, String(bad));
  }
  assert.throws(() => throwawayAddress("1-1", "Owner!"));
});

test("run names and barcodes carry the run ID", () => {
  assert.equal(runOf({ name: runName("77-2", "Gloves") }), "77-2");
  assert.equal(runOf({ code: runBarcode("77-2", 3) }), "77-2");
  assert.equal(runOf({ code: runBarcode("local5", 3) }), "local5");
  assert.equal(runOf({ name: "Gloves", code: "0123" }), null);
  assert.equal(runOf({ name: "E2E Gloves" }), null);
  assert.equal(runOf(), null);
});

const me = (over = {}) => ({
  user: { id: "u1", email: at("crew-lived"), emailVerified: true, mfa: "off", ...over.user },
  teams: over.teams ?? [
    { id: "team-desktop-1", name: "Journeys desktop", role: "contributor", comp: { plan: "team", until: "2027-09-01T00:00:00Z" } },
    { id: "team-phone-2", name: "Journeys phone", role: "contributor", comp: { plan: "team", until: "2027-09-01T00:00:00Z" } },
  ],
  invites: [],
});
const NOW = Date.parse("2026-10-07T00:00:00Z");
const expectTeams = { email: at("crew-lived"), teamIds: ["team-desktop-1", "team-phone-2"], now: NOW, requireTeams: true };

test("checkMe passes a verified test account in exactly the expected teams", () => {
  assert.deepEqual(checkMe(me(), expectTeams), []);
  assert.deepEqual(checkMe(me({ user: { email: at("CREW-lived") } }), expectTeams), []);
});

test("checkMe stops the run for a team the run doesn't expect, naming no ID", () => {
  const err = assert.throws(() => checkMe(me({ teams: [...me().teams, { id: "house-finch-team", name: "House Finch" }] }), expectTeams), GuardError);
  void err;
  try { checkMe(me({ teams: [{ id: "house-finch-team" }] }), expectTeams); } catch (e) { assert.ok(!e.message.includes("house-finch-team")); }
});

test("checkMe refuses an unverified, non-test or different account, and missing teams", () => {
  assert.throws(() => checkMe(me({ user: { emailVerified: false } }), expectTeams), /isn't verified/);
  assert.throws(() => checkMe(me({ user: { email: "real.person@example.com" } }), expectTeams), /not a test account/);
  assert.throws(() => checkMe(me({ user: { email: at("viewer-lived") } }), expectTeams), /different account/);
  assert.throws(() => checkMe({}, expectTeams), /no user/);
  assert.throws(() => checkMe({ user: me().user }, expectTeams), /no team list/);
  assert.throws(() => checkMe(me({ teams: [me().teams[0]] }), expectTeams), /1 of the 2/);
  // A throwaway may be in no team yet
  assert.deepEqual(checkMe(me({ teams: [] }), { email: at("crew-lived"), teamIds: [] }), []);
});

test("checkMe warns when a long-lived team's comp ends within 30 days or is missing", () => {
  const soon = me({ teams: [{ ...me().teams[0], comp: { plan: "team", until: "2026-10-20T00:00:00Z" } }, { ...me().teams[1], comp: null }] });
  const warnings = checkMe(soon, expectTeams);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Journeys desktop.*ends in 13 days/);
  assert.match(warnings[1], /Journeys phone.*no comp/);
});

const longLived = { emails: [at("owner-lived"), at("crew-lived")], teamIds: ["team-desktop-1", "team-phone-2"] };
const runOwner = throwawayAddress("9-1", "owner");

test("destructive calls are allowed only as this run's throwaway, on a team the run made", () => {
  assert.doesNotThrow(() => assertDestructiveAllowed({ action: "deleteAccount", account: runOwner, runIds: ["9-1"], longLived }));
  assert.doesNotThrow(() => assertDestructiveAllowed({ action: "closeTeam", account: runOwner, runIds: ["9-1"], longLived, team: { id: "t-new", role: "owner" }, createdTeams: ["t-new"] }));
});

test("destructive calls are refused as a long-lived account, another run's or a non-throwaway account", () => {
  const cases = [
    [{ action: "deleteAccount", account: at("owner-lived") }, /long-lived/],
    [{ action: "deleteAccount", account: at("OWNER-lived") }, /long-lived/],
    [{ action: "deleteAccount", account: "real.person@example.com" }, /isn't a run's throwaway/],
    [{ action: "deleteAccount", account: at("run-9-1-owner") }, /isn't a run's throwaway/],
    [{ action: "deleteAccount", account: throwawayAddress("8-1", "owner") }, /another run/],
    [{ action: "deleteAccount", account: null }, /isn't a run's throwaway/],
    [{ action: "dropTable", account: runOwner }, /Unknown/],
  ];
  for (const [args, re] of cases) assert.throws(() => assertDestructiveAllowed({ runIds: ["9-1"], longLived, ...args }), (e) => e instanceof GuardError && re.test(e.message));
});

test("team closure is refused for a long-lived team, one the run didn't make, or one not owned", () => {
  const base = { action: "closeTeam", account: runOwner, runIds: ["9-1"], longLived, createdTeams: ["t-new", "team-desktop-1"] };
  assert.throws(() => assertDestructiveAllowed({ ...base, team: { id: "team-desktop-1", role: "owner" } }), /long-lived journey team/);
  assert.throws(() => assertDestructiveAllowed({ ...base, team: { id: "house-finch-team", role: "owner" } }), /didn't create/);
  assert.throws(() => assertDestructiveAllowed({ ...base, team: { id: "t-new", role: "contributor" } }), /doesn't own/);
  assert.throws(() => assertDestructiveAllowed({ ...base, team: undefined }), /doesn't list/);
});

test("cleanup's scope: this run's things, and other runs' only after a day", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const doc = (data) => ({ id: "x", version: 1, data });
  assert.ok(isRunScoped(doc({ name: runName("9-1", "Gloves") }), { runId: "9-1", now }));
  assert.ok(isRunScoped(doc({ client: runName("9-1", "Job") }), { runId: "9-1", now }));
  assert.ok(isRunScoped(doc({ name: "Gloves", code: runBarcode("9-1", 1) }), { runId: "9-1", now }));
  assert.ok(isRunScoped(doc({ name: runName("8-1", "Gloves"), updatedAt: "2026-10-06T11:00:00Z" }), { runId: "9-1", now }));
  assert.ok(!isRunScoped(doc({ name: runName("8-1", "Gloves"), updatedAt: "2026-10-06T13:00:00Z" }), { runId: "9-1", now }));
  assert.ok(!isRunScoped(doc({ client: runName("8-1", "Job") }), { runId: "9-1", now }));
  assert.ok(!isRunScoped(doc({ name: "Nitrile gloves", code: "0123", updatedAt: "2020-01-01T00:00:00Z" }), { runId: "9-1", now }));
  assert.ok(!isRunScoped(undefined, { runId: "9-1", now }));
});

test("the masker hides remembered values and token, address, account and secret-parameter shapes", () => {
  const written = [];
  const masker = createMasker({ github: true, write: (s) => written.push(s) });
  masker.add("hunter2-secret-value");
  masker.add("line-one\nline-two");
  masker.add("abc");
  masker.add(undefined);
  masker.add("hunter2-secret-value");
  assert.deepEqual(written, ["\n::add-mask::hunter2-secret-value\n", "\n::add-mask::line-one\n", "\n::add-mask::line-two\n"]);
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJlLXZhbHVl";
  const text = masker.redact(`pw hunter2-secret-value; ${jwt}; ${at("run-1-1-owner-ab")}; arn 123456789012; https://app.x/?invite=i1&token=t0k3n; s3://bucket-name/runs/x; code=55`);
  assert.ok(!text.includes("hunter2"));
  assert.ok(!text.includes(jwt));
  assert.ok(!text.includes("run-1-1-owner-ab"));
  assert.ok(text.includes(`run…@${PROD.mailDomain}`));
  assert.ok(!text.includes("123456789012"));
  assert.ok(!text.includes("t0k3n") && !text.includes("invite=i1"));
  assert.ok(!text.includes("bucket-name"));
  assert.equal(maskAddress("nope"), "***");
  assert.equal(maskAddress(at("ab")), `ab…@${PROD.mailDomain}`);
  // Outside Actions it remembers without printing
  const quiet = [];
  const local = createMasker({ github: false, write: (s) => quiet.push(s) });
  local.add("a-secret-value");
  assert.deepEqual(quiet, []);
  assert.equal(local.redact("x a-secret-value"), "x ***");
  assert.ok(local.has("a-secret-value"));
  assert.equal(local.size, 1);
});

test("remember() only redacts: a value that's already a GitHub secret is never printed or persisted", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mask-"));
  const file = path.join(dir, MASKED_VALUES_FILE);
  const written = [];
  const masker = createMasker({ github: true, write: (s) => written.push(s), persist: file });
  masker.remember("a-password-from-secrets");
  assert.deepEqual(written, []);
  assert.deepEqual(readMaskedValues(file), []);
  assert.equal(masker.redact("x a-password-from-secrets"), "x ***");
  masker.add("runtime-code-value");
  masker.add("a-password-from-secrets");
  assert.deepEqual(written, ["\n::add-mask::runtime-code-value\n"]);
  assert.deepEqual(readMaskedValues(file), ["runtime-code-value"]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // persistTo starts recording once the run's directory exists
  const later = createMasker({ github: false });
  later.add("before-the-directory");
  later.persistTo(path.join(dir, "later"));
  later.add("after-the-directory");
  assert.deepEqual(readMaskedValues(path.join(dir, "later")), ["after-the-directory"]);
});
