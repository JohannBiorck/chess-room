import { createHash } from "node:crypto";
import type { CatEffect, CatPiece, Color } from "@chess-room/contracts";
import { type Chess, SQUARES, type Square } from "chess.js";
import { derivedCatchessPosition } from "./catchess.js";

function uniform(draw: string, purpose: "action" | "piece" | "target", size: number): number {
  const range = 2 ** 32;
  const limit = range - (range % size);
  for (let counter = 0; counter < 128; counter += 1) {
    const value = createHash("sha256")
      .update(`ChaosCat/v1/${purpose}/${counter}/`)
      .update(Buffer.from(draw, "hex"))
      .digest()
      .readUInt32BE(0);
    if (value < limit) return value % size;
  }
  throw new Error("The random draw could not be sampled within its resource bound.");
}

const PIECE_BUCKETS: readonly CatPiece[] = ["p", "p", "p", "p", "r", "b", "n", "q"];

export function applyChaosCatEffect(
  chess: Chess,
  mover: Color,
  draw: string,
  ply: number,
): { chess: Chess; effect: CatEffect } {
  const action = uniform(draw, "action", 2) === 0 ? "add" : "remove";
  const piece = PIECE_BUCKETS[uniform(draw, "piece", PIECE_BUCKETS.length)];
  if (!piece) throw new Error("The cat piece is invalid.");
  const own = mover === "white" ? "w" : "b";
  const candidates = SQUARES.filter((square) => {
    const occupant = chess.get(square);
    if (action === "remove") return occupant?.color === own && occupant.type === piece;
    return !occupant && (mover === "white" ? Number(square[1]) <= 4 : Number(square[1]) >= 5);
  }).sort();
  const originalFen = chess.fen({ forceEnpassantSquare: true });
  const candidate = derivedCatchessPosition(originalFen);
  if (candidates.length === 0)
    return { chess: candidate, effect: { ply, color: mover, action: "none", piece } };
  const square = candidates[uniform(draw, "target", candidates.length)];
  if (!square) throw new Error("The cat target is invalid.");
  // No king-safety filter: an unlucky theft can expose the mover's king.
  if (action === "add") candidate.put({ type: piece, color: own }, square);
  else candidate.remove(square);
  const fields = candidate.fen({ forceEnpassantSquare: true }).split(" ");
  // put/remove may clear an unrelated en-passant opportunity. Preserve it only
  // while its just-moved pawn and unoccupied capture square still exist.
  const originalEp = originalFen.split(" ")[3];
  if (originalEp && originalEp !== "-") {
    const victim = candidate.get(`${originalEp[0]}${mover === "white" ? 4 : 5}` as Square);
    fields[3] =
      !candidate.get(originalEp as Square) && victim?.type === "p" && victim.color === own
        ? originalEp
        : "-";
  }
  // A cat-created rook never gains castling rights; stealing the original rook
  // permanently loses its side's right. put/remove already applies that removal.
  fields[4] = "0";
  return {
    chess: derivedCatchessPosition(fields.join(" ")),
    effect: { ply, color: mover, action, piece, square },
  };
}
