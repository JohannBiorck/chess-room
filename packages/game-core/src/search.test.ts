import type { CatEffect, MoveInput, RulesetId } from "@chess-room/contracts";
import { describe, expect, it } from "vitest";
import {
  applyEngineMove,
  createEngineState,
  getEngineSearchPosition,
  inspectEngine,
  inspectEngineReplay,
} from "./index.js";
import {
  completeSearchMove,
  createSearchPosition,
  prepareSearchMove,
  searchChanceChoices,
  searchExchangeGain,
  searchLegalMoves,
  searchOutcome,
  searchRepetitionCount,
} from "./search.js";

function input(move: { from: string; to: string; promotion?: string }): MoveInput {
  return {
    from: move.from,
    to: move.to,
    ...(move.promotion ? { promotion: move.promotion as "q" | "r" | "b" | "n" } : {}),
  };
}
function identity(move: MoveInput): string {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}
function sameEffect(
  left: Pick<CatEffect, "action" | "piece" | "square">,
  right: Pick<CatEffect, "action" | "piece" | "square">,
): boolean {
  return left.action === right.action && left.piece === right.piece && left.square === right.square;
}

describe("browser-safe search and durable rules parity", () => {
  for (const rulesetId of ["standard", "three-check", "catchess", "chaos-cat"] as const)
    it(`matches every committed transition for ${rulesetId}`, () => {
      let state = createEngineState(
        rulesetId,
        undefined,
        rulesetId === "catchess" ? { white: 100, black: -100 } : undefined,
      );
      for (let ply = 0; ply < 12; ply += 1) {
        const authoritative = inspectEngine(state);
        const search = createSearchPosition(getEngineSearchPosition(state));
        expect(searchOutcome(search)).toEqual(authoritative.outcome);
        expect(searchLegalMoves(search).map(input).map(identity).sort()).toEqual(
          authoritative.legalMoves.map(identity).sort(),
        );
        if (authoritative.outcome) break;
        const move = authoritative.legalMoves[(ply * 7 + 3) % authoritative.legalMoves.length];
        if (!move) throw new Error("The parity fixture has no move.");
        const prepared = prepareSearchMove(search, move);
        const choices = searchChanceChoices(prepared);
        expect(choices.reduce((sum, choice) => sum + choice.probability, 0)).toBeCloseTo(1, 12);
        const next = applyEngineMove(state, move, ply.toString(16).padStart(64, "0"));
        const nextView = inspectEngine(next);
        const effect = nextView.catEffects.at(-1);
        const choice = choices.find((choice) =>
          effect ? sameEffect(choice, effect) : choice.action === "none",
        );
        expect(choice).toBeDefined();
        if (!choice) throw new Error("The saved effect is absent from the exact distribution.");
        const transitioned = completeSearchMove(prepared, choice).position;
        expect(transitioned.chess.fen()).toBe(nextView.fen);
        expect(transitioned.checks).toEqual(nextView.checks);
        expect(searchOutcome(transitioned)).toEqual(nextView.outcome);
        expect(searchRepetitionCount(transitioned)).toBe(
          searchRepetitionCount(createSearchPosition(getEngineSearchPosition(next))),
        );
        state = next;
      }
    });

  it("retains Chaos action/type mass including missing-type no-ops", () => {
    const state = createEngineState("chaos-cat", "4k3/8/8/8/8/8/P7/4K3 w - - 0 1");
    const choices = searchChanceChoices(
      prepareSearchMove(createSearchPosition(getEngineSearchPosition(state)), {
        from: "a2",
        to: "a3",
      }),
    );
    const mass = (action: string, piece: string) =>
      choices
        .filter((item) => item.action === action && item.piece === piece)
        .reduce((sum, item) => sum + item.probability, 0);
    expect(mass("add", "p")).toBeCloseTo(0.25, 12);
    expect(mass("remove", "p")).toBeCloseTo(0.25, 12);
    for (const piece of ["r", "b", "n", "q"]) {
      expect(mass("add", piece)).toBeCloseTo(0.0625, 12);
      expect(mass("none", piece)).toBeCloseTo(0.0625, 12);
    }
    expect(choices.some((item) => item.square === "a1" && item.action === "add")).toBe(true);
    expect(choices.some((item) => String(item.piece) === "k")).toBe(false);
  });

  it("captures an exposed king before applying another cat", () => {
    const state = applyEngineMove(
      createEngineState("chaos-cat", "k3r3/8/8/8/8/8/P3R3/4K3 w - - 0 1"),
      { from: "a2", to: "a3" },
      "17".padStart(64, "0"),
    );
    const prepared = prepareSearchMove(createSearchPosition(getEngineSearchPosition(state)), {
      from: "e8",
      to: "e1",
    });
    const choices = searchChanceChoices(prepared);
    expect(choices).toEqual([{ probability: 1, action: "none" }]);
    const terminal = completeSearchMove(prepared, choices[0] ?? { action: "none" }).position;
    expect(searchOutcome(terminal)).toEqual({ winner: "black", reason: "king-captured" });
    expect(searchLegalMoves(terminal)).toEqual([]);
  });

  it("keeps safe Cat thefts from exposing a protected king", () => {
    const state = createEngineState("catchess", "k3r3/8/8/8/8/8/P3P3/4K3 w - - 0 1", {
      white: -100,
      black: 0,
    });
    const choices = searchChanceChoices(
      prepareSearchMove(createSearchPosition(getEngineSearchPosition(state)), {
        from: "a2",
        to: "a3",
      }),
    );
    expect(choices.some((choice) => choice.square === "e2")).toBe(false);
    expect(choices.reduce((sum, choice) => sum + choice.probability, 0)).toBe(1);
  });

  it("labels actual Chaos shielding thefts without changing their chance mass", () => {
    const state = createEngineState("chaos-cat", "k3r3/8/8/8/8/8/PPPPPPPP/4K3 w - - 0 1");
    const choices = searchChanceChoices(
      prepareSearchMove(createSearchPosition(getEngineSearchPosition(state)), {
        from: "a2",
        to: "a3",
      }),
    );
    const shield = choices.find((choice) => choice.action === "remove" && choice.square === "e2");
    expect(shield?.kingExposure).toBe(true);
    expect(shield?.probability).toBeCloseTo(1 / 32, 12);
    expect(
      choices.find((choice) => choice.action === "remove" && choice.square === "a3")?.kingExposure,
    ).toBeUndefined();
  });

  for (const rules of ["standard", "catchess", "chaos-cat"] as RulesetId[])
    it(`exports a single validated seed-free timeline for ${rules}`, () => {
      let state = createEngineState(rules);
      const expected: string[] = [];
      for (let ply = 0; ply < 8; ply += 1) {
        const move = inspectEngine(state).legalMoves[ply % 3];
        if (!move) break;
        state = applyEngineMove(state, move, ply.toString(16).padStart(64, "0"));
        expected.push(inspectEngine(state).fen);
      }
      const replay = inspectEngineReplay(state);
      expect(replay.positions.map((item) => item.fen)).toEqual(expected);
      expect(JSON.stringify(replay)).not.toContain('"draw"');
      expect(replay.positions.at(-1)?.move).toEqual(inspectEngine(state).moves.at(-1));
    });
});

