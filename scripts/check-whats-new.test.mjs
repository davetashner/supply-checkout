// scripts/check-whats-new.mjs: each feat entry in the newest release needs a note or a skip,
// and the notes file is well formed. Also runs it on the repository's own files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, coverageProblems, newestRelease, shapeProblems } from "./check-whats-new.mjs";

const SCRIPT = new URL("./check-whats-new.mjs", import.meta.url).pathname;
const CHANGELOG = `# Changelog

## [1.2.0](https://github.com/o/r/compare/v1.1.0...v1.2.0) (2026-10-08)


### Features

* show who is signed in ([#605](https://github.com/o/r/issues/605)) ([58eda98](https://github.com/o/r/commit/58eda98))
* **billing:** say why a team is read-only ([#608](https://github.com/o/r/issues/608)) ([17bc56d](https://github.com/o/r/commit/17bc56d))
* add the journeys stack ([#564](https://github.com/o/r/issues/564)) ([5887453](https://github.com/o/r/commit/5887453))


### Bug Fixes

* require a projection ([#611](https://github.com/o/r/issues/611)) ([264675c](https://github.com/o/r/commit/264675c))

## [1.1.0](https://github.com/o/r/compare/v1.0.0...v1.1.0) (2026-10-02)


### Features

* something older ([#400](https://github.com/o/r/issues/400)) ([aaaaaaa](https://github.com/o/r/commit/aaaaaaa))
`;
const note = (prs, title = "A title", text = "Some text.") => ({ title, text, prs });
const NOTES = {
  releases: [
    { version: "1.2.0", date: "2026-10-08", notes: [note([605]), note([608])], skip: { 564: "Behind the scenes" } },
    { version: "1.1.0", date: "2026-10-02", notes: [], skip: { 400: "Behind the scenes" } },
  ],
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const without = (fn) => { const n = clone(NOTES); fn(n); return n; };

test("reads the newest release's version, date and features, not its fixes or older releases", () => {
  assert.deepEqual(newestRelease(CHANGELOG), {
    version: "1.2.0",
    date: "2026-10-08",
    features: [
      { pr: 605, text: "show who is signed in" },
      { pr: 608, text: "**billing:** say why a team is read-only" },
      { pr: 564, text: "add the journeys stack" },
    ],
  });
  assert.equal(newestRelease("# Changelog\n"), null);
  // release-please's first release has no link
  assert.deepEqual(newestRelease("## 1.0.0 (2026-09-26)\n\n### Features\n\n* first ([#1](x))\n"), { version: "1.0.0", date: "2026-09-26", features: [{ pr: 1, text: "first" }] });
  assert.throws(() => newestRelease("## Unreleased\n"), /Can't read the release heading/);
  assert.deepEqual(newestRelease("## 1.0.0 (2026-09-26)\n\n### Features\n\n* no number\n").features, [{ pr: null, text: "no number" }]);
});

test("passes when every feature is noted or skipped", () => {
  assert.deepEqual(check({ changelog: CHANGELOG, notes: NOTES }), []);
  // Nothing released yet
  assert.deepEqual(check({ changelog: "# Changelog\n", notes: NOTES }), []);
});

test("names a feature with neither a note nor a skip", () => {
  const notes = without((n) => { n.releases[0].notes.pop(); });
  assert.deepEqual(check({ changelog: CHANGELOG, notes }), ['1.2.0: #608 "**billing:** say why a team is read-only" needs a note or a skip in src/whats-new.json.']);
  const skipped = without((n) => { delete n.releases[0].skip; });
  assert.deepEqual(check({ changelog: CHANGELOG, notes: skipped }), ['1.2.0: #564 "add the journeys stack" needs a note or a skip in src/whats-new.json.']);
});

test("needs notes for the newest release (the release pull request), not for older ones", () => {
  const notes = without((n) => { n.releases.shift(); });
  assert.match(check({ changelog: CHANGELOG, notes })[0], /newest release, 1.2.0, has no notes/);
  assert.deepEqual(coverageProblems(NOTES, null), []);
  assert.deepEqual(coverageProblems(NOTES, { version: "1.2.0", features: [{ pr: null, text: "odd" }] }), ['1.2.0: "odd" has no pull request number to match a note to.']);
});

test("refuses a malformed notes file", () => {
  assert.deepEqual(shapeProblems(null), ["It needs a `releases` array."]);
  assert.deepEqual(shapeProblems({}), ["It needs a `releases` array."]);
  const cases = [
    [(n) => { n.releases[0] = "1.2.0"; }, /releases\[0\] isn't an object/],
    [(n) => { n.releases[0].extra = 1; }, /unknown fields: extra/],
    [(n) => { n.releases[0].version = "v1.2"; }, /needs a version like/],
    [(n) => { n.releases[1].version = "1.2.0"; }, /listed twice/],
    [(n) => { n.releases[0].date = "2026-02-30"; }, /needs the date it was released/],
    [(n) => { n.releases[1].date = "2026-10-09"; }, /newer than the release above it/],
    [(n) => { delete n.releases[0].notes; }, /needs a `notes` array/],
    [(n) => { n.releases[0].skip = []; }, /must map pull request numbers/],
    [(n) => { n.releases[0].notes[0] = null; }, /note 1 isn't an object/],
    [(n) => { n.releases[0].notes[0].link = "x"; }, /note 1 has unknown fields: link/],
    [(n) => { n.releases[0].notes[0].title = "x".repeat(61); }, /title of up to 60/],
    [(n) => { n.releases[0].notes[0].title = " padded"; }, /title of up to 60/],
    [(n) => { n.releases[0].notes[0].text = ""; }, /text of up to 200/],
    [(n) => { n.releases[0].notes[0].prs = []; }, /needs `prs`/],
    [(n) => { n.releases[0].notes[0].prs = ["605"]; }, /needs `prs`/],
    [(n) => { n.releases[0].skip.abc = "Reason"; }, /skips "abc", which isn't a pull request number/],
    [(n) => { n.releases[0].skip[605] = "Reason"; }, /both notes and skips #605/],
    [(n) => { n.releases[0].skip[564] = ""; }, /skips #564 without a reason/],
  ];
  for (const [change, expected] of cases) {
    const problems = check({ changelog: CHANGELOG, notes: without(change) });
    assert.ok(problems.some((p) => expected.test(p)), `${expected}: ${JSON.stringify(problems)}`);
  }
  // A version that isn't a string isn't named
  assert.match(shapeProblems({ releases: [{ version: 1, date: "2026-10-08", notes: [] }] })[0], /^releases\[0\] needs a version/);
});

test("the command passes on this repository's notes, and fails with every problem on stderr", () => {
  assert.match(execFileSync("node", [SCRIPT], { encoding: "utf8" }), /^what's new: notes for \d+ releases, every feature in \d+\.\d+\.\d+ noted or skipped/);
  const dir = mkdtempSync(join(tmpdir(), "whats-new-"));
  writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
  writeFileSync(join(dir, "notes.json"), JSON.stringify(without((n) => { n.releases[0].notes = []; })));
  const failed = spawnSync("node", [SCRIPT, "--changelog", join(dir, "CHANGELOG.md"), "--notes", join(dir, "notes.json")], { encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /#605/);
  assert.match(failed.stderr, /#608/);
  writeFileSync(join(dir, "bad.json"), "{");
  const bad = spawnSync("node", [SCRIPT, "--notes", join(dir, "bad.json")], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /isn't valid JSON/);
  // The app's notes are the same file
  assert.ok(JSON.parse(readFileSync(new URL("../src/whats-new.json", import.meta.url), "utf8")).releases.length > 0);
});
