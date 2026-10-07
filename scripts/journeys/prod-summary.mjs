#!/usr/bin/env node
// The prod journey run's results by journey step (docs/journey-tests-plan.md, "Results by
// journey"), for the job summary:
//
//   node scripts/journeys/prod-summary.mjs --report <playwright JSON report>
//        [--registry journeys/registry.json] [--warnings <file>] [--json <verdict file>]
//
// One row per step of every journey in the registry, with the result in each browser project,
// the time taken, and for a failure its first line, masked. A step is matched by a test's tag
// (@J4.2) or a test.step named for it ("J4.2 …"). Steps with no prod test say why: the step's
// `prodSkip` reason, "planned", or "no prod test yet". Tests that passed only on their retry are
// marked flaky (the flake policy: a bead the same day). Appends to $GITHUB_STEP_SUMMARY when
// set, else prints. --json writes { ok, failed, flaky, critical } for the verdict job.
//
// Everything printed goes through the masker: the run's secrets from the environment, and any
// token, address or account ID shape. Nothing else from the report is printed: no stdout, no
// attachments, no source.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENV } from "./lib/config.mjs";
import { createMasker } from "./lib/mask.mjs";

export const PROJECTS = ["desktop-chrome", "iphone-safari"];
const STEP = /^@?(J\d+\.\d+)$/;
const STEP_TITLE = /^(J\d+\.\d+)\b/;
const RANK = { failed: 3, flaky: 2, passed: 1, skipped: 0 };
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

const outcome = (test) => ({ expected: "passed", unexpected: "failed", flaky: "flaky", skipped: "skipped" })[test.status] ?? "failed";

