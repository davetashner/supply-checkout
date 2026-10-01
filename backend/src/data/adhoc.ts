// The team's ADHOC item (ADR 0017, sections 4 and 7): which of its ad hoc
// sheets is open, and how many it has made. One per team, in the team's
// partition, next to META and SETTINGS:
//
//   { PK: TEAM#<team>, SK: ADHOC, type: "adhoc", count, open?, version, updatedAt }
//
// `count` is the number of the last ad hoc sheet made (`adhoc-<count>`), and
// `open` the ID of the open one, absent when none is. Missing altogether, the
// team has made none (the first quick take makes `adhoc-1`).
//
// Every write to it is a whole-item Put on the condition that its `version` is
// still the one read, in the same transaction as the sheet change it goes
// with: the quick take that makes a sheet (commands.ts), and closing,
// reopening or deleting an ad hoc sheet (documents.ts). So the pointer and the
// sheets never disagree, and two first takes at once can't both make a sheet:
// one transaction is cancelled, reads again, and adds to the sheet the other
// made.

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { adhocNumber, keys } from "./keys.js";

type Item = Record<string, unknown>;

/** The team's ADHOC item, strongly consistent, or undefined if it has none yet. */
export async function readAdhoc(db: Db, teamId: string): Promise<Item | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.adhoc(teamId), ConsistentRead: true }));
  return Item;
}

/** The open ad hoc sheet's ID the item names, if it names one. */
export function adhocOpen(pointer: Item | undefined): string | undefined {
  const open = pointer?.open;
  return typeof open === "string" && adhocNumber(open) !== undefined ? open : undefined;
}

/** How many ad hoc sheets the team has made: the item's count, 0 without one. */
export function adhocCount(pointer: Item | undefined): number {
  const count = pointer?.count;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0;
}

/**
 * The transaction item that replaces the ADHOC item, on the condition that it's
 * still as `read` found it (its version, or absent). `open` names the open
 * sheet (undefined: none); `count` never goes down.
 */
export function adhocPut(db: Db, teamId: string, read: Item | undefined, next: { readonly open: string | undefined; readonly count: number }, at: string): Record<string, Record<string, unknown>> {
  const version = read?.version;
  const condition = !read
    ? { ConditionExpression: "attribute_not_exists(PK)" }
    : typeof version === "number"
      ? { ConditionExpression: "#version = :version", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":version": version } }
      : { ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(#version)", ExpressionAttributeNames: { "#version": "version" } };
  return {
    Put: {
      TableName: db.tableName,
      Item: {
        ...keys.adhoc(teamId),
        type: "adhoc",
        count: Math.max(adhocCount(read), next.count),
        ...(next.open === undefined ? {} : { open: next.open }),
        version: (typeof version === "number" ? version : 0) + 1,
        updatedAt: at,
      },
      ...condition,
    },
  };
}
