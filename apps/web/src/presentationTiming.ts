import type { PresentationEvent } from "./presentationEvents";

export const MOVE_ANIMATION_MS = 420;
export const CAT_START_GAP_MS = 100;
export const CAT_VISIT_MS = 2200;
export const CAT_PAW_MS = 1050;
export const CAT_EXIT_MS = 1600;

export function catVisitStartsAt(confirmedAt: number, movementStartedAt = confirmedAt) {
  return Math.max(confirmedAt, movementStartedAt + MOVE_ANIMATION_MS) + CAT_START_GAP_MS;
}

export function botPresentationEndsAt(event: PresentationEvent | undefined, reduced: boolean) {
  if (reduced || event?.kind !== "move") return 0;
  return event.cat?.square && event.cat.action !== "none"
    ? catVisitStartsAt(event.createdAt) + CAT_VISIT_MS
    : event.createdAt + MOVE_ANIMATION_MS;
}
