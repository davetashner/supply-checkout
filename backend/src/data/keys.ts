// Key builders for every entity in ADR 0005. Nothing else builds key strings,
// and each builder validates its parts so a caller-supplied ID can't reach
// into another key (for example, a sheet ID containing "#").

import { InvalidInputError } from "./errors.js";

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

/** Product keys come from the app (a barcode or a generated key), so they allow more. */
export function productKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || CONTROL.test(value)) {
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
  /** How many teams the user created on a UTC day (YYYY-MM-DD): the per-user rate limit. */
  teamsCreated: (userId: string, day: string) => ({ PK: `USER#${id(userId, "user ID")}`, SK: `LIMIT#TEAMS#${date(day)}` }),
  webhook: (eventId: string) => ({ PK: `WEBHOOK#${id(eventId, "webhook event ID")}`, SK: "DONE" }),
};

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
