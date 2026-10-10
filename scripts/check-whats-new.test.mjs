// scripts/check-whats-new.mjs: each feat entry in the newest release needs a note or a skip, a
// feat: pull request adds its note under "upcoming", the release stamps it, and the notes file
// is well formed. Also runs it on the repository's own files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchProblems, check, coverageProblems, newestRelease, pullRequestProblems, shapeProblems, stamp, UPCOMING } from "./check-whats-new.mjs";

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
// Main between releases: 1.2.0 is out, and two feat PRs have written their notes for the next
const UPCOMING_NOTES = without((n) => { n.releases.unshift({ version: UPCOMING, notes: [note([620])], skip: { 621: "Behind the scenes" } }); });
// The release pull request's CHANGELOG.md: 1.3.0 with those two features
const NEXT = `# Changelog

## [1.3.0](https://github.com/o/r/compare/v1.2.0...v1.3.0) (2026-10-12)


### Features

* add a sort button ([#620](https://github.com/o/r/issues/620)) ([1111111](https://github.com/o/r/commit/1111111))
* add a test helper ([#621](https://github.com/o/r/issues/621)) ([2222222](https://github.com/o/r/commit/2222222))

${CHANGELOG.slice("# Changelog\n\n".length)}`;
// A release with only fixes
const FIXES_ONLY = `# Changelog

## [1.2.1](https://github.com/o/r/compare/v1.2.0...v1.2.1) (2026-10-09)


### Bug Fixes

* a fix ([#615](https://github.com/o/r/issues/615)) ([3333333](https://github.com/o/r/commit/3333333))

${CHANGELOG.slice("# Changelog\n\n".length)}`;

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

test("a release with no features needs no notes", () => {
  assert.deepEqual(newestRelease(FIXES_ONLY).features, []);
  assert.deepEqual(check({ changelog: FIXES_ONLY, notes: NOTES }), []);
  assert.deepEqual(check({ changelog: FIXES_ONLY, notes: UPCOMING_NOTES }), []);
});

test("main between releases: the upcoming notes are fine, and main's newest release is still covered", () => {
  assert.deepEqual(check({ changelog: CHANGELOG, notes: UPCOMING_NOTES }), []);
});

