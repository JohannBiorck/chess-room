import type { CatchessSettings as Settings } from "@chess-room/contracts";

import { Cat } from "./Cat";
import { catChanceDescription, catChanceLabel } from "./catPresentation";

export function CatchessSettings({
  value,
  disabled,
  onChange,
}: {
  value: Settings;
  disabled: boolean;
  onChange: (value: Settings) => void;
}) {
  return (
    <fieldset className="catchess-settings">
      <legend>Meet the cats</legend>
      <p className="field-hint">
        Choose each cat independently. Helpful adds your pawn; evil takes one away. Zero switches
        the cat off.
      </p>
      {(["host", "guest"] as const).map((player) => {
        const chance = value[player];
        const id = `cat-chance-${player}`;
        const mood = chance > 0 ? "helpful" : chance < 0 ? "evil" : "off";
        return (
          <div className={`cat-slider cat-slider--${mood}`} key={player}>
            <div className="cat-slider-heading">
              <span className="cat-slider-avatar">
                <Cat evil={chance < 0} color={player === "host" ? "white" : "black"} />
              </span>
              <label htmlFor={id}>{player === "host" ? "Your cat" : "Friend’s cat"}</label>
              <output htmlFor={id} aria-live="polite">
                {catChanceLabel(chance)}
              </output>
            </div>
            <input
              id={id}
              type="range"
              min={-100}
              max={100}
              step={1}
              value={chance}
              onChange={(event) => onChange({ ...value, [player]: Number(event.target.value) })}
              disabled={disabled}
              aria-valuetext={catChanceLabel(chance)}
              aria-describedby={`${id}-description`}
            />
            <div className="cat-slider-scale" aria-hidden="true">
              <span>Evil −100%</span>
              <span>Off</span>
              <span>Helpful +100%</span>
            </div>
            <p className="field-hint" id={`${id}-description`}>
              {catChanceDescription(chance)}
            </p>
          </div>
        );
      })}
    </fieldset>
  );
}
