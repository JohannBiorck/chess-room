import { createHash } from "node:crypto";
import type { CatEffect, Color } from "@chess-room/contracts";
import type { Chess } from "chess.js";
import { catTargets, derivedCatPosition, mutateCatPosition } from "./cat-mutations.js";

/** Only positions derived from validated initial state may use variant pawn ranks. */
export const derivedCatchessPosition = derivedCatPosition;

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
  const candidates = catTargets(chess, mover, action, "p").sort();
  const safe = candidates.flatMap((square) => {
    const position = mutateCatPosition(chess, square, mover, action, "p", true);
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
