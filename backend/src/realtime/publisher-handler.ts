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
//   PUBLISH_CONCURRENCY requests at a time, earliest records first.
// - A publish budget per invocation: at most PUBLISHES_PER_INVOCATION
//   requests, started within PUBLISH_BUDGET_MS. When it runs out, the handler
//   reports the earliest record it didn't finish, as for a failure, and Lambda
//   invokes it again from there. So one big, busy team can't hold its shard
//   (one invocation at a time) for longer than that, and a slow AppSync ends
//   an invocation with what it sent rather than a timeout that sends the lot
//   again. Requests go out earliest record first, so each invocation moves
//   the shard forward. Budget stops aren't failures: they're logged and
//   counted apart (LiveUpdatesDeferred in the Batch line).
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
  EVENTS_PER_PUBLISH,
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
    /** Takes one request from the budget, or says it's used up (and stays used up). */
    take(): boolean {
      if (!spent && (used >= max || now() >= deadline)) spent = true;
      if (spent) return false;
      used++;
      return true;
    },
    get spent() {
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
 * the first event that didn't go out, -1 when all did, or SKIPPED.
 */
async function publishChunk(deps: PublisherDeps, run: Throttle, budget: Budget, teamId: string, channel: string, chunk: readonly Outgoing[]): Promise<number> {
  try {
    const priority = (chunk[0] as Outgoing).index;
    // The budget is checked when the request gets its slot, not when it queued
    const result = await run(priority, async () => (budget.take() ? deps.publish(channel, chunk.map((e) => e.payload)) : undefined));
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
 * current member's channel. Returns how many reached every member and the
 * first one that didn't, if any; nothing after a failure is sent, so the
 * retry keeps the order.
 */
async function publishTeam(
  deps: PublisherDeps,
  run: Throttle,
  budget: Budget,
  teamId: string,
  events: readonly Outgoing[],
): Promise<{ sent: number; publishes: number; firstFailed?: Outgoing; deferred?: boolean }> {
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
    if (budget.spent && channels.length) return { sent, publishes, firstFailed: chunk[0], deferred: true };
    const failures = await Promise.all(channels.map((channel) => publishChunk(deps, run, budget, teamId, channel, chunk)));
    const failed = failures.filter((f) => f >= 0);
    const skipped = failures.filter((f) => f === SKIPPED).length;
    publishes += channels.length - skipped;
    // A chunk the budget stopped part way goes again, whole, to every member: a client applies an event twice safely
    if (skipped) return { sent, publishes, firstFailed: chunk[0], deferred: failed.length === 0 };
    const failedAt = Math.min(...failed);
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
    const budget = publishBudget(deps.maxPublishes ?? PUBLISHES_PER_INVOCATION, deps.budgetMs ?? PUBLISH_BUDGET_MS, deps.now ?? Date.now);
    const teams = [...byTeam];
    const results = await Promise.all(teams.map(([teamId, list]) => publishTeam(deps, run, budget, teamId, list)));

    const sent = results.reduce((n, r) => n + r.sent, 0);
    const publishes = results.reduce((n, r) => n + r.publishes, 0);
    const failures = results.map((r) => r.firstFailed).filter((f): f is Outgoing => f !== undefined);
    // Lambda retries from the earliest reported record, so report only that one
    const earliest = failures.sort((a, b) => a.index - b.index)[0];
    // Events not sent, split by why: a failure (alarmed on) or the budget (sent next invocation)
    let unsent = 0;
    let deferred = 0;
    results.forEach((r, i) => {
      const left = (teams[i]?.[1].length ?? 0) - r.sent;
      if (r.deferred) deferred += left;
      else unsent += left;
    });

    if (events.length) deps.obs.count(BusinessMetric.LiveUpdates, events.length);
    if (unsent) deps.obs.count(BusinessMetric.LiveUpdateFailures, unsent);
    if (deferred) {
      deps.obs.logger.warn("Publish budget used up; Lambda sends the rest from the earliest unsent record", { publishes, deferred, teams: results.filter((r) => r.deferred).length });
    }
    const oldest = Math.min(...records.map((r) => r.dynamodb?.ApproximateCreationDateTime ?? Infinity));
    deps.obs.logger.info("Batch", {
      records: records.length,
      events: events.length,
      teams: byTeam.size,
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
