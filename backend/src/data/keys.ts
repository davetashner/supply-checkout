// Key builders for every entity in ADR 0005. Nothing else builds key strings,
// and each builder validates its parts so a caller-supplied ID can't reach
// into another key (for example, a project ID containing "#").

import { InvalidInputError } from "./errors.js";
import { CLOSED_TEAMS_PARTITION, COMMITTING_IMPORTS_PARTITION, EMAIL_CODE_SENT_SK, INVITE_LIMIT_PREFIX, LAPSE_PREFIX, NOTICE_ADDRESS_SK, RECEIPT_RATE_PREFIX, NOTICE_SENT_PREFIX, OPERATOR_AUDIT_PREFIX, OPS_AUDIT_INDEX_PREFIX, OPS_OWNERS_PREFIX, OPS_TEAMS_PARTITION, TOTP_ON_SK, VERIFIED_EMAIL_SK, WELCOME_SK } from "./schema.js";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const HASH = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A time as toISOString() writes it (`2026-10-02T12:00:00.000Z`), for a key. */
function isoInstant(value: unknown): string {
  if (typeof value !== "string" || !INSTANT.test(value) || new Date(value).toISOString() !== value) throw new InvalidInputError("Invalid time");
  return value;
}

/** Team, user, project, invite, Stripe customer and event IDs: letters, digits, _ and -. */
export function id(value: unknown, what: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new InvalidInputError(`Invalid ${what}`);
  return value;
}

/**
 * Product keys come from the app (a barcode or a generated key), so they allow
 * more. Not "__proto__": a product key is also a field name in a project's
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

/**
 * The suffix of a project line for company equipment bought for the client
 * (ADR 0017, section 2a): `<productKey>:bought`. Only the receipt's lines
 * command (addLines) makes such a line, and no new product may have a key
 * ending in it.
 */
export const BOUGHT_SUFFIX = ":bought";

/** A General Use project's ID: `adhoc-<n>`, n from 1 (ADR 0017, section 4). */
const ADHOC_ID = /^adhoc-([1-9][0-9]{0,8})$/;

/** The ID of the team's `n`th General Use project. */
export function adhocProjectId(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 999_999_999) throw new InvalidInputError("Invalid General Use project number");
  return `adhoc-${n}`;
}

/** The number of a General Use project's ID (`adhoc-3` is 3), or undefined for any other ID. */
export function adhocNumber(projectId: string): number | undefined {
  const match = ADHOC_ID.exec(projectId);
  return match ? Number(match[1]) : undefined;
}

/** True for an ID the General Use projects use (`adhoc-<anything>`): no document write may create one. */
export const isAdhocId = (projectId: string): boolean => projectId.startsWith("adhoc-");

/** The longest barcode: the same bound as a product key, which the app makes from the barcode. */
export const MAX_CODE_LENGTH = 256;

/** A barcode (a product's or a project line's `code`): a string, empty for an item without one. */
export function barcode(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_CODE_LENGTH) throw new InvalidInputError("Invalid barcode");
  return value;
}

/**
 * A date's form only, YYYY-MM-DD: what the date index sorts by, and the
 * bounds of a date range. Lets through dates that don't exist (2026-02-30),
 * so a project stored with one keeps its place in the index.
 */
export function dateFormat(value: unknown): string {
  if (typeof value !== "string" || !DATE.test(value)) throw new InvalidInputError("Invalid date");
  return value;
}

/** The first year a date may have: earlier is a typo (0026 for 2026). */
export const MIN_DATE_YEAR = 2000;

/**
 * A date someone sends, YYYY-MM-DD, as the app stores it: one that exists
 * (2026-02-30 doesn't), from MIN_DATE_YEAR on. Checked by reading it back
 * through a UTC Date. Only values a write sets are checked with it: a stored
 * value carried over unchanged isn't (reorder.ts), and the date index takes
 * any dateFormat.
 */
export function date(value: unknown): string {
  const day = dateFormat(value);
  if (Number(day.slice(0, 4)) < MIN_DATE_YEAR || !isCalendarDay(day)) throw new InvalidInputError("Invalid date");
  return day;
}

/**
 * True when a well-formed YYYY-MM-DD day exists on the calendar (whatever its
 * year): it reads back the same through a UTC Date. An engine that can't
 * parse it gives an invalid Date, which is false, never a thrown RangeError.
 */
