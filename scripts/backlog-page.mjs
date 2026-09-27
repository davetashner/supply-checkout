// Builds the backlog page (Upcoming and Completed tabs) from the beads
// database, for the lead to republish to the private backlog artifact after
// merges and bead edits: `npm run backlog:page`. `npm run land` and the
// Claude Code Stop hook (scripts/backlog-stop-hook.mjs) run it too. Works from
// the main checkout or any worktree (bd finds the database in the main
// checkout), and always writes to the main checkout's dist/backlog/index.html.
// Prints the path it wrote.
//
// Next to the page it writes .hash, a hash of the page's data without its
// `generated` time. `npm run backlog:published` (--published), run by the lead
// right after republishing the page, copies it to .published, so the Stop
// hook and land can tell whether the published page is current. Both files are
// gitignored with the rest of dist/.
//
// Only the fields listed in pick() reach the page. bd's owner and created_by
// hold people's emails, and this page is shared, so any email address left in
// free text is masked too.
//
//   node scripts/backlog-page.mjs [--from-json <file>] [--out <file>]
//   node scripts/backlog-page.mjs --published [--out <file>]
//
// --from-json reads {"all": [...], "ready": [...], "blocked": [...]} (what
// `bd list --all`, `bd ready` and `bd blocked` print with --json) instead of
// running bd. The tests use it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name) => { const k = process.argv.indexOf(name); return k > 0 ? process.argv[k + 1] : undefined; };

// The main checkout of the repo that holds `cwd`, even from a worktree
export function mainCheckout(cwd = here) {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
  return dirname(common);
}

// Where the page goes, and its hash and published stamp next to it
export const pagePath = (main) => join(main, "dist", "backlog", "index.html");
export const hashPath = (page) => join(dirname(page), ".hash");
export const stampPath = (page) => join(dirname(page), ".published");

export function readBeads(file, { cwd, timeout } = {}) {
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  const bd = (...a) => JSON.parse(execFileSync("bd", [...a, "--json"], {
    cwd, timeout, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"],
  }) || "[]");
  return { all: bd("list", "--all", "-n", "0"), ready: bd("ready", "-n", "1000"), blocked: bd("blocked") };
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const text = (v) => (typeof v === "string" ? v.replace(EMAIL, "[email]") : "");
const iso = (v) => (typeof v === "string" && v ? v : null);

// The allowlist: nothing else from bd reaches the page
const pick = (i) => ({
  id: String(i.id),
  title: text(i.title),
  status: String(i.status),
  priority: Number(i.priority) || 0,
  type: String(i.issue_type || ""),
  labels: Array.isArray(i.labels) ? i.labels.map(text) : [],
  parent: typeof i.parent === "string" ? i.parent : null,
  description: text(i.description),
  acceptance: text(i.acceptance_criteria),
  notes: text(i.notes),
  created: iso(i.created_at),
  started: iso(i.started_at),
  closed: iso(i.closed_at),
  reason: text(i.close_reason),
});

export function buildData({ all = [], ready = [], blocked = [] }, generated = new Date().toISOString()) {
  const readyIds = new Set(ready.map((i) => i.id));
  const blockedBy = new Map(blocked.map((i) => [i.id, i.blocked_by || []]));
  const known = new Set(all.map((i) => i.id));
  const items = all.map((i) => ({
    ...pick(i),
    ready: readyIds.has(i.id),
    blockedBy: (blockedBy.get(i.id) || []).filter((b) => known.has(b)),
    children: 0,
    childrenClosed: 0,
  }));
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const i of items) {
    const p = i.parent && byId.get(i.parent);
    if (p) { p.children++; if (i.status === "closed") p.childrenClosed++; }
  }
  return { generated, items };
}

// The page's data without the time it was built: equal hashes, same page
export function dataHash(data) {
  return createHash("sha256").update(JSON.stringify({ ...data, generated: null })).digest("hex");
}

// Writes the page and its .hash; returns the hash
export function writePage(out, data) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buildPage(data));
  const hash = dataHash(data);
  writeFileSync(hashPath(out), hash + "\n");
  return hash;
}

// The hash of the page last published, or "" if none was recorded
export function publishedHash(out) {
  try { return readFileSync(stampPath(out), "utf8").trim(); } catch { return ""; }
}

export function buildPage(data) {
  const tpl = readFileSync(join(here, "backlog-page.html"), "utf8");
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return tpl.replace("/*__DATA__*/null", () => json);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(arg("--out") || pagePath(mainCheckout()));
  if (process.argv.includes("--published")) {
    if (!existsSync(out) || !existsSync(hashPath(out))) {
      console.error(`No backlog page at ${out}. Build it with npm run backlog:page, publish it, then run this again.`);
      process.exit(1);
    }
    copyFileSync(hashPath(out), stampPath(out));
    console.log(`Recorded ${out} as published`);
  } else {
    const data = buildData(readBeads(arg("--from-json")));
    writePage(out, data);
    console.log(`Wrote the backlog page (${data.items.length} beads): ${out}`);
  }
}
