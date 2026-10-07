import { describe, expect, it } from "vitest";

import { readRuntimeRole } from "./database-grants.js";

describe("runtime credential role boundary", () => {
  it.each(["runtime_role", "A", "r".repeat(63), "runtime$role"])(
    "reads the exact supported runtime role %s",
    (role) => {
      expect(
        readRuntimeRole(`postgresql://${encodeURIComponent(role)}:placeholder@localhost/db`),
      ).toBe(role);
    },
  );

  it.each([
    "postgresql://localhost/db",
    "https://runtime:private-placeholder@localhost/db",
    `postgresql://${"r".repeat(64)}:private-placeholder@localhost/db`,
    "postgresql://%22role%22%3BGRANT%20ALL:private-placeholder@localhost/db",
    "postgresql://%FF:private-placeholder@localhost/db",
    "malformed-private-placeholder",
  ])("rejects malformed credentials without disclosing their supplied contents", (url) => {
    try {
      readRuntimeRole(url);
      throw new Error("Invalid role was accepted.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "DATABASE_URL must include a valid PostgreSQL runtime role.",
      );
      expect((error as Error).message).not.toContain("private-placeholder");
    }
  });
});
