import { type CatchessConfig, enginePositionSchema, type MoveInput } from "@chess-room/contracts";
import { describe, expect, it, vi } from "vitest";
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

const draw = (number = 0) => number.toString(16).padStart(64, "0");
const config = (white = 100, black = 0): CatchessConfig => ({ white, black });
const create = (fen?: string, settings = config()) => createEngineState("catchess", fen, settings);
const move = (state: EngineState, from: string, to: string, number = 0) =>
  applyEngineMove(state, { from, to }, draw(number));

describe("Catchess settings and signed chance", () => {
  it("defaults both players to 25 and does not share caller-owned settings", () => {
    expect(createEngineState("catchess").catchess).toEqual({ white: 25, black: 25 });
    const settings = config();
    const state = create(undefined, settings);
    settings.white = -100;
    expect(state.catchess?.white).toBe(100);
  });

  it("keeps zero-chance chess identical while recording every skipped turn", () => {
    let cat = create(undefined, config(0, 0));
    let standard = createEngineState();
    for (const input of [
      { from: "e2", to: "e4" },
      { from: "e7", to: "e5" },
      { from: "g1", to: "f3" },
    ]) {
      cat = applyEngineMove(cat, input, draw());
      standard = applyEngineMove(standard, input);
    }
    const position = inspectEngine(cat);
    expect({ ...position, catEffects: [] }).toEqual(inspectEngine(standard));
    expect(position.catEffects).toEqual([
      { ply: 1, color: "white", action: "none" },
      { ply: 2, color: "black", action: "none" },
      { ply: 3, color: "white", action: "none" },
    ]);
  });

  it("uses each mover's independent sign and guarantees attempts at either extreme", () => {
    const initial = create(undefined, config(100, -100));
    const whiteMoved = move(initial, "e2", "e4");
    const bothMoved = move(whiteMoved, "e7", "e5");
    const position = inspectEngine(bothMoved);
    expect(position.catEffects.map((effect) => [effect.color, effect.action])).toEqual([
      ["white", "add"],
      ["black", "remove"],
    ]);
    expect(
      position.board.filter((piece) => piece.color === "white" && piece.type === "p"),
    ).toHaveLength(9);
    expect(
      position.board.filter((piece) => piece.color === "black" && piece.type === "p"),
    ).toHaveLength(7);
    expect(initial.moves).toEqual([]);
    expect(initial.catTurns).toEqual([]);
  });

  it("uses a strict percentage boundary for both signs", () => {
    // These fixed version-one draws produce gates 40 and 50 respectively.
    for (const chance of [50, -50]) {
      expect(
        inspectEngine(move(create(undefined, config(chance)), "e2", "e4", 0)).catEffects[0]?.action,
      ).toBe(chance > 0 ? "add" : "remove");
      expect(
        inspectEngine(move(create(undefined, config(chance)), "e2", "e4", 6)).catEffects[0]?.action,
      ).toBe("none");
    }
  });

  it("validates settings and requires bounded server entropy only for this mode", () => {
    for (const chance of [-101, 101, 0.5, Number.NaN]) {
      expect(() => create(undefined, config(chance))).toThrow(EngineError);
    }
    for (const entropy of [undefined, "0", "g".repeat(64), "A".repeat(64), "0".repeat(65)]) {
      expect(() => applyEngineMove(create(), { from: "e2", to: "e4" }, entropy)).toThrow(
        EngineError,
      );
    }
    expect(() => createEngineState("standard", undefined, config())).toThrow(EngineError);
    expect(
      inspectEngine(applyEngineMove(createEngineState(), { from: "e2", to: "e4" })).catEffects,
    ).toEqual([]);
  });
});

