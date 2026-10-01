// The team's settings (ADR 0017, section 2a): one `SETTINGS` item in the
// team's partition, next to its META item. Today it holds one setting,
// `equipmentMarkup`: the percentage added to the receipt price of company
// equipment bought for a client (addLines in commands.ts works the price out
// from it, on the server).
//
// Owners read and write it. Nobody else gets the percentage: getTeamSettings
// returns it to owners only, and no other response carries it (a sheet line
// stores the resulting price, not the percentage). Every change to the markup
// is audited in the same transaction (who, when, the old and new value).
// Missing, the markup is 0%.

import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { auditPut } from "./audit.js";
import { type Db, connection } from "./client.js";
import { ConflictError, InvalidInputError } from "./errors.js";
import { keys } from "./keys.js";
import { type TeamContext, readable, writable } from "./team-context.js";

/** The largest equipment markup, in percent. */
export const MAX_MARKUP = 1000;

/** The audit action for a change to the equipment markup. */
export const MARKUP_AUDIT_ACTION = "settings.equipment-markup";

export interface TeamSettings {
  /** Percent added to the receipt price of equipment bought for a client: 0 to MAX_MARKUP, at most two decimals. */
  readonly equipmentMarkup: number;
}

export interface SettingsView {
  /** 0 until an owner first saves the settings; a write names it as expectedVersion. */
  readonly version: number;
  /** All of the settings for an owner; for anyone else, only what they may see (nothing, for now). */
  readonly settings: Partial<TeamSettings>;
}

/** A markup a client sent: a number from 0 to MAX_MARKUP with at most two decimals. */
export function markupPercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_MARKUP || !Number.isInteger(Number((value * 100).toPrecision(12)))) {
    throw new InvalidInputError(`equipmentMarkup must be a percentage from 0 to ${MAX_MARKUP} with at most two decimals`);
  }
  return Math.round(Number((value * 100).toPrecision(12))) / 100;
}

/** The markup a stored settings item holds: 0 when there's no item, or its value isn't a usable percentage. */
export function storedMarkup(item: Record<string, unknown> | undefined): number {
  const value = item?.equipmentMarkup;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_MARKUP ? value : 0;
}

async function readSettingsItem(db: Db, ctx: TeamContext): Promise<Record<string, unknown> | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.settings(ctx.teamId), ConsistentRead: true }));
  return Item;
}

const versionOf = (item: Record<string, unknown> | undefined) => (typeof item?.version === "number" ? item.version : 0);

/** The team's settings as the caller may see them: the markup for owners only. */
export async function getTeamSettings(db: Db, ctx: TeamContext): Promise<SettingsView> {
  readable(ctx);
  const item = await readSettingsItem(db, ctx);
  if (ctx.role !== "owner") return { version: versionOf(item), settings: {} };
  return { version: versionOf(item), settings: { equipmentMarkup: storedMarkup(item) } };
}

/**
 * Saves the team's settings, owners only, if nobody else has since
 * `expectedVersion` (0: never saved). A changed markup is audited in the same
 * transaction.
 */
export async function setTeamSettings(db: Db, ctx: TeamContext, input: { readonly equipmentMarkup?: unknown }, expectedVersion: number, now = new Date()): Promise<SettingsView> {
  writable(db, ctx, "owner");
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new InvalidInputError("Invalid version");
  const equipmentMarkup = markupPercent(input.equipmentMarkup);
  const item = await readSettingsItem(db, ctx);
  if (versionOf(item) !== expectedVersion) throw new ConflictError("The settings changed; reload and try again");
  const before = storedMarkup(item);
  const version = expectedVersion + 1;
  const condition =
    expectedVersion === 0
      ? { ConditionExpression: "attribute_not_exists(PK)" }
      : { ConditionExpression: "#version = :expected", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":expected": expectedVersion } };
  try {
    await connection(db).doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: db.tableName,
              Item: { ...keys.settings(ctx.teamId), type: "settings", equipmentMarkup, version, updatedAt: now.toISOString(), updatedBy: ctx.userId },
              ...condition,
            },
          },
          ...(before === equipmentMarkup ? [] : [auditPut(db, ctx, { action: MARKUP_AUDIT_ACTION, detail: { from: before, to: equipmentMarkup } }, now)]),
        ],
      }),
    );
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "TransactionCanceledException") throw new ConflictError("The settings changed; reload and try again");
    throw error;
  }
  return { version, settings: { equipmentMarkup } };
}
