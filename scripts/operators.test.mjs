// node --test scripts/operators.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALERTING_CALLS, EMAIL, generatePassword, main, parseArgs, PartialError, REDACTED, USERNAME, UsageError } from "./operators.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const POOL = "test-local-1_Pool1";
const PARAM = "/supply-checkout/prod/identity/ops-user-pool-id";
const LIST = {
  Users: [
    { Username: "alex", UserStatus: "CONFIRMED", Enabled: true, UserCreateDate: "2026-09-01T10:00:00.000Z", Attributes: [{ Name: "email", Value: "alex@example.com" }] },
    { Username: "sam", UserStatus: "FORCE_CHANGE_PASSWORD", Enabled: false, UserCreateDate: "2026-09-20T10:00:00.000Z", Attributes: [] },
  ],
};

/** Fakes for main(): an AWS CLI that records each call and its stdin, and fails `fail` ops. */
function harness({ fail = [], history = "", tty = true, env = {} } = {}) {
  const calls = [];
  const logs = [];
  const outs = [];
  const run = (cmd, args, input) => {
    assert.equal(cmd, "aws");
    calls.push({ args, input: input === undefined ? undefined : JSON.parse(input) });
    const [service, op] = args;
    if (service === "configure") {
      if (!history) throw new Error("exit 1");
      return `${history}\n`;
    }
    if (service === "ssm") return `${POOL}\n`;
    if (fail.includes(op)) throw new Error(`Command failed: aws ${op}\nAn error occurred (TestException)`);
    if (op === "list-users") return JSON.stringify(LIST);
    if (op === "list-users-in-group") return JSON.stringify({ Users: [{ Username: "alex" }, { Username: "gone" }] });
    if (op === "admin-get-user") {
      const user = args[args.indexOf("--username") + 1];
      return JSON.stringify(user === "alex" ? { UserMFASettingList: ["SOFTWARE_TOKEN_MFA"] } : {});
    }
    return "";
  };
  const deps = { env, isTTY: tty, run, log: (m) => logs.push(m), out: (m) => outs.push(m) };
  const ops = () => calls.filter((c) => c.args[0] === "cognito-idp").map((c) => c.args[1]);
  return { deps, calls, logs, outs, ops, text: () => [...logs, ...outs].join("\n") };
}

const passwordIn = (h) => h.calls.find((c) => c.input)?.input;

test("parses commands, usernames and flags, and refuses unknown or empty ones", () => {
  assert.deepEqual(parseArgs(["add", "alex", "--email=alex@example.com", "--send-email"]), { command: "add", args: ["alex"], flags: { email: "alex@example.com", "send-email": true } });
  assert.throws(() => parseArgs(["add", "alex", "--nope"]), UsageError);
  assert.throws(() => parseArgs(["add", "alex", "--email"]), UsageError);
  assert.throws(() => parseArgs(["add", "alex", "--email", "--send-email"]), UsageError);
  assert.throws(() => parseArgs(["add", "alex", "--yes=no"]), UsageError);
});

test("accepts only strict usernames and plain email addresses", () => {
  for (const ok of ["alex", "a", "alex.b", "alex_b-2", "9lives", "a".repeat(64)]) assert.ok(USERNAME.test(ok), ok);
  for (const bad of ["", "Alex", "alex@example.com", "-alex", ".alex", "a b", "a".repeat(65), "alex/..", "al\nex", "ålex"]) assert.ok(!USERNAME.test(bad), bad);
  for (const ok of ["alex@example.com", "a.b+ops@example.org"]) assert.ok(EMAIL.test(ok), ok);
  for (const bad of ["alex", "alex@", "@example.com", "alex@example", "a b@example.com", "alex@example.com,x@example.com", "alex@exa_mple.com"]) assert.ok(!EMAIL.test(bad), bad);
  for (const argv of [
    ["add", "Alex"],
    ["add"],
    ["add", "alex", "sam"],
    ["list", "alex"],
    ["add", "alex", "--email", "nope"],
    ["add", "alex", "--send-email"],
    ["add", "alex", "--email", "alex@example.com", "--send-email", "--print-password"],
    ["reset", "alex", "--send-email", "--keep-disabled"],
    ["disable", "alex", "--yes"],
    ["list", "--email", "alex@example.com"],
    ["frobnicate", "alex"],
    ["add", "alex", "--env", "Prod"],
    ["add", "alex", "--profile", "a b"],
    ["add", "alex", "--region", "nowhere"],
    ["add", "alex", "--pool-id", "../x"],
  ]) {
    const h = harness();
    assert.throws(() => main(argv, h.deps), UsageError, argv.join(" "));
    assert.deepEqual(h.calls, [], `${argv.join(" ")} ran nothing`);
  }
});

