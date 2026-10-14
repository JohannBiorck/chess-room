import {
  BOT_ALGORITHM,
  type BotCommand,
  type BotMetadata,
  type PublicGame,
} from "@chess-room/contracts";
import { createEngineState, inspectEngine } from "@chess-room/game-core";
import { describe, expect, it } from "vitest";
import {
  acceptedBotView,
  fallbackBotMove,
  isBotTurn,
  readPendingBotCommand,
  reusableBotCommand,
  savePendingBotCommand,
  validateBotPosition,
} from "./coordinator";

const gameId = "17936ec6-8299-494c-9e09-c3f9ac1b9c82";
const requestId = "cd4c98c0-1b3a-45f7-a445-9b918479df1f";
function fixture(): PublicGame & { bot: BotMetadata } {
  return {
    id: gameId,
    revision: 0,
    phase: "active",
    rulesetId: "standard",
    rulesVersion: 1,
    timeControl: "untimed",
    players: { white: { displayName: "Cat Bot" }, black: { displayName: "Human" } },
    position: inspectEngine(createEngineState()),
    clocks: null,
    outcome: null,
    drawOffer: null,
    rematchRequested: [],
    rematchGameId: null,
    createdAt: 0,
    updatedAt: 0,
    bot: { color: "white", profile: "strong", algorithm: BOT_ALGORITHM, requestId },
  };
}
const command: BotCommand = {
  protocolVersion: 1,
  commandId: requestId,
  expectedRevision: 0,
  move: { from: "e2", to: "e4" },
};
describe("bot proposal and recovery boundary", () => {
  it("resumes the exact pending command only at its owned revision and ticket", () => {
    const game = fixture();
    expect(reusableBotCommand({ gameId, command }, game)).toEqual(command);
    expect(reusableBotCommand({ gameId, command }, { ...game, revision: 1 })).toBeNull();
    expect(
      reusableBotCommand(
        { gameId, command },
        { ...game, bot: { ...game.bot, requestId: "8b5376cc-2b53-46d3-854d-992cd67527a9" } },
      ),
    ).toBeNull();
    expect(
      reusableBotCommand({ gameId, command: { ...command, move: { from: "a1", to: "a8" } } }, game),
    ).toBeNull();
  });
  it("treats human turns, friend games and finished games as non-computing", () => {
    const game = fixture();
    expect(isBotTurn(game)).toBe(true);
    expect(isBotTurn({ ...game, phase: "finished" })).toBe(false);
    expect(isBotTurn({ ...game, bot: { ...game.bot, color: "black" } })).toBe(false);
    const { bot: _, ...friend } = game;
    expect(isBotTurn(friend)).toBe(false);
  });
  it("persists and recovers exact move payloads without any credential", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    savePendingBotCommand({ gameId, command }, storage);
    expect(readPendingBotCommand(storage)).toEqual({ gameId, command });
    expect([...values.values()].join()).not.toContain("token");
    savePendingBotCommand(null, storage);
    expect(readPendingBotCommand(storage)).toBeNull();
    expect(readPendingBotCommand({ getItem: () => "broken JSON" })).toBeNull();
    expect(() =>
      savePendingBotCommand(
        { gameId, command },
        {
          setItem: () => {
            throw new Error("Storage disabled");
          },
          removeItem: () => {},
        },
      ),
    ).not.toThrow();
  });
  it("rejects an unrelated or stale search context before spending compute", () => {
    const game = fixture();
    const view = {
      gameId,
      revision: 0,
      requestId,
      profile: "strong" as const,
      algorithm: BOT_ALGORITHM,
      position: {
        fen: game.position.fen,
        rulesetId: "standard" as const,
        rulesVersion: 1 as const,
        plies: 0,
        checks: { white: 0, black: 0 },
        repetitions: [],
      },
    };
    expect(() => validateBotPosition(view, game)).not.toThrow();
    expect(() => validateBotPosition({ ...view, revision: 1 }, game)).toThrow("game changed");
    expect(() =>
      validateBotPosition(
        { ...view, position: { ...view.position, rulesetId: "chaos-cat" } },
        game,
      ),
    ).toThrow("game changed");
  });
  it("requires the acknowledged move in the exact game rather than just a larger revision", () => {
    const game = fixture();
    const moved = {
      ...game,
      revision: 1,
      position: {
        ...game.position,
        moves: [{ ply: 1, color: "white" as const, ...command.move, san: "e4" }],
      },
    };
    expect(acceptedBotView({ game: moved, seat: "black" }, game, command)).toBe(true);
    expect(
      acceptedBotView({ game: { ...moved, id: requestId }, seat: "black" }, game, command),
    ).toBe(false);
    expect(
      acceptedBotView(
        {
          game: {
            ...moved,
            position: {
              ...moved.position,
              moves: [{ ply: 1, color: "white", from: "d2", to: "d4", san: "d4" }],
            },
          },
          seat: "black",
        },
        game,
        command,
      ),
    ).toBe(false);
  });
  it("the emergency fallback captures a king instead of selecting a random move", () => {
    const game = fixture();
    const position = game.position;
    const exposed = {
      ...game,
      position: {
        ...position,
        board: [
          { square: "e1", color: "white" as const, type: "k" as const },
          { square: "e8", color: "black" as const, type: "r" as const },
        ],
        legalMoves: [
          { from: "e8", to: "d8" },
          { from: "e8", to: "e1" },
        ],
      },
    };
    expect(fallbackBotMove(exposed)).toEqual({ from: "e8", to: "e1" });
  });
});
