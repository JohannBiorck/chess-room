import {
  type CatEffect,
  type Color,
  type GameAction,
  type GameOutcome,
  type GameView,
  type MoveInput,
  RULESETS,
  TIME_CONTROLS,
} from "@chess-room/contracts";
import { useEffect, useRef, useState } from "react";

import { invitationUrl } from "./api";
import { Board } from "./Board";
import { Cat } from "./Cat";
import { Clock } from "./Clock";
import { catChanceLabel, catEffectDescription } from "./catPresentation";
import { CopyIcon, FlipIcon, LinkIcon } from "./Icons";
import { Modal } from "./Modal";
import { Piece, pieceNames } from "./Piece";
import type { Invitation } from "./useChessRoom";

const reasonLabels: Record<GameOutcome["reason"], string> = {
  checkmate: "Checkmate",
  stalemate: "Stalemate",
  "dead-position": "Insufficient mating material",
  "three-check": "Three checks delivered",
  "fivefold-repetition": "Fivefold repetition",
  "seventy-five-move": "Seventy-five-move rule",
  "threefold-repetition": "Threefold repetition claimed",
  "fifty-move": "Fifty-move rule claimed",
  resignation: "Resignation",
  agreement: "Draw by agreement",
  timeout: "Time ran out",
  "timeout-insufficient-material": "Time ran out with insufficient mating material",
  "move-limit": "Game move limit reached",
  "session-expired": "Guest sessions expired",
};

type GameRoomProps = {
  view: GameView;
  liveCatEffects: CatEffect[];
  invitation: Invitation | null;
  receivedAt: number;
  busy: boolean;
  connection: "connecting" | "connected" | "reconnecting";
  onCommand: (action: GameAction) => Promise<void>;
  onReconnect: () => Promise<void>;
  onInvitation: () => Promise<void>;
  onRematch: () => Promise<void>;
  onLobby: () => void;
};

