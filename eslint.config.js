import js from "@eslint/js";
import html from "eslint-plugin-html";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "playwright-report/", "test-results/", "coverage/"] },
  js.configs.recommended,
  {
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["**/*.html"],
    plugins: { html },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser, ZXing: "readonly", BarcodeDetector: "readonly" },
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    // The mock and page.evaluate callbacks run inside the browser
    files: ["tests/**/*.js"],
    languageOptions: { globals: { ...globals.browser } },
  },
];
