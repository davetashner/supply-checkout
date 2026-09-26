// Fails if an AWS region name (us-east-1, us-west-2, eu-west-1, ...) appears
// in infra, backend or app code outside the one config module (ADR 0010,
// "region-ready" rule 4). Lambdas read their region from AWS_REGION, stacks
// from their environment, and the list of regions lives in infra/lib/config.ts.
//
//   node scripts/check-region-strings.mjs            every tracked file in scope
//   node scripts/check-region-strings.mjs --staged   only what's staged (pre-commit hook)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Directories whose code must not name a region: infra, the Lambda backend, the web app. */
const SCOPE = /^(infra|backend|src)\//;

/** The one config module, and generated output (CDK snapshots, lockfiles). */
const EXEMPT = [
  /^infra\/lib\/config\.ts$/,
  /\/__snapshots__\//,
  /(^|\/)package-lock\.json$/,
];

// Every commercial and GovCloud region follows <area>-[gov-]<direction>-<n>
const REGION =
  /\b(?:us|eu|ap|ca|sa|me|af|il|mx|cn)-(?:gov-|iso-|isob-)?(?:north|south|east|west|central|northeast|southeast|northwest|southwest)-\d+\b/g;

const MESSAGE =
  "Region names belong only in infra/lib/config.ts (ADR 0010). Read AWS_REGION in Lambda code, " +
  "the stack's region in infra, and import APPROVED_REGIONS or DEFAULT_REGIONS in tests.";

function findRegionStrings(file, text) {
  if (!SCOPE.test(file) || EXEMPT.some((re) => re.test(file))) return [];
  const findings = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(REGION)) findings.push(`${file}:${i + 1}  ${m[0]}`);
  });
  return findings;
}

const staged = process.argv.includes("--staged");
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
process.chdir(git("rev-parse", "--show-toplevel").trim());
const files = (staged
  ? git("diff", "--cached", "--name-only", "--diff-filter=ACMR")
  : git("ls-files")
).split("\n").filter(Boolean);

const findings = [];
for (const file of files) {
  if (!SCOPE.test(file)) continue;
  let text;
  try { text = staged ? git("show", `:${file}`) : readFileSync(file, "utf8"); }
  catch { continue; }
  if (text.includes("\0")) continue; // binary
  findings.push(...findRegionStrings(file, text));
}

if (findings.length) {
  console.error(`${MESSAGE}\n\n${findings.join("\n")}\n`);
  process.exit(1);
}
console.log("region-strings: none outside infra/lib/config.ts");