describe("Catchess targets and safety", () => {
  it.each([
    {
      side: "white",
      settings: config(),
      start: "w",
      from: "h1",
      to: "g1",
      target: "a1",
      entropy: 54,
      replyFrom: "h8",
      replyTo: "g8",
      forward: "a2",
    },
    {
      side: "black",
      settings: config(0, 100),
      start: "b",
      from: "h8",
      to: "g8",
      target: "a8",
      entropy: 14,
      replyFrom: "h1",
      replyTo: "g1",
      forward: "a7",
    },
  ])("allows a $side back-rank pawn and replays its next normal move", (example) => {
    const initial = create(`7k/8/8/8/8/8/8/7K ${example.start} - - 0 1`, example.settings);
    let state = move(initial, example.from, example.to, example.entropy);
    expect(inspectEngine(state).board).toContainEqual({
      square: example.target,
      type: "p",
      color: example.side,
    });
    state = move(state, example.replyFrom, example.replyTo);
    expect(inspectEngine(state).legalMoves).toContainEqual({
      from: example.target,
      to: example.forward,
    });
    state = move(state, example.target, example.forward);
    expect(inspectEngine(JSON.parse(JSON.stringify(state)) as EngineState)).toEqual(
      inspectEngine(state),
    );
    expect(inspectEngine(state).moves[2]?.san).toBe(example.forward);
  });

  it("can exceed the original 32 pieces without breaking the public projection", () => {
    const state = move(move(create(undefined, config(100, 100)), "g1", "f3"), "g8", "f6");
    const position = inspectEngine(state);
    expect(position.board).toHaveLength(34);
    expect(enginePositionSchema.safeParse(position).success).toBe(true);
    for (const effect of position.catEffects) {
      expect(effect.action).toBe("add");
      const rank = Number(effect.square?.[1]);
      expect(effect.color === "white" ? rank <= 4 : rank >= 5).toBe(true);
    }
  });

  it("skips a full own half and an evil turn with no own pawns", () => {
    const full = create("k7/8/8/7N/PPPPPPPP/PPPPPPPP/PPPPPPPP/RRRRKRRR w - - 0 1");
    expect(inspectEngine(move(full, "h5", "f6")).catEffects).toEqual([
      { ply: 1, color: "white", action: "none" },
    ]);
    const noPawn = create("7k/8/8/8/8/8/8/R6K w - - 0 1", config(-100));
    expect(inspectEngine(move(noPawn, "a1", "a2")).catEffects).toEqual([
      { ply: 1, color: "white", action: "none" },
    ]);
  });

  it("never removes a pinned pawn and skips when it is the only target", () => {
    const onlyPinned = create("4r1k1/8/8/8/8/8/R3P3/4K3 w - - 0 1", config(-100));
    const safe = inspectEngine(move(onlyPinned, "a2", "a3"));
    expect(safe.catEffects[0]?.action).toBe("none");
    expect(safe.board).toContainEqual({ square: "e2", type: "p", color: "white" });
    const alternative = create("4r1k1/8/8/8/P7/8/R3P3/4K3 w - - 0 1", config(-100));
    expect(inspectEngine(move(alternative, "a2", "a3")).catEffects[0]).toEqual({
      ply: 1,
      color: "white",
      action: "remove",
      square: "a4",
    });
  });

  it("removes its own pawn on the opposing half and can uncover a checking line", () => {
    const advanced = create("k7/7P/8/8/8/8/8/R6K w - - 0 1", config(-100));
    const removed = inspectEngine(move(advanced, "a1", "a2"));
    expect(removed.catEffects[0]).toEqual({
      ply: 1,
      color: "white",
      action: "remove",
      square: "h7",
    });
    expect(removed.board.some((piece) => piece.square === "h7")).toBe(false);
    const blocked = create("4k3/8/8/8/4P3/8/8/4R2K w - - 0 1", config(-100));
    const checked = inspectEngine(move(blocked, "h1", "g1"));
    expect(checked.moves[0]?.san).toBe("Kg1+");
    expect(checked.inCheck).toBe(true);
  });

  it("rejects an illegal move even if a hypothetical cat effect could shield the king", () => {
    const state = create("4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1");
    expect(() => move(state, "e2", "f2")).toThrow(EngineError);
    expect(state.catTurns).toEqual([]);
  });
});

