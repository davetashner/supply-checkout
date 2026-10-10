import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each file gets its own table in DynamoDB Local; files can run in parallel.
    testTimeout: 30_000,
    // npm run test:coverage (and CI) measures the Lambda code in src/, and
    // scripts/vitest-coverage.mjs fails the run below coverage-thresholds.json.
    // Test helpers, fixtures and the one-off scripts/ aren't in the denominator.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "json-summary", "json", "html"],
      reportsDirectory: "coverage",
    },
  },
});
