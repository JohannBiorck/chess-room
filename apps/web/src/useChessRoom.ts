import {
  type CreateGame,
  type GameAction,
  type GameCommand,
  type GameView,
  gameViewSchema,
  invitationTokenSchema,
  PROTOCOL_VERSION,
  type PublicGame,
  publicGameSchema,
  type SessionView,
  sessionViewSchema,
} from "@chess-room/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

import {
  ApiError,
  currentGameId,
  errorMessage,
  invitationToken,
  rememberGame,
  request,
} from "./api";

export type Invitation = { token: string; expiresAt: number };
type SessionResponse = { session: SessionView | null };
type CreatedGame = GameView & { invitation: Invitation };
type PendingCommand = { gameId: string; command: GameCommand };
type Connection = "connecting" | "connected" | "reconnecting";

function parseGame(payload: unknown): GameView {
  const candidate =
    typeof payload === "object" && payload !== null && "game" in payload && "seat" in payload
      ? { game: payload.game, seat: payload.seat }
      : null;
  const result = gameViewSchema.safeParse(candidate);
  if (!result.success)
    throw new Error("The server returned an unexpected game state. Reload to reconnect.");
  return result.data;
}

export function useChessRoom() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [view, setView] = useState<GameView | null>(null);
  const viewRef = useRef<GameView | null>(null);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [retry, setRetry] = useState<PendingCommand | null>(null);
  const [receivedAt, setReceivedAt] = useState(performance.now());
  const [initialInvitation] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get("invite") ?? "",
  );

  const applyView = useCallback((next: GameView) => {
    const previous = viewRef.current;
    if (previous?.game.id === next.game.id && previous.game.revision > next.game.revision) return;
    viewRef.current = next;
    setView(next);
    setReceivedAt(performance.now());
    rememberGame(next.game.id);
  }, []);

  const refreshGame = useCallback(
    async (gameId: string, follow = false) => {
      const next = parseGame(await request<GameView>(`/api/games/${gameId}`));
      if (follow || viewRef.current?.game.id === gameId) applyView(next);
      return next;
    },
    [applyView],
  );

  useEffect(() => {
    let alive = true;
    async function initialize() {
      try {
        const payload = await request<SessionResponse>("/api/session");
        const existing = payload.session ? sessionViewSchema.parse(payload.session) : null;
        if (!alive) return;
        setSession(existing);
        const stored = currentGameId();
        if (existing && stored && !initialInvitation) {
          try {
            const saved = parseGame(await request<GameView>(`/api/games/${stored}`));
            if (alive) applyView(saved);
          } catch (cause) {
            if (!alive) return;
            setNotice(
              cause instanceof ApiError && [403, 404, 410].includes(cause.status)
                ? "Your previous room is no longer available to this guest session. You can start a new game."
                : "Your previous room could not be loaded. Try reconnecting before starting a new game.",
            );
            if (cause instanceof ApiError && [403, 404, 410].includes(cause.status))
              rememberGame(null);
          }
        } else if (!existing && stored && !initialInvitation) {
          setNotice(
            "Your guest session has expired or its cookie was removed. Existing seats cannot be recovered by display name. Start a new game with your friend.",
          );
          rememberGame(null);
        }
      } catch (cause) {
        if (alive) setError(errorMessage(cause));
      } finally {
        if (alive) setLoading(false);
      }
    }
    void initialize();
    return () => {
      alive = false;
    };
  }, [applyView, initialInvitation]);

  const gameId = view?.game.id;
  useEffect(() => {
    if (!gameId) return;
    let alive = true;
    setConnection("connecting");
    const socket = io({ transports: ["websocket"], autoConnect: true });
    const subscribe = () => {
      socket
        .timeout(10_000)
        .emit("game:subscribe", { gameId }, (failure: unknown, payload: unknown) => {
          if (!alive) return;
          if (failure) {
            setConnection("reconnecting");
            return;
          }
          if (typeof payload === "object" && payload !== null && "error" in payload) {
            const detail = payload.error;
            if (
              typeof detail === "object" &&
              detail !== null &&
              "message" in detail &&
              typeof detail.message === "string"
            ) {
              setError(detail.message);
              setConnection("reconnecting");
              return;
            }
          }
          try {
            applyView(parseGame(payload));
            setConnection("connected");
          } catch (cause) {
            setError(errorMessage(cause));
          }
        });
    };
    socket.on("connect", subscribe);
    socket.on("disconnect", () => {
      if (alive) setConnection("reconnecting");
    });
    socket.on("connect_error", () => {
      if (alive) setConnection("reconnecting");
    });
    socket.on("game:updated", (payload: PublicGame) => {
      if (!alive) return;
      const result = publicGameSchema.safeParse(payload);
      if (!result.success || result.data.id !== gameId) return;
      const previous = viewRef.current;
      if (previous?.game.id === gameId && result.data.revision > previous.game.revision)
        applyView({ game: result.data, seat: previous.seat });
    });
    // A snapshot also corrects clocks and recovers a missed broadcast without trusting socket recovery.
    const synchronize = () => {
      void refreshGame(gameId)
        .then(() => {
          if (alive && socket.connected) setConnection("connected");
        })
        .catch((cause: unknown) => {
          if (alive) setConnection("reconnecting");
          if (alive && cause instanceof ApiError && cause.status === 401) {
            setSession(null);
            rememberGame(null);
            setNotice(
              "Your guest session ended. Return to the lobby to start a new game. A display name cannot recover an expired seat.",
            );
          }
        });
    };
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") synchronize();
    }, 10_000);
    const foreground = () => {
      if (document.visibilityState === "visible") synchronize();
    };
    document.addEventListener("visibilitychange", foreground);
    return () => {
      alive = false;
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", foreground);
      socket.disconnect();
    };
  }, [applyView, gameId, refreshGame]);

  async function operation(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof ApiError && cause.status === 401) {
        setSession(null);
        rememberGame(null);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function ensureSession(displayName: string) {
    if (session) return;
    const payload = await request<SessionResponse>("/api/session", { displayName });
    if (!payload.session)
      throw new Error("Your guest session could not be created. Please try again.");
    setSession(sessionViewSchema.parse(payload.session));
  }

  async function create(displayName: string, settings: CreateGame) {
    await operation(async () => {
      await ensureSession(displayName);
      const payload = await request<CreatedGame>("/api/games", settings);
      const token = invitationTokenSchema.parse(payload.invitation.token);
      setInvitation({ token, expiresAt: payload.invitation.expiresAt });
      setRetry(null);
      applyView(parseGame(payload));
    });
  }

  async function join(displayName: string, value: string) {
    await operation(async () => {
      const parsed = invitationTokenSchema.safeParse(invitationToken(value));
      if (!parsed.success)
        throw new Error("Paste a complete invitation link or its invitation code.");
      await ensureSession(displayName);
      const payload = await request<GameView>("/api/invitations/join", { token: parsed.data });
      setInvitation(null);
      setRetry(null);
      applyView(parseGame(payload));
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    });
  }

  async function execute(pending: PendingCommand) {
    setRetry(null);
    try {
      const payload = await request<GameView>(
        `/api/games/${pending.gameId}/commands`,
        pending.command,
      );
      applyView(parseGame(payload));
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 0 || cause.status >= 500)) {
        setRetry(pending);
        setNotice(
          "The command was not acknowledged. Reconnect or retry; the same command ID makes a retry safe.",
        );
      }
      try {
        await refreshGame(pending.gameId);
      } catch {
        /* The connection error above remains actionable. */
      }
      throw cause;
    }
  }

  async function command(action: GameAction) {
    const current = viewRef.current;
    if (!current) return;
    const pending: PendingCommand = {
      gameId: current.game.id,
      command: {
        protocolVersion: PROTOCOL_VERSION,
        commandId: crypto.randomUUID(),
        expectedRevision: current.game.revision,
        action,
      },
    };
    await operation(() => execute(pending));
  }

  async function retryCommand() {
    if (retry) await operation(() => execute(retry));
  }

  async function reconnect() {
    const id = viewRef.current?.game.id ?? currentGameId();
    if (id)
      await operation(async () => {
        await refreshGame(id, true);
      });
    else window.location.reload();
  }

  async function renewInvitation() {
    const current = viewRef.current;
    if (!current) return;
    await operation(async () => {
      const payload = await request<Invitation>(`/api/games/${current.game.id}/invitation`, {});
      setInvitation({
        token: invitationTokenSchema.parse(payload.token),
        expiresAt: payload.expiresAt,
      });
    });
  }

  async function openRematch() {
    const id = viewRef.current?.game.rematchGameId;
    if (!id) return;
    await operation(async () => {
      await refreshGame(id, true);
      setInvitation(null);
      setRetry(null);
    });
  }

  function lobby() {
    viewRef.current = null;
    setView(null);
    setInvitation(null);
    setRetry(null);
    setError(null);
    setNotice(null);
    // The last room remains resumable until another room is created or joined.
  }

  return {
    session,
    view,
    invitation,
    loading,
    busy,
    error,
    notice,
    connection,
    retry,
    receivedAt,
    initialInvitation,
    hasSavedGame: session !== null && currentGameId() !== null,
    create,
    join,
    command,
    retryCommand,
    reconnect,
    renewInvitation,
    openRematch,
    lobby,
    clearError: () => setError(null),
  };
}
