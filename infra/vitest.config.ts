import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Synthesizing the whole app takes a few seconds
    testTimeout: 60_000,
    // npm run test:coverage (and CI) measures the CDK code in lib/ and bin/,
    // and scripts/vitest-coverage.mjs fails the run below coverage-thresholds.json.
    // Test helpers and snapshots aren't in the denominator.
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts", "bin/**/*.ts"],
      reporter: ["text-summary", "json-summary", "json", "html"],
      reportsDirectory: "coverage",
    },
  },
});
