// The billing API (POST /teams/{teamId}/billing/checkout) against the
// in-memory table and a fake Stripe. Each request's handles pass only the
// calls the billing-access role allows for their session tags
// (test/billing-policy.ts), so a call outside them fails as IAM would refuse it.

import { beforeEach, describe, expect, it } from "vitest";
import type { BillingScope, DbForBilling } from "../src/api/billing-db.js";
import { type CheckoutSessionParams, type CheckoutStripe, createBillingHandler, idempotencyKey, trialEnd } from "../src/api/billing-handler.js";
import type { DataEvent } from "../src/api/data-handler.js";
import { BILLING_ROUTES, routeKey } from "../src/api/routes.js";
import { priceResolver, type StripePriceLike } from "../src/billing/prices.js";
import { MEMBERS_PER_TEAM, TRIAL_DAYS } from "../src/data/index.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import Stripe from "stripe";
import { billingPolicy } from "./billing-policy.js";
import { REGION } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_pool";
const APP = "https://app.example.test";
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const OWNER = "user-owner";
const CONTRIBUTOR = "user-contributor";
const VIEWER = "user-viewer";
const OUTSIDER = "user-outsider";
const TEAM = "team-a";
const KEY = "checkout-key-1";
const PATH = `/teams/${TEAM}/billing/checkout`;

const PRICES: StripePriceLike[] = [
  { id: "price_monthly", lookup_key: "supply_checkout_starter_monthly", active: true, currency: "usd", product: "supply_checkout_starter", recurring: { interval: "month" } },
  { id: "price_annual", lookup_key: "supply_checkout_starter_annual", active: true, currency: "usd", product: { id: "supply_checkout_starter" }, recurring: { interval: "year" } },
];

let table: MemoryTable;
let now: number;
let counts: Record<string, number>;
let logs: unknown[][];
let scopes: BillingScope[];
let denied: { command: string; input: Record<string, unknown> }[];
let stripe: ReturnType<typeof fakeStripe>;
let handler: ReturnType<typeof createBillingHandler>;

function fakeStripe() {
  const state = {
    customers: [] as { params: { name: string; metadata: Record<string, string> }; key: string }[],
    sessions: [] as { params: CheckoutSessionParams; key: string }[],
    lists: 0,
    prices: [...PRICES],
    sessionError: undefined as Error | undefined,
    noUrl: false,
    /** Runs after a customer is made, before it's linked: another request's link. */
    afterCustomer: undefined as (() => void) | undefined,
  };
  const client: CheckoutStripe = {
    customers: {
      async create(params, options) {
        state.customers.push({ params, key: options.idempotencyKey });
        state.afterCustomer?.();
        return { id: `cus_test_${state.customers.length}` };
      },
    },
    prices: {
      async list(params) {
        state.lists++;
        return { data: state.prices.filter((p) => params.lookup_keys.includes(p.lookup_key as string) && (!params.active || p.active)) };
      },
    },
    checkout: {
      sessions: {
        async create(params, options) {
          if (state.sessionError) throw state.sessionError;
          state.sessions.push({ params, key: options.idempotencyKey });
          // Stripe's default: a day
          return { id: `cs_test_${state.sessions.length}`, url: state.noUrl ? null : `https://checkout.stripe.test/c/pay/cs_test_${state.sessions.length}`, expires_at: Math.floor(now / 1000) + 86400 };
        },
      },
    },
  };
  return { client, state };
}

function fakeObservability(): Observability {
  return {
    region: REGION,
    logger: {
      info: (...a: unknown[]) => logs.push(a),
      warn: (...a: unknown[]) => logs.push(a),
      error: (...a: unknown[]) => logs.push(a),
      addContext: () => {},
    } as unknown as Observability["logger"],
    count: (metric, value = 1) => {
      counts[metric] = (counts[metric] ?? 0) + value;
    },
    gauge: () => {},
    flush: () => {},
  };
}

