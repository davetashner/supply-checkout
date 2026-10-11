// Sealing a billing throwaway's sign-in secrets inside its run record (supply-checkout-o60.9).
//
// The billing journey's owner turns two-step sign-in on, and from then on Cognito takes only its
// password and a code from its authenticator secret, not the email code cleanup uses for the
// other throwaways. So that the next run's cleanup can still delete the account of a run that
// died, the journey records `{ password, totp }` in the run record, but only sealed: AES-256-GCM
// under a key derived (HKDF-SHA256, a random salt per record) from the owner secret the environment already holds (the long-lived owner's
// password), which the bucket and the journeys role never see. A record without the secret
// reveals nothing, and one that can't be opened (the secret was rotated since) is reported as
// left, never guessed at. The throwaway has no value of its own: this is only so it can be
// deleted. Nothing sealed is ever logged.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// v2: the key is HKDF-SHA256 of the secret with a random 16-byte salt kept in the sealed value, so
// no two records share a key, and the record's key path is bound as GCM's additional data, so a
// sealed value copied into another record (another account, another run) doesn't open. The secret
// is the long-lived owner's password: it must be long and random (32 random characters, as the
// plan says), since a guess at it is the only way into a sealed value.
const VERSION = "v2";
export const SEALED = /^v2\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16,1024}$/;

const keyOf = (secret, salt) => {
  if (typeof secret !== "string" || secret.length < 16) throw new Error("The sealing secret is missing or too short");
  return Buffer.from(hkdfSync("sha256", secret, salt, "supply-checkout journeys record seal v2", 32));
};
const aadOf = (aad) => {
  if (typeof aad !== "string" || !/^runs\/[A-Za-z0-9-]{1,40}\/accounts\/[a-z]{1,12}\.json$/.test(aad)) throw new Error("A sealed value is bound to its record's key path");
  return Buffer.from(aad);
};

/** Seals `{ password, totp }` (strings) under `secret`, bound to the record at `aad` (its key path): `v2.<salt>.<iv>.<ciphertext and tag>`, base64url. */
export function seal({ password, totp }, secret, { aad, random = randomBytes } = {}) {
  if (typeof password !== "string" || !password) throw new Error("Nothing to seal: no password");
  if (totp !== undefined && typeof totp !== "string") throw new Error("A sealed authenticator secret is a string");
  const salt = random(16);
  const iv = random(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(secret, salt), iv);
  cipher.setAAD(aadOf(aad));
  const body = Buffer.concat([cipher.update(JSON.stringify({ password, ...(totp ? { totp } : {}) }), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${VERSION}.${salt.toString("base64url")}.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

/** Opens a sealed value from the record at `aad`; throws a message that says nothing about the contents if it can't. */
export function unseal(sealed, secret, { aad } = {}) {
  if (typeof sealed !== "string" || !SEALED.test(sealed)) throw new Error("Not a sealed value");
  const [, salt, iv, body] = sealed.split(".");
  const bound = aadOf(aad);
  try {
    const data = Buffer.from(body, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", keyOf(secret, Buffer.from(salt, "base64url")), Buffer.from(iv, "base64url"));
    decipher.setAAD(bound);
    decipher.setAuthTag(data.subarray(data.length - 16));
    const { password, totp } = JSON.parse(Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8"));
    if (typeof password !== "string" || !password || (totp !== undefined && typeof totp !== "string")) throw new Error("bad shape");
    return { password, ...(totp ? { totp } : {}) };
  } catch {
    throw new Error("A sealed value couldn't be opened (the sealing secret changed, it is another record's, or it was altered)");
  }
}
