// The limits on password reset requests made through the app (POST
// /auth/password-reset, supply-checkout-6uw.26). The API counts the requests,
// before anything is queued or looked up, so an address with an account and
// one without are counted alike and a limit can't tell them apart; the
// password reset function counts the help emails.
//
// - Requests: each address (its inviteLimitKey, so +tags and Gmail's dots
//   count as one mailbox) and each IP address (an IPv6 address by its /64),
//   by the UTC hour and day, all four windows in one transaction, so a
//   refused request counts in none of them. Past any, the API answers 429 and
//   nothing is queued: no code and no help email.
// - Help emails (to an address we can't send a code to): one per address a
//   UTC day, and PASSWORD_RESET_HELP_PER_DAY for everyone together, a circuit
//   breaker on the app sending mail to addresses that never signed up.
//
// Keys are SHA-256 hashes, never an address or IP address, and each window
// expires a day after it ends (TTL).

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { inviteLimitKey } from "./model.js";
import { PASSWORD_RESET_HELP_PER_DAY, PASSWORD_RESET_LIMIT_PREFIX } from "./schema.js";

/** Reset requests one address may get, and one IP address may make, per UTC hour and day. */
export const PASSWORD_RESET_LIMITS = { addressPerHour: 3, addressPerDay: 6, ipPerHour: 10, ipPerDay: 30 } as const;

/** Help emails one address may get a UTC day. */
export const PASSWORD_RESET_HELP_PER_ADDRESS_PER_DAY = 1;

/** Help emails the app may send a UTC day, to every address together: schema.ts has why, and is the one place to change it. */
export { PASSWORD_RESET_HELP_PER_DAY };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** How long a window's counter is kept after the window ends. */
const GRACE_SECONDS = 86_400;
const ATTEMPTS = 3;

/** The key the limits count an address under: its inviteLimitKey. Throws InvalidInputError for an address the app can't mail. */
export const resetAddressKey = (email: string): string => inviteLimitKey(email);

/**
 * The key the limits count an IP address under: the SHA-256 of an IPv4
 * address (an IPv4-mapped IPv6 address counts as its IPv4 address), or of an
 * IPv6 address's first 64 bits (one network hands out a whole /64, so
 * counting each address would count nothing). Throws for anything that isn't
 * an IP address.
 */
export function resetIpKey(ip: string): string {
  const version = isIP(ip);
  if (version === 0) throw new Error("Not an IP address");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const network = version === 4 ? ip : mapped ? (mapped[1] as string) : ipv6Prefix(ip);
  return createHash("sha256").update(`ip:${network}`, "utf8").digest("hex");
}

/** The first four groups of a valid IPv6 address, written the same way however it was given ("::" expanded, lowercase, no leading zeros). */
export function ipv6Prefix(ip: string): string {
  const bare = (ip.split("%")[0] as string).toLowerCase();
  const [head = "", tail] = bare.split("::");
  const left = head ? head.split(":") : [];
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  // An IPv4 tail (…:1.2.3.4) stands for two groups
  const width = (groups: string[]) => groups.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - width(left) - width(right))).fill("0"), ...right];
  return groups
    .slice(0, 4)
    .map((g) => (g.includes(".") ? g : Number.parseInt(g, 16).toString(16)))
    .join(":");
}

interface Window {
  readonly key: { PK: string; SK: string };
  readonly max: number;
  readonly ends: number;
}

const windowOf = (pk: string, kind: "HOUR" | "DAY", now: Date, max: number): Window => {
  const ms = kind === "HOUR" ? HOUR_MS : DAY_MS;
  const iso = now.toISOString();
  return { key: { PK: `${PASSWORD_RESET_LIMIT_PREFIX}${pk}`, SK: `${kind}#${kind === "HOUR" ? iso.slice(0, 13) : iso.slice(0, 10)}` }, max, ends: Math.floor(now.getTime() / ms) * ms + ms };
};

/**
 * Counts one in every window, or in none: the windows that were full (by
 * index), so none when they all had room. A transaction that keeps
 * conflicting (requests for the same address at once) is refused too, as if
 * the first window were full, rather than let one through uncounted.
 */
async function take(db: Db, windows: readonly Window[]): Promise<number[]> {
  const write = new TransactWriteCommand({
    TransactItems: windows.map(({ key, max, ends }) => ({
      Update: {
        TableName: db.tableName,
        Key: key,
        UpdateExpression: "ADD #count :one SET expiresAt = :expires",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":one": 1, ":max": max, ":expires": Math.ceil(ends / 1000) + GRACE_SECONDS },
      },
    })),
  });
  for (let attempt = 1; ; attempt++) {
    try {
      await connection(db).doc.send(write);
      return [];
    } catch (error) {
      if ((error as { name?: string } | null)?.name !== "TransactionCanceledException") throw error;
      const codes = ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map((r) => r.Code);
      const full = codes.flatMap((code, i) => (code === "ConditionalCheckFailed" ? [i] : []));
      if (full.length > 0) return full;
      if (!codes.includes("TransactionConflict")) throw error;
      if (attempt >= ATTEMPTS) return [0];
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 20)));
    }
  }
}

/** Counts one reset request for the address and from the IP address (their keys), or returns false when either is over its limits. */
export async function takePasswordReset(db: Db, addressKey: string, ipKey: string, now = new Date()): Promise<boolean> {
  const full = await take(db, [
    windowOf(`ADDRESS#${addressKey}`, "HOUR", now, PASSWORD_RESET_LIMITS.addressPerHour),
    windowOf(`ADDRESS#${addressKey}`, "DAY", now, PASSWORD_RESET_LIMITS.addressPerDay),
    windowOf(`IP#${ipKey}`, "HOUR", now, PASSWORD_RESET_LIMITS.ipPerHour),
    windowOf(`IP#${ipKey}`, "DAY", now, PASSWORD_RESET_LIMITS.ipPerDay),
  ]);
  return full.length === 0;
}

/**
 * Counts one help email to the address (its key) and one for the day: "ok",
 * or what was used up: "address" (its one a day) or "cap" (everyone's,
 * PASSWORD_RESET_HELP_PER_DAY, whether or not the address's was too).
 */
export async function takePasswordResetHelp(db: Db, addressKey: string, now = new Date(), cap = PASSWORD_RESET_HELP_PER_DAY): Promise<"ok" | "address" | "cap"> {
  // A new window's first count would pass any condition, so a cap of 0 is checked here
  if (cap <= 0) return "cap";
  const full = await take(db, [
    windowOf(`HELP#${addressKey}`, "DAY", now, PASSWORD_RESET_HELP_PER_ADDRESS_PER_DAY),
    windowOf("HELP", "DAY", now, cap),
  ]);
  return full.length === 0 ? "ok" : full.includes(1) ? "cap" : "address";
}
