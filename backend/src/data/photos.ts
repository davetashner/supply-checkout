// A user's profile photo record (supply-checkout-6uw.30), in their own
// `USER#<sub>` partition:
//
//   PK USER#<sub>  SK PHOTO              photoId    the current photo's ID (absent: none)
//                                        orphans    IDs whose objects may still be in the
//                                                   bucket and are to be deleted
//                                        version    bumped by every write; each write is
//                                                   conditioned on the one it read
//   PK USER#<sub>  SK LIMIT#PHOTOS#<day> count      uploads that UTC day (PHOTO_UPLOADS_PER_USER_PER_DAY)
//
// and a copy of `photoId` on the user's MEMBER item in each team they're in
// (setOwnMemberPhoto), which is what GET /teams/{teamId}/photos reads: a
// member's teammates can't read their USER# partition (the account-access
// role's dynamodb:LeadingKeys), and a removed member's MEMBER item is gone,
// so their photo is too.
//
// Every object the API ever writes is named here before it's written
// (stagePhoto adds it to `orphans`), so none can be left behind unknown:
// committing it moves it to `photoId` and the photo it replaces to
// `orphans`; removing it moves it to `orphans`; and the API deletes the
// orphans' objects, then takes them off (clearOrphans). Deleting an account
// deletes every object the record names before the record goes.
//
// Writes check the account's DELETING mark in the same transaction, as
// setPreferences does: an account being deleted gets no new photo.

import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { ConflictError, LimitReachedError } from "./errors.js";
import { id, keys } from "./keys.js";
import { PHOTO_SK } from "./schema.js";
import { type TeamContext, writable } from "./team-context.js";

/** Profile photos one user may upload per UTC day. */
export const PHOTO_UPLOADS_PER_USER_PER_DAY = 20;

/** The most orphans a record may hold before an upload must clear them first. */
export const MAX_PHOTO_ORPHANS = 5;

/** A photo ID: 128 random bits as hex (photos/names.ts PHOTO_ID). */
const PHOTO_ID = /^[0-9a-f]{32}$/;
const DAY_SECONDS = 24 * 60 * 60;

/** The photo uploads limit, as the API answers it (429 `photo_limit`). */
export class PhotoLimitError extends LimitReachedError {
  override readonly name = "PhotoLimitError";
}

export interface PhotoRecord {
  readonly photoId?: string;
  readonly orphans: readonly string[];
  /** 0 when there's no record. */
  readonly version: number;
}

/** A photo ID, or a throw: only these ever reach a key or a record. */
export function photoId(value: unknown): string {
  if (typeof value !== "string" || !PHOTO_ID.test(value)) throw new Error("Invalid photo ID");
  return value;
}

/** A stored photo ID read defensively: anything else counts as none. */
export const storedPhotoId = (value: unknown): string | undefined => (typeof value === "string" && PHOTO_ID.test(value) ? value : undefined);

function recordKey(userId: string) {
  const key = keys.photo(id(userId, "user ID"));
  if (key.SK !== PHOTO_SK || key.PK !== `USER#${userId}`) throw new Error("Not the photo record");
  return key;
}

/** The user's photo record, read consistently; anything malformed in it is left out. */
export async function getPhotoRecord(db: Db, userId: string): Promise<PhotoRecord> {
  const { Item } = await connection(db).doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: recordKey(userId),
      ProjectionExpression: "#photo, #orphans, #version",
      ExpressionAttributeNames: { "#photo": "photoId", "#orphans": "orphans", "#version": "version" },
      ConsistentRead: true,
    }),
  );
  const orphans = Array.isArray(Item?.orphans) ? (Item.orphans as unknown[]).map(storedPhotoId).filter((o): o is string => o !== undefined) : [];
  const photo = storedPhotoId(Item?.photoId);
  return { ...(photo ? { photoId: photo } : {}), orphans, version: typeof Item?.version === "number" ? Item.version : 0 };
}

/** Every photo ID the record names: its objects may be in the bucket. */
export const photoIdsOf = (record: PhotoRecord): string[] => [...new Set([...(record.photoId ? [record.photoId] : []), ...record.orphans])];

const accountDeleting = (userId: string, tableName: string) => ({ ConditionCheck: { TableName: tableName, Key: keys.accountDeletion(userId), ConditionExpression: "attribute_not_exists(PK)" } });

/**
 * Writes the record as `next`, if it's still at `from.version`, with the
 * DELETING check (and any `extra` transaction items before it). Throws
 * ConflictError when the record changed meanwhile or the account is being
 * deleted; returns the record written.
 */
