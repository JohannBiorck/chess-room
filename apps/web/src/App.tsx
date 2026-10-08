import { GameRoom } from "./GameRoom";
import { Lobby } from "./Lobby";
import { Piece } from "./Piece";
import { useChessRoom } from "./useChessRoom";

export function App() {
  const room = useChessRoom();

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
              <Piece type="n" color="black" />
            </span>
            Chess Room<span className="brand-period">.</span>
          </a>
          <div className="header-meta">
            <span className="header-caption">A game between friends</span>
            {room.session && <span className="session-chip">{room.session.displayName}</span>}
          </div>
        </header>
        {room.error && (
          <div className="notice notice--error" role="alert">
            <div>
              <strong>We couldn’t complete that request</strong>
              <p>{room.error}</p>
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
              <button
                type="button"
                className="icon-button"
                aria-label="Dismiss error"
                onClick={room.clearError}
              >
                ×
              </button>
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
            <h1>Setting your table…</h1>
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
          />
        )}
        <footer className="site-footer">
          <span className="footer-brand">Chess Room</span>
          <p>Private rooms. Shared moments. One more game.</p>
          <span>STANDARD · THREE-CHECK · CATCHESS</span>
        </footer>
      </div>
    </>
  );
}
