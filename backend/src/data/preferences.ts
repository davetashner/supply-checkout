// A user's app preferences (supply-checkout-005.17), in their own
// `USER#<sub>` partition, so they follow the user across devices:
//
//   PK USER#<sub>  SK PREFERENCES  whatsNew           boolean: show the What's New banner (default on)
//                                  whatsNewLastShown  YYYY-MM-DD: the user's local date it was last shown
//                                  updatedAt          ISO time of the last change
//
// GET /me returns them and PATCH /me/preferences changes them, with the
// account function's session scoped to the caller's own partition (the
// account-access role's dynamodb:LeadingKeys), so a caller can only ever read
// or write their own. The app shows the banner at most once per local day: it
// records the day it showed it, and doesn't show it again while that's today.
//
// Every value is checked here before anything reaches DynamoDB (an unknown
// field, a non-boolean, a malformed or far-off date are InvalidInputError).
// IAM can't limit the sort key, so as defence in depth the key is checked to
// be PREFERENCES before any call, and each update's condition names it: it
// never creates or touches any other item.

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { InvalidInputError } from "./errors.js";
import { id, keys } from "./keys.js";
import { PK, PREFERENCES_SK, SK } from "./schema.js";

export interface Preferences {
  /** Show the What's New banner. On unless the user turned it off. */
  readonly whatsNew: boolean;
  /** The user's local date (YYYY-MM-DD) the banner was last shown, or null if never. */
  readonly whatsNewLastShown: string | null;
}

/** A change to make: either field or both, each already checked (preferencesChange). */
export interface PreferencesChange {
  whatsNew?: boolean;
  whatsNewLastShown?: string;
}

/** What a user who never changed anything gets. */
export const DEFAULT_PREFERENCES: Preferences = { whatsNew: true, whatsNewLastShown: null };

/** The fields PATCH /me/preferences accepts. */
export const PREFERENCE_FIELDS = ["whatsNew", "whatsNewLastShown"] as const;

/**
 * How far a local date may be from the server's UTC date, in days. Local
 * dates run from UTC−12 to UTC+14, so a day either way, and one more for a
 * device whose clock is a little off.
 */
export const LOCAL_DATE_SLACK_DAYS = 2;

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DAY_MS = 86_400_000;

/** A real calendar date (YYYY-MM-DD) within LOCAL_DATE_SLACK_DAYS of `now`'s UTC date, or InvalidInputError. */
export function localDate(value: unknown, now: Date): string {
  if (typeof value !== "string" || !DATE.test(value)) throw new InvalidInputError("whatsNewLastShown must be a date (YYYY-MM-DD)");
  const at = Date.parse(`${value}T00:00:00.000Z`);
  // 2026-02-30 parses, as 2026-03-02: only a date that comes back the same is real
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) throw new InvalidInputError("whatsNewLastShown must be a date (YYYY-MM-DD)");
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (Math.abs(at - today) > LOCAL_DATE_SLACK_DAYS * DAY_MS) throw new InvalidInputError("whatsNewLastShown must be today's date");
  return value;
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
  return {
    whatsNew: typeof item?.whatsNew === "boolean" ? item.whatsNew : DEFAULT_PREFERENCES.whatsNew,
    whatsNewLastShown: typeof shown === "string" && DATE.test(shown) ? shown : DEFAULT_PREFERENCES.whatsNewLastShown,
  };
}

/** The user's preferences, or the defaults if they never changed any. */
export async function getPreferences(db: Db, userId: string): Promise<Preferences> {
  const { Item } = await connection(db).doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: recordKey(userId),
      ProjectionExpression: "#whatsNew, #shown",
      ExpressionAttributeNames: { "#whatsNew": "whatsNew", "#shown": "whatsNewLastShown" },
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
  const { Attributes } = await connection(db).doc.send(
    new UpdateCommand({
      TableName: db.tableName,
      Key: recordKey(userId),
      UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: "attribute_not_exists(#pk) OR #sk = :sk",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    }),
  );
  return fromItem(Attributes);
}
