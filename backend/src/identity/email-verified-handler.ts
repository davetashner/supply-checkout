// The pre token generation trigger that sets email_verified for Google and
// Apple users from the provider's own claim (supply-checkout-6v9).
//
// Why a trigger: Cognito requires every attribute an IdP maps to be writable
// by the app client, and the web client must never be able to write
// email_verified (the API trusts a verified email for invites). So the
// providers map their `email_verified` claim to `custom:idp_email_verified`
// instead, and this trigger copies it to email_verified with
// AdminUpdateUserAttributes.
//
// When it trusts the custom attribute: the user can write it too (it's
// mapped, so it's client-writable), so the trigger reads it only when Cognito
// has just overwritten it with the provider's claim:
//
// - The trigger source is TokenGeneration_HostedAuth: a sign-in through
//   Managed Login, which is the only way into a federated user. Refreshes
//   (TokenGeneration_RefreshTokens) and API sign-ins are ignored, because the
//   attribute then holds whatever was last written, possibly by the user.
// - The user is a federated-only user: its username is
//   `<providerName>_<provider user ID>` for a Google or SignInWithApple entry
//   in `identities`, which Cognito maintains and no client can write, and
//   Cognito marks it EXTERNAL_PROVIDER (`cognito:user_status`).
// - Such a user can't sign in natively: the pre authentication trigger
//   (sign-in-guard-handler.ts) refuses every password, email-code and passkey
//   sign-in by one. So a Managed Login token for them always comes from a
//   provider sign-in, and Cognito applies the attribute mapping (email and
//   the claim) before this trigger runs. Managed Login's own sign-ins are
//   also TokenGeneration_HostedAuth, which is why the guard is needed.
//
// Accepted risk: if a provider sign-in left the claim out, Cognito would keep
// the attribute's last value, which the user may have written. Google and
// Apple always send email_verified with the email scope, so this doesn't
// happen with them; a missing attribute (never mapped) counts as unverified.
//
// A native user linked to a provider (account-link-handler.ts,
// supply-checkout-0b1) doesn't meet the second condition and never has its
// email_verified promoted here: its email was verified with Cognito's own
// code, and a Managed Login sign-in for it may not have gone through the
// provider. The linking trigger reuses providerSaysVerified(), since Cognito
// puts the mapped attributes in the pre sign-up event too.
//
// Linked users (supply-checkout-kgw). Cognito applies the provider's attribute
// mapping to a linked user at every provider sign-in, so a changed provider
// email overwrites `email`, and email_verified stays "true". The invariant:
// a linked user's email_verified is "true" only for the address recorded in
// `custom:linked_email`, which is always one proven with a Cognito code (the
// linking trigger records it from a user whose email_verified is "true", and
// this trigger records a new one only after the person proved it with a code
// through the account API; see below). So, for a native user with a Google
// or Apple identity linked (linkedUser()), whose email differs from the
// recorded one while email_verified is "true":
//
// - At a Managed Login token (TokenGeneration_HostedAuth), which is the only
//   token that follows a provider sign-in, the email may have just been
//   rewritten from the provider: the trigger sets email_verified to "false"
//   (outcome "linked-unverified"). It never restores the recorded address or
//   promotes anyone: it only takes trust away. The person proves the new
//   address with a Cognito code, as for any change of email. Before the
//   downgrade it sets `custom:downgrade_pending`, and the downgrade clears it
//   in the same write, so the flag is cleared only by a successful downgrade
//   (supply-checkout-0qr8) or a proven address (below). A failed downgrade is
//   tried once more after a short pause; if that fails too, the sign-in fails
//   ("linked-downgrade-failed", counted in EmailUnverifyFailures, logged with
//   the user's correlation handle) and can be tried again: going ahead would
//   issue tokens for an unproven address. A native Managed Login sign-in
//   looks the same here, so a native change of email followed first by a
//   Managed Login sign-in is unverified too, and needs its code again.
// - While the flag is set, the downgrade is owed: a Managed Login token with
//   email_verified "true" downgrades again (even for the recorded address).
//   If email_verified is already "false" (an administrator unverified it),
//   any token clears the flag ("linked-cleared"), since a later "true" can
//   only come from a Cognito code.
// - At any other token (a refresh, an API sign-in), the trigger records the
//   email in `custom:linked_email` ("linked-recorded"), and clears a pending
//   downgrade in the same write, only when it is the address the person last
//   proved with a code, less than an hour ago: after POST /me/email/verify
//   succeeds for the address the code was sent to, the account function
//   writes a hash of the address to a VERIFIED_EMAIL item in the user's own
//   partition (data/verified-email.ts, supply-checkout-ytr2), and the
//   trigger reads it (GetItem, only the hash and its time). Any other verified-
//   looking email is left unrecorded ("linked-not-proven", or "linked-
//   downgrade-pending" while the flag is set), so the API keeps treating it
//   as unverified, and the person verifies it in the app. This is a positive
//   signal: no Cognito state has to be written for a rewritten address to
//   stay unrecorded, so throttling the pool's shared user-update quota (which
//   can make the flag and the downgrade fail) can't get one recorded. A failed
//   read ("linked-lookup-failed") or recording ("linked-record-failed") is
//   logged and counted in EmailVerifyFailures, the sign-in goes ahead, and
//   the next token tries again.
//
// Nothing is written for a linked user whose email is the recorded one (and
// no downgrade is pending), or whose email_verified isn't "true". The account
// API applies the same rule to what GetUser returns (src/api/cognito-user.ts),
// so a rewritten address shows no invites even before this trigger has run.
//
// Known gaps, accepted: an address Cognito verified outside the API (a client
// calling VerifyUserAttribute itself, or an administrator setting
// email_verified) isn't recorded until the person verifies it in the app
// again, or an administrator also sets `custom:linked_email`. With
// keepOriginal on, a native change of email keeps the old, verified address
// in `email` until the new one's code is entered, so GetUser (and /me) show
// the old address as verified meanwhile; the app has no change-of-email flow
// yet, so there's no pending-address signal (docs/infrastructure.md).
//
// A code proves only the address it was sent to (supply-checkout-cjw7): the
// code route records that address, and the verify route records a proof only
// when the email before and after Cognito took the code is that address. So a
// provider's rewrite between sending and checking a code gets nothing
// recorded, even if Cognito accepted the old code for the new address (which
// it doesn't document either way). The trigger honours a proof for an hour
// (VERIFIED_EMAIL_TTL_MS), since the app refreshes right after the code, so
// an old proof can't be replayed for an address that comes back later.
//
// What it does: email_verified becomes "true" when the provider says the email
// is verified (Google sends a boolean, Apple a boolean or the string
// "true"/"false"; mapped into a string attribute, both arrive as text), and
// "false" when the provider says it isn't. Nothing is written when it
// already matches. A failed update is logged and the sign-in goes ahead; the
// next sign-in tries again. A failed promotion leaves the user unverified
// (safe); a failed downgrade leaves them verified until the next sign-in, and
// is logged as its own outcome, "downgrade-failed", at error level. Each
// counts in its own business metric (EmailVerifyFailures,
// EmailUnverifyFailures), which an alarm watches.
//
// The address an email change is told to (supply-checkout-8jc.31): once the
// outcome is settled, the trigger records the user's address if the API would
// now trust it and none is recorded yet (rememberNoticeAddress,
// notice-address.ts; settledAttributes says what this token's writes left),
// never one it has just unverified or tried to. Only with time left for its
// two calls within WRITE_BUDGET_MS, and it never fails the token: a failure is
// logged with the error's name only and counted (SecurityNoticeFailures).
//
// The welcome email (supply-checkout-6uw.25): a Google or Apple user's account
// is made at their first sign-in, and its email is first trusted here, when
// the trigger marks it verified (outcome "verified": Cognito had it
// unverified and the provider says it's verified). Then the trigger hands the
// welcome email to its function (welcome-invoke.ts, an asynchronous invoke),
// which claims a once-only record before it sends, so a retried trigger, or a
// later "verified" (a provider that stopped and then went back to vouching for
// the address), sends nothing more. Later sign-ins are "unchanged" and hand
// nothing over, and an account that had its address verified before this
// existed is never sent one. Only with time left for the call within
// WRITE_BUDGET_MS, and it never fails the token: a failure (or no time left)
// is logged with the error's name only and counted (WelcomeEmailFailures).
//
// Logs carry the provider and the outcome, never the email or the username
// (which contains the provider's user ID). A linked user's failed downgrade
// also carries a correlation handle, an HMAC of the user's sub with a key
// only the operator and the function have (logCorrelation()).
//
// Accepted risk: the key reaches the function as an environment variable (a
// dynamic reference resolved at deploy time), so anyone who may call
// lambda:GetFunctionConfiguration on the function, or read CloudFormation
// drift detection's results for its stack, can read it, and with it turn a
// handle back into a user by hashing candidate subs. That's the same set of
// operators who can already read the logs and the user pool, and the handle
// protects only against someone who has the logs alone.