async function writeRecord(db: Db, userId: string, from: PhotoRecord, next: Omit<PhotoRecord, "version">, now: Date, extra: Record<string, unknown>[] = []): Promise<PhotoRecord> {
  const user = id(userId, "user ID");
  const version = from.version + 1;
  const names: Record<string, string> = { "#type": "type", "#orphans": "orphans", "#version": "version", "#at": "updatedAt", "#photo": "photoId" };
  const values: Record<string, unknown> = { ":type": "photo", ":orphans": next.orphans.map(photoId), ":version": version, ":at": now.toISOString() };
  let update = "SET #type = :type, #orphans = :orphans, #version = :version, #at = :at";
  if (next.photoId) {
    values[":photo"] = photoId(next.photoId);
    update += ", #photo = :photo";
  } else {
    update += " REMOVE #photo";
  }
  // The version it read, or no record at all
  const condition = from.version === 0 ? "attribute_not_exists(#version)" : "#version = :from";
  if (from.version !== 0) values[":from"] = from.version;
  const items = [
    ...extra,
    { Update: { TableName: db.tableName, Key: recordKey(user), UpdateExpression: update, ConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values } },
    accountDeleting(user, db.tableName),
  ];
  try {
    await connection(db).doc.send(new TransactWriteCommand({ TransactItems: items as never }));
  } catch (error) {
    const cancelled = error as { name?: string; CancellationReasons?: { Code?: string }[] } | null;
    if (cancelled?.name !== "TransactionCanceledException") throw error;
    const reasons = (cancelled.CancellationReasons ?? []).map((r) => r?.Code);
    if (extra.length && reasons[0] === "ConditionalCheckFailed") throw new PhotoLimitError(`You can upload up to ${PHOTO_UPLOADS_PER_USER_PER_DAY} photos a day; try again tomorrow`);
    if (reasons[items.length - 1] === "ConditionalCheckFailed") throw new ConflictError("Your account is being deleted");
    if (reasons[items.length - 2] === "ConditionalCheckFailed") throw new ConflictError("Your photo changed just now; try again");
    throw error;
  }
  return { ...next, version };
}

/**
 * Counts an upload against today's limit and names `newId` in the record as
 * an orphan, before its object is written. PhotoLimitError at the limit,
 * ConflictError if the record changed or the account is being deleted.
 */
export async function stagePhoto(db: Db, userId: string, from: PhotoRecord, newId: string, now = new Date()): Promise<PhotoRecord> {
  const user = id(userId, "user ID");
  photoId(newId);
  if (from.orphans.length >= MAX_PHOTO_ORPHANS) throw new ConflictError("Your earlier photos are still being removed; try again");
  const epoch = Math.floor(now.getTime() / 1000);
  const counter = {
    Update: {
      TableName: db.tableName,
      Key: keys.photoUploads(user, now.toISOString().slice(0, 10)),
      UpdateExpression: "ADD #count :one SET #type = :type, expiresAt = :expires",
      ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
      ExpressionAttributeNames: { "#count": "count", "#type": "type" },
      ExpressionAttributeValues: { ":one": 1, ":max": PHOTO_UPLOADS_PER_USER_PER_DAY, ":type": "photoUploads", ":expires": epoch + 2 * DAY_SECONDS },
    },
  };
  return writeRecord(db, user, from, { ...(from.photoId ? { photoId: from.photoId } : {}), orphans: [...from.orphans, newId] }, now, [counter]);
}

/** Makes the staged `newId` the current photo; the one it replaces becomes an orphan. */
export function commitPhoto(db: Db, userId: string, from: PhotoRecord, newId: string, now = new Date()): Promise<PhotoRecord> {
  photoId(newId);
  if (!from.orphans.includes(newId)) throw new Error("That photo wasn't staged");
  const orphans = [...from.orphans.filter((o) => o !== newId), ...(from.photoId && from.photoId !== newId ? [from.photoId] : [])];
  return writeRecord(db, userId, from, { photoId: newId, orphans }, now);
}

/** Takes the current photo away: it becomes an orphan, for its object to be deleted. */
export function removePhoto(db: Db, userId: string, from: PhotoRecord, now = new Date()): Promise<PhotoRecord> {
  return writeRecord(db, userId, from, { orphans: photoIdsOf(from) }, now);
}

/** Takes `deleted` (orphans whose objects are gone) off the record. */
export function clearOrphans(db: Db, userId: string, from: PhotoRecord, deleted: readonly string[], now = new Date()): Promise<PhotoRecord> {
  const gone = new Set(deleted);
  return writeRecord(db, userId, from, { ...(from.photoId ? { photoId: from.photoId } : {}), orphans: from.orphans.filter((o) => !gone.has(o)) }, now);
}

/**
 * Sets the photo ID on the caller's own MEMBER item (or removes it, for
 * undefined), when it differs: what the team's /photos route reads. Like
 * setOwnMemberName: always the context's own user, any role, never recreates
 * a membership. True when it wrote. A closed team's too, unlike the name and
 * email: its /photos must never name a photo that was replaced or removed.
 */
export async function setOwnMemberPhoto(db: Db, ctx: TeamContext, photo: string | undefined): Promise<boolean> {
  writable(db, ctx, "viewer", { whileClosed: true, whileEnded: true });
  const update =
    photo === undefined
      ? { UpdateExpression: "REMOVE photoId", ConditionExpression: "attribute_exists(PK) AND attribute_exists(photoId)" }
      : {
          UpdateExpression: "SET photoId = :photo",
          // AND binds tighter than OR: the item exists, and has no photo or another one
          ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(photoId) OR attribute_exists(PK) AND photoId <> :photo",
          ExpressionAttributeValues: { ":photo": photoId(photo) },
        };
  try {
    await connection(db).doc.send(new UpdateCommand({ TableName: db.tableName, Key: keys.member(ctx.teamId, ctx.userId), ...update }));
    return true;
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}
