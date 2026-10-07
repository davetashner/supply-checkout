// The prod journey harness's configuration (supply-checkout-o60.5, docs/journey-tests-plan.md):
// where it may point, who it signs in as, and when it may run at all.
//
// Everything secret comes from environment variables that the production-journeys GitHub
// environment provides (docs/releases.md, "The production-journeys environment"). Nothing here
// reads a file, SSM or the AWS account: the journeys role can't read SSM, so the two bucket names
// are environment secrets too, which also keeps the account ID in them masked in the public log.
import { tmpdir } from "node:os";
import path from "node:path";
import { DOMAIN } from "../../publish-web.mjs";

/** The only environment the suite runs against: prod, by its fixed public names. */
export const PROD = Object.freeze({
  app: `https://app.${DOMAIN}`,
  api: `https://api.${DOMAIN}`,
  auth: `https://auth.${DOMAIN}`,
  /** The test mail subdomain (infra/lib/domain.ts hostNames().testMail). */
  mailDomain: `e2e.${DOMAIN}`,
  /** The one address the app and Cognito send from (backend/src/email/names.ts). */
  sender: `noreply@${DOMAIN}`,
  /** The domain whose DKIM signature a test mail must carry. */
  senderDomain: DOMAIN,
  /** The primary region: Cognito's user pool and SES inbound (ADR 0010). */
  region: "us-east-1",
});

/** The exact phrase that lets the suite run outside GitHub Actions. */
export const OPT_IN_PHRASE = "run-against-prod";

/** Environment variables, by what they hold. All are secrets of production-journeys. */
export const ENV = Object.freeze({
  accounts: {
    owner: { email: "JOURNEYS_OWNER_EMAIL", password: "JOURNEYS_OWNER_PASSWORD", totp: "JOURNEYS_OWNER_TOTP" },
    crew: { email: "JOURNEYS_CREW_EMAIL", password: "JOURNEYS_CREW_PASSWORD" },
    viewer: { email: "JOURNEYS_VIEWER_EMAIL", password: "JOURNEYS_VIEWER_PASSWORD" },
  },
  teams: { desktop: "JOURNEYS_DESKTOP_TEAM_ID", phone: "JOURNEYS_PHONE_TEAM_ID" },
  buckets: { mail: "JOURNEYS_MAIL_BUCKET", results: "JOURNEYS_RESULTS_BUCKET" },
});

/** The browser project each long-lived team belongs to. */
export const TEAM_FOR_PROJECT = Object.freeze({ "desktop-chrome": "desktop", "iphone-safari": "phone" });

export class ConfigError extends Error {}

/**
 * Whether the base URL is the prod app's: exactly `https://app.<domain>` (a trailing slash
 * allowed), or, only when `allowLocal` (the harness's own unit tests), `http://localhost` or
 * `http://127.0.0.1` on some port. Anything else throws, so the suite can never be pointed at
 * another site with prod credentials.
 */
export function checkBaseUrl(value, { allowLocal = false } = {}) {
  const text = String(value ?? "");
  if (text === PROD.app || text === `${PROD.app}/`) return PROD.app;
  if (allowLocal && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/?$/.test(text)) return text.replace(/\/$/, "");
  throw new ConfigError("The journey suite runs only against the prod app's URL");
}

/**
 * Refuses unless this is a GitHub Actions run (`GITHUB_ACTIONS` and `CI` both `true`) or someone
 * opted in by hand with JOURNEYS_PROD_OPT_IN=run-against-prod. A plain `npx playwright test
 * --config playwright.prod.config.mjs` on a laptop does nothing.
 */
export function assertRunAllowed(env) {
  if (env.GITHUB_ACTIONS === "true" && env.CI === "true") return "ci";
  if (env.JOURNEYS_PROD_OPT_IN === OPT_IN_PHRASE) return "opt-in";
  throw new ConfigError(`The journey suite runs against prod, so it runs only in GitHub Actions, or with JOURNEYS_PROD_OPT_IN=${OPT_IN_PHRASE}`);
}

