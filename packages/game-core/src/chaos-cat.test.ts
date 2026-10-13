import { type EnginePosition, enginePositionSchema } from "@chess-room/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  applyEngineMove,
  canWinOnTime,
  createEngineState,
  EngineError,
  type EngineState,
  exportPgn,
  inspectEngine,
} from "./index.js";

const draw = (number = 0) => number.toString(16).padStart(64, "0");
const create = (fen?: string) => createEngineState("chaos-cat", fen);
const move = (state: EngineState, from: string, to: string, number = 0) =>
  applyEngineMove(state, { from, to }, draw(number));
const count = (position: EnginePosition, piece: string, color = "white") =>
  position.board.filter((entry) => entry.type === piece && entry.color === color).length;

// Fixed version-one server draws cover each of the eight equal piece buckets.
// Four buckets are pawn; rook, bishop, knight and queen have one bucket each.
const grantBuckets = [
  { seed: 27, piece: "p" },
  { seed: 9, piece: "p" },
  { seed: 13, piece: "p" },
  { seed: 0, piece: "p" },
  { seed: 4, piece: "r" },
  { seed: 7, piece: "b" },
  { seed: 1, piece: "n" },
  { seed: 31, piece: "q" },
] as const;
const theftBuckets = [
  { seed: 24, piece: "p" },
  { seed: 2, piece: "p" },
  { seed: 8, piece: "p" },
  { seed: 5, piece: "p" },
  { seed: 23, piece: "r" },
  { seed: 17, piece: "b" },
  { seed: 21, piece: "n" },
  { seed: 11, piece: "q" },
] as const;

describe("Chaos Cat action and piece draws", () => {
  it("has no player sliders and requires a valid private server draw on every move", () => {
    const state = create();
    expect(state.catchess).toBeUndefined();
    expect(state.catTurns).toEqual([]);
    for (const entropy of [undefined, "0", "A".repeat(64), "g".repeat(64), "0".repeat(65)])
      expect(() => applyEngineMove(state, { from: "g1", to: "f3" }, entropy)).toThrow(EngineError);
    expect(() => createEngineState("chaos-cat", undefined, { white: 25, black: 25 })).toThrow(
      EngineError,
    );
  });

  it.each(grantBuckets)("grants the selected $piece in bucket draw $seed", ({ seed, piece }) => {
    const initial = create();
    const before = inspectEngine(initial);
    const result = inspectEngine(move(initial, "g1", "f3", seed));
    const effect = result.catEffects[0];
    expect(effect).toMatchObject({ ply: 1, color: "white", action: "add", piece });
    expect(count(result, piece)).toBe(count(before, piece) + 1);
    expect(result.board).toHaveLength(33);
    expect(Number(effect?.square?.[1])).toBeLessThanOrEqual(4);
    expect(
      before.board.some((entry) => entry.square === effect?.square && entry.square !== "g1"),
    ).toBe(false);
    expect(count(result, "k")).toBe(1);
    expect(count(result, "k", "black")).toBe(1);
  });

  it.each(theftBuckets)(
    "steals only the selected $piece in bucket draw $seed",
    ({ seed, piece }) => {
      const initial = create();
      const before = inspectEngine(initial);
      const result = inspectEngine(move(initial, "g1", "f3", seed));
      expect(result.catEffects[0]).toMatchObject({ color: "white", action: "remove", piece });
      expect(count(result, piece)).toBe(count(before, piece) - 1);
      expect(result.board).toHaveLength(31);
      expect(count(result, "k")).toBe(1);
      expect(count(result, "k", "black")).toBe(1);
    },
  );

  it("does nothing when the selected piece is absent instead of selecting another type", () => {
    const state = create("7k/8/8/8/8/8/P7/7K w - - 0 1");
    const result = inspectEngine(move(state, "a2", "a3", 23));
    expect(result.catEffects[0]).toEqual({ ply: 1, color: "white", action: "none", piece: "r" });
    expect(count(result, "p")).toBe(1);
    expect(result.board).toHaveLength(3);
    expect(result.fen.split(" ")[4]).toBe("0");
  });

  it("skips a grant on a full own half and targets black's own half independently", () => {
    const full = create("k7/8/8/7N/PPPPPPPP/PPPPPPPP/PPPPPPPP/RRRRKRRR w - - 0 1");
    expect(inspectEngine(move(full, "h5", "f6", 31)).catEffects[0]).toEqual({
      ply: 1,
      color: "white",
      action: "none",
      piece: "q",
    });
    const black = inspectEngine(move(create("7k/8/8/8/8/8/8/7K b - - 0 1"), "h8", "g8", 4));
    expect(black.catEffects[0]).toMatchObject({ color: "black", action: "add", piece: "r" });
    expect(Number(black.catEffects[0]?.square?.[1])).toBeGreaterThanOrEqual(5);
  });

  it("permits a new pawn on a vacated home back-rank square and replays it", () => {
    const state = move(create(), "g1", "f3", 9);
    expect(inspectEngine(state).catEffects[0]).toEqual({
      ply: 1,
      color: "white",
      action: "add",
      piece: "p",
      square: "g1",
    });
    expect(inspectEngine(state).board).toContainEqual({ square: "g1", type: "p", color: "white" });
    expect(inspectEngine(JSON.parse(JSON.stringify(state)) as EngineState)).toEqual(
      inspectEngine(state),
    );
  });

  it("can steal an owned piece on the opponent's half", () => {
    const result = inspectEngine(move(create("k7/7R/8/8/8/8/8/7K w - - 0 1"), "h1", "g1", 23));
    expect(result.catEffects[0]).toEqual({
      ply: 1,
      color: "white",
      action: "remove",
      piece: "r",
      square: "h7",
    });
  });
});

