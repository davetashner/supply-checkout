#!/usr/bin/env node
// The operator admin CLI (supply-checkout-6uw.15): adds, lists, disables, removes and
// resets the people in the operator pool (ADR 0015) with the AWS CLI v2, so nobody has
// to type the admin-* calls by hand. The owner runs it with an SSO administrator
// profile; operators themselves use `npm run ops`.
//
//   npm run operators -- add <username> [--email <addr>] [--send-email]
//   npm run operators -- list [--emails]
//   npm run operators -- disable <username>
//   npm run operators -- enable <username>
//   npm run operators -- remove <username> [--yes]
//   npm run operators -- reset <username> [--send-email] [--enable]
//
// Options: --env prod (default), --profile <aws profile> (default $AWS_PROFILE, else
// supply-prod), --region <the identity stack's primary region> (default below),
// --pool-id <ops pool ID> (default: read from SSM, /supply-checkout/<env>/identity/ops-user-pool-id),
// --dry-run (print the AWS CLI calls, with any password redacted, and run nothing).
//
// Temporary passwords (add, reset):
// - Made here with node:crypto (24 characters, every class the pool's policy requires).
// - Given to the AWS CLI in a request file, `--cli-input-json file://<path>`, never as an
//   argument (arguments show in `ps` to every user on the machine) or in the environment.
//   The file is created owner-only (0600, O_EXCL, no symlinks) in its own mkdtemp folder
//   (0700) and removed as soon as the call returns, whether it worked or not; on SIGINT,
//   SIGTERM or any other exit too. (Standard input doesn't work: the CLI can't open
//   /dev/stdin when it's the socket Node gives a child on macOS, supply-checkout-6uw.17.)
// - With --send-email the script makes no password for `add`: Cognito generates the
//   temporary password and emails it (its default sender), so it never passes through
//   here. `reset --send-email` still sets a throwaway one first (never shown), since
//   Cognito's RESEND only works for a user who must change their password.
// - Printed once, to stdout, and only when stdout is a terminal: not into a pipe, a file
//   or Claude Code's `!` (which keeps output in the session transcript). --print-password
//   overrides that for when you know where stdout goes. With --send-email nothing is
//   printed: Cognito emails it (its default sender) instead.
// - Refused when the AWS CLI's own history (`cli_history = enabled`) would record the
//   request, password included, in ~/.aws/cli/history.
import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { chmodSync, closeSync, constants, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OPERATORS_GROUP = "operators"; // OPERATORS_GROUP in infra/lib/identity.ts
// Where the identity stack and its operator pool are: the primary region. Keep in step with
// DEFAULT_REGIONS[0] in infra/lib/config.ts (scripts can't import the TypeScript config).
const DEFAULT_REGION = "us-east-1";
/** Strict on purpose: the pool takes more, but these are easy to read out and type. */
export const USERNAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const ENV = /^[a-z][a-z0-9-]{0,20}$/;
const POOL_ID = /^[a-z]+(?:-[a-z]+)+-\d+_[A-Za-z0-9]{1,64}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REGION = /^[a-z]+(?:-[a-z]+)+-\d+$/;
/** Temporary passwords last this long (tempPasswordValidity of the ops pool in infra/lib/stacks/identity-stack.ts). */
export const TEMP_PASSWORD_DAYS = 1;
/** The operator pool's name (userPoolName in infra/lib/stacks/identity-stack.ts). */
export const opsPoolName = (envName) => `supply-checkout-${envName}-ops`;
export const REDACTED = "<redacted>";

/** Request files not yet removed; the exit and signal handlers remove any left. */
const pendingSecretDirs = new Set();

/** Removes every request file still on disk. Safe to call more than once. */
export function removeSecretFiles() {
  for (const dir of pendingSecretDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
    pendingSecretDirs.delete(dir);
  }
}

/**
 * Writes `body` to an owner-only request file in a fresh owner-only folder, calls
 * `fn(file:// URL)`, and removes the folder afterwards, whatever happens.
 */
export function withSecretFile(body, fn, base = tmpdir()) {
  const dir = mkdtempSync(path.join(base, "supply-operators-"));
  pendingSecretDirs.add(dir);
  try {
    chmodSync(dir, 0o700);
    const file = path.join(dir, "request.json");
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, JSON.stringify(body));
    } finally {
      closeSync(fd);
    }
    return fn(`file://${file}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    pendingSecretDirs.delete(dir);
  }
}

/**
 * The admin calls on the operator pool that alert the P1 topic (OperatorPoolChanges).
 * Keep in step with OPERATOR_USER_EVENTS and OPERATOR_LOCKOUT_EVENTS in
 * infra/lib/stacks/observability-stack.ts (scripts/operators.test.mjs checks):
 * deleting, disabling and signing out an operator alert too (supply-checkout-6uw.16).
 * The pool's configuration calls (OPERATOR_POOL_CONFIG_EVENTS: its client,
 * domain, groups and identity providers) alert outside a deploy too, but
 * this script never makes them (supply-checkout-6uw.19).
 */
export const ALERTING_CALLS = {
  "admin-create-user": "AdminCreateUser",
  "admin-add-user-to-group": "AdminAddUserToGroup",
  "admin-remove-user-from-group": "AdminRemoveUserFromGroup",
  "admin-set-user-password": "AdminSetUserPassword",
  "admin-reset-user-password": "AdminResetUserPassword",
  "admin-enable-user": "AdminEnableUser",
  "admin-set-user-mfa-preference": "AdminSetUserMFAPreference",
  "admin-update-user-attributes": "AdminUpdateUserAttributes",
  "admin-link-provider-for-user": "AdminLinkProviderForUser",
  "admin-delete-user": "AdminDeleteUser",
  "admin-disable-user": "AdminDisableUser",
  "admin-user-global-sign-out": "AdminUserGlobalSignOut",
};

export const USAGE = `Usage: npm run operators -- <command> [options]

  add <username> [--email <addr>] [--send-email]
                             Create an operator with a temporary password and put them in the operators group.
                             The password is printed once (to a terminal only); --send-email has Cognito email it instead.
  list [--emails]            Every user in the operator pool: status, enabled, TOTP, in the group, created
  disable <username>         Disable (signs them out; their tokens stop working at once)
  enable <username>          Enable again
  remove <username> [--yes]  Take out of the group, sign out everywhere and disable; delete only with --yes
  reset <username> [--send-email] [--enable]
                             A stolen password or token: sign out everywhere, disable, turn TOTP off,
                             set a new temporary password; they stay disabled unless --enable

Options: --env <env> (default prod), --profile <aws profile> (default $AWS_PROFILE, else supply-prod),
         --region <region> (default ${DEFAULT_REGION}), --pool-id <ops pool ID> (default: from SSM),
         --dry-run (print the AWS CLI calls and run nothing), --print-password (print it even when stdout isn't a terminal)`;

const VALUE_FLAGS = new Set(["env", "profile", "region", "pool-id", "email"]);
const BOOLEAN_FLAGS = new Set(["send-email", "dry-run", "yes", "emails", "enable", "print-password", "help"]);
const COMMANDS = {
  add: { flags: ["email", "send-email", "print-password"] },
  list: { flags: ["emails"], noUser: true },
  disable: { flags: [] },
  enable: { flags: [] },
  remove: { flags: ["yes"] },
  reset: { flags: ["send-email", "enable", "print-password"] },
};
const COMMON_FLAGS = ["env", "profile", "region", "pool-id", "dry-run", "help"];

export class UsageError extends Error {}

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
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
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

/** Checks the command, its username and its flags; returns the settings everything else uses. */
export function validate({ command, args, flags }, env = {}) {
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(command ? `Unknown command ${command}` : "Give a command");
  for (const name of Object.keys(flags)) {
    if (!COMMON_FLAGS.includes(name) && !spec.flags.includes(name)) throw new UsageError(`${command} doesn't take --${name}`);
  }
  const expected = spec.noUser ? 0 : 1;
  if (args.length !== expected) throw new UsageError(spec.noUser ? `${command} takes no username` : `${command} needs exactly one username`);
  const username = args[0];
  if (username !== undefined && !USERNAME.test(username)) {
    throw new UsageError(`Invalid username "${username}": 1 to 64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit`);
  }
  if (flags.email !== undefined && (flags.email.length > 254 || !EMAIL.test(flags.email))) throw new UsageError(`Invalid email address "${flags.email}"`);
  if (command === "add" && flags["send-email"] && !flags.email) throw new UsageError("--send-email needs --email: Cognito emails the temporary password to that address");
  if (flags["send-email"] && flags["print-password"]) throw new UsageError("--send-email and --print-password don't go together: with --send-email nothing is printed");
  if (command === "reset" && flags["send-email"] && !flags.enable) throw new UsageError("reset --send-email needs --enable: the invitation email goes to an enabled user, so only send it once they've a clean device");
  const envName = flags.env ?? "prod";
  if (!ENV.test(envName)) throw new UsageError(`Invalid --env ${envName}`);
  const profile = flags.profile ?? (env.AWS_PROFILE || "supply-prod");
  if (!PROFILE.test(profile)) throw new UsageError(`Invalid --profile ${profile}`);
  const region = flags.region ?? DEFAULT_REGION;
  if (!REGION.test(region)) throw new UsageError(`Invalid --region ${region}`);
  if (flags["pool-id"] !== undefined && !POOL_ID.test(flags["pool-id"])) throw new UsageError(`Invalid --pool-id ${flags["pool-id"]}`);
  return { command, username, flags, envName, profile, region, dryRun: Boolean(flags["dry-run"]) };
}

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
// Special characters the pool accepts, minus ones that are hard to read out or type
const SYMBOLS = "!#%*+-=?@^_~";

/**
 * A temporary password for the ops pool's policy (16+ characters, upper, lower, digit,
 * symbol): 24 characters from crypto.randomInt, at least one of each class, shuffled.
 * Look-alikes (I, O, l, o, 0, 1) are left out so it can be read out in person.
 */
export function generatePassword(length = 24, pick = randomInt) {
  const classes = [UPPER, LOWER, DIGITS, SYMBOLS];
  const all = classes.join("");
  const chars = classes.map((set) => set[pick(set.length)]);
  while (chars.length < length) chars.push(all[pick(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Quotes one shell word for printing. */
const shellWord = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/** Runs the AWS CLI, or prints what it would run in a dry run. Passwords only ever go in an owner-only request file, removed after the call. */
class Aws {
  constructor(settings, deps) {
    Object.assign(this, { settings, deps, pool: settings.flags["pool-id"] });
  }

  common() {
    return ["--profile", this.settings.profile, "--region", this.settings.region, "--output", "json"];
  }

  /** `op` with plain parameters (none secret). */
  argv(op, params) {
    const args = ["cognito-idp", op, "--user-pool-id", this.poolId()];
    for (const [k, v] of Object.entries(params)) args.push(`--${k}`, v);
    return [...args, ...this.common()];
  }

  poolId() {
    return this.pool ?? "<ops pool ID>";
  }

  /**
   * The operator pool's ID, from --pool-id or SSM, checked before anything else touches it:
   * the pool must be named supply-checkout-<env>-ops and have the operators group, so a
   * wrong ID (the customers' pool, say) stops here, before any read or change of its users.
   * A dry run shows these calls and makes none.
   */
  resolvePool() {
    const { envName, profile, region, dryRun } = this.settings;
    const where = ["--profile", profile, "--region", region];
    if (!this.pool) {
      const args = ["ssm", "get-parameter", "--name", `/supply-checkout/${envName}/identity/ops-user-pool-id`, "--query", "Parameter.Value", "--output", "text", ...where];
      if (dryRun) this.show(args);
      else {
        const id = String(this.deps.run("aws", args)).trim();
        if (!POOL_ID.test(id)) throw new Error(`Couldn't read the operator pool ID from SSM (${args[3]}); pass --pool-id`);
        this.pool = id;
      }
    }
    const expected = opsPoolName(envName);
    const describe = ["cognito-idp", "describe-user-pool", "--user-pool-id", this.poolId(), "--query", "UserPool.Name", "--output", "text", ...where];
    const group = ["cognito-idp", "get-group", "--user-pool-id", this.poolId(), "--group-name", OPERATORS_GROUP, "--query", "Group.GroupName", "--output", "text", ...where];
    if (dryRun) {
      this.show(describe);
      this.deps.log(`    (stops unless the pool is named ${expected})`);
      this.show(group);
      return;
    }
    const name = String(this.deps.run("aws", describe)).trim();
    if (name !== expected) throw new Error(`Refusing: user pool ${this.pool} is named "${name}", not ${expected}. Only the operator pool is managed here; check --pool-id and --env.`);
    let groupName = "";
    try {
      groupName = String(this.deps.run("aws", group)).trim();
    } catch {}
    if (groupName !== OPERATORS_GROUP) throw new Error(`Refusing: user pool ${this.pool} has no ${OPERATORS_GROUP} group, so it isn't the operator pool.`);
  }

  show(args, input) {
    this.deps.log(`  aws ${args.map(shellWord).join(" ")}${input ? `\n    with that file holding:\n${JSON.stringify(input, null, 2).replace(/^/gm, "      ")}` : ""}`);
  }

  /** A read: runs in a real run only, and returns the parsed answer. */
  read(op, params) {
    const args = this.argv(op, params);
    if (this.settings.dryRun) {
      this.show(args);
      return undefined;
    }
    const out = String(this.deps.run("aws", args) ?? "").trim();
    return out ? JSON.parse(out) : {};
  }

  /**
   * A change. With `input`, the request goes in an owner-only file that's removed after the
   * call; `secret` names the one parameter in it that must never be shown or put in argv.
   */
  write(op, params, { input, secret } = {}) {
    if (input) {
      const body = { UserPoolId: this.poolId(), ...input };
      const argsFor = (url) => ["cognito-idp", op, "--cli-input-json", url, ...this.common()];
      if (this.settings.dryRun) this.show(argsFor("file://<owner-only temporary file, removed after the call>"), { ...body, [secret]: REDACTED });
      else withSecretFile(body, (url) => this.deps.run("aws", argsFor(url)), this.deps.tmpdir);
      return;
    }
    const args = this.argv(op, params);
    if (this.settings.dryRun) this.show(args);
    else this.deps.run("aws", args);
  }

  /**
   * The AWS CLI keeps each request, parameters and all, in ~/.aws/cli/history when the
   * profile has `cli_history = enabled`; a password must never go there.
   */
  refuseCliHistory() {
    const args = ["configure", "get", "cli_history", "--profile", this.settings.profile];
    if (this.settings.dryRun) return;
    let value = "";
    try {
      value = String(this.deps.run("aws", args)).trim();
    } catch {
      // `aws configure get` exits non-zero when it isn't set: history is off
    }
    if (value.toLowerCase() === "enabled") {
      throw new Error(`The AWS CLI's history is on for ${this.settings.profile} (cli_history = enabled), so it would store the temporary password in ~/.aws/cli/history. Turn it off (aws configure set cli_history disabled --profile ${this.settings.profile}) and run this again.`);
    }
  }
}

/** A failure part-way through: what's done, what isn't, and how to finish or undo. */
export class PartialError extends Error {}

/** Runs `steps` in order; on a failure, says exactly where it stopped. */
function runSteps(steps, { username, dryRun }, hint) {
  const done = [];
  for (const step of steps) {
    try {
      step.run();
    } catch (error) {
      if (dryRun) throw error;
      const lines = [
        `Stopped: ${step.what} failed for ${username}${error.message ? ` (${firstLine(error.message)})` : ""}.`,
        done.length ? `Already done: ${done.join("; ")}.` : "Nothing was changed.",
        `Not done: ${steps.slice(steps.indexOf(step)).map((s) => s.what).join("; ")}.`,
      ];
      const extra = hint?.(done.length, step);
      if (extra) lines.push(extra);
      throw new PartialError(lines.join("\n"));
    }
    done.push(step.what);
  }
}

const firstLine = (s) => String(s).split("\n").find((l) => l.trim())?.trim() ?? "";

/** What P1 will say about these calls, to print with every command. */
export function alertNote(ops) {
  const events = [...new Set(ops.map((op) => ALERTING_CALLS[op]).filter(Boolean))];
  if (!events.length) return "No P1 alert expected: none of these calls is one the operator-pool alerts watch.";
  return `Expect P1 alerts (OperatorPoolChanges) for ${events.join(", ")} on the operator pool. They're this change: say so where the alerts go.`;
}

function passwordBlock(username, password, settings) {
  const auth = settings.envName === "prod" ? "https://ops-auth.supplycheckout.com" : `https://ops-auth.${settings.envName}.supplycheckout.com`;
  return [
    "",
    `Temporary password for ${username} (shown once, not saved anywhere):`,
    "",
    `    ${password}`,
    "",
    `Hand it over in person (or read it out on a call); don't email or message it. It expires in ${TEMP_PASSWORD_DAYS} day${TEMP_PASSWORD_DAYS === 1 ? "" : "s"}.`,
    `At their first sign-in (npm run ops, or ${auth}) they choose a new password and set up TOTP with an authenticator app on their phone.`,
    "Clear this terminal's scrollback once it's handed over.",
  ].join("\n");
}

/** Refuses to print a password where it could be kept: a pipe, a file, Claude Code's `!`. */
function checkPasswordOutput(settings, deps) {
  if (settings.dryRun || settings.flags["send-email"] || settings.flags["print-password"] || deps.isTTY) return;
  throw new UsageError(
    `${settings.command} prints a temporary password, and stdout isn't a terminal, where it could be saved (a pipe, a file, or Claude Code's \`!\`, which keeps output in the session transcript). Run it in a terminal of your own, or use --send-email, or --print-password if you know where stdout goes.`,
  );
}

function add(aws, settings, deps) {
  const { username, flags } = settings;
  const email = flags.email;
  const sendEmail = Boolean(flags["send-email"]);
  checkPasswordOutput(settings, deps);
  // With --send-email no password passes through here: Cognito generates and emails it
  if (!sendEmail) aws.refuseCliHistory();
  aws.resolvePool();
  const attributes = email ? [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }] : undefined;
  const password = sendEmail ? undefined : generatePassword();
  const create = sendEmail
    ? () => aws.write("admin-create-user", { username, "user-attributes": JSON.stringify(attributes), "desired-delivery-mediums": "EMAIL" })
    : () =>
        aws.write("admin-create-user", undefined, {
          input: { Username: username, TemporaryPassword: password, ...(attributes ? { UserAttributes: attributes } : {}), MessageAction: "SUPPRESS" },
          secret: "TemporaryPassword",
        });
  const group = ["admin-add-user-to-group", { username, "group-name": OPERATORS_GROUP }];
  runSteps(
    [
      { what: `create ${username} in the operator pool`, run: create },
      { what: `add ${username} to the ${OPERATORS_GROUP} group`, run: () => aws.write(...group) },
    ],
    settings,
    (doneCount) =>
      doneCount === 1
        ? [
            `${username} now exists in the pool ${sendEmail ? "(Cognito has emailed them a temporary password)" : "with a temporary password nobody has seen"}, but isn't in ${OPERATORS_GROUP}, so the /ops routes refuse them. Either:`,
            `  finish:  aws ${aws.argv(...group).map(shellWord).join(" ")}`,
            `           then npm run operators -- reset ${username} for a password to hand over`,
            `  undo:    aws ${aws.argv("admin-delete-user", { username }).map(shellWord).join(" ")}`,
          ].join("\n")
        : undefined,
  );
  if (settings.dryRun) return;
  deps.log(`Added ${username} to the operator pool and the ${OPERATORS_GROUP} group.`);
  if (sendEmail) {
    deps.log(`Cognito emailed the temporary password to ${email}; it expires in ${TEMP_PASSWORD_DAYS} day. At their first sign-in they choose a new password and set up TOTP on their phone.`);
  } else {
    deps.out(passwordBlock(username, password, settings));
  }
}

function list(aws, settings, deps) {
  aws.resolvePool();
  const users = aws.read("list-users", {});
  const inGroup = aws.read("list-users-in-group", { "group-name": OPERATORS_GROUP });
  if (settings.dryRun) {
    deps.log(`  aws cognito-idp admin-get-user --user-pool-id ${aws.poolId()} --username <each user> ${aws.common().join(" ")}`);
    return;
  }
  const members = new Set((inGroup.Users ?? []).map((u) => u.Username));
  const rows = (users.Users ?? []).map((u) => {
    const detail = aws.read("admin-get-user", { username: u.Username });
    const totp = (detail.UserMFASettingList ?? []).includes("SOFTWARE_TOKEN_MFA");
    const email = (u.Attributes ?? []).find((a) => a.Name === "email")?.Value;
    return [
      u.Username,
      u.UserStatus ?? "?",
      u.Enabled === false ? "disabled" : "enabled",
      totp ? "TOTP" : "no TOTP",
      members.has(u.Username) ? OPERATORS_GROUP : "not in group",
      typeof u.UserCreateDate === "string" ? u.UserCreateDate.slice(0, 10) : String(u.UserCreateDate ?? "?"),
      ...(settings.flags.emails ? [email ?? "(no email)"] : []),
    ];
  });
  if (!rows.length) {
    deps.log("No users in the operator pool.");
    return;
  }
  const header = ["USERNAME", "STATUS", "ENABLED", "MFA", "GROUP", "CREATED", ...(settings.flags.emails ? ["EMAIL"] : [])];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  for (const row of [header, ...rows]) deps.log(row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]))).join("  "));
  const strays = [...members].filter((m) => !rows.some((r) => r[0] === m));
  if (strays.length) deps.log(`In the group but not listed: ${strays.join(", ")}`);
}

function simple(aws, settings, deps) {
  const { username, command } = settings;
  aws.resolvePool();
  const op = command === "disable" ? "admin-disable-user" : "admin-enable-user";
  runSteps([{ what: `${command} ${username}`, run: () => aws.write(op, { username }) }], settings);
  if (settings.dryRun) return;
  deps.log(command === "disable" ? `Disabled ${username}: their tokens stop working on their next request, and they can't sign in.` : `Enabled ${username}: they can sign in again.`);
}

function remove(aws, settings, deps) {
  const { username, flags } = settings;
  aws.resolvePool();
  const steps = [
    { what: `remove ${username} from the ${OPERATORS_GROUP} group`, run: () => aws.write("admin-remove-user-from-group", { username, "group-name": OPERATORS_GROUP }) },
    { what: `sign ${username} out everywhere`, run: () => aws.write("admin-user-global-sign-out", { username }) },
    { what: `disable ${username}`, run: () => aws.write("admin-disable-user", { username }) },
  ];
  if (flags.yes) steps.push({ what: `delete ${username}`, run: () => aws.write("admin-delete-user", { username }) });
  runSteps(steps, settings, () => `Run the same command again once the cause is fixed: each step is safe to repeat.`);
  if (settings.dryRun) return;
  if (flags.yes) {
    deps.log(`Removed and deleted ${username}. Their operator audit entries stay (2 years).`);
  } else {
    deps.log(`Removed ${username} from ${OPERATORS_GROUP}, signed them out everywhere and disabled them. The user is still in the pool.`);
    deps.log(`To delete them for good: npm run operators -- remove ${username} --yes`);
  }
}

function reset(aws, settings, deps) {
  const { username, flags } = settings;
  const sendEmail = Boolean(flags["send-email"]);
  const keepDisabled = !flags.enable;
  checkPasswordOutput(settings, deps);
  aws.refuseCliHistory();
  aws.resolvePool();
  const password = generatePassword();
  const steps = [
    { what: `sign ${username} out everywhere`, run: () => aws.write("admin-user-global-sign-out", { username }) },
    { what: `disable ${username}`, run: () => aws.write("admin-disable-user", { username }) },
    {
      what: `turn off ${username}'s TOTP`,
      run: () => aws.write("admin-set-user-mfa-preference", { username, "software-token-mfa-settings": "Enabled=false,PreferredMfa=false" }),
    },
    {
      what: `set a new temporary password for ${username}`,
      run: () => aws.write("admin-set-user-password", undefined, { input: { Username: username, Password: password, Permanent: false }, secret: "Password" }),
    },
  ];
  if (!keepDisabled) steps.push({ what: `enable ${username}`, run: () => aws.write("admin-enable-user", { username }) });
  if (sendEmail) {
    // AdminSetUserPassword left them in FORCE_CHANGE_PASSWORD, which RESEND needs (Cognito refuses it
    // for a confirmed user). RESEND makes a new temporary password and emails it, replacing the
    // throwaway one above, which nobody sees.
    steps.push({
      what: `email ${username} a new temporary password`,
      run: () => aws.write("admin-create-user", { username, "message-action": "RESEND", "desired-delivery-mediums": "EMAIL" }),
    });
  }
  runSteps(steps, settings, (doneCount) =>
    [
      ...(doneCount >= 2 ? [`${username} is cut off: signed out and disabled.`] : []),
      "Run the same command again once the cause is fixed: each step is safe to repeat.",
      ...(sendEmail && doneCount === steps.length - 1 ? ["If the email can't go (no email address on the account), run it without --send-email and hand the password over in person."] : []),
    ].join(" "),
  );
  if (settings.dryRun) return;
  deps.log(`Reset ${username}: signed out everywhere, TOTP off, new temporary password${keepDisabled ? ", still disabled" : ", enabled again"}.`);
  if (sendEmail) deps.log(`Cognito emailed the temporary password to the address on ${username}'s account; it expires in ${TEMP_PASSWORD_DAYS} day.`);
  else deps.out(passwordBlock(username, password, settings));
  const next = [
    `Check it took: npm run operators -- list should show ${username} with no TOTP${keepDisabled ? " and disabled" : ""}.`,
    ...(keepDisabled
      ? [`Once they've a clean device: npm run operators -- enable ${username} (the temporary password expires in ${TEMP_PASSWORD_DAYS} day; after that, reset again).`]
      : []),
    `${username} deletes the old entry from their authenticator app, signs in with the temporary password, chooses a new one and sets up TOTP again.`,
    "Read what the account did: npm run ops -- audit (and --team PLATFORM for team lists), the ops function's logs, and CloudTrail for the pool.",
    'End comps it shouldn\'t have made: npm run ops -- uncomp <teamId> --reason "..."',
  ];
  deps.log(["", "Next:", ...next.map((line, i) => `  ${i + 1}. ${line}`)].join("\n"));
}

const OPS_BY_COMMAND = {
  add: ["admin-create-user", "admin-add-user-to-group"],
  list: [],
  disable: ["admin-disable-user"],
  enable: ["admin-enable-user"],
  remove: ["admin-remove-user-from-group", "admin-user-global-sign-out", "admin-disable-user"],
  reset: ["admin-user-global-sign-out", "admin-disable-user", "admin-set-user-mfa-preference", "admin-set-user-password", "admin-enable-user"],
};

/** Runs one command. `deps` holds everything with side effects ({ env, run, log, out, isTTY }), so tests can fake them. */
export function main(argv, deps) {
  const parsed = parseArgs(argv);
  if (parsed.flags.help || !parsed.command) {
    deps.log(USAGE);
    return parsed.command || parsed.flags.help ? 0 : 2;
  }
  const settings = validate(parsed, deps.env);
  const aws = new Aws(settings, deps);
  if (settings.dryRun) deps.log(`Dry run: ${settings.command}${settings.username ? ` ${settings.username}` : ""} in ${settings.envName} would run (nothing is run, passwords are redacted):`);
  ({ add, list, disable: simple, enable: simple, remove, reset })[settings.command](aws, settings, deps);
  let ops = OPS_BY_COMMAND[settings.command];
  if (settings.command === "remove" && settings.flags.yes) ops = [...ops, "admin-delete-user"];
  if (settings.command === "reset" && !settings.flags.enable) ops = ops.filter((op) => op !== "admin-enable-user");
  if (settings.command === "reset" && settings.flags["send-email"]) ops = [...ops, "admin-create-user"];
  deps.log(alertNote(ops));
  return 0;
}

/* c8 ignore start -- the real process wiring; main() is tested with fakes */
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const deps = {
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
    log: (m) => console.log(m),
    out: (m) => process.stdout.write(`${m}\n`),
    // stderr (the CLI's errors) goes to the terminal
    run: (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }),
  };
  // A request file is removed in a finally as soon as its call returns. These catch the rest:
  // Ctrl-C or a kill while the AWS CLI runs (the call returns first, since it's synchronous,
  // and these handlers keep Node from dying before its finally), and any other way out.
  process.on("exit", removeSecretFiles);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      removeSecretFiles();
      process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
    });
  }
  try {
    process.exitCode = main(process.argv.slice(2), deps);
  } catch (error) {
    if (error instanceof UsageError) console.error(`${error.message}\n\n${USAGE}`);
    else console.error(error.message);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
/* c8 ignore stop */
