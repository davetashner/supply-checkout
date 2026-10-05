#!/usr/bin/env node
// Uploads a web build as a release and makes it live (supply-checkout-qk1).
//
//   node scripts/publish-web.mjs publish  --channel demo --dir dist/demo [--version V] [--no-activate] [--reuse]
//   node scripts/publish-web.mjs publish  --channel ops --dir dist/ops   the operator page, at ops.<env domain>
//   node scripts/publish-web.mjs publish  --channel site --dir dist/site the marketing home page, at the apex (npm run publish:site)
//   node scripts/publish-web.mjs activate --channel app --version V     switch (or roll back) the live release
//   node scripts/publish-web.mjs live     --channel app                 print the channel's live version ("none" if nothing)
//   node scripts/publish-web.mjs status                                  live versions and uploaded releases
//   node scripts/publish-web.mjs config [--channel ops]                  print the app's config.json (or the ops page's)
//   node scripts/publish-web.mjs check-router                            run the live router on test requests
//
// Common options: --env prod (default), --profile supply-prod (default: $AWS_PROFILE, else
// supply-prod), --region <the web stack's region> (default: GLOBAL_SERVICES_REGION in
// infra/lib/config.ts), --dry-run (print the AWS CLI commands instead of running them).
//
// --reuse (the deploy workflow, .github/workflows/deploy.yml): when the release already exists,
// make it live again instead of failing, so deploying a release twice, or an older one, works.
// It never uploads over an existing release, and the channel check of `activate` still applies.
//
// Channels: "site" is the marketing home page, at the apex's / (its build has site-release.json),
// "demo" is served at the apex's /demo/, "app" at app. (infra/lib/web/router.js), and
// "ops", the operator page (supply-checkout-gxlt), at ops. by its own distribution and router
// (infra/lib/web/ops-router.js), which serves only releases named ops-*. So ops releases must be
// named ops-* (the default version is), and app and demo releases mustn't be.
// A release is uploaded once to s3://<bucket>/releases/<version>/ and never changed;
// publishing an existing version fails. Making it live is one write to the CloudFront
// KeyValueStore the router function reads (infra/lib/web/router.js), which reaches every
// edge within seconds and needs no invalidation. Rolling back is `activate` with the
// previous version.
//
// The app channel's release also gets config.json, which tells the web build where the
// environment's API, sign-in and live updates are (src/aws/main.js). It's written into
// --dir before the upload, from the SSM parameters the api, identity, realtime and web
// stacks publish, so one build works in every environment and no IDs are in the repository.
// config.json is also how a release's channel is told: app releases have it and demo
// releases don't (publishing the demo refuses a folder that has one), and `activate`
// refuses a release from the other channel, so the app build and its config.json are
// never served at the apex's /demo/, nor the demo at app.
//
// The ops channel's release gets ops-config.json instead (the API, the operator pool's sign-in
// host and the ops client ID, from the identity and api stacks' SSM outputs, hosts checked
// against the deployment config), which also marks it as an ops release.
//
// check-router runs the router CloudFront Function's LIVE stage (`aws cloudfront
// test-function`) on a request to each host, and fails if it throws or answers wrong. Run it
// after every deploy of the web stack: a router that doesn't run answers 503 to every request
// (supply-checkout-3sv.2, docs/observability.md "When the web app is down").
//
// Needs the AWS CLI v2 (the KeyValueStore API uses SigV4A, which v2 includes).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CHANNELS = ["app", "demo", "ops", "site"];
/** The operator page's channel: its releases, and only its, are named ops-* (infra/lib/web/ops-router.js). */
export const OPS_VERSION = /^ops-[A-Za-z0-9._-]{1,124}$/;
// Same pattern as infra/lib/web/router.js, which refuses anything else
export const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// The deployment config, in step with infra/lib/config.ts (publish-web.test.mjs checks):
// where the web stack, its SSM parameters and the KeyValueStore are (GLOBAL_SERVICES_REGION),
// the regions an environment may use (APPROVED_REGIONS), and the domain (DEFAULT_DOMAIN_NAME).
// config.json's hosts come from these, not from SSM (supply-checkout-6uw.23).
export const DEFAULT_REGION = "us-east-1";
export const APPROVED_REGIONS = ["us-east-1", "us-west-2"];
export const DOMAIN = "supplycheckout.com";
// envName in infra/lib/config.ts validateConfig
const ENV = /^[a-z][a-z0-9-]{0,15}$/;

