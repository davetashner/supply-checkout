// Key builders for every entity in ADR 0005. Nothing else builds key strings,
// and each builder validates its parts so a caller-supplied ID can't reach
// into another key (for example, a sheet ID containing "#").

import { InvalidInputError } from "./errors.js";
import { CLOSED_TEAMS_PARTITION, COMMITTING_IMPORTS_PARTITION, INVITE_LIMIT_PREFIX } from "./schema.js";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const HASH = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Team, user, sheet, invite, Stripe customer and event IDs: letters, digits, _ and -. */
export function id(value: unknown, what: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new InvalidInputError(`Invalid ${what}`);
  return value;
}

/**
 * Product keys come from the app (a barcode or a generated key), so they allow
 * more. Not "__proto__": a product key is also a field name in a sheet's
 * `items` map, and JavaScript (and the SDK's marshaller) would treat that one
 * as the map's prototype, not a field. Other built-in names ("constructor",
 * "toString") are fine; code that reads a line by key uses Object.hasOwn.
 */
export function productKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || CONTROL.test(value) || value === "__proto__") {
    throw new InvalidInputError("Invalid product key");
  }
  return value;
}

/** The longest barcode: the same bound as a product key, which the app makes from the barcode. */
export const MAX_CODE_LENGTH = 256;

/** A barcode (a product's or a sheet line's `code`): a string, empty for an item without one. */
export function barcode(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_CODE_LENGTH) throw new InvalidInputError("Invalid barcode");
  return value;
}

/** A sheet date, YYYY-MM-DD, as the app stores it. */
export function date(value: unknown): string {
  if (typeof value !== "string" || !DATE.test(value)) throw new InvalidInputError("Invalid date");
  return value;
}

/** A usage month, YYYY-MM. */
export function month(value: unknown): string {
  if (typeof value !== "string" || !MONTH.test(value)) throw new InvalidInputError("Invalid month");
  return value;
}

export const keys = {
  team: (teamId: string) => ({ PK: `TEAM#${id(teamId, "team ID")}`, SK: "META" }),
  /**
   * A membership. Every path that adds or deletes MEMBER items moves the
   * META item's `members` count (and `owners`, for an owner) in the same
   * transaction (teamCounts in model.ts): acceptInvite, removeMember (which
   * leaving and account deletion use). The one exception is the purge of a
   * closed team (team-purge.ts), which deletes the META item too.
   */
  member: (teamId: string, userId: string) => ({
    PK: `TEAM#${id(teamId, "team ID")}`,
    SK: `MEMBER#${id(userId, "user ID")}`,
  }),
  userTeam: (userId: string, teamId: string) => ({
    PK: `USER#${id(userId, "user ID")}`,
    SK: `TEAM#${id(teamId, "team ID")}`,
  }),
  invite: (teamId: string, inviteId: string) => ({
    PK: `TEAM#${id(teamId, "team ID")}`,
    SK: `INVITE#${id(inviteId, "invite ID")}`,
  }),
  product: (teamId: string, key: string) => ({ PK: `TEAM#${id(teamId, "team ID")}`, SK: `PRODUCT#${productKey(key)}` }),
  sheet: (teamId: string, sheetId: string) => ({
    PK: `TEAM#${id(teamId, "team ID")}`,
    SK: `SHEET#${id(sheetId, "sheet ID")}`,
  }),
  usage: (teamId: string, m: string) => ({ PK: `TEAM#${id(teamId, "team ID")}`, SK: `USAGE#${month(m)}` }),
  audit: (teamId: string, ts: string, eventId: string) => ({
    PK: `TEAM#${id(teamId, "team ID")}`,
    SK: `AUDIT#${ts}#${id(eventId, "event ID")}`,
  }),
  stripe: (customerId: string) => ({ PK: `STRIPE#${id(customerId, "Stripe customer ID")}`, SK: "TEAM" }),
  /**
   * Marks a user whose account is being deleted (accounts.ts). While it's
   * there, createTeam and acceptInvite refuse them in the same transaction as
   * the membership they'd add, so a join from another device can't slip in
   * after the deletion has listed the user's teams.
   */
  accountDeletion: (userId: string) => ({ PK: `USER#${id(userId, "user ID")}`, SK: "DELETING" }),
  /** How many teams the user created on a UTC day (YYYY-MM-DD): the per-user rate limit. */
  teamsCreated: (userId: string, day: string) => ({ PK: `USER#${id(userId, "user ID")}`, SK: `LIMIT#TEAMS#${date(day)}` }),
  /** How many email verification codes the user asked for on a UTC day: the per-user limit. */
  emailCodes: (userId: string, day: string) => ({ PK: `USER#${id(userId, "user ID")}`, SK: `LIMIT#EMAILCODES#${date(day)}` }),
  /** How many invites a team sent (created or re-sent) on a UTC day: the per-team invite limit. */
  invitesSent: (teamId: string, day: string) => ({ PK: `TEAM#${id(teamId, "team ID")}`, SK: `LIMIT#INVITES#${date(day)}` }),
  /**
   * How many invites went to one address (hashEmail) on a UTC day, from any
   * team: the per-invitee limit, so no one can use invites to flood a mailbox.
   */
  invitesToAddress: (emailHash: string, day: string) => ({ PK: inviteLimitPartition(emailHash), SK: `LIMIT#INVITES#${date(day)}` }),
  /** How many invites a team sent one address (its limit key) on a UTC day: so one team can't use up the address's allowance. */
  invitesFromTeamToAddress: (teamId: string, emailHash: string, day: string) => ({
    PK: `TEAM#${id(teamId, "team ID")}`,
    SK: `LIMIT#INVITES#${date(day)}#${inviteLimitPartition(emailHash).slice(INVITE_LIMIT_PREFIX.length)}`,
  }),
  webhook: (eventId: string) => ({ PK: `WEBHOOK#${id(eventId, "webhook event ID")}`, SK: "DONE" }),
  /** A checkout, return or stock command's record, for replaying a retry (commands.ts). */
  operation: (teamId: string, operationId: string) => ({ PK: `TEAM#${id(teamId, "team ID")}`, SK: `OP#${id(operationId, "operation ID")}` }),
  /** A CSV inventory import's job record: its request, plan size and progress (imports.ts). */
  importJob: (teamId: string, importId: string) => ({ PK: `TEAM#${id(teamId, "team ID")}`, SK: `IMPORT#${id(importId, "import ID")}` }),
  /** One staged chunk of an import's plan: the rows one commit transaction applies. */
  importChunk: (teamId: string, importId: string, chunk: number) => ({
    PK: `TEAM#${id(teamId, "team ID")}`,
    SK: `IMPORT#${id(importId, "import ID")}#CHUNK#${importChunkNumber(chunk)}`,
  }),
  /** One change to a product's stock, in its history: newest last by `at` (ISO 8601), then operation. */
  movement: (teamId: string, key: string, at: string, operationId: string) => ({
    PK: `TEAM#${id(teamId, "team ID")}`,
    SK: `${movementPrefix(key)}${at}#${id(operationId, "operation ID")}`,
  }),
};

