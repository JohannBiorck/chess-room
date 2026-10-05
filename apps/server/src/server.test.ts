import { describe, expect, it } from "vitest";

import { buildServer } from "./server.js";

describe("HTTP foundation", () => {
  it("reports process liveness as JSON", async () => {
    const server = buildServer({ logger: false });
    try {
      const response = await server.inject({ method: "GET", url: "/api/health" });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.json()).toEqual({ status: "ok" });
    } finally {
      await server.close();
    }
  });

  it("returns 404 for a route that has not been implemented", async () => {
    const server = buildServer({ logger: false });
    try {
      const response = await server.inject({ method: "GET", url: "/api/games" });

      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("keeps request URLs and credentials out of success, 404, and error logs", async () => {
    const logs: string[] = [];
    const server = buildServer({
      logStream: {
        write(message) {
          logs.push(message);
        },
      },
    });
    server.get("/api/test-error", async (request) => {
      throw new Error(`Failed request: ${request.url}`);
    });

    try {
      server.log.info("Logging check");
      for (const path of ["/api/health", "/api/unknown", "/api/test-error"]) {
        await server.inject({
          method: "GET",
          url: `${path}?token=sensitive-query-value`,
          headers: {
            authorization: "Bearer sensitive-header-value",
            cookie: "session=sensitive-cookie-value",
          },
        });
      }

      const output = logs.join("");
      expect(output).toContain("Logging check");
      expect(output).not.toContain("/api/");
      expect(output).not.toContain("sensitive-query-value");
      expect(output).not.toContain("sensitive-header-value");
      expect(output).not.toContain("sensitive-cookie-value");
    } finally {
      await server.close();
    }
  });
});
