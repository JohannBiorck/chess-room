import {
  type BotCommand,
  botPositionViewSchema,
  type GameView,
  gameViewSchema,
  type MoveInput,
  type PublicGame,
} from "@chess-room/contracts";
import { useEffect, useRef, useState } from "react";
import { ApiError, errorMessage, request } from "./api";
import {
  acceptedBotView,
  fallbackBotMove,
  isBotTurn,
  matchesMove,
  type PendingBotCommand,
  readPendingBotCommand,
  reusableBotCommand,
  savePendingBotCommand,
  validateBotPosition,
} from "./bot/coordinator";
import { searchInWorker } from "./bot/workerClient";

export function BotTurnController({
  game,
  onConfirmed,
  onRefresh,
}: {
  game: PublicGame;
  onConfirmed: (view: GameView) => void;
  onRefresh: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const attemptRef = useRef(attempt);
  attemptRef.current = attempt;
  const [visible, setVisible] = useState(!document.hidden);
  const [status, setStatus] = useState<"loading" | "thinking" | "saving" | "idle">("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);
  const pending = useRef<PendingBotCommand | null>(readPendingBotCommand());
  const callbacks = useRef({ onConfirmed, onRefresh });
  callbacks.current = { onConfirmed, onRefresh };
  const latest = useRef(game);
  latest.current = game;
  const turnKey = game.bot
    ? `${game.id}:${game.revision}:${game.bot.requestId}:${game.phase}:${game.position.turn}`
    : "";
  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    const game = latest.current;
    if (!turnKey || !isBotTurn(game) || !visible) {
      setStatus("idle");
      setFailure(null);
      return;
    }
    const abort = new AbortController();
    const current = () =>
      !abort.signal.aborted &&
      attemptRef.current === attempt &&
      latest.current.id === game.id &&
      latest.current.revision === game.revision &&
      latest.current.bot?.requestId === game.bot?.requestId;
    setFailure(null);
    setFallback(false);
    const run = async () => {
      let command: BotCommand | null = reusableBotCommand(pending.current, game);
      try {
        if (!command) {
          setStatus("loading");
          const position = botPositionViewSchema.parse(
            await request(`/api/games/${game.id}/bot-position`),
          );
          if (!current()) return;
          validateBotPosition(position, game);
          setStatus("thinking");
          let move: MoveInput;
          try {
            move = (await searchInWorker(position, abort.signal)).move;
          } catch (error) {
            if (!current()) return;
            if (error instanceof DOMException && error.name === "AbortError") return;
            move = fallbackBotMove(game);
            setFallback(true);
          }
          if (!current()) return;
          if (!game.position.legalMoves.some((legal) => matchesMove(legal, move)))
            throw new Error("The cat returned an invalid move. Reconnect to continue.");
          command = {
            protocolVersion: 1,
            commandId: position.requestId,
            expectedRevision: game.revision,
            move,
          };
          pending.current = { gameId: game.id, command };
          savePendingBotCommand(pending.current);
        }
        if (!current()) return;
        setStatus("saving");
        const response = gameViewSchema.parse(
          await request(`/api/games/${game.id}/bot-command`, command),
        );
        if (!current()) return;
        if (!acceptedBotView(response, game, command))
          throw new Error("The cat's move could not be confirmed. Reconnect to continue.");
        pending.current = null;
        savePendingBotCommand(null);
        setStatus("idle");
        callbacks.current.onConfirmed(response);
      } catch (error) {
        if (!current()) return;
        setStatus("idle");
        if (
          error instanceof ApiError &&
          [
            "STALE_REVISION",
            "COMMAND_REUSED",
            "BOT_TURN_UNAVAILABLE",
            "BOT_NOT_READY",
            "BOT_TICKET_CHANGED",
            "GAME_FINISHED",
          ].includes(error.code)
        ) {
          pending.current = null;
          savePendingBotCommand(null);
          callbacks.current.onRefresh();
        } else setFailure(errorMessage(error));
      }
    };
    void run();
    return () => abort.abort();
  }, [turnKey, visible, attempt]);
  if (!game.bot) return null;
  if (failure)
    return (
      <aside className="notice" aria-label="Cat bot status">
        <p role="alert">{failure}</p>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          Retry cat turn
        </button>{" "}
        <button type="button" onClick={() => callbacks.current.onRefresh()}>
          Reconnect
        </button>
      </aside>
    );
  if (!isBotTurn(game)) return null;
  return (
    <p className="notice" role="status">
      {!visible
        ? "Cat Bot is paused until this tab returns."
        : status === "loading"
          ? "Cat Bot is getting ready…"
          : status === "thinking"
            ? "Cat Bot is thinking…"
            : status === "saving"
              ? "Confirming the cat’s move…"
              : "Cat Bot is ready."}
      {fallback && " A lighter fallback was used on this device."}
    </p>
  );
}
