import type { CatEffect, Color } from "@chess-room/contracts";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Cat } from "./Cat";
import { catEffectAnnouncement, catSquarePosition } from "./catPresentation";
import { Piece } from "./Piece";

const VISIT_DURATION_MS = 2800;

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return reduced;
}

export function useCatVisit(gameId: string, effects: CatEffect[]) {
  const seen = useRef(new Set<number>());
  const queue = useRef<CatEffect[]>([]);
  const currentGame = useRef(gameId);
  const [active, setActive] = useState<CatEffect | null>(null);
  const [phase, setPhase] = useState<"arrive" | "paw" | "exit">("arrive");
  const [announcement, setAnnouncement] = useState("");
  const reduced = useReducedMotion();

  useLayoutEffect(() => {
    if (currentGame.current !== gameId) {
      currentGame.current = gameId;
      seen.current.clear();
      queue.current = [];
      setActive(null);
    }
    const fresh = effects.filter((effect) => !seen.current.has(effect.ply));
    for (const effect of fresh) seen.current.add(effect.ply);
    const latest = fresh.at(-1);
    if (latest) setAnnouncement(catEffectAnnouncement(latest));
    if (reduced) {
      queue.current = [];
      setActive(null);
      return;
    }
    // A short bounded queue prevents old effects from obscuring a rapidly advancing game.
    queue.current = [
      ...queue.current,
      ...fresh.filter((effect) => effect.action !== "none" && effect.square !== undefined),
    ].slice(-3);
    if (!active) setActive(queue.current.shift() ?? null);
  }, [active, effects, gameId, reduced]);

  useLayoutEffect(() => {
    if (!active) return;
    setPhase("arrive");
    const paw = window.setTimeout(() => setPhase("paw"), 1400);
    const exit = window.setTimeout(() => setPhase("exit"), 1900);
    const complete = window.setTimeout(() => setActive(null), VISIT_DURATION_MS);
    return () => {
      window.clearTimeout(paw);
      window.clearTimeout(exit);
      window.clearTimeout(complete);
    };
  }, [active]);

  return { active, phase, announcement };
}

export function CatVisit({
  effect,
  orientation,
  showPawn,
  phase,
}: {
  effect: CatEffect;
  orientation: Color;
  showPawn: boolean;
  phase: string;
}) {
  if (!effect.square || effect.action === "none") return null;
  const point = catSquarePosition(effect.square, orientation);
  const ownEdge = effect.color === orientation;
  const style = {
    left: `${point.left}%`,
    top: `${point.top}%`,
    "--cat-start-y": `${(ownEdge ? 8 - point.row : -(point.row + 1)) * 100}%`,
    "--cat-start-x": point.column < 4 ? "-25%" : "25%",
    "--cat-facing": point.column < 4 ? 1 : -1,
    "--cat-visit-duration": `${VISIT_DURATION_MS}ms`,
  } as CSSProperties;
  return (
    <div className="cat-layer" aria-hidden="true">
      <div
        className="cat-target"
        style={style}
        data-cat-ply={effect.ply}
        data-cat-square={effect.square}
        data-cat-action={effect.action}
        data-cat-phase={phase}
        data-cat-edge={ownEdge ? "bottom" : "top"}
      >
        <span className="cat-square-glow" />
        {showPawn && (
          <span className={`cat-action-pawn cat-action-pawn--${effect.action}`}>
            <Piece type="p" color={effect.color} />
          </span>
        )}
        <div className="cat-travel">
          <div className="cat-sprite">
            <Cat color={effect.color} evil={effect.action === "remove"} />
          </div>
        </div>
        <span className="cat-action-spark" />
      </div>
    </div>
  );
}