function build(options: { stripeFails?: Error } = {}) {
  const dbFor: DbForBilling = (scope) => {
    scopes.push(scope);
    return table.guarded(billingPolicy(scope, denied));
  };
  const client = () => (options.stripeFails ? Promise.reject(options.stripeFails) : Promise.resolve(stripe.client));
  handler = createBillingHandler({ dbFor, stripe: client, priceFor: priceResolver(client, { now: () => now }), issuerUrl: ISSUER, appUrl: APP, obs: fakeObservability(), now: () => now });
}

beforeEach(() => {
  now = Date.parse("2026-09-27T12:00:00Z");
  counts = {};
  logs = [];
  scopes = [];
  denied = [];
  table = new MemoryTable();
  table.seedTeam(TEAM, { [OWNER]: "owner", [CONTRIBUTOR]: "contributor", [VIEWER]: "viewer" });
  table.seedTeam("team-b", { [OUTSIDER]: "owner" });
  // A team made a day ago, 13 days left of its trial
  patchTeam({ name: "Echo Plumbing", plan: "trial", seats: 1, status: "trialing", createdAt: new Date(now - DAY).toISOString(), trialEndsAt: new Date(now + 13 * DAY).toISOString() });
  stripe = fakeStripe();
  build();
});

function patchTeam(fields: Record<string, unknown>, team = TEAM) {
  const meta = table.get(`TEAM#${team}`, "META") as Record<string, unknown>;
  const next = Object.fromEntries(Object.entries({ ...meta, ...fields }).filter(([, v]) => v !== undefined));
  table.put(next);
}

interface Request {
  readonly user?: string;
  readonly claims?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly teamId?: string;
  readonly routeKey?: string;
}

