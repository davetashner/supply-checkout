// A user's app preferences (supply-checkout-005.17), in their own
// `USER#<sub>` partition, so they follow the user across devices:
//
//   PK USER#<sub>  SK PREFERENCES  whatsNew           boolean: show the What's New banner (default on)
//                                  whatsNewLastShown  YYYY-MM-DD: the user's local date it was last shown
//                                  newFeatures        map of feature ID to { days, last }: the "New" callouts (supply-checkout-ihhe).
//                                                     days (0 to 3) is how many local days the callout was shown, last the
//                                                     local date (YYYY-MM-DD) of the latest. Absent until one is shown
//                                  language           "en" or "es" (LANGUAGES): the language the user chose, absent
//                                                     until they choose one (the app then uses the device's)
//                                  updatedAt          ISO time of the last change
//
// GET /me returns them and PATCH /me/preferences changes them, with the
// account function's session scoped to the caller's own partition (the
// account-access role's dynamodb:LeadingKeys), so a caller can only ever read
// or write their own. The app shows the banner at most once per local day: it
// records the day it showed it, and doesn't show it again while that's today.
//
// Every value is checked here before anything reaches DynamoDB (an unknown
// field, a non-boolean, a malformed or far-off date, a language that isn't
// one of LANGUAGES are InvalidInputError).
// IAM can't limit the sort key, so as defence in depth the key is checked to
// be PREFERENCES before any call, and each update's condition names it: it
// never creates or touches any other item.
//
// An access token outlives the account it was issued for (until it expires),
// so a write checks the account's DELETING mark in the same transaction, as
// recordNoticeAddress and claimWelcome do: an account being deleted, or
// deleted, never gets this row back (ConflictError, 409 `aborted`).

import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { ConflictError, InvalidInputError } from "./errors.js";
import { id, keys } from "./keys.js";
import { PK, PREFERENCES_SK, SK } from "./schema.js";

export interface Preferences {
  /** Show the What's New banner. On unless the user turned it off. */
  readonly whatsNew: boolean;
  /** The user's local date (YYYY-MM-DD) the banner was last shown, or null if never. */
  readonly whatsNewLastShown: string | null;
  /** The language the user chose (the app's and, later, their emails'), or null if they never chose one. */
  readonly language: Language | null;
  /** The "New" callouts shown so far, by feature ID: empty until one is shown. */
  readonly newFeatures: NewFeatures;
}

/** How many local days a feature's "New" callout shows for one person. */
export const NEW_FEATURE_DAYS = 3;
/** Most features tracked at once: the app prunes retired ones, so this is far above what it ever sends. */
export const MAX_NEW_FEATURES = 20;
/** A feature ID: lowercase words joined by hyphens. No underscores, so no `__proto__` and the like. */
const FEATURE_ID = /^[a-z][a-z0-9-]{0,39}$/;

/** One feature's callout state: days shown (0 to NEW_FEATURE_DAYS) and the local date of the latest. */
export interface NewFeatureState {
  readonly days: number;
  readonly last: string;
}
export type NewFeatures = Readonly<Record<string, NewFeatureState>>;

/** The languages the app has: the same codes as OFFERED in src/i18n.js. */
export const LANGUAGES = ["en", "es"] as const;
export type Language = (typeof LANGUAGES)[number];

/** A change to make: either field or both, each already checked (preferencesChange). */
export interface PreferencesChange {
  whatsNew?: boolean;
  whatsNewLastShown?: string;
  language?: Language;
  newFeatures?: NewFeatures;
}

/** What a user who never changed anything gets. */
export const DEFAULT_PREFERENCES: Preferences = { whatsNew: true, whatsNewLastShown: null, language: null, newFeatures: {} };

/** The fields PATCH /me/preferences accepts. */
export const PREFERENCE_FIELDS = ["whatsNew", "whatsNewLastShown", "language", "newFeatures"] as const;

/**
 * How far a local date may be from the server's UTC date, in days. Local
 * dates run from UTC−12 to UTC+14, so a day either way, and one more for a
 * device whose clock is a little off.
 */
export const LOCAL_DATE_SLACK_DAYS = 2;

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DAY_MS = 86_400_000;

