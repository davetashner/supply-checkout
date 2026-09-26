// Live updates (ADR 0006): the AppSync Events channel names, the change event
// the stream consumer publishes, and the names the Lambda code and the CDK app
// share (infra/lib/stacks/realtime-stack.ts imports this file), so they can't
// drift apart. No imports. docs/api/realtime.md is the client contract.

/**
 * The channel namespace. Each signed-in user has one channel, `/users/<sub>`,
 * and only that user may subscribe to it (ADR 0016). The stream consumer
 * publishes a team's changes to the channel of each current member, so a
 * member who is removed, or whose team is canceled, stops getting them as
 * soon as the consumer's view of the team's members catches up.
 */
export const USERS_NAMESPACE = "users";

/**
 * A channel segment. AppSync Events allows letters, digits and dashes, up to
 * 50 characters, starting and ending with a letter or digit. Cognito user IDs
 * (`sub`) are UUIDs, so every real user fits.
 */
const SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;

/** `/users/<userId>`, or undefined for a user ID that can't be a channel segment. */
export function userChannel(userId: string): string | undefined {
  return SEGMENT.test(userId) ? `/${USERS_NAMESPACE}/${userId}` : undefined;
}

/**
 * The user a subscription names, or undefined unless the channel is exactly
 * `/users/<userId>`: no wildcard (`/users/*`), no deeper path, no other
 * namespace. The leading slash is optional, as AppSync accepts both.
 */
export function userFromChannel(channel: unknown): string | undefined {
  if (typeof channel !== "string") return undefined;
  const parts = channel.replace(/^\//, "").split("/");
  if (parts.length !== 2 || parts[0] !== USERS_NAMESPACE) return undefined;
  const userId = parts[1] as string;
  return SEGMENT.test(userId) ? userId : undefined;
}

/**
 * How long the stream consumer trusts its list of a team's members (and
 * whether the team has ended) before reading it again. A member removed, or a
 * team canceled, stops getting change notices within this plus the stream's
 * own delay, and usually at once: the consumer also forgets a team's list when
 * the stream shows a change to its members or its META item.
 */
export const AUDIENCE_TTL_MS = 30_000;

/** How many publish requests the consumer has in flight at once. */
export const PUBLISH_CONCURRENCY = 20;

/**
 * Stream records per consumer invocation (the event source mapping's batch
 * size). A record costs up to one publish per member of its team, and a team
 * has at most MEMBERS_PER_TEAM (100) members, so a full batch is at most
 * STREAM_BATCH_SIZE x 100 publishes: PUBLISHES_PER_INVOCATION.
 */
export const STREAM_BATCH_SIZE = 25;

/**
 * The most publish requests one invocation makes. Past it, the consumer stops
 * and reports the earliest record it didn't finish, and Lambda invokes it
 * again from there. With parallelizationFactor 1 a shard runs one invocation
 * at a time, so this bounds how long a big, busy team can hold up the other
 * teams on its shard. A full batch at the member cap fits (see
 * STREAM_BATCH_SIZE).
 */
export const PUBLISHES_PER_INVOCATION = 2_500;

/**
 * How long one invocation starts new publish requests for, in milliseconds.
 * The same stop-and-resume as PUBLISHES_PER_INVOCATION, for when AppSync is
 * slow: requests in flight get PUBLISH_TIMEOUT_MS more, which keeps an
 * invocation well inside CONSUMER_TIMEOUT_SECONDS, so a slow batch returns
 * what it sent instead of timing out and being sent again from the start.
 */
export const PUBLISH_BUDGET_MS = 5_000;

/** One publish request's timeout, in milliseconds. A publish normally takes about 30 ms. */
export const PUBLISH_TIMEOUT_MS = 3_000;

/** The consumer function's timeout. PUBLISH_BUDGET_MS + PUBLISH_TIMEOUT_MS must fit well inside it (a test checks). */
export const CONSUMER_TIMEOUT_SECONDS = 10;

/** The change event's format version. A client ignores events with a version it doesn't know. */
export const CHANGE_EVENT_FORMAT = 1;

/**
 * One document changed. Published as a JSON string to `/users/<userId>` for
 * each current member of the team.
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
  /** The team whose document changed. A user's channel carries every team they're in. */
  readonly teamId: string;
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
export const CHANGE_EVENT_FIELDS: readonly (keyof ChangeEvent)[] = ["v", "teamId", "eventId", "collection", "id", "op", "version", "at"];

/** AppSync Events takes at most 5 events per publish request. */
export const EVENTS_PER_PUBLISH = 5;

/**
 * Sort-key prefixes of the items that are documents (products and sheets).
 * The event source mapping's filter passes only these to the consumer. The
 * same as `prefixes.product` and `prefixes.sheet` in src/data/keys.ts (a test
 * checks), repeated because this file has no imports.
 */
export const DOCUMENT_SK_PREFIXES = ["PRODUCT#", "SHEET#"] as const;

/**
 * Sort keys of the items that decide who gets a team's changes: the team's
 * META item (its billing status) and its MEMBER items. The event source
 * mapping passes these too, so the consumer can forget a team's cached
 * members as soon as they change. The same as `keys.team`'s SK and
 * `prefixes.member` in src/data/keys.ts (a test checks).
 */
export const AUDIENCE_SK = { exact: "META", prefix: "MEMBER#" } as const;

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
