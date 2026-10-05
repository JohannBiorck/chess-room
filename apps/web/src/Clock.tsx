import type { Color, PublicClocks } from "@chess-room/contracts";
import { useEffect, useState } from "react";

export function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function Clock({
  color,
  clocks,
  receivedAt,
  active,
}: {
  color: Color;
  clocks: PublicClocks | null;
  receivedAt: number;
  active: boolean;
}) {
  const [now, setNow] = useState(performance.now());
  const running = active && clocks?.runningColor === color;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(performance.now()), 200);
    return () => window.clearInterval(timer);
  }, [running]);
  let remaining: number | null = null;
  if (clocks) {
    remaining = color === "white" ? clocks.whiteMs : clocks.blackMs;
    if (clocks.runningColor === color && clocks.turnStartedAt !== null) {
      const elapsed =
        Math.max(0, clocks.serverNow - clocks.turnStartedAt) + Math.max(0, now - receivedAt);
      remaining = Math.max(0, remaining - elapsed);
    }
  }
  return (
    <div
      role="timer"
      aria-live="off"
      className={`clock${running ? " clock--active" : ""}${remaining !== null && remaining <= 10_000 ? " clock--low" : ""}`}
      aria-label={`${color} remaining time: ${remaining === null ? "untimed" : formatClock(remaining)}`}
    >
      {remaining === null ? (
        <>
          <span className="untimed-symbol" aria-hidden="true">
            ∞
          </span>
          <span className="untimed-label">Untimed</span>
        </>
      ) : (
        formatClock(remaining)
      )}
    </div>
  );
}
