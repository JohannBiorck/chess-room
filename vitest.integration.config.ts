import { defineConfig } from "vitest/config";

if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL or DATABASE_URL is required for PostgreSQL integration tests.",
  );
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/server/src/**/*.integration.test.ts"],
    restoreMocks: true,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    fileParallelism: false,
  },
});
