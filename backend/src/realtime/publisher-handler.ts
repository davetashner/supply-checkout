// The DynamoDB stream consumer: turns document writes into change events on
// the channel of each current member of the document's team (ADR 0006,
// ADR 0016, docs/api/realtime.md).
//
// - Only product and project documents go out (a project's twice through the
//   sheets-to-projects rename's window: as `projects` and as `sheets`). The event source mapping already
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
// - A batch with more than COLLECTION_EVENT_AFTER changes to one team's
//   collection (an import) publishes one CollectionEvent ("re-list products")
//   in their place, at the first one's position, so a 200-row import costs a
//   few publishes per member, not 200. It names no documents either.
// - Events for one team go out in stream order, up to 5 per request, to every
//   member's channel, reading the team's members again (usually from the
//   cache) before each chunk, so a removal cuts a member off within
//   AUDIENCE_TTL_MS however long the invocation runs; teams and members publish in parallel, at most
//   PUBLISH_CONCURRENCY requests at a time, earliest records first.
// - A publish budget per invocation: at most PUBLISHES_PER_INVOCATION
//   requests, started within PUBLISH_BUDGET_MS. When it runs out, the handler
//   reports the earliest record it didn't finish, as for a failure, and Lambda
//   invokes it again from there. So one big, busy team can't hold its shard
//   (one invocation at a time) for longer than that, and a slow AppSync ends
//   an invocation with what it sent rather than a timeout that sends the lot
//   again. Requests go out earliest record first, and the batch's first
//   chunk (the earliest document record's team, up to 5 events) always goes
//   to every member, outside the budget and the concurrency limit, so it
//   finishes within one PUBLISH_TIMEOUT_MS and every invocation moves the
//   shard forward by at least one record, however big the team or slow
//   AppSync. Budget stops aren't failures: they're logged, and counted in
//   LiveUpdatesDeferred ("Live updates deferred" alarms when it keeps
//   happening).
// - Retries: each response that reports a record is a failed invocation to
//   the event source mapping, and AWS doesn't say that progress resets its
//   count, so we assume a budget stop spends one of its retry attempts.
//   STREAM_RETRY_ATTEMPTS is at least STREAM_BATCH_SIZE, so budget stops
//   alone, moving at least one record each, can never use them up.
// - Nothing here logs a stream record, an image or an event payload: MEMBER
//   and document images carry emails, names and document data. Logs have
//   team IDs, counts and error messages only (a test checks).
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
import {
  CHANGE_EVENT_FORMAT,
  type ChangeEvent,
  COLLECTION_EVENT_AFTER,
  COLLECTION_EVENT_FORMAT,
  type CollectionEvent,
  type EventCollection,
  EVENTS_PER_PUBLISH,
  LEGACY_EVENT_COLLECTIONS,
  PUBLISH_BUDGET_MS,
  PUBLISH_CONCURRENCY,
  PUBLISHES_PER_INVOCATION,
  userChannel,
} from "./channels.js";
import type { Publish } from "./events-client.js";

export interface PublisherDeps {
  readonly publish: Publish;
  readonly audience: Audience;
  readonly obs: Observability;
  /** Publish requests in flight at once. */
  readonly concurrency?: number;
  /** Publish requests one invocation may make. */
  readonly maxPublishes?: number;
  /** How long one invocation may start publish requests for, in milliseconds. */
  readonly budgetMs?: number;
  /** The clock, for tests. */
  readonly now?: () => number;
  /** More changes than this to one team's collection in a batch go out as one CollectionEvent. */
  readonly collectionEventAfter?: number;
}

