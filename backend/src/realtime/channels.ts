// Live updates (ADR 0006): the AppSync Events channel names, the change event
// the stream consumer publishes, and the names the Lambda code and the CDK app
// share (infra/lib/stacks/realtime-stack.ts imports this file), so they can't
// drift apart. No imports. docs/api/realtime.md is the client contract.

/** The channel namespace. Each team's channel is `/teams/<teamId>`. */
export const TEAMS_NAMESPACE = "teams";

/**
 * A team ID that can be a channel segment. AppSync Events allows letters,
 * digits and dashes, up to 50 characters, starting and ending with a letter
 * or digit. Team IDs are UUIDs (createTeam), so every real team fits; the
 * API's own check (letters, digits, `_` and `-`, up to 128) is looser, and
 * this one applies on top of it.
 */
const SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;

/** `/teams/<teamId>`, or undefined for a team ID that can't be a channel segment. */
export function teamChannel(teamId: string): string | undefined {
  return SEGMENT.test(teamId) ? `/${TEAMS_NAMESPACE}/${teamId}` : undefined;
}

/**
 * The team a subscription names, or undefined unless the channel is exactly
 * `/teams/<teamId>`: no wildcard (`/teams/*`), no deeper path, no other
 * namespace. The leading slash is optional, as AppSync accepts both.
 */
export function teamFromChannel(channel: unknown): string | undefined {
  if (typeof channel !== "string") return undefined;
  const parts = channel.replace(/^\//, "").split("/");
  if (parts.length !== 2 || parts[0] !== TEAMS_NAMESPACE) return undefined;
  const teamId = parts[1] as string;
  return SEGMENT.test(teamId) ? teamId : undefined;
}

/** The change event's format version. A client ignores events with a version it doesn't know. */
export const CHANGE_EVENT_FORMAT = 1;

/**
 * One document changed. Published to `/teams/<teamId>` as a JSON string.
 *
 * It says which document changed and nothing about what's in it: the client
 * fetches the document through the data API, which checks membership on every
 * request. AppSync checks membership only when a client subscribes, and an
 * open subscription can last up to 24 hours, so a member removed while
 * connected must not get document contents from here. docs/api/realtime.md
 * describes how the browser adapter applies it.
 */
export interface ChangeEvent {
  readonly v: typeof CHANGE_EVENT_FORMAT;
  /** The DynamoDB stream record's ID. A retried batch publishes the same event again with the same ID. */
  readonly eventId: string;
  readonly collection: "products" | "sheets";
  /** The product key or sheet ID. */
  readonly id: string;
  /** `put` for a create, replace, update or stock change; `delete` for a delete. */
  readonly op: "put" | "delete";
  /**
   * The document's version after the change (the deleted document's last
   * version, for a delete). A product's stock can change without a new
   * version, so a `put` with the version the client already has still means
   * "fetch it again".
   */
  readonly version?: number;
  /** When the stream saw the change, epoch milliseconds (DynamoDB gives it to the second). */
  readonly at?: number;
}

/** Every field a ChangeEvent may have. Tests check that nothing else, least of all document data, goes out. */
export const CHANGE_EVENT_FIELDS: readonly (keyof ChangeEvent)[] = ["v", "eventId", "collection", "id", "op", "version", "at"];

/** AppSync Events takes at most 5 events per publish request. */
export const EVENTS_PER_PUBLISH = 5;

/**
 * Sort-key prefixes of the items that are documents (products and sheets).
 * The event source mapping's filter passes only these to the consumer. The
 * same as `prefixes.product` and `prefixes.sheet` in src/data/keys.ts (a test
 * checks), repeated because this file has no imports.
 */
export const DOCUMENT_SK_PREFIXES = ["PRODUCT#", "SHEET#"] as const;

/** Environment variables the realtime stack sets and the handlers read. */
export const REALTIME_ENV = {
  tableName: "TABLE_NAME",
  /** The Cognito user pool that issues access tokens. */
  userPoolId: "USER_POOL_ID",
  /** The web app's client ID: an access token's `client_id` must be this. */
  clientId: "CLIENT_ID",
  /** The Event API's HTTP host (not the custom domain), for IAM-signed publishing. */
  httpHost: "EVENTS_HTTP_HOST",
} as const;

/** Names of the resources the observability stack's alarms watch. */
export const realtimeResourceNames = (envName: string) => ({
  /** The DynamoDB stream consumer. */
  consumerFunction: `supply-checkout-${envName}-live-updates`,
  /** Where the consumer's event source mapping sends batches it gave up on. */
  deadLetterQueue: `supply-checkout-${envName}-live-updates-dlq`,
});