export function GameRoom({
  view,
  liveCatEffects,
  invitation,
  receivedAt,
  busy,
  connection,
  onCommand,
  onReconnect,
  onInvitation,
  onRematch,
  onLobby,
}: GameRoomProps) {
  const { game, seat } = view;
  const [orientation, setOrientation] = useState<Color>(seat ?? "white");
  const [now, setNow] = useState(Date.now());
  const [promotion, setPromotion] = useState<MoveInput[] | null>(null);
  const [resigning, setResigning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const history = useRef<HTMLDivElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCopied(false);
    setCopyFailed(false);
    if (!invitation) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, invitation.expiresAt - Date.now()) + 20,
    );
    return () => window.clearTimeout(timer);
  }, [invitation]);

  useEffect(() => {
    if (game.phase !== "active") {
      setPromotion(null);
      setResigning(false);
    }
  }, [game.phase]);

  const movesLength = game.position.moves.length;
  useEffect(() => {
    void movesLength;
    const element = history.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 160)
      element.scrollTop = element.scrollHeight;
  }, [movesLength]);

  const rule = RULESETS.find((entry) => entry.id === game.rulesetId);
  const active = game.phase === "active";
  const finished = game.phase === "finished";
  const yourTurn = active && seat === game.position.turn;
  const canMove = yourTurn && !busy && connection === "connected";
  const opponent: Color = (seat ?? "white") === "white" ? "black" : "white";
  const incomingDraw = active && game.drawOffer !== null && game.drawOffer !== seat;
  const offeredDraw = active && game.drawOffer === seat && seat !== null;
  const ownRematch = seat !== null && game.rematchRequested.includes(seat);
  const incomingRematch = game.rematchRequested.includes(opponent);
  const invitationExpired = invitation !== null && invitation.expiresAt <= now;
  const lastMove = game.position.moves.at(-1);
  const effectsByPly = new Map(
    (game.position.catEffects ?? []).map((effect) => [effect.ply, effect]),
  );
  const status = finished
    ? game.outcome?.winner
      ? `${game.players[game.outcome.winner]?.displayName ?? game.outcome.winner} wins`
      : "Game drawn"
    : game.phase === "waiting"
      ? "Waiting for your friend"
      : yourTurn
        ? "Your move"
        : `${game.players[game.position.turn]?.displayName ?? "Your friend"}’s move`;

  function move(candidates: MoveInput[]) {
    if (candidates.some((candidate) => candidate.promotion !== undefined)) setPromotion(candidates);
    else {
      const candidate = candidates[0];
      if (candidate) void onCommand({ type: "move", ...candidate });
    }
  }

  async function copy() {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitationUrl(invitation.token));
      setCopied(true);
      setCopyFailed(false);
    } catch {
      linkInput.current?.select();
      setCopyFailed(true);
    }
  }

  function player(color: Color) {
    const participant = game.players[color];
    const clockActive = active && game.clocks?.runningColor === color;
    return (
      <div className={`player-bar${clockActive ? " player-bar--active" : ""}`}>
        <div className="player-identity">
          <span className={`player-piece player-piece--${color}`}>
            <Piece type="k" color={color} />
          </span>
          <div>
            <strong>
              {participant?.displayName ?? "Open seat"}
              {color === seat && <span className="you-tag">YOU</span>}
            </strong>
            <span className="player-subtitle">
              {color === "white" ? "White pieces" : "Black pieces"}
              {!participant && " · Invite a friend"}
            </span>
          </div>
        </div>
        <Clock color={color} clocks={game.clocks} receivedAt={receivedAt} active={active} />
      </div>
    );
  }

  return (
    <main id="main" tabIndex={-1} className="game-room">
      <div className="game-heading">
        <div>
          <p className="eyebrow">YOUR PRIVATE TABLE</p>
          <h1>{rule?.label ?? "Chess"}</h1>
        </div>
        <div className="game-heading-actions">
          <span className={`connection connection--${connection}`} role="status">
            <span className="status-dot" />
            {connection === "connected"
              ? "Connected"
              : connection === "connecting"
                ? "Connecting…"
                : "Reconnecting…"}
          </span>
          <button type="button" className="button button--quiet" onClick={onLobby} disabled={busy}>
            Lobby
          </button>
        </div>
      </div>
      {connection === "reconnecting" && (
        <div className="notice notice--connection">
          <div>
            <strong>Reconnecting to your room</strong>
            <p>
              Your game is saved. Clocks continue while disconnected; moves resume when the room
              reconnects.
            </p>
          </div>
          <button
            type="button"
            className="button button--small"
            onClick={() => void onReconnect()}
            disabled={busy}
          >
            Refresh position
          </button>
        </div>
      )}
      <div className="game-layout">
        <section className="board-panel" aria-label="Players and board">
          {player(orientation === "white" ? "black" : "white")}
          <Board
            gameId={game.id}
            catEffects={liveCatEffects}
            latestPly={game.position.moves.length}
            board={game.position.board}
            legalMoves={game.position.legalMoves}
            orientation={orientation}
            seat={seat}
            turn={game.position.turn}
            inCheck={game.position.inCheck}
            canMove={canMove}
            busy={busy}
            revision={game.revision}
            {...(lastMove ? { lastMove } : {})}
            onMove={move}
          />
          {player(orientation)}
          <div className="board-toolbar">
            <span>{TIME_CONTROLS[game.timeControl].label}</span>
            <button
              className="button button--quiet button--small"
              type="button"
              onClick={() => setOrientation(orientation === "white" ? "black" : "white")}
            >
              <FlipIcon /> Flip board
            </button>
          </div>
        </section>
        <aside className="match-panel" aria-label="Game information">
          <section
            className={`game-status${finished ? " game-status--finished" : ""}`}
            aria-labelledby="status-heading"
          >
            <p className="eyebrow">
              {finished
                ? "THE FINAL POSITION"
                : game.phase === "waiting"
                  ? "ROOM IS READY"
                  : busy
                    ? "SENDING YOUR COMMAND"
                    : "AT THE BOARD"}
            </p>
            <h2 id="status-heading" aria-live="polite" aria-atomic="true">
              {status}
            </h2>
            {finished && game.outcome ? (
              <p>{reasonLabels[game.outcome.reason]}</p>
            ) : game.phase === "waiting" ? (
              <p>Send your invitation. The game starts as soon as the other seat is taken.</p>
            ) : (
              <p>
                {game.position.inCheck
                  ? `${game.position.turn === "white" ? "White" : "Black"} is in check. Protect the king.`
                  : yourTurn
                    ? "Select one of your pieces to see its legal moves."
                    : "Take a moment. Your friend is thinking."}
              </p>
            )}
            {game.rulesetId === "three-check" && (
              <fieldset className="check-count">
                <legend className="sr-only">Checks delivered</legend>
                <span>
                  White <strong>{game.position.checks.white} / 3</strong>
                </span>
                <span>
                  Black <strong>{game.position.checks.black} / 3</strong>
                </span>
              </fieldset>
            )}
          </section>
          {game.catchess && (
            <fieldset className="cat-match-settings">
              <legend>Cats at this table</legend>
              {(["white", "black"] as const).map((color) => (
                <div
                  className={`cat-match-setting cat-match-setting--${game.catchess && game.catchess[color] < 0 ? "evil" : "helpful"}`}
                  key={color}
                >
                  <span className="cat-match-avatar">
                    <Cat color={color} evil={(game.catchess?.[color] ?? 0) < 0} />
                  </span>
                  <div>
                    <strong>{color === "white" ? "White’s cat" : "Black’s cat"}</strong>
                    <span>{game.players[color]?.displayName ?? "Open seat"}</span>
                  </div>
                  <span className="cat-chance-value">
                    {catChanceLabel(game.catchess?.[color] ?? 0)}
                  </span>
                </div>
              ))}
              <p className="field-hint">
                After each owner’s move: helpful adds their pawn; evil removes their pawn. No safe
                target means no change.
              </p>
            </fieldset>
          )}
          {game.phase === "waiting" && (
            <section className="invite-panel" aria-labelledby="invite-heading">
              <h3 id="invite-heading">
                <LinkIcon /> Invite your friend
              </h3>
              {invitation && !invitationExpired ? (
                <>
                  <label className="sr-only" htmlFor="invite-link">
                    Private invitation link
                  </label>
                  <input
                    className="invite-input"
                    id="invite-link"
                    readOnly
                    value={invitationUrl(invitation.token)}
                    ref={linkInput}
                    onFocus={(event) => event.target.select()}
                  />
                  <button
                    type="button"
                    className="button button--primary button--wide"
                    onClick={() => void copy()}
                  >
                    <CopyIcon />
                    {copied ? "Link copied" : "Copy invitation link"}
                  </button>
                  <p className="field-hint" role="status">
                    {copyFailed
                      ? "Select the link above and copy it with your keyboard."
                      : `Expires ${new Date(invitation.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}. Only share it with your friend.`}
                  </p>
                </>
              ) : (
                <>
                  <p>
                    {invitationExpired
                      ? "This invitation has expired. Create a fresh link for your friend."
                      : "Create a fresh invitation link to share this room."}
                  </p>
                  <button
                    type="button"
                    className="button button--primary button--wide"
                    disabled={busy}
                    onClick={() => void onInvitation()}
                  >
                    Create invitation link
                    <ArrowForInvitation />
                  </button>
                </>
              )}
            </section>
          )}
          {incomingDraw && (
            <section className="decision-panel" aria-label="Draw offer">
              <h3>Your friend offered a draw</h3>
              <p>Accept to finish this game as a draw, or continue playing.</p>
              <div className="button-row">
                <button
                  type="button"
                  className="button button--primary button--small"
                  disabled={busy}
                  onClick={() => void onCommand({ type: "accept-draw" })}
                >
                  Accept draw
                </button>
                <button
                  type="button"
                  className="button button--small"
                  disabled={busy}
                  onClick={() => void onCommand({ type: "decline-draw" })}
                >
                  Decline
                </button>
              </div>
            </section>
          )}
          {finished && (
            <section className="decision-panel" aria-label="Rematch">
              <h3>One more game?</h3>
              <p>
                {game.rematchGameId
                  ? "Your next board is ready. Colors are swapped for the rematch."
                  : incomingRematch && !ownRematch
                    ? "Your friend is ready for a rematch. Play again with swapped colors."
                    : ownRematch
                      ? "Rematch requested. Waiting for your friend to accept."
                      : "Keep the same rules and time control. Swap colors and start fresh."}
              </p>
              <button
                type="button"
                className="button button--primary button--wide"
                disabled={busy || (ownRematch && !game.rematchGameId)}
                onClick={() =>
                  game.rematchGameId
                    ? void onRematch()
                    : void onCommand({
                        type: incomingRematch ? "accept-rematch" : "request-rematch",
                      })
                }
              >
                {game.rematchGameId
                  ? "Go to rematch"
                  : ownRematch
                    ? "Waiting for your friend…"
                    : incomingRematch
                      ? "Accept rematch"
                      : "Request rematch"}
              </button>
            </section>
          )}
          <section className="history-panel" aria-labelledby="history-heading">
            <div className="panel-heading">
              <h3 id="history-heading">Moves</h3>
              <span>
                {game.position.moves.length} {game.position.moves.length === 1 ? "move" : "moves"}
              </span>
            </div>
            <div className="move-history" ref={history}>
              {game.position.moves.length === 0 ? (
                <p className="history-empty">
                  A fresh board.
                  <br />
                  The story starts with the first move.
                </p>
              ) : (
                <table>
                  <caption className="sr-only">Game move history</caption>
                  <thead className="sr-only">
                    <tr>
                      <th scope="col">Move</th>
                      <th scope="col">White</th>
                      <th scope="col">Black</th>
                    </tr>
                  </thead>
                  <tbody>
                    {game.position.moves
                      .filter((entry) => entry.ply % 2 === 1)
                      .map((entry) => (
                        <tr key={entry.ply}>
                          <th scope="row">{Math.ceil(entry.ply / 2)}.</th>
                          <td className={lastMove?.ply === entry.ply ? "move--latest" : ""}>
                            {entry.san}
                            {effectsByPly.get(entry.ply) && (
                              <small className="cat-history-effect">
                                {catEffectDescription(effectsByPly.get(entry.ply) as CatEffect)}
                              </small>
                            )}
                          </td>
                          <td className={lastMove?.ply === entry.ply + 1 ? "move--latest" : ""}>
                            {game.position.moves[entry.ply]?.san ?? "—"}
                            {effectsByPly.get(entry.ply + 1) && (
                              <small className="cat-history-effect">
                                {catEffectDescription(effectsByPly.get(entry.ply + 1) as CatEffect)}
                              </small>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
          {active && seat && (
            <section className="game-actions" aria-label="Game actions">
              <button
                type="button"
                className="button button--small"
                disabled={busy || offeredDraw || incomingDraw}
                onClick={() => void onCommand({ type: "offer-draw" })}
              >
                {offeredDraw ? "Draw offered" : "Offer draw"}
              </button>
              <button
                type="button"
                className="button button--small button--danger"
                disabled={busy}
                onClick={() => setResigning(true)}
              >
                Resign
              </button>
              {game.position.claimableDraws.length > 0 && yourTurn && (
                <button
                  type="button"
                  className="button button--small button--wide"
                  disabled={busy}
                  onClick={() => void onCommand({ type: "claim-draw" })}
                >
                  Claim{" "}
                  {game.position.claimableDraws.includes("threefold-repetition")
                    ? "repetition"
                    : "fifty-move"}{" "}
                  draw
                </button>
              )}
            </section>
          )}
          <details className="rules-details">
            <summary>About these rules</summary>
            <p>{rule?.description}</p>
            {game.rulesetId === "catchess" && (
              <p>
                Helpful cats add an own pawn to a safe, empty square on their half of the board:
                ranks 1–4 for White and 5–8 for Black. Evil cats remove one of their owner’s pawns.
                The signed chances are fixed for this game; each committed action is recorded in
                history and never rerolled by reconnecting.
              </p>
            )}
            <p>
              Threefold repetition and fifty-move draws require a claim on your turn. Fivefold
              repetition and seventy-five-move draws are automatic. Clocks continue during
              disconnections and service interruptions.
            </p>
            <p>
              Guest seats belong to this browser’s cookie. A display name cannot recover a lost
              seat.
            </p>
          </details>
        </aside>
      </div>
      {promotion && (
        <Modal title="Choose your promotion" onClose={() => setPromotion(null)}>
          <p>Your pawn has reached the final rank. Choose its new piece.</p>
          <div className="promotion-options">
            {(["q", "r", "b", "n"] as const).map((type) => {
              const candidate = promotion.find((entry) => entry.promotion === type);
              return (
                <button
                  key={type}
                  type="button"
                  className="promotion-choice"
                  disabled={!candidate || busy}
                  onClick={() => {
                    if (candidate) {
                      setPromotion(null);
                      void onCommand({ type: "move", ...candidate });
                    }
                  }}
                >
                  <Piece type={type} color={seat ?? "white"} />
                  <span>{pieceNames[type]}</span>
                </button>
              );
            })}
          </div>
          <button type="button" className="button button--wide" onClick={() => setPromotion(null)}>
            Cancel
          </button>
        </Modal>
      )}
      {resigning && (
        <Modal title="Resign this game?" onClose={() => setResigning(false)}>
          <p>Your friend will win this game. You can still request a rematch afterwards.</p>
          <div className="button-row">
            <button
              className="button button--danger"
              type="button"
              onClick={() => {
                setResigning(false);
                void onCommand({ type: "resign" });
              }}
              disabled={busy}
            >
              Resign game
            </button>
            <button className="button" type="button" onClick={() => setResigning(false)}>
              Keep playing
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}

function ArrowForInvitation() {
  return <span aria-hidden="true">→</span>;
}
