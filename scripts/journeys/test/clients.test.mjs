// node --test scripts/journeys/test/ (part of npm run test:scripts): TOTP, the Cognito, API and
// S3 clients, the run records, global setup and the results upload, against fakes.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseThrowaway } from "../lib/addresses.mjs";
import { ApiError, appConfig, createApi } from "../lib/api.mjs";
import { CognitoError, createCognito } from "../lib/cognito.mjs";
import { PROD } from "../lib/config.mjs";
import { createMasker } from "../lib/mask.mjs";
import { checkRecord, readRecords, recordKey, writeRecord } from "../lib/runs.mjs";
import { createS3 } from "../lib/s3.mjs";
import { setup } from "../lib/setup.mjs";
import { base32Decode, freshTotp, hotp, stepAt, totp } from "../lib/totp.mjs";
import { NOT_UPLOADED, UploadRefused, filesToUpload, findLeaks, leakForms, scrubReport, upload } from "../upload-results.mjs";
import { assertNotTracing, markTracing, secretFill } from "../lib/tracing.mjs";
import { at, fakeEnv, fakeFetch, fakeS3 } from "./helpers.mjs";

// RFC 6238's published test vector, "12345678901234567890" in base32: not a credential
const RFC_VECTOR = "GEZDGNBVGY3TQOJQ".repeat(2);

test("TOTP matches RFC 6238's SHA-1 test vectors", () => {
  const secret = RFC_VECTOR;
  assert.equal(base32Decode(secret).toString(), "12345678901234567890");
  for (const [seconds, code] of [[59, "94287082"], [1111111109, "07081804"], [1234567890, "89005924"], [2000000000, "69279037"]]) {
    assert.equal(totp(secret, seconds * 1000, 8), code);
  }
  assert.equal(totp(secret, 59_000), "287082");
  assert.equal(hotp(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq=="), 1), "287082");
  assert.throws(() => base32Decode("not base32!"), /base32/);
});

test("freshTotp claims each step once, atomically, across processes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "totp-"));
  const stateFile = path.join(dir, "totp-step");
  let t = 30_000 * 1000 + 5_000;
  const slept = [];
  const opts = { stateFile, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } };
  const secret = RFC_VECTOR;
  const step = stepAt(t);
  const a = await freshTotp(secret, opts);
  assert.ok(existsSync(`${stateFile}.${step}`));
  assert.deepEqual(slept, []);
  // Another process (same file, same moment) gets the next step, after waiting for it
  const b = await freshTotp(secret, opts);
  assert.notEqual(a, b);
  assert.ok(existsSync(`${stateFile}.${step + 1}`));
  assert.deepEqual(slept, [25_250]);
  // Two at once never share a step
  const codes = await Promise.all([freshTotp(secret, opts), freshTotp(secret, opts)]);
  assert.notEqual(codes[0], codes[1]);
  // Anything but "already claimed" is an error, not a skipped step
  await assert.rejects(freshTotp(secret, { ...opts, stateFile: path.join(dir, "missing", "x") }), /ENOENT/);
  // Without a state file it just answers
  assert.equal(await freshTotp(secret, { now: () => 59_000 }), "287082");
});

const CLIENT = "abcdefghijklmnopqrstuvwxy1";

test("Cognito: password sign-in, with and without the two-step challenge", async () => {
  const { fetch, calls } = fakeFetch({
    InitiateAuth: (body) => (body.AuthParameters.USERNAME === "two" ? [200, { ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "s1", ChallengeParameters: { USERNAME: "sub-1" } }] : [200, { AuthenticationResult: { AccessToken: "a1", IdToken: "i1", RefreshToken: "r1" } }]),
    RespondToAuthChallenge: [200, { AuthenticationResult: { AccessToken: "a2", IdToken: "i2", RefreshToken: "r2" } }],
    GlobalSignOut: [200, {}],
  });
  const c = createCognito({ region: "us-east-1", clientId: CLIENT, fetch });
  assert.deepEqual(await c.signInWithPassword("one", "pw"), { accessToken: "a1", idToken: "i1", refreshToken: "r1" });
  assert.equal(calls[0].url, "https://cognito-idp.us-east-1.amazonaws.com/");
  assert.deepEqual(calls[0].body, { AuthFlow: "USER_AUTH", ClientId: CLIENT, AuthParameters: { USERNAME: "one", PREFERRED_CHALLENGE: "PASSWORD", PASSWORD: "pw" } });
  assert.equal((await c.signInWithPassword("two", "pw", async () => "123456")).accessToken, "a2");
  assert.deepEqual(calls[2].body, { ClientId: CLIENT, ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "s1", ChallengeResponses: { USERNAME: "sub-1", SOFTWARE_TOKEN_MFA_CODE: "123456" } });
  await assert.rejects(c.signInWithPassword("two", "pw"), /no TOTP secret/);
  await c.globalSignOut("a1");
  assert.deepEqual(calls.at(-1).body, { AccessToken: "a1" });
});

