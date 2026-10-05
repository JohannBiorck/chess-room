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

const paths: Record<PieceKind, string> = {
  p: "M30 10a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm-6 16h12l-2 7 5 10H21l5-10-2-7ZM19 46h22v5H19Z",
  r: "M17 12h7v7h4v-7h4v7h4v-7h7v12l-7 5 2 15H22l2-15-7-5V12Zm3 35h20v5H20Z",
  b: "M30 8s-12 10-12 18c0 5 5 8 12 8s12-3 12-8c0-8-12-18-12-18Zm-4 26h8l5 10H21l5-10ZM19 47h22v5H19Z",
  n: "m39 12-4-5-9 6-9 13 3 9 11-8-5 8-5 9h20l-2-15-1-9 1-8ZM19 47h24v5H19Z",
  q: "M14 17a3 3 0 1 0 0 .1Zm8-6a3 3 0 1 0 0 .1Zm8-3a3 3 0 1 0 0 .1Zm8 3a3 3 0 1 0 0 .1Zm8 6a3 3 0 1 0 0 .1ZM15 22l7 6 1-11 7 9 7-9 1 11 7-6-7 18H22l-7-18ZM21 43h18v3H21ZM18 49h24v4H18Z",
  k: "M28 6h4v5h5v4h-5v5h-4v-5h-5v-4h5V6Zm2 18s-7-8-13-4c-7 5-2 14 5 20h16c7-6 12-15 5-20-6-4-13 4-13 4ZM21 43h18v3H21ZM18 49h24v4H18Z",
};

export function Piece({ type, color }: { type: PieceKind; color: PieceColor }) {
  return (
    <svg
      className={`piece piece--${color}`}
      viewBox="0 0 60 60"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[type]} />
      {type === "b" && <path className="piece-detail" d="m26 19 7 9" />}
      {type === "n" && <circle className="piece-eye" cx="32" cy="19" r="1.5" />}
    </svg>
  );
}
