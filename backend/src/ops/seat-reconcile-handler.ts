// The nightly seat reconciliation (supply-checkout-l50), run on a schedule in
// the primary region.
//
// Every team's seat quantity should already equal its billed members: each
// membership change queues a seat sync (billing/seats.ts). This catches what
// that missed (a sync that couldn't be queued, one that went to the
// dead-letter queue, a change made outside the account API such as a restore
// removing a deleted user). It lists the open teams with a Stripe customer
// from the operators' index (listTeamsToReconcile, reading only keys, the
// customer, closure and status) and queues a seat sync with reason
// `reconcile` for each on the seat sync queue. The billing worker does the
// comparison: where the quantity is wrong it counts SeatQuantityDrift (the
// "Seat counts drifting" alarm), logs the IDs and both numbers, and fixes it.
//
// So this function can't read a team's members or call Stripe: it may Query
// GSI3's OPS#TEAMS partition for SEAT_RECONCILE_ATTRIBUTES and send to the
// seat sync queue (infra/lib/observability/ops-checks.ts). It sends the number
// of teams it queued as the SeatReconcileTeams gauge, zero included, whose
// absence alarms ("Seat reconciliation not running").
//
// Deduplication: one message per customer per UTC day, so a second run the
// same day (by hand, after a deploy) within SQS's five minutes queues nothing
// twice. A run after that queues the same message IDs again, as new SQS
// messages: the worker folds the SQS message ID into Stripe's idempotency key
// (billing/seats.ts), so it never replays an update Stripe cached from the
// earlier run. If some messages aren't accepted, the rest still go, and the run
// throws at the end (the Lambda errors metric), naming how many.
//
// When the nightly entitlement reconciliation (supply-checkout-8jc.9) lands,
// it can queue its own checks from this same listing, or fold this in.

import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { SeatSyncMessage } from "../billing/seat-queue.js";
import { type Db, listTeamsToReconcile } from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { SEAT_RECONCILE_BATCH } from "./names.js";

/** What the reconciliation needs from an SQS client. */
export interface BatchSender {
  send(command: SendMessageBatchCommand): Promise<{ readonly Failed?: readonly { readonly Id?: string; readonly Code?: string }[] }>;
}

export interface SeatReconcileDeps {
  readonly db: Db;
  readonly queueUrl: string;
  readonly sqs?: BatchSender;
  readonly obs: Observability;
  readonly now?: () => number;
}

export function createSeatReconcileHandler(deps: SeatReconcileDeps) {
  const { db, obs } = deps;
  const now = deps.now ?? Date.now;
  const sqs = deps.sqs ?? (new SQSClient({}) as unknown as BatchSender);
  return async (): Promise<{ queued: number }> => {
    const at = now();
    const day = new Date(at).toISOString().slice(0, 10);
    const teams = await listTeamsToReconcile(db);
    let queued = 0;
    const failures: string[] = [];
    for (let i = 0; i < teams.length; i += SEAT_RECONCILE_BATCH) {
      const batch = teams.slice(i, i + SEAT_RECONCILE_BATCH);
      const entries = batch.map((team, n) => {
        const message: SeatSyncMessage = { kind: "seats", id: `reconcile-${day}-${team.stripeCustomerId}`, customer: team.stripeCustomerId, reason: "reconcile", created: Math.floor(at / 1000) };
        return { Id: String(n), MessageBody: JSON.stringify(message), MessageGroupId: team.stripeCustomerId, MessageDeduplicationId: message.id };
      });
      const result = await sqs.send(new SendMessageBatchCommand({ QueueUrl: deps.queueUrl, Entries: entries }));
      const failed = result.Failed ?? [];
      queued += entries.length - failed.length;
      for (const f of failed) {
        const team = batch[Number(f.Id)];
        failures.push(f.Code ?? "Unknown");
        obs.logger.warn("Seat reconciliation not queued", { teamId: team?.teamId ?? "", code: f.Code ?? "Unknown" });
      }
    }
    obs.gauge(BusinessMetric.SeatReconcileTeams, queued);
    obs.logger.info("Seat reconciliation queued", { teams: teams.length, queued, failed: failures.length });
    if (failures.length) throw new Error(`${failures.length} seat reconciliation messages weren't queued (${[...new Set(failures)].join(",")})`);
    return { queued };
  };
}
