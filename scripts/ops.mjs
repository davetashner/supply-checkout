#!/usr/bin/env node
// The operator CLI (ADR 0015, supply-checkout-6uw.1): the /ops routes from a terminal.
//
//   npm run ops -- teams [--q <name or team ID>] [--limit N] [--cursor C]
//   npm run ops -- team <teamId>
//   npm run ops -- comp <teamId> --plan free --until 2026-12-31 --reason "Pilot, 90 days" [--seats N]
//   npm run ops -- uncomp <teamId> --reason "Pilot over"
//   npm run ops -- audit [--team <teamId> | --month YYYY-MM]
//   npm run ops -- stuck-imports
//   npm run ops -- clear-import <teamId> <importId> --reason "Owner re-imported it"
//   npm run ops -- sign-out
//
// Options: --env prod (default), --json (print the API's answers as they are),
// --client-id <the ops client ID> (default: $SUPPLY_OPS_CLIENT_ID, else read from SSM
// with the AWS CLI and --profile, default $AWS_PROFILE or supply-prod).
//
// Signing in: the first command opens the operator pool's sign-in page
// (https://ops-auth.<env domain>) in the browser: username, password, then the TOTP
// code. It's the authorization code flow with PKCE, redirected to this script on
// http://localhost:8765/ (a fixed port: Cognito matches callback URLs exactly). Only
// the access token is kept, for its 15 minutes, in ~/.config/supply-checkout/ with
// owner-only permissions; after that the next command signs in again, which within
// the sign-in page's one-hour session doesn't ask again. No refresh token is stored.
// `sign-out` signs the operator out everywhere (Cognito's GlobalSignOut, which revokes
// every token they hold) and forgets the cached one.
//
// Every command goes through the same routes, MFA and audit as everything else: a
// comp reads the team first (audited), then sends its version as expectedVersion with
// a new Idempotency-Key.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CALLBACK_PORT = 8765;
// Keep in step with OPS_CLI_CALLBACK in infra/lib/identity.ts
export const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/`;
const DOMAIN = "supplycheckout.com";
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const ENV = /^[a-z][a-z0-9-]{0,20}$/;

export const USAGE = `Usage: npm run ops -- <command> [options]

  teams [--q <text>] [--limit N] [--cursor C]   List teams, newest first, or search by name or ID
  team <teamId>                                 One team's account record and owners (audited)
  comp <teamId> --plan <plan> --until <date> --reason <text> [--seats N]
                                                Comp a team or change or extend its comp (at most 12 months)
  uncomp <teamId> --reason <text>               End a team's comp now
  audit [--team <teamId> | --month YYYY-MM]     The operator audit (default: this month)
  stuck-imports                                 Imports stuck part-way for over an hour (the "Imports stuck" alarm)
  clear-import <teamId> <importId> --reason <text>
                                                Take a stuck import out of the check (the job itself stays)
  sign-out                                      Sign out everywhere and forget the cached token

Options: --env <env> (default prod), --json, --client-id <id>, --profile <aws profile>`;

const VALUE_FLAGS = new Set(["env", "q", "limit", "cursor", "plan", "until", "reason", "seats", "team", "month", "client-id", "profile"]);
const BOOLEAN_FLAGS = new Set(["json", "help"]);

/** `[command, ...positionals]` and the flags. Refuses unknown flags and flags without a value. */
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new UsageError(`--${name} needs a value`);
      flags[name] = value;
    } else {
      throw new UsageError(`Unknown option --${name}`);
    }
  }
  return { command: positionals[0], args: positionals.slice(1), flags };
}

export class UsageError extends Error {}

/** Where the environment's API and operator sign-in are. */
export function endpoints(env) {
  if (!ENV.test(env)) throw new UsageError(`Invalid --env ${env}`);
  const domain = env === "prod" ? DOMAIN : `${env}.${DOMAIN}`;
  return { api: `https://api.${domain}`, auth: `https://ops-auth.${domain}` };
}

/** A PKCE verifier and its S256 challenge. */
export function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** The claims of a JWT, unverified: only for its expiry and issuer, never for trust. */
export function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

/** The cached access token for `env`, if it's still good for a minute. */
export function readCachedToken(file, now = Date.now()) {
  let fd;
  try {
    // Never through a symlink someone else planted
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const { accessToken } = JSON.parse(readFileSync(fd, "utf8"));
    const exp = Number(jwtClaims(accessToken).exp);
    return Number.isFinite(exp) && exp * 1000 - 60_000 > now ? accessToken : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeCachedToken(file, accessToken) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // mkdir's mode doesn't apply to a directory that already existed
  chmodSync(path.dirname(file), 0o700);
  // Owner-only before the token is written, even if the file already existed with another mode, and never through a symlink
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, JSON.stringify({ accessToken }));
  } finally {
    closeSync(fd);
  }
}

