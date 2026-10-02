// The billing API (ADR 0009, docs/api/openapi.yaml):
//
//   POST /teams/{teamId}/billing/checkout  Owners: start Stripe Checkout for
//                                          the team, with a plan and an
//                                          interval. Answers the Checkout
//                                          page's URL.
//   POST /teams/{teamId}/billing/portal    Owners: open the Stripe Customer
//                                          Portal for the team's Stripe
//                                          customer (supply-checkout-121).
//                                          Answers the portal's URL.
//   GET  /teams/{teamId}/billing/invoices  Owners: the team's latest invoices
//                                          from Stripe (supply-checkout-eja),
//                                          with links to Stripe's hosted
//                                          invoice page and PDF.
//
// The team's Stripe customer is made the first time (and linked to the team
// with linkStripeCustomer), and the Checkout Session is for that customer, so
// whatever the owner does on the Stripe page lands on this team. A team still
// in its free trial keeps it: the subscription's trial ends when the team's
// does (`trialEndsAt`, TRIAL_DAYS after it was made) and Checkout asks for no
// card (payment_method_collection `if_required`); if no card is added by then,
// Stripe cancels the subscription. After the trial, Checkout asks for a card.
// The seat quantity isn't the owner's to choose (supply-checkout-8jc.20): it's
// the team's billed members as they are now (countBilledMembers, at least 1),
// the same number the seat sync keeps the subscription at afterwards
// (billing/seats.ts), so a team with viewers isn't billed for them and its
// first invoice isn't prorated down right after Checkout.
// The portal is only ever for the customer linked to the path's team
// (`stripeCustomerId`, which only linkStripeCustomer writes), with our own
// portal configuration (billing/portal.ts) and a return URL on the app's own
// origin. The webhook (supply-checkout-2kl) turns what Stripe records, from
// Checkout or the portal, into the team's plan, seats and status; nothing
// here changes them. Checkout collects the billing address and, for a
// business, its name and tax ID, which Stripe keeps on the customer and prints
// on every invoice; owners change them in the portal. Stripe itself emails the
// invoices and receipts (its Dashboard's customer email settings), so nothing
// here sends mail. The invoice list is read-only, for the same customer as the
// portal, and passes on only Stripe's own https links.
//
// Isolation, in order:
// 1. API Gateway's JWT authorizer checks the Cognito access token; this
//    handler re-checks it (an access token from our issuer, not expired) and
//    takes the user only from `sub`.
// 2. The team comes only from the path, and the caller must be its owner
//    (authorizeTeam, then requireRole), before the body is read or Stripe is
//    called.
// 2a. Then two-step sign-in (ADR 0007, supply-checkout-8jc.12): Cognito's
//    GetUser, with the caller's own token, must show an authenticator app
//    (TOTP) on and preferred, or a Google or Apple user (whose provider's
//    sign-in counts for it); otherwise 403 `mfa_required`. GetUser also
//    refuses a revoked token (401), and turning TOTP on in the app signs the
//    user out everywhere (account-handler.ts).
// 2b. Then, for TOTP, the session must have begun after it was turned on
//    (supply-checkout-8jc.14): the access token's `auth_time` must be later
//    than the user's TOTP_ON record (data/two-step.ts), which the account API,
//    the security notices function (from CloudTrail, so TOTP turned on
//    directly against Cognito counts too) and this check keep. With no record
//    (TOTP on from before it was kept, or a CloudTrail event not processed
//    yet), this records the time now, which is after TOTP was on. Otherwise
//    403 `mfa_sign_in_again`: sign in again, with the password and the code.
//    The record is read, and written, on a session tagged with the caller's
//    own sub, which may name only `totpOnAt` in `USER#<sub>`.
// 3. Every DynamoDB call runs on a billing-access role session tagged with
//    that team and, when linking, the customer Stripe returned (billing-db.ts):
//    IAM refuses any other partition, and any attribute but the link's. The
//    member count reads only the team's MEMBER items' keys and roles
//    (MEMBER_SEAT_ATTRIBUTES).
// 4. Nothing from the request reaches Stripe except the validated plan and
//    interval; the customer, the price, the seat quantity, the portal
//    configuration and the return URLs are the server's own.
//
// Logged: the route, status and duration, and on a failure the team ID and
// Stripe's error type, code, status and request ID. Never the key, a customer
// or owner's name or email, or Stripe's error message.