describe("bounded legal exchange estimates", () => {
  const position = (fen: string, mode: RulesetId = "standard") =>
    createSearchPosition(getEngineSearchPosition(createEngineState(mode, fen)));

  it("recognizes a queen lost to a pawn recapture", () => {
    expect(searchExchangeGain(position("4k3/8/8/4p3/5Q2/8/8/4K3 b - - 0 1"), "f4")).toBe(900);
  });
  it("does not treat a pinned pawn as a legal defender", () => {
    expect(searchExchangeGain(position("4k3/4p3/3Q4/8/8/8/8/4R1K1 b - - 0 1"), "d6")).toBe(0);
  });
  it("allows declining a losing rook-for-knight exchange", () => {
    expect(searchExchangeGain(position("3r2k1/8/8/8/3N4/2P5/8/6K1 b - - 0 1"), "d4")).toBe(0);
  });
  it("rejects a king recapture onto a defended square", () => {
    expect(searchExchangeGain(position("4k3/4Q3/8/8/8/8/4R3/6K1 b - - 0 1"), "e7")).toBe(0);
  });
  it("preserves the real position and bounds longer exchange chains", () => {
    const board = position("3r2k1/8/8/8/3Q4/2P5/8/6K1 b - - 0 1");
    const fen = board.chess.fen();
    expect(searchExchangeGain(board, "d4")).toBe(400);
    expect(searchExchangeGain(board, "d4", 1)).toBe(900);
    expect(board.chess.fen()).toBe(fen);
  });
});
