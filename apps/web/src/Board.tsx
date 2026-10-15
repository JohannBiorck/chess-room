import type { BoardPiece, CatEffect, Color, MoveInput } from "@chess-room/contracts";
import { useEffect, useRef, useState } from "react";
import { CatVisit, useCatVisit } from "./CatVisit";
import { type BoardMovement, MoveAnimation, useMoveAnimation } from "./MoveAnimation";
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
  gameId: string;
  catEffects: CatEffect[];
  latestPly: number;
  board: BoardPiece[];
  legalMoves: MoveInput[];
  orientation: Color;
  seat: Color | null;
  turn: Color;
  inCheck: boolean;
  kingCapture: boolean;
  threatenedKings: Color[];
  canMove: boolean;
  busy: boolean;
  revision: number;
  lastMove?: MoveInput;
  movement?: BoardMovement | null;
  catStartsAt?: number;
  onMove: (moves: MoveInput[]) => void;
};

export function Board({
  gameId,
  catEffects,
  latestPly,
  board,
  legalMoves,
  orientation,
  seat,
  turn,
  inCheck,
  kingCapture,
  threatenedKings,
  canMove,
  busy,
  revision,
  lastMove,
  movement = null,
  catStartsAt = 0,
  onMove,
}: BoardProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [focused, setFocused] = useState(56);
  const boardRef = useRef<HTMLTableElement>(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const squares = boardSquares(orientation);
  const bySquare = new Map(board.map((piece) => [piece.square, piece]));
  const available = selected && canMove ? legalMoves.filter((move) => move.from === selected) : [];
  const layoutKey = `${gameId}:${orientation}:${layoutEpoch}`;
  const moveAnimation = useMoveAnimation(movement, layoutKey);
  const visit = useCatVisit(gameId, catEffects, latestPly, layoutKey, catStartsAt);
  const effect = visit.effect;
  const targetPiece = effect?.square ? bySquare.get(effect.square) : undefined;
  const depictsCurrentPosition = effect !== null && effect.ply === latestPly;
  const hideArrivingPiece =
    depictsCurrentPosition && effect?.action === "add" && visit.phase !== "exit";

  useEffect(() => {
    void revision;
    setSelected(null);
  }, [revision]);

  useEffect(() => {
    const board = boardRef.current;
    if (!board || typeof ResizeObserver === "undefined") return;
    let width = board.clientWidth;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined && Math.abs(next - width) > 1) {
        width = next;
        setLayoutEpoch((epoch) => epoch + 1);
      }
    });
    observer.observe(board);
    return () => observer.disconnect();
  }, []);

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
      <div
        className="board-stage"
        data-cat-sequence-phase={effect ? visit.phase : undefined}
        data-cat-sequence-square={effect?.square}
        data-cat-sequence-action={effect?.action}
      >
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
                  // Labels and legal actions always use the authoritative board;
                  // a stolen piece stays visible until the cat reaches it.
                  const departingPiece =
                    depictsCurrentPosition &&
                    effect?.action === "remove" &&
                    visit.phase === "waiting" &&
                    effect.square === square &&
                    !piece
                      ? { type: effect.piece ?? "p", color: effect.color }
                      : null;
                  const visualPiece = piece ?? departingPiece;
                  const index = row * 8 + column;
                  const rank = Number(square[1]);
                  const file = square.charCodeAt(0) - 97;
                  const dark = (rank + file) % 2 === 0;
                  const target = available.some((move) => move.to === square);
                  const checked =
                    piece?.type === "k" &&
                    (kingCapture
                      ? threatenedKings.includes(piece.color)
                      : inCheck && piece.color === turn);
                  const last = lastMove?.from === square || lastMove?.to === square;
                  const pendingPiece =
                    hideArrivingPiece &&
                    square === effect?.square &&
                    piece?.type === (effect?.piece ?? "p") &&
                    piece.color === effect.color;
                  const travellingPiece = moveAnimation?.transition.moving.some(
                    (actor) =>
                      actor.to === square &&
                      visualPiece?.color === actor.piece.color &&
                      visualPiece?.type === (actor.promotion ?? actor.piece.type),
                  );
                  const label = `${square}, ${piece ? `${piece.color} ${pieceNames[piece.type]}` : "empty"}${selected === square ? ", selected" : ""}${target ? ", legal destination" : ""}${checked ? (kingCapture ? ", king exposed" : ", in check") : ""}`;
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
                        {visualPiece && (
                          <span
                            className={
                              pendingPiece
                                ? "board-piece board-piece--cat-arrival"
                                : travellingPiece
                                  ? "board-piece board-piece--travelling"
                                  : departingPiece
                                    ? "board-piece board-piece--cat-departure"
                                    : "board-piece"
                            }
                          >
                            <Piece type={visualPiece.type} color={visualPiece.color} />
                          </span>
                        )}
                        {target && (
                          <span
                            className={piece ? "capture-hint" : "move-hint"}
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {moveAnimation && (
          <MoveAnimation
            key={moveAnimation.id}
            movement={moveAnimation}
            orientation={orientation}
          />
        )}
        {visit.active && effect && (
          <CatVisit
            key={`${gameId}:${effect.ply}`}
            effect={effect}
            orientation={orientation}
            phase={visit.phase}
            showPiece={
              depictsCurrentPosition &&
              (effect.action === "remove"
                ? targetPiece === undefined
                : targetPiece?.type === (effect.piece ?? "p") && targetPiece.color === effect.color)
            }
          />
        )}
      </div>
      <p className="board-help" id="board-help">
        Select a piece, then a highlighted square. Use arrow keys to navigate, Enter to select, and
        Escape to clear.
      </p>
      <span className="sr-only" role="status">
        {selected
          ? `${selected} selected. ${new Set(available.map((move) => move.to)).size} legal destinations.`
          : ""}
      </span>
      <span className="sr-only" role="status">
        {visit.announcement}
      </span>
    </>
  );
}
