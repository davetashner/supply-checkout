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
// Operator code may never ask DynamoDB for an item's old or whole values
// (supply-checkout-6uw.5): ReturnValuesOnConditionCheckFailure isn't covered
// by any IAM condition, so ALL_OLD on a failed comp update would hand back
// the whole META item, and ALL_OLD on an audit PutItem would return an item it
// replaced. The property is banned outright, and so are the ALL_OLD and
// ALL_NEW values anywhere in that code.
export const RETURN_VALUES_MESSAGE =
  "Operator code never asks for old or whole items (supply-checkout-6uw.5): no ReturnValuesOnConditionCheckFailure, ALL_OLD or ALL_NEW. The operator-access role must not read beyond what it writes.";
const operatorReturnValues = [
  { selector: "Property[key.name='ReturnValuesOnConditionCheckFailure']", message: RETURN_VALUES_MESSAGE },
  { selector: "Property[key.value='ReturnValuesOnConditionCheckFailure']", message: RETURN_VALUES_MESSAGE },
  { selector: "MemberExpression[property.name='ReturnValuesOnConditionCheckFailure']", message: RETURN_VALUES_MESSAGE },
  { selector: "Literal[value='ReturnValuesOnConditionCheckFailure']", message: RETURN_VALUES_MESSAGE },
  { selector: "Literal[value=/^ALL_(OLD|NEW)$/]", message: RETURN_VALUES_MESSAGE },
  { selector: "TemplateElement[value.raw=/ALL_(OLD|NEW)|ReturnValuesOnConditionCheckFailure/]", message: RETURN_VALUES_MESSAGE },
];
const restrictedPatterns = [
  { regex: DYNAMODB, message: DYNAMODB_MESSAGE },
  { regex: DATA_INTERNALS, message: DATA_INTERNALS_MESSAGE },
];

const restrictedSyntax = [
  [DYNAMODB, DYNAMODB_MESSAGE],
  [DATA_INTERNALS, DATA_INTERNALS_MESSAGE],
].flatMap(([pattern, message]) => [
  { selector: `ImportExpression[source.value=${esquery(pattern)}]`, message },
  { selector: `CallExpression[callee.name='require'][arguments.0.value=${esquery(pattern)}]`, message },
]);

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
      "no-restricted-syntax": ["error", ...restrictedSyntax],
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
      "no-restricted-syntax": ["error", ...restrictedSyntax, ...operatorReturnValues],
    },
  },
  {
    files: ["src/data/**", "test/**"],
    rules: { "no-restricted-imports": "off", "no-restricted-syntax": "off" },
  },
  {
    // The owner's one-off migrations (docs/infrastructure.md, "Backfills") and
    // restore steps (docs/backups.md) and the artifact import (docs/backend.md)
    // run src/data/backfill.ts, src/data/restore.ts and
    // src/data/artifact-import.ts, which index.ts doesn't export so no Lambda
    // can. Direct DynamoDB use stays banned here.
    files: ["scripts/backfill.ts", "scripts/restore.ts", "scripts/import-artifact.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ regex: DYNAMODB, message: DYNAMODB_MESSAGE }, { regex: String.raw`(^|/)data/(?!(index|backfill|restore|artifact-import)(\.js|\.ts)?$)`, message: DATA_INTERNALS_MESSAGE }] }],
    },
  },
  {
    // The owner's report triage (docs/infrastructure.md, "Triaging reports")
    // runs src/data/feedback-owner.ts, which index.ts doesn't export: among
    // the Lambda sources only data/operator.ts imports it, for the ops routes.
    files: ["scripts/feedback.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ regex: DYNAMODB, message: DYNAMODB_MESSAGE }, { regex: String.raw`(^|/)data/(?!(index|feedback-owner)(\.js|\.ts)?$)`, message: DATA_INTERNALS_MESSAGE }] }],
    },
  },
  {
    // feedback-owner.ts too: the ops routes run it on the operator-access role (supply-checkout-3sv.26)
    files: ["src/data/operator.ts", "src/data/feedback-owner.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ regex: String.raw`(^|/)team-context(\.js|\.ts)?$`, message: OPERATOR_MESSAGE }] }],
      "no-restricted-syntax": [
        "error",
        { selector: `ImportExpression[source.value=/team-context/]`, message: OPERATOR_MESSAGE },
        { selector: `CallExpression[callee.name='require'][arguments.0.value=/team-context/]`, message: OPERATOR_MESSAGE },
        ...operatorReturnValues,
      ],
    },
  },
);
