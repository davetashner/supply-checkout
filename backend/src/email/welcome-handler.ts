// The welcome email: one per new account, to its verified address
// (supply-checkout-6uw.25).
//
// Who asks: the user pool's triggers, with an asynchronous invoke
// (identity/welcome-invoke.ts) carrying only the new account's sub and how it
// signed up (WelcomeRequest):
//
// - the post confirmation trigger, when a native user confirms their sign-up
//   with Cognito's email code (PostConfirmation_ConfirmSignUp; never a
//   forgotten password's confirmation);
// - the pre token generation trigger, when it first marks a Google or Apple
//   user's email verified, at the first sign-in that made their account.
//
// Only those two roles may invoke this function. It trusts nothing in the
// request but the sub: it looks the user up in the app pool (ListUsers, then
// AdminGetUser: cognitoAccounts) and sends only to the address the account API
// would trust (emailVerifiedFrom), with their own given name.
//
// Once: before sending, it claims the account's welcome record (claimWelcome,
// data/welcome.ts), a conditional write that also fails for an account being
// deleted. A second request for the same account (a retried trigger, both
// triggers, Lambda trying again, a replay) finds it claimed and sends nothing.
//
// Wording: if the account is already in a team, or a live invite is waiting
// for its address, the email points at that team; otherwise at creating one,
// with its 14-day trial. If that check fails, it's logged and the email says
// both.
//
// Failures never touch sign-up, which finished before this ran:
// - SES refusing the message (EmailNotSentError: sending paused, an address
//   SES won't send to, SES's sandbox) is counted in its own metric,
//   WelcomeEmailsRefused ("Welcome emails refused", a rate alarm), not in
//   WelcomeEmailFailures: until SES production access its sandbox refuses
//   every unverified address, and that mustn't hide the failures below. The
//   claim is given up, so a replay can send it; it isn't retried, since trying
//   again won't change SES's mind. Anything else the send throws is counted
//   (`error`) and thrown, so Lambda tries again.
// - A failed Cognito lookup or DynamoDB call is counted (`lookup_failed`,
//   `error`) and thrown, so Lambda tries twice more, then puts the request on
//   the dead-letter queue ("Welcome emails dropped"), to replay.
// - No verified address is counted (`no_address`); a user who's gone (deleted
//   since) or an account being deleted is only logged.
//
// Logs and metrics carry the sub, how they signed up, the outcome and the
// error's name: never the address or the name.

import { claimWelcome, type Db, hasLiveInvite, hasTeam, isTestAccount, normalizeEmail, releaseWelcome } from "../data/index.js";
import type { FindAccount } from "../identity/cognito-accounts.js";
import { SUB } from "../identity/cognito-accounts.js";
import { BusinessMetric, type Observability, testMark } from "../observability/index.js";
import { EmailNotSentError, type Mailer } from "./mailer.js";
import { WELCOME_VIA, type WelcomeRequest, type WelcomeVia } from "./names.js";

export interface WelcomeDeps {
  /** The app pool (ListUsers and AdminGetUser only). */
  readonly findAccount: FindAccount;
  /**
   * The app table, as the function's role reaches it: UpdateItem of
   * WELCOME_RECORD_ATTRIBUTES and ConditionCheckItem of the DELETING mark in
   * USER# partitions, the keys of a user's TEAM# rows, and GSI2's invitee
   * partitions (WELCOME_INVITE_ATTRIBUTES).
   */
  readonly db: Db;
  readonly mailer: Mailer;
  readonly obs: Observability;
  /** `support@<env domain>`. */
  readonly supportAddress: string;
  /** The test mail domain (TEST_MAIL_DOMAIN, data/test-accounts.ts): a test account's welcome is left out of WelcomeEmails. */
  readonly testMailDomain?: string;
  readonly now?: () => number;
}

/** What one request came to, for the log line. */
export type WelcomeOutcome = "sent" | "already-sent" | "deleting" | "no-user" | "no-address" | "not-sent" | "invalid";

/** An error already logged and counted, thrown on for Lambda to try again. */
class CountedError extends Error {
  constructor(cause: unknown) {
    super("Counted", { cause });
  }
}

