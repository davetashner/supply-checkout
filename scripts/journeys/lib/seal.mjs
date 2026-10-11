// Sealing a billing throwaway's sign-in secrets inside its run record (supply-checkout-o60.9).
//
// The billing journey's owner turns two-step sign-in on, and from then on Cognito takes only its
// password and a code from its authenticator secret, not the email code cleanup uses for the
// other throwaways. So that the next run's cleanup can still delete the account of a run that
// died, the journey records `{ password, totp }` in the run record, but only sealed: AES-256-GCM
// under a key made from the owner secret the environment already holds (the long-lived owner's
// password), which the bucket and the journeys role never see. A record without the secret
// reveals nothing, and one that can't be opened (the secret was rotated since) is reported as
// left, never guessed at. The throwaway has no value of its own: this is only so it can be
// deleted. Nothing sealed is ever logged.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const VERSION = "v1";
export const SEALED = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16,1024}$/;

const keyOf = (secret) => {
  if (typeof secret !== "string" || secret.length < 16) throw new Error("The sealing secret is missing or too short");
  return createHmac("sha256", secret).update("supply-checkout journeys record seal v1").digest();
};

/** Seals `{ password, totp }` (strings) under `secret`: `v1.<iv>.<ciphertext and tag>`, base64url. */
export function seal({ password, totp }, secret, { random = randomBytes } = {}) {
  if (typeof password !== "string" || !password) throw new Error("Nothing to seal: no password");
  if (totp !== undefined && typeof totp !== "string") throw new Error("A sealed authenticator secret is a string");
  const iv = random(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ password, ...(totp ? { totp } : {}) }), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${VERSION}.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

/** Opens a sealed value; throws a message that says nothing about the contents if it can't. */
export function unseal(sealed, secret) {
  if (typeof sealed !== "string" || !SEALED.test(sealed)) throw new Error("Not a sealed value");
  const [, iv, body] = sealed.split(".");
  try {
    const data = Buffer.from(body, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", keyOf(secret), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(data.subarray(data.length - 16));
    const { password, totp } = JSON.parse(Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8"));
    if (typeof password !== "string" || !password || (totp !== undefined && typeof totp !== "string")) throw new Error("bad shape");
    return { password, ...(totp ? { totp } : {}) };
  } catch {
    throw new Error("A sealed value couldn't be opened (the sealing secret changed, or the record was altered)");
  }
}