interface Outgoing {
  /** Position in the batch (of the first record, for a collection event). */
  readonly index: number;
  /** The record Lambda retries from if this doesn't go out. */
  readonly sequenceNumber: string;
  readonly teamId: string;
  readonly collection: EventCollection;
  /**
   * How many changes (stream records) it stands for: 1, or more for a
   * collection event; 0 for the second, old-named copy of a project's event,
   * whose record the first one counts.
   */
  readonly changes: number;
  /** The old-named copy of an event (LEGACY_EVENT_COLLECTIONS). */
  readonly legacy?: true;
  readonly eventId: string;
  /** Stream time in epoch milliseconds, when known. */
  readonly at?: number;
  /** A CollectionEvent rather than a ChangeEvent. */
  readonly list?: true;
  readonly payload: string;
}

/**
 * The event for a change, as the JSON string AppSync publishes. It names the
 * document and carries no data from it (see ChangeEvent): the client fetches
 * the document through the API, which checks membership.
 */
export function changeEvent(record: DynamoDBRecord, change: DocumentChange): string {
  return JSON.stringify(changeEventFields(record, change));
}

function changeEventFields(record: DynamoDBRecord, change: DocumentChange, collection: EventCollection = change.collection): ChangeEvent {
  const seconds = record.dynamodb?.ApproximateCreationDateTime;
  const event: ChangeEvent = {
    v: CHANGE_EVENT_FORMAT,
    teamId: change.teamId,
    eventId: record.eventID ?? record.dynamodb?.SequenceNumber ?? "",
    collection,
    id: change.id,
    op: change.op,
    ...(change.version !== undefined ? { version: change.version } : {}),
    ...(typeof seconds === "number" ? { at: Math.round(seconds * 1000) } : {}),
  };
  return event;
}

/**
 * The records to publish, in batch order, skipping everything that isn't a
 * team's document. A project's change goes out as `projects` and then again
 * as `sheets` (LEGACY_EVENT_COLLECTIONS), with the same event ID: one record,
 * two names for its collection.
 */
export function outgoing(records: readonly DynamoDBRecord[]): Outgoing[] {
  const out: Outgoing[] = [];
  records.forEach((record, index) => {
    const change = documentChangeFromStream(record);
    if (!change) return;
    const legacy = LEGACY_EVENT_COLLECTIONS[change.collection];
    for (const collection of legacy ? [change.collection, legacy] : [change.collection]) {
      const event = changeEventFields(record, change, collection);
      const copy = collection !== change.collection;
      out.push({
        index,
        sequenceNumber: record.dynamodb?.SequenceNumber ?? "",
        teamId: change.teamId,
        collection,
        changes: copy ? 0 : 1,
        ...(copy ? { legacy: true as const } : {}),
        eventId: event.eventId,
        at: event.at,
        payload: JSON.stringify(event),
      });
    }
  });
  return out;
}

/**
 * One team's events with each collection that has more than `after` of them
 * replaced by one CollectionEvent, at the position of its first change: if it
 * doesn't go out, Lambda retries from that record. Order is kept otherwise.
 */
export function coalesce(events: readonly Outgoing[], after: number): Outgoing[] {
  const byCollection = new Map<string, Outgoing[]>();
  for (const e of events) byCollection.set(e.collection, [...(byCollection.get(e.collection) ?? []), e]);
  const replaced = new Map<Outgoing, Outgoing | null>();
  for (const list of byCollection.values()) {
    if (list.length <= after) continue;
    const first = list[0] as Outgoing;
    const last = list[list.length - 1] as Outgoing;
    const event: CollectionEvent = {
      v: COLLECTION_EVENT_FORMAT,
      teamId: first.teamId,
      eventId: `${first.eventId}~${last.eventId}`,
      collection: first.collection,
      op: "list",
      changes: list.length,
      ...(last.at !== undefined ? { at: last.at } : {}),
    };
    replaced.set(first, { ...first, list: true, changes: first.legacy ? 0 : list.length, eventId: event.eventId, at: event.at, payload: JSON.stringify(event) });
    for (const e of list.slice(1)) replaced.set(e, null);
  }
  const out: Outgoing[] = [];
  for (const e of events) {
    const r = replaced.has(e) ? replaced.get(e) : e;
    if (r) out.push(r);
  }
  return out;
}