import { createHash } from "node:crypto";
import type { APIGatewayProxyStructuredResultV2, Context } from "aws-lambda";
import { type CatalogPlan, type CatalogPrice, catalogPrice } from "../billing/catalog.js";
import { PortalConfigurationNotFoundError } from "../billing/portal.js";
import { type PriceLister, PriceNotFoundError } from "../billing/prices.js";
import { stripeErrorFields } from "../billing/stripe.js";
import {
  authorizeTeam,
  ConflictError,
  countBilledMembers,
  ForbiddenError,
  getTeam,
  isClosed,
  hasEnded,
  linkStripeCustomer,
  recordTotpOn,
  type Team,
  TeamClosedError,
  type TeamContext,
  totpOnAt,
  trialEnd,
} from "../data/index.js";
import { BusinessMetric, type BusinessMetricName, type Observability } from "../observability/index.js";
import type { DbForBilling } from "./billing-db.js";
import { callerId, type DataEvent, errorFor as dataErrorFor } from "./data-handler.js";
import type { UserInfo } from "./cognito-user.js";
import { accessToken, ApiError, errorResponse, header, json, jsonBody, notMember } from "./http.js";
import { requireRole } from "./roles.js";
import { BILLING_ROUTES, type BillingRoute, IDEMPOTENCY_HEADER, routeKey } from "./routes.js";

/** What the checkout needs from the Stripe client (the `stripe` package's, or a fake in tests). */
export interface CheckoutStripe extends PriceLister {
  readonly subscriptions: {
    list(params: { customer: string; status: "all"; limit: number }): PromiseLike<{ readonly data: readonly { readonly status: string }[] }>;
  };
  readonly customers: {
    create(params: { name: string; metadata: Record<string, string> }, options: { idempotencyKey: string }): PromiseLike<{ readonly id: string }>;
  };
  readonly checkout: {
    readonly sessions: {
      create(params: CheckoutSessionParams, options: { idempotencyKey: string }): PromiseLike<{ readonly id: string; readonly url: string | null; readonly expires_at: number }>;
    };
  };
}

/** What opening the Customer Portal needs from the Stripe client. */
export interface PortalStripe {
  readonly billingPortal: {
    readonly sessions: {
      create(params: PortalSessionParams): PromiseLike<{ readonly id: string; readonly url: string }>;
    };
  };
}

/** The Customer Portal session this handler creates: a subset of Stripe's parameters. */
export interface PortalSessionParams {
  readonly customer: string;
  readonly configuration: string;
  readonly return_url: string;
}

/** The fields of a Stripe invoice the list reads. */
export interface InvoiceLike {
  readonly id: string;
  readonly number: string | null;
  readonly status: string | null;
  readonly created: number;
  readonly currency: string;
  readonly total: number;
  readonly amount_due: number;
  readonly amount_paid: number;
  readonly hosted_invoice_url?: string | null;
  readonly invoice_pdf?: string | null;
}

/** What listing invoices needs from the Stripe client. */
export interface InvoiceStripe {
  readonly invoices: {
    list(params: { customer: string; limit: number }): PromiseLike<{ readonly data: readonly InvoiceLike[]; readonly has_more: boolean }>;
  };
}

/** Everything the billing function calls on Stripe. */
export type BillingStripe = CheckoutStripe & PortalStripe & InvoiceStripe;

