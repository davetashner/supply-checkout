#!/usr/bin/env node
// Uploads a web build as a release and makes it live (supply-checkout-qk1).
//
//   node scripts/publish-web.mjs publish  --channel demo --dir dist/demo [--version V] [--no-activate]
//   node scripts/publish-web.mjs activate --channel app --version V     switch (or roll back) the live release
//   node scripts/publish-web.mjs status                                  live versions and uploaded releases
//   node scripts/publish-web.mjs config                                  print the app's config.json
//   node scripts/publish-web.mjs check-router                            run the live router on test requests
//
// Common options: --env prod (default), --profile supply-prod (default: $AWS_PROFILE, else
// supply-prod), --region <the web stack's region> (default: GLOBAL_SERVICES_REGION in
// infra/lib/config.ts), --dry-run (print the AWS CLI commands instead of running them).
//
// Channels: "demo" is served at the apex's /demo/, "app" at app. (infra/lib/web/router.js).
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

export const CHANNELS = ["app", "demo"];
// Same pattern as infra/lib/web/router.js, which refuses anything else
export const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Where the web stack, its SSM parameters and the KeyValueStore are. Keep in step with
// GLOBAL_SERVICES_REGION in infra/lib/config.ts.
const DEFAULT_REGION = "us-east-1";

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
    else if (arg === "--dry-run") opts.dryRun = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!["publish", "activate", "status", "config", "check-router"].includes(command)) throw new Error("Usage: publish-web.mjs publish|activate|status|config|check-router [options]");
  if (!["status", "config", "check-router"].includes(command) && !CHANNELS.includes(opts.channel)) throw new Error(`--channel must be one of ${CHANNELS.join(", ")}`);
  if (command === "publish" && !opts.dir) throw new Error("--dir is required (the built folder, e.g. dist/demo)");
  if (command === "activate" && !opts.version) throw new Error("--version is required");
  if (opts.version !== undefined && !VERSION.test(opts.version)) {
    throw new Error(`--version must be letters, digits, dots, dashes or underscores (got "${opts.version}")`);
  }
  if (opts.version === "none") throw new Error('"none" is reserved: it means nothing is live');
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
  const names = configParameterNames(envName);
  const res = aws.read(["ssm", "get-parameters", "--names", ...Object.values(names)]);
  const values = Object.fromEntries((res?.Parameters ?? []).map((p) => [p.Name, p.Value]));
  const missing = Object.values(names).filter((n) => !values[n]);
  if (missing.length) {
    throw new Error(`Missing SSM parameters (deploy the api, identity, realtime and web stacks first): ${missing.join(", ")}`);
  }
  return Object.fromEntries(Object.entries(names).map(([key, name]) => [key, values[name]]));
}

/** Where check-router finds the router and the distribution's hosts: the web stack's outputs. */
export const routerParameterNames = (envName) => ({
  functionName: `/supply-checkout/${envName}/web/router-function-name`,
  distributionId: `/supply-checkout/${envName}/web/distribution-id`,
});

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
    { host: apex, uri: "/", expect: 302 },
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
  } else if (status === check.expect) {
    return `ok  ${where} -> ${status}`;
  }
  throw new Error(`The router answered ${where} with ${status ?? uri ?? "nothing"}, not ${check.expect === "serve" ? "a release" : check.expect}`);
}

function checkRouter(aws, envName) {
  const names = routerParameterNames(envName);
  const res = aws.read(["ssm", "get-parameters", "--names", names.functionName, names.distributionId]);
  const values = Object.fromEntries((res?.Parameters ?? []).map((p) => [p.Name, p.Value]));
  const missing = Object.values(names).filter((n) => !values[n]);
  if (missing.length) throw new Error(`Missing SSM parameters (deploy the web stack first): ${missing.join(", ")}`);
  const name = values[names.functionName];
  const aliases = aws.read(["cloudfront", "get-distribution-config", "--id", values[names.distributionId]])?.DistributionConfig?.Aliases?.Items ?? [];
  const checks = routerChecks(aliases);
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

  exists(bucket, key, region) {
    try {
      this.read(["s3api", "head-object", "--bucket", bucket, "--key", key], region);
      return true;
    } catch {
      return false;
    }
  }
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
    aws.log(JSON.stringify(appConfig(aws, opts.env), null, 2));
    return;
  }
  if (opts.command === "check-router") {
    checkRouter(aws, opts.env);
    return;
  }
  const { bucket, bucketRegion, store } = lookup(aws, opts.env);

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
      throw new Error(`${opts.dir} has no index.html. Build it first (npm run build:${opts.channel === "demo" ? "demo" : "web"}).`);
    }
    const version = opts.version ?? defaultVersion(opts.channel);
    if (!VERSION.test(version)) throw new Error(`Bad version ${version}`);
    if (aws.exists(bucket, releaseIndexKey(version), bucketRegion)) {
      throw new Error(`Release ${version} already exists; releases never change. Pick another --version, or activate it.`);
    }
    if (opts.channel === "demo" && existsSync(path.join(dir, "config.json"))) {
      throw new Error(`${opts.dir} has a config.json, so it's an app build, not the demo (npm run build:demo builds dist/demo).`);
    }
    if (opts.channel === "app") {
      const config = JSON.stringify(appConfig(aws, opts.env), null, 2) + "\n";
      if (aws.dryRun) aws.log(`Would write config.json:\n${config}`);
      else writeFileSync(path.join(dir, "config.json"), config);
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
  const releaseChannel = aws.exists(bucket, releaseConfigKey(opts.version), bucketRegion) ? "app" : "demo";
  if (releaseChannel !== opts.channel) {
    throw new Error(`Release ${opts.version} is ${releaseChannel === "app" ? "an app" : "a demo"} release (it ${releaseChannel === "app" ? "has" : "has no"} config.json), so it can't go live on the ${opts.channel} channel.`);
  }
  activate(aws, { store, channel: opts.channel, version: opts.version });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`publish-web: ${e.message}`);
    process.exit(1);
  }
}
