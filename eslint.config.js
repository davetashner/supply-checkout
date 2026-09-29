import js from "@eslint/js";
import html from "eslint-plugin-html";
import globals from "globals";

export default [
  // infra/ and backend/ are their own packages with their own ESLint configs
  { ignores: ["node_modules/", "playwright-report/", "test-results/", "coverage/", "dist/", "infra/", "backend/"] },
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
      globals: { ...globals.browser, BarcodeDetector: "readonly" },
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
    // The app runs in the browser
    files: ["src/**/*.js"],
    languageOptions: { globals: { ...globals.browser, BarcodeDetector: "readonly" } },
  },
  {
    // The demo build's entry runs in the browser (demo/data.js also runs in the dev server)
    files: ["demo/**/*.js"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // The mock and page.evaluate callbacks run inside the browser
    files: ["tests/**/*.js", "scripts/journey-videos/**/*.mjs"],
    languageOptions: { globals: { ...globals.browser } },
  },
];
