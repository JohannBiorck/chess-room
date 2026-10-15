import type { CatEffect, Color } from "@chess-room/contracts";
import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";

import { Cat } from "./Cat";
import { catEffectAnnouncement, catSquarePosition } from "./catPresentation";
import { Piece } from "./Piece";
import { usePageVisibility, useReducedMotion } from "./presentationPreferences";
import { CAT_EXIT_MS, CAT_PAW_MS, CAT_VISIT_MS } from "./presentationTiming";

export function useCatVisit(
  gameId: string,
  effects: CatEffect[],
  latestPly?: number,
  layoutKey = "",
  startsAt = 0,
) {
  const seen = useRef(new Set<number>());
  const currentGame = useRef(gameId);
  const currentLayout = useRef(layoutKey);
  const [scheduled, setScheduled] = useState<{ effect: CatEffect; startsAt: number } | null>(null);
  const [phase, setPhase] = useState<"waiting" | "arrive" | "paw" | "exit">("waiting");
  const [announcement, setAnnouncement] = useState("");
  const reduced = useReducedMotion();
  const visible = usePageVisibility();

  useLayoutEffect(() => {
    if (currentGame.current !== gameId) {
      currentGame.current = gameId;
      seen.current.clear();
      setScheduled(null);
    }
    const fresh = effects.filter((effect) => !seen.current.has(effect.ply));
    for (const effect of fresh) seen.current.add(effect.ply);
    const latest = fresh.at(-1);
    if (latest) setAnnouncement(catEffectAnnouncement(latest));
    const layoutChanged = currentLayout.current !== layoutKey;
    currentLayout.current = layoutKey;
    if (reduced || !visible || effects.length === 0 || layoutChanged) {
      setScheduled(null);
      return;
    }
    if (scheduled && latestPly !== undefined && scheduled.effect.ply !== latestPly)
      setScheduled(null);
    const candidate = fresh.findLast(
      (effect) =>
        effect.action !== "none" &&
        effect.square !== undefined &&
        (latestPly === undefined || effect.ply === latestPly),
    );
    if (candidate) {
      setPhase("waiting");
      setScheduled({ effect: candidate, startsAt });
    }
  }, [scheduled, effects, gameId, latestPly, layoutKey, startsAt, reduced, visible]);

  useLayoutEffect(() => {
    if (!scheduled) return;
    const delay = Math.max(0, scheduled.startsAt - performance.now());
    setPhase(delay > 0 ? "waiting" : "arrive");
    const arrive = window.setTimeout(() => setPhase("arrive"), delay);
    const paw = window.setTimeout(() => setPhase("paw"), delay + CAT_PAW_MS);
    const exit = window.setTimeout(() => setPhase("exit"), delay + CAT_EXIT_MS);
    const complete = window.setTimeout(() => setScheduled(null), delay + CAT_VISIT_MS);
    return () => {
      window.clearTimeout(arrive);
      window.clearTimeout(paw);
      window.clearTimeout(exit);
      window.clearTimeout(complete);
    };
  }, [scheduled]);

  return {
    effect: scheduled?.effect ?? null,
    active: phase === "waiting" ? null : (scheduled?.effect ?? null),
    phase,
    announcement,
  };
}

export function CatVisit({
  effect,
  orientation,
  showPiece,
  phase,
}: {
  effect: CatEffect;
  orientation: Color;
  showPiece: boolean;
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
    "--cat-visit-duration": `${CAT_VISIT_MS}ms`,
  } as CSSProperties;
  return (
    <div className="cat-layer" aria-hidden="true">
      <div
        className="cat-target"
        style={style}
        data-cat-ply={effect.ply}
        data-cat-square={effect.square}
        data-cat-action={effect.action}
        data-cat-piece={effect.piece ?? "p"}
        data-cat-phase={phase}
        data-cat-edge={ownEdge ? "bottom" : "top"}
      >
        <span className="cat-square-glow" />
        {showPiece && (
          <span
            className={`cat-action-piece cat-action-piece--${effect.action} cat-action-pawn cat-action-pawn--${effect.action}`}
          >
            <Piece type={effect.piece ?? "p"} color={effect.color} />
          </span>
        )}
        <div className="cat-travel">
          <div className="cat-sprite">
            <Cat
              color={effect.color}
              evil={effect.action === "remove"}
              chaos={effect.piece !== undefined}
            />
          </div>
        </div>
        <span className="cat-action-spark" />
      </div>
    </div>
  );
}
