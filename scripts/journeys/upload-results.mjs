#!/usr/bin/env node
// Puts a prod journey run's results (Playwright's traces, videos and screenshots of failed tests,
// and the JSON report) in the private results bucket, under runs/<runId>/. Never an Actions
// artifact: those are public here.
//
//   node scripts/journeys/upload-results.mjs [--run <runId>]
//
// The journeys workflow runs it after cleanup (so every token in a trace was already revoked)
// and after prod-summary.mjs, both with `if: always()`. Before uploading it:
//
// 1. Rewrites report.json without any test's stdout or stderr (where ::add-mask:: commands and
//    anything a test printed would be), without any ::add-mask:: line, and with every string
//    redacted: the environment's secrets, the values the run masked (the masked-values file),
//    and anything shaped like a token, an address or an account ID.
// 2. Refuses to upload anything if any file it would upload still holds a secret from the
//    environment or an ::add-mask:: command, naming the files (never the values).
//
// It never uploads the masked-values file or the TOTP step markers, and prints the key prefix,
// never the bucket.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENV, assertRunAllowed, readConfig, runDir, runId as currentRunId, secretValues } from "./lib/config.mjs";
import { MASKED_VALUES_FILE, createMasker, readMaskedValues } from "./lib/mask.mjs";
import { createS3 } from "./lib/s3.mjs";

export const REPORT_FILE = "report.json";
const ADD_MASK = "::add-mask::";
/** Files in the run's directory that are never uploaded. */
export const NOT_UPLOADED = [MASKED_VALUES_FILE, "totp-step*"];
const notUploaded = (rel) => rel === MASKED_VALUES_FILE || /^totp-step/.test(path.basename(rel));

/** A Playwright JSON report without stdout, stderr or ::add-mask:: lines, every string redacted. */
export function scrubReport(report, redact) {
  const walk = (value) => {
    if (typeof value === "string") return redact(value.split("\n").filter((l) => !l.includes(ADD_MASK)).join("\n"));
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "stdout" && k !== "stderr").map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk(report);
}

/** Every file under `dir` it would upload, relative to `dir`. */
export function filesToUpload(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(dir, path.join(d.parentPath ?? d.path, d.name)))
    .filter((rel) => !notUploaded(rel))
    .sort();
}

/** The files (relative paths) that hold any of `secrets` or an ::add-mask:: command. */
export function findLeaks(dir, files, secrets) {
  const needles = [ADD_MASK, ...secrets].filter((s) => s && s.length >= 4).map((s) => Buffer.from(s));
  return files.filter((rel) => {
    const bytes = readFileSync(path.join(dir, rel));
    return needles.some((n) => bytes.includes(n));
  });
}

export async function upload({ env, run, s3For }) {
  assertRunAllowed(env);
  const config = readConfig(env);
  const id = run ?? currentRunId(env);
  const dir = runDir(env, id);
  let files;
  try { files = filesToUpload(dir); } catch { return `upload-results: nothing to upload for run ${id}`; }
  const secrets = secretValues(config);
  const masker = createMasker({ github: false });
  for (const v of [...secrets, ...readMaskedValues(path.join(dir, MASKED_VALUES_FILE))]) masker.remember(v);
  if (files.includes(REPORT_FILE)) {
    const file = path.join(dir, REPORT_FILE);
    let report;
    try { report = JSON.parse(readFileSync(file, "utf8")); } catch { report = { error: "The JSON report couldn't be read; it was replaced by this note" }; }
    writeFileSync(file, JSON.stringify(scrubReport(report, masker.redact)), { mode: 0o600 });
  }
  const leaks = findLeaks(dir, files, secrets);
  if (leaks.length) throw new Error(`Refusing to upload: a secret or an ::add-mask:: command is in ${leaks.join(", ")}`);
  await s3For(env[ENV.buckets.results]).upload(dir, `runs/${id}/`, NOT_UPLOADED);
  return `upload-results: run ${id}'s results (${files.length} files) are in the results bucket under runs/${id}/`;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const masker = createMasker({ github: false });
  if (env[ENV.buckets.results]) masker.remember(env[ENV.buckets.results]);
  try {
    const run = argv[0] === "--run" ? argv[1] : undefined;
    if (argv.length && !run) throw new Error("Usage: upload-results.mjs [--run <runId>]");
    console.log(await upload({ env, run, s3For: (b) => createS3(b) }));
    return 0;
  } catch (err) {
    console.error(masker.redact(`upload-results: ${err instanceof Error ? err.message : err}`));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
