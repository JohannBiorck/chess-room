import { useEffect, useState, useSyncExternalStore } from "react";

export type PresentationPreferences = {
  sound: boolean;
  volume: number;
  motion: "system" | "reduced" | "full";
};
export const PRESENTATION_PREFERENCES_KEY = "cat-chess.presentation.v1";
export const DEFAULT_PRESENTATION_PREFERENCES: PresentationPreferences = {
  sound: false,
  volume: 45,
  motion: "system",
};
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function parsePresentationPreferences(value: unknown): PresentationPreferences | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<PresentationPreferences>;
  if (
    typeof candidate.sound !== "boolean" ||
    !Number.isInteger(candidate.volume) ||
    typeof candidate.volume !== "number" ||
    candidate.volume < 0 ||
    candidate.volume > 100 ||
    !["system", "reduced", "full"].includes(candidate.motion ?? "")
  )
    return null;
  return {
    sound: candidate.sound,
    volume: candidate.volume,
    motion: candidate.motion as PresentationPreferences["motion"],
  };
}

export function createPresentationPreferencesStore(storage?: StorageLike) {
  let current = { ...DEFAULT_PRESENTATION_PREFERENCES };
  const listeners = new Set<() => void>();
  try {
    const saved: unknown = JSON.parse(storage?.getItem(PRESENTATION_PREFERENCES_KEY) ?? "null");
    current = parsePresentationPreferences(saved) ?? current;
  } catch {
    // Browsers can deny storage. The current tab still has usable preferences.
  }
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(patch: Partial<PresentationPreferences>) {
      const next = parsePresentationPreferences({ ...current, ...patch });
      if (
        !next ||
        (next.sound === current.sound &&
          next.volume === current.volume &&
          next.motion === current.motion)
      )
        return;
      current = next;
      try {
        storage?.setItem(PRESENTATION_PREFERENCES_KEY, JSON.stringify(current));
      } catch {
        /* In-memory settings remain effective. */
      }
      for (const listener of listeners) listener();
    },
  };
}

let deviceStore: ReturnType<typeof createPresentationPreferencesStore> | undefined;
function store() {
  if (!deviceStore) {
    let storage: StorageLike | undefined;
    try {
      if (typeof window !== "undefined") storage = window.localStorage;
    } catch {
      /* Fall back to the current tab. */
    }
    deviceStore = createPresentationPreferencesStore(storage);
  }
  return deviceStore;
}
export function getPresentationPreferences() {
  return store().getSnapshot();
}
export function updatePresentationPreferences(patch: Partial<PresentationPreferences>) {
  store().update(patch);
}
export function subscribePresentationPreferences(listener: () => void) {
  return store().subscribe(listener);
}

// An account setting can improve continuity, but it cannot turn this device's
// audio on, unlock autoplay, or overwrite an explicit device mute.
export function applyAccountPresentationPreferences(
  patch: Partial<Pick<PresentationPreferences, "volume" | "motion">>,
) {
  const { volume, motion } = patch;
  store().update({
    ...(volume !== undefined ? { volume } : {}),
    ...(motion !== undefined ? { motion } : {}),
  });
}

export function usePresentationPreferences() {
  return useSyncExternalStore(
    subscribePresentationPreferences,
    getPresentationPreferences,
    () => DEFAULT_PRESENTATION_PREFERENCES,
  );
}

export function useReducedMotion() {
  const preferences = usePresentationPreferences();
  const [systemReduced, setSystemReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setSystemReduced(media.matches);
    media.addEventListener("change", change);
    change();
    return () => media.removeEventListener("change", change);
  }, []);
  return systemReduced || preferences.motion === "reduced";
}

export function usePageVisibility() {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  return visible;
}
