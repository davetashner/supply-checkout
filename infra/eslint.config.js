import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "cdk.out/"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      // CDK constructs are created for their side effects
      "no-new": "off",
    },
  },
);
