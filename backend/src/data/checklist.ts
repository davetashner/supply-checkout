// The first-run checklist's progress (supply-checkout-fs56): the app's short
// list that gets an owner's new team ready (src/first-run.js). It's the
// team's, not a user's, so every owner on every device sees the same one, and
// it's kept on the team's META item, which GET /me already reads for each
// team, so showing it costs no extra read:
//
//   PK TEAM#<teamId>  SK META  checklistStartedAt  ISO time it started: createTeam writes it for every new team
//                              checklistReceipt    true once an owner saved a scanned receipt
//                              checklistDone       true once it was finished or dismissed
//
// A team without checklistStartedAt (one made before this) never had one,
// unless an owner starts it (`started`, for a checklist a device kept before
// the server did). The other steps aren't stored: the app ticks them from the
// team's own data (its items, members, invites and projects).
//
// Owners change it (PATCH /teams/{teamId}/checklist, the route's minRole, and
// writable() again here), and only ever to true: a step done stays done, and a
// dismissed checklist stays dismissed. The update names only these three
// attributes, so it can't touch anything else on the META item, and it's
// refused for a team that's closed (writable(), and the condition, for one
// closed meanwhile). /me shows it to owners only (checklistOf).

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { InvalidInputError, TeamClosedError } from "./errors.js";
import { keys } from "./keys.js";
import type { Team } from "./model.js";
import { type TeamContext, writable } from "./team-context.js";

/** The checklist's stored progress, as the app gets it. */
export interface Checklist {
  /** A scanned receipt was saved. */
  readonly receipt: boolean;
  /** It was finished or dismissed. */
  readonly done: boolean;
}

/** A change: each field present is true. `started` only starts a checklist the team didn't have. */
export interface ChecklistChange {
  readonly started?: true;
  readonly receipt?: true;
  readonly done?: true;
}

/** The fields PATCH /teams/{teamId}/checklist accepts. */
export const CHECKLIST_FIELDS = ["started", "receipt", "done"] as const;

/** A change from a request body (already limited to CHECKLIST_FIELDS): at least one field, each exactly true. */
export function checklistChange(body: Record<string, unknown>): ChecklistChange {
  const change: { started?: true; receipt?: true; done?: true } = {};
  for (const field of Object.keys(body)) {
    if (!(CHECKLIST_FIELDS as readonly string[]).includes(field)) throw new InvalidInputError(`Unexpected field "${field}"`);
    if (body[field] !== true) throw new InvalidInputError(`${field} can only be true`);
    change[field as keyof ChecklistChange] = true;
  }
  if (Object.keys(change).length === 0) throw new InvalidInputError("Nothing to change");
  return change;
}

/** The team's checklist, or null if it never had one; anything stored that isn't true counts as not done. */
export function checklistOf(team: Pick<Team, "checklistStartedAt" | "checklistReceipt" | "checklistDone">): Checklist | null {
  if (typeof team.checklistStartedAt !== "string") return null;
  return { receipt: team.checklistReceipt === true, done: team.checklistDone === true };
}

/** Applies a checked change (checklistChange), owners only, and returns the checklist after it. */
export async function setChecklist(db: Db, ctx: TeamContext, change: ChecklistChange, now = new Date()): Promise<Checklist> {
  writable(db, ctx, "owner");
  const names: Record<string, string> = { "#started": "checklistStartedAt", "#closed": "closedAt" };
  const values: Record<string, unknown> = { ":now": now.toISOString() };
  const sets = ["#started = if_not_exists(#started, :now)"];
  if (change.receipt === true) {
    names["#receipt"] = "checklistReceipt";
    values[":true"] = true;
    sets.push("#receipt = :true");
  }
  if (change.done === true) {
    names["#done"] = "checklistDone";
    values[":true"] = true;
    sets.push("#done = :true");
  }
  try {
    const { Attributes } = await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.team(ctx.teamId),
        UpdateExpression: `SET ${sets.join(", ")}`,
        // The team's own META item, never a new one, and not once it's closed
        ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(#closed)",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }),
    );
    return checklistOf(Attributes ?? {}) as Checklist;
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "ConditionalCheckFailedException") throw new TeamClosedError("This team was closed. It's read-only until its data is deleted.");
    throw error;
  }
}
