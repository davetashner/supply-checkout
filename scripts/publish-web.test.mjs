// node --test scripts/publish-web.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { APPROVED_REGIONS, DEFAULT_REGION, DOMAIN, IMMUTABLE, REVALIDATE, VERSION, checkRouterResult, isMissing, configParameterNames, defaultVersion, envDomain, main, parseArgs, routerChecks, routerTestEvent, uploadCommands } from "./publish-web.mjs";

const STORE = "arn:aws:cloudfront::000000000000:key-value-store/example"; // public-safety: allow
const POOL_UUID = "11111111-2222-4333-8444-555555555555";
const APP_CONFIG = {
  apiUrl: `https://api.${DOMAIN}`,
  authUrl: `https://auth.${DOMAIN}`,
  clientId: "client-1",
  realtimeUrl: `wss://realtime.${DOMAIN}/event/realtime`,
  realtimeHost: `realtime.${DOMAIN}`,
  rumAppMonitorId: "0f1e2d3c-4b5a-4678-9abc-def012345678",
  rumIdentityPoolId: `${DEFAULT_REGION}:${POOL_UUID}`,
  rumRegion: DEFAULT_REGION,
};
const PARAMS = {
  "/supply-checkout/prod/web/bucket-name": "releases-bucket",
  "/supply-checkout/prod/web/bucket-region": "bucket-region-1",
  "/supply-checkout/prod/web/live-version-store-arn": STORE,
  ...Object.fromEntries(Object.entries(configParameterNames("prod")).map(([k, name]) => [name, APP_CONFIG[k]])),
};

