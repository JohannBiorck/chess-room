import { pieceArtwork } from "./pieces/Classic";

export type PieceKind = "p" | "n" | "b" | "r" | "q" | "k";
export type PieceColor = "white" | "black";

export const pieceNames: Record<PieceKind, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

export function Piece({ type, color }: { type: PieceKind; color: PieceColor }) {
  return (
    <svg
      className={`piece piece--${color}`}
      viewBox="0 0 45 45"
      aria-hidden="true"
      focusable="false"
    >
      {pieceArtwork[color][type]}
    </svg>
  );
}
