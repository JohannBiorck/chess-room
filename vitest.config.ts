import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/server/src/**/*.test.ts"],
    restoreMocks: true,
  },
});