function build() {
  const dir = mkdtempSync(path.join(tmpdir(), "publish-web-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html>");
  writeFileSync(path.join(dir, "assets", "index-abc.js"), "");
  return dir;
}

/** A fake AWS CLI: records every call, answers reads from `existing` demo and `apps` app releases. */
function fakeAws({ existing = [], apps = [], params = PARAMS, headError, listed = [], listError } = {}) {
  const calls = [];
  const log = [];
  const run = (cmd, args) => {
    assert.equal(cmd, "aws");
    calls.push(args);
    const [service, op] = args;
    if (service === "ssm" && op === "get-parameters") {
      const names = args.slice(args.indexOf("--names") + 1).filter((n) => n.startsWith("/"));
      return JSON.stringify({ Parameters: names.filter((n) => n in params).map((Name) => ({ Name, Value: params[Name] })) });
    }
    if (service === "s3api" && op === "head-object") {
      const key = args[args.indexOf("--key") + 1];
      if ([...existing, ...apps].some((v) => key === `releases/${v}/index.html`)) return "{}";
      if (apps.some((v) => key === `releases/${v}/config.json`)) return "{}";
      if (headError) throw headError;
      const e = new Error("Command failed: aws s3api head-object");
      e.stderr = "\nAn error occurred (404) when calling the HeadObject operation: Not Found\n";
      throw e;
    }
    if (op === "describe-key-value-store") return JSON.stringify({ ETag: "etag-1" });
    if (op === "list-keys") return JSON.stringify({ Items: [{ Key: "demo", Value: "d1" }] });
    if (op === "list-objects-v2" && args.includes("--max-keys")) {
      if (listError) throw listError;
      const prefix = args[args.indexOf("--prefix") + 1];
      return JSON.stringify({ KeyCount: listed.includes(prefix) ? 1 : 0 });
    }
    if (op === "list-objects-v2") return JSON.stringify({ CommonPrefixes: [{ Prefix: "releases/d1/" }] });
    return "";
  };
  return { calls, log, deps: { run, log: (m) => log.push(m), env: {} } };
}

const writes = (calls) => calls.filter(([, op]) => op === "sync" || op === "put-key");

test("publish uploads assets immutably, then index.html, then makes the release live", () => {
  const dir = build();
  const aws = fakeAws();
  main(["publish", "--channel", "demo", "--dir", dir, "--version", "demo-1"], aws.deps);
  const [assets, rest, put] = writes(aws.calls);
  assert.deepEqual(assets.slice(0, 4), ["s3", "sync", dir, "s3://releases-bucket/releases/demo-1/"]);
  assert.ok(assets.includes(IMMUTABLE) && assets.includes("assets/*"));
  assert.ok(rest.includes(REVALIDATE));
  for (const cmd of [assets, rest]) {
    assert.ok(cmd.includes("*.map"), "source maps stay local");
    assert.equal(cmd[cmd.indexOf("--region") + 1], "bucket-region-1");
  }
  assert.deepEqual(put.slice(0, 9), ["cloudfront-keyvaluestore", "put-key", "--kvs-arn", STORE, "--key", "demo", "--value", "demo-1", "--if-match"]);
  assert.equal(put[9], "etag-1");
});

test("publish refuses to overwrite a release, and can leave the new one unpublished", () => {
  const dir = build();
  const aws = fakeAws({ existing: ["demo-1"] });
  assert.throws(() => main(["publish", "--channel", "demo", "--dir", dir, "--version", "demo-1"], aws.deps), /already exists/);
  assert.deepEqual(writes(aws.calls), []);

  const quiet = fakeAws();
  main(["publish", "--channel", "app", "--dir", dir, "--version", "1.2.0", "--no-activate"], quiet.deps);
  assert.deepEqual(writes(quiet.calls).map(([, op]) => op), ["sync", "sync"]);
  assert.match(quiet.log.at(-1), /activate --channel app --version 1.2.0/);
});

test("publishing the app writes its config.json from the stacks' outputs first", () => {
  const dir = build();
  const aws = fakeAws();
  main(["publish", "--channel", "app", "--dir", dir, "--version", "app-1"], aws.deps);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8")), APP_CONFIG);
  // Not hashed, so browsers revalidate it like index.html
  assert.ok(writes(aws.calls)[1].includes(REVALIDATE));

  // The demo has no backend, and a dry run only says what it would write
  const demo = build();
  main(["publish", "--channel", "demo", "--dir", demo, "--version", "demo-9"], fakeAws().deps);
  assert.ok(!existsSync(path.join(demo, "config.json")));
  const dry = fakeAws();
  main(["publish", "--channel", "app", "--dir", demo, "--version", "app-2", "--dry-run"], dry.deps);
  assert.ok(!existsSync(path.join(demo, "config.json")));
  assert.ok(dry.log.some((l) => l.startsWith("Would write config.json") && l.includes('"clientId": "client-1"')));
});

test("config prints the app's config.json, and needs the stacks deployed", () => {
  const aws = fakeAws();
  main(["config"], aws.deps);
  assert.deepEqual(JSON.parse(aws.log[0]), APP_CONFIG);
  const bare = fakeAws({ params: {} });
  assert.throws(() => main(["config", "--env", "staging"], bare.deps), /realtime and web stacks first\): \/supply-checkout\/staging\/api\/url/);
});

test("the domain and regions match the deployment config in infra/lib/config.ts", () => {
  const source = readFileSync(new URL("../infra/lib/config.ts", import.meta.url), "utf8");
  assert.equal(DOMAIN, /DEFAULT_DOMAIN_NAME = "([^"]+)"/.exec(source)?.[1]);
  const approved = /APPROVED_REGIONS = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
  assert.deepEqual(APPROVED_REGIONS, [...approved.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  assert.equal(DEFAULT_REGION, /GLOBAL_SERVICES_REGION = "([^"]+)"/.exec(source)?.[1]);
  // The environment's domain, as envDomain in infra/lib/domain.ts builds it
  assert.equal(envDomain("prod"), DOMAIN);
  assert.equal(envDomain("staging"), `staging.${DOMAIN}`);
  for (const env of ["", "Prod", "a.b", "-x", "x/y", "a".repeat(17)]) assert.throws(() => envDomain(env), /--env/, env);
});

