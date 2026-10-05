import type { BoardPiece, Color, MoveInput } from "@chess-room/contracts";
import { useEffect, useRef, useState } from "react";

import { Piece, pieceNames } from "./Piece";

export function boardSquares(orientation: Color): string[] {
  const files = orientation === "white" ? "abcdefgh" : "hgfedcba";
  const ranks = orientation === "white" ? "87654321" : "12345678";
  return [...ranks].flatMap((rank) => [...files].map((file) => `${file}${rank}`));
}

export function keyboardSquare(index: number, key: string, control = false): number {
  const row = Math.floor(index / 8);
  const column = index % 8;
  switch (key) {
    case "ArrowLeft":
      return row * 8 + Math.max(0, column - 1);
    case "ArrowRight":
      return row * 8 + Math.min(7, column + 1);
    case "ArrowUp":
      return Math.max(0, row - 1) * 8 + column;
    case "ArrowDown":
      return Math.min(7, row + 1) * 8 + column;
    case "Home":
      return control ? 0 : row * 8;
    case "End":
      return control ? 63 : row * 8 + 7;
    default:
      return index;
  }
}

type BoardProps = {
  board: BoardPiece[];
  legalMoves: MoveInput[];
  orientation: Color;
  seat: Color | null;
  turn: Color;
  inCheck: boolean;
  canMove: boolean;
  busy: boolean;
  revision: number;
  lastMove?: MoveInput;
  onMove: (moves: MoveInput[]) => void;
};

export function Board({
  board,
  legalMoves,
  orientation,
  seat,
  turn,
  inCheck,
  canMove,
  busy,
  revision,
  lastMove,
  onMove,
}: BoardProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [focused, setFocused] = useState(56);
  const boardRef = useRef<HTMLTableElement>(null);
  const squares = boardSquares(orientation);
  const bySquare = new Map(board.map((piece) => [piece.square, piece]));
  const available = selected && canMove ? legalMoves.filter((move) => move.from === selected) : [];

  useEffect(() => {
    void revision;
    setSelected(null);
  }, [revision]);

  function select(square: string) {
    if (!canMove || busy) return;
    if (selected === square) {
      setSelected(null);
      return;
    }
    const moves = available.filter((move) => move.to === square);
    if (moves.length > 0) {
      onMove(moves);
      setSelected(null);
      return;
    }
    const piece = bySquare.get(square);
    setSelected(piece?.color === seat ? square : null);
  }

  return (
    <>
      <table
        className="chessboard"
        aria-label="Chess board"
        aria-describedby="board-help"
        aria-busy={busy}
        ref={boardRef}
      >
        <tbody>
          {Array.from({ length: 8 }, (_, row) => (
            <tr className="board-row" key={squares[row * 8]}>
              {squares.slice(row * 8, row * 8 + 8).map((square, column) => {
                const piece = bySquare.get(square);
                const index = row * 8 + column;
                const rank = Number(square[1]);
                const file = square.charCodeAt(0) - 97;
                const dark = (rank + file) % 2 === 0;
                const target = available.some((move) => move.to === square);
                const checked = inCheck && piece?.type === "k" && piece.color === turn;
                const last = lastMove?.from === square || lastMove?.to === square;
                const label = `${square}, ${piece ? `${piece.color} ${pieceNames[piece.type]}` : "empty"}${selected === square ? ", selected" : ""}${target ? ", legal destination" : ""}${checked ? ", in check" : ""}`;
                return (
                  <td key={square}>
                    <button
                      type="button"
                      className={`square ${dark ? "square--dark" : "square--light"}${selected === square ? " square--selected" : ""}${target ? " square--target" : ""}${checked ? " square--check" : ""}${last ? " square--last" : ""}`}
                      aria-label={label}
                      aria-pressed={selected === square}
                      aria-disabled={!canMove || busy}
                      tabIndex={index === focused ? 0 : -1}
                      data-index={index}
                      data-square={square}
                      onFocus={() => setFocused(index)}
                      onClick={() => select(square)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setSelected(null);
                        if (
                          [
                            "ArrowLeft",
                            "ArrowRight",
                            "ArrowUp",
                            "ArrowDown",
                            "Home",
                            "End",
                          ].includes(event.key)
                        ) {
                          event.preventDefault();
                          const next = keyboardSquare(index, event.key, event.ctrlKey);
                          setFocused(next);
                          boardRef.current
                            ?.querySelector<HTMLButtonElement>(`[data-index="${next}"]`)
                            ?.focus();
                        }
                      }}
                    >
                      {column === 0 && (
                        <span className="rank-label" aria-hidden="true">
                          {square[1]}
                        </span>
                      )}
                      {row === 7 && (
                        <span className="file-label" aria-hidden="true">
                          {square[0]}
                        </span>
                      )}
                      {piece && <Piece type={piece.type} color={piece.color} />}
                      {target && (
                        <span className={piece ? "capture-hint" : "move-hint"} aria-hidden="true" />
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="board-help" id="board-help">
        Select a piece, then a highlighted square. Use arrow keys to navigate, Enter to select, and
        Escape to clear.
      </p>
      <span className="sr-only" role="status">
        {selected
          ? `${selected} selected. ${new Set(available.map((move) => move.to)).size} legal destinations.`
          : ""}
      </span>
    </>
  );
}
