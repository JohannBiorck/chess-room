import { createHash } from "node:crypto";
import type { CatEffect, Color } from "@chess-room/contracts";
import { Chess, SQUARES, type Square } from "chess.js";

/** Only positions derived from validated initial state may use variant pawn ranks. */
export function derivedCatchessPosition(fen: string): Chess {
  return new Chess(fen, { skipValidation: true });
}

function uniform(draw: string, purpose: "chance" | "target", size: number): number {
  const range = 2 ** 32;
  const limit = range - (range % size);
  // Rejection sampling avoids bias for percentages and uneven candidate counts.
  for (let counter = 0; counter < 128; counter += 1) {
    const value = createHash("sha256")
      .update(`Catchess/v1/${purpose}/${counter}/`)
      .update(Buffer.from(draw, "hex"))
      .digest()
      .readUInt32BE(0);
    if (value < limit) return value % size;
  }
  throw new Error("The random draw could not be sampled within its resource bound.");
}

function mutatedPosition(chess: Chess, square: Square, mover: Color, action: "add" | "remove") {
  const originalFen = chess.fen({ forceEnpassantSquare: true });
  const candidate = derivedCatchessPosition(originalFen);
  const own = mover === "white" ? "w" : "b";
  if (action === "add") candidate.put({ type: "p", color: own }, square);
  else candidate.remove(square);
  const king = candidate.findPiece({ type: "k", color: own })[0];
  if (!king || candidate.isAttacked(king, own === "w" ? "b" : "w")) return null;
  // Keep the last move's en-passant opportunity unless its victim disappears
  // or its destination becomes occupied. Library put/remove can clear unrelated
  // rights, and a cat pawn on the old starting square does not undo a double push.
  const fields = candidate.fen({ forceEnpassantSquare: true }).split(" ");
  const originalEp = originalFen.split(" ")[3];
  if (originalEp && originalEp !== "-") {
    const victimSquare = `${originalEp[0]}${mover === "white" ? 4 : 5}` as Square;
    const victim = candidate.get(victimSquare);
    fields[3] =
      !candidate.get(originalEp as Square) && victim?.type === "p" && victim.color === own
        ? originalEp
        : "-";
  }
  // A pawn effect restarts the no-pawn-change counter.
  fields[4] = "0";
  return derivedCatchessPosition(fields.join(" "));
}

export function applyCatEffect(
  chess: Chess,
  mover: Color,
  chance: number,
  draw: string,
  ply: number,
): { chess: Chess; effect: CatEffect } {
  const skipped: CatEffect = { ply, color: mover, action: "none" };
  if (chance === 0 || uniform(draw, "chance", 100) >= Math.abs(chance)) {
    return {
      chess: derivedCatchessPosition(chess.fen({ forceEnpassantSquare: true })),
      effect: skipped,
    };
  }
  const action = chance > 0 ? "add" : "remove";
  const candidates = SQUARES.filter((square) => {
    const piece = chess.get(square);
    if (action === "remove")
      return piece?.type === "p" && piece.color === (mover === "white" ? "w" : "b");
    const rank = Number(square[1]);
    return !piece && (mover === "white" ? rank <= 4 : rank >= 5);
  }).sort();
  const safe = candidates.flatMap((square) => {
    const position = mutatedPosition(chess, square, mover, action);
    return position ? [{ square, chess: position }] : [];
  });
  if (safe.length === 0) {
    return {
      chess: derivedCatchessPosition(chess.fen({ forceEnpassantSquare: true })),
      effect: skipped,
    };
  }
  const selected = safe[uniform(draw, "target", safe.length)];
  if (!selected) throw new Error("The cat target is invalid.");
  return { chess: selected.chess, effect: { ply, color: mover, action, square: selected.square } };
}
