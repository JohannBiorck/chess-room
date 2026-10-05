import { describe, expect, it } from "vitest";
import { readApplicationConfig } from "./config.js";

const databaseUrl = "postgresql://local_user:local_password@127.0.0.1/test_database";

describe("application configuration", () => {
  it("requires PostgreSQL without disclosing the supplied value", () => {
    expect(() => readApplicationConfig({})).toThrow("DATABASE_URL is required.");
    expect(() =>
      readApplicationConfig({ DATABASE_URL: "https://sensitive-value.example" }),
    ).toThrow("DATABASE_URL must be a PostgreSQL URL.");
  });
  it("defaults to localhost with no trusted proxy", () => {
    expect(readApplicationConfig({ DATABASE_URL: databaseUrl })).toEqual({
      databaseUrl,
      webOrigin: "http://127.0.0.1:5173",
      secureCookies: false,
      serveWeb: false,
    });
  });
  it.each([
    "*",
    "https://example.test/path",
    "https://user:password@example.test",
    "https://example.test/?token=value",
    "https://example.test/#invite",
  ])("rejects unsafe origin %s", (origin) => {
    expect(() =>
      readApplicationConfig({ DATABASE_URL: databaseUrl, WEB_ORIGIN: origin }),
    ).toThrow();
  });
  it("requires HTTPS in production and enables protected cookies", () => {
    expect(() =>
      readApplicationConfig({ DATABASE_URL: databaseUrl, NODE_ENV: "production" }),
    ).toThrow("Production WEB_ORIGIN must use HTTPS.");
    expect(
      readApplicationConfig({
        DATABASE_URL: databaseUrl,
        NODE_ENV: "production",
        WEB_ORIGIN: "https://example.test",
        SERVE_WEB: "true",
      }),
    ).toMatchObject({ webOrigin: "https://example.test", secureCookies: true, serveWeb: true });
  });
  it("allows only explicit trusted proxy addresses", () => {
    expect(
      readApplicationConfig({ DATABASE_URL: databaseUrl, TRUST_PROXY: "127.0.0.1,::1,10.0.0.0/24" })
        .trustProxy,
    ).toEqual(["127.0.0.1", "::1", "10.0.0.0/24"]);
    for (const proxy of [
      "true",
      "*",
      "loopback",
      "10.0.0.0/33",
      "::1/129",
      "1.2.3.4/-1",
      "1.2.3.4/32/0",
    ]) {
      expect(() =>
        readApplicationConfig({ DATABASE_URL: databaseUrl, TRUST_PROXY: proxy }),
      ).toThrow();
    }
  });
});
