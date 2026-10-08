import type { MoveInput, RulesetId } from "@chess-room/contracts";
import { describe, expect, it } from "vitest";
import {
  applyEngineMove,
  canWinOnTime,
  claimEngineDraw,
  createEngineState,
  EngineError,
  type EngineState,
  exportPgn,
  inspectEngine,
} from "./index.js";

function play(moves: MoveInput[], initialFen?: string, rulesetId: RulesetId = "standard") {
  return moves.reduce(
    (state, input) => applyEngineMove(state, input),
    createEngineState(rulesetId, initialFen),
  );
}

function move(from: string, to: string, promotion?: "q" | "r" | "b" | "n"): MoveInput {
  return { from, to, ...(promotion ? { promotion } : {}) };
}

function repeatKnightCycle(times: number): MoveInput[] {
  return Array.from({ length: times }, () => [
    move("g1", "f3"),
    move("g8", "f6"),
    move("f3", "g1"),
    move("f6", "g8"),
  ]).flat();
}

function expectEngineError(run: () => unknown, code: EngineError["code"]) {
  try {
    run();
    expect.fail("An engine error was expected.");
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe(code);
  }
}

describe("standard movement and legal positions", () => {
  it("starts with twenty legal moves and keeps previous state immutable", () => {
    const state = createEngineState();
    const next = applyEngineMove(state, move("e2", "e4"));
    expect(inspectEngine(state).legalMoves).toHaveLength(20);
    expect(state.moves).toEqual([]);
    expect(inspectEngine(next).turn).toBe("black");
    expect(inspectEngine(next).moves).toEqual([
      { ply: 1, color: "white", from: "e2", to: "e4", san: "e4" },
    ]);
  });

  it("pins pieces that would expose their king", () => {
    const state = createEngineState("standard", "4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1");
    expectEngineError(() => applyEngineMove(state, move("e2", "f2")), "illegal-move");
    expect(inspectEngine(state).legalMoves).toContainEqual(move("e2", "e8"));
  });

  it("allows normal castling while rejecting castling through check", () => {
    const safe = createEngineState("standard", "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    const castled = inspectEngine(applyEngineMove(safe, move("e1", "g1")));
    expect(castled.board).toContainEqual({ square: "f1", type: "r", color: "white" });
    expect(castled.moves[0]?.san).toBe("O-O");
    const attacked = createEngineState("standard", "4kr2/8/8/8/8/8/8/R3K2R w KQ - 0 1");
    expectEngineError(() => applyEngineMove(attacked, move("e1", "g1")), "illegal-move");
    expect(inspectEngine(attacked).legalMoves).toContainEqual(move("e1", "c1"));
  });

  it("performs en passant and rejects it when removing the pawn exposes check", () => {
    const legal = createEngineState("standard", "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
    const captured = inspectEngine(applyEngineMove(legal, move("e5", "d6")));
    expect(captured.board).toContainEqual({ square: "d6", type: "p", color: "white" });
    expect(captured.board.some((piece) => piece.square === "d5")).toBe(false);
    const pinned = createEngineState("standard", "k7/8/8/4KPpr/8/8/8/8 w - g6 0 1");
    expectEngineError(() => applyEngineMove(pinned, move("f5", "g6")), "illegal-move");
  });

  it.each(["q", "r", "b", "n"] as const)("supports promotion to %s", (promotion) => {
    const state = createEngineState("standard", "7k/P7/8/8/8/8/8/7K w - - 0 1");
    const result = inspectEngine(applyEngineMove(state, move("a7", "a8", promotion)));
    expect(result.board).toContainEqual({ square: "a8", type: promotion, color: "white" });
    expect(result.moves[0]?.promotion).toBe(promotion);
  });

  it("requires an explicit promotion and rejects promotion on another move", () => {
    const promotion = createEngineState("standard", "7k/P7/8/8/8/8/8/7K w - - 0 1");
    expectEngineError(() => applyEngineMove(promotion, move("a7", "a8")), "illegal-move");
    expectEngineError(
      () => applyEngineMove(createEngineState(), move("e2", "e4", "q")),
      "illegal-move",
    );
  });
});

describe("draw policy and terminal precedence", () => {
  it("requires a current-position threefold claim and preserves it through serialization", () => {
    const state = play(repeatKnightCycle(2));
    const restored = JSON.parse(JSON.stringify(state)) as EngineState;
    expect(inspectEngine(restored)).toEqual(inspectEngine(state));
    expect(inspectEngine(restored).outcome).toBeNull();
    expect(inspectEngine(restored).claimableDraws).toEqual(["threefold-repetition"]);
    expect(claimEngineDraw(restored)).toEqual({ winner: null, reason: "threefold-repetition" });
    expectEngineError(() => claimEngineDraw(createEngineState()), "draw-unavailable");
  });

  it("automatically ends fivefold repetition and disallows additional moves", () => {
    const state = play(repeatKnightCycle(4));
    expect(inspectEngine(state).outcome).toEqual({ winner: null, reason: "fivefold-repetition" });
    expectEngineError(() => applyEngineMove(state, move("g1", "f3")), "game-finished");
  });

  it("offers a fifty-move claim without prematurely ending the game", () => {
    const state = createEngineState("standard", "7k/8/8/8/8/8/R7/7K w - - 100 70");
    expect(inspectEngine(state).outcome).toBeNull();
    expect(claimEngineDraw(state)).toEqual({ winner: null, reason: "fifty-move" });
    const moved = applyEngineMove(state, move("a2", "a3"));
    expect(inspectEngine(moved).outcome).toBeNull();
  });

  it("automatically ends seventy-five moves, with checkmate taking precedence", () => {
    const state = createEngineState("standard", "7k/8/8/8/8/8/R7/7K w - - 149 90");
    expect(inspectEngine(applyEngineMove(state, move("a2", "a3"))).outcome).toEqual({
      winner: null,
      reason: "seventy-five-move",
    });
    const mating = createEngineState("standard", "7k/5K2/6Q1/8/8/8/8/8 w - - 149 90");
    expect(inspectEngine(applyEngineMove(mating, move("g6", "g7"))).outcome).toEqual({
      winner: "white",
      reason: "checkmate",
    });
  });

  it("distinguishes stalemate from checkmate and recognizes supported dead material", () => {
    const stale = createEngineState("standard", "7k/5K2/6Q1/8/8/8/8/8 b - - 0 1");
    expect(inspectEngine(stale).outcome).toEqual({ winner: null, reason: "stalemate" });
    for (const fen of [
      "7k/8/8/8/8/8/8/7K w - - 0 1",
      "7k/8/8/8/8/8/8/5B1K w - - 0 1",
      "7k/8/8/8/8/8/8/5N1K w - - 0 1",
      "5b1k/8/8/8/8/8/8/6BK w - - 0 1",
    ]) {
      expect(inspectEngine(createEngineState("standard", fen)).outcome).toEqual({
        winner: null,
        reason: "dead-position",
      });
    }
    const oppositeBishops = createEngineState("standard", "6bk/8/8/8/8/8/8/6BK w - - 0 1");
    expect(inspectEngine(oppositeBishops).outcome).toBeNull();
  });

  it("counts castling rights in repetition identity", () => {
    const state = play(
      [
        move("h1", "h2"),
        move("h8", "h7"),
        move("h2", "h1"),
        move("h7", "h8"),
        move("h1", "h2"),
        move("h8", "h7"),
        move("h2", "h1"),
        move("h7", "h8"),
      ],
      "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
    );
    expect(inspectEngine(state).claimableDraws).toEqual([]);
  });

  it("counts only legally usable en-passant rights in repetition identity", () => {
    const usable = play(repeatKnightCycle(2), "k5n1/8/8/3pP3/8/8/8/6NK w - d6 0 1");
    expect(inspectEngine(usable).claimableDraws).toEqual([]);
    const pinned = play(repeatKnightCycle(2), "k5n1/8/8/4KPpr/8/8/8/6N1 w - g6 0 1");
    expect(inspectEngine(pinned).claimableDraws).toEqual(["threefold-repetition"]);
  });
});

describe("versioned three-check and recovery", () => {
  it("restores the version-one opening compatibility fixture unchanged", () => {
    const fixture: EngineState = {
      stateVersion: 1,
      rulesetId: "standard",
      rulesVersion: 1,
      initialFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      moves: [
        { from: "e2", to: "e4" },
        { from: "e7", to: "e5" },
        { from: "g1", to: "f3" },
        { from: "b8", to: "c6" },
        { from: "f1", to: "b5" },
        { from: "a7", to: "a6" },
      ],
    };
    const result = inspectEngine(fixture);
    expect(result.fen).toBe("r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4");
    expect(result.moves.map((record) => record.san)).toEqual([
      "e4",
      "e5",
      "Nf3",
      "Nc6",
      "Bb5",
      "a6",
    ]);
    expect(result.outcome).toBeNull();
  });

  it("wins on the third checking move and replays the check counters", () => {
    const state = play(
      [move("a2", "e2"), move("e8", "d8"), move("e2", "d2"), move("d8", "c8"), move("d2", "c2")],
      "4k3/8/8/8/8/8/R7/K7 w - - 0 1",
      "three-check",
    );
    const restored = JSON.parse(JSON.stringify(state)) as EngineState;
    expect(inspectEngine(restored).checks).toEqual({ white: 3, black: 0 });
    expect(inspectEngine(restored).outcome).toEqual({ winner: "white", reason: "three-check" });
    expect(exportPgn(restored)).toContain('[Variant "Three-check"]');
    expect(exportPgn(restored)).toContain("1-0");
  });

  it("retains a single minor piece in three-check instead of applying standard dead material", () => {
    const state = createEngineState("three-check", "7k/8/8/8/8/8/8/5B1K w - - 0 1");
    expect(inspectEngine(state).outcome).toBeNull();
    expect(canWinOnTime(state, "white")).toBe(true);
    expect(canWinOnTime(state, "black")).toBe(false);
  });

  it("treats progress toward three checks as part of repetition identity", () => {
    const checkingCycle = [move("a2", "e2"), move("e8", "d8"), move("e2", "a2"), move("d8", "e8")];
    const fen = "4k3/8/8/8/8/8/R7/K7 w - - 0 1";
    const standard = play([...checkingCycle, ...checkingCycle], fen);
    expect(inspectEngine(standard).claimableDraws).toEqual(["threefold-repetition"]);
    const variant = play([...checkingCycle, ...checkingCycle], fen, "three-check");
    expect(inspectEngine(variant).checks).toEqual({ white: 2, black: 0 });
    expect(inspectEngine(variant).claimableDraws).toEqual([]);
    expect(inspectEngine(applyEngineMove(variant, move("a2", "e2"))).outcome).toEqual({
      winner: "white",
      reason: "three-check",
    });
  });

  it("bounds saved format and rejects illegal or post-terminal history", () => {
    expectEngineError(
      () => inspectEngine({ ...createEngineState(), rulesVersion: 2 } as unknown as EngineState),
      "unsupported-version",
    );
    expectEngineError(
      () => inspectEngine({ ...createEngineState(), moves: [move("e2", "e5")] }),
      "invalid-state",
    );
    expectEngineError(() => createEngineState("standard", "not-a-fen"), "invalid-state");
    const mate = play([move("f2", "f3"), move("e7", "e5"), move("g2", "g4"), move("d8", "h4")]);
    expect(inspectEngine(mate).outcome).toEqual({ winner: "black", reason: "checkmate" });
    expectEngineError(
      () => inspectEngine({ ...mate, moves: [...mate.moves, move("a2", "a3")] }),
      "invalid-state",
    );
  });

  it("uses possible mating material for timeouts instead of requiring a forced win", () => {
    const loneKing = createEngineState("standard", "7k/8/8/8/8/8/R7/7K w - - 0 1");
    expect(canWinOnTime(loneKing, "white")).toBe(true);
    expect(canWinOnTime(loneKing, "black")).toBe(false);
    const knights = createEngineState("standard", "7k/8/8/8/8/8/NN6/7K w - - 0 1");
    expect(canWinOnTime(knights, "white")).toBe(true);
    const minorWithOpponentPawn = createEngineState("standard", "7k/p7/8/8/8/8/N7/7K w - - 0 1");
    expect(canWinOnTime(minorWithOpponentPawn, "white")).toBe(true);
  });
});
