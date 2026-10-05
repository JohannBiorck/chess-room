import { type CreateGame, RULESETS, type SessionView, TIME_CONTROLS } from "@chess-room/contracts";
import { useState } from "react";

import { ArrowIcon, LinkIcon, ShieldIcon } from "./Icons";
import { Piece, type PieceKind } from "./Piece";

type LobbyProps = {
  session: SessionView | null;
  initialInvitation: string;
  busy: boolean;
  canResume: boolean;
  onResume: () => Promise<void>;
  onCreate: (name: string, settings: CreateGame) => Promise<void>;
  onJoin: (name: string, invitation: string) => Promise<void>;
};

function TableIllustration() {
  const backRank: PieceKind[] = ["r", "n", "b", "q", "k", "b", "n", "r"];
  return (
    <div className="table-illustration" aria-hidden="true">
      <div className="illustration-caption">
        <span className="little-dot" /> A seat for you. A seat for a friend.
      </div>
      <div className="illustration-board">
        {Array.from({ length: 64 }, (_, index) => {
          const row = Math.floor(index / 8);
          const column = index % 8;
          const type =
            row === 0 || row === 7 ? backRank[column] : row === 1 || row === 6 ? "p" : null;
          return (
            <span
              className={`illustration-square ${(row + column) % 2 ? "illustration-square--dark" : ""}`}
              key={`${row}-${column}`}
            >
              {type && <Piece type={type} color={row < 2 ? "black" : "white"} />}
            </span>
          );
        })}
      </div>
      <div className="illustration-note">
        <span>01 / STANDARD &amp; THREE-CHECK</span>
        <span>YOUR NEXT MOVE</span>
      </div>
    </div>
  );
}

