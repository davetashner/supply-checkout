// The Stripe webhook (src/billing/webhook-handler.ts): verify, enqueue, then
// 200; a bad signature is 400 and counted; a queue failure is 500 so Stripe
// retries; events we don't handle are dropped with a 200.

import type { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import Stripe from "stripe";
import { beforeEach, describe, expect, it } from "vitest";
import { sqsBillingQueue } from "../src/billing/queue.js";
import { type BillingMessage, createWebhookHandler, messageFor, WEBHOOK_ROUTE_KEY } from "../src/billing/webhook-handler.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { REGION } from "./helpers.js";

// Made up: the right shape, never real
const SECRET = `whsec_${"s".repeat(32)}`;
const NOW_MS = Date.parse("2026-09-27T12:00:00Z");

let queued: { message: BillingMessage; group: string; dedup: string }[];
let queueFails: boolean;
let counts: Record<string, number>;
let logs: unknown[][];
let handler: ReturnType<typeof createWebhookHandler>;

function obs(): Observability {
  return {
    region: REGION,
    logger: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), addContext: () => {} } as unknown as Observability["logger"],
    count: (m, v = 1) => {
      counts[m] = (counts[m] ?? 0) + v;
    },
    gauge: () => {},
    flush: () => {},
  };
}

beforeEach(() => {
  queued = [];
  queueFails = false;
  counts = {};
  logs = [];
  handler = createWebhookHandler({
    secret: async () => SECRET,
    queue: async (message, group, dedup) => {
      if (queueFails) throw Object.assign(new Error("SQS is down"), { name: "ServiceUnavailable" });
      queued.push({ message, group, dedup });
    },
    mode: "test",
    obs: obs(),
    now: () => NOW_MS,
  });
});

function stripeEvent(type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id: "evt_test_1", object: "event", type, created: NOW_MS / 1000 - 5, livemode: false, api_version: Stripe.API_VERSION, data: { object, ...extra }, ...(extra.top as object) };
}

function request(payload: string, options: { signature?: string | null; secret?: string; base64?: boolean; routeKey?: string; timestamp?: number } = {}): APIGatewayProxyEventV2 {
  const signature =
    options.signature === null ? undefined : (options.signature ?? Stripe.webhooks.generateTestHeaderString({ payload, secret: options.secret ?? SECRET, timestamp: options.timestamp ?? NOW_MS / 1000 }));
  return {
    version: "2.0",
    routeKey: options.routeKey ?? WEBHOOK_ROUTE_KEY,
    rawPath: "/billing/webhook",
    rawQueryString: "",
    headers: { "content-type": "application/json", ...(signature ? { "Stripe-Signature": signature } : {}) },
    body: options.base64 ? Buffer.from(payload).toString("base64") : payload,
    isBase64Encoded: options.base64 ?? false,
    requestContext: {} as never,
  } as APIGatewayProxyEventV2;
}

const SUB = { id: "sub_test_1", object: "subscription", customer: "cus_test_1", status: "active", trial_end: null };

describe("POST /billing/webhook", () => {
  it("verifies the signature, queues the event's IDs grouped by customer and deduplicated by event, then answers 200", async () => {
    const payload = JSON.stringify(stripeEvent("customer.subscription.updated", { ...SUB, status: "past_due", customer_email: "owner@example.com" }, { previous_attributes: { status: "active" } }));
    const response = await handler(request(payload));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body as string)).toEqual({ received: true });
    expect(queued).toEqual([
      {
        message: { eventId: "evt_test_1", type: "customer.subscription.updated", created: NOW_MS / 1000 - 5, customer: "cus_test_1", subscription: "sub_test_1", status: "past_due", previousStatus: "active" },
        group: "cus_test_1",
        dedup: "evt_test_1",
      },
    ]);
    // Nothing about the customer beyond IDs goes on the queue or in the logs
    expect(JSON.stringify([queued, logs])).not.toContain("example.com");
  });

  it("takes a base64 body as the same bytes", async () => {
    const payload = JSON.stringify(stripeEvent("customer.subscription.created", { ...SUB, status: "trialing" }));
    expect((await handler(request(payload, { base64: true }))).statusCode).toBe(200);
    expect(queued).toHaveLength(1);
  });

  it.each([
    ["no signature", { signature: null }],
    ["another secret's signature", { secret: `whsec_${"x".repeat(32)}` }],
    ["a garbled header", { signature: "t=1,v1=nope" }],
    ["a signature older than five minutes", { timestamp: NOW_MS / 1000 - 301 }],
  ])("refuses %s with 400, counts it, and queues nothing", async (_what, options) => {
    const payload = JSON.stringify(stripeEvent("customer.subscription.updated", SUB));
    const response = await handler(request(payload, options));
    expect(response.statusCode).toBe(400);
    expect(counts[BusinessMetric.WebhookSignatureFailures]).toBe(1);
    expect(queued).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it("refuses a body that was changed after it was signed", async () => {
    const payload = JSON.stringify(stripeEvent("customer.subscription.updated", SUB));
    const event = request(payload);
    event.body = payload.replace("cus_test_1", "cus_test_2");
    expect((await handler(event)).statusCode).toBe(400);
    expect(queued).toEqual([]);
  });

  it("answers 500 when the queue won't take a verified event, so Stripe sends it again", async () => {
    queueFails = true;
    const response = await handler(request(JSON.stringify(stripeEvent("invoice.payment_failed", { customer: "cus_test_1", parent: { subscription_details: { subscription: "sub_test_1" } } }))));
    expect(response.statusCode).toBe(500);
    expect(logs.find((l) => l[0] === "Webhook failed")?.[1]).toEqual({ code: "ServiceUnavailable" });
  });

  it("answers 500 when the signing secret can't be read", async () => {
    handler = createWebhookHandler({ secret: () => Promise.reject(Object.assign(new Error("x"), { name: "AccessDeniedException" })), queue: async () => {}, mode: "test", obs: obs() });
    expect((await handler(request("{}"))).statusCode).toBe(500);
  });

  it("drops, with a 200, events it doesn't handle and events from the other mode", async () => {
    expect((await handler(request(JSON.stringify(stripeEvent("customer.created", { id: "cus_test_1" }))))).statusCode).toBe(200);
    const live = { ...stripeEvent("customer.subscription.updated", SUB), livemode: true };
    expect((await handler(request(JSON.stringify(live))))).toMatchObject({ statusCode: 200 });
    expect(queued).toEqual([]);
    expect(logs.filter((l) => l[0] === "Webhook dropped").map((l) => (l[1] as { reason: string }).reason)).toEqual(["unhandled_type", "other_mode"]);
  });

  it("refuses a body over the size limit and unknown routes", async () => {
    expect((await handler(request("x".repeat(1_000_001)))).statusCode).toBe(413);
    expect((await handler(request("{}", { routeKey: "POST /billing/other" }))).statusCode).toBe(404);
  });
});

