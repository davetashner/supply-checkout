// Scrubbing a failed test's Playwright trace (trace.zip) before upload-results.mjs uploads it.
// A trace records every request and response: their headers (a live Bearer access token, the
// refresh cookie and the Set-Cookie that sets it) in the .network and .trace entries, and their
// bodies as resources/ files (/auth/session and /auth/refresh answer with an access token). The
// zip is compressed, so the upload's byte-level leak check can't see inside it; this unpacks it,
// strips those, checks every entry, and repacks it.
import { unzipSync, zipSync } from "fflate";

/** Headers (and HAR cookie lists) never kept in an uploaded trace. */
export const SENSITIVE_HEADERS = ["authorization", "proxy-authorization", "cookie", "set-cookie"];
const sensitive = (name) => typeof name === "string" && SENSITIVE_HEADERS.includes(name.toLowerCase());
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * `value` without any sensitive header, wherever it is: a `{ name, value }` entry of a headers
 * list (HAR and Playwright's protocol), a key of a headers object, or a cookie list (`cookies`,
 * emptied) or a context's `storageState` (removed).
 */
export function stripHeaders(value) {
  if (Array.isArray(value)) return value.filter((v) => !(isObject(v) && sensitive(v.name))).map(stripHeaders);
  if (!isObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (sensitive(k) || k === "storageState") continue;
    out[k] = k.toLowerCase() === "cookies" && Array.isArray(v) ? [] : stripHeaders(v);
  }
  return out;
}

/** True for the API's /auth routes and Cognito's token endpoints, whose bodies carry tokens. */
export function isAuthUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.pathname === "/auth" || u.pathname.startsWith("/auth/") || u.pathname.startsWith("/oauth2/") || /^cognito-idp\./.test(u.hostname);
}

/** Removes a body (inline text, form params, or a resources/ file) and returns the file it named. */
function dropBody(body) {
  if (!isObject(body)) return [];
  const files = [];
  if (typeof body._file === "string") files.push(body._file);
  if (typeof body._sha1 === "string") files.push(`resources/${body._sha1}`);
  for (const k of ["text", "params", "_file", "_sha1", "encoding"]) delete body[k];
  return files;
}

/** One trace event, scrubbed, and the resources/ files of the bodies it dropped. */
function scrubEvent(event) {
  const clean = stripHeaders(event);
  const snapshot = clean?.snapshot;
  if (clean?.type !== "resource-snapshot" || !isAuthUrl(snapshot?.request?.url)) return { event: clean, drop: [] };
  return { event: clean, drop: [...dropBody(snapshot.request.postData), ...dropBody(snapshot.response?.content)] };
}

// A JWT whose header and payload are both JSON (each part starts "eyJ"): an access or ID token
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

/** The entries (names) that hold any of `needles` (Buffers) or anything shaped like a JWT. */
export function leakingEntries(entries, needles) {
  return Object.entries(entries).filter(([, bytes]) => {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return needles.some((n) => buf.includes(n)) || JWT.test(buf.toString("latin1"));
  }).map(([name]) => name).sort();
}

/**
 * A scrubbed copy of a trace.zip: every .trace and .network entry without sensitive headers or
 * cookies (a line that isn't JSON is dropped, since it can't be checked), and without the bodies
 * of auth calls and their resources/ files. `leaks` names the entries that still hold one of
 * `needles` or a JWT; the caller refuses to upload the trace if there are any. Throws if the
 * zip can't be read.
 */
export function scrubTrace(zip, needles = []) {
  const entries = unzipSync(zip instanceof Uint8Array ? zip : new Uint8Array(zip));
  const dropped = new Set();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  for (const name of Object.keys(entries)) {
    if (!/\.(trace|network)$/.test(name)) continue;
    const lines = [];
    for (const line of decoder.decode(entries[name]).split("\n")) {
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      const { event, drop } = scrubEvent(parsed);
      for (const f of drop) dropped.add(f);
      lines.push(JSON.stringify(event));
    }
    entries[name] = encoder.encode(lines.length ? `${lines.join("\n")}\n` : "");
  }
  for (const f of dropped) delete entries[f];
  return { zip: zipSync(entries, { level: 6 }), leaks: leakingEntries(entries, needles), dropped: [...dropped].sort() };
}
