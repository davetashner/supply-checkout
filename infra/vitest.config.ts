import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Synthesizing the whole app takes a few seconds
    testTimeout: 60_000,
  },
});