/** Every test result in a Playwright JSON report, with the steps it covers. */
export function results(report) {
  const out = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      const tagged = (spec.tags ?? []).map((t) => STEP.exec(t)?.[1]).filter(Boolean);
      for (const test of spec.tests ?? []) {
        const runs = test.results ?? [];
        const last = runs[runs.length - 1] ?? {};
        const stepped = runs.flatMap((r) => r.steps ?? []).map((s) => STEP_TITLE.exec(s.title ?? "")?.[1]).filter(Boolean);
        const error = (last.errors ?? []).concat(last.error ? [last.error] : []).map((e) => e?.message).find(Boolean);
        const annotations = (test.annotations ?? []).concat(runs.flatMap((r) => r.annotations ?? []));
        out.push({
          title: [...titles, spec.title].filter(Boolean).join(" › "),
          project: test.projectName,
          steps: [...new Set([...tagged, ...stepped])],
          outcome: outcome(test),
          duration: runs.reduce((n, r) => n + (r.duration ?? 0), 0),
          error,
          warnings: annotations.filter((a) => a.type === "journeys-warning").map((a) => a.description),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const file of report.suites ?? []) walk(file, []);
  return out;
}

const firstLine = (text) => String(text ?? "").replace(ANSI, "").split("\n").map((s) => s.trim()).find(Boolean) ?? "";
const cell = (text) => text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").slice(0, 200);
const seconds = (ms) => `${Math.round(ms / 1000)} s`;
const ICON = { passed: "pass", failed: "**FAIL**", flaky: "flaky", skipped: "skipped" };

/**
 * The summary: `{ markdown, failed, flaky, critical, ok }`. `failed` and `flaky` are
 * `J4.2 (desktop-chrome)` strings; `critical` the failed steps of critical journeys.
 */
export function summarize(report, registry, { redact = (s) => s, warnings = [] } = {}) {
  const all = results(report);
  const byStep = new Map();
  for (const r of all) for (const s of r.steps) {
    if (!byStep.has(s)) byStep.set(s, []);
    byStep.get(s).push(r);
  }
  const failed = [];
  const flaky = [];
  const critical = [];
  const rows = [];
  for (const journey of registry.journeys ?? []) {
    for (const step of journey.steps ?? []) {
      const tests = byStep.get(step.id) ?? [];
      const text = cell(redact(`${step.id} ${step.text}`));
      if (!tests.length) {
        const why = step.prodSkip ? `not in prod: ${step.prodSkip}` : step.status === "planned" ? "planned" : "no prod test yet";
        rows.push(`| ${text} | – | – | – | ${cell(redact(why))} |`);
        continue;
      }
      const perProject = PROJECTS.map((p) => {
        const mine = tests.filter((t) => t.project === p);
        if (!mine.length) return { outcome: null };
        return mine.reduce((a, b) => (RANK[b.outcome] > RANK[a.outcome] ? b : a));
      });
      PROJECTS.forEach((p, i) => {
        const r = perProject[i];
        if (r.outcome === "failed") {
          failed.push(`${step.id} (${p})`);
          if (journey.critical) critical.push(`${step.id} (${p})`);
        } else if (r.outcome === "flaky") flaky.push(`${step.id} (${p})`);
      });
      const time = Math.max(...tests.map((t) => t.duration));
      const notes = tests.filter((t) => t.outcome === "failed" && t.error).map((t) => `${t.project}: ${firstLine(redact(t.error))}`);
      rows.push(`| ${text} | ${perProject.map((r) => (r.outcome ? ICON[r.outcome] : "–")).join(" | ")} | ${seconds(time)} | ${cell(notes.join("; "))} |`);
    }
  }
  const untagged = all.filter((r) => !r.steps.length);
  const allWarnings = [...new Set([...warnings, ...all.flatMap((r) => r.warnings)])].map(redact);
  const ok = failed.length === 0;
  const lines = [
    "## Journey tests in prod",
    "",
    ok ? `All prod journey tests passed${flaky.length ? `, ${flaky.length} only on a retry (flaky: file a bead today)` : ""}.` : `**Failed:** ${failed.join(", ")}${critical.length ? `. **Critical journeys failed** (${critical.join(", ")}): follow the runbook.` : ""}`,
    "",
    ...allWarnings.map((w) => `> **Warning:** ${w}`),
    ...(allWarnings.length ? [""] : []),
    `| Step | ${PROJECTS.join(" | ")} | Time | Notes |`,
    `| --- | ${PROJECTS.map(() => "---").join(" | ")} | --- | --- |`,
    ...rows,
  ];
  if (untagged.length) {
    lines.push("", "Tests not tagged with a step:", "");
    for (const t of untagged) lines.push(`- ${redact(t.title)} (${t.project}): ${t.outcome}${t.outcome === "failed" && t.error ? `: ${firstLine(redact(t.error))}` : ""}`);
  }
  return { markdown: lines.join("\n") + "\n", failed, flaky, critical, ok };
}

export function parseArgs(argv) {
  const out = { registry: "journeys/registry.json" };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!["--report", "--registry", "--warnings", "--json"].includes(flag) || !value) throw new Error(`Unknown or incomplete argument ${flag}`);
    out[flag.slice(2)] = value;
    i++;
  }
  if (!out.report) throw new Error("--report <file> is required");
  return out;
}

/** A masker that knows every secret in the environment (whichever are set). */
export function envMasker(env) {
  const masker = createMasker({ github: false });
  const names = [...Object.values(ENV.accounts).flatMap((a) => Object.values(a)), ...Object.values(ENV.teams), ...Object.values(ENV.buckets)];
  for (const n of names) if (env[n]) masker.add(env[n]);
  return masker;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const masker = envMasker(env);
  const report = JSON.parse(readFileSync(args.report, "utf8"));
  const registry = JSON.parse(readFileSync(args.registry, "utf8"));
  let warnings = [];
  if (args.warnings) {
    try { warnings = JSON.parse(readFileSync(args.warnings, "utf8")); } catch {}
  }
  const s = summarize(report, registry, { redact: masker.redact, warnings });
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, s.markdown);
  else process.stdout.write(s.markdown);
  if (args.json) writeFileSync(args.json, JSON.stringify({ ok: s.ok, failed: s.failed, flaky: s.flaky, critical: s.critical }));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
