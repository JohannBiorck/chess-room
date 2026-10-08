import type { BoardPiece, MoveInput } from "@chess-room/contracts";
import { describe, expect, it } from "vitest";
import { previewMove } from "./movePreview";

function piece(square: string, type: BoardPiece["type"], color: BoardPiece["color"]): BoardPiece {
  return { square, type, color };
}

function preview(board: BoardPiece[], move: MoveInput) {
  return previewMove(board, [move], move);
}

describe("pending move board", () => {
  it("moves immediately without mutating the confirmed board and replaces a captured piece", () => {
    const board = [piece("c4", "b", "white"), piece("f7", "p", "black"), piece("g8", "k", "black")];
    const original = structuredClone(board);
    expect(preview(board, { from: "c4", to: "f7" })).toEqual([
      piece("g8", "k", "black"),
      piece("f7", "b", "white"),
    ]);
    expect(board).toEqual(original);
  });

  it("requires the complete server-provided legal move, including promotion", () => {
    const board = [piece("e7", "p", "white")];
    expect(
      previewMove(board, [{ from: "e7", to: "e8", promotion: "n" }], { from: "e7", to: "e8" }),
    ).toBeNull();
    expect(previewMove(board, [], { from: "e7", to: "e8", promotion: "n" })).toBeNull();
    expect(preview(board, { from: "e7", to: "e8", promotion: "n" })).toEqual([
      piece("e8", "n", "white"),
    ]);
  });

  it.each([
    ["white", "e1", "g1", "h1", "f1"],
    ["black", "e8", "c8", "a8", "d8"],
  ] as const)(
    "moves the %s castling rook together with the king",
    (color, from, to, rookFrom, rookTo) => {
      const board = [piece(from, "k", color), piece(rookFrom, "r", color)];
      expect(preview(board, { from, to })).toEqual([
        piece(rookTo, "r", color),
        piece(to, "k", color),
      ]);
      expect(board[1]?.square).toBe(rookFrom);
    },
  );

  it.each([
    ["white", "e5", "d6", "d5", "black"],
    ["black", "d4", "e3", "e4", "white"],
  ] as const)("removes the captured en-passant pawn for %s", (color, from, to, victim, other) => {
    expect(preview([piece(from, "p", color), piece(victim, "p", other)], { from, to })).toEqual([
      piece(to, "p", color),
    ]);
  });
});
