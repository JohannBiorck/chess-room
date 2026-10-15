import { describe, expect, it } from "vitest";
import type { PresentationEvent } from "./presentationEvents";
import {
  botPresentationEndsAt,
  CAT_PAW_MS,
  CAT_VISIT_MS,
  catVisitStartsAt,
  MOVE_ANIMATION_MS,
} from "./presentationTiming";

const turn: PresentationEvent = {
  kind: "move",
  id: "game:1:move",
  gameId: "game",
  revision: 2,
  ply: 1,
  createdAt: 1000,
  cue: "move",
  outcome: null,
  move: { from: "e2", to: "e4" },
  movementId: "game:1:e2:e4:",
  transition: { moving: [], captured: [], boardAfterMove: [], castle: false },
  cat: { ply: 1, action: "add", color: "white", square: "c3" },
};

describe("piece and cat chronology", () => {
  it("gives an opponent's slide time to finish before a distinct cat entrance and paw action", () => {
    const startsAt = catVisitStartsAt(turn.createdAt);
    expect(MOVE_ANIMATION_MS).toBeGreaterThanOrEqual(350);
    expect(startsAt).toBeGreaterThan(turn.createdAt + MOVE_ANIMATION_MS);
    expect(CAT_PAW_MS).toBeGreaterThan(800);
    expect(CAT_VISIT_MS).toBeGreaterThan(CAT_PAW_MS + 800);
  });
  it("preserves the optimistic slide's original start after fast or delayed confirmation", () => {
    const early = catVisitStartsAt(1100, 1000);
    const late = catVisitStartsAt(2000, 1000);
    expect(early).toBeLessThan(catVisitStartsAt(1100));
    expect(early).toBeGreaterThan(1000 + MOVE_ANIMATION_MS);
    expect(late).toBeGreaterThan(2000);
    expect(late).toBeLessThan(2000 + MOVE_ANIMATION_MS);
  });
  it("paces a completed bot proposal until the live gift/theft has visibly finished", () => {
    const until = botPresentationEndsAt(turn, false);
    expect(until).toBeGreaterThan(catVisitStartsAt(turn.createdAt) + CAT_PAW_MS);
    expect(until).toBeLessThan(turn.createdAt + 3000);
    expect(
      botPresentationEndsAt(
        { ...turn, cat: { ply: 1, color: "white", square: "c3", action: "remove" } },
        false,
      ),
    ).toBe(until);
    expect(botPresentationEndsAt({ ...turn, cat: null }, false)).toBeLessThan(until);
  });
  it("adds no computer pacing to reduced motion, hydration or a non-move result", () => {
    expect(botPresentationEndsAt(turn, true)).toBe(0);
    expect(botPresentationEndsAt(undefined, false)).toBe(0);
    expect(
      botPresentationEndsAt(
        {
          kind: "result",
          id: "result",
          gameId: "game",
          revision: 3,
          ply: 1,
          createdAt: 2000,
          outcome: { winner: "black", reason: "resignation" },
          cue: "result",
        },
        false,
      ),
    ).toBe(0);
  });
});
