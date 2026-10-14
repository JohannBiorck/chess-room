import type {
  BoardPiece,
  CatEffect,
  GameOutcome,
  MoveInput,
  PublicGame,
} from "@chess-room/contracts";

import { previewMove } from "./movePreview";

export type SoundCue =
  | "move"
  | "capture"
  | "castle"
  | "promotion"
  | "check"
  | "result"
  | "cat-add"
  | "cat-remove";
export type MovingPiece = {
  from: string;
  to: string;
  piece: BoardPiece;
  promotion?: BoardPiece["type"];
};
export type MoveTransition = {
  moving: MovingPiece[];
  captured: BoardPiece[];
  boardAfterMove: BoardPiece[];
  castle: boolean;
};
export type PresentationEvent = {
  id: string;
  gameId: string;
  revision: number;
  ply: number;
  createdAt: number;
  cue: SoundCue;
  outcome: GameOutcome | null;
} & (
  | {
      kind: "move";
      move: MoveInput;
      movementId: string;
      transition: MoveTransition;
      cat: CatEffect | null;
    }
  | { kind: "result" }
);
export type PresentationUpdate = { reset: boolean; events: PresentationEvent[] };
type PresentationGame = Pick<PublicGame, "id" | "revision" | "phase" | "outcome" | "position">;

export function movementId(gameId: string, ply: number, move: MoveInput): string {
  return `${gameId}:${ply}:${move.from}:${move.to}:${move.promotion ?? ""}`;
}

export function moveTransition(
  board: BoardPiece[],
  legalMoves: MoveInput[],
  move: MoveInput,
): MoveTransition | null {
  const boardAfterMove = previewMove(board, legalMoves, move);
  const piece = board.find((entry) => entry.square === move.from);
  if (!boardAfterMove || !piece) return null;
  const castle =
    piece.type === "k" && Math.abs(move.from.charCodeAt(0) - move.to.charCodeAt(0)) === 2;
  const moving: MovingPiece[] = [
    {
      from: move.from,
      to: move.to,
      piece,
      ...(move.promotion ? { promotion: move.promotion } : {}),
    },
  ];
  if (castle) {
    const kingSide = move.to[0] === "g";
    const rookFrom = `${kingSide ? "h" : "a"}${move.from[1]}`;
    const rook = board.find((entry) => entry.square === rookFrom);
    if (!rook) return null;
    moving.push({ from: rookFrom, to: `${kingSide ? "f" : "d"}${move.from[1]}`, piece: rook });
  }
  const captured = board.filter(
    (entry) =>
      !moving.some((actor) => actor.from === entry.square) &&
      !boardAfterMove.some(
        (remaining) =>
          remaining.square === entry.square &&
          remaining.color === entry.color &&
          remaining.type === entry.type,
      ),
  );
  return { moving, captured, boardAfterMove, castle };
}

function sameMove(a: MoveInput, b: MoveInput): boolean {
  return a.from === b.from && a.to === b.to && a.promotion === b.promotion;
}

function matchesAfterCat(
  transition: MoveTransition,
  cat: CatEffect | null,
  board: BoardPiece[],
): boolean {
  let expected = transition.boardAfterMove;
  if (cat?.action === "add" && cat.square) {
    if (expected.some((piece) => piece.square === cat.square)) return false;
    expected = [...expected, { square: cat.square, color: cat.color, type: cat.piece ?? "p" }];
  }
  if (cat?.action === "remove" && cat.square) {
    if (
      !expected.some(
        (piece) =>
          piece.square === cat.square &&
          piece.color === cat.color &&
          piece.type === (cat.piece ?? "p"),
      )
    )
      return false;
    expected = expected.filter((piece) => piece.square !== cat.square);
  }
  return (
    expected.length === board.length &&
    expected.every((piece) =>
      board.some(
        (entry) =>
          entry.square === piece.square && entry.type === piece.type && entry.color === piece.color,
      ),
    )
  );
}

// Only current, committed deliveries can cause sensory effects. Recovery is a
// snapshot replacement, so missed turns never become an animation/audio backlog.
export function presentationUpdate(
  previous: PresentationGame | null,
  next: PresentationGame,
  live: boolean,
  visible: boolean,
  createdAt: number,
): PresentationUpdate {
  if (!previous || previous.id !== next.id || !live || !visible) return { reset: true, events: [] };
  if (next.revision <= previous.revision) return { reset: false, events: [] };
  const previousMoves = previous.position.moves;
  const moves = next.position.moves;
  const commonHistory = previousMoves.every((move, index) => {
    const candidate = moves[index];
    return (
      candidate !== undefined &&
      sameMove(move, candidate) &&
      move.color === candidate.color &&
      move.ply === candidate.ply &&
      move.san === candidate.san
    );
  });
  if (
    !commonHistory ||
    moves.length < previousMoves.length ||
    moves.length > previousMoves.length + 1
  )
    return { reset: true, events: [] };
  const newlyFinished =
    previous.phase !== "finished" && next.phase === "finished" && next.outcome !== null;
  const base = {
    gameId: next.id,
    revision: next.revision,
    ply: moves.length,
    createdAt,
    outcome: newlyFinished ? next.outcome : null,
  };
  if (moves.length === previousMoves.length) {
    return {
      reset: false,
      events: newlyFinished
        ? [{ ...base, id: `${next.id}:result:${next.revision}`, kind: "result", cue: "result" }]
        : [],
    };
  }
  const move = moves.at(-1);
  if (!move) return { reset: true, events: [] };
  const transition = moveTransition(previous.position.board, previous.position.legalMoves, move);
  const cat = next.position.catEffects?.find((effect) => effect.ply === move.ply) ?? null;
  if (!transition || !matchesAfterCat(transition, cat, next.position.board))
    return { reset: true, events: [] };
  const exposed =
    next.position.threatenedKings?.some(
      (color) => !previous.position.threatenedKings?.includes(color),
    ) ?? false;
  const cue: SoundCue = newlyFinished
    ? "result"
    : next.position.inCheck || exposed
      ? "check"
      : move.promotion
        ? "promotion"
        : transition.captured.length > 0
          ? "capture"
          : transition.castle
            ? "castle"
            : "move";
  return {
    reset: false,
    events: [
      {
        ...base,
        id: `${next.id}:${move.ply}:move`,
        kind: "move",
        move,
        movementId: movementId(next.id, move.ply, move),
        transition,
        cat,
        cue,
      },
    ],
  };
}

export function catCue(event: PresentationEvent): SoundCue | null {
  return event.kind === "move" && event.cat?.square && event.cat.action !== "none"
    ? event.cat.action === "add"
      ? "cat-add"
      : "cat-remove"
    : null;
}
