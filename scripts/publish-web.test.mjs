// node --test scripts/publish-web.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { IMMUTABLE, REVALIDATE, VERSION, checkRouterResult, configParameterNames, defaultVersion, main, parseArgs, routerChecks, routerTestEvent, uploadCommands } from "./publish-web.mjs";

const STORE = "arn:aws:cloudfront::000000000000:key-value-store/example"; // public-safety: allow
const APP_CONFIG = {
  apiUrl: "https://api.example.test",
  authUrl: "https://auth.example.test",
  clientId: "client-1",
  realtimeUrl: "wss://realtime.example.test/event/realtime",
  realtimeHost: "realtime.example.test",
  rumAppMonitorId: "monitor-1",
  rumIdentityPoolId: "rum-region-1:pool-1",
  rumRegion: "rum-region-1",
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
function fakeAws({ existing = [], apps = [], params = PARAMS } = {}) {
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
      throw new Error("404");
    }
    if (op === "describe-key-value-store") return JSON.stringify({ ETag: "etag-1" });
    if (op === "list-keys") return JSON.stringify({ Items: [{ Key: "demo", Value: "d1" }] });
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
