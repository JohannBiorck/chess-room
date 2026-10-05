import type { BoardPiece, Color, GameOutcome, RulesetId } from "@chess-room/contracts";

/** Adjudication variants that share standard legal chess movement. */
export interface ChessRulesAdapter {
  readonly id: RulesetId;
  readonly version: 1;
  readonly pgnVariant: string | null;
  extraOutcome(checks: Readonly<Record<Color, number>>): GameOutcome | null;
  repetitionSuffix(checks: Readonly<Record<Color, number>>): string;
  isDeadPosition(pieces: readonly BoardPiece[]): boolean;
  canWinOnTime(pieces: readonly BoardPiece[], side: Color): boolean;
}

function squareColor(square: string): number {
  return (square.charCodeAt(0) - 97 + Number(square[1])) % 2;
}

function nonKings(pieces: readonly BoardPiece[]): BoardPiece[] {
  return pieces.filter((piece) => piece.type !== "k");
}

function standardDeadPosition(board: readonly BoardPiece[]): boolean {
  const pieces = nonKings(board);
  if (pieces.length === 0) return true;
  if (pieces.length === 1) return pieces[0]?.type === "b" || pieces[0]?.type === "n";
  return (
    pieces.every((piece) => piece.type === "b") &&
    pieces.every((piece) => squareColor(piece.square) === squareColor(pieces[0]?.square ?? "a1"))
  );
}

const standard: ChessRulesAdapter = {
  id: "standard",
  version: 1,
  pgnVariant: null,
  extraOutcome: () => null,
  repetitionSuffix: () => "",
  isDeadPosition: standardDeadPosition,
  canWinOnTime(pieces, side) {
    const own = pieces.filter((piece) => piece.color === side && piece.type !== "k");
    if (own.length === 0 || standardDeadPosition(pieces)) return false;
    const opposing = pieces.filter((piece) => piece.color !== side && piece.type !== "k");
    if (opposing.length === 0 && own.length === 1) {
      return own[0]?.type !== "b" && own[0]?.type !== "n";
    }
    // A possible mate can use the opponent's pieces even without a forced win.
    return true;
  },
};

const threeCheck: ChessRulesAdapter = {
  id: "three-check",
  version: 1,
  pgnVariant: "Three-check",
  extraOutcome(checks) {
    if (checks.white >= 3) return { winner: "white", reason: "three-check" };
    if (checks.black >= 3) return { winner: "black", reason: "three-check" };
    return null;
  },
  repetitionSuffix: (checks) => ` ${checks.white}:${checks.black}`,
  // A lone minor piece can still deliver three checks.
  isDeadPosition: (pieces) => nonKings(pieces).length === 0,
  canWinOnTime: (pieces, side) =>
    pieces.some((piece) => piece.color === side && piece.type !== "k"),
};

export const CHESS_RULES_ADAPTERS: Readonly<Record<RulesetId, ChessRulesAdapter>> = {
  standard,
  "three-check": threeCheck,
};
