#!/usr/bin/env node
// Runs `npm audit --json` in the current directory and fails on any high or
// critical vulnerability, except ones listed in npm-audit-exceptions.json.
// An exception covers one package at the listed paths, for the listed
// advisories only, until its expiry date (inclusive). A new advisory, a new
// path or an expired exception fails the run. CI uses this in place of
// `npm audit --audit-level=high` where an exception is needed.
//
// Options: --exceptions <file>, --input <audit json file> (tests),
// --today <YYYY-MM-DD> (tests).
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FAILING = new Set(["high", "critical"]);
const SEVERITIES = new Set(["info", "low", "moderate", "high", "critical"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmptyStrings = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x);

// Throws unless every exception is complete; a missing expiry must never mean "forever".
export function validateExceptions(list) {
  if (!Array.isArray(list)) throw new Error("the exceptions file must hold a JSON array");
  list.forEach((e, i) => {
    const where = `exception ${i + 1}`;
    if (!isObject(e)) throw new Error(`${where} isn't an object`);
    if (typeof e.package !== "string" || !e.package) throw new Error(`${where} has no package`);
    if (!nonEmptyStrings(e.paths)) throw new Error(`${where} needs a non-empty paths array`);
    if (!nonEmptyStrings(e.advisories) || !e.advisories.every((id) => id.startsWith("GHSA-")))
      throw new Error(`${where} needs a non-empty advisories array of GHSA IDs`);
    if (typeof e.expires !== "string" || !DATE.test(e.expires)) throw new Error(`${where} needs expires as YYYY-MM-DD`);
    if (typeof e.bead !== "string" || !e.bead.startsWith("supply-checkout-")) throw new Error(`${where} needs a bead`);
    if (typeof e.reason !== "string" || !e.reason) throw new Error(`${where} needs a reason`);
  });
  return list;
}

// Throws unless the report is npm's v2 audit JSON, so a format change or an odd
// registry reply fails the run instead of passing it.
export function validateAudit(audit) {
  if (!isObject(audit)) throw new Error("npm audit output isn't a JSON object");
  if (audit.auditReportVersion !== 2) throw new Error(`unexpected auditReportVersion ${JSON.stringify(audit.auditReportVersion)}; expected 2`);
  if (!isObject(audit.vulnerabilities)) throw new Error("npm audit output has no vulnerabilities object");
  const counts = audit.metadata?.vulnerabilities;
  if (!isObject(counts)) throw new Error("npm audit output has no metadata.vulnerabilities counts");
  for (const [name, v] of Object.entries(audit.vulnerabilities)) {
    if (!isObject(v) || !SEVERITIES.has(v.severity) || !Array.isArray(v.nodes) || !Array.isArray(v.via))
      throw new Error(`npm audit entry ${name} has an unexpected shape or severity ${JSON.stringify(v?.severity)}`);
    for (const via of v.via) {
      if (typeof via !== "string" && !(isObject(via) && SEVERITIES.has(via.severity)))
        throw new Error(`npm audit entry ${name} has an advisory with an unexpected shape or severity`);
    }
  }
  for (const level of FAILING) {
    if (!Number.isInteger(counts[level])) throw new Error(`npm audit counts have no integer ${level}`);
  }
  const listed = Object.values(audit.vulnerabilities).filter((v) => FAILING.has(v.severity)).length;
  if (counts.high + counts.critical !== listed)
    throw new Error(`npm audit counts ${counts.high + counts.critical} high or critical, but lists ${listed}`);
  return audit;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

export function ghsa(url) {
  const m = /GHSA-[\w-]+$/.exec(url || "");
  return m ? m[0] : url;
}

// Returns { allowed: [...], failures: [...] } as human-readable lines.
export function checkAudit(audit, exceptions, today) {
  const vulns = audit.vulnerabilities;
  const allowed = [];
  const failures = [];
  const memo = new Map();

  function covered(name, seen = new Set()) {
    if (memo.has(name)) return memo.get(name);
    if (seen.has(name)) return { ok: false, why: `dependency cycle at ${name}` };
    seen.add(name);
    const v = vulns[name];
    if (!v) return { ok: true };
    let result = { ok: true };
    for (const via of v.via) {
      if (typeof via === "string") {
        const sub = covered(via, seen);
        if (!sub.ok) { result = sub; break; }
        continue;
      }
      if (!FAILING.has(via.severity) && !FAILING.has(v.severity)) continue;
      const id = ghsa(via.url);
      const ex = exceptions.find((e) => e.package === name && e.advisories.includes(id));
      if (!ex) { result = { ok: false, why: `${name}: ${id} (${via.severity}) has no exception` }; break; }
      if (today > ex.expires) { result = { ok: false, why: `${name}: the exception for ${id} expired on ${ex.expires} (${ex.bead})` }; break; }
      const stray = v.nodes.filter((n) => !ex.paths.includes(n));
      if (stray.length) { result = { ok: false, why: `${name}: ${id} also at ${stray.join(", ")}, not covered by its exception` }; break; }
    }
    memo.set(name, result);
    return result;
  }

  for (const [name, v] of Object.entries(vulns)) {
    if (!FAILING.has(v.severity)) continue;
    const r = covered(name);
    if (r.ok) allowed.push(`${name} (${v.severity}) at ${v.nodes.join(", ")}`);
    else failures.push(r.why);
  }
  return { allowed, failures };
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const exceptions = validateExceptions(JSON.parse(readFileSync(arg("--exceptions", join(here, "npm-audit-exceptions.json")), "utf8")));
  const today = arg("--today", new Date().toISOString().slice(0, 10));
  const input = arg("--input");
  let raw;
  if (input) raw = readFileSync(input, "utf8");
  else {
    try {
      raw = execFileSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
      // npm audit exits non-zero when it finds anything; its JSON is still on stdout.
      if (!err.stdout) throw err;
      raw = err.stdout;
    }
  }
  const audit = JSON.parse(raw);
  if (isObject(audit) && audit.error) {
    console.error(`npm audit failed: ${audit.error.summary || JSON.stringify(audit.error)}`);
    process.exit(1);
  }
  validateAudit(audit);
  const { allowed, failures } = checkAudit(audit, exceptions, today);
  for (const line of allowed) console.log(`::warning::Allowed by scripts/npm-audit-exceptions.json: ${line}`);
  if (failures.length) {
    for (const line of failures) console.error(`::error::${line}`);
    console.error(`${failures.length} high or critical vulnerabilit${failures.length === 1 ? "y" : "ies"} without a current exception. Run npm audit for details.`);
    process.exit(1);
  }
  console.log(`No high or critical vulnerabilities without a current exception (${allowed.length} allowed).`);
}

// realpath on both sides, so a symlinked path still runs main() instead of
// exiting 0 silently.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
