import type { BoardPiece, MoveInput } from "@chess-room/contracts";

export type PendingMove = {
  gameId: string;
  revision: number;
  move: MoveInput;
  board: BoardPiece[];
};

// Preview only a move already authorized by the server's current legal destinations.
// History, clocks, outcomes and random cat effects wait for the committed update.
export function previewMove(
  board: BoardPiece[],
  legalMoves: MoveInput[],
  move: MoveInput,
): BoardPiece[] | null {
  if (
    !legalMoves.some(
      (legal) =>
        legal.from === move.from && legal.to === move.to && legal.promotion === move.promotion,
    )
  )
    return null;
  const piece = board.find((candidate) => candidate.square === move.from);
  if (!piece) return null;
  const destination = board.find((candidate) => candidate.square === move.to);
  const enPassant = piece.type === "p" && move.from[0] !== move.to[0] && !destination;
  const capturedSquare = enPassant ? `${move.to[0]}${move.from[1]}` : move.to;
  const next = board.filter(
    (candidate) => candidate.square !== move.from && candidate.square !== capturedSquare,
  );
  if (piece.type === "k" && Math.abs(move.to.charCodeAt(0) - move.from.charCodeAt(0)) === 2) {
    const kingside = move.to[0] === "g";
    const rookFrom = `${kingside ? "h" : "a"}${move.from[1]}`;
    const rookTo = `${kingside ? "f" : "d"}${move.from[1]}`;
    const rook = next.find((candidate) => candidate.square === rookFrom);
    if (rook?.type !== "r" || rook.color !== piece.color) return null;
    next.splice(next.indexOf(rook), 1, { ...rook, square: rookTo });
  }
  return [...next, { ...piece, square: move.to, type: move.promotion ?? piece.type }];
}
