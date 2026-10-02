// The billing API (POST /teams/{teamId}/billing/checkout and /billing/portal) against the
// in-memory table and a fake Stripe. Each request's handles pass only the
// calls the billing-access role allows for their session tags
// (test/billing-policy.ts), so a call outside them fails as IAM would refuse it.

import { beforeEach, describe, expect, it } from "vitest";
import type { BillingScope, DbForBilling } from "../src/api/billing-db.js";
import { type BillingStripe, type CheckoutSessionParams, createBillingHandler, idempotencyKey, INVOICE_PAGE, type InvoiceLike, type PortalSessionParams, trialEnd } from "../src/api/billing-handler.js";
import type { CognitoUser } from "../src/api/cognito-user.js";
import type { DataEvent } from "../src/api/data-handler.js";
import { ApiError } from "../src/api/http.js";
import { BILLING_ROUTES, routeKey } from "../src/api/routes.js";
import { PORTAL_METADATA, type PortalConfigurationLike, type PortalConfigurationLister, portalConfigurationResolver } from "../src/billing/portal.js";
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
// GetUser: each user's two-step sign-in, by the user in the token ("token-<user>"); OUTSIDER's
// is on too. Tokens for a user not listed here are refused, as Cognito refuses a revoked one
let cognito: Record<string, Pick<CognitoUser, "totp" | "federated">>;
let getUsers: string[];

