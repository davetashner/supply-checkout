// node --test scripts/check-replacements.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROTECTED_TYPES, check, findReplacements } from "./check-replacements.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-replacements.mjs");

// Shaped like `cdk diff --no-color` output (aws-cdk 2.1143)
const diff = (body, n = 1) => `Stack supply-checkout-prod-r-data
${body}

✨  Number of stacks with differences: ${n}
`;

test("a diff with no differences passes", () => {
  const text = "Stack supply-checkout-prod-r-data\nThere were no differences\n\n✨  Number of stacks with differences: 0\n";
  const r = check(text);
  assert.equal(r.code, 0);
  assert.equal(r.stacksWithDifferences, 0);
  assert.deepEqual(r.findings, []);
  assert.match(r.report, /Nothing that holds data/);
});

test("updates and additions pass, and property lines aren't resources", () => {
  const r = check(diff(`Resources
[+] AWS::Lambda::Function Fn FnABC
[~] AWS::DynamoDB::GlobalTable Table TableABC
 └─ [~] GlobalSecondaryIndexes
     └─ [+] Added: GSI3
[~] AWS::S3::Bucket Logs LogsABC
 └─ [~] BucketName (requires replacement)`));
  // The resource line, not the property line, carries the impact; here it says none
  assert.equal(r.code, 0);
  assert.deepEqual(r.findings, []);
});

test("blocks a replaced, maybe-replaced, destroyed or orphaned resource that holds data", () => {
  for (const [line, impact] of [
    ["[~] AWS::DynamoDB::GlobalTable Table TableABC replace", "replace"],
    ["[~] AWS::Cognito::UserPool Pool PoolABC may be replaced", "may be replaced"],
    ["[-] AWS::KMS::Key Key KeyABC destroy", "destroy"],
    ["[-] AWS::S3::Bucket Bucket BucketABC orphan", "orphan"],
    ["[-] AWS::Logs::LogGroup Logs LogsABC", "destroy"],
    ["[~] AWS::Route53::HostedZone Zone ZoneABC replace (OR move to supply-checkout-prod-r-domain.ZoneABC via refactoring)", "replace"],
  ]) {
    const r = check(diff(`Resources\n${line}`));
    assert.equal(r.code, 1, line);
    assert.equal(r.findings.length, 1, line);
    assert.equal(r.findings[0].impact, impact, line);
    assert.equal(r.findings[0].stack, "supply-checkout-prod-r-data");
    assert.match(r.report, /\*\*Blocked\.\*\*/);
  }
});

test("blocks anything orphaned, and lists other replacements without blocking", () => {
  const orphan = check(diff("[-] AWS::SNS::Topic Topic TopicABC orphan"));
  assert.equal(orphan.code, 1);
  const r = check(diff("[~] AWS::Lambda::Function Fn FnABC replace\n[-] AWS::SNS::Subscription Sub SubABC destroy"));
  assert.equal(r.code, 0);
  assert.equal(r.findings.length, 2);
  assert.ok(r.findings.every((f) => !f.blocking));
  assert.match(r.report, /Other replacements and deletions \(allowed\)/);
  assert.equal(r.findings[0].id, "Fn FnABC");
});

test("--allow reports the findings but passes", () => {
  const r = check(diff("[~] AWS::DynamoDB::Table T TABC replace"), { allow: true });
  assert.equal(r.code, 0);
  assert.match(r.report, /Allowed by the `allow-replacement` input/);
});

test("tracks the stack each resource is in", () => {
  const text = `Stack a-data
[~] AWS::S3::Bucket B BABC replace
Stack a-identity
[~] AWS::Cognito::UserPoolClient C CABC replace

✨  Number of stacks with differences: 2
`;
  const { findings } = findReplacements(text);
  assert.deepEqual(findings.map((f) => f.stack), ["a-data", "a-identity"]);
});

test("output that isn't a finished diff fails as unreadable, never passes", () => {
  for (const text of ["", "Error: Need to perform AWS calls\n", "Stack x\n[~] AWS::S3::Bucket B BABC replace\n"]) {
    const r = check(text);
    assert.equal(r.code, 2, JSON.stringify(text));
    assert.match(r.report, /couldn't read the diff/);
  }
});

test("protects the types that hold data", () => {
  for (const type of ["AWS::DynamoDB::GlobalTable", "AWS::Cognito::UserPool", "AWS::KMS::Key", "AWS::S3::Bucket", "AWS::Route53::HostedZone", "AWS::Logs::LogGroup"]) {
    assert.ok(PROTECTED_TYPES.has(type), type);
  }
});

test("the command line exits 1 when blocked, 0 with --allow, 2 on bad usage or output", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "check-replacements-"));
  const file = path.join(dir, "diff.txt");
  writeFileSync(file, diff("[~] AWS::DynamoDB::Table T TABC replace"));
  const run = (...args) => {
    try {
      return { code: 0, out: execFileSync("node", [script, ...args], { encoding: "utf8", stdio: "pipe" }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };
  assert.equal(run(file).code, 1);
  assert.equal(run(file, "--allow").code, 0);
  assert.equal(run().code, 2);
  assert.equal(run("--allow").code, 2);
  writeFileSync(file, "nothing\n");
  assert.equal(run(file).code, 2);
});