describe("Chaos Cat king exposure and winning captures", () => {
  const exposed = () => move(create("k3r3/8/8/8/8/8/P3R3/4K3 w - - 0 1"), "a2", "a3", 23);

  it("allows an unlucky theft to expose the mover's king and an opponent to capture it", () => {
    const state = exposed();
    const position = inspectEngine(state);
    expect(position.threatenedKings).toEqual(["white"]);
    expect(position.inCheck).toBe(false);
    expect(position.moves[0]?.san).toBe("a3");
    expect(position.outcome).toBeNull();
    expect(position.legalMoves).toContainEqual({ from: "e8", to: "e1" });
    const captured = move(state, "e8", "e1");
    const terminal = inspectEngine(captured);
    expect(terminal.outcome).toEqual({ winner: "black", reason: "king-captured" });
    expect(terminal.legalMoves).toEqual([]);
    expect(terminal.claimableDraws).toEqual([]);
    expect(terminal.threatenedKings).toEqual([]);
    expect(terminal.inCheck).toBe(false);
    expect(count(terminal, "k")).toBe(0);
    expect(count(terminal, "k", "black")).toBe(1);
    expect(terminal.catEffects[1]).toEqual({ ply: 2, color: "black", action: "none" });
    expect(enginePositionSchema.parse(terminal)).toEqual(terminal);
    expect(inspectEngine(JSON.parse(JSON.stringify(captured)) as EngineState)).toEqual(terminal);
    expect(() => move(captured, "a3", "a4")).toThrow(EngineError);
    expect(() =>
      inspectEngine({ ...captured, moves: [...captured.moves, { from: "a3", to: "a4" }] }),
    ).toThrow(EngineError);
    expect(exportPgn(captured)).toContain('[Result "0-1"]');
    expect(exportPgn(captured)).toContain('[Termination "king-captured"]');
    expect(exportPgn(captured)).toContain("Rxe1 {Cat black none} 0-1");
  });

  it("keeps standard move safety when the opponent chooses not to capture the exposed king", () => {
    const state = move(exposed(), "e8", "e7", 11);
    expect(inspectEngine(state).threatenedKings).toEqual(["white"]);
    expect(inspectEngine(state).inCheck).toBe(true);
    expect(() => move(state, "a3", "a4", 0)).toThrow(EngineError);
    const pinned = create("k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1");
    expect(() => move(pinned, "e2", "f2", 0)).toThrow(EngineError);
  });

  it("reports both threatened kings without confusing self-exposure with an opponent check", () => {
    const state = move(create("k3r3/8/1Q6/8/8/8/4R3/4K3 w - - 0 1"), "b6", "b7", 23);
    const position = inspectEngine(state);
    expect(position.threatenedKings).toEqual(["white", "black"]);
    expect(position.inCheck).toBe(true);
    expect(position.moves[0]?.san).toBe("Qb7+");
    expect(position.checks).toEqual({ white: 1, black: 0 });
    expect(position.legalMoves).not.toContainEqual({ from: "e8", to: "e1" });
  });

  it("still recognizes checkmate after the cat and keeps bare kings alive for future grants", () => {
    const mated = move(create("7k/5K2/6Q1/8/8/8/8/8 w - - 0 1"), "g6", "g7", 23);
    expect(inspectEngine(mated).outcome).toEqual({ winner: "white", reason: "checkmate" });
    expect(inspectEngine(mated).moves[0]?.san).toBe("Qg7#");
    const kings = create("7k/8/8/8/8/8/8/7K w - - 0 1");
    expect(inspectEngine(kings).outcome).toBeNull();
    expect(canWinOnTime(kings, "white")).toBe(true);
    expect(canWinOnTime(kings, "black")).toBe(true);
  });
});