test("Cognito: email-code sign-in, and errors that carry only the error type", async () => {
  const { fetch, calls } = fakeFetch({
    InitiateAuth: (body) => (body.AuthParameters.USERNAME === "odd" ? [200, { ChallengeName: "SELECT_CHALLENGE" }] : body.AuthParameters.USERNAME === "bad" ? [400, { __type: "com.amazonaws#NotAuthorizedException", message: "Incorrect username or password for bad" }] : [200, { ChallengeName: "EMAIL_OTP", Session: "s", ChallengeParameters: {} }]),
    RespondToAuthChallenge: (body) => (body.ChallengeResponses.EMAIL_OTP_CODE === "11111111" ? [200, { AuthenticationResult: { AccessToken: "a" } }] : [400, undefined]),
  });
  const c = createCognito({ region: "us-east-1", clientId: CLIENT, fetch });
  const challenge = await c.startEmailCode("someone");
  assert.deepEqual(challenge, { session: "s", username: "someone" });
  assert.deepEqual(calls[0].body.AuthParameters, { USERNAME: "someone", PREFERRED_CHALLENGE: "EMAIL_OTP" });
  assert.equal((await c.answerEmailCode(challenge, "11111111")).accessToken, "a");
  await assert.rejects(c.answerEmailCode(challenge, "22222222"), (e) => e instanceof CognitoError && e.message === "Cognito RespondToAuthChallenge failed: HTTP 400");
  await assert.rejects(c.startEmailCode("odd"), /unexpected challenge SELECT_CHALLENGE/);
  await assert.rejects(c.signInWithPassword("bad", "pw"), (e) => e.type === "NotAuthorizedException" && !e.message.includes("bad") && !e.message.includes("Incorrect"));
  const challengeOnly = createCognito({ region: "us-east-1", clientId: CLIENT, fetch: fakeFetch({ InitiateAuth: [200, { ChallengeName: "NEW_PASSWORD_REQUIRED" }] }).fetch });
  await assert.rejects(challengeOnly.signInWithPassword("x", "y"), /unexpected challenge NEW_PASSWORD_REQUIRED/);
  assert.throws(() => createCognito({ region: "nowhere", clientId: CLIENT }), /region/);
  assert.throws(() => createCognito({ region: "us-east-1", clientId: "x" }), /client ID/);
});

test("the API client: routes, paging, and errors without IDs or messages", async () => {
  const base = PROD.api;
  const { fetch, calls } = fakeFetch({
    [`GET ${base}/me`]: [200, { user: {} }],
    [`GET ${base}/teams/t%2F1/projects?limit=1000`]: [200, { documents: [{ id: "a" }], cursor: "c/2" }],
    [`GET ${base}/teams/t%2F1/projects?limit=1000&cursor=c%2F2`]: [200, { documents: [{ id: "b" }] }],
    [`GET ${base}/teams/t1/products?limit=1000`]: [200, {}],
    [`DELETE ${base}/teams/t1/projects/p1?expectedVersion=3`]: [204],
    [`DELETE ${base}/teams/t1/products/k%201?expectedVersion=2`]: [204],
    [`GET ${base}/teams/t1/settings`]: [200, { version: 4, settings: { equipmentMarkup: 12.34 } }],
    [`PUT ${base}/teams/t1/settings`]: [200, { version: 5, settings: { equipmentMarkup: 0 } }],
    [`POST ${base}/teams/t1/close`]: [409, { error: { code: "aborted", reason: "last_owner", message: "Team secret-name" } }],
    [`DELETE ${base}/me`]: [500, undefined],
  });
  const api = createApi({ token: "tok", fetch });
  assert.deepEqual(await api.me(), { user: {} });
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  assert.deepEqual((await api.listProjects("t/1")).map((d) => d.id), ["a", "b"]);
  assert.deepEqual(await api.listProducts("t1"), []);
  assert.equal(await api.deleteProject("t1", "p1", 3), null);
  assert.equal(await api.deleteProduct("t1", "k 1", 2), null);
  assert.deepEqual(await api.getSettings("t1"), { version: 4, settings: { equipmentMarkup: 12.34 } });
  assert.deepEqual((await api.putSettings("t1", 0, 4)).version, 5);
  assert.deepEqual(calls.at(-1).body, { equipmentMarkup: 0, expectedVersion: 4 });
  await assert.rejects(api.closeTeam("t1", "Team"), (e) => e instanceof ApiError && e.message === "POST /teams/{teamId}/close answered 409 aborted last_owner" && e.status === 409);
  assert.deepEqual(calls.at(-1).body, { name: "Team" });
  await assert.rejects(api.deleteMe(), (e) => e.message === "DELETE /me answered 500");
  assert.deepEqual(calls.at(-1).body, { confirm: "DELETE" });
});