/** The ops client ID: the flag, the environment, or SSM through the AWS CLI. */
export function clientIdFor(env, flags, deps) {
  const given = flags["client-id"] ?? deps.env.SUPPLY_OPS_CLIENT_ID;
  if (given) return given;
  const profile = flags.profile ?? deps.env.AWS_PROFILE ?? "supply-prod";
  const out = deps.run("aws", ["ssm", "get-parameter", "--profile", profile, "--name", `/supply-checkout/${env}/identity/ops-client-id`, "--query", "Parameter.Value", "--output", "text"]);
  const id = String(out).trim();
  if (!/^[A-Za-z0-9]{1,128}$/.test(id)) throw new Error("Couldn't read the ops client ID from SSM; pass --client-id or set SUPPLY_OPS_CLIENT_ID");
  return id;
}

/**
 * Waits for the sign-in redirect on localhost and returns its `code`, after checking
 * `state`. Listens on 127.0.0.1 and ::1 only, never on other interfaces.
 */
export function waitForCode(state, { port = CALLBACK_PORT, timeoutMs = SIGN_IN_TIMEOUT_MS, warn = (m) => console.error(m) } = {}) {
  return new Promise((resolve, reject) => {
    const servers = [];
    let done = false;
    const finish = (error, code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const s of servers) {
        s.close();
        s.closeAllConnections?.();
      }
      if (error) reject(error);
      else resolve(code);
    };
    const timer = setTimeout(() => finish(new Error("Sign-in timed out")), timeoutMs);
    timer.unref?.();
    const handler = (req, res) => {
      const url = new URL(req.url ?? "/", CALLBACK_URL);
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const ok = !error && code && url.searchParams.get("state") === state;
      res.writeHead(ok ? 200 : 400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(ok ? "Signed in. You can close this tab and go back to the terminal." : "Sign-in failed. Go back to the terminal.");
      if (ok) finish(undefined, code);
      else finish(new Error(error ? `Sign-in failed: ${error}` : "Sign-in failed: the answer didn't match this request"));
    };
    for (const host of ["127.0.0.1", "::1"]) {
      const server = createServer(handler);
      servers.push(server);
      // IPv6 may be off, so ::1 is best effort; 127.0.0.1 must work. Cognito
      // allows http callbacks only for "localhost", so the URL can't name 127.0.0.1.
      server.on("error", (e) => {
        if (host === "127.0.0.1") finish(new Error(`Can't listen on ${CALLBACK_URL}: ${e.code ?? e.message}`));
        else warn(`Couldn't listen on [::1]:${port} (${e.code ?? e.message}). If the browser can't reach ${CALLBACK_URL} after you sign in, make localhost resolve to 127.0.0.1 or free the port.`);
      });
      server.listen(port, host);
    }
  });
}

/** Opens the browser at `url` (or asks the operator to). */
export function openBrowser(url, deps) {
  deps.log(`Opening the operator sign-in page. If it doesn't open, go to:\n${url}\n`);
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    spawn(command, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {}
}

/** Signs in with Managed Login (authorization code with PKCE) and returns the access token. */
export async function signIn(env, clientId, deps) {
  const { auth } = endpoints(env);
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("base64url");
  const authorize = new URL("/oauth2/authorize", auth);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK_URL,
    scope: "openid aws.cognito.signin.user.admin",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) authorize.searchParams.set(k, v);
  const code = deps.waitForCode(state);
  deps.openBrowser(authorize.toString(), deps);
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: await code, redirect_uri: CALLBACK_URL, code_verifier: verifier });
  const response = await deps.fetch(new URL("/oauth2/token", auth), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const tokens = await response.json().catch(() => ({}));
  if (!response.ok || typeof tokens.access_token !== "string") throw new Error(`Sign-in failed: ${tokens.error ?? response.status}`);
  return tokens.access_token;
}

/** Signs out everywhere: Cognito's GlobalSignOut with the access token revokes every token the operator holds. */
export async function signOut(accessToken, deps) {
  const iss = jwtClaims(accessToken).iss;
  if (typeof iss !== "string" || !/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(iss)) return false;
  const response = await deps.fetch(`${new URL(iss).origin}/`, {
    method: "POST",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService.GlobalSignOut" },
    body: JSON.stringify({ AccessToken: accessToken }),
  });
  return response.ok;
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `The API answered ${status}`);
    this.status = status;
    this.body = body;
  }
}

