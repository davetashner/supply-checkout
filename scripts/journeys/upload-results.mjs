#!/usr/bin/env node
// Puts a prod journey run's results (Playwright's traces, videos and screenshots of failed tests,
// and the JSON report) in the private results bucket, under runs/<runId>/. Never an Actions
// artifact: those are public here.
//
//   node scripts/journeys/upload-results.mjs [--run <runId>]
//
// The journeys workflow runs it after cleanup (so every token in a trace was already revoked)
// and after prod-summary.mjs, both with `if: always()`, in the same job as the tests. Before
// uploading it:
//
// 1. Refuses if the run directory holds a symlink (the AWS CLI would follow it).
// 2. Rewrites report.json without any test's stdout or stderr (where ::add-mask:: commands and
//    anything a test printed would be) and without any ::add-mask:: line, and rewrites it and
//    every other text file (.json, .md, .txt: Playwright's error-context.md, for one) with every
//    string redacted: the environment's secrets (addresses, team IDs and bucket names among
//    them, which a failed test's page and URLs show), the values the run masked (the
//    masked-values file), and anything shaped like a token, an address or an account ID.
// 3. Refuses to upload anything if any file it would upload (binary ones too) holds a password
//    or the TOTP secret, as is, JSON-escaped, URL-encoded or form-encoded (checked before and after step 2),
//    or still holds an ::add-mask:: command after it, naming the files (never the values).
//
// Each trace (.zip) is unpacked first (lib/traces.mjs): the Authorization, Cookie, Set-Cookie and
// Sec-WebSocket-Protocol headers and cookie lists go from every request and response in its
// .network and .trace entries, as do the bodies of /auth calls and WebSocket frames (their
// resources/ files), and it's repacked only if no entry still holds a password, the TOTP secret, a
// saved session's refresh token or anything shaped like a JWT or JWE; otherwise the upload is refused. A trace that can't be unpacked can't be
// checked, so it's deleted rather than uploaded. The fixtures keep sign-in out of traces as well
// (lib/tracing.mjs).
//
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENV, assertRunAllowed, readConfig, runDir, runId as currentRunId, secretValues } from "./lib/config.mjs";
import { MASKED_VALUES_FILE, createMasker, readMaskedValues } from "./lib/mask.mjs";
import { SESSIONS_DIR, createSessionPool } from "./lib/sessions.mjs";
import { scrubTrace } from "./lib/traces.mjs";
import { createS3 } from "./lib/s3.mjs";

export const REPORT_FILE = "report.json";
const ADD_MASK = "::add-mask::";
/** Files in the run's directory that are never uploaded. */
export const NOT_UPLOADED = [MASKED_VALUES_FILE, "totp-step*", `${SESSIONS_DIR}/*`];
const notUploaded = (rel) => rel === MASKED_VALUES_FILE || /^totp-step/.test(path.basename(rel)) || rel.split(path.sep)[0] === SESSIONS_DIR;

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

/** Every file under `dir` it would upload, relative to `dir`. Throws if there's a symlink. */
export function filesToUpload(dir) {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  const links = entries.filter((d) => d.isSymbolicLink()).map((d) => path.relative(dir, path.join(d.parentPath ?? d.path, d.name)));
  if (links.length) throw new UploadRefused(`Refusing to upload: the run directory holds symlinks (${links.sort().join(", ")})`);
  return entries
    .filter((d) => d.isFile())
    .map((d) => path.relative(dir, path.join(d.parentPath ?? d.path, d.name)))
    .filter((rel) => !notUploaded(rel))
    .sort();
}

export class UploadRefused extends Error {}

/** The forms a secret can take in a file: as is, JSON-escaped, URL-encoded and form-encoded. */
export const leakForms = (secret) => [...new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), new URLSearchParams({ x: secret }).toString().slice(2)])];

