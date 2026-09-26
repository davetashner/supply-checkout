// The DynamoDB stream consumer: turns document writes into change events on
// each team's AppSync Events channel (ADR 0006, docs/api/realtime.md).
//
// - Only product and sheet documents go out. The event source mapping already
//   filters on the sort key, and documentChangeFromStream checks again, so
//   members, invites, usage, audit entries and team metadata never reach a
//   channel.
// - An event names the document that changed (collection, ID, operation,
//   version) and carries none of its data. The client fetches the document
//   through the data API, which checks membership on every request, so a
//   member removed while connected gets no document contents from here.
// - Events for one team go out in stream order, up to 5 per request; teams
//   publish in parallel.
// - Partial batch failures: when a publish fails, the handler reports the
//   earliest record in the batch that didn't go out, and Lambda retries from
//   there. Records after it are published again, with the same event IDs and
//   versions, so a client applying them twice ends up in the same state.
// - A batch that keeps failing goes to the dead-letter queue (the event source
//   mapping's on-failure destination), which alarms. Clients that missed
//   those events catch up on their next reconnect or resync.

import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { documentChangeFromStream, type DocumentChange } from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { CHANGE_EVENT_FORMAT, type ChangeEvent, EVENTS_PER_PUBLISH, teamChannel } from "./channels.js";
import type { Publish } from "./events-client.js";

export interface PublisherDeps {
  readonly publish: Publish;
  readonly obs: Observability;
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
export function outgoing(records: readonly DynamoDBRecord[], obs: Observability): Outgoing[] {
  const out: Outgoing[] = [];
  records.forEach((record, index) => {
    const change = documentChangeFromStream(record);
    if (!change) return;
    if (!teamChannel(change.teamId)) {
      // Real team IDs are UUIDs; one that can't be a channel name has no subscribers
      obs.logger.warn("Team ID can't be a channel name; not publishing", { teamId: change.teamId });
      return;
    }
    out.push({ index, sequenceNumber: record.dynamodb?.SequenceNumber ?? "", teamId: change.teamId, payload: changeEvent(record, change) });
  });
  return out;
}

/**
 * Publishes one team's events in order, EVENTS_PER_PUBLISH at a time. Returns
 * how many went out and the first one that didn't, if any; nothing after a
 * failure is sent, so the retry keeps the order.
 */
async function publishTeam(deps: PublisherDeps, teamId: string, events: readonly Outgoing[]): Promise<{ sent: number; firstFailed?: Outgoing }> {
  const channel = teamChannel(teamId) as string;
  let sent = 0;
  for (let i = 0; i < events.length; i += EVENTS_PER_PUBLISH) {
    const chunk = events.slice(i, i + EVENTS_PER_PUBLISH);
    try {
      const result = await deps.publish(channel, chunk.map((e) => e.payload));
      const ok = new Set(result.successful);
      const failedAt = chunk.findIndex((_, j) => !ok.has(j));
      if (failedAt === -1) {
        sent += chunk.length;
        continue;
      }
      const reasons = result.failed.map((f) => f.code ?? f.message ?? "unknown");
      deps.obs.logger.error("AppSync refused events", { teamId, refused: chunk.length - ok.size, reasons: reasons.join(",") });
      return { sent: sent + failedAt, firstFailed: chunk[failedAt] };
    } catch (error) {
      deps.obs.logger.error("Publish failed", { teamId, error: (error as Error).message });
      return { sent, firstFailed: chunk[0] };
    }
  }
  return { sent };
}

export function createPublisherHandler(deps: PublisherDeps) {
  return async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
    const records = event.Records ?? [];
    const events = outgoing(records, deps.obs);
    const byTeam = new Map<string, Outgoing[]>();
    for (const e of events) {
      const list = byTeam.get(e.teamId) ?? [];
      list.push(e);
      byTeam.set(e.teamId, list);
    }
    const results = await Promise.all([...byTeam].map(([teamId, list]) => publishTeam(deps, teamId, list)));

    const sent = results.reduce((n, r) => n + r.sent, 0);
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
      sent,
      failed: unsent,
      // Seconds precision: a rough lag. docs/api/realtime.md says how to measure delivery end to end
      ...(Number.isFinite(oldest) ? { lagMs: Date.now() - oldest * 1000 } : {}),
    });
    return { batchItemFailures: earliest ? [{ itemIdentifier: earliest.sequenceNumber }] : [] };
  };
}
