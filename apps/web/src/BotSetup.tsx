import {
  BOT_PROFILES,
  type BotProfile,
  type CatchessSettings,
  type CreateBotGame,
  RULESETS,
  type RulesetId,
} from "@chess-room/contracts";
import { useState } from "react";
import { ChaosCatRules } from "./ChaosCatRules";
import { catChanceLabel } from "./catPresentation";

export function BotSetup({
  onCreate,
  pending,
}: {
  onCreate: (settings: CreateBotGame) => Promise<void>;
  pending: boolean;
}) {
  const [rulesetId, setRules] = useState<RulesetId>("catchess");
  const [color, setColor] = useState<"random" | "white" | "black">("random");
  const [profile, setProfile] = useState<BotProfile>("strong");
  const [cats, setCats] = useState<CatchessSettings>({ host: 25, guest: 25 });
  return (
    <form
      id="bot-setup"
      aria-label="Set up a Cat Bot game"
      onSubmit={(event) => {
        event.preventDefault();
        void onCreate({
          rulesetId,
          color,
          profile,
          ...(rulesetId === "catchess" ? { catchess: cats } : {}),
        });
      }}
    >
      <p className="field-hint">
        A private, untimed game against Cat Bot. Thinking runs on your device and pauses when this
        tab is hidden. Your game is saved so you can return.
      </p>
      <fieldset disabled={pending}>
        <legend>Choose your game</legend>
        <div className="form-field">
          <label htmlFor="bot-mode">Game mode</label>
          <select
            id="bot-mode"
            value={rulesetId}
            onChange={(event) => setRules(event.target.value as RulesetId)}
          >
            {RULESETS.map((mode) => (
              <option value={mode.id} key={mode.id}>
                {mode.label}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="bot-color">Your pieces</label>
          <select
            id="bot-color"
            value={color}
            onChange={(event) => setColor(event.target.value as typeof color)}
          >
            <option value="random">Surprise me</option>
            <option value="white">White</option>
            <option value="black">Black</option>
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="bot-profile">Cat’s thinking</label>
          <select
            id="bot-profile"
            value={profile}
            onChange={(event) => setProfile(event.target.value as BotProfile)}
          >
            {Object.entries(BOT_PROFILES).map(([id, item]) => (
              <option value={id} key={id}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <p className="field-hint">
          Strong spends a little longer searching. Smaller devices automatically use a lighter
          budget. These are casual games, without ratings.
        </p>
        {rulesetId === "catchess" && (
          <fieldset className="catchess-settings">
            <legend>Meet the cats</legend>
            {(["host", "guest"] as const).map((player) => (
              <div className="cat-slider" key={player}>
                <label htmlFor={`bot-cat-${player}`}>
                  {player === "host" ? "Your cat" : "Cat Bot’s cat"}
                </label>
                <output htmlFor={`bot-cat-${player}`}>{catChanceLabel(cats[player])}</output>
                <input
                  id={`bot-cat-${player}`}
                  type="range"
                  min={-100}
                  max={100}
                  value={cats[player]}
                  aria-valuetext={catChanceLabel(cats[player])}
                  onChange={(event) => setCats({ ...cats, [player]: Number(event.target.value) })}
                />
                <p className="field-hint">
                  Helpful adds a pawn; evil removes one; zero switches it off.
                </p>
              </div>
            ))}
          </fieldset>
        )}
      </fieldset>
      {rulesetId === "chaos-cat" && <ChaosCatRules />}
      <button className="button button--primary button--wide" type="submit" disabled={pending}>
        {pending ? "Setting the board…" : "Play the cat"}
      </button>
    </form>
  );
}
