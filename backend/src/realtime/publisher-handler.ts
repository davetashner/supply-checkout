// The DynamoDB stream consumer: turns document writes into change events on
// the channel of each current member of the document's team (ADR 0006,
// ADR 0016, docs/api/realtime.md).
//
// - Only product and sheet documents go out. The event source mapping already
//   filters on the sort key, and documentChangeFromStream checks again, so
//   members, invites, usage, audit entries and team metadata never reach a
//   channel.
// - An event names the document that changed (team, collection, ID,
//   operation, version) and carries none of its data. The client fetches the
//   document through the data API, which checks membership on every request.
// - Who gets a team's events: its current members, from the Audience (cached
//   for AUDIENCE_TTL_MS), and nobody once the team has ended. The stream also
//   carries the team's META and MEMBER writes; each makes the consumer forget
//   that team's members before it publishes anything in the batch, so a
//   removal usually takes effect at once, and always within the cache time.
//   AppSync can't end a subscription from the server, so this is what cuts a
//   removed member off: nothing more is published to their channel.
// - Events for one team go out in stream order, up to 5 per request, to every
//   member's channel; teams and members publish in parallel, at most
//   PUBLISH_CONCURRENCY requests at a time.
// - Partial batch failures: when a publish to any member fails, the handler
//   reports the earliest record in the batch that didn't reach everyone, and
//   Lambda retries from there. Records after it are published again, to every
//   member, with the same event IDs and versions, so a client applying them
//   twice ends up in the same state.
// - A batch that keeps failing goes to the dead-letter queue (the event source
//   mapping's on-failure destination), which alarms. Clients that missed
//   those events catch up on their next reconnect or resync.

import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { audienceChangeFromStream, documentChangeFromStream, type DocumentChange } from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import type { Audience } from "./audience.js";
import { CHANGE_EVENT_FORMAT, type ChangeEvent, EVENTS_PER_PUBLISH, PUBLISH_CONCURRENCY, userChannel } from "./channels.js";
import type { Publish } from "./events-client.js";

export interface PublisherDeps {
  readonly publish: Publish;
  readonly audience: Audience;
  readonly obs: Observability;
  /** Publish requests in flight at once. */
  readonly concurrency?: number;
}

interface Outgoing {
  /** Position in the batch. */
  readonly index: number;
  readonly sequenceNumber: string;
  readonly teamId: string;
  readonly payload: string;
}

/**
 * The event for a change, as the JSON string AppSync publishes. It names the
 * document and carries no data from it (see ChangeEvent): the client fetches
 * the document through the API, which checks membership.
 */
export function changeEvent(record: DynamoDBRecord, change: DocumentChange): string {
  const seconds = record.dynamodb?.ApproximateCreationDateTime;
  const event: ChangeEvent = {
    v: CHANGE_EVENT_FORMAT,
    teamId: change.teamId,
    eventId: record.eventID ?? record.dynamodb?.SequenceNumber ?? "",
    collection: change.collection,
    id: change.id,
    op: change.op,
    ...(change.version !== undefined ? { version: change.version } : {}),
    ...(typeof seconds === "number" ? { at: Math.round(seconds * 1000) } : {}),
  };
  return JSON.stringify(event);
}

/** The records to publish, in batch order, skipping everything that isn't a team's document. */
export function outgoing(records: readonly DynamoDBRecord[]): Outgoing[] {
  const out: Outgoing[] = [];
  records.forEach((record, index) => {
    const change = documentChangeFromStream(record);
    if (change) out.push({ index, sequenceNumber: record.dynamodb?.SequenceNumber ?? "", teamId: change.teamId, payload: changeEvent(record, change) });
  });
  return out;
}