function fakeStripe() {
  const state = {
    customers: [] as { params: { name: string; metadata: Record<string, string> }; key: string }[],
    sessions: [] as { params: CheckoutSessionParams; key: string }[],
    lists: 0,
    prices: [...PRICES],
    /** The customer's subscriptions in Stripe, which the webhook may not have recorded yet. */
    subscriptions: [] as { status: string }[],
    subscriptionLists: [] as string[],
    sessionError: undefined as Error | undefined,
    noUrl: false,
    /** Runs after a customer is made, before it's linked: another request's link. */
    afterCustomer: undefined as (() => void) | undefined,
    portalSessions: [] as PortalSessionParams[],
    portalError: undefined as Error | undefined,
    configurations: [
      { id: "bpc_default", active: true, metadata: {} },
      { id: "bpc_old", active: false, metadata: { ...PORTAL_METADATA } },
      { id: "bpc_ours", active: true, metadata: { ...PORTAL_METADATA } },
    ] as PortalConfigurationLike[],
    configurationLists: 0,
    /** The customers' invoices in Stripe, newest first. */
    invoices: [] as (InvoiceLike & { customer: string })[],
    invoiceLists: [] as { customer: string; limit: number }[],
    invoiceError: undefined as Error | undefined,
  };
  const client: BillingStripe & PortalConfigurationLister = {
    billingPortal: {
      configurations: {
        async list(params) {
          state.configurationLists++;
          expect(params).toEqual({ active: true, limit: 100 });
          return { data: state.configurations };
        },
      },
      sessions: {
        async create(params) {
          if (state.portalError) throw state.portalError;
          state.portalSessions.push(params);
          return { id: `bps_test_${state.portalSessions.length}`, url: `https://billing.stripe.test/p/session/bps_test_${state.portalSessions.length}` };
        },
      },
    },
    invoices: {
      async list(params) {
        if (state.invoiceError) throw state.invoiceError;
        state.invoiceLists.push(params);
        const mine = state.invoices.filter((i) => i.customer === params.customer);
        return { data: mine.slice(0, params.limit), has_more: mine.length > params.limit };
      },
    },
    subscriptions: {
      async list(params) {
        state.subscriptionLists.push(params.customer);
        return { data: state.subscriptions };
      },
    },
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

function build(options: { stripeFails?: Error; refuse?: string } = {}) {
  const dbFor: DbForBilling = (scope) => {
    scopes.push(scope);
    const allowed = billingPolicy(scope, denied);
    return table.guarded((command, input) => command !== options.refuse && allowed(command, input));
  };
  const client = () => (options.stripeFails ? Promise.reject(options.stripeFails) : Promise.resolve(stripe.client));
  const userInfo = async (token: string): Promise<CognitoUser> => {
    getUsers.push(token);
    const sub = token.replace(/^token-/, "");
    const user = cognito[sub];
    if (!user) throw new ApiError(401, "unauthenticated", "Sign in again");
    return { sub, emailVerified: true, emailVerifiedInCognito: true, ...user };
  };
  handler = createBillingHandler({
    dbFor,
    userInfo,
    stripe: client,
    priceFor: priceResolver(client, { now: () => now }),
    portalConfiguration: portalConfigurationResolver(client, { now: () => now }),
    issuerUrl: ISSUER,
    appUrl: APP,
    obs: fakeObservability(),
    now: () => now,
  });
}

beforeEach(() => {
  now = Date.parse("2026-09-27T12:00:00Z");
  counts = {};
  logs = [];
  scopes = [];
  denied = [];
  const on = { totp: true, federated: false };
  cognito = { [OWNER]: on, [CONTRIBUTOR]: on, [VIEWER]: on, [OUTSIDER]: on };
  getUsers = [];
  table = new MemoryTable();
  table.seedTeam(TEAM, { [OWNER]: "owner", [CONTRIBUTOR]: "contributor", [VIEWER]: "viewer" });
  table.seedTeam("team-b", { [OUTSIDER]: "owner" });
  // When each user turned TOTP on (supply-checkout-8jc.14): a day ago
  for (const user of [OWNER, CONTRIBUTOR, VIEWER, OUTSIDER]) table.put({ PK: `USER#${user}`, SK: "TOTP_ON", totpOnAt: new Date(now - DAY).toISOString() });
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
  // Signed in a minute ago, after TOTP was turned on (TOTP_ON, a day ago: beforeEach)
  const claims = request.claims ?? { sub: user, token_use: "access", exp: String(Math.floor(now / 1000) + 600), auth_time: String(Math.floor(now / 1000) - 60), iss: ISSUER, client_id: "web" };
  const teamId = request.teamId ?? TEAM;
  return {
    version: "2.0",
    routeKey: request.routeKey ?? routeKey(BILLING_ROUTES[0] as (typeof BILLING_ROUTES)[number]),
    rawPath: `/teams/${teamId}/billing/checkout`,
    rawQueryString: "",
    headers: { authorization: `Bearer token-${user}`, "idempotency-key": KEY, ...request.headers },
    pathParameters: { teamId },
    body: request.rawBody ?? (request.body === undefined ? JSON.stringify({ plan: "starter", interval: "month" }) : JSON.stringify(request.body)),
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
      // A seat for each billed member: the owner and the editor, not the viewer (data/seats.ts)
      line_items: [{ price: "price_monthly", quantity: 2 }],
      success_url: `${APP}/?billing=success&team=${TEAM}`,
      cancel_url: `${APP}/?billing=canceled&team=${TEAM}`,
      metadata: { teamId: TEAM },
      payment_method_collection: "if_required",
      billing_address_collection: "required",
      tax_id_collection: { enabled: true },
      customer_update: { address: "auto", name: "auto" },
      subscription_data: {
        metadata: { teamId: TEAM, plan: "starter" },
        trial_end: Math.floor((now + 13 * DAY) / 1000),
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
      },
    });
    expect(session?.key).toBe(idempotencyKey("checkout", TEAM, { key: KEY, customer: "cus_test_1", priceId: "price_monthly", seats: 2, trial: Math.floor((now + 13 * DAY) / 1000) }));
    // Every handle was scoped to the path's team; only the link's also named the customer
    expect(scopes).toEqual([{ teamId: TEAM }, { teamId: TEAM, userId: OWNER }, { teamId: TEAM }, { teamId: TEAM, stripeCustomer: "cus_test_1" }]);
    expect(denied).toEqual([]);
    expect(counts[BusinessMetric.CheckoutSessionErrors]).toBeUndefined();
    expect(JSON.stringify(logs)).not.toContain("Echo Plumbing");
  });

  it("reuses the linked customer, and the annual price, on the next checkout", async () => {
    await checkout();
    const { status } = await checkout({ body: { plan: "starter", interval: "year" }, headers: { "idempotency-key": "checkout-key-2" } });
    expect(status).toBe(201);
    expect(stripe.state.customers).toHaveLength(1);
    expect(stripe.state.sessions[1]?.params).toMatchObject({ customer: "cus_test_1", line_items: [{ price: "price_annual", quantity: 2 }] });
    expect(scopes.filter((s) => s.stripeCustomer)).toHaveLength(1);
  });

  it("gives a retry with the same Idempotency-Key and choices the same Stripe idempotency key, and a new key or seats a new one", async () => {
    await checkout();
    await checkout();
    await checkout({ headers: { "idempotency-key": "checkout-key-2" } });
    // The viewer became an editor meanwhile: one more seat, so a new session rather than Stripe refusing the reused key
    table.put({ ...(table.get(`TEAM#${TEAM}`, `MEMBER#${VIEWER}`) as Record<string, unknown>), role: "contributor" });
    await checkout();
    const [a, b, c, d] = stripe.state.sessions.map((s) => s.key);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(d).not.toBe(a);
    expect(stripe.state.sessions[3]?.params.line_items).toEqual([{ price: "price_monthly", quantity: 3 }]);
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
    expect(trialEnd({ trialEndsAt: "soon", createdAt: "long ago" })).toBeNaN();
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
    [{ plan: "starter", interval: "month", coupon: "FREE" }],
    [{ plan: "enterprise", interval: "month" }],
    [{ plan: "starter", interval: "week" }],
    [{ plan: 1, interval: "month" }],
    [{ plan: "starter" }],
    // The seat count is the server's, from the team's billed members: a client can't choose it
    [{ plan: "starter", interval: "month", seats: 3 }],
    [{ plan: "starter", interval: "month", seats: MEMBERS_PER_TEAM }],
    [{ plan: "starter", interval: "month", quantity: 1 }],
    [["starter"]],
  ])("refuses the body %j", async (body) => {
    const { status, body: answer } = await checkout({ body });
    expect(status).toBe(400);
    expect(answer.error.code).toBe("bad_request");
    expect(stripe.state.customers).toHaveLength(0);
  });

  it("bills only owners and editors, counted from the members as they are now, so the seat sync has nothing to prorate", async () => {
    // Viewers are free; the META item's member count (viewers included, or missing on an old team) doesn't matter
    table.seedTeam("team-v", { [OWNER]: "owner", v1: "viewer", v2: "viewer", v3: "viewer", v4: "viewer" });
    patchTeam({ members: undefined, createdAt: new Date(now - DAY).toISOString() }, "team-v");
    const { status } = await checkout({ teamId: "team-v" });
    expect(status).toBe(201);
    expect(stripe.state.sessions[0]?.params.line_items).toEqual([{ price: "price_monthly", quantity: 1 }]);
    // Two owners and three editors: five seats
    table.seedTeam("team-e", { [OWNER]: "owner", o2: "owner", e1: "contributor", e2: "contributor", e3: "contributor", v1: "viewer" });
    patchTeam({ members: 50, createdAt: new Date(now - DAY).toISOString() }, "team-e");
    expect((await checkout({ teamId: "team-e" })).status).toBe(201);
    expect(stripe.state.sessions[1]?.params.line_items).toEqual([{ price: "price_monthly", quantity: 5 }]);
    // The count read only the members' keys and roles, as the billing-access role allows
    expect(denied).toEqual([]);
    expect(logs).toContainEqual(["Checkout started", expect.objectContaining({ teamId: "team-e", seats: 5 })]);
  });

  it("fails without a Stripe call if the billed members can't be counted", async () => {
    build({ refuse: "QueryCommand" });
    const { status } = await checkout();
    expect(status).toBe(500);
    expect(stripe.state.customers).toHaveLength(0);
    expect(stripe.state.sessions).toHaveLength(0);
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

  it("refuses a team whose customer has a live subscription the webhook hasn't recorded yet", async () => {
    patchTeam({ stripeCustomerId: "cus_test_9" });
    stripe.state.subscriptions = [{ status: "canceled" }, { status: "trialing" }];
    const answer = await checkout();
    expect(answer.status).toBe(409);
    expect(answer.body.error.reason).toBe("already_subscribed");
    expect(stripe.state.subscriptionLists).toEqual(["cus_test_9"]);
    stripe.state.subscriptions = [{ status: "canceled" }, { status: "incomplete_expired" }];
    expect((await checkout()).status).toBe(201);
  });

  it("doesn't link a customer to a team closed after the membership check", async () => {
    let gets = 0;
    table.afterGet = () => {
      // The team's read for the checkout: close it right after
      if (++gets === 1) patchTeam({ closedAt: new Date(now).toISOString() });
    };
    const { status } = await checkout();
    expect(status).toBe(409);
    expect(meta().stripeCustomerId).toBeUndefined();
    expect(table.get("STRIPE#cus_test_1", "TEAM")).toBeUndefined();
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
    expect((await checkout({ routeKey: "POST /teams/{teamId}/billing/refund" })).status).toBe(404);
    expect(scopes).toEqual([]);
    // No team ID to log for a request that never named a valid one
    const e = event();
    e.pathParameters = {};
    stripe.state.sessionError = new Error("boom");
    expect((await handler(e)).statusCode).toBe(400);
  });
});

describe("two-step sign-in for billing (supply-checkout-8jc.12)", () => {
  const portal = (request: Request = {}) => checkout({ routeKey: routeKey(BILLING_ROUTES[1] as (typeof BILLING_ROUTES)[number]), rawBody: "", ...request });

  const invoices = (request: Request = {}) => checkout({ routeKey: routeKey(BILLING_ROUTES.find((r) => r.action === "listInvoices") as (typeof BILLING_ROUTES)[number]), rawBody: "", ...request });

  it("refuses an owner without an authenticator app on every route, before the body is read or Stripe is called", async () => {
    patchTeam({ stripeCustomerId: "cus_linked" });
    cognito[OWNER] = { totp: false, federated: false };
    for (const [name, send] of [["checkout", checkout], ["portal", portal], ["invoices", invoices]] as const) {
      const { status, body } = await send({ rawBody: name === "checkout" ? "not json" : "", headers: { "idempotency-key": "" } });
      expect(status, name).toBe(403);
      expect(body.error, name).toMatchObject({ code: "permission_denied", reason: "mfa_required" });
      expect(body.error.message, name).toMatch(/two-step sign-in/);
    }
    expect(getUsers).toEqual([`token-${OWNER}`, `token-${OWNER}`, `token-${OWNER}`]);
    expect(stripe.state.customers).toEqual([]);
    expect(stripe.state.sessions).toEqual([]);
    expect(stripe.state.portalSessions).toEqual([]);
    expect(stripe.state.invoiceLists).toEqual([]);
  });

  it("lets an owner through with TOTP on, and a Google or Apple owner without it", async () => {
    expect((await checkout()).status).toBe(201);
    cognito[OWNER] = { totp: false, federated: true };
    expect((await portal()).status).toBe(201);
    expect((await invoices()).status).toBe(200);
  });

  it("checks membership and role first, so anyone else gets the same answer as before, and Cognito isn't asked", async () => {
    cognito[CONTRIBUTOR] = { totp: false, federated: false };
    expect((await checkout({ user: CONTRIBUTOR })).body.error.reason).toBe("owners_only");
    expect((await checkout({ user: OUTSIDER })).body.error.reason).toBe("not_member");
    expect(getUsers).toEqual([]);
  });

  it("refuses a revoked token (signed out everywhere when TOTP was turned on), and a token whose GetUser is someone else's", async () => {
    cognito = { [OUTSIDER]: { totp: true, federated: false } };
    expect(await checkout()).toMatchObject({ status: 401, body: { error: { code: "unauthenticated" } } });
    cognito[OWNER] = { totp: true, federated: false };
    expect((await checkout({ headers: { authorization: `Bearer token-${OUTSIDER}` } })).status).toBe(401);
    expect((await checkout({ headers: { authorization: "" } })).status).toBe(401);
    expect(stripe.state.sessions).toEqual([]);
  });

  describe("a session that began before TOTP was turned on (supply-checkout-8jc.14)", () => {
    const signedIn = (at: number, user = OWNER) => ({ sub: user, token_use: "access", exp: String(Math.floor(now / 1000) + 600), auth_time: String(Math.floor(at / 1000)), iss: ISSUER, client_id: "web" });
    const turnedOn = (at: number) => table.put({ PK: `USER#${OWNER}`, SK: "TOTP_ON", totpOnAt: new Date(at).toISOString() });

    it("refuses it on every route, before Stripe is called, and lets a later sign-in through", async () => {
      patchTeam({ stripeCustomerId: "cus_linked" });
      turnedOn(now - 5 * 60_000);
      for (const [name, send] of [["checkout", checkout], ["portal", portal], ["invoices", invoices]] as const) {
        const { status, body } = await send({ claims: signedIn(now - HOUR) });
        expect(status, name).toBe(403);
        expect(body.error, name).toMatchObject({ code: "permission_denied", reason: "mfa_sign_in_again" });
        expect(body.error.message, name).toMatch(/Sign in again/);
      }
      expect(stripe.state.customers).toEqual([]);
      expect(stripe.state.sessions).toEqual([]);
      expect(stripe.state.portalSessions).toEqual([]);
      expect(stripe.state.invoiceLists).toEqual([]);
      expect((await portal({ claims: signedIn(now - 60_000) })).status).toBe(201);
      expect(denied).toEqual([]);
    });

    it("needs a later second: auth_time is in whole seconds, rounded down", async () => {
      patchTeam({ stripeCustomerId: "cus_linked" });
      // Turned on at :00.400; a sign-in in the same second, before or after it, can't be told apart
      const on = Math.floor(now / 1000) * 1000 - 10_000 + 400;
      turnedOn(on);
      expect((await portal({ claims: signedIn(on) })).body.error.reason).toBe("mfa_sign_in_again");
      expect((await portal({ claims: signedIn(on + 600) })).status).toBe(201);
    });

    it("refuses a token without a usable auth_time", async () => {
      patchTeam({ stripeCustomerId: "cus_linked" });
      for (const authTime of [undefined, "", "soon", "1.5"]) {
        const claims: Record<string, unknown> = { ...signedIn(now), auth_time: authTime };
        if (authTime === undefined) delete claims.auth_time;
        expect((await portal({ claims })).body.error.reason, String(authTime)).toBe("mfa_sign_in_again");
      }
    });

    it("with no record (TOTP on from before it was kept), records now and refuses, so the next sign-in passes", async () => {
      patchTeam({ stripeCustomerId: "cus_linked" });
      table.delete(`USER#${OWNER}`, "TOTP_ON");
      expect((await portal({ claims: signedIn(now - 60_000) })).body.error.reason).toBe("mfa_sign_in_again");
      expect(table.get(`USER#${OWNER}`, "TOTP_ON")).toEqual({ PK: `USER#${OWNER}`, SK: "TOTP_ON", totpOnAt: new Date(now).toISOString() });
      expect(logs).toContainEqual(["Two-step sign-in time recorded", { userId: OWNER }]);
      // The same session still can't; one that began after it can
      now += 5_000;
      expect((await portal({ claims: signedIn(now - 5_000) })).body.error.reason).toBe("mfa_sign_in_again");
      expect((await portal({ claims: signedIn(now) })).status).toBe(201);
      // Only the caller's own record, on a session tagged with them, naming only totpOnAt
      expect(scopes.filter((s) => s.userId)).toEqual([{ teamId: TEAM, userId: OWNER }, { teamId: TEAM, userId: OWNER }, { teamId: TEAM, userId: OWNER }]);
      expect(denied).toEqual([]);
    });

    it("doesn't apply to a Google or Apple user, who has no TOTP to have turned on", async () => {
      patchTeam({ stripeCustomerId: "cus_linked" });
      cognito[OWNER] = { totp: false, federated: true };
      table.delete(`USER#${OWNER}`, "TOTP_ON");
      expect((await portal({ claims: signedIn(now - DAY * 2) })).status).toBe(201);
      expect(table.get(`USER#${OWNER}`, "TOTP_ON")).toBeUndefined();
      expect(scopes.filter((s) => s.userId)).toEqual([]);
    });

    it("fails with 500 when the record can't be read, logged as the two-step check", async () => {
      const allow = billingPolicy({ teamId: TEAM });
      handler = createBillingHandler({
        dbFor: (scope) => table.guarded((command, input) => !scope.userId && allow(command, input)),
        userInfo: async () => ({ sub: OWNER, emailVerified: true, emailVerifiedInCognito: true, totp: true, federated: false }),
        stripe: () => Promise.resolve(stripe.client),
        priceFor: async () => "price_monthly",
        portalConfiguration: async () => "bpc_ours",
        issuerUrl: ISSUER,
        appUrl: APP,
        obs: fakeObservability(),
        now: () => now,
      });
      expect((await invoices()).status).toBe(500);
      expect(logs).toContainEqual(["Two-step sign-in check failed", { code: "AccessDeniedException" }]);
      expect(counts).toEqual({});
    });
  });

  it("fails with 500 when Cognito can't answer, without counting it as Stripe's failure", async () => {
    cognito = new Proxy({}, { get: () => { throw new Error("GetUser failed: 500 InternalErrorException"); } });
    expect((await checkout()).status).toBe(500);
    expect((await portal()).status).toBe(500);
    expect(stripe.state.sessions).toEqual([]);
    expect(counts).toEqual({});
    expect(logs.filter((l) => l[0] === "Two-step sign-in check failed")).toEqual([
      ["Two-step sign-in check failed", { code: "Error" }],
      ["Two-step sign-in check failed", { code: "Error" }],
    ]);
  });
});

describe("POST /teams/{teamId}/billing/portal", () => {
  const PORTAL_ROUTE = routeKey(BILLING_ROUTES.find((r) => r.action === "createPortalSession") as (typeof BILLING_ROUTES)[number]);
  const portal = (request: Request = {}) => checkout({ routeKey: PORTAL_ROUTE, rawBody: "", ...request });

  beforeEach(() => {
    patchTeam({ stripeCustomerId: "cus_test_9", stripeSubscriptionId: "sub_test_1", status: "active", plan: "starter" });
  });

  it("opens the portal for the team's own Stripe customer, with our configuration and the app as the way back", async () => {
    const { status, body } = await portal();
    expect(status).toBe(201);
    expect(body).toEqual({ portal: { url: "https://billing.stripe.test/p/session/bps_test_1" } });
    expect(stripe.state.portalSessions).toEqual([{ customer: "cus_test_9", configuration: "bpc_ours", return_url: `${APP}/?billing=portal&team=${TEAM}` }]);
    // Read-only: handles scoped to the path's team only, and nothing written
    expect(scopes).toEqual([{ teamId: TEAM }, { teamId: TEAM, userId: OWNER }, { teamId: TEAM }]);
    expect(denied).toEqual([]);
    expect(stripe.state.customers).toHaveLength(0);
    expect(logs.find((l) => l[0] === "Billing portal opened")?.[1]).toEqual({ teamId: TEAM });
    expect(JSON.stringify(logs)).not.toContain("cus_test_9");
    // An empty object is a body too. The configuration is looked up once, then kept for a while
    expect((await portal({ rawBody: "{}" })).status).toBe(201);
    expect(stripe.state.configurationLists).toBe(1);
    now += 11 * 60_000;
    await portal();
    expect(stripe.state.configurationLists).toBe(2);
  });

  it("opens it for a team whose subscription ended, for its invoices and card", async () => {
    patchTeam({ status: "canceled" });
    expect((await portal()).status).toBe(201);
  });

  it.each([
    [CONTRIBUTOR, "owners_only"],
    [VIEWER, "owners_only"],
    [OUTSIDER, "not_member"],
  ])("refuses %s (%s) before reading the body or calling Stripe", async (user, reason) => {
    const { status, body } = await portal({ user, rawBody: "not json" });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ code: "permission_denied", reason });
    expect(stripe.state.portalSessions).toHaveLength(0);
    expect(stripe.state.configurationLists).toBe(0);
  });

  it("never opens another team's customer: the owner of team-b gets only team-b's", async () => {
    patchTeam({ stripeCustomerId: "cus_test_b" }, "team-b");
    expect((await portal({ user: OUTSIDER })).status).toBe(403);
    expect((await portal({ user: OUTSIDER, teamId: "team-b" })).status).toBe(201);
    expect(stripe.state.portalSessions.map((s) => s.customer)).toEqual(["cus_test_b"]);
  });

  it.each([["not json"], ['{"customer":"cus_test_b"}'], ['{"return_url":"https://evil.example"}'], ["[]"]])("refuses the body %s", async (rawBody) => {
    const { status, body } = await portal({ rawBody });
    expect(status).toBe(400);
    expect(body.error.code).toBe("bad_request");
    expect(stripe.state.portalSessions).toHaveLength(0);
  });

  it("answers no_billing_account for a team with no Stripe customer yet", async () => {
    patchTeam({ stripeCustomerId: undefined, stripeSubscriptionId: undefined, status: "trialing" });
    const { status, body } = await portal();
    expect(status).toBe(409);
    expect(body.error).toMatchObject({ code: "aborted", reason: "no_billing_account" });
    expect(stripe.state.configurationLists).toBe(0);
  });

  it("answers no_billing_account for a customer ID that isn't one", async () => {
    patchTeam({ stripeCustomerId: "cus bad/../x" });
    expect((await portal()).body.error.reason).toBe("no_billing_account");
    expect(stripe.state.portalSessions).toHaveLength(0);
  });

  it("refuses a closed team", async () => {
    patchTeam({ closedAt: new Date(now - DAY).toISOString(), purgeAfter: new Date(now + 29 * DAY).toISOString() });
    const { status, body } = await portal();
    expect(status).toBe(403);
    expect(body.error.reason).toBe("team_closed");
    expect(stripe.state.portalSessions).toHaveLength(0);
  });

  it.each([
    ["none of ours", [{ id: "bpc_default", active: true, metadata: {} }]],
    ["only an archived one", [{ id: "bpc_old", active: false, metadata: { ...PORTAL_METADATA } }]],
    [
      "two of ours",
      [
        { id: "bpc_a", active: true, metadata: { ...PORTAL_METADATA } },
        { id: "bpc_b", active: true, metadata: { ...PORTAL_METADATA } },
      ],
    ],
    ["one with no metadata", [{ id: "bpc_c", active: true, metadata: null }]],
  ])("fails with 500 and counts it when our configuration isn't there (%s), never falling back to the default", async (_, configurations) => {
    stripe.state.configurations = configurations as PortalConfigurationLike[];
    const { status } = await portal();
    expect(status).toBe(500);
    expect(stripe.state.portalSessions).toHaveLength(0);
    expect(counts[BusinessMetric.BillingPortalErrors]).toBe(1);
    expect(counts[BusinessMetric.CheckoutSessionErrors]).toBeUndefined();
    expect(logs.find((l) => l[0] === "Billing portal failed")?.[1]).toEqual({ teamId: TEAM, code: "PortalConfigurationNotFoundError", reason: "portal_configuration_not_found" });
  });

  it("fails with 500, counts it and logs no Stripe message when Stripe fails", async () => {
    stripe.state.portalError = new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", message: "No such customer: 'cus_test_9'", code: "resource_missing", statusCode: 400, requestId: "req_2" } as never);
    const { status } = await portal();
    expect(status).toBe(500);
    expect(counts[BusinessMetric.BillingPortalErrors]).toBe(1);
    expect(logs.find((l) => l[0] === "Billing portal failed")?.[1]).toEqual({ teamId: TEAM, type: "StripeInvalidRequestError", code: "resource_missing", status: 400, requestId: "req_2" });
    expect(JSON.stringify(logs)).not.toContain("cus_test_9");
  });

  it("refuses tokens from another issuer before anything else", async () => {
    const exp = String(Math.floor(now / 1000) + 600);
    expect((await portal({ claims: { sub: OWNER, token_use: "access", exp, iss: "https://elsewhere.example" } })).status).toBe(401);
    expect(scopes).toEqual([]);
  });
});

