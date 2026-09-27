// The billing API (ADR 0009, docs/api/openapi.yaml):
//
//   POST /teams/{teamId}/billing/checkout  Owners: start Stripe Checkout for
//                                          the team, with a plan, an interval
//                                          and a seat count. Answers the
//                                          Checkout page's URL.
//
// The team's Stripe customer is made the first time (and linked to the team
// with linkStripeCustomer), and the Checkout Session is for that customer, so
// whatever the owner does on the Stripe page lands on this team. A team still
// in its free trial keeps it: the subscription's trial ends when the team's
// does (`trialEndsAt`, TRIAL_DAYS after it was made) and Checkout asks for no
// card (payment_method_collection `if_required`); if no card is added by then,
// Stripe cancels the subscription. After the trial, Checkout asks for a card.
// The webhook (supply-checkout-2kl) turns what Stripe records into the team's
// plan, seats and status; nothing here changes them.
//
// Isolation, in order:
// 1. API Gateway's JWT authorizer checks the Cognito access token; this
//    handler re-checks it (an access token from our issuer, not expired) and
//    takes the user only from `sub`.
// 2. The team comes only from the path, and the caller must be its owner
//    (authorizeTeam, then requireRole), before the body is read or Stripe is
//    called.
// 3. Every DynamoDB call runs on a billing-access role session tagged with
//    that team and, when linking, the customer Stripe returned (billing-db.ts):
//    IAM refuses any other partition, and any attribute but the link's.
// 4. Nothing from the request reaches Stripe except the validated plan,
//    interval and seat count; the customer, the price and the return URLs are
//    the server's own.
//
// Logged: the route, status and duration, and on a failure the team ID and
// Stripe's error type, code, status and request ID. Never the key, a customer
// or owner's name or email, or Stripe's error message.

import { createHash } from "node:crypto";
import type { APIGatewayProxyStructuredResultV2, Context } from "aws-lambda";
import { type CatalogPlan, type CatalogPrice, catalogPrice } from "../billing/catalog.js";
import { type PriceLister, PriceNotFoundError } from "../billing/prices.js";
import { stripeErrorFields } from "../billing/stripe.js";
import {
  authorizeTeam,
  ConflictError,
  ForbiddenError,
  getTeam,
  hasEnded,
  linkStripeCustomer,
  MEMBERS_PER_TEAM,
  type Team,
  TeamClosedError,
  type TeamContext,
  TRIAL_DAYS,
} from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import type { DbForBilling } from "./billing-db.js";
import { callerId, type DataEvent, errorFor as dataErrorFor } from "./data-handler.js";
import { ApiError, errorResponse, header, json, jsonBody, notMember } from "./http.js";
import { requireRole } from "./roles.js";
import { BILLING_ROUTES, type BillingRoute, IDEMPOTENCY_HEADER, routeKey } from "./routes.js";

/** What the checkout needs from the Stripe client (the `stripe` package's, or a fake in tests). */
export interface CheckoutStripe extends PriceLister {
  readonly customers: {
    create(params: { name: string; metadata: Record<string, string> }, options: { idempotencyKey: string }): PromiseLike<{ readonly id: string }>;
  };
  readonly checkout: {
    readonly sessions: {
      create(params: CheckoutSessionParams, options: { idempotencyKey: string }): PromiseLike<{ readonly id: string; readonly url: string | null; readonly expires_at: number }>;
    };
  };
}

/** The Checkout Session this handler creates: a subset of Stripe's parameters. */
export interface CheckoutSessionParams {
  readonly mode: "subscription";
  readonly customer: string;
  readonly client_reference_id: string;
  readonly line_items: { readonly price: string; readonly quantity: number }[];
  readonly success_url: string;
  readonly cancel_url: string;
  readonly metadata: Record<string, string>;
  readonly payment_method_collection: "always" | "if_required";
  readonly billing_address_collection: "auto";
  readonly customer_update: { readonly address: "auto"; readonly name: "auto" };
  readonly subscription_data: {
    readonly metadata: Record<string, string>;
    readonly trial_end?: number;
    readonly trial_settings?: { readonly end_behavior: { readonly missing_payment_method: "cancel" } };
  };
}

export interface BillingHandlerDeps {
  readonly dbFor: DbForBilling;
  /** The Stripe client, read from Secrets Manager on first use (billing/stripe.ts). */
  readonly stripe: () => Promise<CheckoutStripe>;
  /** The price ID for a catalog price, by its lookup key (billing/prices.ts). */
  readonly priceFor: (plan: CatalogPlan, price: CatalogPrice) => Promise<string>;
  /** The user pool's issuer URL; tokens from anywhere else are refused. */
  readonly issuerUrl: string;
  /** `https://app.<env domain>`: where Checkout sends the owner back to. */
  readonly appUrl: string;
  readonly obs: Observability;
  readonly now?: () => number;
}

