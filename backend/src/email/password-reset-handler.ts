// Password resets asked for in the app (supply-checkout-6uw.26): a reset code
// for an address with an account, or a short help email for one without.
//
// Who asks: the API's POST /auth/password-reset (api/password-reset-handler.ts),
// with an asynchronous invoke carrying the address as typed and the caller's
// IP address (PasswordResetRequest). The API answers the same way before any
// of this runs, so neither its answer nor how long it takes says whether the
// address has an account. Only the address's inbox learns that.
//
// For each request:
// 1. The limits (data/password-resets.ts), before the address is looked up,
//    so they count an address with an account and one without alike: per
//    address and per IP address, by the hour and the day. Past any, nothing
//    is sent.
// 2. The native user who signs in with the address (AdminGetUser by alias). If
//    it's enabled, confirmed and its email verified, Cognito's ForgotPassword
//    emails it a code, as Managed Login's reset does. A disabled user gets
//    nothing.
// 3. Otherwise (no such user, one Cognito won't send a code to, or a Google or
//    Apple user), a help email: why there's no code, and the ways in that might
//    work ("sign in with Google", or "a different address, Google or Apple, or
//    create an account"). At most one an address a day, and
//    PASSWORD_RESET_HELP_PER_DAY in all, so the route can't be used to mail
//    many addresses: the email is fixed text, with nothing from the request
//    in it but the recipient.
//
// Failures: SES refusing the email (a suppressed address, sending paused) is
// logged and not retried. A failed Cognito or DynamoDB call is thrown, which
// counts in the function's errors; Lambda doesn't try again (the person can
// ask again), and there's no dead-letter queue, since the request holds an
// address.
//
// Logs and metrics carry the outcome and the error's name: never the address
// or the IP address.

import { type Db, mailAddress, resetAddressKey, resetIpKey, takePasswordReset, takePasswordResetHelp } from "../data/index.js";
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
  /** The app table, as the function's role reaches it: UpdateItem of PASSWORD_RESET_LIMIT_ATTRIBUTES in `RESETLIMIT#` partitions. */
  readonly db: Db;
  readonly mailer: Mailer;
  readonly obs: Observability;
  /** `support@<env domain>`, which the help email names. */
  readonly supportAddress: string;
  readonly now?: () => Date;
}

/** What became of a request, as logged. */
export type ResetOutcome = "invalid" | "limited" | "code" | "code_limited" | "disabled" | "help" | "help_limited" | "help_refused";

/** The request, if it's one: an address and an IP address, as strings of sane length. */
export function resetRequestOf(event: unknown): PasswordResetRequest | undefined {
  const { email, ip } = (event ?? {}) as { email?: unknown; ip?: unknown };
  if (typeof email !== "string" || email.length > 320 || typeof ip !== "string" || ip.length > 64) return undefined;
  return { email, ip };
}

/** A native user Cognito will email a reset code to: enabled, confirmed (or asked to reset) and with a verified email. */
function resettable(user: PoolUser): boolean {
  const attributes = { ...user.attributes, "cognito:user_status": user.status };
  return user.enabled && (user.status === "CONFIRMED" || user.status === "RESET_REQUIRED") && user.attributes.email_verified === "true" && !isFederatedOnly(user.username, attributes);
}

export function createPasswordResetHandler(deps: PasswordResetDeps) {
  const { lookup, db, mailer, obs } = deps;
  const now = deps.now ?? (() => new Date());

  /** The provider to suggest when the address is only a Google or Apple user's, or "none" when there's no account to suggest; "disabled" when every account for it is. */
  async function others(address: string, typed: string): Promise<FederatedProvider | "none" | "disabled"> {
    const users = (await lookup.byEmail([address, typed])).filter((u) => asciiLower((u.attributes.email ?? "").trim()) === address);
    if (users.length > 0 && users.every((u) => !u.enabled)) return "disabled";
    for (const u of users) {
      const provider = u.enabled ? federatedProvider(u.username, u.attributes.identities) : undefined;
      if (provider) return provider;
    }
    return "none";
  }

  async function help(address: string, addressKey: string, signInWith: FederatedProvider | undefined): Promise<ResetOutcome> {
    if (!(await takePasswordResetHelp(db, addressKey, now()))) {
      obs.count(BusinessMetric.PasswordResetsLimited, 1, { limit: "help" });
      return "help_limited";
    }
    try {
      await mailer.send(address, { kind: "passwordResetHelp", supportAddress: deps.supportAddress, ...(signInWith ? { signInWith } : {}) });
    } catch (error) {
      if (!(error instanceof EmailNotSentError)) throw error;
      obs.logger.warn("Password reset help not sent", { error: error.code });
      return "help_refused";
    }
    obs.count(BusinessMetric.PasswordResetHelpEmails, 1, { signInWith: signInWith ?? "none" });
    return "help";
  }

  async function handle(event: unknown): Promise<ResetOutcome> {
    const request = resetRequestOf(event);
    if (!request) return "invalid";
    let address: string, addressKey: string, ipKey: string;
    try {
      address = mailAddress(request.email);
      addressKey = resetAddressKey(address);
      ipKey = resetIpKey(request.ip);
    } catch {
      return "invalid";
    }
    if (!(await takePasswordReset(db, addressKey, ipKey, now()))) {
      obs.count(BusinessMetric.PasswordResetsLimited, 1, { limit: "request" });
      return "limited";
    }

    const native = await lookup.byAlias(address);
    if (native && !native.enabled) return "disabled";
    if (native && resettable(native)) {
      const sent = await lookup.forgotPassword(native.username);
      if (sent === "sent") return "code";
      if (sent === "limited") {
        obs.count(BusinessMetric.PasswordResetsLimited, 1, { limit: "cognito" });
        return "code_limited";
      }
      // Cognito won't send one after all: help, as for an address with no account
    }
    // A native user who can't be sent a code gets the general help; only an address with no native user may be a Google or Apple one
    const other = native ? "none" : await others(address, request.email.trim());
    if (other === "disabled") return "disabled";
    return help(address, addressKey, other === "none" ? undefined : other);
  }

  return async (event: unknown): Promise<void> => {
    const outcome = await handle(event);
    obs.logger.info("Password reset", { outcome });
  };
}
