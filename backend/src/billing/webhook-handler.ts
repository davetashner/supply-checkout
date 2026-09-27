// The Stripe webhook (ADR 0009, docs/infrastructure.md "Billing"):
//
//   POST /billing/webhook   Stripe's events. No Cognito token: the
//                           Stripe-Signature header, checked against the
//                           endpoint's signing secret, is the proof.
//
// In this order, and nothing else: verify the signature (400 if it doesn't
// match, counted as WebhookSignatureFailures), put the event on the billing
// queue, then answer 200. It records nothing: the worker (worker.ts) applies
// the event and only then records it as processed, so an event is never lost
// between the two. If the queue won't take it, the answer is 500 and Stripe
// retries. Events we don't handle (BILLING_EVENTS) are answered 200 and
// dropped, so Stripe doesn't retry them.
//
// The message holds only IDs, the event's type and time, and the statuses and
// dates the notices need: never a customer's name, email or address, which a
// Stripe event can carry. The queue is FIFO, grouped by Stripe customer (one
// team, one customer), so a customer's events are applied one at a time, in
// order, and deduplicated by event ID for SQS's five minutes; the worker's
// own record catches later repeats.
//
// Logged: the event's ID and type, and why it was dropped. Never the body,
// the signature or the secret.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import Stripe from "stripe";
import { ApiError, errorResponse, header, json, MAX_BODY_BYTES } from "../api/http.js";
import { routeKey, WEBHOOK_ROUTES } from "../api/routes.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { BILLING_EVENTS, type BillingEventType, type StripeMode } from "./names.js";

export const WEBHOOK_ROUTE_KEY = routeKey(WEBHOOK_ROUTES[0] as (typeof WEBHOOK_ROUTES)[number]);

/** What the webhook puts on the billing queue for the worker. */
export interface BillingMessage {
  readonly eventId: string;
  readonly type: BillingEventType;
  /** When Stripe made the event (epoch seconds). */
  readonly created: number;
  readonly customer: string;
  /** The subscription the event is about, when it's about one. */
  readonly subscription?: string;
  /** The subscription's status in the event, and before it (customer.subscription.updated). */
  readonly status?: string;
  readonly previousStatus?: string;
  /** When the trial ends (customer.subscription.trial_will_end), epoch seconds. */
  readonly trialEnd?: number;
  /** When Stripe will try the payment again (invoice.payment_failed), epoch seconds. */
  readonly nextAttempt?: number;
}

/** Sends one message to the billing queue (SQS FIFO). */
export type BillingQueue = (message: BillingMessage, group: string, deduplicationId: string) => Promise<void>;