describe("Catchess adjudication and notation after the effect", () => {
  it("includes checks and mates created by a new pawn in final SAN and PGN", () => {
    const checking = move(create("8/8/8/3k4/8/8/8/7K w - - 0 1"), "h1", "g1", 9);
    expect(inspectEngine(checking).moves[0]?.san).toBe("Kg1+");
    expect(inspectEngine(checking).checks).toEqual({ white: 1, black: 0 });
    const mating = move(create("8/8/2Q5/k7/2K5/8/8/7R w - - 0 1"), "h1", "h2", 12);
    expect(inspectEngine(mating).moves[0]?.san).toBe("Rh2#");
    expect(inspectEngine(mating).outcome).toEqual({ winner: "white", reason: "checkmate" });
    expect(exportPgn(mating)).toContain("1. Rh2# {Cat white add b4} 1-0");
  });

  it("removes a premature checkmate suffix when the evil cat removes the checking pawn", () => {
    const fen = "8/8/2Q5/k7/2K5/1P6/8/8 w - - 0 1";
    expect(
      inspectEngine(applyEngineMove(createEngineState("standard", fen), { from: "b3", to: "b4" }))
        .outcome?.reason,
    ).toBe("checkmate");
    const state = move(create(fen, config(-100)), "b3", "b4");
    expect(inspectEngine(state).moves[0]?.san).toBe("b4");
    expect(inspectEngine(state).outcome).toEqual({ winner: null, reason: "stalemate" });
    expect(exportPgn(state)).toContain("1. b4 {Cat white remove b4} 1/2-1/2");
  });

  it("resets the half-move counter only for an applied effect", () => {
    const fen = "7k/8/8/8/P7/8/R7/7K w - - 149 90";
    for (const chance of [100, -100]) {
      const position = inspectEngine(move(create(fen, config(chance)), "a2", "b2"));
      expect(position.fen.split(" ")[4]).toBe("0");
      expect(position.outcome).toBeNull();
      expect(position.claimableDraws).toEqual([]);
    }
    const skipped = inspectEngine(move(create(fen, config(0)), "a2", "b2"));
    expect(skipped.fen.split(" ")[4]).toBe("150");
    expect(skipped.outcome?.reason).toBe("seventy-five-move");
  });

  it("accounts for future helpful pawns when deciding dead material and timeout wins", () => {
    const kings = "7k/8/8/8/8/8/8/7K w - - 0 1";
    const helpful = create(kings, config(1, 0));
    expect(inspectEngine(helpful).outcome).toBeNull();
    expect(canWinOnTime(helpful, "white")).toBe(true);
    expect(canWinOnTime(helpful, "black")).toBe(false);
    expect(inspectEngine(create(kings, config(0, -100))).outcome?.reason).toBe("dead-position");
    const bishop = "7k/8/8/8/8/8/8/5B1K w - - 0 1";
    expect(canWinOnTime(create(bishop, config(0, 1)), "white")).toBe(true);
    expect(inspectEngine(create(bishop, config(0, 0))).outcome?.reason).toBe("dead-position");
  });

  it("retains repetition claims across no-effect turns and rejects terminal history", () => {
    const cycle: MoveInput[] = [
      { from: "g1", to: "f3" },
      { from: "g8", to: "f6" },
      { from: "f3", to: "g1" },
      { from: "f6", to: "g8" },
    ];
    let state = create(undefined, config(0, 0));
    for (let repeat = 0; repeat < 2; repeat += 1) {
      for (const input of cycle) state = applyEngineMove(state, input, draw());
    }
    expect(claimEngineDraw(state).reason).toBe("threefold-repetition");
    for (let repeat = 0; repeat < 2; repeat += 1) {
      for (const input of cycle) state = applyEngineMove(state, input, draw());
    }
    expect(inspectEngine(state).outcome?.reason).toBe("fivefold-repetition");
    expect(() => move(state, "g1", "f3")).toThrow(EngineError);
  });
});

