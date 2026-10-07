// Time-based one-time codes (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), as Cognito's
// software token MFA and every authenticator app use. No dependency: node:crypto does it.
//
// Cognito won't take the same code twice, and the suite signs in as `owner` from more than one
// process (global setup, the browser tests, cleanup), so freshTotp() claims each step with an
// exclusive create of a marker file in the run's temporary directory, and waits for the next step
// when the current one is taken.
import { createHmac } from "node:crypto";
import { closeSync, openSync } from "node:fs";
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
 * A code no process of this run has used yet. Each process claims a step by creating
 * `<stateFile>.<step>` exclusively (O_EXCL, so two processes can't both claim one); if the
 * current step is taken, it waits for the next one and claims that. Without `stateFile`, just
 * the current code.
 */
export async function freshTotp(secret, { stateFile, now = Date.now, sleep = delay } = {}) {
  const key = base32Decode(secret);
  if (!stateFile) return hotp(key, stepAt(now()));
  let step = stepAt(now());
  for (;;) {
    try {
      closeSync(openSync(`${stateFile}.${step}`, "wx", 0o600));
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      step += 1;
    }
  }
  const startsAt = step * STEP_SECONDS * 1000;
  if (now() < startsAt) await sleep(startsAt - now() + 250);
  return hotp(key, step);
}
