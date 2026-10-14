import type { CatPiece, Color } from "@chess-room/contracts";
import { Chess, SQUARES, type Square } from "chess.js";

/** Only validated game-derived positions may contain variant back-rank pawns. */
export function derivedCatPosition(fen: string): Chess {
  return new Chess(fen, { skipValidation: true });
}

export function catTargets(
  chess: Chess,
  mover: Color,
  action: "add" | "remove",
  piece: CatPiece,
): Square[] {
  const own = mover === "white" ? "w" : "b";
  return SQUARES.filter((square) => {
    const occupant = chess.get(square);
    if (action === "remove") return occupant?.color === own && occupant.type === piece;
    return !occupant && (mover === "white" ? Number(square[1]) <= 4 : Number(square[1]) >= 5);
  });
}

/** Shared by durable random turns and search; entropy selection lives elsewhere. */
export function mutateCatPosition(
  chess: Chess,
  square: Square,
  mover: Color,
  action: "add" | "remove",
  piece: CatPiece,
  requireSafety: boolean,
): Chess | null {
  const originalFen = chess.fen({ forceEnpassantSquare: true });
  const candidate = derivedCatPosition(originalFen);
  const own = mover === "white" ? "w" : "b";
  if (action === "add") candidate.put({ type: piece, color: own }, square);
  else candidate.remove(square);
  if (requireSafety) {
    const king = candidate.findPiece({ type: "k", color: own })[0];
    if (!king || candidate.isAttacked(king, own === "w" ? "b" : "w")) return null;
  }
  const fields = candidate.fen({ forceEnpassantSquare: true }).split(" ");
  const originalEp = originalFen.split(" ")[3];
  if (originalEp && originalEp !== "-") {
    const victim = candidate.get(`${originalEp[0]}${mover === "white" ? 4 : 5}` as Square);
    fields[3] =
      !candidate.get(originalEp as Square) && victim?.type === "p" && victim.color === own
        ? originalEp
        : "-";
  }
  fields[4] = "0";
  return derivedCatPosition(fields.join(" "));
}
