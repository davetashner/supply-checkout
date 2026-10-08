// Scrubbing Playwright traces before upload (lib/traces.mjs and upload-results.mjs), against a
// small fixture trace shaped like the ones Playwright writes (trace.trace, trace.network,
// resources/). Every value in it is fake.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { SENSITIVE_HEADERS, isAuthUrl, leakingEntries, scrubTrace, stripHeaders } from "../lib/traces.mjs";
import { UploadRefused, scrubTraces, upload } from "../upload-results.mjs";
import { fakeEnv, fakeS3 } from "./helpers.mjs";

const API = "https://api.example.test";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
// Built here so no token-shaped literal sits in the repository
const ACCESS = `${b64({ alg: "RS256", kid: "fake-key" })}.${b64({ sub: "fake-user", token_use: "access" })}.fake-signature-part`;
const REFRESH = "fake-refresh-cookie-value-0123";
const OTHER_COOKIE = "fake-other-cookie-value";

const h = (pairs) => Object.entries(pairs).map(([name, value]) => ({ name, value }));
const resource = (url, { request = {}, response = {}, postData, content = { size: 10, mimeType: "application/json" } } = {}) => ({
  type: "resource-snapshot",
  snapshot: {
    request: { method: postData ? "POST" : "GET", url, cookies: [{ name: "sc_refresh", value: REFRESH }], headers: h({ Accept: "*/*", ...request }), ...(postData ? { postData } : {}) },
    response: { status: 200, cookies: [{ name: "sc_refresh", value: REFRESH, path: "/auth", httpOnly: true }], headers: h({ "content-type": "application/json", ...response }), content },
  },
});

/** A trace.zip with an authorized API call, a refresh call with its body files, and trace events. */
function fixtureTrace() {
  const network = [
    resource(`${API}/teams/t1/items`, { request: { Authorization: `Bearer ${ACCESS}`, Cookie: `other=${OTHER_COOKIE}` }, content: { size: 12, mimeType: "application/json", _file: "resources/items.json" } }),
    resource(`${API}/auth/refresh`, {
      request: { cookie: `sc_refresh=${REFRESH}` },
      response: { "Set-Cookie": `sc_refresh=${REFRESH}; Path=/auth; HttpOnly` },
      postData: { mimeType: "application/json", text: "{}", _file: "resources/refresh-request.txt" },
      content: { size: 40, mimeType: "application/json", _sha1: "refresh-response" },
    }),
    resource(`${API}/auth/session`, { content: { size: 40, mimeType: "application/json", text: JSON.stringify({ accessToken: ACCESS }) } }),
  ];
  const events = [
    { type: "context-options", options: { extraHTTPHeaders: h({ "X-Extra": "1", AUTHORIZATION: `Bearer ${ACCESS}` }), storageState: { cookies: [{ name: "sc_refresh", value: REFRESH }] } } },
    { type: "before", callId: "call@1", class: "APIRequestContext", method: "fetch", params: { url: `${API}/me`, headers: { authorization: `Bearer ${ACCESS}`, accept: "*/*" } } },
    { type: "before", callId: "call@2", class: "BrowserContext", method: "addCookies", params: { cookies: [{ name: "sc_refresh", value: REFRESH }] } },
    { type: "frame-snapshot", snapshot: { html: ["DIV", {}, "Items"] } },
  ];
  const ndjson = (rows) => strToU8(`${rows.map((r) => JSON.stringify(r)).join("\n")}\nnot json ${REFRESH}\n`);
  return zipSync({
    "trace.trace": ndjson(events),
    "trace.network": ndjson(network),
    "trace.stacks": strToU8("{}"),
    "resources/items.json": strToU8('{"items":[]}'),
    "resources/refresh-request.txt": strToU8("{}"),
    "resources/refresh-response": strToU8(JSON.stringify({ accessToken: ACCESS })),
    "resources/page.jpeg": new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
  });
}

const text = (entries, name) => strFromU8(entries[name]);

test("a scrubbed trace has no Authorization, Cookie or Set-Cookie, no cookie lists and no /auth bodies", () => {
  const { zip, leaks, dropped } = scrubTrace(fixtureTrace(), [Buffer.from("Owner-password-fake")]);
  assert.deepEqual(leaks, []);
  assert.deepEqual(dropped, ["resources/refresh-request.txt", "resources/refresh-response"]);
  const entries = unzipSync(zip);
  assert.deepEqual(Object.keys(entries).sort(), ["resources/items.json", "resources/page.jpeg", "trace.network", "trace.stacks", "trace.trace"]);
  const all = Object.keys(entries).map((n) => text(entries, n)).join("\n");
  for (const secret of [ACCESS, REFRESH, OTHER_COOKIE, "sc_refresh", "storageState"]) assert.ok(!all.includes(secret), secret);
  assert.doesNotMatch(all, /"(authorization|cookie|set-cookie)"/i);
  // Everything else is kept: other headers, the non-auth body, the trace events themselves
  const network = text(entries, "trace.network").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(network.length, 3);
  assert.deepEqual(network[0].snapshot.request.headers, [{ name: "Accept", value: "*/*" }]);
  assert.deepEqual(network[0].snapshot.request.cookies, []);
  assert.equal(network[0].snapshot.response.content._file, "resources/items.json");
  assert.deepEqual(network[1].snapshot.request.postData, { mimeType: "application/json" });
  assert.deepEqual(network[1].snapshot.response.content, { size: 40, mimeType: "application/json" });
  assert.deepEqual(network[1].snapshot.response.headers, [{ name: "content-type", value: "application/json" }]);
  assert.deepEqual(network[2].snapshot.response.content, { size: 40, mimeType: "application/json" });
  const events = text(entries, "trace.trace").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(events[0].options, { extraHTTPHeaders: [{ name: "X-Extra", value: "1" }] });
  assert.deepEqual(events[1].params.headers, { accept: "*/*" });
  assert.deepEqual(events[2].params.cookies, []);
  assert.deepEqual(events[3], { type: "frame-snapshot", snapshot: { html: ["DIV", {}, "Items"] } });
  assert.equal(text(entries, "trace.stacks"), "{}");
});

