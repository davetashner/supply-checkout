// Small pure parts of the billing journeys (tests/prod/billing.mjs; supply-checkout-o60.9).
import { randomBytes } from "node:crypto";

/**
 * A password for the billing throwaway, meeting the user pool's policy (12 or more characters,
 * upper and lower case, a number and a symbol): a fixed start for the classes, then 96 random bits.
 */
export function newPassword(random = randomBytes) {
  return `Tw1!${random(12).toString("hex")}`;
}

/** The base32 secret out of the key as the app shows it ("ABCD EFGH …"), or throws without echoing it. */
export function parseTotpKey(text) {
  const key = String(text ?? "").replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z2-7]{16,}$/.test(key)) throw new Error("The authenticator key the app showed isn't a base32 secret");
  return key;
}

/**
 * Whether a team body from /me (or the Checkout answer's team) is the sandbox subscription the
 * journey expects after Checkout: the Starter plan, trialing or active.
 */
export function isSubscribed(team) {
  return team?.plan === "starter" && (team.status === "trialing" || team.status === "active");
}

/** Whether a GET billing/invoices answer is fine for the read-only live check: a list, or "no billing account yet". */
export function invoicesAnswerOk({ status, body }) {
  if (status === 200) return Array.isArray(body?.invoices);
  return status >= 400 && status < 500 && body?.error?.reason === "no_billing_account";
}