import { createHmac } from "node:crypto";
import type { PreTokenGenerationTriggerEvent } from "aws-lambda";
import { verifiedEmailHash } from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import type { UpdateUserAttributes } from "./cognito-admin.js";
import type { NoticeAddressOutcome, RememberNoticeAddress } from "./notice-address.js";
import type { SendWelcome } from "./welcome-invoke.js";
import {
  DOWNGRADE_PENDING_ATTRIBUTE,
  FEDERATED_PROVIDERS,
  type FederatedProvider,
  LINKED_EMAIL_ATTRIBUTE,
  PROVIDER_EMAIL_VERIFIED_ATTRIBUTE,
} from "./names.js";

export interface EmailVerifiedDeps {
  readonly updateUserAttributes: UpdateUserAttributes;
  /**
   * The hash of the address the user (by `sub`) last proved with a code
   * through the account API, or undefined (data/verified-email.ts).
   */
  readonly provenEmailHash: (sub: string) => Promise<string | undefined>;
  readonly obs: Observability;
  /** A user's log correlation handle from their `sub` (logCorrelation()). Without it, failure logs say "unavailable". */
  readonly correlate?: (sub: string) => string;
  /** For tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /**
   * Records the address an email change is told to (notice-address.ts,
   * supply-checkout-8jc.31). Without it, nothing is recorded.
   */
  readonly rememberNoticeAddress?: RememberNoticeAddress;
  /**
   * Hands a new Google or Apple account's welcome email to its function
   * (welcome-invoke.ts, supply-checkout-6uw.25). Without it, none is sent.
   */
  readonly sendWelcome?: SendWelcome;
}