/** The environment's domain, as envDomain in infra/lib/domain.ts builds it. */
export function envDomain(envName) {
  if (!ENV.test(envName)) throw new Error(`--env must be lowercase letters, digits or dashes (got "${envName}")`);
  return envName === "prod" ? DOMAIN : `${envName}.${DOMAIN}`;
}

/** Hashed files: cached for a year everywhere. */
export const IMMUTABLE = "public, max-age=31536000, immutable";
/**
 * Everything else (index.html): browsers revalidate on every load, because the URL they
 * cache (/) serves whichever release is live. The edge may keep it, since each release's
 * copy has its own cache key and never changes.
 */
export const REVALIDATE = "public, max-age=0, must-revalidate, s-maxage=31536000";

export function parseArgs(argv, env = process.env) {
  const [command, ...rest] = argv;
  const opts = {
    command,
    env: "prod",
    profile: env.AWS_PROFILE || "supply-prod",
    region: DEFAULT_REGION,
    activate: true,
    dryRun: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = () => {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--channel") opts.channel = value();
    else if (arg === "--dir") opts.dir = value();
    else if (arg === "--version") opts.version = value();
    else if (arg === "--env") opts.env = value();
    else if (arg === "--profile") opts.profile = value();
    else if (arg === "--region") opts.region = value();
    else if (arg === "--no-activate") opts.activate = false;
    else if (arg === "--reuse") opts.reuse = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!["publish", "activate", "live", "status", "config", "check-router"].includes(command)) throw new Error("Usage: publish-web.mjs publish|activate|live|status|config|check-router [options]");
  if (!["status", "config", "check-router"].includes(command) && !CHANNELS.includes(opts.channel)) throw new Error(`--channel must be one of ${CHANNELS.join(", ")}`);
  if (command === "config" && opts.channel !== undefined && !["app", "ops"].includes(opts.channel)) throw new Error("config --channel must be app or ops");
  if (command === "publish" && !opts.dir) throw new Error("--dir is required (the built folder, e.g. dist/demo)");
  if (command === "activate" && !opts.version) throw new Error("--version is required");
  if (opts.version !== undefined && !VERSION.test(opts.version)) {
    throw new Error(`--version must be letters, digits, dots, dashes or underscores (got "${opts.version}")`);
  }
  if (opts.version === "none") throw new Error('"none" is reserved: it means nothing is live');
  if (opts.version !== undefined && opts.channel !== undefined && (opts.channel === "ops") !== OPS_VERSION.test(opts.version)) {
    throw new Error(opts.channel === "ops" ? `Operator page releases are named ops-<something> (got "${opts.version}")` : `ops-* releases are the operator page's; pick another --version for ${opts.channel}`);
  }
  return opts;
}

/** <channel>-<UTC date and time>-<git commit>, e.g. demo-20260926-141500-5fb80a0. */
export function defaultVersion(channel, now = new Date(), commit = gitCommit()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return [channel, stamp, commit].filter(Boolean).join("-");
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export const parameterNames = (envName) => ({
  bucket: `/supply-checkout/${envName}/web/bucket-name`,
  bucketRegion: `/supply-checkout/${envName}/web/bucket-region`,
  store: `/supply-checkout/${envName}/web/live-version-store-arn`,
});

/** The AWS CLI commands that upload a build to releases/<version>/. */
export function uploadCommands({ dir, version, bucket, bucketRegion, profile }) {
  const dest = `s3://${bucket}/releases/${version}/`;
  const common = ["--profile", profile, "--region", bucketRegion, "--only-show-errors"];
  return [
    // Hashed assets first, so index.html never points at a file that isn't there yet
    ["s3", "sync", dir, dest, "--exclude", "*", "--include", "assets/*", "--exclude", "*.map", "--cache-control", IMMUTABLE, ...common],
    ["s3", "sync", dir, dest, "--exclude", "assets/*", "--exclude", "*.map", "--cache-control", REVALIDATE, ...common],
  ];
}

/**
 * Where the app's config.json values come from: the api, identity, realtime and web stacks'
 * outputs. The rum* values tell the app where to report its errors and page performance
 * (CloudWatch RUM, src/aws/rum.js); `ssm get-parameters` takes at most 10 names.
 */
export const configParameterNames = (envName) => ({
  apiUrl: `/supply-checkout/${envName}/api/url`,
  authUrl: `/supply-checkout/${envName}/identity/auth-url`,
  clientId: `/supply-checkout/${envName}/identity/web-client-id`,
  realtimeUrl: `/supply-checkout/${envName}/realtime/websocket-url`,
  realtimeHost: `/supply-checkout/${envName}/realtime/host`,
  rumAppMonitorId: `/supply-checkout/${envName}/web/rum-app-monitor-id`,
  rumIdentityPoolId: `/supply-checkout/${envName}/web/rum-identity-pool-id`,
  rumRegion: `/supply-checkout/${envName}/web/rum-region`,
});

/** The web build's config.json for an environment (src/aws/main.js reads it). */
export function appConfig(aws, envName) {
  const domain = envDomain(envName);
  const names = configParameterNames(envName);
  const res = aws.read(["ssm", "get-parameters", "--names", ...Object.values(names)]);
  const values = Object.fromEntries((res?.Parameters ?? []).map((p) => [p.Name, p.Value]));
  const missing = Object.values(names).filter((n) => !values[n]);
  if (missing.length) {
    throw new Error(`Missing SSM parameters (deploy the api, identity, realtime and web stacks first): ${missing.join(", ")}`);
  }
  const config = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, values[name]]));
  // The browser signs in at authUrl and sends the user's tokens to apiUrl and realtimeUrl, so a rewritten parameter
  // mustn't point any of them elsewhere (supply-checkout-6uw.23). Each host is the one the stacks build from the
  // deployment config (infra/lib/domain.ts hostNames), never one taken from SSM
  const expected = {
    apiUrl: `https://api.${domain}`,
    authUrl: `https://auth.${domain}`,
    realtimeUrl: `wss://realtime.${domain}/event/realtime`,
    realtimeHost: `realtime.${domain}`,
    // RUM reports to the web stack's region, the one these parameters were read from
    rumRegion: aws.region,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (config[key] !== value) throw new Error(`${names[key]} must be ${value} (got ${JSON.stringify(config[key])})`);
  }
  if (!APPROVED_REGIONS.includes(config.rumRegion)) throw new Error(`${names.rumRegion} must be one of ${APPROVED_REGIONS.join(", ")} (got ${JSON.stringify(config.rumRegion)})`);
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  if (!new RegExp(`^${uuid}$`).test(config.rumAppMonitorId)) throw new Error(`${names.rumAppMonitorId} must be an app monitor ID (a lowercase UUID)`);
  if (!new RegExp(`^${config.rumRegion}:${uuid}$`).test(config.rumIdentityPoolId)) {
    throw new Error(`${names.rumIdentityPoolId} must be an identity pool ID in ${config.rumRegion} (${config.rumRegion}:<UUID>)`);
  }
  return config;
}

