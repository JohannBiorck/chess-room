import { describe, expect, it } from "vitest";
import {
  catchessConfigSchema,
  catEffectSchema,
  createGameSchema,
  gameCommandSchema,
  guestSessionSchema,
  joinInvitationSchema,
  moveInputSchema,
  publicClocksSchema,
  publicGameSchema,
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

describe("Catchess protocol boundaries", () => {
  it("uses independent signed chances and defaults only Catchess to 25 per player", () => {
    expect(createGameSchema.parse({ rulesetId: "catchess" }).catchess).toEqual({
      host: 25,
      guest: 25,
    });
    expect(
      createGameSchema.parse({ rulesetId: "catchess", catchess: { host: -100, guest: 100 } })
        .catchess,
    ).toEqual({ host: -100, guest: 100 });
    expect(catchessConfigSchema.parse({ white: 0, black: -25 })).toEqual({ white: 0, black: -25 });
    for (const chance of [-101, 101, 1.5, "25", null, Number.NaN]) {
      expect(
        createGameSchema.safeParse({ rulesetId: "catchess", catchess: { host: chance, guest: 25 } })
          .success,
      ).toBe(false);
    }
    expect(
      createGameSchema.safeParse({ rulesetId: "catchess", catchess: { host: 0 } }).success,
    ).toBe(false);
    expect(
      catchessConfigSchema.safeParse({ white: 0, black: 0, draw: "client entropy" }).success,
    ).toBe(false);
  });

  it("rejects cat settings in other modes and client-supplied draws/effects", () => {
    for (const rulesetId of ["standard", "three-check"]) {
      expect(
        createGameSchema.safeParse({ rulesetId, catchess: { host: 0, guest: 0 } }).success,
      ).toBe(false);
    }
    for (const field of ["draw", "effect", "catchess"]) {
      expect(
        gameCommandSchema.safeParse({
          ...command,
          action: { ...command.action, [field]: "forged" },
        }).success,
      ).toBe(false);
    }
  });

  it("requires a target for applied effects and none for skipped effects", () => {
    const effect = { ply: 1, color: "white", action: "add", square: "a1" };
    expect(catEffectSchema.parse(effect)).toEqual(effect);
    expect(catEffectSchema.safeParse({ ply: 1, color: "black", action: "none" }).success).toBe(
      true,
    );
    for (const invalid of [
      { ...effect, square: undefined },
      { ...effect, action: "none" },
      { ...effect, ply: 0 },
      { ...effect, ply: 1201 },
      { ...effect, square: "a9" },
      { ...effect, draw: "private random input" },
    ]) {
      expect(catEffectSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("preserves legacy projections without cat fields for existing command receipts", () => {
    const legacy = {
      id: "0fe54f10-65af-4c2f-b70d-925d0d1b73ab",
      revision: 1,
      phase: "active",
      rulesetId: "standard",
      rulesVersion: 1,
      timeControl: "untimed",
      players: { white: { displayName: "Ada" }, black: { displayName: "Ben" } },
      position: {
        fen: "7k/8/8/8/8/8/R7/7K w - - 0 1",
        turn: "white",
        inCheck: false,
        board: [{ square: "h1", type: "k", color: "white" }],
        legalMoves: [],
        moves: [],
        checks: { white: 0, black: 0 },
        claimableDraws: [],
        outcome: null,
      },
      clocks: null,
      outcome: null,
      drawOffer: null,
      rematchRequested: [],
      rematchGameId: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const game = publicGameSchema.parse(legacy);
    expect(game).toEqual(legacy);
    expect(game).not.toHaveProperty("catchess");
    expect(game.position).not.toHaveProperty("catEffects");
    expect(publicGameSchema.safeParse({ ...legacy, catchess: null }).success).toBe(false);
    expect(
      publicGameSchema.safeParse({ ...legacy, position: { ...legacy.position, catEffects: [] } })
        .success,
    ).toBe(false);
    expect(publicGameSchema.safeParse({ ...legacy, rulesetId: "catchess" }).success).toBe(false);
    expect(
      publicGameSchema.safeParse({
        ...legacy,
        rulesetId: "catchess",
        catchess: { white: 0, black: 0 },
        position: { ...legacy.position, catEffects: [] },
      }).success,
    ).toBe(true);
  });
});
