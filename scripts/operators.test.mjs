// node --test scripts/operators.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALERTING_CALLS, EMAIL, generatePassword, main, parseArgs, PartialError, REDACTED, removeSecretFiles, USERNAME, UsageError, withSecretFile } from "./operators.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const POOL = "test-local-1_Pool1";
const PARAM = "/supply-checkout/prod/identity/ops-user-pool-id";
const LIST = {
  Users: [
    { Username: "alex", UserStatus: "CONFIRMED", Enabled: true, UserCreateDate: "2026-09-01T10:00:00.000Z", Attributes: [{ Name: "email", Value: "alex@example.com" }] },
    { Username: "sam", UserStatus: "FORCE_CHANGE_PASSWORD", Enabled: false, UserCreateDate: "2026-09-20T10:00:00.000Z", Attributes: [] },
  ],
};

/**
 * Reads a --cli-input-json file:// request as the AWS CLI does, and checks it's owner-only.
 * Like the real CLI on macOS (supply-checkout-6uw.17), it can't read file:///dev/stdin.
 */
function readRequest(args) {
  const i = args.indexOf("--cli-input-json");
  if (i < 0) return undefined;
  const url = args[i + 1];
  if (url === "file:///dev/stdin") throw new Error("Unable to load paramfile file:///dev/stdin: [Errno 13] Permission denied: '/dev/stdin'");
  assert.match(url, /^file:\/\//);
  const file = url.slice("file://".length);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700, "in an owner-only folder");
  // One open: its mode and contents come from the same file
  const fd = openSync(file, "r");
  try {
    assert.equal(fstatSync(fd).mode & 0o777, 0o600, "the request file is owner-only");
    return { file, body: JSON.parse(readFileSync(fd, "utf8")) };
  } finally {
    closeSync(fd);
  }
}

