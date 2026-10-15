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
import type { PresentationEvent } from "./presentationEvents";
import { useReducedMotion } from "./presentationPreferences";
import { botPresentationEndsAt } from "./presentationTiming";

async function waitForPresentation(until: number, signal: AbortSignal) {
  const delay = until - performance.now();
  if (delay <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      window.clearTimeout(timer);
      reject(new DOMException("The cat turn was cancelled.", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, delay);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

export function BotTurnController({
  game,
  presentationEvents,
  onConfirmed,
  onRefresh,
}: {
  game: PublicGame;
  presentationEvents: PresentationEvent[];
  onConfirmed: (view: GameView) => void;
  onRefresh: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const attemptRef = useRef(attempt);
  attemptRef.current = attempt;
  const [visible, setVisible] = useState(!document.hidden);
  const reduced = useReducedMotion();
  const [status, setStatus] = useState<"loading" | "thinking" | "waiting" | "saving" | "idle">(
    "idle",
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);
  const pending = useRef<PendingBotCommand | null>(readPendingBotCommand());
  const callbacks = useRef({ onConfirmed, onRefresh });
  callbacks.current = { onConfirmed, onRefresh };
  const latest = useRef(game);
  latest.current = game;
  const presentation = useRef(presentationEvents);
  presentation.current = presentationEvents;
  const cancelledVisit = useRef<string | null>(null);
  const turnKey = game.bot
    ? `${game.id}:${game.revision}:${game.bot.requestId}:${game.phase}:${game.position.turn}`
    : "";
  useEffect(() => {
    const changed = () => {
      if (document.hidden) cancelledVisit.current = presentation.current.at(-1)?.id ?? null;
      setVisible(!document.hidden);
    };
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    const game = latest.current;
    if (reduced) cancelledVisit.current = presentation.current.at(-1)?.id ?? null;
    if (!turnKey || !isBotTurn(game) || !visible) {
      setStatus("idle");
      setFailure(null);
      return;
    }
    const abort = new AbortController();
    const current = () =>
      !abort.signal.aborted &&
      !document.hidden &&
      attemptRef.current === attempt &&
      latest.current.id === game.id &&
      latest.current.revision === game.revision &&
      latest.current.bot?.requestId === game.bot?.requestId;
    setFailure(null);
    const run = async () => {
      let command: BotCommand | null = reusableBotCommand(pending.current, game);
      try {
        if (!command) {
          setFallback(false);
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
        const event = presentation.current.at(-1);
        const until =
          event?.gameId === game.id &&
          event.ply === game.position.moves.length &&
          event.id !== cancelledVisit.current
            ? botPresentationEndsAt(event, reduced)
            : 0;
        if (until > performance.now()) {
          setStatus("waiting");
          await waitForPresentation(until, abort.signal);
          if (!current()) return;
        }
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
  }, [turnKey, visible, attempt, reduced]);
  if (!game.bot) return null;
  if (failure)
    return (
      <aside className="bot-turn-status" aria-label="Cat bot status">
        <p role="alert">{failure}</p>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          Retry cat turn
        </button>{" "}
        <button type="button" onClick={() => callbacks.current.onRefresh()}>
          Reconnect
        </button>
      </aside>
    );
  return (
    <p className="bot-turn-status" role="status">
      {!isBotTurn(game)
        ? game.phase === "finished"
          ? "Cat Bot is ready for another game."
          : "Cat Bot is waiting for your move."
        : !visible
          ? "Cat Bot is paused until this tab returns."
          : status === "loading"
            ? "Cat Bot is getting ready…"
            : status === "thinking"
              ? "Cat Bot is thinking…"
              : status === "waiting"
                ? "Letting the cat finish its visit…"
                : status === "saving"
                  ? "Confirming the cat’s move…"
                  : "Cat Bot is ready."}
      {fallback && " A lighter fallback was used on this device."}
    </p>
  );
}