export function Lobby({
  session,
  initialInvitation,
  busy,
  canResume,
  onResume,
  onCreate,
  onJoin,
}: LobbyProps) {
  const [displayName, setDisplayName] = useState(session?.displayName ?? "");
  const [settings, setSettings] = useState<CreateGame>({
    rulesetId: "standard",
    timeControl: "untimed",
    color: "random",
  });
  const [invite, setInvite] = useState(initialInvitation);
  const [tab, setTab] = useState<"create" | "join">(initialInvitation ? "join" : "create");
  const rules = RULESETS.find((entry) => entry.id === settings.rulesetId);

  return (
    <main id="main" tabIndex={-1} className="lobby">
      <section className="lobby-intro" aria-labelledby="page-heading">
        <div>
          <p className="eyebrow">
            <span className="little-dot" /> PLAY TOGETHER, WHEREVER YOU ARE
          </p>
          <h1 id="page-heading">
            Good company.
            <br />
            Great chess.
          </h1>
          <p className="introduction">
            A private board for you and a friend. Share a link, take your seats, and make your next
            move.
          </p>
          <div className="hero-details">
            <span>
              <LinkIcon /> Invitation links
            </span>
            <span>
              <ShieldIcon /> No account needed
            </span>
          </div>
        </div>
        <TableIllustration />
      </section>

      <section className="lobby-controls" aria-labelledby="room-heading">
        <div className="room-description">
          <p className="eyebrow">YOUR ROOM, YOUR GAME</p>
          <h2 id="room-heading">Pull up a chair.</h2>
          <p>
            Keep it classic or try a new challenge. Every move is checked, and your game stays with
            you when you reconnect.
          </p>
          <div className="small-rule">
            <span>01</span>
            <div>
              <h3>Make a room</h3>
              <p>Choose your rules and your pace.</p>
            </div>
          </div>
          <div className="small-rule">
            <span>02</span>
            <div>
              <h3>Invite your friend</h3>
              <p>One private link. Two players.</p>
            </div>
          </div>
          <div className="small-rule">
            <span>03</span>
            <div>
              <h3>Meet at the board</h3>
              <p>Make the first move and enjoy the game.</p>
            </div>
          </div>
        </div>
        <div className="lobby-card">
          {canResume && (
            <div className="resume-room">
              <span>Your last room is saved.</span>
              <button
                type="button"
                className="button button--quiet button--small"
                onClick={() => void onResume()}
                disabled={busy}
              >
                Return to previous room <ArrowIcon />
              </button>
            </div>
          )}
          <fieldset className="room-tabs">
            <legend className="sr-only">Choose how to play</legend>
            <button
              type="button"
              className={tab === "create" ? "room-tab room-tab--active" : "room-tab"}
              aria-pressed={tab === "create"}
              onClick={() => setTab("create")}
            >
              Create a room
            </button>
            <button
              type="button"
              className={tab === "join" ? "room-tab room-tab--active" : "room-tab"}
              aria-pressed={tab === "join"}
              onClick={() => setTab("join")}
            >
              Join a friend
            </button>
          </fieldset>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (tab === "create") void onCreate(displayName.trim(), settings);
              else void onJoin(displayName.trim(), invite);
            }}
          >
            {session ? (
              <div className="guest-identity">
                <span className="avatar">{session.displayName.slice(0, 1).toUpperCase()}</span>
                <div>
                  <span className="field-label">PLAYING AS</span>
                  <strong>{session.displayName}</strong>
                </div>
                <span className="guest-badge">Guest</span>
              </div>
            ) : (
              <div className="form-field">
                <label htmlFor="display-name">Your display name</label>
                <input
                  id="display-name"
                  name="displayName"
                  placeholder="What should your friend call you?"
                  autoComplete="nickname"
                  maxLength={32}
                  required
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  disabled={busy}
                />
                <span className="field-hint">
                  Your guest seat stays in this browser. Keep its cookies to return.
                </span>
              </div>
            )}
            {tab === "create" ? (
              <>
                <fieldset className="mode-field">
                  <legend>Game mode</legend>
                  <div className="mode-options">
                    {RULESETS.map((mode) => (
                      <label
                        className={
                          settings.rulesetId === mode.id
                            ? "mode-option mode-option--selected"
                            : "mode-option"
                        }
                        key={mode.id}
                      >
                        <input
                          type="radio"
                          name="ruleset"
                          value={mode.id}
                          checked={settings.rulesetId === mode.id}
                          onChange={() => setSettings({ ...settings, rulesetId: mode.id })}
                          disabled={busy}
                        />
                        <span className="mode-piece">
                          <Piece type={mode.id === "standard" ? "k" : "n"} color="black" />
                        </span>
                        <span>
                          <strong>{mode.label}</strong>
                          <small>
                            {mode.id === "standard"
                              ? "The game you know"
                              : "Three checks. A new challenge."}
                          </small>
                        </span>
                      </label>
                    ))}
                  </div>
                  <p className="field-hint">{rules?.description}</p>
                </fieldset>
                <div className="form-row">
                  <div className="form-field">
                    <label htmlFor="time-control">Time control</label>
                    <select
                      id="time-control"
                      value={settings.timeControl}
                      disabled={busy}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          timeControl: event.target.value as CreateGame["timeControl"],
                        })
                      }
                    >
                      {Object.entries(TIME_CONTROLS).map(([value, control]) => (
                        <option value={value} key={value}>
                          {control.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-field">
                    <label htmlFor="color">Your pieces</label>
                    <select
                      id="color"
                      value={settings.color}
                      disabled={busy}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          color: event.target.value as CreateGame["color"],
                        })
                      }
                    >
                      <option value="random">Random</option>
                      <option value="white">White</option>
                      <option value="black">Black</option>
                    </select>
                  </div>
                </div>
                <button
                  type="submit"
                  className="button button--primary button--wide"
                  disabled={busy}
                >
                  {busy ? "Creating your room…" : "Create private room"}
                  <ArrowIcon />
                </button>
                <p className="form-note">
                  Only someone with your invitation can take the other seat.
                </p>
              </>
            ) : (
              <>
                <div className="form-field">
                  <label htmlFor="invitation">Invitation link or code</label>
                  <textarea
                    id="invitation"
                    name="invitation"
                    rows={3}
                    placeholder="Paste the invitation your friend shared"
                    required
                    value={invite}
                    onChange={(event) => setInvite(event.target.value)}
                    disabled={busy}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <span className="field-hint">
                    Invitations are private, expire, and can claim one seat.
                  </span>
                </div>
                <button
                  type="submit"
                  className="button button--primary button--wide"
                  disabled={busy}
                >
                  {busy ? "Joining your friend…" : "Join private room"}
                  <ArrowIcon />
                </button>
              </>
            )}
          </form>
        </div>
      </section>
    </main>
  );
}