describe("GET /teams/{teamId}/billing/invoices (supply-checkout-eja)", () => {
  const INVOICES_ROUTE = routeKey(BILLING_ROUTES.find((r) => r.action === "listInvoices") as (typeof BILLING_ROUTES)[number]);
  const invoices = (request: Request = {}) => checkout({ routeKey: INVOICES_ROUTE, rawBody: "", ...request });
  const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const invoice = (n: number, fields: Partial<InvoiceLike> = {}, customer = "cus_test_9") => ({
    id: `in_test_${n}`,
    customer,
    number: `ABCD1234-000${n}`,
    status: "paid" as const,
    created: at(`2026-0${n}-01T00:00:00Z`),
    currency: "usd",
    total: 900 + n,
    amount_due: 900 + n,
    amount_paid: 900 + n,
    hosted_invoice_url: `https://invoice.stripe.com/i/acct_x/test_${n}`,
    invoice_pdf: `https://pay.stripe.com/invoice/acct_x/test_${n}/pdf`,
    ...fields,
  });

  beforeEach(() => {
    patchTeam({ stripeCustomerId: "cus_test_9", stripeSubscriptionId: "sub_test_1", status: "active", plan: "starter" });
  });

  it("lists the team's own invoices from Stripe, newest first, with Stripe's hosted page and PDF", async () => {
    stripe.state.invoices = [invoice(3, { status: "open", amount_paid: 0 }), invoice(2), invoice(1, { number: null }), invoice(4, {}, "cus_test_b")];
    const { status, body } = await invoices();
    expect(status).toBe(200);
    expect(body).toEqual({
      invoices: [
        { id: "in_test_3", number: "ABCD1234-0003", status: "open", createdAt: "2026-03-01T00:00:00.000Z", currency: "usd", total: 903, amountDue: 903, amountPaid: 0, hostedUrl: "https://invoice.stripe.com/i/acct_x/test_3", pdfUrl: "https://pay.stripe.com/invoice/acct_x/test_3/pdf" },
        { id: "in_test_2", number: "ABCD1234-0002", status: "paid", createdAt: "2026-02-01T00:00:00.000Z", currency: "usd", total: 902, amountDue: 902, amountPaid: 902, hostedUrl: "https://invoice.stripe.com/i/acct_x/test_2", pdfUrl: "https://pay.stripe.com/invoice/acct_x/test_2/pdf" },
        { id: "in_test_1", number: null, status: "paid", createdAt: "2026-01-01T00:00:00.000Z", currency: "usd", total: 901, amountDue: 901, amountPaid: 901, hostedUrl: "https://invoice.stripe.com/i/acct_x/test_1", pdfUrl: "https://pay.stripe.com/invoice/acct_x/test_1/pdf" },
      ],
      hasMore: false,
    });
    // Only the path's team's customer, a page of them
    expect(stripe.state.invoiceLists).toEqual([{ customer: "cus_test_9", limit: INVOICE_PAGE }]);
    // Read-only: handles scoped to the path's team only, and nothing written
    expect(scopes).toEqual([{ teamId: TEAM }, { teamId: TEAM, userId: OWNER }, { teamId: TEAM }]);
    expect(denied).toEqual([]);
    expect(logs.find((l) => l[0] === "Invoices listed")?.[1]).toEqual({ teamId: TEAM, count: 3 });
    expect(JSON.stringify(logs)).not.toContain("cus_test_9");
  });

  it("leaves out drafts, which have no page yet, and says when there are older ones", async () => {
    stripe.state.invoices = [invoice(9, { status: "draft", hosted_invoice_url: null, invoice_pdf: null }), ...Array.from({ length: INVOICE_PAGE }, (_, i) => invoice(1, { id: `in_many_${i}` }))];
    const { body } = await invoices();
    expect(body.invoices).toHaveLength(INVOICE_PAGE - 1);
    expect(body.invoices.map((i: { status: string }) => i.status)).not.toContain("draft");
    expect(body.hasMore).toBe(true);
  });

  it("gives no link that isn't Stripe's own https page", async () => {
    stripe.state.invoices = [
      invoice(1, { hosted_invoice_url: "javascript:alert(1)", invoice_pdf: "http://pay.stripe.com/x" }),
      invoice(2, { hosted_invoice_url: "https://invoice.stripe.com.evil.example/x", invoice_pdf: "not a url" }),
      invoice(3, { hosted_invoice_url: undefined, invoice_pdf: "https://stripe.com/x", status: null }),
      invoice(4, { hosted_invoice_url: "https://evilstripe.com/x", invoice_pdf: null, status: "void" }),
    ];
    const { body } = await invoices();
    expect(body.invoices.map((i: { id: string; status: string; hostedUrl: unknown; pdfUrl: unknown }) => [i.id, i.status, i.hostedUrl, i.pdfUrl])).toEqual([
      ["in_test_1", "paid", null, null],
      ["in_test_2", "paid", null, null],
      ["in_test_4", "void", null, null],
    ]);
  });

  it("lists them for a team whose subscription ended", async () => {
    patchTeam({ status: "canceled" });
    stripe.state.invoices = [invoice(1)];
    expect((await invoices()).body.invoices).toHaveLength(1);
  });

  it.each([
    [CONTRIBUTOR, "owners_only"],
    [VIEWER, "owners_only"],
    [OUTSIDER, "not_member"],
  ])("refuses %s (%s) before calling Stripe", async (user, reason) => {
    const { status, body } = await invoices({ user });
    expect(status).toBe(403);
    expect(body.error).toMatchObject({ code: "permission_denied", reason });
    expect(stripe.state.invoiceLists).toHaveLength(0);
  });

  it("never lists another team's invoices: the owner of team-b gets only team-b's", async () => {
    patchTeam({ stripeCustomerId: "cus_test_b" }, "team-b");
    stripe.state.invoices = [invoice(1), invoice(2, {}, "cus_test_b")];
    expect((await invoices({ user: OUTSIDER })).status).toBe(403);
    const { status, body } = await invoices({ user: OUTSIDER, teamId: "team-b" });
    expect(status).toBe(200);
    expect(body.invoices.map((i: { id: string }) => i.id)).toEqual(["in_test_2"]);
    expect(stripe.state.invoiceLists.map((l) => l.customer)).toEqual(["cus_test_b"]);
  });

  it("answers no_billing_account for a team with no Stripe customer yet, or one that isn't one", async () => {
    patchTeam({ stripeCustomerId: undefined, stripeSubscriptionId: undefined, status: "trialing" });
    expect((await invoices()).body.error).toMatchObject({ code: "aborted", reason: "no_billing_account" });
    patchTeam({ stripeCustomerId: "cus bad/../x" });
    expect((await invoices()).body.error.reason).toBe("no_billing_account");
    expect(stripe.state.invoiceLists).toHaveLength(0);
  });

  it("refuses a closed team", async () => {
    patchTeam({ closedAt: new Date(now - DAY).toISOString(), purgeAfter: new Date(now + 29 * DAY).toISOString() });
    const { status, body } = await invoices();
    expect(status).toBe(403);
    expect(body.error.reason).toBe("team_closed");
    expect(stripe.state.invoiceLists).toHaveLength(0);
  });

  it("fails with 500, counts it apart from the portal and logs no Stripe message when Stripe fails", async () => {
    stripe.state.invoiceError = new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", message: "No such customer: 'cus_test_9'", code: "resource_missing", statusCode: 400, requestId: "req_3" } as never);
    const { status } = await invoices();
    expect(status).toBe(500);
    expect(counts).toEqual({ [BusinessMetric.InvoiceListErrors]: 1 });
    expect(logs.find((l) => l[0] === "Invoices failed")?.[1]).toEqual({ teamId: TEAM, type: "StripeInvalidRequestError", code: "resource_missing", status: 400, requestId: "req_3" });
    expect(JSON.stringify(logs)).not.toContain("cus_test_9");
  });

  it("refuses tokens from another issuer before anything else", async () => {
    const exp = String(Math.floor(now / 1000) + 600);
    expect((await invoices({ claims: { sub: OWNER, token_use: "access", exp, iss: "https://elsewhere.example" } })).status).toBe(401);
    expect(scopes).toEqual([]);
  });
});