const errorCode = (error: unknown) => (error instanceof EmailNotSentError ? error.code : ((error as { name?: string } | null)?.name ?? "Unknown"));

/** The request, if it's one the triggers send: a Cognito sub and a known sign-up method. */
export function welcomeRequest(event: unknown): WelcomeRequest | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const { userId, via } = event as { userId?: unknown; via?: unknown };
  if (typeof userId !== "string" || !SUB.test(userId)) return undefined;
  if (typeof via !== "string" || !(WELCOME_VIA as readonly string[]).includes(via)) return undefined;
  return { userId, via: via as WelcomeVia };
}

export function createWelcomeHandler(deps: WelcomeDeps) {
  const { db, obs } = deps;
  const now = () => new Date((deps.now ?? Date.now)());

  const failed = (reason: string, code: string, via: WelcomeVia | "unknown", userId?: string) => {
    obs.logger.warn("Welcome email not sent", { ...(userId ? { userId } : {}), via, reason, code });
    obs.count(BusinessMetric.WelcomeEmailFailures, 1, { reason, via });
  };

  /** Whether the account's next step is a team it was invited to (or has joined) rather than a new one; false if that can't be read. */
  async function invited(userId: string, address: string, at: Date): Promise<boolean> {
    try {
      return (await hasTeam(db, userId)) || (await hasLiveInvite(db, address, at));
    } catch (error) {
      obs.logger.warn("Welcome email's team check failed; it says both", { userId, code: errorCode(error) });
      return false;
    }
  }

  async function handle(event: unknown): Promise<WelcomeOutcome> {
    const request = welcomeRequest(event);
    if (!request) {
      failed("invalid", "InvalidRequest", "unknown");
      return "invalid";
    }
    const { userId, via } = request;

    let account: Awaited<ReturnType<FindAccount>>;
    try {
      account = await deps.findAccount(userId);
    } catch (error) {
      failed("lookup_failed", errorCode(error), via, userId);
      throw new CountedError(error);
    }
    if (!account) return "no-user";
    let to: string | undefined;
    try {
      to = account.emailVerified && account.email ? normalizeEmail(account.email) : undefined;
    } catch {
      to = undefined;
    }
    if (!to) {
      failed("no_address", "NoAddress", via, userId);
      return "no-address";
    }

    const at = now();
    let claim: Awaited<ReturnType<typeof claimWelcome>>;
    try {
      claim = await claimWelcome(db, userId, at);
    } catch (error) {
      failed("error", errorCode(error), via, userId);
      throw new CountedError(error);
    }
    if (claim === "sent") {
      // Usually a retried trigger or a replay. If no welcome went out, an earlier try died between
      // claiming and sending (a timeout, say): the function's Errors alarm ("Welcome email function failing") says so
      obs.logger.info("Welcome email already claimed", { userId, via });
      return "already-sent";
    }
    if (claim === "deleting") return "deleting";

    const invite = await invited(userId, to, at);
    try {
      await deps.mailer.send(to, { kind: "welcome", ...(account.givenName ? { givenName: account.givenName } : {}), invited: invite, supportAddress: deps.supportAddress });
    } catch (error) {
      if (error instanceof EmailNotSentError) {
        obs.logger.warn("Welcome email not sent", { userId, via, reason: "refused", code: error.code });
        obs.count(BusinessMetric.WelcomeEmailsRefused, 1, { via });
      } else {
        failed("error", errorCode(error), via, userId);
      }
      // Give the claim up, so a replay can send it; if that fails too, it stays claimed and no welcome goes out
      try {
        await releaseWelcome(db, userId, at);
      } catch (release) {
        obs.logger.error("Welcome email claim not given up", { userId, code: errorCode(release) });
      }
      if (error instanceof EmailNotSentError) return "not-sent";
      throw new CountedError(error);
    }
    obs.count(BusinessMetric.WelcomeEmails, 1, { via, ...testMark(isTestAccount(account, deps.testMailDomain)) });
    obs.logger.info("Welcome email sent", { userId, via, invited: invite });
    return "sent";
  }

  return async (event: unknown): Promise<void> => {
    const outcome = await handle(event);
    obs.logger.info("Welcome email", { outcome });
  };
}