export interface WebhookHandlerDeps {
  /** The endpoint's signing secret, from Secrets Manager (cachedSecret). */
  readonly secret: () => Promise<string>;
  readonly queue: BillingQueue;
  /** test or live: an event from the other mode is dropped. */
  readonly mode: StripeMode;
  readonly obs: Observability;
  /** Epoch milliseconds, for the signature's five-minute tolerance. For tests. */
  readonly now?: () => number;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const idOf = (value: unknown): string | undefined => {
  const found = typeof value === "string" ? value : typeof value === "object" && value !== null ? (value as { id?: unknown }).id : undefined;
  return typeof found === "string" && ID.test(found) ? found : undefined;
};
const numberOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const stringOf = (value: unknown): string | undefined => (typeof value === "string" && value.length <= 64 ? value : undefined);

/**
 * The queue message for a verified event: the IDs and fields the worker
 * needs, or a reason to drop it (a mode or payment we don't bill that way, or
 * no customer).
 */
export function messageFor(event: Stripe.Event, mode: StripeMode): BillingMessage | { readonly drop: string } {
  if (!(BILLING_EVENTS as readonly string[]).includes(event.type)) return { drop: "unhandled_type" };
  if (event.livemode !== (mode === "live")) return { drop: "other_mode" };
  const type = event.type as BillingEventType;
  const object = event.data.object as unknown as Record<string, unknown>;
  const customer = idOf(object.customer);
  if (!customer) return { drop: "no_customer" };
  const base = { eventId: event.id, type, created: event.created, customer };
  switch (type) {
    case "checkout.session.completed": {
      if (object.mode !== "subscription") return { drop: "not_subscription" };
      const subscription = idOf(object.subscription);
      return subscription ? { ...base, subscription } : { drop: "no_subscription" };
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      // Since API version 2025-03-31 the invoice names its subscription under parent
      const parent = object.parent as { subscription_details?: { subscription?: unknown } | null } | null | undefined;
      const subscription = idOf(parent?.subscription_details?.subscription);
      if (!subscription) return { drop: "no_subscription" };
      const nextAttempt = numberOf(object.next_payment_attempt);
      return { ...base, subscription, ...(nextAttempt !== undefined ? { nextAttempt } : {}) };
    }
    default: {
      // customer.subscription.*
      const subscription = idOf(object.id);
      if (!subscription) return { drop: "no_subscription" };
      const status = stringOf(object.status);
      const previousStatus = stringOf((event.data.previous_attributes as { status?: unknown } | undefined)?.status);
      const trialEnd = numberOf(object.trial_end);
      return {
        ...base,
        subscription,
        ...(status !== undefined ? { status } : {}),
        ...(previousStatus !== undefined ? { previousStatus } : {}),
        ...(type === "customer.subscription.trial_will_end" && trialEnd !== undefined ? { trialEnd } : {}),
      };
    }
  }
}

export function createWebhookHandler(deps: WebhookHandlerDeps) {
  const { obs } = deps;

  async function receive(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
    if (event.routeKey !== WEBHOOK_ROUTE_KEY) throw new ApiError(404, "not_found", "No such route");
    const raw = event.body ?? "";
    // The signature is over the exact bytes Stripe sent
    const payload = event.isBase64Encoded ? Buffer.from(raw, "base64") : Buffer.from(raw, "utf8");
    if (payload.byteLength > MAX_BODY_BYTES) throw new ApiError(413, "quota_exceeded", "Request body is too large");
    const signature = header(event, "stripe-signature");
    let verified: Stripe.Event;
    try {
      if (!signature) throw new Stripe.errors.StripeSignatureVerificationError(signature ?? "", payload, { message: "No Stripe-Signature header" });
      verified = Stripe.webhooks.constructEvent(payload, signature, await deps.secret(), undefined, undefined, deps.now?.());
    } catch (error) {
      // A bad or missing signature, or a body that isn't an event: someone other than Stripe,
      // or a signing secret that doesn't match the endpoint's (rotated, or the wrong mode)
      if (error instanceof Stripe.errors.StripeSignatureVerificationError || error instanceof SyntaxError) {
        obs.count(BusinessMetric.WebhookSignatureFailures);
        obs.logger.warn("Webhook signature refused", { code: error.name });
        throw new ApiError(400, "bad_request", "The Stripe-Signature header doesn't match");
      }
      throw error;
    }
    const message = messageFor(verified, deps.mode);
    if ("drop" in message) {
      obs.logger.info("Webhook dropped", { eventId: verified.id, type: verified.type, reason: message.drop });
      return json(200, { received: true });
    }
    // Only then 200: a failure here is a 500, and Stripe sends the event again
    await deps.queue(message, message.customer, message.eventId);
    obs.logger.info("Webhook queued", { eventId: message.eventId, type: message.type });
    return json(200, { received: true });
  }

  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    try {
      return await receive(event);
    } catch (error) {
      if (error instanceof ApiError) return errorResponse(error);
      // The queue or the secret: log the error's name only, and let Stripe retry
      obs.logger.error("Webhook failed", { code: (error as { name?: string } | null)?.name ?? "Unknown" });
      return errorResponse(new ApiError(500, "internal", "Something went wrong"));
    }
  };
}
