import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Only the data-access module (src/data) may use the DynamoDB client, so every
// read and write goes through a TeamContext (ADR 0005). Tests may, to check
// what was stored.
const DYNAMODB = ["@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb", "@aws-sdk/client-dynamodb-streams"];
export const DYNAMODB_MESSAGE =
  "Use the data-access module (src/data) instead: it scopes every read and write to a TeamContext (ADR 0005).";

export default tseslint.config(
  { ignores: ["node_modules/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "no-restricted-imports": ["error", { paths: DYNAMODB.map((name) => ({ name, message: DYNAMODB_MESSAGE })) }],
      "no-restricted-syntax": [
        "error",
        ...DYNAMODB.flatMap((name) => [
          { selector: `ImportExpression[source.value='${name}']`, message: DYNAMODB_MESSAGE },
          { selector: `CallExpression[callee.name='require'][arguments.0.value='${name}']`, message: DYNAMODB_MESSAGE },
        ]),
      ],
    },
  },
  {
    files: ["src/data/**", "test/**"],
    rules: { "no-restricted-imports": "off", "no-restricted-syntax": "off" },
  },
);
