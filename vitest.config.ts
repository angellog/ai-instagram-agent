import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration and e2e suites share one Postgres database and one Redis db,
    // so files run one at a time.
    fileParallelism: false,
    setupFiles: ["tests/helpers/setup.ts"],
  },
});
