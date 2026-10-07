#!/usr/bin/env node
// Puts a prod journey run's results (Playwright's traces, videos and screenshots of failed tests,
// and the JSON report) in the private results bucket, under runs/<runId>/, then deletes them from
// the run's temporary directory. Never an Actions artifact: those are public here.
//
//   node scripts/journeys/upload-results.mjs [--run <runId>]
//
// The journeys workflow runs it after cleanup, so every token in a trace was already revoked
// (cleanup signs every test account out everywhere). It prints the key prefix, never the bucket.
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENV, assertRunAllowed, runDir, runId as currentRunId } from "./lib/config.mjs";
import { createMasker } from "./lib/mask.mjs";
import { createS3 } from "./lib/s3.mjs";

export async function upload({ env, run, s3For, exists = existsSync, remove = (d) => rmSync(d, { recursive: true, force: true }) }) {
  assertRunAllowed(env);
  const bucket = env[ENV.buckets.results];
  if (!bucket) throw new Error(`${ENV.buckets.results} is not set`);
  const id = run ?? currentRunId(env);
  const dir = runDir(env, id);
  if (!exists(dir)) return `upload-results: nothing to upload for run ${id}`;
  await s3For(bucket).upload(dir, `runs/${id}/`);
  remove(dir);
  return `upload-results: run ${id}'s results are in the results bucket under runs/${id}/`;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const masker = createMasker();
  if (env[ENV.buckets.results]) masker.add(env[ENV.buckets.results]);
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
