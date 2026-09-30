import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAudit, ghsa } from "./npm-audit.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLED = "node_modules/aws-cdk-lib/node_modules/brace-expansion";
const adv = (id, severity) => ({ url: `https://github.com/advisories/${id}`, severity });

function audit(vulns) {
  return { vulnerabilities: vulns };
}
const exception = {
  package: "brace-expansion",
  paths: [BUNDLED],
  advisories: ["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"],
  expires: "2026-10-31",
  bead: "supply-checkout-x",
};
const brace = (nodes = [BUNDLED], via = [adv("GHSA-aaaa-bbbb-cccc", "high"), adv("GHSA-dddd-eeee-ffff", "moderate")]) => ({
  severity: "high",
  nodes,
  via,
});

test("ghsa takes the ID from an advisory URL", () => {
  assert.equal(ghsa("https://github.com/advisories/GHSA-q2hr-2g5m-vwhr"), "GHSA-q2hr-2g5m-vwhr");
});

test("a covered advisory at the listed path is allowed until it expires", () => {
  const r = checkAudit(audit({ "brace-expansion": brace() }), [exception], "2026-10-31");
  assert.deepEqual(r.failures, []);
  assert.equal(r.allowed.length, 1);
});

test("an expired exception fails", () => {
  const r = checkAudit(audit({ "brace-expansion": brace() }), [exception], "2026-11-01");
  assert.match(r.failures[0], /expired on 2026-10-31/);
});

test("a new advisory on the same package fails", () => {
  const r = checkAudit(audit({ "brace-expansion": brace([BUNDLED], [adv("GHSA-zzzz-zzzz-zzzz", "high")]) }), [exception], "2026-10-01");
  assert.match(r.failures[0], /GHSA-zzzz-zzzz-zzzz \(high\) has no exception/);
});

test("the same advisory at another path fails", () => {
  const r = checkAudit(audit({ "brace-expansion": brace([BUNDLED, "node_modules/brace-expansion"]) }), [exception], "2026-10-01");
  assert.match(r.failures[0], /also at node_modules\/brace-expansion/);
});

test("another package fails, and moderate or lower is ignored", () => {
  const r = checkAudit(
    audit({
      other: { severity: "critical", nodes: ["node_modules/other"], via: [adv("GHSA-1111-2222-3333", "critical")] },
      meh: { severity: "moderate", nodes: ["node_modules/meh"], via: [adv("GHSA-4444-5555-6666", "moderate")] },
    }),
    [exception],
    "2026-10-01",
  );
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /^other: GHSA-1111-2222-3333/);
});

test("a package that is vulnerable only through a covered one is allowed; through an uncovered one it fails", () => {
  const parent = { severity: "high", nodes: ["node_modules/aws-cdk-lib/node_modules/minimatch"], via: ["brace-expansion"] };
  const ok = checkAudit(audit({ "brace-expansion": brace(), minimatch: parent }), [exception], "2026-10-01");
  assert.deepEqual(ok.failures, []);
  const bad = checkAudit(audit({ "brace-expansion": brace(), minimatch: parent }), [], "2026-10-01");
  assert.equal(bad.failures.length, 2);
});

test("a dependency cycle fails instead of looping", () => {
  const r = checkAudit(
    audit({ a: { severity: "high", nodes: ["x"], via: ["b"] }, b: { severity: "high", nodes: ["y"], via: ["a"] } }),
    [],
    "2026-10-01",
  );
  assert.ok(r.failures.some((f) => /cycle/.test(f)));
});

test("the CLI exits non-zero on a failure and zero when everything is allowed", () => {
  const dir = mkdtempSync(join(tmpdir(), "npm-audit-"));
  const input = join(dir, "audit.json");
  const exceptions = join(dir, "exceptions.json");
  writeFileSync(input, JSON.stringify(audit({ "brace-expansion": brace() })));
  writeFileSync(exceptions, JSON.stringify([exception]));
  const run = (today) =>
    execFileSync(process.execPath, [join(here, "npm-audit.mjs"), "--input", input, "--exceptions", exceptions, "--today", today], {
      encoding: "utf8",
      stdio: "pipe",
    });
  assert.match(run("2026-10-01"), /1 allowed/);
  assert.throws(() => run("2026-12-01"), (err) => err.status === 1 && /expired/.test(err.stderr));
  writeFileSync(input, JSON.stringify({ error: { summary: "registry down" } }));
  assert.throws(() => run("2026-10-01"), (err) => err.status === 1 && /registry down/.test(err.stderr));
});

test("the checked-in exceptions are well formed", () => {
  const list = JSON.parse(readFileSync(join(here, "npm-audit-exceptions.json"), "utf8"));
  for (const e of list) {
    assert.ok(e.package && e.paths.length && e.advisories.length && e.reason && /^supply-checkout-/.test(e.bead));
    assert.match(e.expires, /^\d{4}-\d{2}-\d{2}$/);
    for (const id of e.advisories) assert.match(id, /^GHSA-/);
  }
});