/** `config` with one SSM value changed refuses, naming that parameter. */
function refuses(key, value, env = "prod") {
  const names = configParameterNames(env);
  const domain = envDomain(env);
  const own = { ...APP_CONFIG, apiUrl: `https://api.${domain}`, authUrl: `https://auth.${domain}`, realtimeUrl: `wss://realtime.${domain}/event/realtime`, realtimeHost: `realtime.${domain}` };
  const params = { ...Object.fromEntries(Object.entries(names).map(([k, name]) => [name, own[k]])), [names[key]]: value };
  const aws = fakeAws({ params });
  assert.throws(() => main(["config", "--env", env], aws.deps), (e) => e.message.includes(names[key]), `${key} ${JSON.stringify(value)}`);
}

test("config trusts only the hosts the deployment config names, never a host from SSM (supply-checkout-6uw.23)", () => {
  // The browser signs in at authUrl, and sends its tokens to apiUrl and realtimeUrl
  const https = (label) => [`https://${label}.evil.example`, `https://${label}.${DOMAIN}.evil.example`, `https://${label}.evil.${DOMAIN}`, `http://${label}.${DOMAIN}`, `https://${label}.${DOMAIN}/`, `https://${label}.${DOMAIN}/x`, `https://${label}.${DOMAIN}:8443`, `https://x${label}.${DOMAIN}`, ""];
  for (const v of https("api")) refuses("apiUrl", v);
  for (const v of [...https("auth"), `https://ops-auth.${DOMAIN}`]) refuses("authUrl", v);
  // An API URL on another domain doesn't vouch for a sign-in URL on that domain
  const names = configParameterNames("prod");
  const moved = fakeAws({ params: { ...PARAMS, [names.apiUrl]: "https://api.evil.example", [names.authUrl]: "https://auth.evil.example" } });
  assert.throws(() => main(["config"], moved.deps), /api\/url/);
  const host = `realtime.${DOMAIN}`;
  for (const v of ["wss://realtime.evil.example/event/realtime", `wss://${host}.evil.example/event/realtime`, `ws://${host}/event/realtime`, `https://${host}/event/realtime`, `wss://${host}/event/realtime/`, `wss://${host}/event`, `wss://${host}/event/realtime?x=1`, `wss://${host}:444/event/realtime`, `wss://${host}`, ""]) {
    refuses("realtimeUrl", v);
  }
  for (const v of ["realtime.evil.example", `${host}.evil.example`, `${host}:443`, `${host}/`, `x${host}`, `wss://${host}`, ""]) refuses("realtimeHost", v);
  // Another environment's hosts are on its own domain
  const stagingNames = configParameterNames("staging");
  const own = { ...APP_CONFIG, apiUrl: `https://api.staging.${DOMAIN}`, authUrl: `https://auth.staging.${DOMAIN}`, realtimeUrl: `wss://realtime.staging.${DOMAIN}/event/realtime`, realtimeHost: `realtime.staging.${DOMAIN}` };
  const staging = fakeAws({ params: Object.fromEntries(Object.entries(stagingNames).map(([k, name]) => [name, own[k]])) });
  main(["config", "--env", "staging"], staging.deps);
  assert.deepEqual(JSON.parse(staging.log[0]), own);
  refuses("apiUrl", `https://api.${DOMAIN}`, "staging");
  refuses("realtimeHost", host, "staging");
});

test("config checks the RUM values: the web stack's region, and AWS's ID formats (supply-checkout-6uw.23)", () => {
  const other = APPROVED_REGIONS.find((r) => r !== DEFAULT_REGION);
  for (const v of ["", "evil-region-1", other, `${DEFAULT_REGION} `, DEFAULT_REGION.toUpperCase()]) refuses("rumRegion", v);
  for (const v of ["", "monitor-1", APP_CONFIG.rumAppMonitorId.toUpperCase(), APP_CONFIG.rumAppMonitorId.slice(1), `${APP_CONFIG.rumAppMonitorId}0`, APP_CONFIG.rumAppMonitorId.replace(/-/g, "")]) {
    refuses("rumAppMonitorId", v);
  }
  for (const v of ["", "pool-1", POOL_UUID, `${other}:${POOL_UUID}`, `${DEFAULT_REGION}:pool-1`, `${DEFAULT_REGION}:${POOL_UUID}:x`]) refuses("rumIdentityPoolId", v);
  // --region says where the web stack is, so the RUM region must follow it, and be an approved region
  const names = configParameterNames("prod");
  const moved = fakeAws({ params: { ...PARAMS, [names.rumRegion]: other, [names.rumIdentityPoolId]: `${other}:${POOL_UUID}` } });
  main(["config", "--region", other], moved.deps);
  assert.equal(JSON.parse(moved.log[0]).rumRegion, other);
  assert.throws(() => main(["config", "--region", "evil-region-1"], fakeAws({ params: { ...PARAMS, [names.rumRegion]: "evil-region-1", [names.rumIdentityPoolId]: `evil-region-1:${POOL_UUID}` } }).deps), /rum-region/);
});

