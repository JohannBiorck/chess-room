import type { CatEffect } from "@chess-room/contracts";
import { describe, expect, it } from "vitest";

import {
  catChanceDescription,
  catChanceLabel,
  catEffectAnnouncement,
  catEffectDescription,
  catSquarePosition,
  liveCatEffects,
} from "./catPresentation";

const effects: CatEffect[] = [
  { ply: 1, color: "white", action: "add", square: "c3" },
  { ply: 2, color: "black", action: "none" },
  { ply: 3, color: "white", action: "remove", square: "a2" },
];

describe("Catchess presentation", () => {
  it("announces a later identical cat action as a new move", () => {
    const first: CatEffect = { ply: 1, color: "white", action: "add", square: "c3" };
    const later: CatEffect = { ...first, ply: 5 };
    expect(catEffectDescription(first)).toBe(catEffectDescription(later));
    expect(catEffectAnnouncement(first)).toBe("Move 1: White’s cat added a pawn on c3.");
    expect(catEffectAnnouncement(later)).toBe("Move 5: White’s cat added a pawn on c3.");
  });
  it("describes signed chances and the disabled midpoint truthfully", () => {
    expect(catChanceLabel(100)).toBe("100% helpful");
    expect(catChanceLabel(-100)).toBe("100% evil");
    expect(catChanceLabel(0)).toBe("Off");
    expect(catChanceDescription(-25)).toContain("25% chance");
    expect(catChanceDescription(-25)).toContain("their own pawns");
    expect(catChanceDescription(25)).toContain("their color");
    expect(catChanceDescription(0)).toContain("stays off");
  });

  it("places an effect at the same chess square in either board orientation", () => {
    expect(catSquarePosition("a1", "white")).toEqual({ column: 0, row: 7, left: 0, top: 87.5 });
    expect(catSquarePosition("a1", "black")).toEqual({ column: 7, row: 0, left: 87.5, top: 0 });
    expect(catSquarePosition("c3", "white")).toEqual({ column: 2, row: 5, left: 25, top: 62.5 });
    expect(catSquarePosition("c3", "black")).toEqual({ column: 5, row: 2, left: 62.5, top: 25 });
  });

  it("describes the committed owner, action, and square without claiming a skipped effect happened", () => {
    expect(catEffectDescription(effects[0] as CatEffect)).toBe("White’s cat added a pawn on c3.");
    expect(catEffectDescription(effects[1] as CatEffect)).toBe("Black’s cat made no change.");
    expect(catEffectDescription(effects[2] as CatEffect)).toBe(
      "White’s cat removed a pawn from a2.",
    );
  });

  it("does not animate history on initial load, a snapshot, a reconnect, or a different room", () => {
    expect(liveCatEffects(null, { id: "room", ply: 3 }, effects, true)).toEqual([]);
    expect(liveCatEffects({ id: "room", ply: 1 }, { id: "room", ply: 3 }, effects, false)).toEqual(
      [],
    );
    expect(
      liveCatEffects({ id: "old-room", ply: 0 }, { id: "room", ply: 3 }, effects, true),
    ).toEqual([]);
  });

  it("only queues new applied effects, excluding duplicate acknowledgements and skipped turns", () => {
    expect(liveCatEffects({ id: "room", ply: 1 }, { id: "room", ply: 3 }, effects, true)).toEqual([
      effects[2],
    ]);
    expect(liveCatEffects({ id: "room", ply: 3 }, { id: "room", ply: 3 }, effects, true)).toEqual(
      [],
    );
    expect(liveCatEffects({ id: "room", ply: 0 }, { id: "room", ply: 1 }, effects, true)).toEqual([
      effects[0],
    ]);
  });

  it("queues both players' applied cat actions in move order", () => {
    const bothPlayers: CatEffect[] = [
      { ply: 1, color: "white", action: "add", square: "c3" },
      { ply: 2, color: "black", action: "add", square: "f6" },
      { ply: 3, color: "white", action: "remove", square: "a2" },
      { ply: 4, color: "black", action: "remove", square: "h7" },
    ];
    expect(
      liveCatEffects({ id: "room", ply: 0 }, { id: "room", ply: 4 }, bothPlayers, true),
    ).toEqual(bothPlayers);
    expect(
      liveCatEffects({ id: "room", ply: 2 }, { id: "room", ply: 4 }, bothPlayers, true),
    ).toEqual(bothPlayers.slice(2));
  });
});