function event(request: Request = {}): DataEvent {
  const user = request.user ?? OWNER;
  const claims = request.claims ?? { sub: user, token_use: "access", exp: String(Math.floor(now / 1000) + 600), iss: ISSUER, client_id: "web" };
  const teamId = request.teamId ?? TEAM;
  return {
    version: "2.0",
    routeKey: request.routeKey ?? routeKey(BILLING_ROUTES[0] as (typeof BILLING_ROUTES)[number]),
    rawPath: `/teams/${teamId}/billing/checkout`,
    rawQueryString: "",
    headers: { authorization: `Bearer token-${user}`, "idempotency-key": KEY, ...request.headers },
    pathParameters: { teamId },
    body: request.rawBody ?? (request.body === undefined ? JSON.stringify({ plan: "starter", interval: "month", seats: 3 }) : JSON.stringify(request.body)),
    isBase64Encoded: false,
    requestContext: {
      http: { method: "POST", path: PATH, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" },
      authorizer: { principalId: "", integrationLatency: 0, jwt: { claims, scopes: null } },
    },
  } as unknown as DataEvent;
}

async function checkout(request: Request = {}) {
  const response = await handler(event(request));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

const meta = () => table.get(`TEAM#${TEAM}`, "META") as Record<string, unknown>;

describe("POST /teams/{teamId}/billing/checkout", () => {
  it("makes the team's Stripe customer, links it, and starts Checkout in the free trial without a card", async () => {
    const { status, body } = await checkout();
    expect(status).toBe(201);
    expect(body).toEqual({
      checkout: {
        url: "https://checkout.stripe.test/c/pay/cs_test_1",
        expiresAt: new Date(Math.floor(now / 1000) * 1000 + DAY).toISOString(),
        trialEndsAt: new Date(now + 13 * DAY).toISOString(),
      },
    });
    // One customer, once per team, named after the team
    expect(stripe.state.customers).toEqual([{ params: { name: "Echo Plumbing", metadata: { teamId: TEAM } }, key: idempotencyKey("customer", TEAM, { name: "Echo Plumbing", metadata: { teamId: TEAM } }) }]);
    expect(meta().stripeCustomerId).toBe("cus_test_1");
    expect(table.get("STRIPE#cus_test_1", "TEAM")).toEqual({ PK: "STRIPE#cus_test_1", SK: "TEAM", type: "stripeLink", customerId: "cus_test_1", teamId: TEAM });
    // The plan, status and seats are the webhook's to change, not the checkout's
    expect(meta()).toMatchObject({ plan: "trial", status: "trialing", seats: 1 });
    const [session] = stripe.state.sessions;
    expect(session?.params).toEqual({
      mode: "subscription",
      customer: "cus_test_1",
      client_reference_id: TEAM,
      line_items: [{ price: "price_monthly", quantity: 3 }],
      success_url: `${APP}/?billing=success&team=${TEAM}`,
      cancel_url: `${APP}/?billing=canceled&team=${TEAM}`,
      metadata: { teamId: TEAM },
      payment_method_collection: "if_required",
      billing_address_collection: "auto",
      customer_update: { address: "auto", name: "auto" },
      subscription_data: {
        metadata: { teamId: TEAM, plan: "starter" },
        trial_end: Math.floor((now + 13 * DAY) / 1000),
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
      },
    });
    expect(session?.key).toBe(idempotencyKey("checkout", TEAM, { key: KEY, customer: "cus_test_1", priceId: "price_monthly", seats: 3, trial: Math.floor((now + 13 * DAY) / 1000) }));
    // Every handle was scoped to the path's team; only the link's also named the customer
    expect(scopes).toEqual([{ teamId: TEAM }, { teamId: TEAM }, { teamId: TEAM, stripeCustomer: "cus_test_1" }]);
    expect(denied).toEqual([]);
    expect(counts[BusinessMetric.CheckoutSessionErrors]).toBeUndefined();
    expect(JSON.stringify(logs)).not.toContain("Echo Plumbing");
  });

  it("reuses the linked customer, and the annual price, on the next checkout", async () => {
    await checkout();
    const { status } = await checkout({ body: { plan: "starter", interval: "year", seats: 5 }, headers: { "idempotency-key": "checkout-key-2" } });
    expect(status).toBe(201);
    expect(stripe.state.customers).toHaveLength(1);
    expect(stripe.state.sessions[1]?.params).toMatchObject({ customer: "cus_test_1", line_items: [{ price: "price_annual", quantity: 5 }] });
    expect(scopes.filter((s) => s.stripeCustomer)).toHaveLength(1);
  });

  it("gives a retry with the same Idempotency-Key and choices the same Stripe idempotency key, and new choices a new one", async () => {
    await checkout();
    await checkout();
    await checkout({ body: { plan: "starter", interval: "month", seats: 4 } });
    const [a, b, c] = stripe.state.sessions.map((s) => s.key);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    // Prices are looked up once, then kept
    expect(stripe.state.lists).toBe(1);
  });

  it("asks for a card when less than two days of the trial are left", async () => {
    patchTeam({ trialEndsAt: new Date(now + 47 * HOUR).toISOString() });
    const { status, body } = await checkout();
    expect(status).toBe(201);
    expect(body.checkout.trialEndsAt).toBeNull();
    const params = stripe.state.sessions[0]?.params as CheckoutSessionParams;
    expect(params.payment_method_collection).toBe("always");
    expect(params.subscription_data).toEqual({ metadata: { teamId: TEAM, plan: "starter" } });
  });

  it("asks for a card after the trial", async () => {
    patchTeam({ trialEndsAt: new Date(now - DAY).toISOString() });
    await checkout();
    expect(stripe.state.sessions[0]?.params.payment_method_collection).toBe("always");
  });

  it("dates the trial from creation for a team from before trials", async () => {
    patchTeam({ trialEndsAt: undefined, createdAt: new Date(now - 2 * DAY).toISOString() });
    await checkout();
    expect(stripe.state.sessions[0]?.params.subscription_data.trial_end).toBe(Math.floor((now + (TRIAL_DAYS - 2) * DAY) / 1000));
  });

  it("works out the trial's end", () => {
    expect(trialEnd({ trialEndsAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z" })).toBe(Date.parse("2026-10-01T00:00:00.000Z"));
    expect(trialEnd({ createdAt: "2026-09-01T00:00:00.000Z" })).toBe(Date.parse("2026-09-15T00:00:00.000Z"));
    expect(trialEnd({ trialEndsAt: "soon", createdAt: "long ago" })).toBe(0);
  });

  it.each([
    [CONTRIBUTOR, "owners_only"],
    [VIEWER, "owners_only"],
    [OUTSIDER, "not_member"],
  ])("refuses %s (%s) before reading the body or calling Stripe", async (user, reason) => {
    const { status, body } = await checkout({ user, rawBody: "not json" });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ code: "permission_denied", reason });
    expect(stripe.state.customers).toHaveLength(0);
    expect(stripe.state.sessions).toHaveLength(0);
  });

  it("answers not_member for a team that doesn't exist, and 400 for a malformed team ID", async () => {
    expect((await checkout({ teamId: "team-nope" })).body.error.reason).toBe("not_member");
    const bad = await checkout({ teamId: "team#a" });
    expect(bad.status).toBe(400);
    expect(scopes).toEqual([{ teamId: "team-nope" }]);
  });

  it.each([
    [{} as Record<string, string>, "missing"],
    [{ "idempotency-key": "short" }, "too short"],
    [{ "idempotency-key": "has spaces in it" }, "not an ID"],
  ])("needs an Idempotency-Key (%j, %s)", async (headers: Record<string, string>) => {
    const e = event({ headers });
    if (!("idempotency-key" in headers)) delete (e.headers as Record<string, string>)["idempotency-key"];
    const response = await handler(e);
    expect(response.statusCode).toBe(400);
    expect(stripe.state.sessions).toHaveLength(0);
  });

  it.each([
    [{ plan: "starter", interval: "month", seats: 3, coupon: "FREE" }],
    [{ plan: "enterprise", interval: "month", seats: 3 }],
    [{ plan: "starter", interval: "week", seats: 3 }],
    [{ plan: 1, interval: "month", seats: 3 }],
    [{ plan: "starter", interval: "month" }],
    [{ plan: "starter", interval: "month", seats: 0 }],
    [{ plan: "starter", interval: "month", seats: MEMBERS_PER_TEAM + 1 }],
    [{ plan: "starter", interval: "month", seats: 2.5 }],
    [{ plan: "starter", interval: "month", seats: "3" }],
    [["starter"]],
  ])("refuses the body %j", async (body) => {
    const { status, body: answer } = await checkout({ body });
    expect(status).toBe(400);
    expect(answer.error.code).toBe("bad_request");
    expect(stripe.state.customers).toHaveLength(0);
  });

  it("refuses fewer seats than the team has members", async () => {
    const { status, body } = await checkout({ body: { plan: "starter", interval: "month", seats: 2 } });
    expect(status).toBe(400);
    expect(body.error.message).toContain("at least 3 seats");
  });

  it("allows as few as one seat for a team from before the member count", async () => {
    patchTeam({ members: undefined });
    expect((await checkout({ body: { plan: "starter", interval: "month", seats: 1 } })).status).toBe(201);
  });

  it("refuses a closed team", async () => {
    patchTeam({ closedAt: new Date(now - DAY).toISOString(), purgeAfter: new Date(now + 29 * DAY).toISOString() });
    const { status, body } = await checkout();
    expect(status).toBe(403);
    expect(body.error.reason).toBe("team_closed");
    expect(stripe.state.customers).toHaveLength(0);
  });

  it.each(["trialing", "active", "past_due", "incomplete"])("refuses a team whose subscription is %s", async (status) => {
    patchTeam({ stripeCustomerId: "cus_test_9", stripeSubscriptionId: "sub_test_1", status });
    const answer = await checkout();
    expect(answer.status).toBe(409);
    expect(answer.body.error.reason).toBe("already_subscribed");
    expect(stripe.state.sessions).toHaveLength(0);
  });

  it("lets a team whose subscription ended subscribe again, with the same customer and a card", async () => {
    patchTeam({ stripeCustomerId: "cus_test_9", stripeSubscriptionId: "sub_test_1", status: "canceled", trialEndsAt: new Date(now - 20 * DAY).toISOString() });
    expect((await checkout()).status).toBe(201);
    expect(stripe.state.customers).toHaveLength(0);
    expect(stripe.state.sessions[0]?.params).toMatchObject({ customer: "cus_test_9", payment_method_collection: "always" });
  });

  it("uses the customer another request linked meanwhile", async () => {
    stripe.state.afterCustomer = () => {
      patchTeam({ stripeCustomerId: "cus_test_other" });
    };
    const { status } = await checkout();
    expect(status).toBe(201);
    expect(stripe.state.sessions[0]?.params.customer).toBe("cus_test_other");
    expect(table.get("STRIPE#cus_test_1", "TEAM")).toBeUndefined();
  });

  it("answers 409 if the link fails and no customer is linked", async () => {
    // Another team already has this customer (it can't move): the link's condition fails
    table.put({ PK: "STRIPE#cus_test_1", SK: "TEAM", type: "stripeLink", customerId: "cus_test_1", teamId: "team-b" });
    const { status, body } = await checkout();
    expect(status).toBe(409);
    expect(body.error.code).toBe("aborted");
    expect(meta().stripeCustomerId).toBeUndefined();
    expect(stripe.state.sessions).toHaveLength(0);
  });

  it("fails with 500, counts it and logs no Stripe message when Stripe fails", async () => {
    stripe.state.sessionError = new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", message: "No such customer: 'cus_secret_detail'", code: "resource_missing", statusCode: 400, requestId: "req_1" } as never);
    const { status, body } = await checkout();
    expect(status).toBe(500);
    expect(body.error).toEqual({ code: "internal", message: "Something went wrong" });
    expect(counts[BusinessMetric.CheckoutSessionErrors]).toBe(1);
    const failed = logs.find((l) => l[0] === "Checkout failed");
    expect(failed?.[1]).toEqual({ teamId: TEAM, type: "StripeInvalidRequestError", code: "resource_missing", status: 400, requestId: "req_1" });
    expect(JSON.stringify(logs)).not.toContain("cus_secret_detail");
  });

  it("fails with 500 when the price isn't in Stripe as the catalog says", async () => {
    stripe.state.prices = [{ ...(PRICES[0] as StripePriceLike), recurring: { interval: "year" } }];
    const { status } = await checkout();
    expect(status).toBe(500);
    expect(logs.find((l) => l[0] === "Checkout failed")?.[1]).toMatchObject({ teamId: TEAM, reason: "price_not_found", code: "PriceNotFoundError" });
    expect(stripe.state.customers).toHaveLength(0);
  });

  it("fails with 500 when the Stripe key can't be read, without logging why in detail", async () => {
    build({ stripeFails: new Error("The Stripe secret holds a live key, not a test-mode key") });
    const { status } = await checkout();
    expect(status).toBe(500);
    expect(counts[BusinessMetric.CheckoutSessionErrors]).toBe(1);
    expect(logs.find((l) => l[0] === "Checkout failed")?.[1]).toEqual({ teamId: TEAM, code: "Error" });
  });

  it("fails with 500 when Stripe returns a session without a URL", async () => {
    stripe.state.noUrl = true;
    expect((await checkout()).status).toBe(500);
  });

  it("refuses tokens from another issuer, ID tokens, expired tokens and unknown routes", async () => {
    const exp = String(Math.floor(now / 1000) + 600);
    expect((await checkout({ claims: { sub: OWNER, token_use: "access", exp, iss: "https://elsewhere.example" } })).status).toBe(401);
    expect((await checkout({ claims: { sub: OWNER, token_use: "id", exp, iss: ISSUER } })).status).toBe(401);
    expect((await checkout({ claims: { sub: OWNER, token_use: "access", exp: "1", iss: ISSUER } })).status).toBe(401);
    expect((await checkout({ routeKey: "POST /teams/{teamId}/billing/portal" })).status).toBe(404);
    expect(scopes).toEqual([]);
    // No team ID to log for a request that never named a valid one
    const e = event();
    e.pathParameters = {};
    stripe.state.sessionError = new Error("boom");
    expect((await handler(e)).statusCode).toBe(400);
  });
});