/** Fakes for main(): an AWS CLI that records each call and its request file, and fails `fail` ops. */
function harness({ fail = [], history = "", tty = true, env = {}, poolName = "supply-checkout-prod-ops", group = true } = {}) {
  const calls = [];
  const logs = [];
  const outs = [];
  const tmp = mkdtempSync(path.join(tmpdir(), "operators-unit-"));
  const run = (cmd, args) => {
    assert.equal(cmd, "aws");
    const request = readRequest(args);
    calls.push({ args, input: request?.body, file: request?.file });
    const [service, op] = args;
    if (service === "configure") {
      if (!history) throw new Error("exit 1");
      return `${history}\n`;
    }
    if (service === "ssm") return `${POOL}\n`;
    if (op === "describe-user-pool") return `${poolName}\n`;
    if (op === "get-group") {
      if (!group) throw new Error("Command failed: aws get-group\nAn error occurred (ResourceNotFoundException)");
      return "operators\n";
    }
    if (fail.includes(op)) throw new Error(`Command failed: aws ${op}\nAn error occurred (TestException)`);
    if (op === "list-users") return JSON.stringify(LIST);
    if (op === "list-users-in-group") return JSON.stringify({ Users: [{ Username: "alex" }, { Username: "gone" }] });
    if (op === "admin-get-user") {
      const user = args[args.indexOf("--username") + 1];
      return JSON.stringify(user === "alex" ? { UserMFASettingList: ["SOFTWARE_TOKEN_MFA"] } : {});
    }
    return "";
  };
  const deps = { env, isTTY: tty, run, tmpdir: tmp, log: (m) => logs.push(m), out: (m) => outs.push(m) };
  const CHECKS = ["describe-user-pool", "get-group"];
  const ops = () => calls.filter((c) => c.args[0] === "cognito-idp" && !CHECKS.includes(c.args[1])).map((c) => c.args[1]);
  /** What's left in the folder request files are made in: must be nothing once a command is over. */
  const leftovers = () => readdirSync(tmp);
  return { deps, calls, logs, outs, ops, leftovers, text: () => [...logs, ...outs].join("\n") };
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
    ["reset", "alex", "--send-email"],
    ["reset", "alex", "--keep-disabled"],
    ["add", "alex", "--profile", "-x"],
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

test("add creates the user with the password in an owner-only request file, adds them to the group, and prints the password once", () => {
  const h = harness();
  assert.equal(main(["add", "alex", "--email", "alex@example.com"], h.deps), 0);
  assert.deepEqual(h.calls[0].args, ["configure", "get", "cli_history", "--profile", "supply-prod"]);
  assert.deepEqual(h.calls[1].args.slice(0, 4), ["ssm", "get-parameter", "--name", PARAM]);
  assert.ok(h.calls[1].args.includes("us-east-1"), "the primary region by default"); // public-safety: allow
  assert.deepEqual(h.ops(), ["admin-create-user", "admin-add-user-to-group"]);
  assert.deepEqual(h.calls.slice(2, 4).map((c) => c.args[1]), ["describe-user-pool", "get-group"], "the pool is checked first");
  const create = h.calls[4];
  assert.deepEqual(create.args.slice(0, 3), ["cognito-idp", "admin-create-user", "--cli-input-json"]);
  assert.equal(create.args[3], `file://${create.file}`);
  assert.deepEqual(h.leftovers(), [], "the request file is gone");
  const { TemporaryPassword: password, ...rest } = create.input;
  assert.deepEqual(rest, {
    UserPoolId: POOL,
    Username: "alex",
    UserAttributes: [{ Name: "email", Value: "alex@example.com" }, { Name: "email_verified", Value: "true" }],
    MessageAction: "SUPPRESS",
  });
  assert.equal(password.length, 24);
  for (const c of h.calls) assert.ok(!c.args.join(" ").includes(password), "never in argv");
  assert.deepEqual(h.calls[5].args.slice(0, 8), ["cognito-idp", "admin-add-user-to-group", "--user-pool-id", POOL, "--username", "alex", "--group-name", "operators"]);
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

test("add --send-email has Cognito make and email the password: none passes through the script", () => {
  const h = harness({ tty: false, history: "enabled" });
  main(["add", "alex", "--email", "alex@example.com", "--send-email"], h.deps);
  assert.equal(passwordIn(h), undefined, "no request file");
  assert.ok(!h.calls.some((c) => c.args[0] === "configure"), "no history check needed: nothing secret");
  const create = h.calls.find((c) => c.args[1] === "admin-create-user").args;
  assert.ok(!create.includes("--cli-input-json"));
  assert.ok(!create.some((a) => /password/i.test(a)), "no password argument");
  assert.ok(!create.includes("--message-action"), "Cognito sends the invitation");
  assert.equal(create[create.indexOf("--desired-delivery-mediums") + 1], "EMAIL");
  assert.deepEqual(JSON.parse(create[create.indexOf("--user-attributes") + 1]), [{ Name: "email", Value: "alex@example.com" }, { Name: "email_verified", Value: "true" }]);
  assert.deepEqual(h.outs, []);
  assert.deepEqual(h.leftovers(), []);
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

test("disable and enable make one call each, and each alerts", () => {
  const d = harness();
  main(["disable", "alex"], d.deps);
  assert.deepEqual(d.ops(), ["admin-disable-user"]);
  assert.match(d.text(), /Disabled alex/);
  assert.match(d.text(), /P1 alerts .*AdminDisableUser/);
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
  // Every one of remove's calls alerts, the deletion included (supply-checkout-6uw.16)
  assert.match(y.logs.at(-1), /P1 alerts \(OperatorPoolChanges\) for AdminRemoveUserFromGroup, AdminUserGlobalSignOut, AdminDisableUser, AdminDeleteUser on/);
  const f = harness({ fail: ["admin-disable-user"] });
  assert.throws(() => main(["remove", "alex", "--yes"], f.deps), (e) => /Already done: remove alex from the operators group; sign alex out everywhere/.test(e.message) && /Not done: disable alex; delete alex/.test(e.message));
  assert.ok(!f.ops().includes("admin-delete-user"));
});

test("reset runs the stolen-credential runbook and prints the next steps", () => {
  const h = harness();
  main(["reset", "alex"], h.deps);
  assert.deepEqual(h.ops(), ["admin-user-global-sign-out", "admin-disable-user", "admin-set-user-mfa-preference", "admin-set-user-password"], "stays disabled by default");
  const mfa = h.calls.find((c) => c.args[1] === "admin-set-user-mfa-preference").args;
  assert.equal(mfa[mfa.indexOf("--software-token-mfa-settings") + 1], "Enabled=false,PreferredMfa=false");
  const set = h.calls.find((c) => c.args[1] === "admin-set-user-password");
  assert.deepEqual(set.args.slice(2, 4), ["--cli-input-json", `file://${set.file}`]);
  assert.deepEqual(h.leftovers(), []);
  assert.equal(set.input.Permanent, false);
  assert.equal(set.input.Username, "alex");
  assert.equal(h.outs.length, 1);
  assert.ok(h.outs[0].includes(set.input.Password));
  assert.ok(!h.logs.join("\n").includes(set.input.Password));
  assert.match(h.text(), /Next:[\s\S]*operators -- list should show alex with no TOTP and disabled[\s\S]*npm run operators -- enable alex[\s\S]*TOTP again[\s\S]*npm run ops -- audit/);
  assert.match(h.logs.at(-1), /for AdminUserGlobalSignOut, AdminDisableUser, AdminSetUserMFAPreference, AdminSetUserPassword on/);
});

test("reset --enable enables them at the end; --send-email (with --enable) has Cognito resend the invitation", () => {
  const k = harness();
  main(["reset", "alex", "--enable"], k.deps);
  assert.equal(k.ops().at(-1), "admin-enable-user");
  assert.doesNotMatch(k.text(), /npm run operators -- enable alex/);
  assert.match(k.logs.at(-1), /AdminEnableUser/);
  assert.throws(() => main(["reset", "alex", "--send-email"], harness().deps), /reset --send-email needs --enable/);
  const s = harness({ tty: false });
  main(["reset", "alex", "--send-email", "--enable"], s.deps);
  assert.deepEqual(s.ops().slice(-2), ["admin-enable-user", "admin-create-user"]);
  const resend = s.calls.at(-1);
  assert.equal(resend.input, undefined, "RESEND passes no password: Cognito makes a new one");
  assert.ok(!resend.args.includes("--cli-input-json") && !resend.args.some((a) => /password/i.test(a)));
  assert.equal(resend.args[resend.args.indexOf("--message-action") + 1], "RESEND");
  assert.equal(resend.args[resend.args.indexOf("--desired-delivery-mediums") + 1], "EMAIL");
  const throwaway = s.calls.find((c) => c.args[1] === "admin-set-user-password").input.Password;
  assert.deepEqual(s.outs, []);
  assert.ok(!s.text().includes(throwaway), "the throwaway password is never shown");
  assert.deepEqual(s.leftovers(), []);
  assert.match(s.logs.at(-1), /AdminCreateUser/);
});

test("reset says the operator is cut off when a later step fails", () => {
  const h = harness({ fail: ["admin-set-user-password"] });
  assert.throws(
    () => main(["reset", "alex", "--enable"], h.deps),
    (e) => /cut off: signed out and disabled/.test(e.message) && /Not done: set a new temporary password for alex; enable alex\./.test(e.message),
  );
  assert.ok(!h.ops().includes("admin-enable-user"));
  assert.deepEqual(h.outs, []);
  const s = harness({ fail: ["admin-create-user"], tty: false });
  assert.throws(() => main(["reset", "alex", "--send-email", "--enable"], s.deps), /run it without --send-email/);
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
    ["reset", "alex", "--send-email", "--enable"],
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
      if (argv.includes("--send-email") && argv[0] === "add") {
        assert.doesNotMatch(text, /--cli-input-json|Password/);
      } else {
        assert.match(text, /--cli-input-json 'file:\/\/<owner-only temporary file, removed after the call>'/);
        assert.ok(text.includes(`"${REDACTED}"`));
        assert.doesNotMatch(text, /"(Temporary)?Password": "(?!<redacted>)/);
      }
    }
    assert.deepEqual(h.leftovers(), []);
  }
  const h = harness();
  main(["remove", "alex", "--yes", "--dry-run", "--pool-id", POOL], h.deps);
  assert.match(h.text(), new RegExp(`aws cognito-idp admin-delete-user --user-pool-id ${POOL} --username alex --profile supply-prod`));
  assert.doesNotMatch(h.text(), /ssm get-parameter/);
});

test("the alerted calls match the observability stack's OPERATOR_USER_EVENTS and OPERATOR_LOCKOUT_EVENTS", () => {
  const source = readFileSync(path.join(here, "..", "infra", "lib", "stacks", "observability-stack.ts"), "utf8");
  const events = ["OPERATOR_USER_EVENTS", "OPERATOR_LOCKOUT_EVENTS"].flatMap((list) => {
    const block = source.match(new RegExp(`${list} = \\[([\\s\\S]*?)\\]`))[1];
    return [...block.matchAll(/"(\w+)"/g)].map((m) => m[1]);
  });
  // Deleting, disabling and signing an operator out alert too (supply-checkout-6uw.16)
  for (const call of ["AdminDeleteUser", "AdminDisableUser", "AdminUserGlobalSignOut"]) assert.ok(events.includes(call), call);
  assert.deepEqual(Object.values(ALERTING_CALLS).sort(), events.sort());
});

// The real script, with a fake `aws` on PATH: what reaches the AWS CLI's argv, and what's on disk afterwards

const FAKE_AWS = `#!/usr/bin/env node
const { appendFileSync, closeSync, fstatSync, openSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
let request;
const at = args.indexOf("--cli-input-json");
if (at >= 0) {
  // As the real CLI does: read the file:// path. It can't open /dev/stdin when that's a socket (macOS)
  const url = args[at + 1];
  if (!url.startsWith("file://") || url === "file:///dev/stdin") {
    process.stderr.write("aws: [ERROR]: Unable to load paramfile " + url + ": [Errno 13] Permission denied\\n");
    process.exit(252);
  }
  const file = url.slice("file://".length);
  const fd = openSync(file, "r");
  const body = JSON.parse(readFileSync(fd, "utf8"));
  const mode = (fstatSync(fd).mode & 0o777).toString(8);
  closeSync(fd);
  // Recorded base64-encoded, so the test can tell what arrived while a plain search of the disk for the password still means a leak
  for (const k of ["TemporaryPassword", "Password"]) if (k in body) body[k] = "base64:" + Buffer.from(body[k]).toString("base64");
  request = { file, mode, body };
}
appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify({ args, request }) + "\\n");
if (request && process.env.FAKE_AWS_SLOW) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_AWS_SLOW));
if (args[0] === "configure") process.exit(1);
if (args[0] === "ssm") { process.stdout.write("${POOL}\\n"); process.exit(0); }
if (args[1] === "describe-user-pool") { process.stdout.write("supply-checkout-prod-ops\\n"); process.exit(0); }
if (args[1] === "get-group") { process.stdout.write("operators\\n"); process.exit(0); }
if (args[1] === process.env.FAKE_AWS_FAIL) { process.stderr.write("An error occurred (TestException)\\n"); process.exit(254); }
process.stdout.write("{}\\n");
`;

function realSetup() {
  const root = mkdtempSync(path.join(tmpdir(), "operators-cli-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  for (const d of [bin, home, tmp]) mkdirSync(d);
  writeFileSync(path.join(bin, "aws"), FAKE_AWS);
  chmodSync(path.join(bin, "aws"), 0o755);
  const log = path.join(root, "aws-calls.jsonl");
  return { root, tmp, log, env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home, TMPDIR: tmp, FAKE_AWS_LOG: log } };
}

function realRun(argv, { fail } = {}) {
  const { root, tmp, log, env } = realSetup();
  const result = spawnSync(process.execPath, [path.join(here, "operators.mjs"), ...argv], {
    encoding: "utf8",
    env: { ...env, ...(fail ? { FAKE_AWS_FAIL: fail } : {}) },
  });
  let calls = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  } catch {}
  return { root, tmp, result, calls };
}

/** Every file under `dir`, read. */
function filesUnder(dir) {
  return readdirSync(dir, { recursive: true })
    .map((f) => path.join(dir, f))
    .filter((f) => statSync(f).isFile())
    .map((f) => readFileSync(f, "utf8"));
}

test("the real script hands the password to the AWS CLI in an owner-only file only, and leaves it nowhere on disk", () => {
  const { root, tmp, result, calls } = realRun(["add", "alex", "--email", "alex@example.com", "--print-password"]);
  assert.equal(result.status, 0, result.stderr);
  const password = result.stdout.match(/^ {4}(\S{24})$/m)?.[1];
  assert.ok(password, result.stdout);
  assert.equal(result.stdout.split(password).length, 2, "printed once");
  const create = calls.find((c) => c.args[1] === "admin-create-user");
  assert.equal(create.request.body.TemporaryPassword, `base64:${Buffer.from(password).toString("base64")}`, "the CLI read it from the file");
  assert.equal(create.request.mode, "600");
  assert.ok(create.request.file.startsWith(tmp), "in TMPDIR");
  assert.deepEqual(readdirSync(tmp), [], "and removed");
  for (const c of calls) assert.ok(!c.args.some((a) => a.includes(password)), "never in the CLI's argv");
  assert.deepEqual(calls.map((c) => c.args[1]), ["get", "get-parameter", "describe-user-pool", "get-group", "admin-create-user", "admin-add-user-to-group"]);
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
  assert.deepEqual(readdirSync(partial.tmp), []);
  const failed = realRun(["reset", "alex", "--print-password"], { fail: "admin-set-user-password" });
  assert.equal(failed.result.status, 1);
  assert.ok(failed.calls.find((c) => c.args[1] === "admin-set-user-password").request, "the CLI read the file before failing");
  assert.deepEqual(readdirSync(failed.tmp), [], "removed after the AWS call failed");
});

test("the real script's add --send-email passes no password and makes no file", () => {
  const { tmp, result, calls } = realRun(["add", "alex", "--email", "alex@example.com", "--send-email"]);
  assert.equal(result.status, 0, result.stderr);
  const create = calls.find((c) => c.args[1] === "admin-create-user");
  assert.equal(create.request, undefined);
  assert.ok(!create.args.some((a) => /password|cli-input-json/i.test(a)));
  assert.deepEqual(readdirSync(tmp), []);
});

test("request files are removed when the AWS call fails or anything throws", () => {
  const failed = harness({ fail: ["admin-create-user"] });
  assert.throws(() => main(["add", "alex"], failed.deps), PartialError);
  assert.ok(failed.calls.find((c) => c.args[1] === "admin-create-user").file);
  assert.deepEqual(failed.leftovers(), []);
  const base = mkdtempSync(path.join(tmpdir(), "operators-throw-"));
  let seen;
  assert.throws(
    () =>
      withSecretFile({ Password: "x" }, (url) => {
        seen = url.slice("file://".length);
        assert.ok(statSync(seen).isFile());
        throw new TypeError("boom");
      }, base),
    TypeError,
  );
  assert.deepEqual(readdirSync(base), []);
  // What the exit and signal handlers call: removes any folder a crash left behind
  const dir = mkdtempSync(path.join(base, "left-"));
  let inside;
  try {
    withSecretFile({ Password: "x" }, (url) => {
      inside = path.dirname(url.slice("file://".length));
      removeSecretFiles();
      assert.ok(!existsSync(inside), "removeSecretFiles removed it mid-call");
    }, dir);
  } finally {
    removeSecretFiles();
  }
  assert.deepEqual(readdirSync(dir), []);
});

test("refuses any pool but the environment's operator pool, before reading or changing a user", () => {
  for (const argv of [["add", "alex"], ["list"], ["disable", "alex"], ["enable", "alex"], ["remove", "alex", "--yes"], ["reset", "alex"], ["list", "--pool-id", POOL]]) {
    const wrong = harness({ poolName: "supply-checkout-prod" });
    assert.throws(() => main(argv, wrong.deps), /Refusing: user pool test-local-1_Pool1 is named "supply-checkout-prod", not supply-checkout-prod-ops/, argv.join(" "));
    assert.deepEqual(wrong.ops(), [], `${argv.join(" ")}: no user read or change`);
    assert.deepEqual(wrong.outs, []);
    const noGroup = harness({ group: false });
    assert.throws(() => main(argv, noGroup.deps), /has no operators group/, argv.join(" "));
    assert.deepEqual(noGroup.ops(), []);
  }
  const staging = harness({ poolName: "supply-checkout-prod-ops" });
  assert.throws(() => main(["disable", "alex", "--env", "staging"], staging.deps), /not supply-checkout-staging-ops/);
  const ok = harness({ poolName: "supply-checkout-staging-ops" });
  main(["disable", "alex", "--env", "staging"], ok.deps);
  assert.deepEqual(ok.ops(), ["admin-disable-user"]);
  const checks = ok.calls.filter((c) => ["describe-user-pool", "get-group"].includes(c.args[1]));
  assert.deepEqual(checks.map((c) => c.args.slice(0, 4)), [["cognito-idp", "describe-user-pool", "--user-pool-id", POOL], ["cognito-idp", "get-group", "--user-pool-id", POOL]]);
});

test("the dry run shows the pool check", () => {
  const h = harness();
  main(["reset", "alex", "--dry-run", "--pool-id", POOL], h.deps);
  assert.deepEqual(h.calls, []);
  assert.match(h.text(), new RegExp(`aws cognito-idp describe-user-pool --user-pool-id ${POOL} --query UserPool.Name`));
  assert.match(h.text(), /stops unless the pool is named supply-checkout-prod-ops/);
  assert.match(h.text(), /aws cognito-idp get-group .*--group-name operators/);
});

test("profiles can't start with a hyphen", () => {
  for (const bad of ["-x", "--x", "-", "a b", "a".repeat(65)]) assert.throws(() => main(["list", `--profile=${bad}`], harness().deps), /Invalid --profile/, bad);
  const h = harness();
  main(["list", "--profile", "supply-prod.admin_1"], h.deps);
  assert.ok(h.calls.length > 0);
});

/**
 * Starts the real script with a slow fake CLI and waits until the CLI is running a call
 * with a request file. Waiting for the file alone isn't enough: its folder exists before
 * the CLI starts, and a SIGINT that reaches the script before then (while its code runs
 * synchronously) never runs its handler, so every step runs and it exits 0.
 */
async function startSlow(argv, extra = {}) {
  const { spawn } = await import("node:child_process");
  const setup = realSetup();
  const child = spawn(process.execPath, [path.join(here, "operators.mjs"), ...argv], { env: { ...setup.env, FAKE_AWS_SLOW: "1500" }, stdio: "ignore", ...extra });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  // The fake CLI logs a call just before it waits, so a logged request means the CLI is running it
  const cliRunning = () => existsSync(setup.log) && readFileSync(setup.log, "utf8").includes('"request":{');
  const started = Date.now();
  while (!cliRunning() && Date.now() - started < 10_000) await new Promise((r) => setTimeout(r, 20));
  assert.ok(cliRunning(), "the CLI is running a call with a request file");
  assert.equal(readdirSync(setup.tmp).length, 1, "the request file exists while the CLI runs");
  return { ...setup, child, exited };
}

test("Ctrl-C while the AWS CLI runs stops the command and removes the request file", async () => {
  // Ctrl-C signals the terminal's whole process group: the script and the CLI
  const { tmp, log, child, exited } = await startSlow(["add", "alex", "--print-password"], { detached: true });
  process.kill(-child.pid, "SIGINT");
  const { code } = await exited;
  assert.notEqual(code, 0);
  assert.deepEqual(readdirSync(tmp), []);
  assert.ok(!readFileSync(log, "utf8").includes("admin-add-user-to-group"), "no further step ran");
});

test("SIGTERM to the script alone still leaves no request file", async () => {
  // Node can't run a handler during the synchronous call, so the call finishes and its finally removes the file
  const { tmp, child, exited } = await startSlow(["reset", "alex", "--print-password"]);
  child.kill("SIGTERM");
  await exited;
  assert.deepEqual(readdirSync(tmp), []);
});