test("appConfig takes the client ID only from a config.json that names prod's hosts", async () => {
  const good = { apiUrl: PROD.api, authUrl: PROD.auth, clientId: CLIENT };
  const fetchOf = (status, json) => fakeFetch({ [`GET ${PROD.app}/config.json`]: [status, json] }).fetch;
  assert.equal((await appConfig({ fetch: fetchOf(200, good) })).clientId, CLIENT);
  await assert.rejects(appConfig({ fetch: fetchOf(200, { ...good, apiUrl: "https://api.evil.example" }) }), /other than prod/);
  await assert.rejects(appConfig({ fetch: fetchOf(200, { ...good, authUrl: "https://auth.evil.example" }) }), /other than prod/);
  await assert.rejects(appConfig({ fetch: fetchOf(200, { ...good, clientId: undefined }) }), /no clientId/);
  await assert.rejects(appConfig({ fetch: fetchOf(503, good) }), /answered 503/);
});

test("the S3 client passes the bucket only as an argument and redacts it from errors", async () => {
  const bucket = "supply-checkout-prod-journey-mail-us-east-1-123456789012";
  const runs = [];
  const exec = async (args, input) => {
    runs.push({ args, input });
    if (args.includes("delete-object")) throw Object.assign(new Error("fail"), { stderr: `An error occurred (AccessDenied) when calling the DeleteObject operation: on ${bucket} for 123456789012` });
    if (args[1] === "list-objects-v2") return Buffer.from(JSON.stringify({ Contents: [{ Key: "inbox/a", LastModified: "2026-10-07T12:00:00Z" }] }));
    return Buffer.from("body");
  };
  const s3 = createS3(bucket, { exec });
  assert.deepEqual(await s3.list("inbox/"), [{ key: "inbox/a", lastModified: Date.parse("2026-10-07T12:00:00Z") }]);
  assert.deepEqual(runs[0].args, ["s3api", "list-objects-v2", "--bucket", bucket, "--prefix", "inbox/", "--output", "json"]);
  assert.equal((await s3.get("inbox/a")).toString(), "body");
  await s3.put("runs/1/accounts/owner.json", "{}");
  assert.equal(runs.at(-1).input, "{}");
  await s3.upload("/tmp/x", "runs/1/", ["masked-values", "totp-step*"]);
  assert.deepEqual(runs.at(-1).args.slice(-4), ["--exclude", "masked-values", "--exclude", "totp-step*"]);
  await assert.rejects(s3.remove("inbox/a"), (e) => e.message === "S3 delete failed: AccessDenied" && !e.message.includes(bucket) && !e.message.includes("123456789012"));
  const empty = createS3(bucket, { exec: async () => Buffer.alloc(0) });
  assert.deepEqual(await empty.list("runs/"), []);
  const noStderr = createS3(bucket, { exec: async () => { throw new Error("spawn aws ENOENT"); } });
  await assert.rejects(noStderr.get("x"), (e) => e.message === "S3 get failed");
});