describe("Catchess special moves and durable replay", () => {
  it.each([21, 28])(
    "preserves legal en passant after an unrelated cat spawn (draw %i)",
    (entropy) => {
      const initial = create("7k/8/8/8/3p4/8/4P3/7K w - - 0 1");
      const state = move(initial, "e2", "e4", entropy);
      expect(inspectEngine(state).fen.split(" ")[3]).toBe("e3");
      expect(inspectEngine(state).legalMoves).toContainEqual({ from: "d4", to: "e3" });
      const captured = inspectEngine(move(state, "d4", "e3"));
      expect(captured.board).toContainEqual({ square: "e3", type: "p", color: "black" });
      expect(captured.board.some((piece) => piece.square === "e4")).toBe(false);
    },
  );

  it("cancels en passant when its pawn disappears or the target becomes occupied", () => {
    const fen = "7k/8/8/8/3p4/8/4P3/7K w - - 0 1";
    const removed = inspectEngine(move(create(fen, config(-100)), "e2", "e4"));
    expect(removed.fen.split(" ")[3]).toBe("-");
    expect(removed.legalMoves).not.toContainEqual({ from: "d4", to: "e3" });
    const occupied = move(create(fen), "e2", "e4", 24);
    expect(inspectEngine(occupied).fen.split(" ")[3]).toBe("-");
    // The cat pawn on e3 can be captured normally; the double-pushed e4 pawn stays.
    const captured = inspectEngine(move(occupied, "d4", "e3"));
    expect(captured.board).toContainEqual({ square: "e4", type: "p", color: "white" });
    expect(captured.moves[1]?.san).toBe("dxe3");
  });

  it("retains castling history and supports all promotion choices with an applied cat effect", () => {
    const castled = move(create("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"), "e1", "g1");
    const position = inspectEngine(castled);
    expect(position.board).toContainEqual({ square: "f1", type: "r", color: "white" });
    expect(position.fen.split(" ")[2]).toBe("kq");
    expect(position.moves[0]?.san).toBe("O-O");
    for (const promotion of ["q", "r", "b", "n"] as const) {
      const state = applyEngineMove(
        create("7k/P7/8/8/8/8/8/7K w - - 0 1"),
        { from: "a7", to: "a8", promotion },
        draw(),
      );
      expect(inspectEngine(state).board).toContainEqual({
        square: "a8",
        type: promotion,
        color: "white",
      });
      expect(inspectEngine(state).catEffects[0]?.action).toBe("add");
      expect(inspectEngine(state).moves[0]?.san).toContain(`a8=${promotion.toUpperCase()}`);
    }
  });

  it("replays fixed saved draws without randomness and rejects tampered or misaligned effects", () => {
    const initial = create("7k/8/8/8/8/8/8/7K w - - 0 1");
    const state = move(initial, "h1", "g1", 54);
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
    expect(turn).toEqual({
      draw: draw(54),
      effect: { ply: 1, color: "white", action: "add", square: "a1" },
    });
    if (!turn) throw new Error("A cat turn was expected.");
    const tampered = [
      { ...state, catTurns: [] },
      { ...state, catTurns: [{ ...turn, draw: draw(14) }] },
      { ...state, catTurns: [{ ...turn, effect: { ...turn.effect, square: "b1" } }] },
      { ...state, catTurns: [{ ...turn, effect: { ...turn.effect, ply: 2 } }] },
      { ...state, catTurns: [{ ...turn, effect: { ...turn.effect, color: "black" } }] },
      { ...state, catchess: undefined },
    ];
    for (const value of tampered)
      expect(() => inspectEngine(value as EngineState)).toThrow(EngineError);
    expect(() => create("P6k/8/8/8/8/8/8/7K w - - 0 1")).toThrow(EngineError);
  });

  it("exports all turns with variant settings, effects, starting numbers and external results", () => {
    let state = create(undefined, config(100, -100));
    state = move(state, "e2", "e4");
    state = move(state, "e7", "e5");
    state = move(state, "g1", "f3");
    const pgn = exportPgn(state, { winner: "black", reason: "resignation" });
    expect(pgn).toContain('[Variant "Catchess"]');
    expect(pgn).toContain('[CatchessWhiteChance "100"]');
    expect(pgn).toContain('[CatchessBlackChance "-100"]');
    expect(pgn).toContain('[Result "0-1"]');
    expect(pgn).toMatch(
      /1\. e4 \{Cat white add [a-h][1-4]\} e5 \{Cat black remove [a-h][1-8]\} 2\. Nf3 \{Cat white add [a-h][1-4]\} 0-1$/,
    );
    expect(pgn).not.toContain("SetUp");
    const fen = "7k/8/8/8/8/8/R7/7K b - - 0 12";
    const custom = move(create(fen, config(0, 0)), "h8", "g8");
    expect(exportPgn(custom)).toContain('[SetUp "1"]');
    expect(exportPgn(custom)).toContain(`[FEN "${fen}"]`);
    expect(exportPgn(custom)).toContain("12... Kg8 {Cat black none} *");
  });
});
