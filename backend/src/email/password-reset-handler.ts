// Password resets asked for in the app (supply-checkout-6uw.26): a reset code
// for an address with an account, a short "sign in with Google" (or Apple)
// hint for an address only a Google or Apple account has, and nothing for any
// other address.
//
// Who asks: the API's POST /auth/password-reset (api/password-reset-handler.ts),
// with an asynchronous invoke carrying the address as typed
// (PasswordResetRequest), once the API has counted the request against the
// address's and the caller's IP address's limits (data/password-resets.ts),
// which count requests, not accounts. The API answers the same way before any
// of this runs, so neither its answer nor how long it takes says whether the
// address has an account; the app shows everyone the same guidance (another
// address, Google, or no account yet).
//
// For each request:
// 1. The native user who signs in with the address (AdminGetUser by alias). If
//    it's enabled, confirmed and its email verified, Cognito's ForgotPassword
//    emails it a code, as Managed Login's reset does. Any other native user
//    (disabled, unconfirmed, an unverified address) gets nothing.
// 2. With no native user, an enabled Google or Apple user whose verified email
//    is the address gets a hint: there's no password, sign in with Google (or
//    Apple). The pool knows the address and its provider vouched for it, so
//    this never mails an address nobody signed up with. At most one an address
//    a day, and PASSWORD_RESET_HINTS_PER_DAY in all. It's fixed text with
//    nothing from the request in it but the recipient.
// 3. Any other address gets nothing (the owner's decision, 2026-10-08: no
//    email to addresses without an account, which would let anyone make the
//    app mail made-up addresses and hurt SES's bounce and complaint rates).
//
// Failures: SES refusing the hint (a suppressed address, sending paused) is
// logged and not retried. A failed Cognito or DynamoDB call is thrown, which
// counts in the function's errors; Lambda doesn't try again (the person can
// ask again), and there's no dead-letter queue, since the request holds an
// address.
//
// Logs and metrics carry the outcome and the error's name: never the address.

import { type Db, mailAddress, resetAddressKey, takePasswordResetHint } from "../data/index.js";
import type { PoolUser } from "../identity/cognito-admin.js";
import { asciiLower, federatedProvider, isFederatedOnly } from "../identity/email-verified-handler.js";
import type { FederatedProvider } from "../identity/names.js";
import type { ResetLookup } from "../identity/reset-lookup.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { EmailNotSentError, type Mailer } from "./mailer.js";
import type { PasswordResetRequest } from "./names.js";

export interface PasswordResetDeps {
  /** The app pool (AdminGetUser and ListUsers only) and Cognito's ForgotPassword. */
  readonly lookup: ResetLookup;
  /** The app table, as the function's role reaches it: UpdateItem of PASSWORD_RESET_LIMIT_ATTRIBUTES in `RESETLIMIT#HINT` partitions (the provider hints' limits). */
  readonly db: Db;
  readonly mailer: Mailer;
  readonly obs: Observability;
  /** `support@<env domain>`, which the provider hint names. */
  readonly supportAddress: string;
  readonly now?: () => Date;
}

/**
 * What became of a request, as logged: a code; nothing, for an address with no
 * account Cognito would send a code to (`no_code`) or a disabled one; or a
 * provider hint, or not, past its limits or refused by SES.
 */
export type ResetOutcome = "invalid" | "code" | "code_limited" | "no_code" | "disabled" | "hint" | "hint_limited" | "hint_capped" | "hint_refused";

/** The request, if it's one: an address, as a string of sane length. */
export function resetRequestOf(event: unknown): PasswordResetRequest | undefined {
  const { email } = (event ?? {}) as { email?: unknown };
  if (typeof email !== "string" || email.length > 320) return undefined;
  return { email };
}

/** A native user Cognito will email a reset code to: enabled, confirmed (or asked to reset) and with a verified email. */
function resettable(user: PoolUser): boolean {
  const attributes = { ...user.attributes, "cognito:user_status": user.status };
  return user.enabled && (user.status === "CONFIRMED" || user.status === "RESET_REQUIRED") && user.attributes.email_verified === "true" && !isFederatedOnly(user.username, attributes);
}

export function createPasswordResetHandler(deps: PasswordResetDeps) {
  const { lookup, db, mailer, obs } = deps;
  const now = deps.now ?? (() => new Date());

  /**
   * The provider of an enabled Google or Apple user whose verified email is
   * this address, if there is one: an account the pool knows, with an address
   * its provider vouched for.
   */
  async function providerFor(address: string, typed: string): Promise<FederatedProvider | undefined> {
    const users = await lookup.byEmail([address, typed]);
    for (const u of users) {
      if (!u.enabled || u.attributes.email_verified !== "true" || asciiLower((u.attributes.email ?? "").trim()) !== address) continue;
      const provider = federatedProvider(u.username, u.attributes.identities);
      if (provider) return provider;
    }
    return undefined;
  }

  async function hint(address: string, addressKey: string, signInWith: FederatedProvider): Promise<ResetOutcome> {
    const taken = await takePasswordResetHint(db, addressKey, now());
    if (taken !== "ok") {
      // Everyone's cap reached has its own metric, for the "Password reset hints capped" alarm
      obs.count(taken === "cap" ? BusinessMetric.PasswordResetHintsCapped : BusinessMetric.PasswordResetsLimited, 1, { limit: "hint" });
      return taken === "cap" ? "hint_capped" : "hint_limited";
    }
    try {
      await mailer.send(address, { kind: "passwordResetProvider", signInWith, supportAddress: deps.supportAddress });
    } catch (error) {
      if (!(error instanceof EmailNotSentError)) throw error;
      obs.logger.warn("Password reset hint not sent", { error: error.code });
      return "hint_refused";
    }
    obs.count(BusinessMetric.PasswordResetProviderHints, 1, { signInWith });
    return "hint";
  }

  async function handle(event: unknown): Promise<ResetOutcome> {
    const request = resetRequestOf(event);
    if (!request) return "invalid";
    let address: string, addressKey: string;
    try {
      address = mailAddress(request.email);
      addressKey = resetAddressKey(address);
    } catch {
      return "invalid";
    }

    const native = await lookup.byAlias(address);
    if (native) {
      if (!native.enabled) return "disabled";
      if (!resettable(native)) return "no_code";
      const sent = await lookup.forgotPassword(native.username);
      if (sent === "limited") {
        obs.count(BusinessMetric.PasswordResetsLimited, 1, { limit: "cognito" });
        return "code_limited";
      }
      return sent === "sent" ? "code" : "no_code";
    }
    // No native user: only a Google or Apple account's address gets a hint; any other gets nothing (the screen says what to try)
    const provider = await providerFor(address, request.email.trim());
    return provider ? hint(address, addressKey, provider) : "no_code";
  }

  return async (event: unknown): Promise<void> => {
    const outcome = await handle(event);
    obs.logger.info("Password reset", { outcome });
  };
}