/** The operator page's ops-config.json values: the identity and api stacks' outputs. */
export const opsConfigParameterNames = (envName) => ({
  apiUrl: `/supply-checkout/${envName}/api/url`,
  authUrl: `/supply-checkout/${envName}/identity/ops-auth-url`,
  clientId: `/supply-checkout/${envName}/identity/ops-client-id`,
});

/**
 * The operator page's ops-config.json for an environment (ops/lib/config.js reads it). The page
 * sends an operator's token to apiUrl and signs in at authUrl, so both must be this
 * environment's hosts, as the stacks build them, whatever SSM says (as for the app's).
 */
export function opsConfig(aws, envName) {
  const domain = envDomain(envName);
  const names = opsConfigParameterNames(envName);
  const res = aws.read(["ssm", "get-parameters", "--names", ...Object.values(names)]);
  const values = Object.fromEntries((res?.Parameters ?? []).map((p) => [p.Name, p.Value]));
  const missing = Object.values(names).filter((n) => !values[n]);
  if (missing.length) throw new Error(`Missing SSM parameters (deploy the api and identity stacks first): ${missing.join(", ")}`);
  const config = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, values[name]]));
  const expected = { apiUrl: `https://api.${domain}`, authUrl: `https://ops-auth.${domain}` };
  for (const [key, value] of Object.entries(expected)) {
    if (config[key] !== value) throw new Error(`${names[key]} must be ${value} (got ${JSON.stringify(config[key])})`);
  }
  if (!/^[A-Za-z0-9]{1,128}$/.test(config.clientId)) throw new Error(`${names.clientId} must be a Cognito app client ID`);
  return config;
}

