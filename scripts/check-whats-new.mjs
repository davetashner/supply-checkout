#!/usr/bin/env node
// Checks the What's New notes (src/whats-new.json, supply-checkout-005.17, pbp.48) against the
// changelog and the pull request. docs/releases.md, "What's New notes", says how to write them.
//
// - A `feat:` pull request adds its note, or a skip with a reason, under the "upcoming" entry
//   at the top of the file: judged by the PR's title and number in CI (PR_TITLE, PR_NUMBER),
//   and locally by the commit subjects since origin/main (a `feat:` commit needs the upcoming
//   entry to cover a pull request that main's doesn't).
// - The upcoming entry has no version or date of its own, so the app never shows it. When
//   release-please opens or updates its release pull request, the release workflow stamps it
//   (--stamp, on that branch) with the release's version and its CHANGELOG.md date.
// - The newest release in CHANGELOG.md: if it has `feat:` entries, each needs a note or a skip
//   in that release's notes. A release with no features needs no entry at all. On an ordinary
//   pull request that's main's newest release, which is covered already; it matters on the
//   release pull request, after the stamp.
// - Every release is well formed: a version, its date (YYYY-MM-DD), newest first, short notes,
//   and no pull request both noted and skipped.
//
// It runs in `npm run lint`, so in CI on every pull request, push and release run.
//
//   node scripts/check-whats-new.mjs [--changelog CHANGELOG.md] [--notes src/whats-new.json] [--stamp]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MAX_TITLE = 60;
export const MAX_TEXT = 200;
const VERSION = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// The entry feat PRs write their notes under until the release stamps it. Not a version, and
// it has no date, so the app (which shows releases dated in the last 14 days) never shows it.
export const UPCOMING = "upcoming";
// A Conventional Commits feat title or subject, as release-please reads it
const FEAT = /^feat(\([^)]*\))?!?: /;

/**
 * The newest release in a release-please CHANGELOG.md: its version, date and the pull
 * request numbers of its Features, with each entry's text. Null if there's no release yet.
 */