/** How many changes some events stand for. */
const changesIn = (events: readonly Outgoing[]) => events.reduce((n, e) => n + e.changes, 0);

/**
 * A shared limit on publish requests in flight, across every team in the
 * batch. A freed slot goes to the waiting request with the lowest `priority`
 * (its first record's position in the batch), so the earliest records go out
 * first whatever order the teams' requests queued in.
 */
function throttle(limit: number) {
  let active = 0;
  const waiting: { priority: number; resolve: () => void }[] = [];
  return async <T>(priority: number, task: () => Promise<T>): Promise<T> => {
    // A slot is either taken now or handed over by the task that frees it
    if (active < limit) active++;
    else
      await new Promise<void>((resolve) => {
        const at = waiting.findIndex((w) => w.priority > priority);
        waiting.splice(at === -1 ? waiting.length : at, 0, { priority, resolve });
      });
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next.resolve();
      else active--;
    }
  };
}

/** The invocation's publish budget: `max` requests, started before `ms` have passed. */
function publishBudget(max: number, ms: number, now: () => number) {
  const deadline = now() + ms;
  let used = 0;
  let spent = false;
  return {
    /** Counts a request the budget can't refuse (the batch's first chunk). */
    force(): void {
      used++;
    },
    /** Takes one request from the budget, or says it's used up (and stays used up). */
    take(): boolean {
      if (!spent && (used >= max || now() >= deadline)) spent = true;
      if (spent) return false;
      used++;
      return true;
    },
    /** Whether the budget is used up, or its time is: checked before a chunk reads its members. */
    get spent() {
      if (!spent && (used >= max || now() >= deadline)) spent = true;
      return spent;
    },
  };
}

type Budget = ReturnType<typeof publishBudget>;

type Throttle = ReturnType<typeof throttle>;

/** publishChunk's answer when the budget ran out before the request could start. */
const SKIPPED = -2;

/**
 * Publishes one chunk to one channel. Returns the position in the chunk of
 * the first event that didn't go out, -1 when all did, or SKIPPED. The
 * batch's first chunk (`first`) goes at once, whatever the budget and the
 * concurrency limit.
 */
