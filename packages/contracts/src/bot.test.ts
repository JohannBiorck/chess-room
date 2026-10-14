import { describe, expect, it } from "vitest";
import {
  BOT_ALGORITHM,
  botCommandSchema,
  botMetadataSchema,
  botSearchPositionSchema,
  createBotGameSchema,
} from "./bot.js";

describe("bot boundary contracts", () => {
  it("defaults to a private untimed-compatible Cat configuration", () => {
    expect(createBotGameSchema.parse({})).toEqual({
      rulesetId: "catchess",
      color: "random",
      profile: "strong",
      catchess: { host: 25, guest: 25 },
    });
    expect(createBotGameSchema.safeParse({ timeControl: "5+0" }).success).toBe(false);
    expect(createBotGameSchema.safeParse({ visibility: "open" }).success).toBe(false);
  });
  it("rejects probability configuration on another mode", () => {
    expect(
      createBotGameSchema.safeParse({ rulesetId: "chaos-cat", catchess: { host: 25, guest: 25 } })
        .success,
    ).toBe(false);
  });
  it("does not accept client-selected entropy or rules", () => {
    const command = {
      protocolVersion: 1,
      commandId: "cd4c98c0-1b3a-45f7-a445-9b918479df1f",
      expectedRevision: 1,
      move: { from: "e2", to: "e4" },
    };
    expect(botCommandSchema.safeParse(command).success).toBe(true);
    expect(botCommandSchema.safeParse({ ...command, draw: "00".repeat(32) }).success).toBe(false);
    expect(botCommandSchema.safeParse({ ...command, move: { from: "e2", to: "e2" } }).success).toBe(
      false,
    );
    expect(
      botMetadataSchema.safeParse({
        color: "black",
        profile: "strong",
        algorithm: BOT_ALGORITHM,
        requestId: null,
      }).success,
    ).toBe(true);
  });
  it("bounds and deduplicates position history and omits random inputs", () => {
    const position = {
      fen: "8/8/8/8/8/8/8/8 w - - 0 1",
      rulesetId: "standard",
      rulesVersion: 1,
      plies: 0,
      checks: { white: 0, black: 0 },
      repetitions: [["one", 1]],
    };
    expect(botSearchPositionSchema.safeParse(position).success).toBe(true);
    expect(
      botSearchPositionSchema.safeParse({
        ...position,
        repetitions: [
          ["one", 1],
          ["one", 2],
        ],
      }).success,
    ).toBe(false);
    expect(botSearchPositionSchema.safeParse({ ...position, draw: "00".repeat(32) }).success).toBe(
      false,
    );
  });
});