/** Each Cognito call's timeout (email-verified.ts passes it to the client). */
export const CALL_TIMEOUT_MS = 1_200;
/** The pause before trying a failed downgrade again. */
export const RETRY_PAUSE_MS = 250;
/**
 * The time the downgrade's writes may take, within the 5 seconds Cognito
 * gives the trigger: the flag, the downgrade, a pause and one more try, each
 * call at most CALL_TIMEOUT_MS, is 3.85 seconds.
 */
export const WRITE_BUDGET_MS = 4_000;
/**
 * Each DynamoDB call's timeout when recording the notice address (email-verified.ts
 * passes it to the recorder): best effort, so short. Its two calls start only
 * while they still fit in WRITE_BUDGET_MS, so the worst case (the linked
 * path's two calls, then these two) is 3.4 seconds, leaving room for a cold
 * start in Cognito's 5.
 */
export const NOTICE_CALL_TIMEOUT_MS = 500;
/**
 * The welcome email's invoke timeout (email-verified.ts passes it to the
 * invoker). It starts only while it still fits in WRITE_BUDGET_MS, after the
 * promotion's one write and the notice address's two calls: 3 seconds at worst.
 */
export const WELCOME_CALL_TIMEOUT_MS = 800;

/**
 * A user's log correlation handle: the first 16 hex digits of
 * HMAC-SHA256(key, sub). It names no user to someone reading the logs, and an
 * operator with the key can find the user it belongs to (docs/journeys.md).
 */
export function logCorrelation(key: string): (sub: string) => string {
  return (sub) => createHmac("sha256", key).update(sub, "utf8").digest("hex").slice(0, 16);
}

