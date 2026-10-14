import { useId, useSyncExternalStore } from "react";

import {
  updatePresentationPreferences,
  usePresentationPreferences,
} from "./presentationPreferences";
import { presentationAudio } from "./presentationSound";

export function PresentationSettings({ compact = false }: { compact?: boolean }) {
  const preferences = usePresentationPreferences();
  const audio = presentationAudio();
  const status = useSyncExternalStore(audio.subscribe, audio.getSnapshot, () => "muted" as const);
  const id = useId();
  const enabled = preferences.sound && (status === "ready" || status === "starting");
  return (
    <details className={`presentation-settings${compact ? " presentation-settings--compact" : ""}`}>
      <summary>Sound &amp; motion</summary>
      <div className="presentation-settings-body">
        <button
          type="button"
          className="button button--quiet button--small"
          aria-pressed={enabled}
          disabled={status === "unsupported"}
          onClick={() => {
            if (enabled) {
              updatePresentationPreferences({ sound: false });
              audio.mute();
            } else {
              updatePresentationPreferences({ sound: true });
              void audio.enable(preferences.volume);
            }
          }}
        >
          {status === "unsupported" ? "Sound unavailable" : enabled ? "Mute sound" : "Enable sound"}
        </button>
        <p className="field-hint" role="status">
          {status === "unsupported"
            ? "This browser cannot play effects. Your game still works."
            : status === "blocked"
              ? "Sound is paused. Select Enable sound to try again."
              : enabled
                ? "Short effects for moves and cat visits."
                : "Sound stays off until you enable it on this device."}
        </p>
        <label htmlFor={`${id}-volume`}>
          Effect volume <span>{preferences.volume}%</span>
        </label>
        <input
          id={`${id}-volume`}
          type="range"
          min={0}
          max={100}
          step={1}
          value={preferences.volume}
          onChange={(event) => {
            const volume = Number(event.target.value);
            updatePresentationPreferences({ volume });
            audio.setVolume(volume);
          }}
        />
        <button
          type="button"
          className="button button--quiet button--small"
          disabled={status !== "ready" || !preferences.sound || preferences.volume === 0}
          onClick={() => audio.test()}
        >
          Test sound
        </button>
        <label htmlFor={`${id}-motion`}>Animation preference</label>
        <select
          id={`${id}-motion`}
          value={preferences.motion}
          onChange={(event) =>
            updatePresentationPreferences({
              motion: event.target.value as "system" | "reduced" | "full",
            })
          }
        >
          <option value="system">Follow device setting</option>
          <option value="reduced">Reduced motion</option>
          <option value="full">Standard motion</option>
        </select>
        <p className="field-hint">
          Your device’s reduced-motion setting is always respected. Sound and motion are
          independent.
        </p>
      </div>
    </details>
  );
}
