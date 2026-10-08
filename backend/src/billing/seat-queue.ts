// The seat sync queue's message, its check and its sender (see seats.ts for
// what the billing worker does with one). Imports no data code, so the
// functions that only send seat syncs (the account function, the ops
// function) bundle nothing that reads a team.

import { randomUUID } from "node:crypto";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

/**
 * Why a seat sync was queued: a membership change, the nightly reconciliation, a Stripe event for the
 * subscription, or the team just closed (`closed`: not a seat sync, the worker sets the team's
 * subscription to end instead; worker.ts, endAtClose, supply-checkout-8jc.30), or an operator changed
 * the team's comp (`comp`: not a seat sync either, the worker makes the subscription's comp discount
 * match the comp; billing/comp-discount.ts, supply-checkout-6e4b).
 */
export const SEAT_SYNC_REASONS = ["membership", "reconcile", "subscription", "closed", "comp"] as const;
export type SeatSyncReason = (typeof SEAT_SYNC_REASONS)[number];

/** A seat sync on the seat sync queue. It names only the Stripe customer: the worker finds the team from our own link. */
export interface SeatSyncMessage {
  readonly kind: "seats";
  /** Unique per sync: the worker's session tag, and part of the Stripe idempotency key. */
  readonly id: string;
  readonly customer: string;
  readonly reason: SeatSyncReason;
  /** When it was queued (epoch seconds). */
  readonly created: number;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A seat sync queue message, checked. The account function and the reconciliation wrote it, but the worker trusts no shape it didn't check. */
export function parseSeatSync(body: string): SeatSyncMessage {
  const m = JSON.parse(body) as Record<string, unknown> | null;
  const ok =
    typeof m === "object" &&
    m !== null &&
    m.kind === "seats" &&
    typeof m.id === "string" &&
    ID.test(m.id) &&
    typeof m.customer === "string" &&
    ID.test(m.customer) &&
    (SEAT_SYNC_REASONS as readonly unknown[]).includes(m.reason) &&
    typeof m.created === "number";
  if (!ok) throw new Error("Not a seat sync message");
  return { kind: "seats", id: m.id as string, customer: m.customer as string, reason: m.reason as SeatSyncReason, created: m.created as number };
}

/** The nightly reconciliation's seat sync ID for a customer on a UTC day (YYYY-MM-DD): its message ID and SQS deduplication ID. */
export function reconcileSeatSyncId(day: string, customer: string): string {
  return `reconcile-${day}-${customer}`;
}

const RECONCILE_ID = /^reconcile-\d{4}-\d{2}-\d{2}-(.+)$/;

/** The SQS attributes of a seat sync's delivery that its body must agree with. */
export interface SeatSyncDelivery {
  readonly MessageGroupId?: string;
  readonly MessageDeduplicationId?: string;
}

/**
 * Checks a seat sync against the record that delivered it (supply-checkout-8jc.26). Every sender groups
 * a seat sync by its customer and deduplicates it by its own ID, and the queue deduplicates within a
 * group (deduplicationScope MESSAGE_GROUP), so a message that could take the place of another
 * customer's sync, or of the nightly reconciliation's, is refused (it goes to the dead-letter queue):
 * - its group must be its customer, so its deduplication ID only ever drops that customer's syncs;
 * - its deduplication ID must be its own ID, so the ID the worker sees is the one SQS deduplicated by;
 * - a reconciliation ID (reconcileSeatSyncId) must be the reconciliation's for its customer, with reason
 *   `reconcile`, and reason `reconcile` must have one: whatever sent the ID first, the customer's
 *   reconciliation still happens.
 */
export function checkSeatSyncDelivery(message: SeatSyncMessage, delivery: SeatSyncDelivery): SeatSyncMessage {
  const reconcile = RECONCILE_ID.exec(message.id);
  const ok =
    delivery.MessageGroupId === message.customer &&
    delivery.MessageDeduplicationId === message.id &&
    (reconcile === null ? message.reason !== "reconcile" : message.reason === "reconcile" && reconcile[1] === message.customer);
  if (!ok) {
    const error = new Error("Seat sync doesn't match its delivery");
    error.name = "SeatSyncMismatch";
    throw error;
  }
  return message;
}

/** What sending a message to the seat sync queue needs from an SQS client: `send`, as SQSClient has it. */
export interface SeatQueueSender {
  send(command: SendMessageCommand): Promise<unknown>;
}

/** Queues a seat sync for a team's Stripe customer. */
export type SeatSyncQueue = (customer: string, reason: SeatSyncReason) => Promise<void>;

/**
 * Sends seat syncs to the seat sync queue (a FIFO queue): grouped by the
 * customer, so one team's syncs are handled one at a time, and deduplicated
 * by the message's own ID (within the customer's group; checkSeatSyncDelivery).
 */
export function sqsSeatSyncQueue(queueUrl: string, sqs: SeatQueueSender = new SQSClient({}), options: { readonly now?: () => number; readonly newId?: () => string } = {}): SeatSyncQueue {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => `seats-${randomUUID()}`);
  return async (customer, reason) => {
    if (!ID.test(customer)) throw new Error("Invalid Stripe customer ID");
    const message: SeatSyncMessage = { kind: "seats", id: newId(), customer, reason, created: Math.floor(now() / 1000) };
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message), MessageGroupId: customer, MessageDeduplicationId: message.id }));
  };
}