/** How many of the latest invoices the list asks Stripe for; older ones are in the Customer Portal. */
export const INVOICE_PAGE = 24;

/** A link from Stripe, if it's an https page on stripe.com (the hosted invoice page, its PDF); otherwise null. */
export function stripeLink(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "stripe.com" || parsed.hostname.endsWith(".stripe.com")) ? parsed.href : null;
  } catch {
    return null;
  }
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
  readonly billing_address_collection: "required";
  readonly tax_id_collection: { readonly enabled: true };
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
  readonly stripe: () => Promise<BillingStripe>;
  /** The price ID for a catalog price, by its lookup key (billing/prices.ts). */
  readonly priceFor: (plan: CatalogPlan, price: CatalogPrice) => Promise<string>;
  /** Our Customer Portal configuration's ID, by its metadata (billing/portal.ts). */
  readonly portalConfiguration: () => Promise<string>;
  /** The user pool's issuer URL; tokens from anywhere else are refused. */
  readonly issuerUrl: string;
  /** Cognito's GetUser with the caller's own token (cognito-user.ts): whether two-step sign-in is on. */
  readonly userInfo: UserInfo;
  /** `https://app.<env domain>`: where Checkout and the portal send the owner back to. Never from the request. */
  readonly appUrl: string;
  readonly obs: Observability;
  readonly now?: () => number;
}

/** GetUser failed for the two-step sign-in check (a 500, logged and counted apart from Stripe's failures). */
class MfaCheckError extends Error {
  override readonly name = "MfaCheckError";
  constructor(cause: unknown) {
    super("The two-step sign-in check failed", { cause });
  }
}

/** How each route's failures on our side or Stripe's are logged and counted. */
const FAILURES: Record<BillingRoute["action"], { readonly message: string; readonly metric: BusinessMetricName }> = {
  createCheckout: { message: "Checkout failed", metric: BusinessMetric.CheckoutSessionErrors },
  createPortalSession: { message: "Billing portal failed", metric: BusinessMetric.BillingPortalErrors },
  listInvoices: { message: "Invoices failed", metric: BusinessMetric.InvoiceListErrors },
};

const ROUTES = new Map(BILLING_ROUTES.map((r) => [routeKey(r), r]));
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const CLOSED_CHECKOUT = "This team was closed. Reopen it before choosing a plan.";

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

/** When the team's free trial ends (data/model.ts): `trialEndsAt`, or TRIAL_DAYS after it was made for a team from before trials. */
export { trialEnd };