/** True only for the provider's claim saying yes: boolean true or the text "true" (any case, trimmed). */
export function providerSaysVerified(value: unknown): boolean {
  if (value === true) return true;
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

interface Identity {
  readonly providerName?: unknown;
  readonly providerType?: unknown;
  readonly userId?: unknown;
}

/**
 * The provider a federated-only user signs in with: the Google or Apple entry
 * in `identities` (Cognito's JSON list) whose `<providerName>_<userId>` is the
 * username. Undefined for anyone else, including a native user with a linked
 * provider. Usernames compare case-insensitively, as the pool does.
 */
export function federatedProvider(userName: unknown, identities: unknown): FederatedProvider | undefined {
  if (typeof userName !== "string" || typeof identities !== "string") return undefined;
  let list: unknown;
  try {
    list = JSON.parse(identities);
  } catch {
    return undefined;
  }
  if (!Array.isArray(list)) return undefined;
  const name = userName.toLowerCase();
  for (const entry of list as Identity[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const provider = FEDERATED_PROVIDERS.find((p) => p === entry.providerName && p === entry.providerType);
    if (provider && typeof entry.userId === "string" && entry.userId !== "" && `${provider}_${entry.userId}`.toLowerCase() === name) return provider;
  }
  return undefined;
}

/**
 * True for a user who must sign in only through Google or Apple: a Google or
 * Apple identity whose `<providerName>_<userId>` is the username, or a user
 * Cognito marks EXTERNAL_PROVIDER. (The sign-in guard's rule; it's here so the
 * guard, this trigger and the linking trigger share it.)
 */
export function isFederatedOnly(userName: unknown, attributes: Readonly<Record<string, string | undefined>>): boolean {
  return federatedProvider(userName, attributes.identities) !== undefined || attributes["cognito:user_status"] === "EXTERNAL_PROVIDER";
}

/** Lowers A–Z only: no Unicode case folding, so only ASCII-identical addresses match. */
export const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The Google and Apple providers in `identities` (Cognito's JSON list); undefined when it can't be read. */
export function linkedProviders(identities: string | undefined): string[] | undefined {
  try {
    const list: unknown = JSON.parse(identities ?? "[]");
    if (!Array.isArray(list)) return undefined;
    return list
      .map((e: { providerName?: unknown } | null) => e?.providerName)
      .filter((p): p is string => typeof p === "string" && (FEDERATED_PROVIDERS as readonly string[]).includes(p));
  } catch {
    return undefined;
  }
}

/**
 * True for a native user with a Google or Apple identity linked to it (or
 * whose identities can't be read, which is treated the same, to be safe).
 */
export function linkedUser(userName: unknown, attributes: Readonly<Record<string, string | undefined>>): boolean {
  if (isFederatedOnly(userName, attributes)) return false;
  const linked = linkedProviders(attributes.identities);
  return linked === undefined || linked.length > 0;
}

/** Whether a linked user's email is the one recorded when a provider was linked (or recorded since). */
export function isRecordedEmail(attributes: Readonly<Record<string, string | undefined>>): boolean {
  const recorded = attributes[LINKED_EMAIL_ATTRIBUTE]?.trim();
  return !!recorded && asciiLower(attributes.email?.trim() ?? "") === asciiLower(recorded);
}

/** Whether a linked user's downgrade is pending (`custom:downgrade_pending` set): its email mustn't be trusted or recorded. */
export function isDowngradePending(attributes: Readonly<Record<string, string | undefined>>): boolean {
  return !!attributes[DOWNGRADE_PENDING_ATTRIBUTE]?.trim();
}

/** Tokens that never follow a provider sign-in, so Cognito hasn't just rewritten the email. */
const NOT_AFTER_PROVIDER = new Set(["TokenGeneration_RefreshTokens", "TokenGeneration_Authentication", "TokenGeneration_NewPasswordChallenge", "TokenGeneration_AuthenticateDevice"]);

/** What a linked user's failed downgrade shows the person: it names no account detail. */
export const LINKED_FAILED_ERROR = "Sign-in couldn't finish. Try again.";

export type Outcome =
  | "not-provider-sign-in"
  | "not-federated"
  | "no-email"
  | "unchanged"
  | "verified"
  | "unverified"
  /** Couldn't mark verified: the user stays unverified. */
  | "failed"
  /** Couldn't mark unverified: the user stays verified until a later sign-in succeeds. */
  | "downgrade-failed"
  /** A linked user whose email is the recorded one, or isn't verified: nothing to do. */
  | "linked-unchanged"
  /** A linked user's email differed from the recorded one at a Managed Login token: unverified. */
  | "linked-unverified"
  /** Couldn't unverify a linked user's changed email: the sign-in fails. */
  | "linked-downgrade-failed"
  /** A linked user's email, proven with a code through the account API, is now the recorded one (and any pending downgrade is cleared). */
  | "linked-recorded"
  /** A linked user's verified-looking email isn't the one they last proved with a code: nothing is recorded. */
  | "linked-not-proven"
  /** Couldn't read the proven address: nothing is recorded until a later token reads it. */
  | "linked-lookup-failed"
  /** Couldn't record it: the API treats the email as unverified until a later token records it. */
  | "linked-record-failed"
  /** A linked user's downgrade is pending (an earlier one failed) and the email isn't a proven one: nothing is recorded. */
  | "linked-downgrade-pending"
  /** A linked user already unverified had a pending downgrade: the flag is cleared. */
  | "linked-cleared"
  /** Couldn't clear it: the user stays untrusted until a later token clears it. */
  | "linked-clear-failed";

/**
 * The user's attributes once this token's writes are in, for deciding whether
 * the API trusts the email (notice-address.ts); undefined when the trigger
 * itself just took trust away, or tried to and couldn't (the email isn't one
 * to record). An outcome that wrote nothing leaves them as they came, and a
 * failed write changes nothing, so the email stays as untrusted as it was.
 */
export function settledAttributes(outcome: Outcome, attributes: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>> | undefined {
  switch (outcome) {
    case "verified":
      return { ...attributes, email_verified: "true" };
    case "linked-recorded":
      return { ...attributes, [LINKED_EMAIL_ATTRIBUTE]: asciiLower(attributes.email?.trim() ?? ""), [DOWNGRADE_PENDING_ATTRIBUTE]: "" };
    case "unverified":
    case "downgrade-failed":
    case "linked-unverified":
      return undefined;
    default:
      return attributes;
  }
}

export function createEmailVerifiedHandler(deps: EmailVerifiedDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const handleOf = (attributes: Readonly<Record<string, string | undefined>>) => (deps.correlate && attributes.sub ? deps.correlate(attributes.sub) : "unavailable");

  /**
   * Unverifies a linked user's changed email at a Managed Login token. Order,
   * so each failure leaves the user no more trusted than before:
   *
   * 1. Flag the downgrade as pending (skipped when it already is). If this
   *    fails, the downgrade is still tried: it's what matters.
   * 2. Set email_verified to "false" and clear the flag in one call, so the
   *    flag is cleared only by a successful downgrade. Tried again once after
   *    a short pause if there's time left in Cognito's 5 seconds.
   *
   * If step 2 fails, the sign-in fails. With the flag set (step 1 worked, or
   * an earlier sign-in set it), no later token records the address and the
   * API doesn't trust it, until a Managed Login sign-in downgrades it. With
   * neither write through, a refresh could still record it: the failure log
   * says which (`flagged`), with the user's correlation handle, for the
   * runbook (docs/journeys.md, "Email verification not saved").
   */
  const downgrade = async (event: PreTokenGenerationTriggerEvent, attributes: Readonly<Record<string, string | undefined>>, pending: boolean): Promise<{ outcome: Outcome }> => {
    const started = now();
    let flagged = pending;
    if (!flagged) {
      try {
        await deps.updateUserAttributes(event.userPoolId, event.userName, { [DOWNGRADE_PENDING_ATTRIBUTE]: "1" });
        flagged = true;
      } catch (error) {
        deps.obs.logger.warn("Couldn't flag a linked user's downgrade as pending; trying the downgrade anyway", { outcome: "linked-flag-failed", error: (error as Error).message });
      }
    }
    const unverify = () => deps.updateUserAttributes(event.userPoolId, event.userName, { email_verified: "false", [DOWNGRADE_PENDING_ATTRIBUTE]: "" });
    let failure: unknown;
    try {
      await unverify();
      return { outcome: "linked-unverified" };
    } catch (error) {
      failure = error;
    }
    if (now() - started + RETRY_PAUSE_MS + CALL_TIMEOUT_MS <= WRITE_BUDGET_MS) {
      await sleep(RETRY_PAUSE_MS);
      try {
        await unverify();
        return { outcome: "linked-unverified" };
      } catch (error) {
        failure = error;
      }
    }
    deps.obs.logger.error("Couldn't mark a linked user's changed email unverified; the sign-in fails", {
      outcome: "linked-downgrade-failed",
      flagged,
      user: handleOf(attributes),
      error: (failure as Error).message,
    });
    deps.obs.count(BusinessMetric.EmailUnverifyFailures);
    throw new Error(LINKED_FAILED_ERROR, { cause: failure });
  };

  const linked = async (event: PreTokenGenerationTriggerEvent, attributes: Readonly<Record<string, string | undefined>>): Promise<{ outcome: Outcome }> => {
    if (!attributes.email) return { outcome: "no-email" };
    const pending = isDowngradePending(attributes);
    if (attributes.email_verified !== "true") {
      if (!pending) return { outcome: "linked-unchanged" };
      // Unverified already (an administrator, following the runbook): the
      // flag has done its job, and a later "true" can only come from a code
      try {
        await deps.updateUserAttributes(event.userPoolId, event.userName, { [DOWNGRADE_PENDING_ATTRIBUTE]: "" });
      } catch (error) {
        deps.obs.logger.error("Couldn't clear a linked user's pending downgrade", { outcome: "linked-clear-failed", error: (error as Error).message });
        deps.obs.count(BusinessMetric.EmailVerifyFailures);
        return { outcome: "linked-clear-failed" };
      }
      return { outcome: "linked-cleared" };
    }
    if (event.triggerSource === "TokenGeneration_HostedAuth") {
      // A pending downgrade is owed even if the email now looks like the recorded one
      return pending || !isRecordedEmail(attributes) ? downgrade(event, attributes, pending) : { outcome: "linked-unchanged" };
    }
    if (!NOT_AFTER_PROVIDER.has(event.triggerSource)) return { outcome: "linked-unchanged" };
    if (!pending && isRecordedEmail(attributes)) return { outcome: "linked-unchanged" };
    // Only the address the person last proved with a code is recorded, and
    // only it clears a pending downgrade: email_verified "true" alone may be
    // a provider's rewrite whose downgrade didn't go through
    const email = asciiLower(attributes.email.trim());
    let proven: string | undefined;
    try {
      proven = attributes.sub ? await deps.provenEmailHash(attributes.sub) : undefined;
    } catch (error) {
      deps.obs.logger.error("Couldn't read a linked user's proven email", { outcome: "linked-lookup-failed", error: (error as Error).message });
      deps.obs.count(BusinessMetric.EmailVerifyFailures);
      return { outcome: "linked-lookup-failed" };
    }
    if (proven !== verifiedEmailHash(email)) return { outcome: pending ? "linked-downgrade-pending" : "linked-not-proven" };
    try {
      await deps.updateUserAttributes(event.userPoolId, event.userName, { [LINKED_EMAIL_ATTRIBUTE]: email, ...(pending ? { [DOWNGRADE_PENDING_ATTRIBUTE]: "" } : {}) });
    } catch (error) {
      deps.obs.logger.error("Couldn't record a linked user's verified email", { outcome: "linked-record-failed", error: (error as Error).message });
      deps.obs.count(BusinessMetric.EmailVerifyFailures);
      return { outcome: "linked-record-failed" };
    }
    return { outcome: "linked-recorded" };
  };

  const handle = async (event: PreTokenGenerationTriggerEvent): Promise<{ outcome: Outcome; provider?: FederatedProvider }> => {
    const attributes = event.request?.userAttributes ?? {};
    if (linkedUser(event.userName, attributes)) return linked(event, attributes);
    if (event.triggerSource !== "TokenGeneration_HostedAuth") return { outcome: "not-provider-sign-in" };
    const provider = federatedProvider(event.userName, attributes.identities);
    if (!provider || attributes["cognito:user_status"] !== "EXTERNAL_PROVIDER") return { outcome: "not-federated" };
    if (!attributes.email) return { outcome: "no-email", provider };

    const verified = providerSaysVerified(attributes[PROVIDER_EMAIL_VERIFIED_ATTRIBUTE]);
    if (verified === (attributes.email_verified === "true")) return { outcome: "unchanged", provider };
    try {
      await deps.updateUserAttributes(event.userPoolId, event.userName, { email_verified: verified ? "true" : "false" });
    } catch (error) {
      const outcome = verified ? "failed" : "downgrade-failed";
      deps.obs.logger.error(verified ? "Couldn't mark email verified" : "Couldn't mark email unverified; it stays verified", {
        provider,
        outcome,
        error: (error as Error).message,
      });
      // The Lambda doesn't fail, so its Errors metric misses this; the "Email
      // verification not saved" alarm (docs/journeys.md, J3) watches these counts
      deps.obs.count(verified ? BusinessMetric.EmailVerifyFailures : BusinessMetric.EmailUnverifyFailures);
      return { outcome, provider };
    }
    return { outcome: verified ? "verified" : "unverified", provider };
  };

  /**
   * Records the address an email change is told to, if the API would trust
   * the email once this token's writes are in (settledAttributes) and none is
   * recorded yet (notice-address.ts). Only with time left for its two calls
   * within WRITE_BUDGET_MS; otherwise a later token does it. Never throws: a
   * failure is logged with the error's name only and counted.
   */
  const rememberAddress = async (
    remember: RememberNoticeAddress,
    event: PreTokenGenerationTriggerEvent,
    outcome: Outcome,
    started: number,
  ): Promise<NoticeAddressOutcome | "deferred" | "failed"> => {
    const attributes = settledAttributes(outcome, event.request?.userAttributes ?? {});
    if (!attributes) return "untrusted";
    if (now() - started + 2 * NOTICE_CALL_TIMEOUT_MS > WRITE_BUDGET_MS) return "deferred";
    try {
      return await remember(event.userName, attributes);
    } catch (error) {
      deps.obs.logger.error("Notice address not recorded", { outcome: "notice-address-failed", code: (error as { name?: string } | null)?.name ?? "Unknown" });
      deps.obs.count(BusinessMetric.SecurityNoticeFailures, 1, { kind: "emailChanged", reason: "record_address", via: "sign-in" });
      return "failed";
    }
  };

  /**
   * Hands the welcome email over for a Google or Apple user whose email this
   * token has just verified (see "The welcome email" at the top). Never throws.
   */
  const welcome = async (send: SendWelcome, event: PreTokenGenerationTriggerEvent, outcome: Outcome, provider: FederatedProvider | undefined, started: number) => {
    const userId = event.request?.userAttributes?.sub;
    if (outcome !== "verified" || !provider || !userId) return undefined;
    if (now() - started + WELCOME_CALL_TIMEOUT_MS > WRITE_BUDGET_MS) {
      deps.obs.logger.error("Welcome email not queued", { provider, code: "NoTimeLeft" });
      deps.obs.count(BusinessMetric.WelcomeEmailFailures, 1, { reason: "deferred", via: provider });
      return "failed";
    }
    try {
      await send({ userId, via: provider });
      return "queued";
    } catch (error) {
      deps.obs.logger.error("Welcome email not queued", { provider, code: (error as { name?: string } | null)?.name ?? "Unknown" });
      deps.obs.count(BusinessMetric.WelcomeEmailFailures, 1, { reason: "invoke", via: provider });
      return "failed";
    }
  };

  return async (event: PreTokenGenerationTriggerEvent): Promise<PreTokenGenerationTriggerEvent> => {
    const started = now();
    const { outcome, provider } = await handle(event);
    const noticeAddress = deps.rememberNoticeAddress ? await rememberAddress(deps.rememberNoticeAddress, event, outcome, started) : undefined;
    const welcomed = deps.sendWelcome ? await welcome(deps.sendWelcome, event, outcome, provider, started) : undefined;
    deps.obs.logger.info("Federated email", {
      triggerSource: String(event.triggerSource),
      outcome,
      ...(provider ? { provider } : {}),
      ...(noticeAddress ? { noticeAddress } : {}),
      ...(welcomed ? { welcome: welcomed } : {}),
    });
    // The tokens are unchanged: the API reads email_verified from Cognito (GetUser), not from a token
    return event;
  };
}
