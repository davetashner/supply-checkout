// Time-based one-time codes (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), as Cognito's
// software token MFA and every authenticator app use. No dependency: node:crypto does it.
//
// Cognito won't take the same code twice, and the suite signs in as `owner` from more than one
// process (global setup, the browser tests, cleanup), so freshTotp() remembers the last step it
// used in a file in the run's temporary directory and waits for the next step when needed.
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export const STEP_SECONDS = 30;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The bytes of a base32 secret (RFC 4648; spaces, padding and letter case ignored). */
export function base32Decode(secret) {
  const clean = String(secret).replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("A TOTP secret is base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for time step `step` of a key (a Buffer), `digits` long. */
export function hotp(key, step, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const n = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(n % 10 ** digits).padStart(digits, "0");
}

/** The time step at `nowMs`. */
export const stepAt = (nowMs) => Math.floor(nowMs / 1000 / STEP_SECONDS);

/** The code for a base32 secret at `nowMs`. */
export const totp = (secret, nowMs = Date.now(), digits = 6) => hotp(base32Decode(secret), stepAt(nowMs), digits);

/**
 * A code no process of this run has used yet: if the current step was used (recorded in
 * `stateFile`), waits for the next one. Records the step it returns.
 */
export async function freshTotp(secret, { stateFile, now = Date.now, sleep = delay } = {}) {
  let last = -1;
  try { last = Number(readFileSync(stateFile, "utf8")) || -1; } catch {}
  let t = now();
  if (stepAt(t) <= last) {
    await sleep((last + 1) * STEP_SECONDS * 1000 - t + 250);
    t = now();
  }
  const step = stepAt(t);
  if (stateFile) writeFileSync(stateFile, String(step), { mode: 0o600 });
  return hotp(base32Decode(secret), step);
}