test("a trace that still holds a secret or a JWT after scrubbing is named, by entry", () => {
  const pw = "Owner-password-fake-0123";
  const zip = zipSync({
    "trace.trace": strToU8(`${JSON.stringify({ type: "log", message: `typed ${pw}` })}\n`),
    "trace.network": strToU8(""),
    "resources/page.html": strToU8(`<p>${ACCESS}</p>`),
    "resources/ok.html": strToU8("<p>fine</p>"),
  });
  const { leaks } = scrubTrace(zip, [Buffer.from(pw)]);
  assert.deepEqual(leaks, ["resources/page.html", "trace.trace"]);
  assert.deepEqual(leakingEntries({ a: strToU8("eyJabc.eyJdef.ghi") }, []), []);
  assert.throws(() => scrubTrace(Buffer.from("PK not a zip")));
});

test("the helpers: which headers, which URLs", () => {
  assert.deepEqual(SENSITIVE_HEADERS, ["authorization", "proxy-authorization", "cookie", "set-cookie"]);
  assert.deepEqual(stripHeaders([{ name: "Cookie", value: "x" }, { name: "Accept" }, "s", 1, null]), [{ name: "Accept" }, "s", 1, null]);
  assert.deepEqual(stripHeaders({ cookies: "not a list", Headers: { "Set-Cookie": "x", "X-A": "1" } }), { cookies: "not a list", Headers: { "X-A": "1" } });
  for (const url of [`${API}/auth`, `${API}/auth/refresh`, "https://login.example.test/oauth2/token", "https://cognito-idp.us-east-1.amazonaws.com/"]) assert.ok(isAuthUrl(url), url);
  for (const url of [`${API}/authors`, `${API}/teams/auth/x`, "not a url", undefined]) assert.ok(!isAuthUrl(url), String(url));
});

function runDirWith(files) {
  const temp = mkdtempSync(path.join(tmpdir(), "traces-"));
  const dir = path.join(temp, "journeys-77-1");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return { temp, dir };
}
const uploadEnv = (temp) => fakeEnv({ GITHUB_ACTIONS: "true", CI: "true", GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "1", RUNNER_TEMP: temp });

test("upload-results uploads a trace only scrubbed, deletes one it can't unpack, and refuses one that leaks", async () => {
  const { temp, dir } = runDirWith({ "report.json": "{}", "test-results/a/trace.zip": fixtureTrace(), "test-results/b/trace.zip": "PK broken" });
  const s3 = fakeS3();
  const message = await upload({ env: uploadEnv(temp), s3For: () => s3 });
  assert.match(message, /\(2 files\).*deleted 1 trace\(s\) that couldn't be unpacked \(test-results\/b\/trace\.zip\)/);
  assert.deepEqual(s3.calls, [["upload", dir, "runs/77-1/"]]);
  assert.ok(!existsSync(path.join(dir, "test-results/b/trace.zip")));
  const entries = unzipSync(readFileSync(path.join(dir, "test-results/a/trace.zip")));
  assert.ok(!Object.values(entries).some((e) => Buffer.from(e).includes(REFRESH)));

  // The account's password in a trace (an evaluate's argument, say) refuses the whole upload
  const env = fakeEnv();
  const leaky = zipSync({ "trace.trace": strToU8(`${JSON.stringify({ type: "before", params: { arg: env.JOURNEYS_CREW_PASSWORD } })}\n`) });
  const bad = runDirWith({ "report.json": "{}", "test-results/a/trace.zip": leaky });
  const s3b = fakeS3();
  await assert.rejects(upload({ env: uploadEnv(bad.temp), s3For: () => s3b }), (e) => e instanceof UploadRefused && e.message.endsWith("is in test-results/a/trace.zip (trace.trace)") && !e.message.includes(env.JOURNEYS_CREW_PASSWORD));
  assert.deepEqual(s3b.calls, []);
  // Short or empty secrets are never needles; no zips, nothing to do
  assert.deepEqual(scrubTraces(dir, ["report.json"], ["", "abc", undefined]), []);
});