test("--send-email needs --email, and says so", () => {
  const h = harness();
  assert.throws(() => main(["add", "alex", "--send-email"], h.deps), /--send-email needs --email/);
});

test("prints the usage for --help or no command", () => {
  const h = harness();
  assert.equal(main(["--help"], h.deps), 0);
  assert.equal(main([], h.deps), 2);
  assert.match(h.logs[0], /Usage: npm run operators/);
});

test("makes strong temporary passwords with every class the pool needs", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const p = generatePassword();
    assert.equal(p.length, 24);
    assert.match(p, /[A-Z]/);
    assert.match(p, /[a-z]/);
    assert.match(p, /[0-9]/);
    assert.match(p, /[!#%*+\-=?@^_~]/);
    assert.doesNotMatch(p, /[IOlo01\s'"`$\\]/);
    seen.add(p);
  }
  assert.equal(seen.size, 200);
  // Every class is there even when the random source always picks the first character
  assert.match(generatePassword(16, () => 0), /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[!#%*+\-=?@^_~]).{16}$/);
});

test("add creates the user with the password on stdin, adds them to the group, and prints the password once", () => {
  const h = harness();
  assert.equal(main(["add", "alex", "--email", "alex@example.com"], h.deps), 0);
  assert.deepEqual(h.calls[0].args, ["configure", "get", "cli_history", "--profile", "supply-prod"]);
  assert.deepEqual(h.calls[1].args.slice(0, 4), ["ssm", "get-parameter", "--name", PARAM]);
  assert.ok(h.calls[1].args.includes("us-east-1"), "the primary region by default"); // public-safety: allow
  assert.deepEqual(h.ops(), ["admin-create-user", "admin-add-user-to-group"]);
  const create = h.calls[2];
  assert.deepEqual(create.args.slice(0, 4), ["cognito-idp", "admin-create-user", "--cli-input-json", "file:///dev/stdin"]);
  const { TemporaryPassword: password, ...rest } = create.input;
  assert.deepEqual(rest, {
    UserPoolId: POOL,
    Username: "alex",
    UserAttributes: [{ Name: "email", Value: "alex@example.com" }, { Name: "email_verified", Value: "true" }],
    MessageAction: "SUPPRESS",
  });
  assert.equal(password.length, 24);
  for (const c of h.calls) assert.ok(!c.args.join(" ").includes(password), "never in argv");
  assert.deepEqual(h.calls[3].args.slice(0, 8), ["cognito-idp", "admin-add-user-to-group", "--user-pool-id", POOL, "--username", "alex", "--group-name", "operators"]);
  assert.equal(h.outs.length, 1);
  assert.equal(h.outs[0].split(password).length, 2, "printed exactly once");
  assert.match(h.outs[0], /in person/);
  assert.match(h.outs[0], /expires in 1 day/);
  assert.match(h.outs[0], /TOTP/);
  assert.ok(!h.logs.join("\n").includes(password), "only in the one output block");
  assert.match(h.logs.at(-1), /P1 alerts .*AdminCreateUser, AdminAddUserToGroup/);
});

test("add without --email sets no attributes; --profile, --region, --pool-id and $AWS_PROFILE are used", () => {
  const h = harness({ env: { AWS_PROFILE: "admin-x" } });
  main(["add", "sam", "--region", "test-local-2", "--pool-id", POOL], h.deps);
  assert.equal(h.calls.filter((c) => c.args[0] === "ssm").length, 0);
  const create = h.calls.find((c) => c.args[1] === "admin-create-user");
  assert.equal(create.input.UserAttributes, undefined);
  for (const c of h.calls.filter((c) => c.args[0] === "cognito-idp")) {
    assert.equal(c.args[c.args.indexOf("--profile") + 1], "admin-x");
    assert.equal(c.args[c.args.indexOf("--region") + 1], "test-local-2");
  }
  const h2 = harness({ env: { AWS_PROFILE: "admin-x" } });
  main(["list", "--profile", "other"], h2.deps);
  assert.ok(h2.calls.every((c) => c.args[c.args.indexOf("--profile") + 1] === "other"));
});

test("add --send-email lets Cognito email the password and prints none", () => {
  const h = harness({ tty: false });
  main(["add", "alex", "--email", "alex@example.com", "--send-email"], h.deps);
  const create = passwordIn(h);
  assert.equal(create.MessageAction, undefined);
  assert.deepEqual(create.DesiredDeliveryMediums, ["EMAIL"]);
  assert.deepEqual(h.outs, []);
  assert.ok(!h.text().includes(create.TemporaryPassword));
  assert.match(h.text(), /emailed the temporary password to alex@example.com/);
});

test("add and reset refuse to print a password where it could be kept, before any AWS call", () => {
  for (const argv of [["add", "alex"], ["reset", "alex"]]) {
    const h = harness({ tty: false });
    assert.throws(() => main(argv, h.deps), /stdout isn't a terminal/);
    assert.deepEqual(h.calls, []);
    const ok = harness({ tty: false });
    main([...argv, "--print-password"], ok.deps);
    assert.equal(ok.outs.length, 1);
  }
});

test("add and reset refuse when the AWS CLI's history would keep the password", () => {
  for (const argv of [["add", "alex"], ["reset", "alex"]]) {
    const h = harness({ history: "enabled" });
    assert.throws(() => main(argv, h.deps), /cli_history/);
    assert.deepEqual(h.ops(), []);
  }
  const off = harness({ history: "disabled" });
  main(["add", "alex"], off.deps);
  assert.deepEqual(off.ops(), ["admin-create-user", "admin-add-user-to-group"]);
});

test("add says what's left when the group add fails after the user was created", () => {
  const h = harness({ fail: ["admin-add-user-to-group"] });
  let error;
  try {
    main(["add", "alex"], h.deps);
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof PartialError);
  const password = passwordIn(h).TemporaryPassword;
  assert.ok(!error.message.includes(password));
  assert.deepEqual(h.outs, [], "no password for a half-made operator");
  assert.match(error.message, /Stopped: add alex to the operators group failed/);
  assert.match(error.message, /Already done: create alex in the operator pool/);
  assert.match(error.message, /isn't in operators/);
  assert.match(error.message, new RegExp(`finish: +aws cognito-idp admin-add-user-to-group --user-pool-id ${POOL} --username alex --group-name operators`));
  assert.match(error.message, /npm run operators -- reset alex/);
  assert.match(error.message, new RegExp(`undo: +aws cognito-idp admin-delete-user --user-pool-id ${POOL} --username alex`));
});

test("add says nothing changed when the create fails", () => {
  const h = harness({ fail: ["admin-create-user"] });
  assert.throws(() => main(["add", "alex"], h.deps), (e) => e instanceof PartialError && /Nothing was changed/.test(e.message) && !/finish:/.test(e.message));
  assert.deepEqual(h.ops(), ["admin-create-user"]);
});

test("a failed SSM read or a bad pool ID stops before any change", () => {
  const h = harness();
  h.deps.run = (cmd, args) => {
    h.calls.push({ args });
    return args[0] === "ssm" ? "None\n" : "";
  };
  assert.throws(() => main(["disable", "alex"], h.deps), /Couldn't read the operator pool ID/);
  assert.deepEqual(h.ops(), []);
});

test("list shows status, enabled, TOTP, group and created, without emails unless asked", () => {
  const h = harness();
  main(["list"], h.deps);
  assert.deepEqual(h.ops(), ["list-users", "list-users-in-group", "admin-get-user", "admin-get-user"]);
  const table = h.logs.join("\n");
  assert.match(table, /^USERNAME +STATUS +ENABLED +MFA +GROUP +CREATED$/m);
  assert.match(table, /^alex +CONFIRMED +enabled +TOTP +operators +2026-09-01$/m);
  assert.match(table, /^sam +FORCE_CHANGE_PASSWORD +disabled +no TOTP +not in group +2026-09-20$/m);
  assert.match(table, /In the group but not listed: gone/);
  assert.doesNotMatch(table, /@/);
  assert.match(table, /No P1 alert expected/);
  const e = harness();
  main(["list", "--emails"], e.deps);
  assert.match(e.logs.join("\n"), /^alex .* alex@example\.com$/m);
  assert.match(e.logs.join("\n"), /^sam .* \(no email\)$/m);
});

test("list says when the pool is empty", () => {
  const h = harness();
  const run = h.deps.run;
  h.deps.run = (cmd, args, input) => (args[1] === "list-users" ? "{}" : run(cmd, args, input));
  main(["list"], h.deps);
  assert.match(h.logs.join("\n"), /No users in the operator pool/);
});

test("disable and enable make one call each; only enable alerts", () => {
  const d = harness();
  main(["disable", "alex"], d.deps);
  assert.deepEqual(d.ops(), ["admin-disable-user"]);
  assert.match(d.text(), /Disabled alex/);
  assert.match(d.text(), /No P1 alert expected/);
  const e = harness();
  main(["enable", "alex"], e.deps);
  assert.deepEqual(e.ops(), ["admin-enable-user"]);
  assert.match(e.text(), /P1 alerts .*AdminEnableUser/);
  const f = harness({ fail: ["admin-disable-user"] });
  assert.throws(() => main(["disable", "alex"], f.deps), /Stopped: disable alex failed .*\nNothing was changed/);
});

test("remove takes them out of the group, signs out and disables; deletes only with --yes", () => {
  const h = harness();
  main(["remove", "alex"], h.deps);
  assert.deepEqual(h.ops(), ["admin-remove-user-from-group", "admin-user-global-sign-out", "admin-disable-user"]);
  assert.match(h.text(), /npm run operators -- remove alex --yes/);
  assert.match(h.text(), /AdminRemoveUserFromGroup/);
  const y = harness();
  main(["remove", "alex", "--yes"], y.deps);
  assert.deepEqual(y.ops(), ["admin-remove-user-from-group", "admin-user-global-sign-out", "admin-disable-user", "admin-delete-user"]);
  assert.match(y.text(), /deleted alex/);
  const f = harness({ fail: ["admin-disable-user"] });
  assert.throws(() => main(["remove", "alex", "--yes"], f.deps), (e) => /Already done: remove alex from the operators group; sign alex out everywhere/.test(e.message) && /Not done: disable alex; delete alex/.test(e.message));
  assert.ok(!f.ops().includes("admin-delete-user"));
});

test("reset runs the stolen-credential runbook and prints the next steps", () => {
  const h = harness();
  main(["reset", "alex"], h.deps);
  assert.deepEqual(h.ops(), ["admin-user-global-sign-out", "admin-disable-user", "admin-set-user-mfa-preference", "admin-set-user-password", "admin-enable-user"]);
  const mfa = h.calls.find((c) => c.args[1] === "admin-set-user-mfa-preference").args;
  assert.equal(mfa[mfa.indexOf("--software-token-mfa-settings") + 1], "Enabled=false,PreferredMfa=false");
  const set = h.calls.find((c) => c.args[1] === "admin-set-user-password");
  assert.deepEqual(set.args.slice(2, 4), ["--cli-input-json", "file:///dev/stdin"]);
  assert.equal(set.input.Permanent, false);
  assert.equal(set.input.Username, "alex");
  assert.equal(h.outs.length, 1);
  assert.ok(h.outs[0].includes(set.input.Password));
  assert.ok(!h.logs.join("\n").includes(set.input.Password));
  assert.match(h.text(), /Next:[\s\S]*TOTP again[\s\S]*npm run ops -- audit/);
  assert.match(h.text(), /AdminSetUserMFAPreference, AdminSetUserPassword, AdminEnableUser/);
});

test("reset --keep-disabled leaves them disabled; --send-email has Cognito resend the invitation", () => {
  const k = harness();
  main(["reset", "alex", "--keep-disabled"], k.deps);
  assert.ok(!k.ops().includes("admin-enable-user"));
  assert.match(k.text(), /npm run operators -- enable alex/);
  assert.doesNotMatch(k.logs.at(-1), /AdminEnableUser/);
  const s = harness({ tty: false });
  main(["reset", "alex", "--send-email"], s.deps);
  assert.deepEqual(s.ops().slice(-2), ["admin-enable-user", "admin-create-user"]);
  const resend = s.calls.at(-1).input;
  assert.equal(resend.MessageAction, "RESEND");
  assert.deepEqual(resend.DesiredDeliveryMediums, ["EMAIL"]);
  assert.deepEqual(s.outs, []);
  assert.ok(!s.text().includes(resend.TemporaryPassword));
  assert.match(s.logs.at(-1), /AdminCreateUser/);
});

test("reset says the operator is cut off when a later step fails", () => {
  const h = harness({ fail: ["admin-set-user-password"] });
  assert.throws(
    () => main(["reset", "alex"], h.deps),
    (e) => /cut off: signed out and disabled/.test(e.message) && /Not done: set a new temporary password for alex; enable alex/.test(e.message),
  );
  assert.ok(!h.ops().includes("admin-enable-user"));
  assert.deepEqual(h.outs, []);
  const s = harness({ fail: ["admin-create-user"], tty: false });
  assert.throws(() => main(["reset", "alex", "--send-email"], s.deps), /run it without --send-email/);
  const early = harness({ fail: ["admin-user-global-sign-out"] });
  assert.throws(() => main(["reset", "alex"], early.deps), (e) => /Nothing was changed/.test(e.message) && !/cut off/.test(e.message));
});

test("--dry-run prints every call, redacts the password and runs nothing", () => {
  for (const argv of [
    ["add", "alex", "--email", "alex@example.com"],
    ["add", "alex", "--email", "alex@example.com", "--send-email"],
    ["list"],
    ["disable", "alex"],
    ["enable", "alex"],
    ["remove", "alex", "--yes"],
    ["reset", "alex"],
    ["reset", "alex", "--send-email"],
  ]) {
    const h = harness({ tty: false });
    assert.equal(main([...argv, "--dry-run"], h.deps), 0);
    assert.deepEqual(h.calls, [], `${argv.join(" ")} ran nothing`);
    assert.deepEqual(h.outs, []);
    const text = h.text();
    assert.match(text, /^Dry run:/);
    assert.match(text, new RegExp(`aws ssm get-parameter --name ${PARAM}`));
    assert.match(text, /P1 alert/);
    for (const op of argv[0] === "list" ? ["list-users", "list-users-in-group", "admin-get-user"] : []) assert.match(text, new RegExp(`cognito-idp ${op} `));
    if (argv[0] === "add" || argv[0] === "reset") {
      assert.match(text, /--cli-input-json file:\/\/\/dev\/stdin/);
      assert.ok(text.includes(`"${REDACTED}"`));
      assert.doesNotMatch(text, /"(Temporary)?Password": "(?!<redacted>)/);
    }
  }
  const h = harness();
  main(["remove", "alex", "--yes", "--dry-run", "--pool-id", POOL], h.deps);
  assert.match(h.text(), new RegExp(`aws cognito-idp admin-delete-user --user-pool-id ${POOL} --username alex --profile supply-prod`));
  assert.doesNotMatch(h.text(), /ssm get-parameter/);
});

test("the alerted calls match the observability stack's OPERATOR_USER_EVENTS", () => {
  const source = readFileSync(path.join(here, "..", "infra", "lib", "stacks", "observability-stack.ts"), "utf8");
  const block = source.match(/OPERATOR_USER_EVENTS = \[([\s\S]*?)\]/)[1];
  const events = [...block.matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(Object.values(ALERTING_CALLS).sort(), events.sort());
});

// The real script, with a fake `aws` on PATH: what reaches the AWS CLI's argv, and what's on disk afterwards

const FAKE_AWS = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const args = process.argv.slice(2);
let stdin;
if (args.includes("file:///dev/stdin")) {
  const body = JSON.parse(readFileSync(0, "utf8"));
  for (const k of ["TemporaryPassword", "Password"]) if (k in body) body[k] = "sha256:" + createHash("sha256").update(body[k]).digest("hex");
  stdin = body;
}
appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify({ args, stdin }) + "\\n");
if (args[0] === "configure") process.exit(1);
if (args[0] === "ssm") { process.stdout.write("${POOL}\\n"); process.exit(0); }
if (args[1] === process.env.FAKE_AWS_FAIL) { process.stderr.write("An error occurred (TestException)\\n"); process.exit(254); }
process.stdout.write("{}\\n");
`;

function realRun(argv, { fail } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "operators-cli-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  for (const d of [bin, home, tmp]) mkdirSync(d);
  writeFileSync(path.join(bin, "aws"), FAKE_AWS);
  chmodSync(path.join(bin, "aws"), 0o755);
  const log = path.join(root, "aws-calls.jsonl");
  const result = spawnSync(process.execPath, [path.join(here, "operators.mjs"), ...argv], {
    encoding: "utf8",
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home, TMPDIR: tmp, FAKE_AWS_LOG: log, ...(fail ? { FAKE_AWS_FAIL: fail } : {}) },
  });
  let calls = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  } catch {}
  return { root, result, calls };
}

/** Every file under `dir`, read. */
function filesUnder(dir) {
  return readdirSync(dir, { recursive: true })
    .map((f) => path.join(dir, f))
    .filter((f) => statSync(f).isFile())
    .map((f) => readFileSync(f, "utf8"));
}

test("the real script hands the password to the AWS CLI on stdin only, and leaves it nowhere on disk", () => {
  const { root, result, calls } = realRun(["add", "alex", "--email", "alex@example.com", "--print-password"]);
  assert.equal(result.status, 0, result.stderr);
  const password = result.stdout.match(/^ {4}(\S{24})$/m)?.[1];
  assert.ok(password, result.stdout);
  assert.equal(result.stdout.split(password).length, 2, "printed once");
  const create = calls.find((c) => c.args[1] === "admin-create-user");
  assert.equal(create.stdin.TemporaryPassword, `sha256:${createHash("sha256").update(password).digest("hex")}`, "the CLI got it on stdin");
  for (const c of calls) assert.ok(!c.args.some((a) => a.includes(password)), "never in the CLI's argv");
  assert.deepEqual(calls.map((c) => c.args[1]), ["get", "get-parameter", "admin-create-user", "admin-add-user-to-group"]);
  for (const content of filesUnder(root)) assert.ok(!content.includes(password), "not in any file: HOME, TMPDIR or elsewhere");
  assert.ok(!result.stderr.includes(password));
});

test("the real script refuses to print a password into a pipe, and exits non-zero on a partial failure", () => {
  const piped = realRun(["reset", "alex"]);
  assert.equal(piped.result.status, 2);
  assert.match(piped.result.stderr, /stdout isn't a terminal/);
  assert.deepEqual(piped.calls, []);
  const partial = realRun(["add", "alex", "--print-password"], { fail: "admin-add-user-to-group" });
  assert.equal(partial.result.status, 1);
  assert.match(partial.result.stderr, /Already done: create alex in the operator pool/);
  assert.match(partial.result.stderr, /undo: +aws cognito-idp admin-delete-user/);
  assert.doesNotMatch(partial.result.stdout, /Temporary password/);
});
