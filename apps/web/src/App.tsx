import { useEffect, useState } from "react";
import { Cat } from "./Cat";
import { DisplayNameEditor } from "./DisplayNameEditor";
import { GameRoom } from "./GameRoom";
import { Lobby } from "./Lobby";
import { useChessRoom } from "./useChessRoom";

export function App() {
  const room = useChessRoom();
  const [editingName, setEditingName] = useState(false);
  const hasSession = room.session !== null;

  useEffect(() => {
    if (!hasSession) setEditingName(false);
  }, [hasSession]);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="page-shell">
        <header className="site-header">
          <a
            className="wordmark"
            href="/"
            onClick={(event) => {
              event.preventDefault();
              if (!room.busy) room.lobby();
            }}
          >
            <span className="brand-piece">
              <Cat />
            </span>
            Cat Chess<span className="brand-period">.</span>
          </a>
          <div className="header-meta">
            <span className="header-caption">A little chess. A little mischief.</span>
            {room.session && (
              <button
                type="button"
                className="session-chip"
                aria-label="Change display name"
                title="Change display name"
                disabled={room.busy || room.loading}
                onClick={() => setEditingName(true)}
              >
                <span className="session-chip-name">{room.session.displayName}</span>
                <svg
                  viewBox="0 0 20 20"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="m12.5 3.5 4 4-8.5 8.5-5 1 1-5 8.5-8.5Z" />
                  <path d="m10.5 5.5 4 4" />
                </svg>
              </button>
            )}
          </div>
        </header>
        {(room.error || room.retry) && (
          <div
            className={room.error ? "notice notice--error" : "notice"}
            role={room.error ? "alert" : "status"}
          >
            <div>
              <strong>
                {room.error
                  ? "We couldn’t complete that request"
                  : "Your command needs confirmation"}
              </strong>
              <p>
                {room.error ??
                  "Your last game command wasn’t acknowledged. Retry uses the same command ID, so it won’t apply twice."}
              </p>
            </div>
            <div className="button-row">
              {room.retry ? (
                <button
                  type="button"
                  className="button button--small"
                  disabled={room.busy}
                  onClick={() => void room.retryCommand()}
                >
                  Retry command
                </button>
              ) : (
                <button
                  type="button"
                  className="button button--small"
                  disabled={room.busy}
                  onClick={() => void room.reconnect()}
                >
                  Reconnect
                </button>
              )}
              {room.error && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Dismiss error"
                  onClick={room.clearError}
                >
                  ×
                </button>
              )}
            </div>
          </div>
        )}
        {room.notice && (
          <div className="notice" role="status">
            <p>{room.notice}</p>
          </div>
        )}
        {room.loading ? (
          <main id="main" className="loading-panel" tabIndex={-1}>
            <span className="loading-ring" aria-hidden="true" />
            <h1>Waking the cats…</h1>
            <p role="status">Connecting to your guest session.</p>
          </main>
        ) : room.view ? (
          <GameRoom
            key={room.view.game.id}
            view={room.view}
            liveCatEffects={room.liveCatEffects}
            pendingMove={room.pendingMove}
            invitation={room.invitation}
            receivedAt={room.receivedAt}
            busy={room.busy}
            commandError={room.error}
            connection={room.connection}
            onCommand={room.command}
            onReconnect={room.reconnect}
            onInvitation={room.renewInvitation}
            onRematch={room.openRematch}
            onLobby={room.lobby}
          />
        ) : (
          <Lobby
            session={room.session}
            initialInvitation={room.initialInvitation}
            canResume={room.hasSavedGame}
            onResume={room.reconnect}
            busy={room.busy}
            onCreate={room.create}
            onJoin={room.join}
            openRooms={room.openRooms}
            roomsLoading={room.roomsLoading}
            roomsError={room.roomsError}
            onRefreshRooms={room.refreshOpenRooms}
            onJoinOpen={room.joinOpen}
          />
        )}
        <footer className="site-footer">
          <span className="footer-brand">Cat Chess</span>
          <p>Good friends. Curious cats. One more move.</p>
          <span>CAT CHESS · CHAOS CAT · CLASSICS</span>
        </footer>
      </div>
      {editingName && room.session && (
        <DisplayNameEditor
          displayName={room.session.displayName}
          busy={room.busy}
          error={room.error}
          onSave={room.rename}
          onClose={() => setEditingName(false)}
        />
      )}
    </>
  );
}