const ROUTES = new Map(BILLING_ROUTES.map((r) => [routeKey(r), r]));
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const DAY_MS = 24 * 60 * 60_000;

/**
 * Stripe wants a subscription's trial to end at least 48 hours after the
 * Checkout Session is made. A team with less of its trial left gets none on
 * Stripe: Checkout asks for a card, and the first invoice is due at once.
 */
export const MIN_TRIAL_LEFT_MS = 49 * 60 * 60_000;

/** The data layer's and Stripe's errors, as this route answers them. */
export function errorFor(error: unknown): ApiError {
  if (error instanceof TeamClosedError) return new ApiError(403, "permission_denied", error.message, "team_closed");
  return dataErrorFor(error);
}

/** When the team's free trial ends: `trialEndsAt`, or TRIAL_DAYS after it was made for a team from before trials. */
export function trialEnd(team: Pick<Team, "trialEndsAt" | "createdAt">): number {
  const at = Date.parse(team.trialEndsAt ?? "");
  if (Number.isFinite(at)) return at;
  const created = Date.parse(team.createdAt);
  return Number.isFinite(created) ? created + TRIAL_DAYS * DAY_MS : 0;
}

/** A request's idempotency key for one Stripe create: the same inputs give the same key, so a retry makes nothing new. */
export function idempotencyKey(kind: string, teamId: string, parts: unknown): string {
  return `${kind}-${teamId}-${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

export function createBillingHandler(deps: BillingHandlerDeps) {
  const now = deps.now ?? Date.now;
  const { dbFor, obs } = deps;

  /** The caller's context for the path's team, as its owner, or 403 (`not_member` for a team that doesn't exist). */
  async function ownerContext(event: DataEvent, userId: string, route: BillingRoute): Promise<TeamContext> {
    const teamId = event.pathParameters?.teamId;
    if (typeof teamId !== "string" || !ID.test(teamId)) throw new ApiError(400, "bad_request", "Invalid team ID");
    const ctx = await authorizeTeam(dbFor({ teamId }), userId, teamId).catch((error: unknown) => {
      if (error instanceof ForbiddenError) throw notMember();
      throw error;
    });
    requireRole(ctx.role, route.minRole);
    return ctx;
  }

  /** The body's plan, interval and seats, checked against the catalog and the member cap. */
  function checkoutInput(event: DataEvent) {
    const body = jsonBody(event, ["plan", "interval", "seats"]);
    const found = typeof body.plan === "string" && typeof body.interval === "string" ? catalogPrice(body.plan, body.interval) : undefined;
    if (!found) throw new ApiError(400, "bad_request", "Choose a plan and an interval we sell (see the API description)");
    const seats = body.seats;
    if (typeof seats !== "number" || !Number.isInteger(seats) || seats < 1 || seats > MEMBERS_PER_TEAM) {
      throw new ApiError(400, "bad_request", `Seats must be a whole number from 1 to ${MEMBERS_PER_TEAM}`);
    }
    return { ...found, seats };
  }

  /**
   * The team's Stripe customer: the linked one, or a new one Stripe makes
   * (once per team: its idempotency key is the team's) and this links. If
   * another request linked one meanwhile, that one.
   */
  async function customerFor(stripe: CheckoutStripe, ctx: TeamContext, team: Team): Promise<string> {
    if (team.stripeCustomerId) return team.stripeCustomerId;
    const params = { name: team.name, metadata: { teamId: ctx.teamId } };
    // Once per team (and name: Stripe refuses a key reused with other parameters)
    const customer = await stripe.customers.create(params, { idempotencyKey: idempotencyKey("customer", ctx.teamId, params) });
    try {
      await linkStripeCustomer(dbFor({ teamId: ctx.teamId, stripeCustomer: customer.id }), ctx, customer.id);
      return customer.id;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const linked = (await getTeam(dbFor({ teamId: ctx.teamId }), ctx)).stripeCustomerId;
      if (!linked) throw error;
      return linked;
    }
  }

  async function createCheckout(event: DataEvent, userId: string, route: BillingRoute): Promise<APIGatewayProxyStructuredResultV2> {
    // Membership and role first, so anyone else gets the same 403 whatever they send
    const ctx = await ownerContext(event, userId, route);
    const key = header(event, IDEMPOTENCY_HEADER);
    if (!key || !REQUEST_KEY.test(key)) throw new ApiError(400, "bad_request", "Send an Idempotency-Key header: 8 to 128 letters, digits, - or _, new for each checkout");
    const input = checkoutInput(event);
    if (ctx.closed) throw new TeamClosedError("This team was closed. Reopen it before choosing a plan.");
    const team = await getTeam(dbFor({ teamId: ctx.teamId }), ctx);
    if (team.stripeSubscriptionId && !hasEnded(team.status)) {
      throw new ApiError(409, "aborted", "This team already has a subscription. Change it from Manage billing.", "already_subscribed");
    }
    if (typeof team.members === "number" && input.seats < team.members) {
      throw new ApiError(400, "bad_request", `Choose at least ${team.members} seats: the team has ${team.members} members`);
    }
    const stripe = await deps.stripe();
    const priceId = await deps.priceFor(input.plan, input.price);
    const customer = await customerFor(stripe, ctx, team);
    const at = now();
    const trialEndsMs = trialEnd(team);
    const trial = trialEndsMs - at >= MIN_TRIAL_LEFT_MS;
    const back = (outcome: string) => `${deps.appUrl}/?billing=${outcome}&team=${encodeURIComponent(ctx.teamId)}`;
    const params: CheckoutSessionParams = {
      mode: "subscription",
      customer,
      client_reference_id: ctx.teamId,
      line_items: [{ price: priceId, quantity: input.seats }],
      success_url: back("success"),
      cancel_url: back("canceled"),
      metadata: { teamId: ctx.teamId },
      // Still in the free trial: no card now, and Stripe cancels the subscription if none is added by its end
      payment_method_collection: trial ? "if_required" : "always",
      billing_address_collection: "auto",
      customer_update: { address: "auto", name: "auto" },
      subscription_data: {
        metadata: { teamId: ctx.teamId, plan: input.plan.plan },
        ...(trial ? { trial_end: Math.floor(trialEndsMs / 1000), trial_settings: { end_behavior: { missing_payment_method: "cancel" as const } } } : {}),
      },
    };
    // A retry with the same Idempotency-Key and the same choices sends the same
    // parameters under the same key, so Stripe answers with the same session. (So
    // nothing in them may move with the clock: the page expires after Stripe's 24 hours.)
    const session = await stripe.checkout.sessions.create(params, {
      idempotencyKey: idempotencyKey("checkout", ctx.teamId, { key, customer, priceId, seats: input.seats, trial: params.subscription_data.trial_end ?? null }),
    });
    if (!session.url) throw new Error("Stripe returned a Checkout Session without a URL");
    obs.logger.info("Checkout started", { teamId: ctx.teamId, plan: input.plan.plan, interval: input.price.interval, seats: input.seats, trial });
    return json(201, { checkout: { url: session.url, expiresAt: new Date(session.expires_at * 1000).toISOString(), trialEndsAt: trial ? new Date(trialEndsMs).toISOString() : null } });
  }

  const actions: Record<BillingRoute["action"], (event: DataEvent, userId: string, route: BillingRoute) => Promise<APIGatewayProxyStructuredResultV2>> = {
    createCheckout,
  };

  return async (event: DataEvent, context?: Context): Promise<APIGatewayProxyStructuredResultV2> => {
    void context;
    const started = now();
    const route = ROUTES.get(event.routeKey);
    let status = 500;
    try {
      if (!route) throw new ApiError(404, "not_found", "No such route");
      const userId = callerId(event, now());
      if (event.requestContext.authorizer.jwt.claims.iss !== deps.issuerUrl) throw new ApiError(401, "unauthenticated", "Sign in again");
      const response = await actions[route.action](event, userId, route);
      status = response.statusCode ?? 200;
      return response;
    } catch (error) {
      const apiError = errorFor(error);
      status = apiError.status;
      if (apiError.status >= 500) {
        const teamId = event.pathParameters?.teamId;
        // Stripe's error fields only: never its message, which can echo what was sent
        obs.logger.error("Checkout failed", { ...(typeof teamId === "string" && ID.test(teamId) ? { teamId } : {}), ...stripeErrorFields(error), ...(error instanceof PriceNotFoundError ? { reason: "price_not_found" } : {}) });
        obs.count(BusinessMetric.CheckoutSessionErrors);
      }
      return errorResponse(apiError);
    } finally {
      obs.logger.info("Request", { route: event.routeKey, status, ms: now() - started });
    }
  };
}
