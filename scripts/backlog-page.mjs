// Builds the backlog page (Upcoming and Completed tabs) from the beads
// database, for the lead to republish to the private backlog artifact after
// a batch of merges: `npm run backlog:page`. Works from the main checkout or
// any worktree (bd finds the database in the main checkout), and always
// writes to the main checkout's dist/backlog/index.html, the file
// scripts/land-pr.sh checks. Prints the path it wrote.
//
// Only the fields listed in pick() reach the page. bd's owner and created_by
// hold people's emails, and this page is shared, so any email address left in
// free text is masked too.
//
//   node scripts/backlog-page.mjs [--from-json <file>] [--out <file>]
//
// --from-json reads {"all": [...], "ready": [...], "blocked": [...]} (what
// `bd list --all`, `bd ready` and `bd blocked` print with --json) instead of
// running bd. The tests use it.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name) => { const k = process.argv.indexOf(name); return k > 0 ? process.argv[k + 1] : undefined; };

function mainCheckout() {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: here, encoding: "utf8" }).trim();
  return dirname(common);
}

function readBeads(file) {
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  const bd = (...a) => JSON.parse(execFileSync("bd", [...a, "--json"], { encoding: "utf8", maxBuffer: 64 << 20 }) || "[]");
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

export function buildPage(data) {
  const tpl = readFileSync(join(here, "backlog-page.html"), "utf8");
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return tpl.replace("/*__DATA__*/null", () => json);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(arg("--out") || join(mainCheckout(), "dist", "backlog", "index.html"));
  const data = buildData(readBeads(arg("--from-json")));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buildPage(data));
  console.log(`Wrote the backlog page (${data.items.length} beads): ${out}`);
}
