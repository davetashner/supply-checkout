#!/usr/bin/env node
// Notes the prod journey tests' result on a GitHub Release (supply-checkout-o60.6;
// docs/journey-tests-plan.md, "When the suite fails"). The deploy workflow's `verdict` job runs it
// after the journeys workflow, with `contents: write` and no AWS:
//
//   node scripts/release-verdict.mjs --repo owner/name --tag vX.Y.Z --suite <outcome>
//        --run-url <this run's URL> [--failed "J4.2 (desktop-chrome),…"] [--critical "…"]
//
// --suite is the outcome of the journeys job's suite step: `success` adds "Journey tests passed in
// prod" to the release's notes; `failure` adds "Journey tests failed in prod: <steps>" and marks
// the release as a pre-release, which the deploy workflow's release check then refuses unless
// the run says allow-bad-release. Anything else (skipped, cancelled, empty: the suite never ran or
// didn't finish) changes nothing. A pass never clears the pre-release mark: the owner does that by
// hand (docs/releases.md, "When the journey tests fail").
//
// The lists come from another job, and the note is public, so every entry must look like a step
// and a browser (`J4.2 (desktop-chrome)`), the tag like vX.Y.Z and the URL like a run's; anything
// else is refused before anything is changed. Appends to $GITHUB_STEP_SUMMARY when it's set.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNBOOK = "docs/runbooks/journey-tests-failed.md";
const ENTRY = /^J\d{1,3}\.\d{1,3} \((desktop-chrome|iphone-safari)\)$/;
const TAG = /^v\d+\.\d+\.\d+$/;
const RUN_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/actions\/runs\/\d+$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** A comma-separated list of `J4.2 (desktop-chrome)` entries; throws on anything else. */
export function parseList(text, what) {
  const entries = String(text ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const e of entries) if (!ENTRY.test(e)) throw new Error(`--${what} must list steps like "J4.2 (desktop-chrome)"`);
  return [...new Set(entries)];
}

/** What to do with the release: `{ action: "pass" | "fail" | "none", note, prerelease }`. */
export function verdict({ suite, failed = [], critical = [], runUrl, tag }) {
  if (suite === "success") {
    return { action: "pass", prerelease: false, note: `**Journey tests passed in prod** for ${tag}: ${runUrl}` };
  }
  if (suite !== "failure") return { action: "none", prerelease: false, note: "" };
  const what = failed.length ? failed.join(", ") : "the suite failed before any test finished (see the run)";
  const lines = [
    `**Journey tests failed in prod** for ${tag}: ${what}. ${runUrl}`,
    "",
    "Marked as a pre-release: the deploy workflow refuses to deploy it again unless the run is started with **allow-bad-release**.",
  ];
  if (critical.length) lines.push("", `**Critical journeys failed** (${critical.join(", ")}): a P1, follow \`${RUNBOOK}\`.`);
  return { action: "fail", prerelease: true, note: lines.join("\n") };
}

/** The release notes with the note added at the end. */
export function withNote(body, note) {
  const text = String(body ?? "").trimEnd();
  return `${text ? `${text}\n\n` : ""}${note}\n`;
}

export function parseArgs(argv) {
  const out = {};
  const flags = { "--repo": "repo", "--tag": "tag", "--suite": "suite", "--run-url": "runUrl", "--failed": "failed", "--critical": "critical" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]];
    if (!key || i + 1 >= argv.length || key in out) throw new Error(`Unknown or incomplete argument ${argv[i]}`);
    out[key] = argv[i + 1];
  }
  if (!REPO.test(out.repo ?? "")) throw new Error("--repo must be owner/name");
  if (!TAG.test(out.tag ?? "")) throw new Error("--tag must look like v1.2.3");
  if (!RUN_URL.test(out.runUrl ?? "")) throw new Error("--run-url must be a GitHub Actions run's URL");
  if (out.suite === undefined) throw new Error("--suite is required (the suite step's outcome; empty if it didn't run)");
  return { ...out, failed: parseList(out.failed, "failed"), critical: parseList(out.critical, "critical") };
}

const gh = (args, run = execFileSync) => run("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

/** Edits the release as `verdict` says. Returns the verdict. */
export function main(argv, { run = execFileSync, env = process.env } = {}) {
  const args = parseArgs(argv);
  const v = verdict(args);
  const summary = (text) => { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`); };
  if (v.action === "none") {
    console.log(`The journey tests didn't run or didn't finish (suite: ${args.suite || "not run"}): ${args.tag}'s release is left as it is`);
    summary(`## Release\n\nThe journey tests didn't run or didn't finish, so ${args.tag}'s release is left as it is.`);
    return v;
  }
  const release = JSON.parse(gh(["release", "view", args.tag, "--repo", args.repo, "--json", "body"], run));
  const dir = mkdtempSync(path.join(env.RUNNER_TEMP || tmpdir(), "release-verdict-"));
  try {
    const file = path.join(dir, "notes.md");
    writeFileSync(file, withNote(release.body, v.note));
    const edit = ["release", "edit", args.tag, "--repo", args.repo, "--notes-file", file];
    if (v.prerelease) edit.push("--prerelease");
    gh(edit, run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const done = v.prerelease ? `${args.tag} is now a pre-release, with the failed steps in its notes` : `${args.tag}'s notes say the journey tests passed`;
  console.log(done);
  summary(`## Release\n\n${done}.`);
  return v;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`release-verdict: ${e.message}`);
    process.exit(1);
  }
}
