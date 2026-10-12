import { displayNameSchema, type OpenRoom, RULESETS, TIME_CONTROLS } from "@chess-room/contracts";
import { useEffect, useRef, useState } from "react";
import { catChanceLabel } from "./catPresentation";
import { ArrowIcon } from "./Icons";
import { Modal } from "./Modal";

export function OpenRooms({
  rooms,
  loading,
  error,
  busy,
  displayName,
  hasSession,
  onDisplayName,
  onRefresh,
  onJoin,
}: {
  rooms: OpenRoom[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  displayName: string;
  hasSession: boolean;
  onDisplayName: (name: string) => void;
  onRefresh: () => Promise<void>;
  onJoin: (name: string, roomId: string) => Promise<void>;
}) {
  const [joining, setJoining] = useState<OpenRoom | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (joining) nameInput.current?.focus();
  }, [joining]);

  function join(room: OpenRoom) {
    if (busy) return;
    if (hasSession && displayNameSchema.safeParse(displayName).success) {
      void onJoin(displayName.trim(), room.id);
    } else {
      setNameError(null);
      setJoining(room);
    }
  }

  return (
    <section className="open-rooms" aria-labelledby="open-rooms-heading">
      <div className="open-rooms-heading">
        <div>
          <p className="eyebrow">THERE’S A SEAT FOR YOU</p>
          <h2 id="open-rooms-heading">Open rooms</h2>
          <p>Find an opponent. No invitation needed.</p>
        </div>
        <button
          type="button"
          className="button button--small"
          onClick={() => void onRefresh()}
          disabled={loading || busy}
          aria-label="Refresh open rooms"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {error && (
        <p className="open-rooms-message field-error" role="alert">
          {error} Refresh to try again.
        </p>
      )}
      {rooms.length > 0 ? (
        <ul className="open-room-list" aria-busy={loading}>
          {rooms.map((room) => {
            const color = room.host.color === "white" ? "black" : "white";
            return (
              <li className="open-room-card" key={room.id}>
                <div className="open-room-host">
                  <span className="avatar open-room-avatar" aria-hidden="true">
                    {room.host.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <h3>{room.host.displayName}</h3>
                    <span className="open-room-subtitle">Waiting for an opponent</span>
                  </div>
                </div>
                <dl className="open-room-details">
                  <div>
                    <dt>Mode</dt>
                    <dd>{RULESETS.find((rule) => rule.id === room.rulesetId)?.label}</dd>
                  </div>
                  <div>
                    <dt>Time</dt>
                    <dd>{TIME_CONTROLS[room.timeControl].label}</dd>
                  </div>
                  <div>
                    <dt>Your pieces</dt>
                    <dd>{color === "white" ? "White" : "Black"}</dd>
                  </div>
                  {room.catchess && (
                    <>
                      <div>
                        <dt>Your cat</dt>
                        <dd>{catChanceLabel(room.catchess[color])}</dd>
                      </div>
                      <div>
                        <dt>Host’s cat</dt>
                        <dd>{catChanceLabel(room.catchess[room.host.color])}</dd>
                      </div>
                    </>
                  )}
                </dl>
                <button
                  type="button"
                  className="button button--primary button--wide open-room-join"
                  onClick={() => join(room)}
                  disabled={busy}
                  aria-label={`Join ${room.host.displayName}’s room`}
                >
                  Join room <ArrowIcon />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="open-rooms-empty" role="status">
          <span className="little-dot" aria-hidden="true" />
          {loading
            ? "Looking for open rooms…"
            : error
              ? "Open rooms are temporarily unavailable."
              : "No open rooms right now. Create one below and welcome the next player."}
        </div>
      )}
      <p className="field-hint open-rooms-note">
        Rooms disappear when someone joins or they expire. The first player to join takes the seat.
      </p>
      {joining && (
        <Modal title="Join open room" onClose={() => setJoining(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const result = displayNameSchema.safeParse(displayName);
              if (!result.success) {
                setNameError("Use 1–32 characters, without control characters.");
                nameInput.current?.focus();
                return;
              }
              setJoining(null);
              void onJoin(result.data, joining.id);
            }}
          >
            <p>
              Choose a name and take the seat across from{" "}
              <strong>{joining.host.displayName}</strong>. Your name will be shown to your opponent.
            </p>
            <div className="form-field">
              <label htmlFor="open-room-name">Display name to join</label>
              <input
                id="open-room-name"
                ref={nameInput}
                value={displayName}
                onChange={(event) => onDisplayName(event.target.value)}
                maxLength={32}
                autoComplete="nickname"
                required
                aria-invalid={nameError !== null}
                aria-describedby={nameError ? "open-name-error" : undefined}
              />
              {nameError && (
                <span className="field-error" id="open-name-error" role="alert">
                  {nameError}
                </span>
              )}
            </div>
            <div className="button-row">
              <button
                type="button"
                className="button button--quiet"
                onClick={() => setJoining(null)}
              >
                Cancel
              </button>
              <button type="submit" className="button button--primary" disabled={busy}>
                Join room
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