/** A request's idempotency key for one Stripe create: the same inputs give the same key, so a retry makes nothing new. */
export function idempotencyKey(kind: string, teamId: string, parts: unknown): string {
  return `${kind}-${teamId}-${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

export function createBillingHandler(deps: BillingHandlerDeps) {
  const now = deps.now ?? Date.now;
  const { dbFor, obs } = deps;

  /** The caller's context for the path's team, as its owner with two-step sign-in on, or 403 (`not_member` for a team that doesn't exist, `mfa_required`, `mfa_sign_in_again`). */
  async function ownerContext(event: DataEvent, userId: string, route: BillingRoute): Promise<TeamContext> {
    const teamId = event.pathParameters?.teamId;
    if (typeof teamId !== "string" || !ID.test(teamId)) throw new ApiError(400, "bad_request", "Invalid team ID");
    const ctx = await authorizeTeam(dbFor({ teamId }), userId, teamId, new Date(now())).catch((error: unknown) => {
      if (error instanceof ForbiddenError) throw notMember();
      throw error;
    });
    requireRole(ctx.role, route.minRole);
    await requireMfa(event, userId, ctx.teamId);
    return ctx;
  }

  /** Two-step sign-in on (see 2a at the top), or 403 `mfa_required`; for TOTP, in a session that began after it was on (2b), or 403 `mfa_sign_in_again`. */
  async function requireMfa(event: DataEvent, userId: string, teamId: string): Promise<void> {
    const user = await deps.userInfo(accessToken(event)).catch((error: unknown) => {
      // Cognito couldn't answer: not Stripe's failure, so not counted as one
      throw error instanceof ApiError ? error : new MfaCheckError(error);
    });
    // The same user API Gateway verified, or something is badly wrong
    if (user.sub !== userId) throw new ApiError(401, "unauthenticated", "Sign in again");
    if (user.federated) return;
    if (!user.totp) throw new ApiError(403, "permission_denied", "Turn on two-step sign-in with an authenticator app (Account, in the team bar) before managing billing", "mfa_required");
    const after = await sessionAfterTotp(event, userId, teamId).catch((error: unknown) => {
      // DynamoDB couldn't answer: as for Cognito above
      throw new MfaCheckError(error);
    });
    if (!after) {
      throw new ApiError(403, "permission_denied", "Sign in again, with your password and a code from your authenticator app, before managing billing: this session began before two-step sign-in was turned on", "mfa_sign_in_again");
    }
  }

  /**
   * Whether the token's session began after TOTP was last turned on (2b at
   * the top). `auth_time` is when the user signed in, in whole seconds
   * (rounded down), so a later second is needed; a token without one fails.
   */
  async function sessionAfterTotp(event: DataEvent, userId: string, teamId: string): Promise<boolean> {
    const db = dbFor({ teamId, userId });
    const on = await totpOnAt(db, userId);
    if (on === undefined) {
      // TOTP is on (GetUser just said so), so now is no earlier than when it was turned on
      await recordTotpOn(db, userId, new Date(now()));
      obs.logger.info("Two-step sign-in time recorded", { userId });
      return false;
    }
    const authTime = Number(event.requestContext.authorizer.jwt.claims.auth_time);
    return Number.isInteger(authTime) && authTime * 1000 > on;
  }

  /** The body's plan and interval, checked against the catalog. Nothing else: the seat quantity is the server's. */
  function checkoutInput(event: DataEvent) {
    const body = jsonBody(event, ["plan", "interval"]);
    const found = typeof body.plan === "string" && typeof body.interval === "string" ? catalogPrice(body.plan, body.interval) : undefined;
    if (!found) throw new ApiError(400, "bad_request", "Choose a plan and an interval we sell (see the API description)");
    return found;
  }

  /**
   * The team's Stripe customer: the linked one, or a new one Stripe makes
   * (once per team: its idempotency key is the team's) and this links. If
   * another request linked one meanwhile, that one. Either way it's linked
   * (again) before the Checkout Session is made: every link moves the team's
   * version, so the lapsed-team job's closure, conditioned on the version it
   * read, can't close a team under a Checkout that's starting, and once the
   * team is closed the link, and so the Checkout, is refused (TeamClosedError).
   */
  async function customerFor(stripe: CheckoutStripe, ctx: TeamContext, team: Team): Promise<string> {
    const closedMeanwhile = async (error: unknown) => {
      if (error instanceof ConflictError && isClosed(await getTeam(dbFor({ teamId: ctx.teamId }), ctx))) throw new TeamClosedError(CLOSED_CHECKOUT);
      throw error;
    };
    const link = (customerId: string) => linkStripeCustomer(dbFor({ teamId: ctx.teamId, stripeCustomer: customerId }), ctx, customerId, new Date(now())).catch(closedMeanwhile);
    if (team.stripeCustomerId) {
      await link(team.stripeCustomerId);
      return team.stripeCustomerId;
    }
    const params = { name: team.name, metadata: { teamId: ctx.teamId } };
    // Once per team (and name: Stripe refuses a key reused with other parameters)
    const customer = await stripe.customers.create(params, { idempotencyKey: idempotencyKey("customer", ctx.teamId, params) });
    try {
      await link(customer.id);
      return customer.id;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const linked = (await getTeam(dbFor({ teamId: ctx.teamId }), ctx)).stripeCustomerId;
      if (!linked) throw error;
      await link(linked);
      return linked;
    }
  }

  async function createCheckout(event: DataEvent, userId: string, route: BillingRoute): Promise<APIGatewayProxyStructuredResultV2> {
    // Membership and role first, so anyone else gets the same 403 whatever they send
    const ctx = await ownerContext(event, userId, route);
    const key = header(event, IDEMPOTENCY_HEADER);
    if (!key || !REQUEST_KEY.test(key)) throw new ApiError(400, "bad_request", "Send an Idempotency-Key header: 8 to 128 letters, digits, - or _, new for each checkout");
    const input = checkoutInput(event);
    if (ctx.closed) throw new TeamClosedError(CLOSED_CHECKOUT);
    const db = dbFor({ teamId: ctx.teamId });
    const team = await getTeam(db, ctx);
    if (team.stripeSubscriptionId && !hasEnded(team.status)) {
      throw new ApiError(409, "aborted", "This team already has a subscription. Change it from Manage billing.", "already_subscribed");
    }
    // A seat for each billed member (owners and editors; viewers are free), at least one
    const seats = Math.max(1, await countBilledMembers(db, ctx));
    const stripe = await deps.stripe();
    // A subscription the webhook hasn't recorded yet (another checkout just finished): one per team
    if (team.stripeCustomerId && (await stripe.subscriptions.list({ customer: team.stripeCustomerId, status: "all", limit: 10 })).data.some((s) => !hasEnded(s.status))) {
      throw new ApiError(409, "aborted", "This team already has a subscription. Change it from Manage billing.", "already_subscribed");
    }
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
      line_items: [{ price: priceId, quantity: seats }],
      success_url: back("success"),
      cancel_url: back("canceled"),
      metadata: { teamId: ctx.teamId },
      // Still in the free trial: no card now, and Stripe cancels the subscription if none is added by its end
      payment_method_collection: trial ? "if_required" : "always",
      // The address, and a business's name and tax ID, go on the customer and so on every invoice
      billing_address_collection: "required",
      tax_id_collection: { enabled: true },
      customer_update: { address: "auto", name: "auto" },
      subscription_data: {
        metadata: { teamId: ctx.teamId, plan: input.plan.plan },
        ...(trial ? { trial_end: Math.floor(trialEndsMs / 1000), trial_settings: { end_behavior: { missing_payment_method: "cancel" as const } } } : {}),
      },
    };
    // A retry with the same Idempotency-Key and the same choices sends the same
    // parameters under the same key, so Stripe answers with the same session. (So
    // nothing in them may move with the clock: the page expires after Stripe's 24 hours.)
    // The seats are in the key too: if the billed members changed between tries, the
    // retry gets a new session rather than Stripe refusing a reused key.
    const session = await stripe.checkout.sessions.create(params, {
      idempotencyKey: idempotencyKey("checkout", ctx.teamId, { key, customer, priceId, seats, trial: params.subscription_data.trial_end ?? null }),
    });
    if (!session.url) throw new Error("Stripe returned a Checkout Session without a URL");
    obs.logger.info("Checkout started", { teamId: ctx.teamId, plan: input.plan.plan, interval: input.price.interval, seats, trial });
    return json(201, { checkout: { url: session.url, expiresAt: new Date(session.expires_at * 1000).toISOString(), trialEndsAt: trial ? new Date(trialEndsMs).toISOString() : null } });
  }

  /**
   * A Customer Portal session for the team's Stripe customer, with our portal
   * configuration. Owners only, checked before anything else; the body must
   * be none, or `{}`. A closed team (403 `team_closed`) or one with
   * no Stripe customer yet (409 `no_billing_account`) gets none. A team whose
   * subscription ended does: its owners can still see invoices and details.
   */
  async function createPortalSession(event: DataEvent, userId: string, route: BillingRoute): Promise<APIGatewayProxyStructuredResultV2> {
    const ctx = await ownerContext(event, userId, route);
    // Nothing to send: a body, if any, must be an empty object
    if (event.body) jsonBody(event, []);
    const customer = await linkedCustomer(ctx);
    const stripe = await deps.stripe();
    const configuration = await deps.portalConfiguration();
    const session = await stripe.billingPortal.sessions.create({ customer, configuration, return_url: `${deps.appUrl}/?billing=portal&team=${encodeURIComponent(ctx.teamId)}` });
    obs.logger.info("Billing portal opened", { teamId: ctx.teamId });
    return json(201, { portal: { url: session.url } });
  }

  /**
   * The team's latest invoices, newest first, as Stripe has them for the
   * team's own customer: the same owners-only checks and refusals as the
   * portal. Drafts (not sent yet, no page) are left out; `hasMore` says older
   * ones are in the portal. Nothing from the request reaches Stripe.
   */
  async function listInvoices(event: DataEvent, userId: string, route: BillingRoute): Promise<APIGatewayProxyStructuredResultV2> {
    const ctx = await ownerContext(event, userId, route);
    const customer = await linkedCustomer(ctx);
    const stripe = await deps.stripe();
    const page = await stripe.invoices.list({ customer, limit: INVOICE_PAGE });
    const invoices = page.data
      .filter((i) => i.status && i.status !== "draft")
      .map((i) => ({
        id: i.id,
        number: i.number,
        status: i.status,
        createdAt: new Date(i.created * 1000).toISOString(),
        currency: i.currency,
        total: i.total,
        amountDue: i.amount_due,
        amountPaid: i.amount_paid,
        hostedUrl: stripeLink(i.hosted_invoice_url),
        pdfUrl: stripeLink(i.invoice_pdf),
      }));
    obs.logger.info("Invoices listed", { teamId: ctx.teamId, count: invoices.length });
    return json(200, { invoices, hasMore: page.has_more });
  }

  /** The Stripe customer linked to the caller's team: 403 `team_closed` for a closed team, 409 `no_billing_account` for none. */
  async function linkedCustomer(ctx: TeamContext): Promise<string> {
    if (ctx.closed) throw new TeamClosedError("This team was closed. Reopen it before managing billing.");
    const team = await getTeam(dbFor({ teamId: ctx.teamId }), ctx);
    const customer = team.stripeCustomerId;
    if (!customer || !ID.test(customer)) throw new ApiError(409, "aborted", "This team has no billing account yet. Subscribe first.", "no_billing_account");
    return customer;
  }

  const actions: Record<BillingRoute["action"], (event: DataEvent, userId: string, route: BillingRoute) => Promise<APIGatewayProxyStructuredResultV2>> = {
    createCheckout,
    createPortalSession,
    listInvoices,
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
      if (error instanceof MfaCheckError) {
        // Only the error's name: GetUser's errors carry only Cognito's status and type
        obs.logger.error("Two-step sign-in check failed", { code: (error.cause as { name?: string } | null)?.name ?? "Unknown" });
      } else if (apiError.status >= 500) {
        const teamId = event.pathParameters?.teamId;
        // Stripe's error fields only: never its message, which can echo what was sent
        const failed = FAILURES[route?.action ?? "createCheckout"];
        const reason = error instanceof PriceNotFoundError ? "price_not_found" : error instanceof PortalConfigurationNotFoundError ? "portal_configuration_not_found" : undefined;
        obs.logger.error(failed.message, { ...(typeof teamId === "string" && ID.test(teamId) ? { teamId } : {}), ...stripeErrorFields(error), ...(reason ? { reason } : {}) });
        obs.count(failed.metric);
      }
      return errorResponse(apiError);
    } finally {
      obs.logger.info("Request", { route: event.routeKey, status, ms: now() - started });
    }
  };
}
