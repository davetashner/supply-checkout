// Fails if the repository contains things a public repo must not: AWS account
// and SSO identifiers, personal email addresses, or credentials.
//
//   node scripts/check-public-safety.mjs           every tracked file
//   node scripts/check-public-safety.mjs --staged  only what's staged (pre-commit hook)
//
// A line containing "public-safety: allow" is skipped. Use it only for
// deliberate examples, never for real values.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RULES = [
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

const staged = process.argv.includes("--staged");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
process.chdir(git("rev-parse", "--show-toplevel").trim());
const files = (staged
  ? git("diff", "--cached", "--name-only", "--diff-filter=ACMR")
  : git("ls-files")
).split("\n").filter(Boolean);

const findings = [];
for (const file of files) {
  let text;
  try { text = staged ? git("show", `:${file}`) : readFileSync(file, "utf8"); }
  catch { continue; }
  if (text.includes("\0")) continue; // binary
  text.split("\n").forEach((line, i) => {
    if (line.includes("public-safety: allow")) return;
    for (const rule of RULES) {
      const matches = rule.re.global ? [...line.matchAll(rule.re)].map((m) => m[0]) : [line.match(rule.re)?.[0]].filter(Boolean);
      for (const m of matches) {
        if (rule.allow && rule.allow(m)) continue;
        findings.push(`${file}:${i + 1}  ${rule.name}: ${m.slice(0, 4)}…`);
      }
    }
  });
}

if (findings.length) {
  console.error(`This repository is public. Remove these before committing:\n\n${findings.join("\n")}\n`);
  process.exit(1);
}
console.log(`public-safety: ${files.length} file${files.length === 1 ? "" : "s"} clean`);