test("publish needs a built folder", () => {
  const aws = fakeAws();
  const empty = mkdtempSync(path.join(tmpdir(), "publish-web-"));
  assert.throws(() => main(["publish", "--channel", "demo", "--dir", empty], aws.deps), /npm run build:demo/);
});

test("a dry run prints the writes and changes nothing", () => {
  const dir = build();
  const aws = fakeAws();
  main(["publish", "--channel", "demo", "--dir", dir, "--version", "demo-2", "--dry-run"], aws.deps);
  assert.deepEqual(writes(aws.calls), []);
  assert.equal(aws.log.filter((l) => l.startsWith("$ aws ")).length, 3);
});

test("activate switches to an existing release only", () => {
  const aws = fakeAws({ apps: ["1.1.0"] });
  main(["activate", "--channel", "app", "--version", "1.1.0"], aws.deps);
  assert.equal(writes(aws.calls).length, 1);
  const demo = fakeAws({ existing: ["demo-1"] });
  main(["activate", "--channel", "demo", "--version", "demo-1"], demo.deps);
  assert.equal(writes(demo.calls).length, 1);
  assert.throws(() => main(["activate", "--channel", "app", "--version", "9.9.9"], fakeAws().deps), /No release 9\.9\.9/);
});

test("activate refuses a release from the other channel", () => {
  // An app release (it has config.json) never goes live at /demo/
  const app = fakeAws({ apps: ["1.1.0"] });
  assert.throws(() => main(["activate", "--channel", "demo", "--version", "1.1.0"], app.deps), /1\.1\.0 is an app release .*demo channel/);
  assert.deepEqual(writes(app.calls), []);
  // Nor a demo release on app.
  const demo = fakeAws({ existing: ["demo-1"] });
  assert.throws(() => main(["activate", "--channel", "app", "--version", "demo-1"], demo.deps), /demo-1 is a demo release .*app channel/);
  assert.deepEqual(writes(demo.calls), []);
});