function importChunkNumber(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999) throw new InvalidInputError("Invalid import chunk");
  return String(n).padStart(3, "0");
}

/**
 * The sort-key prefix of one product's movements. A product key may contain
 * "#", so it's escaped ("%" to "%25", then "#" to "%23"): otherwise the
 * movements of "a" would share a prefix with those of "a#b".
 */
export function movementPrefix(key: string): string {
  return `MOVE#${productKey(key).replaceAll("%", "%25").replaceAll("#", "%23")}#`;
}

/** Sort-key prefixes for queries within a team's partition. */
export const prefixes = {
  member: "MEMBER#",
  invite: "INVITE#",
  product: "PRODUCT#",
  sheet: "SHEET#",
  audit: "AUDIT#",
  userTeam: "TEAM#",
};

/** GSI1 keys. */
export const gsi1 = {
  /** Sheets by date: one index partition per team, sorted by date then ID. */
  sheetsByDate: (teamId: string, sheetDate: string, sheetId: string) => ({
    GSI1PK: `TEAM#${id(teamId, "team ID")}#SHEETS`,
    GSI1SK: `${date(sheetDate)}#${id(sheetId, "sheet ID")}`,
  }),
  sheetsPartition: (teamId: string) => `TEAM#${id(teamId, "team ID")}#SHEETS`,
  inviteToken: (tokenHash: string) => ({ GSI1PK: `INVITE#${tokenHash}`, GSI1SK: "INVITE" }),
  /** A closed team's META item, in the partition the purge reads, by when it's due (ISO 8601). */
  closedTeam: (purgeAfter: string, teamId: string) => ({ GSI1PK: CLOSED_TEAMS_PARTITION, GSI1SK: `${purgeAfter}#${id(teamId, "team ID")}` }),
  /** An import job while it's committing: every team's in one index partition, oldest first. */
  importCommitting: (createdAt: string, importId: string) => ({
    GSI1PK: COMMITTING_IMPORTS_PARTITION,
    GSI1SK: `${createdAt}#${id(importId, "import ID")}`,
  }),
};

/** GSI2 keys: invites by the invitee's hashed email. */
export const gsi2 = {
  invitee: (emailHash: string, inviteId: string) => ({ GSI2PK: inviteePartition(emailHash), GSI2SK: `INVITE#${id(inviteId, "invite ID")}` }),
};

/** The GSI2 partition that holds the invites for one email address. */
export function inviteePartition(emailHash: string): string {
  if (typeof emailHash !== "string" || !HASH.test(emailHash)) throw new InvalidInputError("Invalid email hash");
  return `INVITEE#${emailHash}`;
}

/** The partition that counts the invites sent to one address (hashEmail), across teams. */
export function inviteLimitPartition(emailHash: string): string {
  if (typeof emailHash !== "string" || !HASH.test(emailHash)) throw new InvalidInputError("Invalid email hash");
  return `${INVITE_LIMIT_PREFIX}${emailHash}`;
}

/** The partition that holds everything a team owns. */
export function teamPartition(teamId: string): string {
  return `TEAM#${id(teamId, "team ID")}`;
}

/** Removes key and index attributes before an item leaves the data layer. */
export function strip<T>(item: Record<string, unknown> | undefined): T | undefined {
  if (!item) return undefined;
  const { PK: _pk, SK: _sk, GSI1PK: _gpk, GSI1SK: _gsk, GSI2PK: _g2pk, GSI2SK: _g2sk, ...rest } = item;
  void _pk; void _sk; void _gpk; void _gsk; void _g2pk; void _g2sk;
  return rest as T;
}
