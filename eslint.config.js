import js from "@eslint/js";
import html from "eslint-plugin-html";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "playwright-report/", "test-results/", "coverage/", "dist/"] },
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
    // The app runs in the browser, with ZXing loaded from a CDN script tag
    files: ["src/**/*.js"],
    languageOptions: { globals: { ...globals.browser, ZXing: "readonly", BarcodeDetector: "readonly" } },
  },
  {
    // The mock and page.evaluate callbacks run inside the browser
    files: ["tests/**/*.js"],
    languageOptions: { globals: { ...globals.browser } },
  },
];