/** A shared limit on publish requests in flight, across every team in the batch. */
function throttle(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    // A slot is either taken now or handed over by the task that frees it
    if (active < limit) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

type Throttle = ReturnType<typeof throttle>;

/**
 * Publishes one chunk to one channel. Returns the position in the chunk of
 * the first event that didn't go out, or -1 when all did.
 */
async function publishChunk(deps: PublisherDeps, run: Throttle, teamId: string, channel: string, chunk: readonly Outgoing[]): Promise<number> {
  try {
    const result = await run(() => deps.publish(channel, chunk.map((e) => e.payload)));
    const ok = new Set(result.successful);
    const failedAt = chunk.findIndex((_, j) => !ok.has(j));
    if (failedAt !== -1) {
      const reasons = result.failed.map((f) => f.code ?? f.message ?? "unknown");
      deps.obs.logger.error("AppSync refused events", { teamId, refused: chunk.length - ok.size, reasons: reasons.join(",") });
    }
    return failedAt;
  } catch (error) {
    deps.obs.logger.error("Publish failed", { teamId, error: (error as Error).message });
    return 0;
  }
}

/**
 * Publishes one team's events in order, EVENTS_PER_PUBLISH at a time, to each
 * current member's channel. Returns how many reached every member and the
 * first one that didn't, if any; nothing after a failure is sent, so the
 * retry keeps the order.
 */
async function publishTeam(
  deps: PublisherDeps,
  run: Throttle,
  teamId: string,
  events: readonly Outgoing[],
): Promise<{ sent: number; publishes: number; firstFailed?: Outgoing }> {
  let users: readonly string[];
  try {
    users = await deps.audience.recipients(teamId);
  } catch (error) {
    deps.obs.logger.error("Couldn't read the team's members", { teamId, error: (error as Error).message });
    return { sent: 0, publishes: 0, firstFailed: events[0] };
  }
  const channels: string[] = [];
  for (const user of users) {
    const channel = userChannel(user);
    // Cognito user IDs are UUIDs; one that can't be a channel name has no subscriber
    if (channel) channels.push(channel);
    else deps.obs.logger.warn("User ID can't be a channel name; not publishing to it", { teamId, userId: user });
  }
  let sent = 0;
  let publishes = 0;
  for (let i = 0; i < events.length; i += EVENTS_PER_PUBLISH) {
    const chunk = events.slice(i, i + EVENTS_PER_PUBLISH);
    const failures = await Promise.all(channels.map((channel) => publishChunk(deps, run, teamId, channel, chunk)));
    publishes += channels.length;
    const failedAt = Math.min(...failures.filter((f) => f !== -1));
    if (Number.isFinite(failedAt)) return { sent: sent + failedAt, publishes, firstFailed: chunk[failedAt] };
    sent += chunk.length;
  }
  return { sent, publishes };
}

export function createPublisherHandler(deps: PublisherDeps) {
  return async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
    const records = event.Records ?? [];
    // Membership and billing changes first: nothing in this batch goes to a removed member
    for (const record of records) {
      const teamId = audienceChangeFromStream(record);
      if (teamId) deps.audience.forget(teamId);
    }
    const events = outgoing(records);
    const byTeam = new Map<string, Outgoing[]>();
    for (const e of events) {
      const list = byTeam.get(e.teamId) ?? [];
      list.push(e);
      byTeam.set(e.teamId, list);
    }
    const run = throttle(deps.concurrency ?? PUBLISH_CONCURRENCY);
    const results = await Promise.all([...byTeam].map(([teamId, list]) => publishTeam(deps, run, teamId, list)));

    const sent = results.reduce((n, r) => n + r.sent, 0);
    const publishes = results.reduce((n, r) => n + r.publishes, 0);
    const failures = results.map((r) => r.firstFailed).filter((f): f is Outgoing => f !== undefined);
    // Lambda retries from the earliest reported record, so report only that one
    const earliest = failures.sort((a, b) => a.index - b.index)[0];
    const unsent = earliest ? events.length - sent : 0;

    if (events.length) deps.obs.count(BusinessMetric.LiveUpdates, events.length);
    if (unsent) deps.obs.count(BusinessMetric.LiveUpdateFailures, unsent);
    const oldest = Math.min(...records.map((r) => r.dynamodb?.ApproximateCreationDateTime ?? Infinity));
    deps.obs.logger.info("Batch", {
      records: records.length,
      events: events.length,
      teams: byTeam.size,
      publishes,
      sent,
      failed: unsent,
      // Seconds precision: a rough lag. docs/api/realtime.md says how to measure delivery end to end
      ...(Number.isFinite(oldest) ? { lagMs: Date.now() - oldest * 1000 } : {}),
    });
    return { batchItemFailures: earliest ? [{ itemIdentifier: earliest.sequenceNumber }] : [] };
  };
}
