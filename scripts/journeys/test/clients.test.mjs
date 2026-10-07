// node --test scripts/journeys/test/ (part of npm run test:scripts): TOTP, the Cognito, API and
// S3 clients, the run records, global setup and the results upload, against fakes.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
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
import { upload } from "../upload-results.mjs";
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

test("freshTotp never hands out a step twice, across processes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "totp-"));
  const stateFile = path.join(dir, "step");
  let t = 30_000 * 1000 + 5_000;
  const slept = [];
  const opts = { stateFile, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } };
  const secret = RFC_VECTOR;
  const a = await freshTotp(secret, opts);
  assert.equal(readFileSync(stateFile, "utf8"), String(stepAt(30_000 * 1000)));
  const b = await freshTotp(secret, opts);
  assert.notEqual(a, b);
  assert.equal(slept.length, 1);
  assert.equal(slept[0], 25_250);
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
  await s3.upload("/tmp/x", "runs/1/");
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

test("upload-results puts the run's directory under runs/<runId>/ in the results bucket, then deletes it", async () => {
  const env = fakeEnv({ GITHUB_ACTIONS: "true", CI: "true", GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "1", RUNNER_TEMP: "/runner" });
  const s3 = fakeS3();
  const removed = [];
  const message = await upload({ env, s3For: (b) => { assert.equal(b, env.JOURNEYS_RESULTS_BUCKET); return s3; }, exists: () => true, remove: (d) => removed.push(d) });
  assert.deepEqual(s3.calls, [["upload", "/runner/journeys-77-1", "runs/77-1/"]]);
  assert.deepEqual(removed, ["/runner/journeys-77-1"]);
  assert.ok(!message.includes(env.JOURNEYS_RESULTS_BUCKET));
  assert.match(await upload({ env, run: "5-1", s3For: () => s3, exists: () => false }), /nothing to upload for run 5-1/);
  await assert.rejects(upload({ env: fakeEnv(), s3For: () => s3 }), /runs only in GitHub Actions/);
  await assert.rejects(upload({ env: { ...env, JOURNEYS_RESULTS_BUCKET: "" }, s3For: () => s3 }), /JOURNEYS_RESULTS_BUCKET is not set/);
});
