import { describe, expect, it } from "vitest";

import { readConfig } from "./config.js";

describe("server configuration", () => {
  it("binds to the local machine by default", () => {
    expect(readConfig({})).toEqual({ host: "127.0.0.1", port: 3001 });
  });

  it.each(["1", "3001", "65535"])("accepts port %s", (port) => {
    expect(readConfig({ PORT: port }).port).toBe(Number(port));
  });

  it.each(["", "0", "65536", "-1", "1.5", "1e3", "123abc", " 3001", "3001 ", "NaN", "Infinity"])(
    "rejects invalid port %j",
    (port) => {
      expect(() => readConfig({ PORT: port })).toThrow(
        "PORT must be an integer between 1 and 65535.",
      );
    },
  );

  it.each(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"])(
    "accepts explicit binding %s",
    (host) => {
      expect(readConfig({ HOST: host }).host).toBe(host);
    },
  );

  it.each(["", "https://example.com", "example.com", "127.0.0.999", " localhost"])(
    "rejects invalid binding %j",
    (host) => {
      expect(() => readConfig({ HOST: host })).toThrow(
        "HOST must be localhost or a valid IP address.",
      );
    },
  );
});