test("run records hold only addresses, IDs and progress: never a password", async () => {
  const address = `run-9-1-owner-${"ab".repeat(16)}@${PROD.mailDomain}`;
  const s3 = fakeS3();
  const written = await writeRecord(s3, { runId: "9-1", role: "owner", address, state: "started", userId: "u1", teamIds: ["t1"] }, () => "2026-10-07T12:00:00Z");
  assert.deepEqual(JSON.parse(s3.store.get(recordKey("9-1", "owner")).body.toString()), written);
  await assert.rejects(writeRecord(s3, { runId: "9-1", role: "owner", address, state: "started", password: "Hunter2!" }), /may not hold password/);
  for (const bad of [
    { runId: "9-1", role: "crew", address, state: "started" },
    { runId: "8-1", role: "owner", address, state: "started" },
    { runId: "9-1", role: "owner", address: at("someone"), state: "started" },
    { runId: "9-1", role: "owner", address, state: "gone" },
    { runId: "9-1", role: "owner", address, state: "started", userId: "a/b" },
    { runId: "9-1", role: "owner", address, state: "started", teamIds: "t1" },
  ]) assert.throws(() => checkRecord(bad), Error, JSON.stringify(bad));
  s3.store.set("runs/9-1/accounts/crew.json", { body: Buffer.from("not json"), lastModified: 0 });
  s3.store.set("runs/7-1/accounts/owner.json", { body: Buffer.from(JSON.stringify(written)), lastModified: 0 });
  s3.store.set("runs/9-1/other.txt", { body: Buffer.from("x"), lastModified: 0 });
  const { records, problems } = await readRecords(s3);
  assert.deepEqual(records, [written]);
  assert.equal(problems.length, 2);
});

test("global setup: guards first, then /me for every long-lived account, then planned throwaways", async () => {
  const env = fakeEnv({ GITHUB_ACTIONS: "true", CI: "true" });
  const signedIn = [];
  const s3 = fakeS3();
  const masker = createMasker({ github: false });
  const meFor = (email) => ({ user: { id: `u-${email.slice(0, 5)}`, email, emailVerified: true }, teams: [{ id: "team-desktop-1", name: "Journeys desktop", comp: { until: "2026-10-10T00:00:00Z" } }, { id: "team-phone-2", name: "Journeys phone", comp: { until: "2027-10-10T00:00:00Z" } }] });
  const deps = {
    env,
    baseUrls: [PROD.app, PROD.app],
    runId: "9-1",
    appConfig: async () => ({ clientId: CLIENT }),
    createCognito: (clientId) => {
      assert.equal(clientId, CLIENT);
      return { signInWithPassword: async (email, pw, totp) => { signedIn.push([email, typeof totp]); return { accessToken: `eyJ.${email.slice(0, 3)}.x`, idToken: "id-token-x", refreshToken: "refresh-x" }; } };
    },
    apiFor: (token) => ({ me: async () => meFor([env.JOURNEYS_OWNER_EMAIL, env.JOURNEYS_CREW_EMAIL, env.JOURNEYS_VIEWER_EMAIL].find((e) => token.includes(e.slice(0, 3)))) }),
    mailS3: s3,
    masker,
    totpCode: async () => "000000",
  };
  const result = await setup(deps);
  assert.deepEqual(signedIn, [[env.JOURNEYS_OWNER_EMAIL, "function"], [env.JOURNEYS_CREW_EMAIL, "undefined"], [env.JOURNEYS_VIEWER_EMAIL, "undefined"]]);
  assert.equal(result.env.JOURNEYS_CLIENT_ID, CLIENT);
  assert.deepEqual(parseThrowaway(result.env.JOURNEYS_THROWAWAY_OWNER), { runId: "9-1", role: "owner" });
  assert.deepEqual(parseThrowaway(result.env.JOURNEYS_THROWAWAY_CREW), { runId: "9-1", role: "crew" });
  assert.equal(JSON.parse(s3.store.get(recordKey("9-1", "owner")).body).state, "planned");
  assert.ok(masker.has(result.env.JOURNEYS_THROWAWAY_OWNER) && masker.has(env.JOURNEYS_OWNER_PASSWORD) && masker.has("refresh-x"));
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Journeys desktop/);

  // Each guard stops it before anything signs in
  for (const bad of [{ env: fakeEnv() }, { baseUrls: ["https://evil.example"] }, { env: { ...env, JOURNEYS_OWNER_EMAIL: "real.person@example.com" } }]) {
    signedIn.length = 0;
    await assert.rejects(setup({ ...deps, ...bad }));
    assert.equal(signedIn.length, 0);
  }
  // A long-lived account in a team the run doesn't expect stops it before any throwaway is planned
  const s3b = fakeS3();
  await assert.rejects(setup({ ...deps, mailS3: s3b, apiFor: () => ({ me: async () => ({ ...meFor(env.JOURNEYS_OWNER_EMAIL), teams: [{ id: "house-finch-team" }] }) }) }), /journey team this run expects/);
  assert.equal(s3b.store.size, 0);
});