async function publishChunk(deps: PublisherDeps, run: Throttle, budget: Budget, teamId: string, channel: string, chunk: readonly Outgoing[], first: boolean): Promise<number> {
  try {
    const priority = (chunk[0] as Outgoing).index;
    const send = () => deps.publish(channel, chunk.map((e) => e.payload));
    let result;
    if (first) {
      budget.force();
      result = await send();
    } else {
      // The budget is checked when the request gets its slot, not when it queued
      result = await run(priority, async () => (budget.take() ? send() : undefined));
    }
    if (!result) return SKIPPED;
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
 * current member's channel, asking the Audience for the members before each
 * chunk. Returns how many changes reached every member and the first event
 * that didn't, if any; nothing after a failure is sent, so the retry keeps
 * the order.
 */
async function publishTeam(
  deps: PublisherDeps,
  run: Throttle,
  budget: Budget,
  teamId: string,
  events: readonly Outgoing[],
  firstIndex: number,
): Promise<{ sent: number; publishes: number; firstFailed?: Outgoing; deferred?: boolean }> {
  const warned = new Set<string>();
  let sent = 0;
  let publishes = 0;
  for (let i = 0; i < events.length; i += EVENTS_PER_PUBLISH) {
    const chunk = events.slice(i, i + EVENTS_PER_PUBLISH);
    const first = (chunk[0] as Outgoing).index === firstIndex;
    // Once the budget is spent, stop before reading: an uncached read could take AUDIENCE_READ_TIMEOUT_MS
    if (budget.spent && !first) return { sent, publishes, firstFailed: chunk[0], deferred: true };
    // Read for every chunk, not once per team: the cache says how stale the list may be, not how long this invocation runs
    let users: readonly string[];
    try {
      users = await deps.audience.recipients(teamId);
    } catch (error) {
      deps.obs.logger.error("Couldn't read the team's members", { teamId, error: (error as Error).message });
      return { sent, publishes, firstFailed: chunk[0] };
    }
    const channels: string[] = [];
    for (const user of users) {
      const channel = userChannel(user);
      // Cognito user IDs are UUIDs; one that can't be a channel name has no subscriber
      if (channel) channels.push(channel);
      else if (!warned.has(user)) {
        warned.add(user);
        deps.obs.logger.warn("User ID can't be a channel name; not publishing to it", { teamId, userId: user });
      }
    }
    const failures = await Promise.all(channels.map((channel) => publishChunk(deps, run, budget, teamId, channel, chunk, first)));
    const failed = failures.filter((f) => f >= 0);
    const skipped = failures.filter((f) => f === SKIPPED).length;
    publishes += channels.length - skipped;
    // A chunk the budget stopped part way goes again, whole, to every member: a client applies an event twice safely
    if (skipped) return { sent, publishes, firstFailed: chunk[0], deferred: failed.length === 0 };
    const failedAt = Math.min(...failed);
    if (Number.isFinite(failedAt)) return { sent: sent + changesIn(chunk.slice(0, failedAt)), publishes, firstFailed: chunk[failedAt] };
    sent += changesIn(chunk);
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
    const after = deps.collectionEventAfter ?? COLLECTION_EVENT_AFTER;
    for (const [teamId, list] of byTeam) byTeam.set(teamId, coalesce(list, after));
    const run = throttle(deps.concurrency ?? PUBLISH_CONCURRENCY);
    const budget = publishBudget(deps.maxPublishes ?? PUBLISHES_PER_INVOCATION, deps.budgetMs ?? PUBLISH_BUDGET_MS, deps.now ?? Date.now);
    const teams = [...byTeam];
    const firstIndex = events[0]?.index ?? -1;
    const results = await Promise.all(teams.map(([teamId, list]) => publishTeam(deps, run, budget, teamId, list, firstIndex)));

    const sent = results.reduce((n, r) => n + r.sent, 0);
    const publishes = results.reduce((n, r) => n + r.publishes, 0);
    const failures = results.map((r) => r.firstFailed).filter((f): f is Outgoing => f !== undefined);
    // Lambda retries from the earliest reported record, so report only that one
    const earliest = failures.sort((a, b) => a.index - b.index)[0];
    // Events not sent, split by why: a failure (alarmed on) or the budget (sent next invocation)
    let unsent = 0;
    let deferred = 0;
    results.forEach((r, i) => {
      const left = changesIn(teams[i]?.[1] ?? []) - r.sent;
      if (r.deferred) deferred += left;
      else unsent += left;
    });

    // Document changes (stream records), not events: a project's old-named copy isn't counted again
    const changes = changesIn(events);
    if (changes) deps.obs.count(BusinessMetric.LiveUpdates, changes);
    if (unsent) deps.obs.count(BusinessMetric.LiveUpdateFailures, unsent);
    if (deferred) {
      deps.obs.count(BusinessMetric.LiveUpdatesDeferred, deferred);
      deps.obs.logger.warn("Publish budget used up; Lambda sends the rest from the earliest unsent record", { publishes, deferred, teams: results.filter((r) => r.deferred).length });
    }
    const collectionEvents = teams.reduce((n, [, list]) => n + list.filter((e) => e.list && !e.legacy).length, 0);
    const oldest = Math.min(...records.map((r) => r.dynamodb?.ApproximateCreationDateTime ?? Infinity));
    deps.obs.logger.info("Batch", {
      records: records.length,
      events: changes,
      teams: byTeam.size,
      collectionEvents,
      publishes,
      sent,
      failed: unsent,
      deferred,
      // Seconds precision: a rough lag. docs/api/realtime.md says how to measure delivery end to end
      ...(Number.isFinite(oldest) ? { lagMs: Date.now() - oldest * 1000 } : {}),
    });
    return { batchItemFailures: earliest ? [{ itemIdentifier: earliest.sequenceNumber }] : [] };
  };
}
