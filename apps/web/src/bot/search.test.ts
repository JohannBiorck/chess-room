import {
  applyEngineMove,
  createEngineState,
  getEngineSearchPosition,
  inspectEngine,
} from "@chess-room/game-core";
import {
  completeSearchMove,
  createSearchPosition,
  prepareSearchMove,
  searchChanceChoices,
  searchOutcome,
} from "@chess-room/game-core/search";
import { describe, expect, it } from "vitest";
import { chooseBotMove, sampleChanceChoices } from "./search";

const deterministicBudget = { thinkMs: 2000, maxNodes: 4000, maxDepth: 3, now: () => 0 };
describe("bounded variant bot", () => {
  for (const mode of ["standard", "three-check", "catchess", "chaos-cat"] as const)
    it(`returns an authoritative legal ${mode} move under a strict node budget`, () => {
      const state = createEngineState(mode);
      const result = chooseBotMove(getEngineSearchPosition(state), {
        ...deterministicBudget,
        maxNodes: 40,
      });
      expect(inspectEngine(state).legalMoves).toContainEqual(result.move);
      expect(result.nodes).toBeLessThanOrEqual(41);
      expect(result.exhausted).toBe(true);
    });
  it("always takes an exposed Chaos king", () => {
    const state = applyEngineMove(
      createEngineState("chaos-cat", "k3r3/8/8/8/8/8/P3R3/4K3 w - - 0 1"),
      { from: "a2", to: "a3" },
      "17".padStart(64, "0"),
    );
    const result = chooseBotMove(getEngineSearchPosition(state), deterministicBudget);
    expect(result.move).toEqual({ from: "e8", to: "e1" });
    expect(result.nodes).toBe(1);
    expect(inspectEngine(applyEngineMove(state, result.move, "00".repeat(32))).outcome).toEqual({
      winner: "black",
      reason: "king-captured",
    });
  });
  it("delivers immediate standard checkmate", () => {
    const state = createEngineState("standard", "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1");
    const result = chooseBotMove(getEngineSearchPosition(state), deterministicBudget);
    expect(inspectEngine(applyEngineMove(state, result.move)).outcome).toEqual({
      winner: "white",
      reason: "checkmate",
    });
  });
  it("values the third check as a terminal win", () => {
    const snapshot = getEngineSearchPosition(
      createEngineState("three-check", "4k3/8/8/8/8/8/R7/4K3 w - - 0 1"),
    );
    snapshot.checks.white = 2;
    const result = chooseBotMove(snapshot, deterministicBudget);
    const after = completeSearchMove(
      prepareSearchMove(createSearchPosition(snapshot), result.move),
      { action: "none" },
    ).position;
    expect(searchOutcome(after)).toEqual({ winner: "white", reason: "three-check" });
  });
  it("promotes to the strongest winning piece", () => {
    const state = createEngineState("standard", "4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
    expect(chooseBotMove(getEngineSearchPosition(state), deterministicBudget).move).toEqual({
      from: "a7",
      to: "a8",
      promotion: "q",
    });
  });
  it("escapes check by capturing the checking queen", () => {
    const state = createEngineState("standard", "4k3/8/8/8/8/8/3q4/3RK3 w - - 0 1");
    const result = chooseBotMove(getEngineSearchPosition(state), deterministicBudget);
    expect(result.move.to).toBe("d2");
    expect(inspectEngine(applyEngineMove(state, result.move)).inCheck).toBe(false);
  });

  it("does not sacrifice its queen for a pawn defended by another pawn", () => {
    const state = createEngineState("standard", "4k3/8/8/4p3/5p1Q/8/8/4K3 w - - 0 1");
    const result = chooseBotMove(getEngineSearchPosition(state), {
      ...deterministicBudget,
      maxDepth: 1,
    });
    expect(result.move).not.toEqual({ from: "h4", to: "f4" });
    expect(inspectEngine(state).legalMoves).toContainEqual(result.move);
  });
  it("keeps every exact action/type probability in bounded chance samples", () => {
    const snapshot = getEngineSearchPosition(createEngineState("chaos-cat"));
    const choices = searchChanceChoices(
      prepareSearchMove(createSearchPosition(snapshot), { from: "e2", to: "e4" }),
    );
    const sampled = sampleChanceChoices(choices, 1, "held-out-seed");
    expect(sampled.length).toBeLessThanOrEqual(10);
    expect(sampled.reduce((sum, item) => sum + item.probability, 0)).toBeCloseTo(1, 12);
    for (const action of ["add", "remove"])
      for (const piece of ["p", "r", "b", "n", "q"]) {
        const mass = (items: typeof choices) =>
          items
            .filter((item) => item.action === action && item.piece === piece)
            .reduce((sum, item) => sum + item.probability, 0);
        expect(mass(sampled)).toBeCloseTo(mass(choices), 12);
      }
    expect(sampleChanceChoices(choices, 1, "held-out-seed")).toEqual(sampled);
  });
  it("never continues after a terminal result", () => {
    const state = createEngineState("standard", "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1");
    expect(() => chooseBotMove(getEngineSearchPosition(state), deterministicBudget)).toThrow(
      "no legal move",
    );
  });

  it("keeps a rare king-exposing theft at its true probability", () => {
    const sampled = sampleChanceChoices(
      [
        { action: "remove", piece: "p", square: "e2", probability: 0.01, kingExposure: true },
        { action: "remove", piece: "p", square: "a3", probability: 0.01 },
        { action: "remove", piece: "p", square: "b3", probability: 0.01 },
        { action: "none", piece: "p", probability: 0.97 },
      ],
      1,
      "rare-shield",
    );
    expect(sampled.find((choice) => choice.square === "e2")?.probability).toBe(0.01);
    expect(
      sampled.filter((choice) => choice.action === "remove" && !choice.kingExposure),
    ).toHaveLength(1);
    expect(sampled.reduce((sum, choice) => sum + choice.probability, 0)).toBeCloseTo(1, 12);
  });

  it("moves its king out of a dangerous rook file instead of trusting its shield", () => {
    const state = createEngineState("chaos-cat", "k3r3/8/8/8/8/8/PPPPPPPP/4K3 w - - 0 1");
    const result = chooseBotMove(getEngineSearchPosition(state), {
      ...deterministicBudget,
      maxDepth: 1,
    });
    expect(result.move.from).toBe("e1");
    expect(["d1", "f1"]).toContain(result.move.to);
  });
  it("observes a wall clock deadline without exhausting all nodes", () => {
    let clock = 0;
    const result = chooseBotMove(getEngineSearchPosition(createEngineState("chaos-cat")), {
      thinkMs: 5,
      maxNodes: 5000,
      now: () => clock++,
    });
    expect(result.exhausted).toBe(true);
    expect(result.nodes).toBeLessThan(10);
    expect(inspectEngine(createEngineState("chaos-cat")).legalMoves).toContainEqual(result.move);
  });
});