function runDirWith(files) {
  const temp = mkdtempSync(path.join(tmpdir(), "upload-"));
  const dir = path.join(temp, "journeys-77-1");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return { temp, dir };
}
const uploadEnv = (temp) => fakeEnv({ GITHUB_ACTIONS: "true", CI: "true", GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "1", RUNNER_TEMP: temp });

test("upload-results scrubs the report and text files, then puts the run's directory under runs/<runId>/", async () => {
  const env = fakeEnv();
  const report = {
    suites: [{ specs: [{ tests: [{ results: [{
      stdout: [{ text: "\n::add-mask::run-throwaway-address-value\n" }],
      stderr: [{ text: "noise" }],
      error: { message: `expected run-throwaway-address-value for ${env.JOURNEYS_CREW_EMAIL} in ${env.JOURNEYS_DESKTOP_TEAM_ID}\n::add-mask::leftover-value` },
    }] }] }] }],
  };
  // A failed test's error-context.md shows the page: the signed-in address, the team in a URL
  const context = `# Page\n- text: Signed in as ${env.JOURNEYS_CREW_EMAIL}\n- link: https://app.supplycheckout.com/?team=${env.JOURNEYS_DESKTOP_TEAM_ID}\n- bucket ${env.JOURNEYS_RESULTS_BUCKET}\n`;
  const { temp, dir } = runDirWith({
    "report.json": JSON.stringify(report),
    "masked-values": "run-throwaway-address-value\n",
    "totp-step.1000": "",
    "test-results/x/error-context.md": context,
    "test-results/x/trace.zip": "PK binary",
    "test-results/x/test-failed-1.png": `PNG ${env.JOURNEYS_CREW_EMAIL}`,
  });
  const s3 = fakeS3();
  const message = await upload({ env: uploadEnv(temp), s3For: (b) => { assert.equal(b, env.JOURNEYS_RESULTS_BUCKET); return s3; } });
  assert.deepEqual(s3.calls, [["upload", dir, "runs/77-1/"]]);
  assert.match(message, /\(4 files\)/);
  assert.ok(!message.includes(env.JOURNEYS_RESULTS_BUCKET));
  const scrubbed = readFileSync(path.join(dir, "report.json"), "utf8");
  for (const v of ["::add-mask::", "stdout", "stderr", env.JOURNEYS_CREW_EMAIL, env.JOURNEYS_DESKTOP_TEAM_ID, "run-throwaway-address-value"]) assert.ok(!scrubbed.includes(v), v);
  const md = readFileSync(path.join(dir, "test-results/x/error-context.md"), "utf8");
  for (const v of [env.JOURNEYS_CREW_EMAIL, env.JOURNEYS_DESKTOP_TEAM_ID, env.JOURNEYS_RESULTS_BUCKET]) assert.ok(!md.includes(v), v);
  assert.match(md, /Signed in as \*\*\*/);
  // Binary files are uploaded as they are
  assert.equal(readFileSync(path.join(dir, "test-results/x/test-failed-1.png"), "utf8"), `PNG ${env.JOURNEYS_CREW_EMAIL}`);
  assert.deepEqual(filesToUpload(dir), ["report.json", "test-results/x/error-context.md", "test-results/x/test-failed-1.png", "test-results/x/trace.zip"]);
  assert.deepEqual(NOT_UPLOADED, ["masked-values", "totp-step*"]);
  // An unreadable report is replaced, not uploaded as is
  const bad = runDirWith({ "report.json": `{ broken ${env.JOURNEYS_CREW_EMAIL}` });
  await upload({ env: uploadEnv(bad.temp), s3For: () => fakeS3() });
  assert.ok(!readFileSync(path.join(bad.dir, "report.json"), "utf8").includes(env.JOURNEYS_CREW_EMAIL));
});