/** A real calendar date (YYYY-MM-DD) within LOCAL_DATE_SLACK_DAYS of `now`'s UTC date, or InvalidInputError. */
export function localDate(value: unknown, now: Date, field = "whatsNewLastShown"): string {
  if (typeof value !== "string" || !DATE.test(value)) throw new InvalidInputError(`${field} must be a date (YYYY-MM-DD)`);
  const at = Date.parse(`${value}T00:00:00.000Z`);
  // 2026-02-30 parses, as 2026-03-02: only a date that comes back the same is real
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) throw new InvalidInputError(`${field} must be a date (YYYY-MM-DD)`);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (Math.abs(at - today) > LOCAL_DATE_SLACK_DAYS * DAY_MS) throw new InvalidInputError(`${field} must be today's date`);
  return value;
}

/** A real calendar date (YYYY-MM-DD) that isn't past tomorrow's local date (an earlier one is fine), or InvalidInputError. */
function pastLocalDate(value: unknown, now: Date, field: string): string {
  if (typeof value !== "string" || !DATE.test(value)) throw new InvalidInputError(`${field} must be a date (YYYY-MM-DD)`);
  const at = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) throw new InvalidInputError(`${field} must be a date (YYYY-MM-DD)`);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (at - today > LOCAL_DATE_SLACK_DAYS * DAY_MS) throw new InvalidInputError(`${field} can't be in the future`);
  return value;
}

/**
 * The "New" callouts' state from a request, checked: a plain object of at most MAX_NEW_FEATURES
 * entries, each key a feature ID (FEATURE_ID) and each value exactly { days, last } with days a whole
 * number from 0 to NEW_FEATURE_DAYS and last a real date, not in the future. The IDs aren't a list
 * kept here (that would need a backend deploy for every feature the app marks): the pattern and the
 * cap bound what a caller can store, and the whole map is one attribute's value, so no key becomes
 * an attribute name or part of an expression. Earlier dates are allowed because the app sends the
 * whole map back, with the features it showed on earlier days unchanged.
 */
export function newFeaturesValue(value: unknown, now: Date): NewFeatures {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidInputError("newFeatures must be an object");
  const entries = Object.entries(value);
  if (entries.length > MAX_NEW_FEATURES) throw new InvalidInputError(`newFeatures can have at most ${MAX_NEW_FEATURES} features`);
  const out: Record<string, NewFeatureState> = {};
  for (const [feature, state] of entries) {
    if (!FEATURE_ID.test(feature)) throw new InvalidInputError("newFeatures has a feature ID that isn't lowercase words joined by hyphens");
    if (typeof state !== "object" || state === null || Array.isArray(state)) throw new InvalidInputError("Each feature in newFeatures must be an object");
    const { days, last, ...rest } = state as Record<string, unknown>;
    if (Object.keys(rest).length) throw new InvalidInputError("Each feature in newFeatures has only days and last");
    if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > NEW_FEATURE_DAYS) throw new InvalidInputError(`days must be a whole number from 0 to ${NEW_FEATURE_DAYS}`);
    out[feature] = { days, last: pastLocalDate(last, now, "last") };
  }
  return out;
}

/** One of LANGUAGES, or InvalidInputError. */
export function languageCode(value: unknown): Language {
  if (typeof value !== "string" || !(LANGUAGES as readonly string[]).includes(value)) throw new InvalidInputError(`language must be one of ${LANGUAGES.join(", ")}`);
  return value as Language;
}

/** A change from a request body (already limited to PREFERENCE_FIELDS), checked: at least one field, each of the right type. */
export function preferencesChange(body: Record<string, unknown>, now: Date): PreferencesChange {
  const change: PreferencesChange = {};
  for (const field of Object.keys(body)) {
    if (!(PREFERENCE_FIELDS as readonly string[]).includes(field)) throw new InvalidInputError(`Unexpected field "${field}"`);
  }
  if (body.whatsNew !== undefined) {
    if (typeof body.whatsNew !== "boolean") throw new InvalidInputError("whatsNew must be true or false");
    change.whatsNew = body.whatsNew;
  }
  if (body.whatsNewLastShown !== undefined) change.whatsNewLastShown = localDate(body.whatsNewLastShown, now);
  if (body.language !== undefined) change.language = languageCode(body.language);
  if (body.newFeatures !== undefined) change.newFeatures = newFeaturesValue(body.newFeatures, now);
  if (Object.keys(change).length === 0) throw new InvalidInputError("Nothing to change");
  return change;
}

/** The record's key, checked to be PREFERENCES in the user's own partition. */
function recordKey(userId: string) {
  const key = keys.preferences(id(userId, "user ID"));
  if (key.SK !== PREFERENCES_SK || key.PK !== `USER#${userId}`) throw new Error("Not the preferences record");
  return key;
}