export function newestRelease(changelog) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => /^## /.test(l));
  if (start < 0) return null;
  const head = lines[start].match(/^## \[?(\d+\.\d+\.\d+)\]?.*\((\d{4}-\d{2}-\d{2})\)/);
  if (!head) throw new Error(`Can't read the release heading: ${lines[start]}`);
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  const section = lines.slice(start + 1, end < 0 ? undefined : end);
  const features = [];
  let inFeatures = false;
  for (const line of section) {
    if (/^### /.test(line)) inFeatures = /^### Features\s*$/.test(line);
    else if (inFeatures && /^\* /.test(line)) {
      const pr = line.match(/\[#(\d+)\]/);
      features.push({ pr: pr ? Number(pr[1]) : null, text: line.replace(/^\* /, "").replace(/ \(\[#.*$/, "") });
    }
  }
  return { version: head[1], date: head[2], features };
}

const realDate = (d) => typeof d === "string" && DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const plain = (s, max) => typeof s === "string" && s.trim() === s && s.length > 0 && s.length <= max;

/** Problems with the notes file's shape, as sentences. */
export function shapeProblems(notes) {
  const problems = [];
  if (!notes || !Array.isArray(notes.releases)) return ["It needs a `releases` array."];
  const seen = new Set();
  notes.releases.forEach((r, i) => {
    const where = `releases[${i}]${r && typeof r.version === "string" ? ` (${r.version})` : ""}`;
    if (!r || typeof r !== "object") { problems.push(`${where} isn't an object.`); return; }
    const extra = Object.keys(r).filter((k) => !["version", "date", "notes", "skip"].includes(k));
    if (extra.length) problems.push(`${where} has unknown fields: ${extra.join(", ")}.`);
    if (r.version === UPCOMING) {
      if (i > 0) problems.push(`${where} must be the first entry: the upcoming release goes at the top.`);
      if ("date" in r) problems.push(`${where} has a date: leave it out, the release stamps it.`);
    } else {
      if (typeof r.version !== "string" || !VERSION.test(r.version)) problems.push(`${where} needs a version like 1.10.0, or "${UPCOMING}".`);
      else if (seen.has(r.version)) problems.push(`${where} is listed twice.`);
      seen.add(r.version);
      if (!realDate(r.date)) problems.push(`${where} needs the date it was released, as YYYY-MM-DD.`);
      else if (i > 0 && realDate(notes.releases[i - 1].date) && r.date > notes.releases[i - 1].date) problems.push(`${where} is newer than the release above it: list the newest first.`);
    }
    if (!Array.isArray(r.notes)) { problems.push(`${where} needs a \`notes\` array (it may be empty).`); return; }
    const skip = r.skip ?? {};
    if (typeof skip !== "object" || Array.isArray(skip)) { problems.push(`${where}'s \`skip\` must map pull request numbers to reasons.`); return; }
    const noted = new Set();
    r.notes.forEach((n, j) => {
      const at = `${where} note ${j + 1}`;
      if (!n || typeof n !== "object") { problems.push(`${at} isn't an object.`); return; }
      const extraNote = Object.keys(n).filter((k) => !["title", "text", "prs"].includes(k));
      if (extraNote.length) problems.push(`${at} has unknown fields: ${extraNote.join(", ")}.`);
      if (!plain(n.title, MAX_TITLE)) problems.push(`${at} needs a title of up to ${MAX_TITLE} characters.`);
      if (!plain(n.text, MAX_TEXT)) problems.push(`${at} needs text of up to ${MAX_TEXT} characters.`);
      if (!Array.isArray(n.prs) || !n.prs.length || !n.prs.every((p) => Number.isInteger(p) && p > 0)) problems.push(`${at} needs \`prs\`: the pull request numbers it covers.`);
      else n.prs.forEach((p) => noted.add(p));
    });
    for (const [pr, reason] of Object.entries(skip)) {
      if (!/^[1-9]\d*$/.test(pr)) problems.push(`${where} skips "${pr}", which isn't a pull request number.`);
      else if (noted.has(Number(pr))) problems.push(`${where} both notes and skips #${pr}.`);
      if (!plain(reason, MAX_TEXT)) problems.push(`${where} skips #${pr} without a reason.`);
    }
  });
  return problems;
}

// The pull requests an entry notes or skips
const coveredBy = (r) => new Set(r ? [...r.notes.flatMap((n) => n.prs), ...Object.keys(r.skip ?? {}).map(Number)] : []);
const upcomingOf = (notes) => (notes.releases[0]?.version === UPCOMING ? notes.releases[0] : null);
const HOW = `under "${UPCOMING}" at the top of src/whats-new.json (docs/releases.md, "What's New notes")`;

/** Problems with the newest release's coverage: each feat entry noted or skipped. A release with no features needs nothing. */
export function coverageProblems(notes, release) {
  if (!release || !release.features.length) return [];
  const r = notes.releases.find((x) => x.version === release.version);
  if (!r) {
    return upcomingOf(notes)
      ? [`CHANGELOG.md's newest release, ${release.version}, has notes under "${UPCOMING}" that the release workflow hasn't stamped yet: run node scripts/check-whats-new.mjs --stamp on the release branch.`]
      : [`CHANGELOG.md's newest release, ${release.version}, has no notes. Add them ${HOW}.`];
  }
  const covered = coveredBy(r);
  return release.features
    .filter((f) => f.pr === null || !covered.has(f.pr))
    .map((f) => (f.pr === null ? `${release.version}: "${f.text}" has no pull request number to match a note to.` : `${release.version}: #${f.pr} "${f.text}" needs a note or a skip in src/whats-new.json.`));
}

/** In CI: a feat: pull request (by its title) needs its own note or skip under upcoming. */
export function pullRequestProblems(notes, { pr, title }) {
  if (!FEAT.test(title ?? "")) return [];
  if (!Number.isInteger(pr) || pr <= 0) return [`A feat: pull request's number is needed to check its What's New note, not "${pr}".`];
  return coveredBy(upcomingOf(notes)).has(pr) ? [] : [`#${pr} is a feat: pull request: add its note, or a skip with a reason, ${HOW}.`];
}

/**
 * Locally, before there's a pull request number: if a commit since main is a feat:, the
 * upcoming entry must cover some pull request that main's doesn't.
 */
export function branchProblems(notes, mainNotes, subjects) {
  const feats = subjects.filter((s) => FEAT.test(s));
  if (!feats.length) return [];
  const before = coveredBy(mainNotes && Array.isArray(mainNotes.releases) ? upcomingOf(mainNotes) : null);
  if ([...coveredBy(upcomingOf(notes))].some((pr) => !before.has(pr))) return [];
  return [`"${feats[0]}" is a feat: commit: add its pull request's note, or a skip with a reason, ${HOW}. Open the pull request first to get its number.`];
}

/**
 * The notes with the upcoming entry stamped as the newest release in CHANGELOG.md (its version
 * and date), or null when there's nothing to stamp: no release, no upcoming entry, or the
 * release has an entry already.
 */
export function stamp(notes, release) {
  const upcoming = upcomingOf(notes);
  if (!release || !upcoming || notes.releases.some((r) => r.version === release.version)) return null;
  const { version: _placeholder, date: _none, ...rest } = upcoming;
  return { ...notes, releases: [{ version: release.version, date: release.date, ...rest }, ...notes.releases.slice(1)] };
}

export function check({ changelog, notes, pr = null, mainNotes = null, subjects = [] }) {
  const shape = shapeProblems(notes);
  if (shape.length) return shape;
  return [
    ...coverageProblems(notes, newestRelease(changelog)),
    ...(pr ? pullRequestProblems(notes, pr) : branchProblems(notes, mainNotes, subjects)),
  ];
}

/* c8 ignore start -- the command line; its parts are tested above */
// What the PR check needs: the PR in CI, or locally the commits since origin/main and main's
// notes. Other CI runs (pushes, the merge queue, the release branch) have no PR to check.
function pullRequestContext() {
  if (process.env.PR_TITLE) return { pr: { pr: Number(process.env.PR_NUMBER), title: process.env.PR_TITLE } };
  if (process.env.CI) return {};
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    const base = git("merge-base", "origin/main", "HEAD").trim();
    const subjects = git("log", "--format=%s", `${base}..HEAD`).split("\n").filter(Boolean);
    let mainNotes = null;
    try { mainNotes = JSON.parse(git("show", "origin/main:src/whats-new.json")); } catch { /* none on main yet */ }
    return { subjects, mainNotes };
  } catch {
    return {}; // no origin/main here
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
  const changelogPath = arg("--changelog", `${ROOT}CHANGELOG.md`), notesPath = arg("--notes", `${ROOT}src/whats-new.json`);
  let notes;
  try { notes = JSON.parse(readFileSync(notesPath, "utf8")); }
  catch (e) { console.error(`what's new: ${notesPath} isn't valid JSON: ${e.message}`); process.exit(1); }
  const changelog = readFileSync(changelogPath, "utf8");
  const release = newestRelease(changelog);
  if (process.argv.includes("--stamp")) {
    const shape = shapeProblems(notes);
    if (shape.length) {
      for (const p of shape) console.error(`what's new: ${p}`);
      process.exit(1);
    }
    const stamped = stamp(notes, release);
    if (stamped) writeFileSync(notesPath, `${JSON.stringify(stamped, null, 2)}\n`);
    console.log(stamped ? `what's new: stamped the upcoming notes as ${release.version} (${release.date})` : "what's new: nothing to stamp");
    process.exit(0);
  }
  const problems = check({ changelog, notes, ...pullRequestContext() });
  if (problems.length) {
    for (const p of problems) console.error(`what's new: ${p}`);
    process.exit(1);
  }
  const released = notes.releases.filter((r) => r.version !== UPCOMING).length;
  console.log(`what's new: notes for ${released} releases${release ? `, every feature in ${release.version} noted or skipped` : ""}`);
}
/* c8 ignore stop */
