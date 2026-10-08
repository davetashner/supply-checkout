#!/usr/bin/env node
// Checks the What's New notes (src/whats-new.json, supply-checkout-005.17) against the
// changelog: every `feat:` entry in the newest release in CHANGELOG.md needs a plain-language
// note in that release's notes, or an explicit skip with a reason. And every release in the
// notes is well formed: a version, its date (YYYY-MM-DD), newest first, short notes, and no
// pull request both noted and skipped. docs/releases.md, "What's New notes", says how to
// write them.
//
// It runs in `npm run lint`, so in CI on every pull request, push and release run. On an
// ordinary pull request CHANGELOG.md is main's, whose newest release already has its notes,
// so it passes whatever the PR is. release-please's pull request is the one that adds a new
// release to CHANGELOG.md (CI runs on it through the release workflow), so that's where it
// fails until the notes are written: in a pull request to main, which release-please then
// carries into its own.
//
//   node scripts/check-whats-new.mjs [--changelog CHANGELOG.md] [--notes src/whats-new.json]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MAX_TITLE = 60;
export const MAX_TEXT = 200;
const VERSION = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

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
    if (typeof r.version !== "string" || !VERSION.test(r.version)) problems.push(`${where} needs a version like 1.10.0.`);
    else if (seen.has(r.version)) problems.push(`${where} is listed twice.`);
    seen.add(r.version);
    if (!realDate(r.date)) problems.push(`${where} needs the date it was released, as YYYY-MM-DD.`);
    else if (i > 0 && realDate(notes.releases[i - 1].date) && r.date > notes.releases[i - 1].date) problems.push(`${where} is newer than the release above it: list the newest first.`);
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

/** Problems with the newest release's coverage: each feat entry noted or skipped. */
export function coverageProblems(notes, release) {
  if (!release) return [];
  const r = notes.releases.find((x) => x.version === release.version);
  if (!r) return [`CHANGELOG.md's newest release, ${release.version}, has no notes. Add it to src/whats-new.json (docs/releases.md, "What's New notes").`];
  const covered = new Set([...r.notes.flatMap((n) => n.prs), ...Object.keys(r.skip ?? {}).map(Number)]);
  return release.features
    .filter((f) => f.pr === null || !covered.has(f.pr))
    .map((f) => (f.pr === null ? `${release.version}: "${f.text}" has no pull request number to match a note to.` : `${release.version}: #${f.pr} "${f.text}" needs a note or a skip in src/whats-new.json.`));
}

export function check({ changelog, notes }) {
  const shape = shapeProblems(notes);
  return shape.length ? shape : coverageProblems(notes, newestRelease(changelog));
}

/* c8 ignore start -- the command line; its parts are tested above */
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
  const changelogPath = arg("--changelog", `${ROOT}CHANGELOG.md`), notesPath = arg("--notes", `${ROOT}src/whats-new.json`);
  let notes;
  try { notes = JSON.parse(readFileSync(notesPath, "utf8")); }
  catch (e) { console.error(`what's new: ${notesPath} isn't valid JSON: ${e.message}`); process.exit(1); }
  const problems = check({ changelog: readFileSync(changelogPath, "utf8"), notes });
  if (problems.length) {
    for (const p of problems) console.error(`what's new: ${p}`);
    process.exit(1);
  }
  const release = newestRelease(readFileSync(changelogPath, "utf8"));
  console.log(`what's new: notes for ${notes.releases.length} releases${release ? `, every feature in ${release.version} noted or skipped` : ""}`);
}
/* c8 ignore stop */
