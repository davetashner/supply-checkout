import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Only the data-access module (src/data) may use DynamoDB, so every read and
// write goes through a TeamContext (ADR 0005). Outside src/data:
//
// - No @aws-sdk package with "dynamodb" in its name, or any path inside one
//   (client-dynamodb, lib-dynamodb, util-dynamodb, client-dynamodb-streams,
//   and deep paths such as lib-dynamodb/dist-cjs/index.js).
// - Nothing from src/data except its entry point, data/index.js. The internals
//   (the context issuer's file, the raw client) stay private to the module.
//
// Tests may do both, to inspect stored items and build fake connections.
const DYNAMODB = String.raw`^@aws-sdk/[^/]*dynamodb[^/]*(/.*)?$`;
const DATA_INTERNALS = String.raw`(^|/)data/(?!index(\.js|\.ts)?$)`;
export const DYNAMODB_MESSAGE =
  "Use the data-access module (src/data/index.js) instead: it scopes every read and write to a TeamContext (ADR 0005).";
export const DATA_INTERNALS_MESSAGE =
  "Import the data-access module only through src/data/index.js; its other files are private (ADR 0005).";

// esquery regex literals end at the first "/", so write slashes as \x2F
const esquery = (pattern) => `/${pattern.replaceAll("/", "\\x2F")}/`;

// The ops code (ADR 0015) never gets a TeamContext: operators aren't members
// of any team. Outside src/data it may not import the functions that issue
// one, and inside, the operator module may not import team-context.ts.
export const TEAM_CONTEXT_ISSUERS = ["authorizeTeam", "createTeam", "acceptInvite", "teamContextForStripeCustomer", "teamContextForEmailEvent", "TeamContext"];
export const OPERATOR_MESSAGE = "Operator code never gets a TeamContext (ADR 0015): operators reach teams only through data/operator.ts and the operator-access role.";
const restrictedPatterns = [
  { regex: DYNAMODB, message: DYNAMODB_MESSAGE },
  { regex: DATA_INTERNALS, message: DATA_INTERNALS_MESSAGE },
];

export default tseslint.config(
  { ignores: ["node_modules/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: restrictedPatterns,
        },
      ],
      "no-restricted-syntax": [
        "error",
        ...[
          [DYNAMODB, DYNAMODB_MESSAGE],
          [DATA_INTERNALS, DATA_INTERNALS_MESSAGE],
        ].flatMap(([pattern, message]) => [
          { selector: `ImportExpression[source.value=${esquery(pattern)}]`, message },
          { selector: `CallExpression[callee.name='require'][arguments.0.value=${esquery(pattern)}]`, message },
        ]),
      ],
    },
  },
  {
    files: ["src/operator/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [...restrictedPatterns, { regex: String.raw`(^|/)data/index(\.js|\.ts)?$`, importNames: TEAM_CONTEXT_ISSUERS, message: OPERATOR_MESSAGE }],
        },
      ],
    },
  },
  {
    files: ["src/data/**", "test/**"],
    rules: { "no-restricted-imports": "off", "no-restricted-syntax": "off" },
  },
  {
    // The owner's one-off migrations (docs/infrastructure.md, "Backfills") and
    // restore steps (docs/backups.md) run src/data/backfill.ts and
    // src/data/restore.ts, which index.ts doesn't export so no Lambda can.
    // Direct DynamoDB use stays banned here.
    files: ["scripts/backfill.ts", "scripts/restore.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ regex: DYNAMODB, message: DYNAMODB_MESSAGE }, { regex: String.raw`(^|/)data/(?!(index|backfill|restore)(\.js|\.ts)?$)`, message: DATA_INTERNALS_MESSAGE }] }],
    },
  },
  {
    files: ["src/data/operator.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ regex: String.raw`(^|/)team-context(\.js|\.ts)?$`, message: OPERATOR_MESSAGE }] }],
      "no-restricted-syntax": [
        "error",
        { selector: `ImportExpression[source.value=/team-context/]`, message: OPERATOR_MESSAGE },
        { selector: `CallExpression[callee.name='require'][arguments.0.value=/team-context/]`, message: OPERATOR_MESSAGE },
      ],
    },
  },
);
