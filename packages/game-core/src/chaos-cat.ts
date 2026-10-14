import { createHash } from "node:crypto";
import type { CatEffect, CatPiece, Color } from "@chess-room/contracts";
import type { Chess } from "chess.js";
import { catTargets, mutateCatPosition } from "./cat-mutations.js";
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
  const candidates = catTargets(chess, mover, action, piece).sort();
  const originalFen = chess.fen({ forceEnpassantSquare: true });
  const candidate = derivedCatchessPosition(originalFen);
  if (candidates.length === 0)
    return { chess: candidate, effect: { ply, color: mover, action: "none", piece } };
  const square = candidates[uniform(draw, "target", candidates.length)];
  if (!square) throw new Error("The cat target is invalid.");
  const changed = mutateCatPosition(chess, square, mover, action, piece, false);
  if (!changed) throw new Error("The selected cat mutation is invalid.");
  return {
    chess: changed,
    effect: { ply, color: mover, action, piece, square },
  };
}
