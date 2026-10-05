import { describe, expect, it } from "vitest";
import {
  createGameSchema,
  gameCommandSchema,
  guestSessionSchema,
  joinInvitationSchema,
  moveInputSchema,
  publicClocksSchema,
} from "./index.js";

const command = {
  protocolVersion: 1,
  commandId: "0fe54f10-65af-4c2f-b70d-925d0d1b73ab",
  expectedRevision: 4,
  action: { type: "move", from: "e2", to: "e4" },
};

describe("guest and room boundaries", () => {
  it("normalizes a display name and applies the smallest match defaults", () => {
    expect(guestSessionSchema.parse({ displayName: "  Ada  " })).toEqual({ displayName: "Ada" });
    expect(createGameSchema.parse({})).toEqual({
      rulesetId: "standard",
      color: "random",
      timeControl: "untimed",
    });
  });

  it.each(["", "   ", "a".repeat(33), "Ada\u0000", "Ada\u202e"])(
    "rejects empty, long or hidden-control names: %j",
    (displayName) => {
      expect(guestSessionSchema.safeParse({ displayName }).success).toBe(false);
    },
  );

  it("rejects configuration not supported by reviewed rules adapters", () => {
    expect(createGameSchema.safeParse({ rulesetId: "custom-script" }).success).toBe(false);
    expect(createGameSchema.safeParse({ timeControl: "1+0" }).success).toBe(false);
    expect(createGameSchema.safeParse({ rulesVersion: 7 }).success).toBe(false);
    expect(guestSessionSchema.safeParse({ displayName: "Ada", admin: true }).success).toBe(false);
  });

  it("bounds invitations and rejects extra identity fields", () => {
    expect(joinInvitationSchema.parse({ token: "a".repeat(43) })).toEqual({
      token: "a".repeat(43),
    });
    expect(joinInvitationSchema.safeParse({ token: "a".repeat(44) }).success).toBe(false);
    expect(joinInvitationSchema.safeParse({ token: "/".repeat(43) }).success).toBe(false);
    expect(joinInvitationSchema.safeParse({ token: "a".repeat(43), seat: "white" }).success).toBe(
      false,
    );
  });
});

describe("command boundaries", () => {
  it("accepts only versioned, bounded, identified commands", () => {
    expect(gameCommandSchema.parse(command)).toEqual(command);
    for (const mutation of [
      { protocolVersion: 2 },
      { commandId: "123" },
      { expectedRevision: -1 },
      { expectedRevision: 0.5 },
      { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { actorId: "someone-else" },
    ]) {
      expect(gameCommandSchema.safeParse({ ...command, ...mutation }).success).toBe(false);
    }
  });

  it("rejects forged authoritative fields even inside an otherwise legal action", () => {
    expect(
      gameCommandSchema.safeParse({
        ...command,
        action: { ...command.action, fen: "client-chosen-position" },
      }).success,
    ).toBe(false);
  });

  it("validates board coordinates and all underpromotion choices", () => {
    for (const promotion of ["q", "r", "b", "n"]) {
      expect(moveInputSchema.safeParse({ from: "a7", to: "a8", promotion }).success).toBe(true);
    }
    for (const invalid of [
      { from: "a0", to: "a8" },
      { from: "a1", to: "i8" },
      { from: "e2", to: "e2" },
      { from: "a7", to: "a8", promotion: "k" },
    ]) {
      expect(moveInputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("keeps timestamps as finite epoch milliseconds and clocks nonnegative", () => {
    const clocks = {
      whiteMs: 1000,
      blackMs: 900,
      runningColor: "white",
      turnStartedAt: 1720000000000,
      serverNow: 1720000000100,
    };
    expect(publicClocksSchema.safeParse(clocks).success).toBe(true);
    expect(publicClocksSchema.safeParse({ ...clocks, whiteMs: -1 }).success).toBe(false);
    expect(publicClocksSchema.safeParse({ ...clocks, serverNow: "2026-10-05" }).success).toBe(
      false,
    );
  });
});