describe("messageFor", () => {
  const event = (type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) => stripeEvent(type, object, extra) as unknown as Stripe.Event;

  it("takes a completed subscription checkout's subscription, and drops other checkouts", () => {
    expect(messageFor(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1" }), "test")).toMatchObject({ subscription: "sub_test_1" });
    expect(messageFor(event("checkout.session.completed", { mode: "subscription", customer: { id: "cus_test_1" }, subscription: { id: "sub_test_1" } }), "test")).toMatchObject({ customer: "cus_test_1", subscription: "sub_test_1" });
    expect(messageFor(event("checkout.session.completed", { mode: "payment", customer: "cus_test_1" }), "test")).toEqual({ drop: "not_subscription" });
    expect(messageFor(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: null }), "test")).toEqual({ drop: "no_subscription" });
  });

  it("takes an invoice's subscription from its parent, and when Stripe will try again", () => {
    expect(messageFor(event("invoice.payment_failed", { customer: "cus_test_1", next_payment_attempt: 1_800_000_000, parent: { subscription_details: { subscription: "sub_test_1" } } }), "test")).toMatchObject({ subscription: "sub_test_1", nextAttempt: 1_800_000_000 });
    expect(messageFor(event("invoice.paid", { customer: "cus_test_1", parent: { subscription_details: { subscription: "sub_test_1" } } }), "test")).not.toHaveProperty("nextAttempt");
    expect(messageFor(event("invoice.paid", { customer: "cus_test_1", parent: null }), "test")).toEqual({ drop: "no_subscription" });
  });

  it("takes a subscription's status, its previous status and the trial's end", () => {
    expect(messageFor(event("customer.subscription.trial_will_end", { ...SUB, status: "trialing", trial_end: 1_800_000_000 }), "test")).toMatchObject({ status: "trialing", trialEnd: 1_800_000_000 });
    expect(messageFor(event("customer.subscription.updated", { ...SUB, trial_end: 1_800_000_000 }), "test")).not.toHaveProperty("trialEnd");
    expect(messageFor(event("customer.subscription.deleted", { ...SUB, id: "bad id", status: "canceled" }), "test")).toEqual({ drop: "no_subscription" });
    expect(messageFor(event("customer.subscription.updated", { ...SUB, status: "x".repeat(65) }), "test")).not.toHaveProperty("status");
  });

  it("drops an event without a customer ID it can use", () => {
    expect(messageFor(event("customer.subscription.updated", { ...SUB, customer: null }), "test")).toEqual({ drop: "no_customer" });
    expect(messageFor(event("customer.subscription.updated", { ...SUB, customer: "cus#1" }), "test")).toEqual({ drop: "no_customer" });
    expect(messageFor({ ...event("customer.subscription.updated", SUB), livemode: true } as Stripe.Event, "live")).toMatchObject({ customer: "cus_test_1" });
  });
});

describe("sqsBillingQueue", () => {
  it("sends one FIFO message per event", async () => {
    const sent: SendMessageCommand["input"][] = [];
    const queue = sqsBillingQueue("https://sqs.example/queue.fifo", { send: async (command: SendMessageCommand) => sent.push(command.input) });
    const message: BillingMessage = { eventId: "evt_test_1", type: "invoice.paid", created: 1, customer: "cus_test_1", subscription: "sub_test_1" };
    await queue(message, "cus_test_1", "evt_test_1");
    expect(sent).toEqual([{ QueueUrl: "https://sqs.example/queue.fifo", MessageBody: JSON.stringify(message), MessageGroupId: "cus_test_1", MessageDeduplicationId: "evt_test_1" }]);
    expect(sqsBillingQueue("https://sqs.example/queue.fifo")).toBeTypeOf("function");
  });
});
