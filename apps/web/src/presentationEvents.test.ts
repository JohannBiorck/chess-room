import type { PublicGame } from "@chess-room/contracts";
import {
  applyEngineMove,
  createEngineState,
  type EngineState,
  inspectEngine,
} from "@chess-room/game-core";
import { describe, expect, it } from "vitest";

import { catCue, movementId, presentationUpdate } from "./presentationEvents";

const draw = (seed = 0) => seed.toString(16).padStart(64, "0");
function game(
  state: EngineState,
  revision = state.moves.length,
): Pick<PublicGame, "id" | "revision" | "phase" | "outcome" | "position"> {
  const position = inspectEngine(state);
  return {
    id: "game",
    revision,
    phase: position.outcome ? "finished" : "active",
    outcome: position.outcome,
    position,
  };
}
const live = (before: ReturnType<typeof game>, after: ReturnType<typeof game>) =>
  presentationUpdate(before, after, true, true, 100);

describe("confirmed game presentation", () => {
  it("presents one quiet move and uses the same movement identity as its immediate preview", () => {
    const state = createEngineState();
    const move = { from: "e2", to: "e4" };
    const before = game(state);
    const after = game(applyEngineMove(state, move));
    const event = live(before, after).events[0];
    expect(event).toMatchObject({
      kind: "move",
      cue: "move",
      ply: 1,
      createdAt: 100,
      movementId: movementId(before.id, 1, move),
    });
    if (event?.kind !== "move") throw new Error("Expected movement.");
    expect(event.transition.moving).toEqual([
      { from: "e2", to: "e4", piece: { square: "e2", type: "p", color: "white" } },
    ]);
    expect(event.transition.captured).toEqual([]);
    expect(live(after, after)).toEqual({ reset: false, events: [] });
    expect(live(after, { ...after, revision: 0 }).events).toEqual([]);
  });

  it("does not turn revision-only changes, hydrate, hidden deliveries or missed plies into effects", () => {
    const state = createEngineState();
    const before = game(state);
    const first = applyEngineMove(state, { from: "e2", to: "e4" });
    const after = game(first);
    expect(live(before, { ...before, revision: 1 })).toEqual({ reset: false, events: [] });
    for (const [liveDelivery, visible] of [
      [false, true],
      [true, false],
    ])
      expect(
        presentationUpdate(before, after, liveDelivery ?? false, visible ?? false, 100),
      ).toEqual({ reset: true, events: [] });
    expect(presentationUpdate(null, after, true, true, 100).events).toEqual([]);
    expect(live(before, { ...after, id: "other-game" }).reset).toBe(true);
    expect(live(before, game(applyEngineMove(first, { from: "e7", to: "e5" })))).toEqual({
      reset: true,
      events: [],
    });
    const altered = {
      ...after,
      revision: 2,
      position: {
        ...after.position,
        moves: after.position.moves.map((move) => ({ ...move, san: "changed history" })),
      },
    };
    expect(live(after, altered).reset).toBe(true);
  });

  it.each([
    {
      fen: "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
      move: { from: "e1", to: "g1" },
      cue: "castle",
      captured: [],
      destinations: ["g1", "f1"],
    },
    {
      fen: "7k/8/8/3pP3/8/8/8/K7 w - d6 0 1",
      move: { from: "e5", to: "d6" },
      cue: "capture",
      captured: ["d5"],
      destinations: ["d6"],
    },
    {
      fen: "7k/8/8/3p4/2P5/8/8/K7 w - - 0 1",
      move: { from: "c4", to: "d5" },
      cue: "capture",
      captured: ["d5"],
      destinations: ["d5"],
    },
    {
      fen: "7k/P6r/8/8/8/8/8/K7 w - - 0 1",
      move: { from: "a7", to: "a8", promotion: "n" as const },
      cue: "promotion",
      captured: [],
      destinations: ["a8"],
    },
  ])(
    "depicts a $cue including every actual moving and captured piece",
    ({ fen, move, cue, captured, destinations }) => {
      const state = createEngineState("standard", fen);
      const event = live(game(state), game(applyEngineMove(state, move))).events[0];
      expect(event?.cue).toBe(cue);
      if (event?.kind !== "move") throw new Error("Expected movement.");
      expect(event.transition.captured.map((piece) => piece.square)).toEqual(captured);
      expect(event.transition.moving.map((piece) => piece.to)).toEqual(destinations);
      if (move.promotion) expect(event.transition.moving[0]?.promotion).toBe("n");
    },
  );

  it("uses the committed cat gift rather than inventing or predicting a target", () => {
    const state = createEngineState("catchess", undefined, { white: 100, black: 100 });
    const after = game(applyEngineMove(state, { from: "e2", to: "e4" }, draw()));
    const event = live(game(state), after).events[0];
    if (event?.kind !== "move") throw new Error("Expected movement.");
    expect(event.cat).toEqual(after.position.catEffects?.[0]);
    expect(catCue(event)).toBe("cat-add");
    expect(event.transition.boardAfterMove).toHaveLength(32);
    expect(after.position.board).toHaveLength(33);
    const wrongBoard = {
      ...after,
      position: {
        ...after.position,
        board: after.position.board.filter((piece) => piece.square !== "a1"),
      },
    };
    expect(live(game(state), wrongBoard)).toEqual({ reset: true, events: [] });
  });

  it("prioritizes exposed king then terminal king capture and never sounds a no-op theft", () => {
    const initial = createEngineState("chaos-cat", "k3r3/8/8/8/8/8/P3R3/4K3 w - - 0 1");
    const exposed = applyEngineMove(initial, { from: "a2", to: "a3" }, draw(23));
    const event = live(game(initial), game(exposed)).events[0];
    expect(event?.cue).toBe("check");
    if (!event) throw new Error("Expected exposure.");
    expect(catCue(event)).toBe("cat-remove");
    const terminal = game(applyEngineMove(exposed, { from: "e8", to: "e1" }, draw()));
    const finalEvent = live(game(exposed), terminal).events[0];
    expect(finalEvent).toMatchObject({
      cue: "result",
      outcome: { winner: "black", reason: "king-captured" },
    });
    if (!finalEvent) throw new Error("Expected terminal effect.");
    expect(catCue(finalEvent)).toBeNull();
    const bare = createEngineState("chaos-cat", "7k/8/8/8/8/8/P7/7K w - - 0 1");
    const noOp = live(game(bare), game(applyEngineMove(bare, { from: "a2", to: "a3" }, draw(23))))
      .events[0];
    if (!noOp) throw new Error("Expected actual move.");
    expect(noOp.cue).toBe("move");
    expect(catCue(noOp)).toBeNull();
  });

  it("announces a non-move result once, but never plays it after recovery", () => {
    const before = game(createEngineState());
    const finished = {
      ...before,
      revision: 1,
      phase: "finished" as const,
      outcome: { winner: "black" as const, reason: "resignation" as const },
    };
    expect(live(before, finished).events).toMatchObject([
      { kind: "result", cue: "result", outcome: finished.outcome },
    ]);
    expect(live(finished, { ...finished, revision: 2 }).events).toEqual([]);
    expect(presentationUpdate(before, finished, false, true, 100).events).toEqual([]);
  });
});