const RUN_ID = /^[A-Za-z0-9]{1,24}(-[A-Za-z0-9]{1,8})?$/;

/**
 * The run's ID: `<GitHub run id>-<attempt>` in Actions, else JOURNEYS_RUN_ID, else `local<time>`.
 * Letters and digits only (one dash before the attempt), so it's safe in names, barcodes,
 * addresses and S3 keys.
 */
export function runId(env, now = Date.now()) {
  const id = env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || "1"}` : env.JOURNEYS_RUN_ID || `local${now}`;
  if (!RUN_ID.test(id)) throw new ConfigError("The run ID must be letters and digits, with at most one dash before the attempt");
  return id;
}

/**
 * The run's own temporary directory: everything the harness writes (Playwright's output, the
 * JSON report, the TOTP step, warnings) goes under it, and nowhere else. RUNNER_TEMP in Actions
 * (emptied after every job), else the OS temp directory.
 */
export function runDir(env, id) {
  return path.join(env.RUNNER_TEMP || tmpdir(), `journeys-${id}`);
}

// A lowercase-or-not ASCII address whose whole domain part is exactly the test mail domain
// (the same rule as backend/src/data/test-accounts.ts isAtDomain).
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
export function isAtTestDomain(address, domain = PROD.mailDomain) {
  if (typeof address !== "string" || !PRINTABLE_ASCII.test(address)) return false;
  const at = address.indexOf("@");
  if (at < 1 || at !== address.lastIndexOf("@")) return false;
  return address.slice(at + 1).toLowerCase() === domain;
}

const BASE32 = /^[A-Z2-7]{16,}=*$/;
const TEAM_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * Reads and checks every secret the suite needs. Errors name the variables, never their values.
 * The long-lived accounts must be at the test mail domain, the TOTP secret base32, the team IDs
 * well formed and different, and the buckets valid bucket names.
 */
export function readConfig(env) {
  const problems = [];
  const need = (name) => {
    const v = env[name];
    if (typeof v !== "string" || v === "") problems.push(`${name} is not set`);
    return v;
  };
  const accounts = {};
  for (const [role, names] of Object.entries(ENV.accounts)) {
    const email = need(names.email);
    const password = need(names.password);
    if (email && !isAtTestDomain(email)) problems.push(`${names.email} must be an address at the test mail domain`);
    accounts[role] = { role, email, password };
    if (names.totp) {
      const totp = need(names.totp);
      const clean = totp?.replace(/\s+/g, "").toUpperCase();
      if (totp && !BASE32.test(clean)) problems.push(`${names.totp} must be a base32 secret`);
      accounts[role].totp = clean;
    }
  }
  const teams = {};
  for (const [which, name] of Object.entries(ENV.teams)) {
    teams[which] = need(name);
    if (teams[which] && !TEAM_ID.test(teams[which])) problems.push(`${name} is not a team ID`);
  }
  if (teams.desktop && teams.desktop === teams.phone) problems.push("The desktop and phone journey teams must be different teams");
  const buckets = {};
  for (const [which, name] of Object.entries(ENV.buckets)) {
    buckets[which] = need(name);
    if (buckets[which] && !BUCKET.test(buckets[which])) problems.push(`${name} is not a bucket name`);
  }
  const emails = Object.values(accounts).map((a) => a.email?.toLowerCase());
  if (new Set(emails).size !== emails.length) problems.push("The owner, crew and viewer accounts must be different accounts");
  if (problems.length) throw new ConfigError(`The journey suite's configuration is incomplete:\n- ${problems.join("\n- ")}`);
  return { accounts, teams, buckets };
}

/** Every secret value in the configuration, for masking. */
export function secretValues(config) {
  const out = [];
  for (const a of Object.values(config.accounts)) out.push(a.email, a.password, a.totp);
  out.push(...Object.values(config.teams), ...Object.values(config.buckets));
  return out.filter(Boolean);
}