/** The files (relative paths) that hold any form of any of `secrets`, or an ::add-mask:: command. */
export function findLeaks(dir, files, secrets, { addMask = true } = {}) {
  const needles = [...(addMask ? [ADD_MASK] : []), ...secrets.filter((s) => s && s.length >= 4).flatMap(leakForms)].map((s) => Buffer.from(s));
  return files.filter((rel) => {
    const bytes = readFileSync(path.join(dir, rel));
    return needles.some((n) => bytes.includes(n));
  });
}

/**
 * Scrubs every trace (.zip) among `files` in place (lib/traces.mjs) and returns the ones it
 * deleted because they couldn't be unpacked. Throws UploadRefused, naming the trace and its
 * entries, if a scrubbed trace still holds any form of `secrets` or a JWT.
 */
export function scrubTraces(dir, files, secrets) {
  const needles = secrets.filter((s) => s && s.length >= 4).flatMap(leakForms).map((s) => Buffer.from(s));
  const deleted = [];
  for (const rel of files.filter((f) => /\.zip$/i.test(f))) {
    const file = path.join(dir, rel);
    let scrubbed;
    try { scrubbed = scrubTrace(readFileSync(file), needles); } catch {
      rmSync(file);
      deleted.push(rel);
      continue;
    }
    if (scrubbed.leaks.length) throw new UploadRefused(`Refusing to upload: a password, the TOTP secret, a session's refresh token or a token is in ${rel} (${scrubbed.leaks.join(", ")})`);
    writeFileSync(file, scrubbed.zip, { mode: 0o600 });
  }
  return deleted;
}

/** Text files the upload rewrites redacted. */
const TEXT = /\.(json|md|txt)$/i;

export async function upload({ env, run, s3For }) {
  assertRunAllowed(env);
  const config = readConfig(env);
  const id = run ?? currentRunId(env);
  const dir = runDir(env, id);
  if (!existsSync(dir)) return `upload-results: nothing to upload for run ${id}`;
  // Only what unlocks an account refuses the upload (everything else is redacted below). Checked
  // before redacting as well as after, so a password anywhere is a refusal, never a quiet fix.
  const { owner, crew, viewer } = config.accounts;
  // and any refresh token a saved session still holds (cleanup deletes them after signing out)
  const unlocking = [owner.password, crew.password, viewer.password, owner.totp, ...createSessionPool(dir).tokens()];
  const deleted = scrubTraces(dir, filesToUpload(dir), unlocking);
  const files = filesToUpload(dir);
  const refuse = (leaks) => { if (leaks.length) throw new UploadRefused(`Refusing to upload: a password, the TOTP secret, a session's refresh token or an ::add-mask:: command is in ${leaks.join(", ")}`); };
  refuse(findLeaks(dir, files, unlocking, { addMask: false }));
  const masker = createMasker({ github: false });
  for (const v of [...secretValues(config), ...readMaskedValues(path.join(dir, MASKED_VALUES_FILE))]) masker.remember(v);
  for (const rel of files.filter((f) => TEXT.test(f))) {
    const file = path.join(dir, rel);
    if (rel === REPORT_FILE) {
      let report;
      try { report = JSON.parse(readFileSync(file, "utf8")); } catch { report = { error: "The JSON report couldn't be read; it was replaced by this note" }; }
      writeFileSync(file, JSON.stringify(scrubReport(report, masker.redact)), { mode: 0o600 });
    } else {
      // Redacted, but a mask command is kept so the check below refuses it: only the report's
      // own stdout is an expected place for one
      writeFileSync(file, masker.redact(readFileSync(file, "utf8")), { mode: 0o600 });
    }
  }
  refuse(findLeaks(dir, files, unlocking));
  await s3For(env[ENV.buckets.results]).upload(dir, `runs/${id}/`, NOT_UPLOADED);
  const note = deleted.length ? `; deleted ${deleted.length} trace(s) that couldn't be unpacked (${deleted.join(", ")})` : "";
  return `upload-results: run ${id}'s results (${files.length} files) are in the results bucket under runs/${id}/${note}`;
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