/** What's stored, read defensively: anything not the right type counts as the default. */
function fromItem(item: Record<string, unknown> | undefined): Preferences {
  const shown = item?.whatsNewLastShown;
  const language = item?.language;
  const stored = item?.newFeatures;
  const newFeatures: Record<string, NewFeatureState> = {};
  // Anything that isn't a valid entry is dropped, as the rest fall back to their defaults
  if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
    for (const [feature, state] of Object.entries(stored).slice(0, MAX_NEW_FEATURES)) {
      const s = state as { days?: unknown; last?: unknown } | null;
      if (FEATURE_ID.test(feature) && s && typeof s.days === "number" && Number.isInteger(s.days) && s.days >= 0 && s.days <= NEW_FEATURE_DAYS && typeof s.last === "string" && DATE.test(s.last)) newFeatures[feature] = { days: s.days, last: s.last };
    }
  }
  return {
    whatsNew: typeof item?.whatsNew === "boolean" ? item.whatsNew : DEFAULT_PREFERENCES.whatsNew,
    whatsNewLastShown: typeof shown === "string" && DATE.test(shown) ? shown : DEFAULT_PREFERENCES.whatsNewLastShown,
    language: typeof language === "string" && (LANGUAGES as readonly string[]).includes(language) ? (language as Language) : DEFAULT_PREFERENCES.language,
    newFeatures,
  };
}

/** The user's preferences, or the defaults if they never changed any. */
export async function getPreferences(db: Db, userId: string): Promise<Preferences> {
  const { Item } = await connection(db).doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: recordKey(userId),
      ProjectionExpression: "#whatsNew, #shown, #language, #newFeatures",
      ExpressionAttributeNames: { "#whatsNew": "whatsNew", "#shown": "whatsNewLastShown", "#language": "language", "#newFeatures": "newFeatures" },
      ConsistentRead: true,
    }),
  );
  return fromItem(Item);
}

/** Applies a checked change (preferencesChange) and returns the preferences after it. */
export async function setPreferences(db: Db, userId: string, change: PreferencesChange, now = new Date()): Promise<Preferences> {
  const names: Record<string, string> = { "#pk": PK, "#sk": SK, "#at": "updatedAt", "#type": "type" };
  const values: Record<string, unknown> = { ":sk": PREFERENCES_SK, ":at": now.toISOString(), ":type": "preferences" };
  const sets = ["#at = :at", "#type = :type"];
  if (change.whatsNew !== undefined) {
    if (typeof change.whatsNew !== "boolean") throw new InvalidInputError("whatsNew must be true or false");
    names["#whatsNew"] = "whatsNew";
    values[":whatsNew"] = change.whatsNew;
    sets.push("#whatsNew = :whatsNew");
  }
  if (change.whatsNewLastShown !== undefined) {
    names["#shown"] = "whatsNewLastShown";
    values[":shown"] = localDate(change.whatsNewLastShown, now);
    sets.push("#shown = :shown");
  }
  if (change.language !== undefined) {
    names["#language"] = "language";
    values[":language"] = languageCode(change.language);
    sets.push("#language = :language");
  }
  if (change.newFeatures !== undefined) {
    names["#newFeatures"] = "newFeatures";
    values[":newFeatures"] = newFeaturesValue(change.newFeatures, now);
    sets.push("#newFeatures = :newFeatures");
  }
  const user = id(userId, "user ID");
  try {
    await connection(db).doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: db.tableName,
              Key: recordKey(user),
              UpdateExpression: `SET ${sets.join(", ")}`,
              ConditionExpression: "attribute_not_exists(#pk) OR #sk = :sk",
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            },
          },
          // Not for an account being deleted: its rows are going, and its token may still work
          { ConditionCheck: { TableName: db.tableName, Key: keys.accountDeletion(user), ConditionExpression: "attribute_not_exists(PK)" } },
        ],
      }),
    );
  } catch (error) {
    const cancelled = error as { name?: string; CancellationReasons?: { Code?: string }[] } | null;
    const deleting = cancelled?.name === "TransactionCanceledException" && (cancelled.CancellationReasons ?? [])[1]?.Code === "ConditionalCheckFailed";
    if (deleting) throw new ConflictError("Your account is being deleted");
    throw error;
  }
  return getPreferences(db, user);
}
