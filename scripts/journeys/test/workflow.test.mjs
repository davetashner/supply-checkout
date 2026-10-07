// node --test scripts/journeys/test/ (part of npm run test:scripts): the journeys workflow's own
// steps, checking the secrets before signing in and passing the failed steps to the deploy.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main, outputLines, secretProblems } from "../workflow.mjs";
import { fakeEnv } from "./helpers.mjs";

test("check-secrets: names the missing or malformed variables, never their values", () => {
  assert.deepEqual(secretProblems(fakeEnv()), []);
  const env = fakeEnv({ JOURNEYS_OWNER_PASSWORD: "", JOURNEYS_OWNER_TOTP: "not base32 at all!" });
  const problems = secretProblems(env);
  assert.ok(problems.length >= 2);
  for (const p of problems) assert.match(p, /^::error::/);
  assert.ok(problems.some((p) => p.includes("JOURNEYS_OWNER_PASSWORD is not set")));
  assert.ok(problems.some((p) => p.includes("JOURNEYS_OWNER_TOTP must be a base32 secret")));
  for (const p of problems) for (const v of Object.values(fakeEnv())) assert.ok(!p.includes(v), "a value was printed");

  const lines = [];
  assert.equal(main(["check-secrets"], fakeEnv(), (l) => lines.push(l)), 0);
  assert.deepEqual(lines, ["Every journeys secret is set"]);
  lines.length = 0;
  assert.equal(main(["check-secrets"], {}, (l) => lines.push(l)), 1);
  assert.ok(lines.length > 1 && lines.every((l) => l.startsWith("::error::")));
});

test("outputs: only well-formed step entries reach the deploy", () => {
  assert.equal(outputLines({ failed: ["J4.2 (desktop-chrome)", "J13.4 (iphone-safari)"], critical: ["J4.2 (desktop-chrome)"] }), "failed=J4.2 (desktop-chrome), J13.4 (iphone-safari)\ncritical=J4.2 (desktop-chrome)\n");
  assert.equal(outputLines({ failed: ["J4.2 (desktop-chrome)\ncritical=x", "J4.2 (firefox)", 7, "J4.2 (desktop-chrome)"], critical: "J1.1 (desktop-chrome)" }), "failed=J4.2 (desktop-chrome)\ncritical=\n");
  assert.equal(outputLines(null), "failed=\ncritical=\n");

  const dir = mkdtempSync(path.join(tmpdir(), "journeys-workflow-"));
  try {
    const out = path.join(dir, "out");
    writeFileSync(out, "");
    const file = path.join(dir, "verdict.json");
    // No verdict file (the suite didn't start): nothing written
    assert.equal(main(["outputs", file], { GITHUB_OUTPUT: out }), 0);
    assert.equal(readFileSync(out, "utf8"), "");
    writeFileSync(file, JSON.stringify({ ok: false, failed: ["J0.2 (iphone-safari)"], flaky: [], critical: ["J0.2 (iphone-safari)"] }));
    assert.equal(main(["outputs", file], { GITHUB_OUTPUT: out }), 0);
    assert.equal(readFileSync(out, "utf8"), "failed=J0.2 (iphone-safari)\ncritical=J0.2 (iphone-safari)\n");
    assert.throws(() => main(["outputs", file], {}), /GITHUB_OUTPUT isn't set/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage", () => {
  for (const argv of [[], ["frob"], ["check-secrets", "x"], ["outputs"], ["outputs", "a", "b"]]) assert.throws(() => main(argv, {}), /Usage/);
});
