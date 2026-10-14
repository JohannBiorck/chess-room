import {
  type CatEffect,
  type CreateBotGame,
  type CreateGame,
  displayNameSchema,
  type GameAction,
  type GameCommand,
  type GameView,
  gameViewSchema,
  invitationTokenSchema,
  type OpenRoom,
  openRoomsSchema,
  PROTOCOL_VERSION,
  type PublicGame,
  playerUpdateSchema,
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
  request as rawRequest,
  rememberGame,
} from "./api";
import { liveCatEffects as collectLiveCatEffects } from "./catPresentation";
import { type PendingMove, previewMove } from "./movePreview";
import { type PresentationEvent, presentationUpdate } from "./presentationEvents";

export type Invitation = { token: string; expiresAt: number };
type SessionResponse = { session: SessionView | null };
type CreatedGame = GameView & { invitation: Invitation };
type PendingCommand = { gameId: string; command: GameCommand };
type Connection = "connecting" | "connected" | "reconnecting";
type Delivery = { isCurrent: () => boolean; isLive: () => boolean };
class IdentityChanged extends Error {}

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
  const [liveCatEffects, setLiveCatEffects] = useState<CatEffect[]>([]);
  const [presentationEvents, setPresentationEvents] = useState<PresentationEvent[]>([]);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const viewRef = useRef<GameView | null>(null);
  const playersEpoch = useRef(0);
  const connectionEpoch = useRef(0);
  const subscribed = useRef(false);
  const identityEpoch = useRef(0);
  const navigationEpoch = useRef(0);
  const [identityGeneration, setIdentityGeneration] = useState(0);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [retry, setRetry] = useState<PendingCommand | null>(null);
  const [receivedAt, setReceivedAt] = useState(performance.now());
  const [openRooms, setOpenRooms] = useState<OpenRoom[]>([]);
  const [activeBotId, setActiveBotId] = useState<string | null>(null);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const roomsRequest = useRef(0);
  const [initialInvitation] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get("invite") ?? "",
  );

  const request = useCallback(async <T>(path: string, body?: unknown): Promise<T> => {
    const epoch = identityEpoch.current;
    try {
      const result = await rawRequest<T>(path, body);
      if (epoch !== identityEpoch.current) throw new IdentityChanged();
      return result;
    } catch (cause) {
      if (epoch !== identityEpoch.current) throw new IdentityChanged();
      throw cause;
    }
  }, []);

  const applyView = useCallback((next: GameView, animate = false, preserveNames = false) => {
    const previous = viewRef.current;
    if (previous?.game.id === next.game.id && previous.game.revision > next.game.revision) return;
    if (previous?.game.id !== next.game.id) {
      playersEpoch.current += 1;
      connectionEpoch.current += 1;
      subscribed.current = false;
    }
    if (preserveNames && previous?.game.id === next.game.id)
      next = {
        ...next,
        game: {
          ...next.game,
          players: {
            white: previous.game.players.white ?? next.game.players.white,
            black: previous.game.players.black ?? next.game.players.black,
          },
        },
      };
    const arrivals = collectLiveCatEffects(
      previous ? { id: previous.game.id, ply: previous.game.position.moves.length } : null,
      { id: next.game.id, ply: next.game.position.moves.length },
      next.game.position.catEffects ?? [],
      animate,
    );
    const presentation = presentationUpdate(
      previous?.game ?? null,
      next.game,
      animate,
      document.visibilityState === "visible",
      performance.now(),
    );
    if (presentation.reset) {
      setPresentationEvents([]);
      setLiveCatEffects([]);
    } else if (presentation.events.length > 0) {
      setPresentationEvents((events) => [...events, ...presentation.events].slice(-8));
    }
    if (previous?.game.id !== next.game.id) setLiveCatEffects([]);
    else if (!presentation.reset && arrivals.length > 0)
      setLiveCatEffects((effects) => [...effects, ...arrivals].slice(-24));
    viewRef.current = next;
    if (next.game.closure) setInvitation(null);
    setPendingMove((pending) =>
      pending && (pending.gameId !== next.game.id || next.game.revision > pending.revision)
        ? null
        : pending,
    );
    setView(next);
    const own = next.seat ? next.game.players[next.seat] : null;
    if (own)
      setSession((current) => (current ? { ...current, displayName: own.displayName } : current));
    setReceivedAt(performance.now());
    rememberGame(next.game.id);
  }, []);

  const refreshGame = useCallback(
    async (gameId: string, follow = false, delivery?: Delivery) => {
      const namesAtRequest = playersEpoch.current;
      const next = parseGame(await request<GameView>(`/api/games/${gameId}`));
      if (delivery && !delivery.isCurrent()) return next;
      if (follow || viewRef.current?.game.id === gameId)
        applyView(next, delivery?.isLive() ?? false, namesAtRequest !== playersEpoch.current);
      return next;
    },
    [applyView, request],
  );

  const refreshOpenRooms = useCallback(async () => {
    const requestId = ++roomsRequest.current;
    setRoomsLoading(true);
    try {
      const [payload, bot] = await Promise.all([
        request<unknown>("/api/lobbies"),
        request<{ gameId: string | null }>("/api/bot-game"),
      ]);
      const result = openRoomsSchema.parse(payload);
      if (requestId !== roomsRequest.current || viewRef.current) return;
      setOpenRooms(result.rooms);
      setActiveBotId(bot.gameId && /^[0-9a-f-]{36}$/i.test(bot.gameId) ? bot.gameId : null);
      setRoomsError(null);
    } catch (cause) {
      if (requestId === roomsRequest.current && !viewRef.current)
        setRoomsError(errorMessage(cause));
    } finally {
      if (requestId === roomsRequest.current) setRoomsLoading(false);
    }
  }, [request]);

  const inLobby = view === null && !loading;
  useEffect(() => {
    if (!inLobby) return;
    void refreshOpenRooms();
    const refresh = () => {
      if (document.visibilityState === "visible") void refreshOpenRooms();
    };
    const timer = window.setInterval(refresh, 10_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      roomsRequest.current += 1;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [inLobby, refreshOpenRooms]);

  useEffect(() => {
    let alive = true;
    const epoch = identityEpoch.current;
    const navigation = navigationEpoch.current;
    async function initialize() {
      try {
        const payload = await request<SessionResponse>("/api/session");
        const existing = payload.session ? sessionViewSchema.parse(payload.session) : null;
        if (!alive || epoch !== identityEpoch.current || navigation !== navigationEpoch.current)
          return;
        setSession(existing);
        const stored = currentGameId();
        if (existing && stored && !initialInvitation) {
          try {
            const saved = parseGame(await request<GameView>(`/api/games/${stored}`));
            if (alive && epoch === identityEpoch.current && navigation === navigationEpoch.current)
              applyView(saved);
          } catch (cause) {
            if (!alive || epoch !== identityEpoch.current || navigation !== navigationEpoch.current)
              return;
            setNotice(
              cause instanceof ApiError && [403, 404, 410].includes(cause.status)
                ? "Your previous room is unavailable to this player session. Sign in with its account or start a new game."
                : "Your previous room could not be loaded. Try reconnecting before starting a new game.",
            );
            if (cause instanceof ApiError && [403, 404, 410].includes(cause.status))
              rememberGame(null);
          }
        } else if (!existing && stored && !initialInvitation) {
          setNotice(
            "Your player session has ended. Sign in to recover account games. Guest seats need their original valid browser cookie.",
          );
          rememberGame(null);
        }
      } catch (cause) {
        if (alive && epoch === identityEpoch.current && navigation === navigationEpoch.current)
          setError(errorMessage(cause));
      } finally {
        if (alive && epoch === identityEpoch.current) setLoading(false);
      }
    }
    void initialize();
    return () => {
      alive = false;
    };
  }, [applyView, initialInvitation, request]);

  const gameId = view?.game.id;
  useEffect(() => {
    if (!gameId || identityGeneration !== identityEpoch.current) return;
    let alive = true;
    subscribed.current = false;
    connectionEpoch.current += 1;
    setConnection("connecting");
    const socket = io({ transports: ["websocket"], autoConnect: true });
    const subscribe = () => {
      const epoch = ++connectionEpoch.current;
      const namesAtRequest = playersEpoch.current;
      subscribed.current = false;
      socket
        .timeout(10_000)
        .emit("game:subscribe", { gameId }, (failure: unknown, payload: unknown) => {
          if (!alive || epoch !== connectionEpoch.current) return;
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
            applyView(parseGame(payload), false, namesAtRequest !== playersEpoch.current);
            subscribed.current = true;
            setConnection("connected");
          } catch (cause) {
            setError(errorMessage(cause));
          }
        });
    };
    socket.on("connect", subscribe);
    socket.on("disconnect", () => {
      connectionEpoch.current += 1;
      subscribed.current = false;
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
        applyView({ game: result.data, seat: previous.seat }, true, true);
    });
    socket.on("game:players", (payload: unknown) => {
      if (!alive) return;
      const result = playerUpdateSchema.safeParse(payload);
      const previous = viewRef.current;
      if (!result.success || result.data.gameId !== gameId || previous?.game.id !== gameId) return;
      playersEpoch.current += 1;
      const players = {
        white: result.data.players.white ?? previous.game.players.white,
        black: result.data.players.black ?? previous.game.players.black,
      };
      const next = { ...previous, game: { ...previous.game, players } };
      viewRef.current = next;
      setView(next);
      const own = previous.seat ? players[previous.seat] : null;
      if (own)
        setSession((current) => (current ? { ...current, displayName: own.displayName } : current));
    });
    // A snapshot also corrects clocks and recovers a missed broadcast without trusting socket recovery.
    const synchronize = () => {
      const epoch = connectionEpoch.current;
      const live = subscribed.current && socket.connected;
      // A connected refresh is another live delivery path. Treating it as history can
      // consume a new cat effect just before the same socket revision arrives.
      void refreshGame(gameId, false, {
        isCurrent: () => alive && epoch === connectionEpoch.current,
        isLive: () => live && subscribed.current && socket.connected,
      })
        .then(() => {
          if (alive && subscribed.current && socket.connected && epoch === connectionEpoch.current)
            setConnection("connected");
        })
        .catch((cause: unknown) => {
          if (!alive || epoch !== connectionEpoch.current) return;
          setConnection("reconnecting");
          if (cause instanceof ApiError && cause.status === 401) {
            setSession(null);
            rememberGame(null);
            setNotice(
              "Your player session ended. Sign in again for account games, or return to the lobby for guest play.",
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
      subscribed.current = false;
      connectionEpoch.current += 1;
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", foreground);
      socket.disconnect();
    };
  }, [applyView, gameId, refreshGame, identityGeneration]);

  async function operation(work: () => Promise<void>) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const epoch = identityEpoch.current;
    try {
      await work();
      return true;
    } catch (cause) {
      if (cause instanceof IdentityChanged || epoch !== identityEpoch.current) return false;
      setError(errorMessage(cause));
      if (cause instanceof ApiError && cause.status === 401) {
        setSession(null);
        rememberGame(null);
      }
      return false;
    } finally {
      if (epoch === identityEpoch.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  async function ensureSession(displayName: string) {
    const name = displayNameSchema.safeParse(displayName);
    if (!name.success)
      throw new Error("Use a display name of 1–32 characters without hidden control characters.");
    if (session) {
      if (session.displayName !== name.data) await saveName(name.data);
      return;
    }
    const payload = await request<SessionResponse>("/api/session", { displayName: name.data });
    if (!payload.session)
      throw new Error("Your guest session could not be created. Please try again.");
    setSession(sessionViewSchema.parse(payload.session));
  }

  async function saveName(displayName: string) {
    const name = displayNameSchema.safeParse(displayName);
    if (!name.success)
      throw new Error("Use a display name of 1–32 characters without hidden control characters.");
    const payload = await request<SessionResponse>("/api/session/name", { displayName: name.data });
    if (!payload.session)
      throw new Error("Your display name could not be saved. Please try again.");
    const next = sessionViewSchema.parse(payload.session);
    setSession(next);
    const current = viewRef.current;
    if (current?.seat) {
      playersEpoch.current += 1;
      const updated = {
        ...current,
        game: {
          ...current.game,
          players: { ...current.game.players, [current.seat]: { displayName: next.displayName } },
        },
      };
      viewRef.current = updated;
      setView(updated);
    }
    if (!viewRef.current) void refreshOpenRooms();
  }

  async function rename(displayName: string) {
    return operation(() => saveName(displayName));
  }

  async function joinOpen(displayName: string, roomId: string) {
    await operation(async () => {
      const navigation = ++navigationEpoch.current;
      if (!/^[0-9a-f-]{36}$/i.test(roomId)) throw new Error("Choose an available open room.");
      await ensureSession(displayName);
      try {
        const payload = await request<GameView>(`/api/lobbies/${roomId}/join`, {});
        if (navigation !== navigationEpoch.current) throw new IdentityChanged();
        setInvitation(null);
        setRetry(null);
        applyView(parseGame(payload));
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch (cause) {
        void refreshOpenRooms();
        throw cause;
      }
    });
  }

  async function create(displayName: string, settings: CreateGame) {
    await operation(async () => {
      const navigation = ++navigationEpoch.current;
      await ensureSession(displayName);
      const payload = await request<CreatedGame>("/api/games", settings);
      if (navigation !== navigationEpoch.current) throw new IdentityChanged();
      const token = invitationTokenSchema.parse(payload.invitation.token);
      setInvitation({ token, expiresAt: payload.invitation.expiresAt });
      setRetry(null);
      applyView(parseGame(payload));
    });
  }

  async function createBot(displayName: string, settings: CreateBotGame) {
    await operation(async () => {
      const navigation = ++navigationEpoch.current;
      await ensureSession(displayName);
      const payload = await request<GameView>("/api/bot-games", settings);
      if (navigation !== navigationEpoch.current) throw new IdentityChanged();
      setInvitation(null);
      setRetry(null);
      applyView(parseGame(payload));
    });
  }

  async function join(displayName: string, value: string) {
    await operation(async () => {
      const navigation = ++navigationEpoch.current;
      const parsed = invitationTokenSchema.safeParse(invitationToken(value));
      if (!parsed.success)
        throw new Error("Paste a complete invitation link or its invitation code.");
      await ensureSession(displayName);
      const payload = await request<GameView>("/api/invitations/join", { token: parsed.data });
      if (navigation !== navigationEpoch.current) throw new IdentityChanged();
      setInvitation(null);
      setRetry(null);
      applyView(parseGame(payload));
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    });
  }

  async function execute(pending: PendingCommand) {
    setRetry(null);
    const current = viewRef.current;
    const epoch = connectionEpoch.current;
    const navigation = navigationEpoch.current;
    const live = subscribed.current;
    if (
      pending.command.action.type === "move" &&
      current?.game.id === pending.gameId &&
      current.game.revision === pending.command.expectedRevision &&
      current.game.phase === "active" &&
      current.seat === current.game.position.turn &&
      connection === "connected"
    ) {
      const board = previewMove(
        current.game.position.board,
        current.game.position.legalMoves,
        pending.command.action,
      );
      if (board)
        setPendingMove({
          gameId: pending.gameId,
          revision: current.game.revision,
          commandId: pending.command.commandId,
          ply: current.game.position.moves.length + 1,
          move: pending.command.action,
          board,
        });
    }
    try {
      const payload = await request<GameView>(
        `/api/games/${pending.gameId}/commands`,
        pending.command,
      );
      if (navigation !== navigationEpoch.current) throw new IdentityChanged();
      applyView(parseGame(payload), true, true);
      setPendingMove(null);
    } catch (cause) {
      if (cause instanceof IdentityChanged || navigation !== navigationEpoch.current)
        throw new IdentityChanged();
      // Roll back only the visual preview; an independently confirmed socket update
      // remains authoritative even when its HTTP acknowledgement was lost.
      setPendingMove(null);
      if (cause instanceof ApiError && (cause.status === 0 || cause.status >= 500)) {
        setRetry(pending);
        setNotice(
          "The command was not acknowledged. Reconnect or retry; the same command ID makes a retry safe.",
        );
      }
      try {
        await refreshGame(pending.gameId, false, {
          isCurrent: () => epoch === connectionEpoch.current,
          isLive: () => live && subscribed.current,
        });
      } catch {
        /* The connection error above remains actionable. */
      }
      throw cause;
    }
  }

  async function command(action: GameAction) {
    const current = viewRef.current;
    if (!current) return false;
    const pending: PendingCommand = {
      gameId: current.game.id,
      command: {
        protocolVersion: PROTOCOL_VERSION,
        commandId: crypto.randomUUID(),
        expectedRevision: current.game.revision,
        action,
      },
    };
    return operation(() => execute(pending));
  }

  async function retryCommand() {
    if (retry) await operation(() => execute(retry));
  }

  async function reconnect() {
    const id = viewRef.current?.game.id ?? currentGameId();
    if (id)
      await operation(async () => {
        const navigation = ++navigationEpoch.current;
        await refreshGame(id, true, {
          isCurrent: () => navigation === navigationEpoch.current,
          isLive: () => false,
        });
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
      const navigation = ++navigationEpoch.current;
      await refreshGame(id, true, {
        isCurrent: () => navigation === navigationEpoch.current,
        isLive: () => false,
      });
      if (navigation !== navigationEpoch.current) throw new IdentityChanged();
      setInvitation(null);
      setRetry(null);
    });
  }

  async function openGame(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return;
    await operation(async () => {
      const navigation = ++navigationEpoch.current;
      await refreshGame(id, true, {
        isCurrent: () => navigation === navigationEpoch.current,
        isLive: () => false,
      });
      if (navigation !== navigationEpoch.current) throw new IdentityChanged();
      setInvitation(null);
      setRetry(null);
    });
  }

  async function identityChanged() {
    const previousGame = viewRef.current?.game.id ?? currentGameId();
    const navigation = navigationEpoch.current;
    const epoch = ++identityEpoch.current;
    connectionEpoch.current += 1;
    playersEpoch.current += 1;
    subscribed.current = false;
    roomsRequest.current += 1;
    setIdentityGeneration((value) => value + 1);
    viewRef.current = null;
    setView(null);
    setSession(null);
    setActiveBotId(null);
    setPendingMove(null);
    setPresentationEvents([]);
    setLiveCatEffects([]);
    setInvitation(null);
    setRetry(null);
    setError(null);
    setNotice(null);
    busyRef.current = false;
    setBusy(false);
    setLoading(true);
    try {
      const payload = await request<SessionResponse>("/api/session");
      if (navigation !== navigationEpoch.current) return;
      const next = payload.session ? sessionViewSchema.parse(payload.session) : null;
      setSession(next);
      if (next && previousGame) {
        try {
          await refreshGame(previousGame, true, {
            isCurrent: () =>
              epoch === identityEpoch.current && navigation === navigationEpoch.current,
            isLive: () => false,
          });
        } catch (cause) {
          if (cause instanceof IdentityChanged || navigation !== navigationEpoch.current) return;
          if (cause instanceof ApiError && [401, 403, 404, 410].includes(cause.status))
            rememberGame(null);
          else setNotice("Your saved room could not be loaded. You can retry from the lobby.");
        }
      } else rememberGame(null);
    } catch (cause) {
      if (!(cause instanceof IdentityChanged) && navigation === navigationEpoch.current)
        setError(errorMessage(cause));
    } finally {
      if (epoch === identityEpoch.current) setLoading(false);
    }
  }

  const confirmBotView = useCallback(
    (next: GameView) => {
      if (viewRef.current?.game.id !== next.game.id) return;
      applyView(parseGame(next), true, true);
    },
    [applyView],
  );

  function lobby() {
    navigationEpoch.current += 1;
    connectionEpoch.current += 1;
    playersEpoch.current += 1;
    subscribed.current = false;
    if (viewRef.current?.game.closure) rememberGame(null);
    viewRef.current = null;
    setView(null);
    setPendingMove(null);
    setLiveCatEffects([]);
    setPresentationEvents([]);
    setInvitation(null);
    setRetry(null);
    setError(null);
    setNotice(null);
    setLoading(false);
    // The last room remains resumable until another room is created or joined.
  }

  return {
    session,
    view,
    liveCatEffects,
    presentationEvents,
    pendingMove,
    invitation,
    loading,
    busy,
    error,
    notice,
    connection,
    retry,
    receivedAt,
    initialInvitation,
    openRooms,
    activeBotId,
    roomsLoading,
    roomsError,
    hasSavedGame: session !== null && currentGameId() !== null,
    create,
    createBot,
    join,
    joinOpen,
    rename,
    refreshOpenRooms,
    command,
    retryCommand,
    reconnect,
    renewInvitation,
    openRematch,
    openGame,
    identityChanged,
    confirmBotView,
    lobby,
    clearError: () => setError(null),
  };
}