export function isCalendarDay(day: string): boolean {
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

/** A rate window's UTC stamp: the ISO time cut to the minute, hour or day. */
const RATE_STAMP = { MINUTE: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, HOUR: /^\d{4}-\d{2}-\d{2}T\d{2}$/, DAY: /^\d{4}-\d{2}-\d{2}$/, TRIALDAY: /^\d{4}-\d{2}-\d{2}$/ } as const;

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
  /**
   * The team's latest invite to one address (hashEmail): `inviteId` names it.
   * createInvite and resendInvite write it in the invite's transaction, on the
   * condition that it's absent or still names the invite they found (gone or
   * expired, for a new one; the one being replaced, for a re-send), so two
   * creates at once can't both leave a live invite. Nothing else deletes it:
   * one naming an invite that's gone is stale, and the next invite replaces
   * it. It expires with its invite (TTL).
   */
  inviteGuard: (teamId: string, emailHash: string) => ({
    PK: `TEAM#${id(teamId, "team ID")}`,
    SK: `INVITEGUARD#${inviteLimitPartition(emailHash).slice(INVITE_LIMIT_PREFIX.length)}`,
  }),
  product: (teamId: string, key: string) => ({ PK: `TEAM#${id(teamId, "team ID")}`, SK: `PRODUCT#${productKey(key)}` }),
  /** A project: where new ones are written, and where the rename's backfill moves old ones (legacy-sheets.ts has the old key). */
  project: (teamId: string, projectId: string) => ({
    PK: `TEAM#${id(teamId, "team ID")}`,
    SK: `PROJECT#${id(projectId, "project ID")}`,
  }),
  usage: (teamId: string, m: string) => ({ PK: `TEAM#${id(teamId, "team ID")}`, SK: `USAGE#${month(m)}` }),
  /** Receipts a team read while it wasn't paying: its trial's allowance, counted once for the whole trial (supply-checkout-wxx). */
  trialUsage: (teamId: string) => ({ PK: `TEAM#${id(teamId, "team ID")}`, SK: "USAGE#TRIAL" }),
  /**
   * Receipts one user read in one window (a UTC minute, hour or day), from
   * every team they're in: the per-user rate limit (supply-checkout-wxx).
   * `TRIALDAY` counts only their reads for trial teams, per UTC day.
   * Expires (TTL) a day after its window ends.
   */
  receiptRate: (userId: string, window: "MINUTE" | "HOUR" | "DAY" | "TRIALDAY", stamp: string) => {
    if (!RATE_STAMP[window].test(stamp)) throw new InvalidInputError("Invalid rate window");
    return { PK: `${RECEIPT_RATE_PREFIX}${id(userId, "user ID")}`, SK: `RECEIPTS#${window}#${stamp}` };
  },
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
  /** The address the user last proved with a Cognito code (verified-email.ts). */
  verifiedEmail: (userId: string) => ({ PK: `USER#${id(userId, "user ID")}`, SK: VERIFIED_EMAIL_SK }),
  /** The address the user's last verification code was sent to (verified-email.ts). */
  emailCodeSent: (userId: string) => ({ PK: `USER#${id(userId, "user ID")}`, SK: EMAIL_CODE_SENT_SK }),
  /** When a security notice of one kind last went to the user (security-notices.ts). */
  noticeSent: (userId: string, kind: string) => ({ PK: `USER#${id(userId, "user ID")}`, SK: `${NOTICE_SENT_PREFIX}${id(kind, "notice kind")}` }),
  /** The verified address the user's account had, for telling it of an email change (security-notices.ts). */
  noticeAddress: (userId: string) => ({ PK: `USER#${id(userId, "user ID")}`, SK: NOTICE_ADDRESS_SK }),
  /** When two-step sign-in was last turned on for the user (two-step.ts). */
  totpOn: (userId: string) => ({ PK: `USER#${id(userId, "user ID")}`, SK: TOTP_ON_SK }),
  /** That the account was sent its welcome email, or is being sent it (welcome.ts, supply-checkout-6uw.25). */
  welcome: (userId: string) => ({ PK: `USER#${id(userId, "user ID")}`, SK: WELCOME_SK }),
  /** How many times a team was reopened on a UTC day: the per-team reopen limit (reopenTeam). */
  reopens: (teamId: string, day: string) => ({ PK: `TEAM#${id(teamId, "team ID")}`, SK: `LIMIT#REOPENS#${date(day)}` }),
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
  /**
   * How many invites one user sent one address (its limit key) on a UTC day,
   * from all the teams they own: so one account owning many teams can't use
   * up the address's allowance either.
   */
  invitesFromUserToAddress: (userId: string, emailHash: string, day: string) => ({
    PK: `USER#${id(userId, "user ID")}`,
    SK: `LIMIT#INVITES#${date(day)}#${inviteLimitPartition(emailHash).slice(INVITE_LIMIT_PREFIX.length)}`,
  }),
  webhook: (eventId: string) => ({ PK: `WEBHOOK#${id(eventId, "webhook event ID")}`, SK: "DONE" }),
  /** That an owner was emailed about a Stripe event (claimBillingNotice), so a retry doesn't email them again. */
  webhookNotice: (eventId: string, userId: string) => ({ PK: `WEBHOOK#${id(eventId, "webhook event ID")}`, SK: `NOTICE#${id(userId, "user ID")}` }),
  /** The lapsed-team job's record that it emailed one owner one notice, for one date (`anchor`, ISO 8601: the trial's end, the grace's end or the deletion date). */
  lapseNotice: (teamId: string, kind: string, anchor: string, userId: string) => ({
    PK: `${LAPSE_PREFIX}${id(teamId, "team ID")}`,
    SK: `NOTICE#${id(kind, "notice kind")}#${isoInstant(anchor)}#${id(userId, "user ID")}`,
  }),
  /** The lapsed-team job's record of when it warned a team's owners of its deletion on `deleteAfter`. */
  /** The lapsed-team job's lease: one run at a time (claimLapseRun). `RUN` is no team ID (those are UUIDs), and its sort key no record of a team's. */
  lapseRun: () => ({ PK: `${LAPSE_PREFIX}RUN`, SK: "LEASE" }),
  lapseWarned: (teamId: string, deleteAfter: string) => ({ PK: `${LAPSE_PREFIX}${id(teamId, "team ID")}`, SK: `WARNED#${isoInstant(deleteAfter)}` }),
  /** The team's settings (ADR 0017, section 2a): owners write it; only owners read its markup. */
  settings: (teamId: string) => ({ PK: `TEAM#${id(teamId, "team ID")}`, SK: "SETTINGS" }),
  /**
   * The team's General Use projects (ADR 0017, section 4): `count`, how many it has
   * made (the last is `adhoc-<count>`), and `open`, the ID of the one that's
   * open, if any. The quick take reads it and, in the transaction that takes,
   * adds to the open project or makes the next one, on the condition that its
   * `version` is still the one read. Closing, reopening and deleting an ad hoc
   * project update it in the project write's transaction (documents.ts).
   */
  adhoc: (teamId: string) => ({ PK: `TEAM#${id(teamId, "team ID")}`, SK: "ADHOC" }),
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
  project: "PROJECT#",
  audit: "AUDIT#",
  userTeam: "TEAM#",
};

