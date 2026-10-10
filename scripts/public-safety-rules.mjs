// The patterns scripts/check-public-safety.mjs refuses in a public repo, shared
// with the feedback CLI (backend/scripts/feedback.ts), which refuses a bead's
// title and summary that match any of them before it creates the bead.

export const RULES = [
  // A bare 12-digit number is often a barcode, so account IDs need context
  { name: "AWS account ID", re: /(?:arn:aws[\w-]*:[\w-]*:[\w-]*:|account[_ -]?id["'\s:=]{0,5}|\baccount\s+)(\d{12})\b/i },
  { name: "AWS account ID in a profile name", re: /\b\d{12}_[A-Za-z]/ },
  { name: "IAM Identity Center instance", re: /\bssoins-[0-9a-f]{16}\b/ },
  { name: "Identity Store ID", re: /\bd-[0-9a-f]{10}\b/ },
  { name: "SSO start URL", re: /[\w-]+\.awsapps\.com\/start|identitycenter\.amazonaws\.com\/ssoins/ },
  { name: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Stripe secret key", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{10,}/ },
  { name: "Stripe webhook secret", re: /\bwhsec_[0-9A-Za-z]{10,}/ },
  {
    name: "email address",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    // The product's own no-reply sender (Cognito and SES mail) and its support
    // address (supply-checkout-6qd) are public by design
    allow: (m) => /^noreply@(?:[a-z0-9-]+\.)*supplycheckout\.com$|^support@(?:[a-z0-9-]+\.)*supplycheckout\.com$|^noreply@anthropic\.com$|@users\.noreply\.github\.com$|@example\.(?:com|org|net|test)$|^git@github\.com$/i.test(m),
  },
];

/** The rules `text` breaks, as `{ name }` (never the matched text: it may be what must not be printed). */
export function publicSafetyFindings(text) {
  const found = [];
  for (const rule of RULES) {
    const matches = rule.re.global ? [...text.matchAll(rule.re)].map((m) => m[0]) : [text.match(rule.re)?.[0]].filter(Boolean);
    if (matches.some((m) => !(rule.allow && rule.allow(m)))) found.push({ name: rule.name });
  }
  return found;
}
