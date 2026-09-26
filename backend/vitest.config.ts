import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each file gets its own table in DynamoDB Local; files can run in parallel.
    testTimeout: 30_000,
  },
});
