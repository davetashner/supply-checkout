// Test accounts and test teams (supply-checkout-o60.2, docs/journey-tests-plan.md).
//
// The prod journey tests sign in as real users whose addresses are at a mail
// subdomain only we can read (SES inbound to a private bucket). That
// subdomain is the one marker of a test account:
//
// - A test account is one whose VERIFIED email, as Cognito has it (never the
//   request), is at the test mail domain, matched exactly on the whole domain
//   part of the address. Not a suffix: neither `x.<domain>` nor
//   `<domain>.example` is one.
// - A test team is a team a test account created: createTeam writes
//   `test: true` on its META item, and nothing else ever sets or clears it.
//
// What the mark does, and only this: the handlers leave test accounts and
// teams out of the customer-activity business metrics (TEST_SKIPPED_METRICS
// in observability/names.ts), logging the line with `test: true` instead,
// and the operator page and `npm run ops` show a Test badge. It never grants
// anything: no access, trial, limit, check or billing depends on it.
//
// The domain is configuration (TEST_MAIL_DOMAIN, set by the CDK app from
// hostNames().testMail); with none set, no account is a test account.

/** The environment variable that names the test mail domain. */
export const TEST_MAIL_DOMAIN_ENV = "TEST_MAIL_DOMAIN";

// A lowercase DNS name of at least two labels, ASCII only (an international
// domain in its xn-- form), at most 253 characters
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The test mail domain from its configured value: undefined when unset or
 * empty (no account is then a test account); an Error for anything else that
 * isn't a lowercase ASCII domain name, so a typo fails the function's start
 * rather than marking the wrong accounts.
 */
export function testMailDomain(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!DOMAIN.test(value)) throw new Error(`${TEST_MAIL_DOMAIN_ENV} must be a lowercase domain name`);
  return value;
}

// Printable ASCII but space: anything else (Unicode lookalikes, fullwidth
// dots, zero-width characters, control characters) means not a test address,
// without any folding that could make two different addresses equal
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/**
 * Whether `address` is at exactly `domain`: printable ASCII only, one `@`, a
 * non-empty local part, and the whole domain part equal to `domain` but for
 * ASCII letter case (mail to `E2E.Example.com` reaches `e2e.example.com`).
 * No Unicode normalization, trimming or trailing-dot folding.
 */
export function isAtDomain(address: unknown, domain: string | undefined): boolean {
  if (!domain || typeof address !== "string" || !PRINTABLE_ASCII.test(address)) return false;
  const at = address.indexOf("@");
  if (at < 1 || at !== address.lastIndexOf("@")) return false;
  return address.slice(at + 1).replace(/[A-Z]/g, (c) => c.toLowerCase()) === domain;
}

/**
 * Whether a user is a test account: Cognito says their email is verified
 * (`emailVerified` exactly true, as CognitoUser and cognitoAccounts report
 * it) and it's at the test mail domain (isAtDomain). Pass only what Cognito
 * returned for the caller, never anything from the request.
 */
export function isTestAccount(user: { readonly email?: string; readonly emailVerified: boolean } | undefined, domain: string | undefined): boolean {
  return user?.emailVerified === true && isAtDomain(user.email, domain);
}