test("a feat: pull request needs its own note or skip under upcoming, judged by its title", () => {
  const pr = (number, title) => pullRequestProblems(UPCOMING_NOTES, { pr: number, title });
  assert.deepEqual(pr(620, "feat: add a sort button"), []);
  assert.deepEqual(pr(621, "feat(tests)!: add a test helper"), []);
  assert.deepEqual(pr(622, "feat: something else"), ['#622 is a feat: pull request: add its note, or a skip with a reason, under "upcoming" at the top of src/whats-new.json (docs/releases.md, "What\'s New notes").']);
  // Other types don't need one, whatever their commits say
  for (const title of ["fix: a fix", "docs: feat: in a docs title", "chore(main): release 1.3.0", "feature: not a type", "", undefined]) assert.deepEqual(pr(622, title), [], title);
  // Notes under a released version don't count: they're already out
  assert.deepEqual(pullRequestProblems(NOTES, { pr: 605, title: "feat: show who is signed in" }), ['#605 is a feat: pull request: add its note, or a skip with a reason, under "upcoming" at the top of src/whats-new.json (docs/releases.md, "What\'s New notes").']);
  assert.match(pullRequestProblems(UPCOMING_NOTES, { pr: NaN, title: "feat: x" })[0], /pull request's number is needed/);
  // Through check, with the shape and the release coverage
  assert.deepEqual(check({ changelog: CHANGELOG, notes: UPCOMING_NOTES, pr: { pr: 622, title: "feat: x" } }).length, 1);
  assert.deepEqual(check({ changelog: CHANGELOG, notes: UPCOMING_NOTES, pr: { pr: 620, title: "feat: x" } }), []);
});

test("locally, a feat: commit needs the upcoming entry to cover a pull request main's doesn't", () => {
  const main = without((n) => { n.releases.unshift({ version: UPCOMING, notes: [note([620])] }); });
  assert.deepEqual(branchProblems(UPCOMING_NOTES, main, ["feat: add a test helper", "fix: typo"]), []);
  assert.deepEqual(branchProblems(UPCOMING_NOTES, NOTES, ["feat: add a test helper"]), []);
  assert.deepEqual(branchProblems(UPCOMING_NOTES, null, ["feat: add a test helper"]), []);
  assert.deepEqual(branchProblems(UPCOMING_NOTES, { nothing: true }, ["feat: add a test helper"]), []);
  assert.deepEqual(branchProblems(main, main, ["fix: typo", "docs: words"]), []);
  assert.deepEqual(branchProblems(main, main, []), []);
  assert.deepEqual(branchProblems(main, main, ["fix: typo", "feat: new thing"]), ['"feat: new thing" is a feat: commit: add its pull request\'s note, or a skip with a reason, under "upcoming" at the top of src/whats-new.json (docs/releases.md, "What\'s New notes"). Open the pull request first to get its number.']);
  assert.equal(branchProblems(NOTES, NOTES, ["feat: x"]).length, 1);
  assert.equal(check({ changelog: CHANGELOG, notes: main, mainNotes: main, subjects: ["feat: x"] }).length, 1);
});

test("the release stamps the upcoming notes with its version and CHANGELOG.md date, once", () => {
  const release = newestRelease(NEXT);
  // Before the stamp, the release pull request says what's missing
  assert.match(check({ changelog: NEXT, notes: UPCOMING_NOTES })[0], /has notes under "upcoming" that the release workflow hasn't stamped yet/);
  const stamped = stamp(UPCOMING_NOTES, release);
  assert.deepEqual(stamped.releases[0], { version: "1.3.0", date: "2026-10-12", notes: [note([620])], skip: { 621: "Behind the scenes" } });
  assert.deepEqual(Object.keys(stamped.releases[0]), ["version", "date", "notes", "skip"]);
  assert.deepEqual(stamped.releases.slice(1), NOTES.releases);
  assert.deepEqual(check({ changelog: NEXT, notes: stamped }), []);
  // The input isn't changed
  assert.equal(UPCOMING_NOTES.releases[0].version, UPCOMING);
  // Nothing to stamp: stamped already, no upcoming entry, or no release
  assert.equal(stamp(stamped, release), null);
  assert.equal(stamp(NOTES, release), null);
  assert.equal(stamp(UPCOMING_NOTES, null), null);
  // A feature the upcoming notes miss still fails after the stamp
  const missing = stamp(without((n) => { n.releases.unshift({ version: UPCOMING, notes: [note([620])] }); }), release);
  assert.deepEqual(check({ changelog: NEXT, notes: missing }), ['1.3.0: #621 "add a test helper" needs a note or a skip in src/whats-new.json.']);
});

test("refuses a malformed notes file", () => {
  assert.deepEqual(shapeProblems(null), ["It needs a `releases` array."]);
  assert.deepEqual(shapeProblems({}), ["It needs a `releases` array."]);
  const cases = [
    [(n) => { n.releases[0] = "1.2.0"; }, /releases\[0\] isn't an object/],
    [(n) => { n.releases[0].extra = 1; }, /unknown fields: extra/],
    [(n) => { n.releases[0].version = "v1.2"; }, /needs a version like/],
    [(n) => { n.releases[1].version = UPCOMING; delete n.releases[1].date; }, /must be the first entry/],
    [(n) => { n.releases[0].version = UPCOMING; }, /has a date: leave it out/],
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
  // As CI runs it on a push (no pull request), so the branch's own commits don't matter here
  const env = { ...process.env, CI: "true", PR_TITLE: "", PR_NUMBER: "" };
  assert.match(execFileSync("node", [SCRIPT], { encoding: "utf8", env }), /^what's new: notes for \d+ releases, every feature in \d+\.\d+\.\d+ noted or skipped/);
  const dir = mkdtempSync(join(tmpdir(), "whats-new-"));
  writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
  writeFileSync(join(dir, "notes.json"), JSON.stringify(without((n) => { n.releases[0].notes = []; })));
  const failed = spawnSync("node", [SCRIPT, "--changelog", join(dir, "CHANGELOG.md"), "--notes", join(dir, "notes.json")], { encoding: "utf8", env });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /#605/);
  assert.match(failed.stderr, /#608/);
  writeFileSync(join(dir, "bad.json"), "{");
  const bad = spawnSync("node", [SCRIPT, "--notes", join(dir, "bad.json")], { encoding: "utf8", env });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /isn't valid JSON/);
  // The app's notes are the same file
  assert.ok(JSON.parse(readFileSync(new URL("../src/whats-new.json", import.meta.url), "utf8")).releases.length > 0);
});

test("the command checks a feat: pull request from PR_TITLE and PR_NUMBER", () => {
  const dir = mkdtempSync(join(tmpdir(), "whats-new-pr-"));
  writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
  writeFileSync(join(dir, "notes.json"), JSON.stringify(UPCOMING_NOTES));
  const run = (title, number) => spawnSync("node", [SCRIPT, "--changelog", join(dir, "CHANGELOG.md"), "--notes", join(dir, "notes.json")], { encoding: "utf8", env: { ...process.env, CI: "true", PR_TITLE: title, PR_NUMBER: number } });
  assert.equal(run("feat: add a sort button", "620").status, 0);
  const missing = run("feat: something else", "622");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /#622 is a feat: pull request/);
  assert.equal(run("fix: something", "622").status, 0);
});

test("--stamp writes the stamped notes on the release branch, and does nothing the second time", () => {
  const dir = mkdtempSync(join(tmpdir(), "whats-new-stamp-"));
  const notesPath = join(dir, "notes.json");
  writeFileSync(join(dir, "CHANGELOG.md"), NEXT);
  writeFileSync(notesPath, JSON.stringify(UPCOMING_NOTES));
  const run = () => spawnSync("node", [SCRIPT, "--stamp", "--changelog", join(dir, "CHANGELOG.md"), "--notes", notesPath], { encoding: "utf8" });
  const first = run();
  assert.equal(first.status, 0);
  assert.match(first.stdout, /stamped the upcoming notes as 1\.3\.0 \(2026-10-12\)/);
  const written = readFileSync(notesPath, "utf8");
  assert.deepEqual(JSON.parse(written), stamp(UPCOMING_NOTES, newestRelease(NEXT)));
  assert.ok(written.endsWith("}\n"));
  const second = run();
  assert.equal(second.status, 0);
  assert.match(second.stdout, /nothing to stamp/);
  assert.equal(readFileSync(notesPath, "utf8"), written);
  // A malformed file isn't stamped
  writeFileSync(notesPath, JSON.stringify({ releases: [{ version: UPCOMING, date: "2026-10-12", notes: [] }] }));
  const bad = run();
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /has a date: leave it out/);
});
