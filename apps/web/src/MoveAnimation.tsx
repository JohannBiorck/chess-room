import type { Color } from "@chess-room/contracts";
import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";

import { catSquarePosition } from "./catPresentation";
import { Piece } from "./Piece";
import type { MoveTransition } from "./presentationEvents";
import { usePageVisibility, useReducedMotion } from "./presentationPreferences";

export type BoardMovement = { id: string; transition: MoveTransition; createdAt: number };
export const MOVE_ANIMATION_MS = 180;

export function useMoveAnimation(movement: BoardMovement | null, layoutKey: string) {
  const reduced = useReducedMotion();
  const visible = usePageVisibility();
  const [active, setActive] = useState<BoardMovement | null>(null);
  const seen = useRef<string | null>(null);
  const layout = useRef(layoutKey);
  const id = movement?.id;
  const movementRef = useRef(movement);
  movementRef.current = movement;
  useLayoutEffect(() => {
    void id;
    const candidate = movementRef.current;
    const layoutChanged = layout.current !== layoutKey;
    layout.current = layoutKey;
    if (!candidate || reduced || !visible || layoutChanged) {
      setActive(null);
      if (candidate) seen.current = candidate.id;
      return;
    }
    if (seen.current === candidate.id) return;
    seen.current = candidate.id;
    if (performance.now() - candidate.createdAt >= 1500) {
      setActive(null);
      return;
    }
    setActive(candidate);
    const timer = window.setTimeout(() => setActive(null), MOVE_ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [id, layoutKey, reduced, visible]);
  return reduced || !visible ? null : active;
}

export function MoveAnimation({
  movement,
  orientation,
}: {
  movement: BoardMovement;
  orientation: Color;
}) {
  return (
    <div className="move-layer" aria-hidden="true" data-move-animation={movement.id}>
      {movement.transition.captured.map((piece) => {
        const point = catSquarePosition(piece.square, orientation);
        return (
          <span
            key={piece.square}
            className="move-captured-piece"
            style={{ left: `${point.left}%`, top: `${point.top}%` }}
          >
            <Piece type={piece.type} color={piece.color} />
          </span>
        );
      })}
      {movement.transition.moving.map((actor) => {
        const from = catSquarePosition(actor.from, orientation);
        const to = catSquarePosition(actor.to, orientation);
        const style = {
          left: `${from.left}%`,
          top: `${from.top}%`,
          "--move-x": `${(to.column - from.column) * 100}%`,
          "--move-y": `${(to.row - from.row) * 100}%`,
          "--move-duration": `${MOVE_ANIMATION_MS}ms`,
        } as CSSProperties;
        return (
          <span
            key={actor.from}
            className={`move-travelling-piece${actor.promotion ? " move-travelling-piece--promotion" : ""}`}
            style={style}
          >
            <span className="move-original-piece">
              <Piece type={actor.piece.type} color={actor.piece.color} />
            </span>
            {actor.promotion && (
              <span className="move-promoted-piece">
                <Piece type={actor.promotion} color={actor.piece.color} />
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