test("publish --reuse makes an existing release live again, without uploading, on its own channel only", () => {
  const dir = build();
  const app = fakeAws({ apps: ["app-v1.0.0"] });
  main(["publish", "--channel", "app", "--dir", dir, "--version", "app-v1.0.0", "--reuse"], app.deps);
  assert.deepEqual(writes(app.calls).map(([, op]) => op), ["put-key"]);
  assert.ok(!existsSync(path.join(dir, "config.json")), "no config.json written for a release that isn't uploaded");
  assert.match(app.log[0], /already exists, so it isn't uploaded again/);
  const quiet = fakeAws({ apps: ["app-v1.0.0"] });
  main(["publish", "--channel", "app", "--dir", dir, "--version", "app-v1.0.0", "--reuse", "--no-activate"], quiet.deps);
  assert.deepEqual(writes(quiet.calls), []);
  const wrong = fakeAws({ existing: ["demo-v1.0.0"] });
  assert.throws(() => main(["publish", "--channel", "app", "--dir", dir, "--version", "demo-v1.0.0", "--reuse"], wrong.deps), /is a demo release/);
  assert.deepEqual(writes(wrong.calls), []);
  // A new release still uploads
  const fresh = fakeAws();
  main(["publish", "--channel", "demo", "--dir", build(), "--version", "demo-v2.0.0", "--reuse"], fresh.deps);
  assert.deepEqual(writes(fresh.calls).map(([, op]) => op), ["sync", "sync", "put-key"]);
});

test("a release is missing only on S3's 404 or 403; any other error stops the publish", () => {
  const err = (stderr) => Object.assign(new Error("Command failed"), { stderr });
  assert.equal(isMissing(err("An error occurred (404) when calling the HeadObject operation: Not Found")), true);
  assert.equal(isMissing(err("An error occurred (403) when calling the HeadObject operation: Forbidden")), true);
  assert.equal(isMissing(err("An error occurred (ExpiredToken) when calling the HeadObject operation: expired")), false);
  assert.equal(isMissing(err("Could not connect to the endpoint URL")), false);
  assert.equal(isMissing(undefined), false);
  // A 403 is missing only if a listing with the key as prefix finds nothing
  const forbidden = fakeAws({ headError: err("An error occurred (403) when calling the HeadObject operation: Forbidden") });
  main(["publish", "--channel", "demo", "--dir", build(), "--version", "demo-5"], forbidden.deps);
  assert.deepEqual(writes(forbidden.calls).map(([, op]) => op), ["sync", "sync", "put-key"]);
  assert.ok(forbidden.calls.some((c) => c[1] === "list-objects-v2" && c.includes("releases/demo-5/index.html") && c.includes("--max-keys")));
  const hidden = fakeAws({ headError: err("An error occurred (403) when calling the HeadObject operation: Forbidden"), listed: ["releases/demo-7/index.html"] });
  assert.throws(() => main(["publish", "--channel", "demo", "--dir", build(), "--version", "demo-7"], hidden.deps), /is there, but this role may not read it/);
  assert.deepEqual(writes(hidden.calls), []);
  const noList = fakeAws({ headError: err("An error occurred (403) when calling the HeadObject operation: Forbidden"), listError: err("An error occurred (AccessDenied) when calling the ListObjectsV2 operation") });
  assert.throws(() => main(["publish", "--channel", "demo", "--dir", build(), "--version", "demo-8"], noList.deps), /Couldn't check .*AccessDenied/);
  assert.deepEqual(writes(noList.calls), []);
  // A 404 needs no listing
  const gone = fakeAws();
  main(["publish", "--channel", "demo", "--dir", build(), "--version", "demo-9"], gone.deps);
  assert.ok(!gone.calls.some((c) => c[1] === "list-objects-v2"));
  const expired = fakeAws({ headError: err("An error occurred (ExpiredToken) when calling the HeadObject operation: The provided token has expired.") });
  assert.throws(() => main(["publish", "--channel", "demo", "--dir", build(), "--version", "demo-6"], expired.deps), /Couldn't check s3:\/\/releases-bucket\/releases\/demo-6\/index.html: An error occurred \(ExpiredToken\)/);
  assert.deepEqual(writes(expired.calls), []);
});

test("live prints a channel's live version, or none", () => {
  const aws = fakeAws();
  main(["live", "--channel", "demo"], aws.deps);
  assert.deepEqual(aws.log, ["d1"]);
  const app = fakeAws();
  main(["live", "--channel", "app"], app.deps);
  assert.deepEqual(app.log, ["none"]);
  assert.throws(() => parseArgs(["live"], {}), /--channel/);
});

test("publishing the demo refuses an app build (a folder with config.json)", () => {
  const dir = build();
  writeFileSync(path.join(dir, "config.json"), "{}");
  const aws = fakeAws();
  assert.throws(() => main(["publish", "--channel", "demo", "--dir", dir, "--version", "demo-3"], aws.deps), /has a config\.json/);
  assert.deepEqual(writes(aws.calls), []);
});

test("status lists live versions and releases", () => {
  const aws = fakeAws();
  main(["status"], aws.deps);
  assert.deepEqual(aws.log, ["live  demo: d1", "release  d1"]);
});

test("reports missing stack parameters", () => {
  const aws = fakeAws();
  const run = aws.deps.run;
  aws.deps.run = (cmd, args, o) => (args[1] === "get-parameters" ? JSON.stringify({ Parameters: [] }) : run(cmd, args, o));
  assert.throws(() => main(["status"], aws.deps), /deploy the web stack first/);
});

const ALIASES = ["supplycheckout.com", "www.supplycheckout.com", "app.supplycheckout.com"];
const ROUTER_PARAMS = {
  ...PARAMS,
  "/supply-checkout/prod/web/router-function-name": "router-fn",
  "/supply-checkout/prod/web/distribution-id": "DIST1",
};

/** What a working router answers (infra/lib/web/router.js), with `live` versions per channel. */
function workingRouter({ app = "1.3.0", demo = "demo-1" } = {}) {
  const serve = (version, uri) =>
    version ? { request: { uri: `/releases/${version}${uri}index.html` } } : { response: { statusCode: 503 } };
  return ({ host, uri }) => {
    if (host.startsWith("app.")) return serve(app, uri);
    if (host.startsWith("www.")) return { response: { statusCode: 301 } };
    if (uri.startsWith("/demo/")) return serve(demo, "/");
    return { response: { statusCode: 302 } };
  };
}

/** A fake AWS CLI for check-router: `router` answers each test event, or `error` fails every one. */
function fakeCloudFront({ router = workingRouter(), error, params = ROUTER_PARAMS } = {}) {
  const aws = fakeAws({ params });
  const run = aws.deps.run;
  const events = [];
  aws.deps.run = (cmd, args, o) => {
    const [service, op] = args;
    if (service !== "cloudfront") return run(cmd, args, o);
    aws.calls.push(args);
    if (op === "get-distribution-config") return JSON.stringify({ ETag: "d", DistributionConfig: { Aliases: { Quantity: 3, Items: ALIASES } } });
    if (op === "describe-function") return JSON.stringify({ ETag: "fn-etag" });
    assert.equal(op, "test-function");
    assert.equal(args[args.indexOf("--if-match") + 1], "fn-etag");
    assert.equal(args[args.indexOf("--stage") + 1], "LIVE");
    const file = args[args.indexOf("--event-object") + 1];
    assert.match(file, /^fileb:\/\//);
    const event = JSON.parse(readFileSync(file.slice("fileb://".length), "utf8"));
    assert.equal(event.context.eventType, "viewer-request");
    const request = { host: event.request.headers.host.value, uri: event.request.uri };
    events.push(request);
    const TestResult = error
      ? { FunctionErrorMessage: error, FunctionOutput: "" }
      : { FunctionErrorMessage: "", FunctionOutput: JSON.stringify(router(request)) };
    return JSON.stringify({ TestResult });
  };
  return { ...aws, events };
}

test("check-router runs the live router on a request to each host", () => {
  const aws = fakeCloudFront();
  main(["check-router"], aws.deps);
  assert.deepEqual(aws.events, [
    { host: "app.supplycheckout.com", uri: "/" },
    { host: "supplycheckout.com", uri: "/demo/" },
    { host: "supplycheckout.com", uri: "/" },
    { host: "www.supplycheckout.com", uri: "/" },
  ]);
  assert.deepEqual(aws.log, [
    "ok  app.supplycheckout.com/ -> /releases/1.3.0/index.html",
    "ok  supplycheckout.com/demo/ -> /releases/demo-1/index.html",
    "ok  supplycheckout.com/ -> 302",
    "ok  www.supplycheckout.com/ -> 301",
    "The live router (router-fn) works.",
  ]);
  const fn = aws.calls.find(([, op]) => op === "describe-function");
  assert.equal(fn[fn.indexOf("--name") + 1], "router-fn");
  // Nothing live on a channel is a 503, which the router means
  const empty = fakeCloudFront({ router: workingRouter({ app: null }) });
  main(["check-router"], empty.deps);
  assert.equal(empty.log[0], "ok  app.supplycheckout.com/ -> 503 (nothing live on this channel)");
});

test("check-router fails when the router throws or answers wrong", () => {
  assert.throws(
    () => main(["check-router"], fakeCloudFront({ error: "SyntaxError: Unexpected token" }).deps),
    /The router failed on app\.supplycheckout\.com\/: SyntaxError/,
  );
  const redirectsApp = fakeCloudFront({ router: () => ({ response: { statusCode: 302 } }) });
  assert.throws(() => main(["check-router"], redirectsApp.deps), /answered app\.supplycheckout\.com\/ with 302, not a release/);
  const servesWww = fakeCloudFront({ router: ({ host }) => (host.startsWith("www.") ? { request: { uri: "/x" } } : workingRouter()({ host, uri: "/demo/" })) });
  assert.throws(() => main(["check-router"], servesWww.deps), /answered supplycheckout\.com\/ with \/releases\/.*, not 302/);
  const garbled = fakeCloudFront({ router: () => undefined });
  assert.throws(() => main(["check-router"], garbled.deps), /no readable output/);
  assert.throws(() => main(["check-router"], fakeCloudFront({ params: PARAMS }).deps), /deploy the web stack first\): \/supply-checkout\/prod\/web\/router-function-name/);
});

test("check-router needs the app., www. and apex aliases", () => {
  assert.equal(routerChecks(["a.test", "www.a.test", "app.a.test"]).length, 4);
  assert.throws(() => routerChecks(["www.a.test", "app.a.test"]), /Expected app\., www\. and apex aliases/);
  assert.throws(() => routerChecks([]), /\(got none\)/);
  assert.deepEqual(routerTestEvent("a.test", "/").request.headers, { host: { value: "a.test" } });
  assert.throws(() => checkRouterResult({ host: "a.test", uri: "/", expect: 302 }, undefined), /no readable output/);
});

test("parses and checks options", () => {
  assert.equal(parseArgs(["check-router"], {}).command, "check-router");
  assert.deepEqual(parseArgs(["status"], {}), {
    command: "status", env: "prod", profile: "supply-prod", region: parseArgs(["status"], {}).region, activate: true, dryRun: false,
  });
  assert.equal(parseArgs(["status"], { AWS_PROFILE: "other" }).profile, "other");
  assert.equal(parseArgs(["status", "--env", "staging", "--profile", "p", "--region", "r"], {}).env, "staging");
  assert.throws(() => parseArgs(["deploy"], {}), /Usage/);
  assert.throws(() => parseArgs(["publish", "--channel", "beta", "--dir", "d"], {}), /--channel/);
  assert.throws(() => parseArgs(["publish", "--channel", "demo"], {}), /--dir/);
  assert.throws(() => parseArgs(["activate", "--channel", "demo"], {}), /--version is required/);
  assert.throws(() => parseArgs(["activate", "--channel", "demo", "--version", "../x"], {}), /--version must/);
  assert.throws(() => parseArgs(["activate", "--channel", "demo", "--version", "none"], {}), /reserved/);
  assert.throws(() => parseArgs(["status", "--version"], {}), /needs a value/);
  assert.throws(() => parseArgs(["status", "--bogus"], {}), /Unknown option/);
});

test("default versions name the channel, time and commit, and pass the router's check", () => {
  const v = defaultVersion("demo", new Date("2026-09-26T14:15:00Z"), "5fb80a0");
  assert.equal(v, "demo-20260926-141500-5fb80a0");
  assert.match(v, VERSION);
  assert.equal(defaultVersion("app", new Date("2026-09-26T14:15:00Z"), ""), "app-20260926-141500");
});

test("uses the same version pattern as the router function", () => {
  const router = readFileSync(new URL("../infra/lib/web/router.js", import.meta.url), "utf8");
  assert.ok(router.includes(`const VERSION = ${VERSION};`));
});

test("upload commands put everything under releases/<version>/", () => {
  const cmds = uploadCommands({ dir: "d", version: "v1", bucket: "b", bucketRegion: "r", profile: "p" });
  for (const c of cmds) assert.equal(c[3], "s3://b/releases/v1/");
});
