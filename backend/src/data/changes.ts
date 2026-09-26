// Document changes from the table's DynamoDB stream, for live updates
// (ADR 0006, supply-checkout-dpc). The stream consumer in src/realtime can't
// read DynamoDB's item format itself (only this module knows the item
// shapes), so it hands each stream record here and gets back which team's
// document changed, and how.
//
// Only the keys and the version are read: live updates carry no document
// data (docs/api/realtime.md), so the images' other attributes never leave
// this function.
//
// Every document write is one PutItem or DeleteItem on the document's item
// (documents.ts), so each write is exactly one stream record. A product's
// `stock` can also change through a command (commands.ts) or products.ts's
// adjustStock, which give it a new `version`; either is an ordinary MODIFY
// record here.

import type { DynamoDBRecord } from "aws-lambda";
import type { Collection } from "./documents.js";
import { id as checkId, prefixes, productKey } from "./keys.js";

export interface DocumentChange {
  readonly teamId: string;
  readonly collection: Collection;
  /** The product key or sheet ID. */
  readonly id: string;
  readonly op: "put" | "delete";
  /** The version after a put, or the deleted document's last version. Missing only for a malformed item. */
  readonly version?: number;
}

const TEAM_PK = /^TEAM#([^#]+)$/;
const COLLECTION_PREFIXES: readonly [string, Collection][] = [
  [prefixes.product, "products"],
  [prefixes.sheet, "sheets"],
];

function valid(check: () => string): string | undefined {
  try {
    return check();
  } catch {
    return undefined;
  }
}

function versionOf(image: Record<string, { N?: string }> | undefined): number | undefined {
  const raw = image?.version?.N;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * The document change in a stream record, or undefined for anything that
 * isn't a product or sheet document: team metadata, members, invites, usage,
 * audit entries, Stripe links, and anything malformed.
 */
export function documentChangeFromStream(record: DynamoDBRecord): DocumentChange | undefined {
  const keys = record.dynamodb?.Keys;
  const pk = keys?.PK?.S;
  const sk = keys?.SK?.S;
  if (typeof pk !== "string" || typeof sk !== "string") return undefined;

  const teamId = valid(() => checkId(TEAM_PK.exec(pk)?.[1], "team ID"));
  if (!teamId) return undefined;
  const match = COLLECTION_PREFIXES.find(([prefix]) => sk.startsWith(prefix));
  if (!match) return undefined;
  const [prefix, collection] = match;
  const raw = sk.slice(prefix.length);
  const docId = valid(() => (collection === "products" ? productKey(raw) : checkId(raw, "sheet ID")));
  if (!docId) return undefined;

  const base = { teamId, collection, id: docId };
  if (record.eventName === "REMOVE") return { ...base, op: "delete", version: versionOf(record.dynamodb?.OldImage) };
  if (record.eventName === "INSERT" || record.eventName === "MODIFY") return { ...base, op: "put", version: versionOf(record.dynamodb?.NewImage) };
  return undefined;
}
