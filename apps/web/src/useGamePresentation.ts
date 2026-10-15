import { useEffect, useRef, useState } from "react";

import type { PresentationEvent } from "./presentationEvents";
import {
  usePageVisibility,
  usePresentationPreferences,
  useReducedMotion,
} from "./presentationPreferences";
import { presentationAudio } from "./presentationSound";
import { CAT_PAW_MS } from "./presentationTiming";

export function useGamePresentation(gameId: string, events: PresentationEvent[], catStartsAt = 0) {
  const preferences = usePresentationPreferences();
  const reduced = useReducedMotion();
  const visible = usePageVisibility();
  const [resultEmphasis, setResultEmphasis] = useState(false);
  const seenResult = useRef<string | null>(null);
  const audio = presentationAudio();

  useEffect(() => {
    audio.setVolume(preferences.volume);
  }, [audio, preferences.volume]);
  useEffect(() => {
    if (!preferences.sound) audio.mute();
  }, [audio, preferences.sound]);
  useEffect(() => {
    if (!visible) audio.pause();
    else audio.resumeIfActivated();
  }, [audio, visible]);
  useEffect(() => {
    void gameId;
    return () => audio.cancel();
  }, [audio, gameId]);
  useEffect(() => {
    if (events.length === 0) {
      audio.cancel();
      return;
    }
    const event = events.at(-1);
    if (event?.gameId === gameId && performance.now() - event.createdAt < 1500)
      audio.present(event, reduced ? 0 : Math.max(0, catStartsAt - performance.now()) + CAT_PAW_MS);
  }, [audio, events, gameId, catStartsAt, reduced]);

  useEffect(() => {
    setResultEmphasis(false);
    const event = events.at(-1);
    if (
      !event?.outcome ||
      event.gameId !== gameId ||
      seenResult.current === event.id ||
      !visible ||
      reduced ||
      performance.now() - event.createdAt >= 1500
    )
      return;
    seenResult.current = event.id;
    setResultEmphasis(true);
    const timer = window.setTimeout(() => setResultEmphasis(false), 450);
    return () => window.clearTimeout(timer);
  }, [events, gameId, reduced, visible]);
  return { reduced, visible, resultEmphasis };
}