/** Where check-router finds the routers and the distribution's hosts: the web stack's outputs. */
export const routerParameterNames = (envName) => ({
  functionName: `/supply-checkout/${envName}/web/router-function-name`,
  distributionId: `/supply-checkout/${envName}/web/distribution-id`,
  opsFunctionName: `/supply-checkout/${envName}/web/ops-router-function-name`,
});

/** What the operator page's router must answer on ops.<domain>: the page (or 503), and 404 for anything else. */
export const opsRouterChecks = (envName) => {
  const host = `ops.${envDomain(envName)}`;
  return [
    { host, uri: "/", expect: "serve" },
    { host, uri: "/config.json", expect: 404 },
  ];
};

/** A viewer-request event for `aws cloudfront test-function`. */
export function routerTestEvent(host, uri) {
  return {
    version: "1.0",
    context: { eventType: "viewer-request" },
    viewer: { ip: "198.51.100.10" },
    request: { method: "GET", uri, querystring: {}, headers: { host: { value: host } }, cookies: {} },
  };
}

/**
 * The requests check-router makes, and what each must get: a channel is served (the path
 * rewritten into releases/) or, with nothing live, a 503; the apex home page and www.
 * redirect. Hosts are the distribution's aliases: app.<domain>, www.<domain> and <domain>.
 */
export function routerChecks(aliases) {
  const app = aliases.find((a) => a.startsWith("app."));
  const www = aliases.find((a) => a.startsWith("www."));
  const apex = aliases.find((a) => a !== app && a !== www);
  if (!app || !www || !apex) throw new Error(`Expected app., www. and apex aliases on the distribution (got ${aliases.join(", ") || "none"})`);
  return [
    { host: app, uri: "/", expect: "serve" },
    { host: apex, uri: "/demo/", expect: "serve" },
    // The home page once published; until then the redirect to the app
    { host: apex, uri: "/", expect: "site" },
    { host: apex, uri: "/assets/check-router.js", expect: "site" },
    { host: apex, uri: "/anything-else", expect: 302 },
    { host: www, uri: "/", expect: 301 },
  ];
}

/** Checks one test-function result against what the request must get; returns a line for the log. */
export function checkRouterResult(check, result) {
  const where = `${check.host}${check.uri}`;
  const error = result?.FunctionErrorMessage;
  if (error) throw new Error(`The router failed on ${where}: ${error}`);
  let output;
  try {
    output = JSON.parse(result?.FunctionOutput ?? "");
  } catch {
    throw new Error(`The router gave no readable output for ${where}: ${String(result?.FunctionOutput)}`);
  }
  const status = output?.response?.statusCode;
  const uri = output?.request?.uri;
  if (check.expect === "serve") {
    if (typeof uri === "string" && uri.startsWith("/releases/")) return `ok  ${where} -> ${uri}`;
    if (status === 503) return `ok  ${where} -> 503 (nothing live on this channel)`;
  } else if (check.expect === "site") {
    // Served from a release, or (nothing live on the site channel yet) the redirect to the app
    if (typeof uri === "string" && uri.startsWith("/releases/")) return `ok  ${where} -> ${uri}`;
    if (status === 302) return `ok  ${where} -> 302 (no home page live: the app)`;
  } else if (status === check.expect) {
    return `ok  ${where} -> ${status}`;
  }
  throw new Error(`The router answered ${where} with ${status ?? uri ?? "nothing"}, not ${check.expect === "serve" ? "a release" : check.expect === "site" ? "a release or a 302" : check.expect}`);
}