const pad = (s, n) => String(s).padEnd(n);
const date = (iso) => (typeof iso === "string" ? iso.slice(0, 10) : "-");

/** A team as one line of the list. */
export function teamLine(team) {
  const comp = team.comp ? ` comp:${team.comp.plan} until ${date(team.comp.until)}${team.comp.live ? "" : " (ended)"}` : "";
  const owners = (team.owners ?? []).map((o) => o.email ?? o.userId).join(", ");
  return `${pad(team.id, 38)} ${pad(team.name, 28)} ${pad(`${team.plan}/${team.status}`, 20)} created ${date(team.createdAt)}${team.closedAt ? ` closed ${date(team.closedAt)}` : ""}${comp}${owners ? `  owners: ${owners}` : ""}`;
}

function teamDetail(team) {
  const lines = [
    `${team.name} (${team.id})`,
    `  plan ${team.plan}, status ${team.status}, seats ${team.seats}, owners ${team.ownerCount}${team.closedAt ? `, CLOSED ${team.closedAt} (read-only until it's deleted)` : ""}`,
    `  created ${team.createdAt}${team.trialEndsAt ? `, trial ends ${team.trialEndsAt}` : ""}`,
    `  Stripe customer ${team.stripeCustomerId ?? "none"}`,
    team.comp
      ? `  comp ${team.comp.plan}${team.comp.seats ? ` (${team.comp.seats} seats)` : ""} until ${team.comp.until}${team.comp.live ? "" : " (ended)"}: ${team.comp.reason}`
      : "  no comp",
    `  version ${team.version}`,
    ...(team.owners ?? []).map((o) => `  owner ${o.email ?? "(no email)"} (${o.userId}), joined ${o.joinedAt ?? "?"}`),
  ];
  return lines.join("\n");
}

function auditLine(e) {
  const change = e.action === "ops.import.clear" && e.after ? ` import ${e.after.importId}` : e.after ? ` -> ${e.after.plan} until ${date(e.after.until)}` : e.action === "ops.comp.end" ? " -> none" : "";
  return `${e.ts}  ${pad(e.action, 14)} team ${e.teamId}  by ${e.operatorSub}${change}${e.reason ? `  "${e.reason}"` : ""}`;
}

/** Runs one command. `deps` holds everything with side effects, so tests can fake them. */
export async function main(argv, deps) {
  const { command, args, flags } = parseArgs(argv);
  if (!command || flags.help || command === "help") {
    deps.log(USAGE);
    return 0;
  }
  const env = flags.env ?? "prod";
  const { api } = endpoints(env);
  const cacheFile = path.join(deps.home, ".config", "supply-checkout", `ops-${env}.json`);
  const print = (value, human) => deps.log(flags.json ? JSON.stringify(value, null, 2) : human(value));

  if (command === "sign-out") {
    const cached = readCachedToken(cacheFile, deps.now());
    const revoked = cached ? await signOut(cached, deps) : false;
    rmSync(cacheFile, { force: true });
    deps.log(
      revoked
        ? "Signed out everywhere: every token you held is revoked."
        : "Forgot the cached token. None was live, so nothing was revoked. To revoke every token (a lost laptop, say), run any command to sign in, then sign-out again, or ask an administrator to run admin-user-global-sign-out.",
    );
    // End the sign-in page's own session too, so the next sign-in asks for the password and TOTP again
    try {
      const logout = new URL("/logout", endpoints(env).auth);
      logout.searchParams.set("client_id", clientIdFor(env, flags, deps));
      logout.searchParams.set("logout_uri", CALLBACK_URL);
      deps.openBrowser(logout.toString(), deps);
      deps.log("Opened the sign-in page's logout; the browser may then say it can't reach localhost, which is fine.");
    } catch (error) {
      deps.log(`Couldn't open the sign-in page's logout (${error.message}); its session ends by itself within an hour.`);
    }
    return 0;
  }

  const teamId = () => {
    const id = args[0];
    if (!id || !ID.test(id)) throw new UsageError(`${command} needs a team ID`);
    return id;
  };
  const known = { teams: true, team: true, comp: true, uncomp: true, audit: true, "stuck-imports": true, "clear-import": true };
  if (!known[command]) throw new UsageError(`Unknown command ${command}`);

  let token = readCachedToken(cacheFile, deps.now());
  if (!token) {
    token = await deps.signIn(env, clientIdFor(env, flags, deps), deps);
    writeCachedToken(cacheFile, token);
  }
  const call = async (method, route, { query, body, idempotent } = {}) => {
    const url = new URL(route, api);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const headers = { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...(idempotent ? { "idempotency-key": randomUUID() } : {}) };
    const response = await deps.fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const answer = await response.json().catch(() => ({}));
    if (response.status === 401) rmSync(cacheFile, { force: true });
    if (!response.ok) throw new ApiError(response.status, answer);
    return answer;
  };

  if (command === "teams") {
    const page = await call("GET", "/ops/teams", { query: { q: flags.q, limit: flags.limit, cursor: flags.cursor } });
    print(page, (p) => [p.teams.length ? p.teams.map(teamLine).join("\n") : "No teams.", ...(p.cursor ? [`More: --cursor ${p.cursor}`] : [])].join("\n"));
  } else if (command === "team") {
    print(await call("GET", `/ops/teams/${teamId()}`), (r) => teamDetail(r.team));
  } else if (command === "comp" || command === "uncomp") {
    const id = teamId();
    if (!flags.reason) throw new UsageError(`${command} needs --reason`);
    let body;
    if (command === "comp") {
      if (!flags.plan || !flags.until) throw new UsageError("comp needs --plan and --until");
      const seats = flags.seats === undefined ? undefined : Number(flags.seats);
      if (seats !== undefined && !Number.isInteger(seats)) throw new UsageError("--seats must be a whole number");
      body = { plan: flags.plan, until: flags.until, reason: flags.reason, ...(seats === undefined ? {} : { seats }) };
    } else {
      body = { reason: flags.reason };
    }
    const { team } = await call("GET", `/ops/teams/${id}`);
    const outcome = await call(command === "comp" ? "PUT" : "DELETE", `/ops/teams/${id}/comp`, { body: { ...body, expectedVersion: team.version }, idempotent: true });
    print(outcome, (o) => (o.comp ? `Comped ${team.name} (${id}): ${o.comp.plan} until ${o.comp.until}. Audit event ${o.eventId}.` : `Ended the comp of ${team.name} (${id}). Audit event ${o.eventId}.`));
  } else if (command === "stuck-imports") {
    const answer = await call("GET", "/ops/imports");
    print(answer, (a) =>
      a.imports.length
        ? a.imports.map((j) => `team ${j.teamId}  import ${j.importId}  started ${j.startedAt}  ${j.committed} of ${j.total} rows`).join("\n")
        : `No imports stuck for more than ${a.stuckAfterMinutes} minutes.`,
    );
  } else if (command === "clear-import") {
    const id = teamId();
    const importId = args[1];
    if (!importId || !ID.test(importId)) throw new UsageError("clear-import needs a team ID and an import ID");
    if (!flags.reason) throw new UsageError("clear-import needs --reason");
    const outcome = await call("POST", `/ops/teams/${id}/imports/${importId}/clear`, { body: { reason: flags.reason }, idempotent: true });
    print(outcome, (o) => `Took import ${importId} of team ${id} out of the stuck-import check. Audit event ${o.eventId}.`);
  } else {
    if (flags.team && flags.month) throw new UsageError("Give --team or --month, not both");
    const page = await call("GET", "/ops/audit", { query: { teamId: flags.team, month: flags.month, cursor: flags.cursor, limit: flags.limit } });
    print(page, (p) => [p.events.length ? p.events.map(auditLine).join("\n") : "No operator actions.", ...(p.cursor ? [`More: --cursor ${p.cursor}`] : [])].join("\n"));
  }
  return 0;
}

/* c8 ignore start -- the real process wiring; main() is tested with fakes */
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const deps = {
    fetch,
    env: process.env,
    home: homedir(),
    now: Date.now,
    log: (m) => console.log(m),
    run: (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }),
    waitForCode,
    openBrowser,
    signIn,
  };
  main(process.argv.slice(2), deps).then(
    (code) => process.exit(code),
    (error) => {
      if (error instanceof UsageError) console.error(`${error.message}\n\n${USAGE}`);
      else if (error instanceof ApiError) console.error(`${error.status}: ${error.message}${error.status === 401 ? " (run the command again to sign in)" : ""}`);
      else console.error(error.message);
      process.exit(error instanceof UsageError ? 2 : 1);
    },
  );
}
/* c8 ignore stop */