describe("Chaos Cat history, rights and durable replay", () => {
  it("never restores lost castling rights when granting a replacement corner rook", () => {
    let state = move(create("k7/8/8/8/8/8/P7/4K2R w K - 0 1"), "a2", "a3", 23);
    expect(inspectEngine(state).catEffects[0]).toMatchObject({
      action: "remove",
      piece: "r",
      square: "h1",
    });
    expect(inspectEngine(state).fen.split(" ")[2]).toBe("-");
    state = move(state, "a8", "b8", 11);
    state = move(state, "a3", "a4", 677);
    expect(inspectEngine(state).catEffects[2]).toMatchObject({
      action: "add",
      piece: "r",
      square: "h1",
    });
    expect(inspectEngine(state).fen.split(" ")[2]).toBe("-");
  });

  it("preserves en passant after an unrelated grant and cancels it when the victim is stolen", () => {
    const fen = "7k/8/8/8/3p4/8/4P3/7K w - - 0 1";
    const added = move(create(fen), "e2", "e4", 0);
    expect(inspectEngine(added).catEffects[0]).toMatchObject({
      action: "add",
      piece: "p",
      square: "f3",
    });
    expect(inspectEngine(added).legalMoves).toContainEqual({ from: "d4", to: "e3" });
    const captured = inspectEngine(move(added, "d4", "e3", 11));
    expect(captured.board).toContainEqual({ square: "e3", type: "p", color: "black" });
    expect(captured.board.some((entry) => entry.square === "e4")).toBe(false);
    const stolen = inspectEngine(move(create(fen), "e2", "e4", 2));
    expect(stolen.catEffects[0]).toMatchObject({ action: "remove", piece: "p", square: "e4" });
    expect(stolen.fen.split(" ")[3]).toBe("-");
  });

  it("supports all promotions before the cat and resets the half-move counter only on applied effects", () => {
    for (const promotion of ["q", "r", "b", "n"] as const) {
      const state = applyEngineMove(
        create("7k/P7/8/8/8/8/8/7K w - - 0 1"),
        {
          from: "a7",
          to: "a8",
          promotion,
        },
        draw(0),
      );
      expect(inspectEngine(state).board).toContainEqual({
        square: "a8",
        type: promotion,
        color: "white",
      });
      expect(inspectEngine(state).catEffects[0]).toMatchObject({ action: "add", piece: "p" });
    }
    const fen = "7k/8/8/8/8/8/R7/7K w - - 149 90";
    const applied = inspectEngine(move(create(fen), "a2", "b2", 0));
    expect(applied.fen.split(" ")[4]).toBe("0");
    expect(applied.outcome).toBeNull();
    const skipped = inspectEngine(move(create(fen), "a2", "b2", 11));
    expect(skipped.fen.split(" ")[4]).toBe("150");
    expect(skipped.outcome?.reason).toBe("seventy-five-move");
  });

  it("replays persisted draws without rerolling and rejects tampering of piece, target or settings", () => {
    const state = move(create(), "g1", "f3", 4);
    const restored = JSON.parse(JSON.stringify(state)) as EngineState;
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Replay must not reroll.");
    });
    try {
      expect(inspectEngine(restored)).toEqual(inspectEngine(state));
      expect(exportPgn(restored)).toEqual(exportPgn(state));
    } finally {
      random.mockRestore();
    }
    const turn = state.catTurns?.[0];
    if (!turn) throw new Error("A cat turn was expected.");
    for (const bad of [
      { ...state, catTurns: [] },
      { ...state, catchess: { white: 0, black: 0 } },
      { ...state, catTurns: [{ ...turn, draw: draw(1) }] },
      { ...state, catTurns: [{ ...turn, effect: { ...turn.effect, piece: "q" } }] },
      { ...state, catTurns: [{ ...turn, effect: { ...turn.effect, piece: "k" } }] },
      { ...state, catTurns: [{ ...turn, effect: { ...turn.effect, piece: undefined } }] },
      { ...state, catTurns: [{ ...turn, effect: { ...turn.effect, square: "h8" } }] },
      { ...state, catTurns: [{ ...turn, effect: { ...turn.effect, color: "black" } }] },
    ])
      expect(() => inspectEngine(bad as EngineState)).toThrow(EngineError);
    const pgn = exportPgn(state);
    expect(pgn).toContain('[Event "Cat Chess game"]');
    expect(pgn).toContain('[Variant "Chaos Cat"]');
    expect(pgn).not.toContain("CatchessWhiteChance");
    expect(pgn).toMatch(/1\. Nf3 \{Cat white add r [a-h][1-4]\} \*$/);
  });
});
