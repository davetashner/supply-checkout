// Masking for the prod journey harness. The repository is public, so its Actions logs, job
// summaries and annotations are public. Every value the harness learns that names or unlocks
// something (codes and links from the mailbox, throwaway addresses, team and user IDs, tokens)
// is masked with GitHub's ::add-mask:: before it can be printed, and every text the harness
// prints itself goes through redact() as well, in case a value slipped past.
import { appendFileSync, readFileSync } from "node:fs";

/** Longer values first, so a value that contains another is replaced whole. */
const byLength = (a, b) => b.length - a.length;

// A JWT (three base64url parts, the first starting "eyJ"), an email address, a 12-digit AWS
// account ID, an S3 URL's bucket, and query parameters that carry secrets
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g;
const ACCOUNT_ID = /(?<![0-9])[0-9]{12}(?![0-9])/g;
const S3_URL = /\bs3:\/\/[^/\s]+/g;
const SECRET_PARAMS = /([?&](?:token|code|invite|session|state|access_token|id_token|refresh_token)=)[^&\s"'#]+/gi;

/** `run-1234-1-owner-…@e2e.example.com` → `run…@e2e.example.com`: the domain and nothing more. */
export function maskAddress(address) {
  const text = String(address ?? "");
  const at = text.lastIndexOf("@");
  if (at < 0) return "***";
  return `${text.slice(0, Math.min(3, at))}…@${text.slice(at + 1)}`;
}

/** The file in the run's directory where maskers record the values they learn at run time. */
export const MASKED_VALUES_FILE = "masked-values";

/**
 * A masker.
 *
 * - `remember(value)` only remembers it for redact(). For values that are already GitHub
 *   secrets (the passwords, the TOTP secret, the addresses, team IDs and bucket names), which
 *   the runner masks on its own: printing `::add-mask::` for them would put them in the
 *   output Playwright keeps in its JSON report.
 * - `add(value)` remembers a value learned at run time (a code, a link, a throwaway address, a
 *   token, an ID) and, in GitHub Actions, prints `::add-mask::` for it (each line of a
 *   multi-line value), so the runner hides it in the log from then on. With `persist` (a file
 *   path), it also appends it to that file (mode 600, in the run's directory), so
 *   prod-summary.mjs and upload-results.mjs can redact it too; upload never uploads that file.
 * - `redact(text)` replaces every remembered value, and anything shaped like a token, an
 *   address, an account ID or a secret query parameter, with `***`.
 *
 * `write` is where the mask commands go (stdout by default). Each command gets a line of its own.
 */
export function createMasker({ github = process.env.GITHUB_ACTIONS === "true", write = (s) => process.stdout.write(s), persist } = {}) {
  const values = new Set();
  let file = persist;
  const lines = (value) => (value === undefined || value === null ? [] : String(value).split(/\r?\n/).filter((line) => line.trim().length >= 4 && !values.has(line)));
  // Very short values would mask every occurrence of common text; nothing secret is that short
  const remember = (value) => {
    for (const line of lines(value)) values.add(line);
    return value;
  };
  const add = (value) => {
    for (const line of lines(value)) {
      values.add(line);
      if (file) appendFileSync(file, `${line}\n`, { mode: 0o600 });
      if (github) write(`\n::add-mask::${line}\n`);
    }
    return value;
  };
  const redact = (input) => {
    let text = String(input ?? "");
    for (const v of [...values].sort(byLength)) text = text.split(v).join("***");
    return text
      .replace(JWT, "***")
      .replace(SECRET_PARAMS, "$1***")
      .replace(S3_URL, "s3://***")
      .replace(EMAIL, (m) => maskAddress(m))
      .replace(ACCOUNT_ID, "***");
  };
  /** From now on, also record add()ed values in `path` (once the run's directory exists). */
  const persistTo = (path) => { file = path; };
  return { add, remember, redact, persistTo, has: (v) => values.has(String(v)), get size() { return values.size; } };
}

/** The values recorded in a masked-values file (none if it doesn't exist). */
export function readMaskedValues(file) {
  try { return readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { return []; }
}