/** GSI1 keys. */
export const gsi1 = {
  /** Projects by date: one index partition per team, sorted by date then ID (projectAttributes in project-items.ts builds the sort key). */
  projectsPartition: (teamId: string) => `TEAM#${id(teamId, "team ID")}#PROJECTS`,
  inviteToken: (tokenHash: string) => ({ GSI1PK: `INVITE#${tokenHash}`, GSI1SK: "INVITE" }),
  /** A closed team's META item, in the partition the purge reads, by when it's due (ISO 8601). */
  closedTeam: (purgeAfter: string, teamId: string) => ({ GSI1PK: CLOSED_TEAMS_PARTITION, GSI1SK: `${purgeAfter}#${id(teamId, "team ID")}` }),
  /** An import job while it's committing: every team's in one index partition, oldest first. */
  importCommitting: (createdAt: string, importId: string) => ({
    GSI1PK: COMMITTING_IMPORTS_PARTITION,
    GSI1SK: `${createdAt}#${id(importId, "import ID")}`,
  }),
};

/** GSI3 keys: the operators' index (ADR 0015; schema.ts). */
export const gsi3 = {
  /** On a team's META item: every team in one index partition, keyed by team ID so one team is a direct lookup. */
  team: (teamId: string) => ({ GSI3PK: OPS_TEAMS_PARTITION, GSI3SK: id(teamId, "team ID") }),
  /** On an owner's MEMBER item, while they're an owner. */
  owner: (teamId: string, userId: string) => ({ GSI3PK: opsOwnersPartition(teamId), GSI3SK: id(userId, "user ID") }),
  /** On an operator audit item: the audit by month. */
  audit: (ts: string, eventId: string) => ({ GSI3PK: opsAuditIndexPartition(ts.slice(0, 7)), GSI3SK: `${ts}#${id(eventId, "event ID")}` }),
};

/** The GSI3 partition of a team's owners. */
export function opsOwnersPartition(teamId: string): string {
  return `${OPS_OWNERS_PREFIX}${id(teamId, "team ID")}`;
}

/** The GSI3 partition of a month's operator audit. */
export function opsAuditIndexPartition(yearMonth: string): string {
  return `${OPS_AUDIT_INDEX_PREFIX}${month(yearMonth)}`;
}

/** The operator audit partition of a team, or of the platform (`PLATFORM`, for campaigns). */
export function operatorAuditPartition(teamId: string): string {
  return `${OPERATOR_AUDIT_PREFIX}${id(teamId, "team ID")}`;
}

/** Operator audit items and idempotency records (ADR 0015). */
export const operatorKeys = {
  /** One operator action, newest last by time. */
  audit: (teamId: string, ts: string, eventId: string) => ({ PK: operatorAuditPartition(teamId), SK: `AUDIT#${ts}#${id(eventId, "event ID")}` }),
  /** A write's Idempotency-Key, so a retry replays rather than acting twice. */
  request: (teamId: string, keyHash: string) => {
    if (!HASH.test(keyHash)) throw new InvalidInputError("Invalid idempotency key");
    return { PK: operatorAuditPartition(teamId), SK: `REQUEST#${keyHash}` };
  },
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
  const { PK: _pk, SK: _sk, GSI1PK: _gpk, GSI1SK: _gsk, GSI2PK: _g2pk, GSI2SK: _g2sk, GSI3PK: _g3pk, GSI3SK: _g3sk, ...rest } = item;
  void _pk; void _sk; void _gpk; void _gsk; void _g2pk; void _g2sk; void _g3pk; void _g3sk;
  return rest as T;
}