function checkRouter(aws, envName) {
  const names = routerParameterNames(envName);
  const res = aws.read(["ssm", "get-parameters", "--names", names.functionName, names.distributionId, names.opsFunctionName]);
  const values = Object.fromEntries((res?.Parameters ?? []).map((p) => [p.Name, p.Value]));
  const missing = Object.values(names).filter((n) => !values[n]);
  if (missing.length) throw new Error(`Missing SSM parameters (deploy the web stack first): ${missing.join(", ")}`);
  const aliases = aws.read(["cloudfront", "get-distribution-config", "--id", values[names.distributionId]])?.DistributionConfig?.Aliases?.Items ?? [];
  testRouter(aws, values[names.functionName], routerChecks(aliases));
  testRouter(aws, values[names.opsFunctionName], opsRouterChecks(envName));
}

/** Runs one router function's LIVE stage on each check's request. */
function testRouter(aws, name, checks) {
  const etag = aws.read(["cloudfront", "describe-function", "--name", name, "--stage", "LIVE"])?.ETag;
  const dir = mkdtempSync(path.join(tmpdir(), "check-router-"));
  try {
    checks.forEach((check, i) => {
      const file = path.join(dir, `event-${i}.json`);
      writeFileSync(file, JSON.stringify(routerTestEvent(check.host, check.uri)));
      const out = aws.read(["cloudfront", "test-function", "--name", name, "--if-match", etag, "--stage", "LIVE", "--event-object", `fileb://${file}`]);
      aws.log(checkRouterResult(check, out?.TestResult));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  aws.log(`The live router (${name}) works.`);
}

export const releaseIndexKey = (version) => `releases/${version}/index.html`;
export const releaseConfigKey = (version) => `releases/${version}/config.json`;
export const releaseOpsConfigKey = (version) => `releases/${version}/ops-config.json`;
/** The home page's build marks itself (vite.config.js), so it can't go live as the demo, whose builds have no marker. */
export const SITE_MARKER = "site-release.json";
export const releaseSiteKey = (version) => `releases/${version}/${SITE_MARKER}`;

class Aws {
  constructor({ profile, region, dryRun, log = console.log, run = execFileSync }) {
    Object.assign(this, { profile, region, dryRun, log, run });
  }

  /** Runs a read-only command (also in a dry run) and returns parsed JSON. */
  read(args, region = this.region) {
    const out = this.run("aws", [...args, "--profile", this.profile, "--region", region, "--output", "json"], { encoding: "utf8" });
    return out.trim() ? JSON.parse(out) : null;
  }

  /** Runs a command that changes something, or prints it in a dry run. */
  write(args) {
    this.log(`$ aws ${args.map((a) => (/[\s*"]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
    if (!this.dryRun) this.run("aws", args, { stdio: "inherit" });
  }

  /**
   * Whether an object exists. Only S3's "not there" answers mean no. A 404 is one. A 403 is
   * what S3 gives for a missing key when the caller may not list that key's place in the bucket
   * (the deploy workflow's web publisher role may list only with an s3:prefix, which a HEAD
   * request doesn't carry), but also for a key the caller may not read; so after a 403 it lists
   * with the key as the prefix, which that role may do, and only an empty answer means missing.
   * Anything else (expired credentials, the network, throttling) is an error, so it can never
   * look like a missing release and lead to an upload over a real one.
   */
  exists(bucket, key, region) {
    const fail = (e) => new Error(`Couldn't check s3://${bucket}/${key}: ${String(e.stderr || e.message).trim()}`, { cause: e });
    try {
      this.read(["s3api", "head-object", "--bucket", bucket, "--key", key], region);
      return true;
    } catch (e) {
      if (!isMissing(e)) throw fail(e);
      if (!/\(403\)/.test(`${e?.stderr ?? ""}\n${e?.message ?? ""}`)) return false;
    }
    let listing;
    try {
      listing = this.read(["s3api", "list-objects-v2", "--bucket", bucket, "--prefix", key, "--max-keys", "1"], region);
    } catch (e) {
      throw fail(e);
    }
    if ((listing?.KeyCount ?? 0) > 0) throw new Error(`s3://${bucket}/${key} is there, but this role may not read it`);
    return false;
  }
}

/** The AWS CLI's error for a HEAD of a key that isn't there (or that the caller may not see). */
export function isMissing(error) {
  return /An error occurred \((404|403)\) when calling the HeadObject operation/.test(`${error?.stderr ?? ""}\n${error?.message ?? ""}`);
}

function lookup(aws, envName) {
  const names = parameterNames(envName);
  const res = aws.read(["ssm", "get-parameters", "--names", names.bucket, names.bucketRegion, names.store]);
  const values = Object.fromEntries((res?.Parameters ?? []).map((p) => [p.Name, p.Value]));
  const missing = Object.values(names).filter((n) => !values[n]);
  if (missing.length) {
    throw new Error(`Missing SSM parameters (deploy the web stack first): ${missing.join(", ")}`);
  }
  return { bucket: values[names.bucket], bucketRegion: values[names.bucketRegion], store: values[names.store] };
}

function activate(aws, { store, channel, version }) {
  const etag = aws.read(["cloudfront-keyvaluestore", "describe-key-value-store", "--kvs-arn", store]).ETag;
  aws.write([
    "cloudfront-keyvaluestore", "put-key", "--kvs-arn", store, "--key", channel, "--value", version, "--if-match", etag,
    "--profile", aws.profile, "--region", aws.region,
  ]);
  aws.log(`${channel} is now ${version}${aws.dryRun ? " (dry run)" : ""}. Edges pick it up within seconds.`);
}

export function main(argv, deps = {}) {
  const opts = parseArgs(argv, deps.env);
  const aws = new Aws({ ...opts, ...deps });
  if (opts.command === "config") {
    aws.log(JSON.stringify(opts.channel === "ops" ? opsConfig(aws, opts.env) : appConfig(aws, opts.env), null, 2));
    return;
  }
  if (opts.command === "check-router") {
    checkRouter(aws, opts.env);
    return;
  }
  const { bucket, bucketRegion, store } = lookup(aws, opts.env);

  if (opts.command === "live") {
    const keys = aws.read(["cloudfront-keyvaluestore", "list-keys", "--kvs-arn", store]);
    aws.log((keys?.Items ?? []).find((item) => item.Key === opts.channel)?.Value ?? "none");
    return;
  }

  if (opts.command === "status") {
    const keys = aws.read(["cloudfront-keyvaluestore", "list-keys", "--kvs-arn", store]);
    for (const item of keys?.Items ?? []) aws.log(`live  ${item.Key}: ${item.Value}`);
    const listing = aws.read(["s3api", "list-objects-v2", "--bucket", bucket, "--prefix", "releases/", "--delimiter", "/"], bucketRegion);
    for (const p of listing?.CommonPrefixes ?? []) aws.log(`release  ${p.Prefix.replace(/^releases\/|\/$/g, "")}`);
    return;
  }

  if (opts.command === "publish") {
    const dir = path.resolve(opts.dir);
    if (!existsSync(path.join(dir, "index.html")) || !statSync(dir).isDirectory()) {
      throw new Error(`${opts.dir} has no index.html. Build it first (npm run build:${{ demo: "demo", ops: "ops", site: "site", app: "web" }[opts.channel]}).`);
    }
    const version = opts.version ?? defaultVersion(opts.channel);
    if (!VERSION.test(version)) throw new Error(`Bad version ${version}`);
    if (aws.exists(bucket, releaseIndexKey(version), bucketRegion)) {
      if (!opts.reuse) throw new Error(`Release ${version} already exists; releases never change. Pick another --version, or activate it.`);
      aws.log(`Release ${version} already exists, so it isn't uploaded again.`);
      checkReleaseChannel(aws, { bucket, bucketRegion, channel: opts.channel, version });
      if (opts.activate) activate(aws, { store, channel: opts.channel, version });
      return;
    }
    if (opts.channel === "demo" && existsSync(path.join(dir, "config.json"))) {
      throw new Error(`${opts.dir} has a config.json, so it's an app build, not the demo (npm run build:demo builds dist/demo).`);
    }
    // A folder is one channel's build: the home page's marker is on its folder alone, and the operator page never ships with the app's files, nor the app with the page's
    if (opts.channel === "site" && !existsSync(path.join(dir, SITE_MARKER))) {
      throw new Error(`${opts.dir} has no ${SITE_MARKER}, so it isn't the home page's build (npm run build:site builds dist/site).`);
    }
    if (opts.channel !== "site" && existsSync(path.join(dir, SITE_MARKER))) {
      throw new Error(`${opts.dir} has a ${SITE_MARKER}, so it's the home page's build (npm run build:site), not the ${opts.channel}'s.`);
    }
    if (opts.channel !== "ops" && existsSync(path.join(dir, "ops-config.json"))) {
      throw new Error(`${opts.dir} has an ops-config.json, so it's the operator page's build (npm run build:ops), not the ${opts.channel}'s.`);
    }
    if (opts.channel === "ops" && existsSync(path.join(dir, "config.json"))) {
      throw new Error(`${opts.dir} has a config.json, so it's an app build, not the operator page (npm run build:ops builds dist/ops).`);
    }
    const [file, config] =
      opts.channel === "app" ? ["config.json", appConfig(aws, opts.env)] : opts.channel === "ops" ? ["ops-config.json", opsConfig(aws, opts.env)] : [];
    if (file) {
      const text = JSON.stringify(config, null, 2) + "\n";
      if (aws.dryRun) aws.log(`Would write ${file}:\n${text}`);
      else writeFileSync(path.join(dir, file), text);
    }
    for (const cmd of uploadCommands({ dir, version, bucket, bucketRegion, profile: opts.profile })) aws.write(cmd);
    aws.log(`Uploaded ${opts.dir} as release ${version}.`);
    if (!opts.activate) {
      aws.log(`Not live. To switch: node scripts/publish-web.mjs activate --channel ${opts.channel} --version ${version}`);
      return;
    }
    activate(aws, { store, channel: opts.channel, version });
    return;
  }

  // activate
  if (!aws.exists(bucket, releaseIndexKey(opts.version), bucketRegion)) {
    throw new Error(`No release ${opts.version} in ${bucket} (see: node scripts/publish-web.mjs status)`);
  }
  checkReleaseChannel(aws, { bucket, bucketRegion, channel: opts.channel, version: opts.version });
  activate(aws, { store, channel: opts.channel, version: opts.version });
}

/**
 * App releases have config.json, operator page releases ops-config.json, home page releases
 * site-release.json, and demo releases none of them; none goes live on another's channel.
 */
function checkReleaseChannel(aws, { bucket, bucketRegion, channel, version }) {
  const releaseChannel = aws.exists(bucket, releaseConfigKey(version), bucketRegion)
    ? "app"
    : aws.exists(bucket, releaseOpsConfigKey(version), bucketRegion)
      ? "ops"
      : aws.exists(bucket, releaseSiteKey(version), bucketRegion)
        ? "site"
        : "demo";
  if (releaseChannel !== channel) {
    const what = { app: "an app release (it has config.json)", ops: "an operator page release (it has ops-config.json)", site: `a home page release (it has ${SITE_MARKER})`, demo: "a demo release (it has no config.json)" }[releaseChannel];
    throw new Error(`Release ${version} is ${what}, so it can't go live on the ${channel} channel.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`publish-web: ${e.message}`);
    process.exit(1);
  }
}