test("upload-results refuses on a password or the TOTP secret in any form, anywhere, and on a mask command", async () => {
  const env = fakeEnv();
  const pw = env.JOURNEYS_OWNER_PASSWORD;
  const cases = [
    ["test-results/a/error-context.md", `log line ${env.JOURNEYS_OWNER_TOTP}`],
    ["test-results/a/error-context.md", "::add-mask::x-value"],
    ["test-results/a/data.bin", `binary ${env.JOURNEYS_VIEWER_PASSWORD}`],
    ["report.json", JSON.stringify({ steps: [{ title: `Fill "${pw}"` }] })],
    ["test-results/a/note.txt", JSON.stringify(`said "${pw}"`)],
    ["test-results/a/url.bin", `https://x.example/?p=${encodeURIComponent(pw)}`],
  ];
  for (const [file, body] of cases) {
    const { temp } = runDirWith({ "report.json": "{}", [file]: body, "test-results/a/ok.txt": "fine" });
    const s3 = fakeS3();
    await assert.rejects(upload({ env: uploadEnv(temp), s3For: () => s3 }), (e) => e instanceof UploadRefused && e.message.endsWith(` is in ${file}`) && !e.message.includes(pw), file);
    assert.deepEqual(s3.calls, [], file);
  }
  assert.deepEqual(leakForms('a"b c/d'), ['a"b c/d', 'a\\"b c/d', "a%22b%20c%2Fd"]);
  assert.deepEqual(scrubReport({ a: ["x\n::add-mask::y", 1, null], stdout: [] }, (s) => s), { a: ["x", 1, null] });
  const { dir } = runDirWith({ "ok.txt": "fine" });
  assert.deepEqual(findLeaks(dir, ["ok.txt"], [pw]), []);
});

test("upload-results refuses a run directory with a symlink", async () => {
  const { temp, dir } = runDirWith({ "report.json": "{}" });
  symlinkSync("/etc/hosts", path.join(dir, "hosts"));
  const s3 = fakeS3();
  await assert.rejects(upload({ env: uploadEnv(temp), s3For: () => s3 }), (e) => e instanceof UploadRefused && /symlinks \(hosts\)/.test(e.message));
  assert.deepEqual(s3.calls, []);
});

test("upload-results needs a run, the opt-in or Actions, and the secrets", async () => {
  const { temp } = runDirWith({});
  assert.match(await upload({ env: { ...uploadEnv(temp), GITHUB_RUN_ID: "5" }, s3For: () => fakeS3() }), /nothing to upload for run 5-1/);
  await assert.rejects(upload({ env: fakeEnv(), s3For: () => fakeS3() }), /runs only in GitHub Actions/);
  await assert.rejects(upload({ env: { ...uploadEnv(temp), JOURNEYS_RESULTS_BUCKET: "" }, s3For: () => fakeS3() }), /JOURNEYS_RESULTS_BUCKET is not set/);
});

test("secrets are never typed into a traced page, and secretFill sets the value in the page", async () => {
  const context = {};
  const calls = [];
  const locator = {
    page: () => ({ context: () => context }),
    focus: async () => calls.push("focus"),
    evaluate: async (fn, value) => {
      // Run the page function against a stand-in input
      const events = [];
      const proto = { set value(v) { this._v = v; } };
      const el = Object.assign(Object.create(proto), { dispatchEvent: (e) => events.push(e.type) });
      globalThis.Event ??= class { constructor(type) { this.type = type; } };
      fn(el, value);
      calls.push(["evaluate", el._v, events]);
    },
  };
  await secretFill(locator, "s3cret-value");
  assert.deepEqual(calls, ["focus", ["evaluate", "s3cret-value", ["input", "change"]]]);
  assert.doesNotThrow(() => assertNotTracing(context));
  markTracing(context);
  assert.throws(() => assertNotTracing(context, "a sign-in"), /Refusing to enter a sign-in while this page is being traced/);
  calls.length = 0;
  await assert.rejects(secretFill(locator, "s3cret-value"), /being traced/);
  assert.deepEqual(calls, [], "nothing typed");
  // Another context isn't affected
  assert.doesNotThrow(() => assertNotTracing({}));
});
