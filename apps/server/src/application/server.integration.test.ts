import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  type CreateGame,
  type GameCommand,
  gameViewSchema,
  OPEN_ROOM_LIFETIME_MS,
  openRoomsSchema,
  type PublicGame,
  playerUpdateSchema,
  publicEnginePositionSchema,
  publicGameSchema,
  type TimeControl,
} from "@chess-room/contracts";
import { Pool } from "pg";
import { io as connectSocket, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { Database } from "../storage/database.js";
import { migrate } from "../storage/migrations.js";
import { tokenHash } from "./games.js";
import { buildApplication } from "./server.js";

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString)
  throw new Error("A PostgreSQL URL is required for transport integration tests.");
const origin = "http://127.0.0.1:5173";
type Application = Awaited<ReturnType<typeof buildApplication>>;

// Preserve the exact strict object fields understood by existing protocol-one clients.
const gameFields = publicGameSchema.shape;
const positionFields = publicEnginePositionSchema.shape;
const previousGameSchema = z.strictObject({
  id: gameFields.id,
  revision: gameFields.revision,
  phase: gameFields.phase,
  rulesetId: z.enum(["standard", "three-check"]),
  rulesVersion: gameFields.rulesVersion,
  timeControl: gameFields.timeControl,
  players: gameFields.players,
  position: z.strictObject({
    fen: positionFields.fen,
    turn: positionFields.turn,
    inCheck: positionFields.inCheck,
    board: positionFields.board.max(32),
    legalMoves: positionFields.legalMoves.max(256),
    moves: positionFields.moves,
    checks: positionFields.checks,
    claimableDraws: positionFields.claimableDraws,
    outcome: positionFields.outcome,
  }),
  clocks: gameFields.clocks,
  outcome: gameFields.outcome,
  drawOffer: gameFields.drawOffer,
  rematchRequested: gameFields.rematchRequested,
  rematchGameId: gameFields.rematchGameId,
  createdAt: gameFields.createdAt,
  updatedAt: gameFields.updatedAt,
});
const previousViewSchema = z.strictObject({
  game: previousGameSchema,
  seat: gameViewSchema.shape.seat,
});

describe("HTTP and real Socket.IO game transport", () => {
  let administrator: Pool;
  let database: Database;
  let application: Application;
  let schema: string;
  const applications: Application[] = [];
  const extraDatabases: Database[] = [];
  const sockets: Socket[] = [];

  const config = (secureCookies = false) => ({
    databaseUrl: connectionString,
    webOrigin: secureCookies ? "https://chess.example" : origin,
    secureCookies,
    serveWeb: false,
  });

  beforeEach(async () => {
    schema = `http_test_${randomUUID().replaceAll("-", "")}`;
    administrator = new Pool({ connectionString, max: 1 });
    await administrator.query(`CREATE SCHEMA "${schema}"`);
    database = new Database(connectionString, { options: `-c search_path=${schema}` });
    await migrate(database.pool);
    application = await buildApplication({
      database,
      config: config(),
      logger: false,
      workers: false,
    });
    applications.push(application);
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    for (const app of applications.splice(0)) await app.server.close();
    for (const extra of extraDatabases.splice(0)) await extra.close();
    await database?.close();
    if (administrator) {
      try {
        await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await administrator.end();
      }
    }
  });

  async function guest(name: string, app = application): Promise<string> {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: { displayName: name },
    });
    expect(response.statusCode).toBe(200);
    const header = response.headers["set-cookie"];
    const value = Array.isArray(header) ? header[0] : header;
    const cookie = value?.split(";")[0];
    if (!cookie) throw new Error("Guest session cookie was not issued.");
    return cookie;
  }

  async function create(
    cookie: string,
    app = application,
    timeControl: TimeControl = "untimed",
    overrides: Partial<CreateGame> = {},
  ) {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/games",
      headers: { origin, cookie },
      payload: { rulesetId: "standard", color: "white", timeControl, ...overrides },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ game: PublicGame; invitation: { token: string } }>();
  }

  async function startedGame(overrides: Partial<CreateGame> = {}) {
    const whiteCookie = await guest("White");
    const blackCookie = await guest("Black");
    const created = await create(whiteCookie, application, "untimed", overrides);
    const joined = await application.server.inject({
      method: "POST",
      url: "/api/invitations/join",
      headers: { origin, cookie: blackCookie },
      payload: { token: created.invitation.token },
    });
    expect(joined.statusCode).toBe(200);
    return { whiteCookie, blackCookie, view: gameViewSchema.parse(joined.json()) };
  }

  async function backgroundApplication(): Promise<Application> {
    const app = await buildApplication({ database, config: config(), logger: false });
    applications.push(app);
    await app.scheduler?.settled();
    return app;
  }

  async function postCommand(
    cookie: string,
    gameId: string,
    payload: GameCommand,
    app = application,
  ) {
    return app.server.inject({
      method: "POST",
      url: `/api/games/${gameId}/commands`,
      headers: { origin, cookie },
      payload,
    });
  }

  async function socketAt(
    address: string,
    cookie?: string,
    requestOrigin = origin,
  ): Promise<Socket> {
    const socket = connectSocket(address, {
      transports: ["websocket"],
      autoConnect: false,
      reconnection: false,
      extraHeaders: { origin: requestOrigin, ...(cookie ? { cookie } : {}) },
      timeout: 2_000,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", reject);
      socket.connect();
    });
    return socket;
  }

  async function subscribe(socket: Socket, gameId: string): Promise<unknown> {
    return socket.timeout(2_000).emitWithAck("game:subscribe", { gameId });
  }

  function updated(socket: Socket, revision: number): Promise<PublicGame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off("game:updated", receive);
        reject(new Error("Committed game update was not received."));
      }, 3_000);
      const receive = (game: PublicGame) => {
        if (game.revision < revision) return;
        clearTimeout(timer);
        socket.off("game:updated", receive);
        resolve(game);
      };
      socket.on("game:updated", receive);
    });
  }

  function playersUpdated(socket: Socket) {
    return new Promise<ReturnType<typeof playerUpdateSchema.parse>>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off("game:players", receive);
        reject(new Error("Renamed player update was not received."));
      }, 3_000);
      const receive = (payload: unknown) => {
        clearTimeout(timer);
        socket.off("game:players", receive);
        resolve(playerUpdateSchema.parse(payload));
      };
      socket.on("game:players", receive);
    });
  }

  it("discovers only public waiting rooms anonymously and joins a seat without an invitation", async () => {
    const host = await guest("Public host");
    const friend = await guest("Public friend");
    const privateRoom = await create(host);
    const open = await create(host, application, "10+5", { visibility: "open", color: "black" });
    const listed = await application.server.inject({ method: "GET", url: "/api/lobbies" });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["cache-control"]).toBe("no-store");
    const rooms = openRoomsSchema.parse(listed.json()).rooms;
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({
      id: open.game.id,
      host: { displayName: "Public host", color: "black" },
      timeControl: "10+5",
    });
    expect(JSON.stringify(rooms)).not.toContain(privateRoom.game.id);
    expect(JSON.stringify(rooms)).not.toContain(open.invitation.token);
    expect(
      (await application.server.inject({ method: "GET", url: `/api/games/${open.game.id}` }))
        .statusCode,
    ).toBe(401);
    const address = await application.server.listen({ port: 0, host: "127.0.0.1" });
    const hostSocket = await socketAt(address, host);
    gameViewSchema.parse(await subscribe(hostSocket, open.game.id));
    const updatedGame = updated(hostSocket, 1);
    const joined = await application.server.inject({
      method: "POST",
      url: `/api/lobbies/${open.game.id}/join`,
      headers: { origin, cookie: friend },
      payload: {},
    });
    expect(joined.statusCode).toBe(200);
    const view = gameViewSchema.parse(joined.json());
    expect(view.seat).toBe("white");
    expect(await updatedGame).toEqual(view.game);
    expect(
      (await application.server.inject({ method: "GET", url: "/api/lobbies" })).json(),
    ).toEqual({ rooms: [] });
    const retried = gameViewSchema.parse(
      (
        await application.server.inject({
          method: "POST",
          url: `/api/lobbies/${open.game.id}/join`,
          headers: { origin, cookie: friend },
          payload: {},
        })
      ).json(),
    );
    expect(retried.seat).toBe(view.seat);
    expect({ ...retried.game, clocks: null }).toEqual({ ...view.game, clocks: null });
    expect({ ...retried.game.clocks, serverNow: 0 }).toEqual({ ...view.game.clocks, serverNow: 0 });
    expect(application.scheduler).toBeUndefined();
  });

  it("validates and authenticates public joins and profile edits, bounds their request rates and preserves cookies", async () => {
    const cookie = await guest("Original");
    const before = await application.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie },
    });
    const joinedPath = `/api/lobbies/${randomUUID()}/join`;
    expect(
      (
        await application.server.inject({
          method: "POST",
          url: joinedPath,
          headers: { origin },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await application.server.inject({
          method: "POST",
          url: joinedPath,
          headers: { origin, cookie },
          payload: { sessionId: randomUUID() },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await application.server.inject({
          method: "POST",
          url: joinedPath,
          headers: { origin, cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await application.server.inject({
          method: "POST",
          url: "/api/session/name",
          headers: { origin },
          payload: { displayName: "Other" },
        })
      ).statusCode,
    ).toBe(401);
    for (const payload of [
      { displayName: "" },
      { displayName: "X".repeat(33) },
      { displayName: "Bad\u0000name" },
      { displayName: "Other", sessionId: randomUUID() },
    ]) {
      expect(
        (
          await application.server.inject({
            method: "POST",
            url: "/api/session/name",
            headers: { origin, cookie },
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
    const renamed = await application.server.inject({
      method: "POST",
      url: "/api/session/name",
      headers: { origin, cookie },
      payload: { displayName: "  Updated  " },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.headers["set-cookie"]).toBeUndefined();
    expect(renamed.json()).toEqual({
      session: { ...before.json().session, displayName: "Updated" },
    });
    expect(Object.keys(renamed.json().session).sort()).toEqual(["displayName", "expiresAt"]);
    for (let index = 0; index < 19; index += 1)
      expect(
        (
          await application.server.inject({
            method: "POST",
            url: "/api/session/name",
            headers: { origin, cookie },
            payload: { displayName: "Updated" },
          })
        ).statusCode,
      ).toBe(200);
    expect(
      (
        await application.server.inject({
          method: "POST",
          url: "/api/session/name",
          headers: { origin, cookie },
          payload: { displayName: "Limited" },
        })
      ).statusCode,
    ).toBe(429);
    for (let index = 0; index < 60; index += 1)
      expect(
        (await application.server.inject({ method: "GET", url: "/api/lobbies" })).statusCode,
      ).toBe(200);
    expect(
      (await application.server.inject({ method: "GET", url: "/api/lobbies" })).statusCode,
    ).toBe(429);
  });

  it("shares name changes only with authorized players without revising or projecting the match", async () => {
    const { whiteCookie, blackCookie, view } = await startedGame({ timeControl: "10+5" });
    const strangerCookie = await guest("Stranger");
    const address = await application.server.listen({ port: 0, host: "127.0.0.1" });
    const whiteSocket = await socketAt(address, whiteCookie);
    const blackSocket = await socketAt(address, blackCookie);
    const stranger = await socketAt(address, strangerCookie);
    gameViewSchema.parse(await subscribe(whiteSocket, view.game.id));
    gameViewSchema.parse(await subscribe(blackSocket, view.game.id));
    expect(await subscribe(stranger, view.game.id)).toMatchObject({ error: { code: "FORBIDDEN" } });
    const strangerProfiles: unknown[] = [];
    stranger.on("game:players", (payload: unknown) => strangerProfiles.push(payload));
    const previous = await database.transaction((tx) => tx.getGame(view.game.id));
    const projected = vi.spyOn(application.service, "publicView");
    const changes = [playersUpdated(whiteSocket), playersUpdated(blackSocket)];
    const renamed = await application.server.inject({
      method: "POST",
      url: "/api/session/name",
      headers: { origin, cookie: whiteCookie },
      payload: { displayName: "New White" },
    });
    expect(renamed.statusCode).toBe(200);
    const payload = {
      gameId: view.game.id,
      players: { white: { displayName: "New White" }, black: { displayName: "Black" } },
    };
    expect(await Promise.all(changes)).toEqual([payload, payload]);
    await application.tick();
    expect(projected).not.toHaveBeenCalled();
    expect(await database.transaction((tx) => tx.getGame(view.game.id))).toEqual(previous);
    expect(strangerProfiles).toEqual([]);
    const mine = await application.server.inject({
      method: "GET",
      url: `/api/games/${view.game.id}`,
      headers: { cookie: blackCookie },
    });
    expect(gameViewSchema.parse(mine.json()).game.players).toEqual(payload.players);
  });

  it("detects same-revision name changes across instances and restores them on reconnect", async () => {
    const { whiteCookie, blackCookie, view } = await startedGame();
    const secondDatabase = new Database(connectionString, { options: `-c search_path=${schema}` });
    extraDatabases.push(secondDatabase);
    const second = await buildApplication({
      database: secondDatabase,
      config: config(),
      logger: false,
      workers: false,
    });
    applications.push(second);
    const firstAddress = await application.server.listen({ port: 0, host: "127.0.0.1" });
    const secondAddress = await second.server.listen({ port: 0, host: "127.0.0.1" });
    const whiteSocket = await socketAt(firstAddress, whiteCookie);
    const blackSocket = await socketAt(secondAddress, blackCookie);
    gameViewSchema.parse(await subscribe(whiteSocket, view.game.id));
    gameViewSchema.parse(await subscribe(blackSocket, view.game.id));
    const projected = vi.spyOn(second.service, "publicView");
    const changes = [playersUpdated(whiteSocket), playersUpdated(blackSocket)];
    expect(
      (
        await application.server.inject({
          method: "POST",
          url: "/api/session/name",
          headers: { origin, cookie: whiteCookie },
          payload: { displayName: "Across instances" },
        })
      ).statusCode,
    ).toBe(200);
    await second.tick();
    const updates = await Promise.all(changes);
    expect(updates[0]).toEqual(updates[1]);
    expect(updates[0]?.players.white?.displayName).toBe("Across instances");
    expect(projected).not.toHaveBeenCalled();
    blackSocket.disconnect();
    const reconnected = await socketAt(secondAddress, blackCookie);
    const restored = gameViewSchema.parse(await subscribe(reconnected, view.game.id));
    expect(restored.game.revision).toBe(view.game.revision);
    expect(restored.game.players.white?.displayName).toBe("Across instances");
  });

  it("suppresses an older profile poll that finishes after a committed local rename", async () => {
    const { whiteCookie, view } = await startedGame();
    const address = await application.server.listen({ port: 0, host: "127.0.0.1" });
    const socket = await socketAt(address, whiteCookie);
    gameViewSchema.parse(await subscribe(socket, view.game.id));
    let signalReady: () => void = () => undefined;
    let release: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const profiles = application.service.profiles.bind(application.service);
    vi.spyOn(application.service, "profiles").mockImplementationOnce(async (ids, participant) => {
      const old = await profiles(ids, participant);
      signalReady();
      await released;
      return old;
    });
    const changes: unknown[] = [];
    socket.on("game:players", (payload: unknown) => changes.push(payload));
    const tick = application.tick();
    try {
      await ready;
      const change = playersUpdated(socket);
      const renamed = await application.server.inject({
        method: "POST",
        url: "/api/session/name",
        headers: { origin, cookie: whiteCookie },
        payload: { displayName: "Latest name" },
      });
      expect(renamed.statusCode).toBe(200);
      expect((await change).players.white?.displayName).toBe("Latest name");
    } finally {
      release();
      await tick;
    }
    await application.tick();
    expect(changes).toHaveLength(1);
  });

  it("does not publish an older remote name after a newer subscription snapshot", async () => {
    const { whiteCookie, view } = await startedGame();
    const address = await application.server.listen({ port: 0, host: "127.0.0.1" });
    const socket = await socketAt(address, whiteCookie);
    gameViewSchema.parse(await subscribe(socket, view.game.id));
    const actor = await application.service.session(whiteCookie.split("=")[1]);
    if (!actor) throw new Error("Guest session is missing.");
    // Direct service writes simulate another instance: this process must poll.
    await application.service.rename(actor, "Remote first name");
    let signalReady: () => void = () => undefined;
    let release: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const profiles = application.service.profiles.bind(application.service);
    vi.spyOn(application.service, "profiles").mockImplementationOnce(async (ids, participant) => {
      const old = await profiles(ids, participant);
      signalReady();
      await released;
      return old;
    });
    const changes: unknown[] = [];
    socket.on("game:players", (payload: unknown) => changes.push(payload));
    const tick = application.tick();
    try {
      await ready;
      await application.service.rename(actor, "Remote latest name");
      const change = playersUpdated(socket);
      const subscribed = gameViewSchema.parse(await subscribe(socket, view.game.id));
      expect(subscribed.game.players.white?.displayName).toBe("Remote latest name");
      expect((await change).players.white?.displayName).toBe("Remote latest name");
    } finally {
      release();
      await tick;
    }
    await application.tick();
    expect(changes).toHaveLength(1);
  });

  it("does not publish a name change when PostgreSQL rejects its commit", async () => {
    const { whiteCookie, view } = await startedGame();
    const address = await application.server.listen({ port: 0, host: "127.0.0.1" });
    const socket = await socketAt(address, whiteCookie);
    gameViewSchema.parse(await subscribe(socket, view.game.id));
    const changes: unknown[] = [];
    socket.on("game:players", (payload: unknown) => changes.push(payload));
    await database.pool.query(`CREATE FUNCTION reject_name_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic name commit failure'; END $$;
      CREATE CONSTRAINT TRIGGER name_commit_failure AFTER UPDATE ON player_sessions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_name_change()`);
    const renamed = await application.server.inject({
      method: "POST",
      url: "/api/session/name",
      headers: { origin, cookie: whiteCookie },
      payload: { displayName: "Uncommitted" },
    });
    expect(renamed.statusCode).toBe(503);
    await application.tick();
    expect(changes).toEqual([]);
    const session = await application.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: whiteCookie },
    });
    expect(session.json().session.displayName).toBe("White");
  });

  it("does not replace a joined player's name with an older waiting-room profile", async () => {
    const host = await guest("Host");
    const friend = await guest("Friend");
    const created = await create(host, application, "untimed", { visibility: "open" });
    const address = await application.server.listen({ port: 0, host: "127.0.0.1" });
    const socket = await socketAt(address, host);
    gameViewSchema.parse(await subscribe(socket, created.game.id));
    let signalReady: () => void = () => undefined;
    let release: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const profiles = application.service.profiles.bind(application.service);
    vi.spyOn(application.service, "profiles").mockImplementationOnce(async (ids, participant) => {
      const old = await profiles(ids, participant);
      signalReady();
      await released;
      return old;
    });
    const changes: unknown[] = [];
    socket.on("game:players", (payload: unknown) => changes.push(payload));
    const rename = application.server.inject({
      method: "POST",
      url: "/api/session/name",
      headers: { origin, cookie: host },
      payload: { displayName: "Renamed Host" },
    });
    try {
      await ready;
      const joinedGame = updated(socket, 1);
      const joined = await application.server.inject({
        method: "POST",
        url: `/api/lobbies/${created.game.id}/join`,
        headers: { origin, cookie: friend },
        payload: {},
      });
      expect(joined.statusCode).toBe(200);
      expect((await joinedGame).players.black?.displayName).toBe("Friend");
    } finally {
      release();
    }
    expect((await rename).statusCode).toBe(200);
    expect(changes).toEqual([]);
    const current = playersUpdated(socket);
    await application.tick();
    expect((await current).players).toEqual({
      white: { displayName: "Renamed Host" },
      black: { displayName: "Friend" },
    });
    expect(changes).toHaveLength(1);
  });

  it("publishes host closure immediately to subscribed host tabs and replays its original acknowledgement", async () => {
    const hostCookie = await guest("Host");
    const visitorCookie = await guest("Visitor");
    const created = await create(hostCookie, application, "10+5", { visibility: "open" });
    const address = await application.server.listen({ port: 0, host: "127.0.0.1" });
    const hostSocket = await socketAt(address, hostCookie);
    gameViewSchema.parse(await subscribe(hostSocket, created.game.id));
    const close: GameCommand = {
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: 0,
      action: { type: "close-room" },
    };
    expect((await postCommand(visitorCookie, created.game.id, close)).statusCode).toBe(403);
    const delivered = updated(hostSocket, 1);
    const response = await postCommand(hostCookie, created.game.id, close);
    expect(response.statusCode).toBe(200);
    const accepted = gameViewSchema.parse(response.json());
    expect((await delivered).closure?.reason).toBe("host-closed");
    expect(application.scheduler).toBeUndefined();
    expect(accepted.game.phase).toBe("finished");
    expect(accepted.game.outcome).toBeNull();
    expect((await postCommand(hostCookie, created.game.id, close)).json()).toEqual(accepted);
    expect(
      (await application.server.inject({ method: "GET", url: "/api/lobbies" })).json(),
    ).toEqual({ rooms: [] });
    const join = await application.server.inject({
      method: "POST",
      url: `/api/lobbies/${created.game.id}/join`,
      headers: { origin, cookie: visitorCookie },
      payload: {},
    });
    expect(join.statusCode).toBe(409);
    const refresh = await application.server.inject({
      method: "GET",
      url: `/api/games/${created.game.id}`,
      headers: { cookie: hostCookie },
    });
    expect(gameViewSchema.parse(refresh.json()).game.closure).toEqual(accepted.game.closure);
    const socketSnapshot = gameViewSchema.parse(await subscribe(hostSocket, created.game.id));
    expect(socketSnapshot.game.closure).toEqual(accepted.game.closure);
    const pgn = await application.server.inject({
      method: "GET",
      url: `/api/games/${created.game.id}/pgn`,
      headers: { cookie: hostCookie },
    });
    expect(pgn.statusCode).toBe(409);
    expect(pgn.json()).toMatchObject({ error: { code: "ROOM_CLOSED" } });
  });

  it("recovers expired open rooms on authorized HTTP reads and socket snapshots without workers", async () => {
    const hostCookie = await guest("Host");
    const visitorCookie = await guest("Visitor");
    const first = await create(hostCookie, application, "untimed", { visibility: "open" });
    const second = await create(hostCookie, application, "untimed", { visibility: "open" });
    await database.pool.query(
      "UPDATE matches SET created_at=clock_timestamp()-interval '1 hour' WHERE id=ANY($1::uuid[])",
      [[first.game.id, second.game.id]],
    );
    expect(
      (await application.server.inject({ method: "GET", url: "/api/lobbies" })).json(),
    ).toEqual({ rooms: [] });
    const denied = await application.server.inject({
      method: "GET",
      url: `/api/games/${first.game.id}`,
      headers: { cookie: visitorCookie },
    });
    expect(denied.statusCode).toBe(403);
    expect((await database.transaction((tx) => tx.getGame(first.game.id)))?.revision).toBe(0);
    const restored = await application.server.inject({
      method: "GET",
      url: `/api/games/${first.game.id}`,
      headers: { cookie: hostCookie },
    });
    expect(gameViewSchema.parse(restored.json()).game).toMatchObject({
      phase: "finished",
      revision: 1,
      closure: { reason: "expired" },
      outcome: null,
    });
    const address = await application.server.listen({ port: 0, host: "127.0.0.1" });
    const socket = await socketAt(address, hostCookie);
    expect(gameViewSchema.parse(await subscribe(socket, second.game.id)).game.closure?.reason).toBe(
      "expired",
    );
    for (const id of [first.game.id, second.game.id])
      expect(await database.transaction((tx) => tx.listEvents(id, 0))).toHaveLength(1);
  });

  it("schedules a persisted waiting-room deadline after worker restart without any sockets", async () => {
    const hostCookie = await guest("Host");
    const created = await create(hostCookie, application, "untimed", { visibility: "open" });
    await database.pool.query(
      "UPDATE matches SET created_at=clock_timestamp()-interval '1 hour'+interval '400 milliseconds' WHERE id=$1",
      [created.game.id],
    );
    const worker = await backgroundApplication();
    expect(worker.io.engine.clientsCount).toBe(0);
    await expect
      .poll(async () => (await database.transaction((tx) => tx.getGame(created.game.id)))?.status, {
        timeout: 5000,
        interval: 25,
      })
      .toBe("finished");
    const retained = await worker.service.publicView(created.game.id);
    expect(retained?.closure?.reason).toBe("expired");
    expect(retained?.outcome).toBeNull();
    expect(retained?.revision).toBe(1);
    expect(
      (await database.transaction((tx) => tx.getInvitation(tokenHash(created.invitation.token))))
        ?.consumedAt,
    ).toBeNull();
  });

  it("wakes an idle worker for newly created waiting rooms and uses their earliest host bound", async () => {
    const worker = await backgroundApplication();
    const hostCookie = await guest("Host", worker);
    const host = await worker.service.session(hostCookie.split("=")[1]);
    if (!host) throw new Error("Host is missing.");
    await database.pool.query(
      "UPDATE player_sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1",
      [host.id],
    );
    const created = await create(hostCookie, worker, "untimed", { visibility: "open" });
    await worker.scheduler?.settled();
    expect(worker.io.engine.clientsCount).toBe(0);
    await expect
      .poll(async () => (await database.transaction((tx) => tx.getGame(created.game.id)))?.status, {
        timeout: 5000,
        interval: 25,
      })
      .toBe("finished");
    expect((await worker.service.publicView(created.game.id))?.closure?.reason).toBe("expired");
    const queries = vi.spyOn(database.pool, "query");
    const transactions = vi.spyOn(database, "transaction");
    await worker.scheduler?.settled();
    queries.mockClear();
    transactions.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(queries).not.toHaveBeenCalled();
    expect(transactions).not.toHaveBeenCalled();
    expect(OPEN_ROOM_LIFETIME_MS).toBe(3600000);
  });

  it("limits one background tick to a hundred overdue room closures even when retention is due", async () => {
    const hostCookie = await guest("Host");
    const created = await create(hostCookie, application, "untimed", { visibility: "open" });
    await database.transaction(async (tx) => {
      const template = await tx.getGame(created.game.id);
      const host = (await tx.listSeats(created.game.id))[0];
      if (!template || !host) throw new Error("Room is missing.");
      for (let index = 0; index < 100; index += 1) {
        const game = { ...template, id: randomUUID() };
        await tx.createGame(game);
        await tx.addSeat({ gameId: game.id, color: "white", sessionId: host.sessionId });
      }
      await tx.client.query("UPDATE matches SET created_at=clock_timestamp()-interval '1 hour'");
    });
    await application.tick();
    const statuses = async () =>
      (
        await database.pool.query<{ status: string; count: string }>(
          "SELECT status,count(*)::text FROM matches GROUP BY status ORDER BY status",
        )
      ).rows;
    expect(await statuses()).toEqual([
      { status: "finished", count: "100" },
      { status: "waiting", count: "1" },
    ]);
    await application.tick();
    expect(await statuses()).toEqual([{ status: "finished", count: "101" }]);
  });

  it("leaves PostgreSQL unused while idle and answers liveness probes without database reads", async () => {
    const worker = await backgroundApplication();
    const queries = vi.spyOn(database.pool, "query");
    const transactions = vi.spyOn(database, "transaction");
    for (let probe = 0; probe < 3; probe += 1) {
      expect((await worker.server.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(
        200,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(queries).not.toHaveBeenCalled();
    expect(transactions).not.toHaveBeenCalled();
  });

  it("processes a persisted clock deadline without sockets after worker startup", async () => {
    const { view } = await startedGame();
    await database.pool.query(
      `UPDATE matches SET lifecycle=lifecycle || jsonb_build_object(
      'timeControl','5+0','remaining',jsonb_build_object('white',300,'black',300000),
      'turnStartedAt',floor(extract(epoch FROM clock_timestamp())*1000)::bigint,
      'deadlineAt',floor(extract(epoch FROM clock_timestamp())*1000)::bigint+300) WHERE id=$1`,
      [view.game.id],
    );
    const worker = await backgroundApplication();
    expect(worker.io.engine.clientsCount).toBe(0);
    await expect
      .poll(
        async () => {
          const result = await database.pool.query<{ status: string }>(
            "SELECT status FROM matches WHERE id=$1",
            [view.game.id],
          );
          return result.rows[0]?.status;
        },
        { timeout: 5_000, interval: 25 },
      )
      .toBe("finished");
    const result = await database.pool.query<{
      lifecycle: { outcome: { winner: string; reason: string } };
    }>("SELECT lifecycle FROM matches WHERE id=$1", [view.game.id]);
    expect(result.rows[0]?.lifecycle.outcome).toEqual({ winner: "black", reason: "timeout" });
  });

  it("reschedules an idle worker when an HTTP join starts a timed game", async () => {
    const worker = await backgroundApplication();
    const whiteCookie = await guest("White", worker);
    const blackCookie = await guest("Black", worker);
    const created = await create(whiteCookie, worker, "5+0");
    await worker.scheduler?.settled();
    await database.pool.query(
      "UPDATE matches SET lifecycle=jsonb_set(lifecycle,'{remaining,white}','300'::jsonb) WHERE id=$1",
      [created.game.id],
    );
    const joined = await worker.server.inject({
      method: "POST",
      url: "/api/invitations/join",
      headers: { origin, cookie: blackCookie },
      payload: { token: created.invitation.token },
    });
    expect(joined.statusCode).toBe(200);
    await worker.scheduler?.settled();
    expect(worker.io.engine.clientsCount).toBe(0);
    await expect
      .poll(
        async () => {
          const result = await database.pool.query<{ status: string }>(
            "SELECT status FROM matches WHERE id=$1",
            [created.game.id],
          );
          return result.rows[0]?.status;
        },
        { timeout: 5_000, interval: 25 },
      )
      .toBe("finished");
  });

  it("polls real subscribed games and stops database polling after the last socket disconnects", async () => {
    const { whiteCookie, view } = await startedGame();
    const worker = await backgroundApplication();
    const address = await worker.server.listen({ port: 0, host: "127.0.0.1" });
    const socket = await socketAt(address, whiteCookie);
    gameViewSchema.parse(await subscribe(socket, view.game.id));
    await worker.scheduler?.settled();
    const queries = vi.spyOn(database.pool, "query");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(queries.mock.calls.length).toBeGreaterThanOrEqual(2);
    socket.disconnect();
    await expect
      .poll(() => worker.io.sockets.sockets.size, { timeout: 2_000, interval: 10 })
      .toBe(0);
    await worker.scheduler?.settled();
    queries.mockClear();
    const transactions = vi.spyOn(database, "transaction");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(queries).not.toHaveBeenCalled();
    expect(transactions).not.toHaveBeenCalled();
  });

  it("requires an allowed origin for mutations and does not create sessions for rejected origins", async () => {
    for (const headers of [
      {},
      { origin: "https://untrusted.example" },
      { origin, "sec-fetch-site": "cross-site" },
    ]) {
      const response = await application.server.inject({
        method: "POST",
        url: "/api/session",
        headers,
        payload: { displayName: "Friend" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "ORIGIN_REJECTED" } });
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    const result = await database.pool.query<{ count: string }>(
      "SELECT count(*) FROM player_sessions",
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("validates signed Catchess settings and supplies defaults at the HTTP boundary", async () => {
    const cookie = await guest("Host");
    for (const payload of [
      { rulesetId: "catchess", catchess: { host: -101, guest: 0 } },
      { rulesetId: "catchess", catchess: { host: 0, guest: 101 } },
      { rulesetId: "catchess", catchess: { host: 1.5, guest: 0 } },
      { rulesetId: "catchess", catchess: { host: "25", guest: 0 } },
      { rulesetId: "catchess", catchess: { host: 0, guest: 0, draw: "0".repeat(64) } },
      { rulesetId: "standard", catchess: { host: 25, guest: 25 } },
    ]) {
      const response = await application.server.inject({
        method: "POST",
        url: "/api/games",
        headers: { origin, cookie },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    const created = await create(cookie, application, "untimed", { rulesetId: "catchess" });
    expect(created.game.catchess).toEqual({ white: 25, black: 25 });
    expect(created.game.position.catEffects).toEqual([]);
  });

  it("rejects client entropy and broadcasts authoritative Catchess effects across instances and reconnects", async () => {
    const { whiteCookie, blackCookie, view } = await startedGame({
      rulesetId: "catchess",
      catchess: { host: 100, guest: -100 },
    });
    const secondDatabase = new Database(connectionString, { options: `-c search_path=${schema}` });
    extraDatabases.push(secondDatabase);
    const second = await buildApplication({
      database: secondDatabase,
      config: config(),
      logger: false,
      workers: false,
    });
    applications.push(second);
    const addressOne = await application.server.listen({ port: 0, host: "127.0.0.1" });
    const addressTwo = await second.server.listen({ port: 0, host: "127.0.0.1" });
    const whiteSocket = await socketAt(addressOne, whiteCookie);
    const blackSocket = await socketAt(addressTwo, blackCookie);
    expect(gameViewSchema.parse(await subscribe(whiteSocket, view.game.id)).game.catchess).toEqual({
      white: 100,
      black: -100,
    });
    gameViewSchema.parse(await subscribe(blackSocket, view.game.id));
    const move: GameCommand = {
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: 1,
      action: { type: "move", from: "e2", to: "e4" },
    };
    for (const payload of [
      { ...move, serverDraw: "0".repeat(64) },
      { ...move, action: { ...move.action, draw: "0".repeat(64) } },
      { ...move, catTurns: [{ draw: "0".repeat(64), effect: { action: "none" } }] },
    ]) {
      const response = await application.server.inject({
        method: "POST",
        url: `/api/games/${view.game.id}/commands`,
        headers: { origin, cookie: whiteCookie },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    const whiteUpdate = updated(whiteSocket, 2);
    const blackUpdate = updated(blackSocket, 2);
    const response = await postCommand(whiteCookie, view.game.id, move);
    expect(response.statusCode).toBe(200);
    const accepted = gameViewSchema.parse(response.json());
    await application.tick();
    await second.tick();
    const received = await Promise.all([whiteUpdate, blackUpdate]);
    for (const update of received) {
      const game = publicGameSchema.parse(update);
      expect(game.position.fen).toBe(accepted.game.position.fen);
      expect(game.position.board).toEqual(accepted.game.position.board);
      expect(game.position.board).toHaveLength(33);
      expect(game.position.catEffects).toEqual(accepted.game.position.catEffects);
      expect(game.position.catEffects?.[0]).toMatchObject({
        ply: 1,
        color: "white",
        action: "add",
      });
    }
    expect(received[0]).toEqual(received[1]);
    blackSocket.disconnect();
    const laterResponse = await postCommand(
      blackCookie,
      view.game.id,
      {
        protocolVersion: 1,
        commandId: randomUUID(),
        expectedRevision: 2,
        action: { type: "move", from: "e7", to: "e5" },
      },
      second,
    );
    expect(laterResponse.statusCode).toBe(200);
    const later = gameViewSchema.parse(laterResponse.json());
    expect(later.game.position.board).toHaveLength(32);
    expect(later.game.position.catEffects?.[1]).toMatchObject({
      ply: 2,
      color: "black",
      action: "remove",
    });
    expect(
      gameViewSchema.parse((await postCommand(whiteCookie, view.game.id, move)).json()),
    ).toEqual(accepted);
    const reconnected = await socketAt(addressTwo, blackCookie);
    const restored = gameViewSchema.parse(await subscribe(reconnected, view.game.id));
    expect(restored.game.position).toEqual(later.game.position);
    expect(restored.game.catchess).toEqual({ white: 100, black: -100 });
  });

  it.each(["standard", "three-check"] as const)(
    "preserves the strict protocol-one $0 HTTP, socket and receipt shapes",
    async (rulesetId) => {
      const { whiteCookie, blackCookie, view } = await startedGame({ rulesetId });
      previousViewSchema.parse(view);
      const address = await application.server.listen({ port: 0, host: "127.0.0.1" });
      const socket = await socketAt(address, whiteCookie);
      previousViewSchema.parse(await subscribe(socket, view.game.id));
      const firstMove: GameCommand = {
        protocolVersion: 1,
        commandId: randomUUID(),
        expectedRevision: 1,
        action: { type: "move", from: "e2", to: "e4" },
      };
      const update = updated(socket, 2);
      const acceptedResponse = await postCommand(whiteCookie, view.game.id, firstMove);
      expect(acceptedResponse.statusCode).toBe(200);
      const accepted = previousViewSchema.parse(acceptedResponse.json());
      await application.tick();
      previousGameSchema.parse(await update);
      expect(
        (
          await postCommand(blackCookie, view.game.id, {
            protocolVersion: 1,
            commandId: randomUUID(),
            expectedRevision: 2,
            action: { type: "move", from: "e7", to: "e5" },
          })
        ).statusCode,
      ).toBe(200);
      const retryResponse = await postCommand(whiteCookie, view.game.id, firstMove);
      expect(retryResponse.statusCode).toBe(200);
      const retry = previousViewSchema.parse(retryResponse.json());
      expect(retry).toStrictEqual(accepted);
      const receipts = await database.pool.query<{ acknowledgement: unknown }>(
        "SELECT acknowledgement FROM command_receipts WHERE match_id=$1 AND command_id=$2",
        [view.game.id, firstMove.commandId],
      );
      expect(receipts.rows[0]?.acknowledgement).toStrictEqual(accepted);
      const restoredResponse = await application.server.inject({
        method: "GET",
        url: `/api/games/${view.game.id}`,
        headers: { cookie: whiteCookie },
      });
      expect(previousViewSchema.parse(restoredResponse.json()).game.revision).toBe(3);
    },
  );

  it("issues an HttpOnly guest cookie, retains identity and redacts internal session fields", async () => {
    const response = await application.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: { displayName: "  Friend  " },
    });
    expect(response.statusCode).toBe(200);
    const header = response.headers["set-cookie"];
    const raw = Array.isArray(header) ? header[0] : header;
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Lax");
    expect(raw).toContain("Path=/");
    const cookie = raw?.split(";")[0];
    if (!cookie) throw new Error("Cookie is missing.");
    expect(response.json().session.displayName).toBe("Friend");
    expect(Object.keys(response.json().session).sort()).toEqual(["displayName", "expiresAt"]);
    const restored = await application.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie },
    });
    expect(restored.json()).toEqual(response.json());
    const repeated = await application.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin, cookie },
      payload: { displayName: "Another name" },
    });
    expect(repeated.json()).toEqual(response.json());
  });

  it("uses a Secure host-only cookie for an HTTPS configuration", async () => {
    const app = await buildApplication({
      database,
      config: config(true),
      logger: false,
      workers: false,
    });
    applications.push(app);
    const response = await app.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "https://chess.example" },
      payload: { displayName: "Friend" },
    });
    const header = response.headers["set-cookie"];
    const raw = Array.isArray(header) ? header[0] : header;
    expect(raw).toMatch(/^__Host-chess_session=/);
    expect(raw).toContain("Secure");
    expect(raw).toContain("HttpOnly");
    expect(raw).not.toContain("Domain=");
  });

  it("rejects missing, forged and expired guest sessions at protected routes", async () => {
    for (const cookie of [undefined, "chess_session=forged"]) {
      const response = await application.server.inject({
        method: "POST",
        url: "/api/games",
        headers: { origin, ...(cookie ? { cookie } : {}) },
        payload: {},
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "SESSION_REQUIRED" } });
    }
    const { whiteCookie, view } = await startedGame();
    const token = whiteCookie.split("=")[1];
    if (!token) throw new Error("Session token is missing.");
    await database.pool.query(
      "UPDATE player_sessions SET created_at=clock_timestamp()-interval '2 seconds', expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
      [tokenHash(token)],
    );
    const response = await application.server.inject({
      method: "GET",
      url: `/api/games/${view.game.id}`,
      headers: { cookie: whiteCookie },
    });
    expect(response.statusCode).toBe(401);
    const session = await application.server.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie: whiteCookie },
    });
    expect(session.json()).toEqual({ session: null });
  });

  it("rejects strict-schema extras, malformed JSON, bad identifiers and oversized payloads", async () => {
    const cookie = await guest("Friend");
    for (const payload of [
      { color: "white", winner: "white" },
      { rulesetId: "untrusted-script" },
      { timeControl: "-1+0" },
    ]) {
      const response = await application.server.inject({
        method: "POST",
        url: "/api/games",
        headers: { origin, cookie },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    }
    const malformed = await application.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin, "content-type": "application/json" },
      payload: "{",
    });
    expect(malformed.statusCode).toBe(400);
    const oversized = await application.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: { displayName: "x".repeat(20_000) },
    });
    expect(oversized.statusCode).toBe(413);
    const badId = await application.server.inject({
      method: "GET",
      url: "/api/games/not-a-uuid",
      headers: { cookie },
    });
    expect(badId.statusCode).toBe(400);
    const invalidName = await application.server.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: { displayName: "Friend\u0000" },
    });
    expect(invalidName.statusCode).toBe(400);
  });

  it("denies room access and commands to a third guest even with a known game locator", async () => {
    const { view } = await startedGame();
    const stranger = await guest("Stranger");
    const response = await application.server.inject({
      method: "GET",
      url: `/api/games/${view.game.id}`,
      headers: { cookie: stranger },
    });
    expect(response.statusCode).toBe(403);
    const move = await postCommand(stranger, view.game.id, {
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: 1,
      action: { type: "resign" },
    });
    expect(move.statusCode).toBe(403);
    expect(move.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(move.body).not.toContain(view.game.position.fen);
  });

  it("separates liveness from database readiness and sends browser protection headers", async () => {
    const healthy = await application.server.inject({ method: "GET", url: "/api/ready" });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.headers["x-content-type-options"]).toBe("nosniff");
    expect(healthy.headers["referrer-policy"]).toBe("no-referrer");
    expect(healthy.headers["cache-control"]).toBe("no-store");
    expect(healthy.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    await database.pool.query("DROP TABLE matches CASCADE");
    expect((await application.server.inject({ method: "GET", url: "/api/ready" })).statusCode).toBe(
      503,
    );
    expect(
      (await application.server.inject({ method: "GET", url: "/api/health" })).statusCode,
    ).toBe(200);
  });

  it("exits cleanly with sanitized diagnostics when its listen port is already occupied", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("Occupied port is unavailable.");
    const databaseUrl = new URL(connectionString);
    databaseUrl.searchParams.set("options", `-c search_path=${schema}`);
    const child = spawn(process.execPath, ["--import", "tsx", "apps/server/src/main.ts"], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl.toString(),
        HOST: "127.0.0.1",
        PORT: String(address.port),
        WEB_ORIGIN: origin,
        SERVE_WEB: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exitCode = await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Failed startup retained active workers.")),
            5_000,
          );
        }),
      ]);
      expect(exitCode).toBe(1);
      expect(output).toContain("Server failed to start.");
      if (databaseUrl.password) expect(output).not.toContain(databaseUrl.password);
      expect(output).not.toContain(connectionString);
    } finally {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 10_000);

  it("rejects unauthenticated and wrong-origin real socket handshakes", async () => {
    const address = await application.server.listen({ port: 0, host: "127.0.0.1" });
    const cookie = await guest("Friend");
    await expect(socketAt(address)).rejects.toMatchObject({ message: "SESSION_REQUIRED" });
    await expect(socketAt(address, cookie, "https://untrusted.example")).rejects.toThrow();
  });

  it("revalidates guest expiry for each subscription and bounds oversized realtime input", async () => {
    const { whiteCookie, view } = await startedGame();
    const address = await application.server.listen({ port: 0, host: "127.0.0.1" });
    const socket = await socketAt(address, whiteCookie);
    gameViewSchema.parse(await subscribe(socket, view.game.id));
    const token = whiteCookie.split("=")[1];
    if (!token) throw new Error("Session token is missing.");
    await database.pool.query(
      "UPDATE player_sessions SET created_at=clock_timestamp()-interval '2 seconds', expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
      [tokenHash(token)],
    );
    expect(await subscribe(socket, view.game.id)).toMatchObject({
      error: { code: "SESSION_REQUIRED" },
    });
    const disconnected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Oversized socket was not closed.")), 3_000);
      socket.once("disconnect", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    socket.emit("game:subscribe", { gameId: view.game.id, extra: "x".repeat(20_000) }, () => {});
    await disconnected;
    expect(socket.connected).toBe(false);
  });

  it("bounds simultaneous realtime connections per guest", async () => {
    const cookie = await guest("Friend");
    const address = await application.server.listen({ port: 0, host: "127.0.0.1" });
    const connected = await Promise.all(Array.from({ length: 8 }, () => socketAt(address, cookie)));
    expect(connected.every((socket) => socket.connected)).toBe(true);
    await expect(socketAt(address, cookie)).rejects.toMatchObject({ message: "CONNECTION_LIMIT" });
  });

  it.each(["standard", "catchess"] as const)(
    "sends no success or uncommitted $0 socket update when PostgreSQL rejects the commit",
    async (rulesetId) => {
      const { whiteCookie, view } = await startedGame({
        rulesetId,
        ...(rulesetId === "catchess" ? { catchess: { host: 100, guest: 0 } } : {}),
      });
      const address = await application.server.listen({ port: 0, host: "127.0.0.1" });
      const socket = await socketAt(address, whiteCookie);
      gameViewSchema.parse(await subscribe(socket, view.game.id));
      const updates: PublicGame[] = [];
      socket.on("game:updated", (game: PublicGame) => updates.push(game));
      // A deferred foreign key rejects COMMIT, after the snapshot/event/receipt writes ran.
      await database.pool.query(`CREATE TABLE commit_targets (id uuid PRIMARY KEY);
      ALTER TABLE command_receipts ADD CONSTRAINT reject_commit
      FOREIGN KEY (match_id) REFERENCES commit_targets (id) DEFERRABLE INITIALLY DEFERRED`);
      const response = await postCommand(whiteCookie, view.game.id, {
        protocolVersion: 1,
        commandId: randomUUID(),
        expectedRevision: 1,
        action: { type: "move", from: "e2", to: "e4" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: {
          code: "UNAVAILABLE",
          message: "The service is temporarily unavailable. Please retry.",
        },
      });
      await application.tick();
      const currentResponse = await application.server.inject({
        method: "GET",
        url: `/api/games/${view.game.id}`,
        headers: { cookie: whiteCookie },
      });
      const current = gameViewSchema.parse(currentResponse.json());
      expect(current.game.revision).toBe(1);
      expect(current.game.position.moves).toEqual([]);
      if (rulesetId === "catchess") expect(current.game.position.catEffects).toEqual([]);
      else expect(current.game.position).not.toHaveProperty("catEffects");
      expect(current.game.position.board).toHaveLength(32);
      expect(updates).toEqual([]);
      expect(await database.transaction((tx) => tx.listEvents(view.game.id, 1))).toEqual([]);
    },
  );

  it("delivers a committed join to the waiting host without a worker cycle", async () => {
    const whiteCookie = await guest("White");
    const blackCookie = await guest("Black");
    const created = await create(whiteCookie);
    const address = await application.server.listen({ port: 0, host: "127.0.0.1" });
    const whiteSocket = await socketAt(address, whiteCookie);
    gameViewSchema.parse(await subscribe(whiteSocket, created.game.id));
    const update = updated(whiteSocket, 1);
    const response = await application.server.inject({
      method: "POST",
      url: "/api/invitations/join",
      headers: { origin, cookie: blackCookie },
      payload: { token: created.invitation.token },
    });
    expect(response.statusCode).toBe(200);
    expect(await update).toEqual(gameViewSchema.parse(response.json()).game);
    expect(application.scheduler).toBeUndefined();
  });

  it("delivers accepted moves to both players without polling and suppresses retry or rejected broadcasts", async () => {
    const { whiteCookie, blackCookie, view } = await startedGame({
      rulesetId: "catchess",
      catchess: { host: 100, guest: -100 },
    });
    const strangerCookie = await guest("Stranger");
    const address = await application.server.listen({ port: 0, host: "127.0.0.1" });
    const whiteSocket = await socketAt(address, whiteCookie);
    const blackSocket = await socketAt(address, blackCookie);
    const strangerSocket = await socketAt(address, strangerCookie);
    gameViewSchema.parse(await subscribe(whiteSocket, view.game.id));
    gameViewSchema.parse(await subscribe(blackSocket, view.game.id));
    expect(await subscribe(strangerSocket, view.game.id)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    const strangerUpdates: PublicGame[] = [];
    strangerSocket.on("game:updated", (game: PublicGame) => strangerUpdates.push(game));
    const broadcasts = vi.spyOn(application.io, "to");
    const projections = vi.spyOn(application.service, "publicView");
    const command: GameCommand = {
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: 1,
      action: { type: "move", from: "e2", to: "e4" },
    };
    const firstUpdates = [updated(whiteSocket, 2), updated(blackSocket, 2)];
    const response = await postCommand(whiteCookie, view.game.id, command);
    const accepted = gameViewSchema.parse(response.json());
    expect(response.statusCode).toBe(200);
    expect(await Promise.all(firstUpdates)).toEqual([accepted.game, accepted.game]);
    expect(accepted.game.position.catEffects?.[0]?.action).toBe("add");
    expect(application.scheduler).toBeUndefined();
    expect(projections).not.toHaveBeenCalled();

    const secondUpdates = [updated(whiteSocket, 3), updated(blackSocket, 3)];
    const next = await postCommand(blackCookie, view.game.id, {
      ...command,
      commandId: randomUUID(),
      expectedRevision: 2,
      action: { type: "move", from: "e7", to: "e5" },
    });
    const second = gameViewSchema.parse(next.json());
    expect(next.statusCode).toBe(200);
    expect(await Promise.all(secondUpdates)).toEqual([second.game, second.game]);
    expect(second.game.position.catEffects?.[1]?.action).toBe("remove");
    expect(
      gameViewSchema.parse((await postCommand(whiteCookie, view.game.id, command)).json()),
    ).toEqual(accepted);
    expect((await postCommand(strangerCookie, view.game.id, command)).statusCode).toBe(403);
    expect(
      (
        await postCommand(blackCookie, view.game.id, {
          ...command,
          commandId: randomUUID(),
          expectedRevision: 3,
        })
      ).statusCode,
    ).toBe(409);
    await application.tick();
    expect(broadcasts).toHaveBeenCalledTimes(2);
    expect(strangerUpdates).toEqual([]);
  });

  it("does not broadcast an older polling projection after a newer local move", async () => {
    const { whiteCookie, blackCookie, view } = await startedGame();
    const address = await application.server.listen({ port: 0, host: "127.0.0.1" });
    const socket = await socketAt(address, whiteCookie);
    gameViewSchema.parse(await subscribe(socket, view.game.id));
    const session = await application.service.session(whiteCookie.split("=")[1]);
    if (!session) throw new Error("Guest session is missing.");
    // Simulate a commit from another instance that this process must discover by polling.
    await application.service.command(session, view.game.id, {
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: 1,
      action: { type: "move", from: "e2", to: "e4" },
    });
    let signalReady: () => void = () => undefined;
    let releaseProjection: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    const project = application.service.publicView.bind(application.service);
    vi.spyOn(application.service, "publicView").mockImplementationOnce(async (id) => {
      const old = await project(id);
      signalReady();
      await released;
      return old;
    });
    const broadcasts = vi.spyOn(application.io, "to");
    const tick = application.tick();
    try {
      await ready;
      const update = updated(socket, 3);
      const response = await postCommand(blackCookie, view.game.id, {
        protocolVersion: 1,
        commandId: randomUUID(),
        expectedRevision: 2,
        action: { type: "move", from: "e7", to: "e5" },
      });
      expect(response.statusCode).toBe(200);
      expect(await update).toEqual(gameViewSchema.parse(response.json()).game);
    } finally {
      releaseProjection();
      await tick;
    }
    expect(broadcasts).toHaveBeenCalledTimes(1);
    await application.tick();
    expect(broadcasts).toHaveBeenCalledTimes(1);
  });

  it("fans committed state across two instances, authorizes subscriptions and resyncs after reconnect", async () => {
    const { whiteCookie, blackCookie, view } = await startedGame();
    const strangerCookie = await guest("Stranger");
    const secondDatabase = new Database(connectionString, { options: `-c search_path=${schema}` });
    extraDatabases.push(secondDatabase);
    const second = await buildApplication({
      database: secondDatabase,
      config: config(),
      logger: false,
      workers: false,
    });
    applications.push(second);
    const addressOne = await application.server.listen({ port: 0, host: "127.0.0.1" });
    const addressTwo = await second.server.listen({ port: 0, host: "127.0.0.1" });
    const whiteSocket = await socketAt(addressOne, whiteCookie);
    const blackSocket = await socketAt(addressTwo, blackCookie);
    const strangerSocket = await socketAt(addressTwo, strangerCookie);
    expect(gameViewSchema.parse(await subscribe(whiteSocket, view.game.id)).seat).toBe("white");
    expect(gameViewSchema.parse(await subscribe(blackSocket, view.game.id)).seat).toBe("black");
    expect(await subscribe(strangerSocket, view.game.id)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    const strangerUpdates: PublicGame[] = [];
    strangerSocket.on("game:updated", (game: PublicGame) => strangerUpdates.push(game));
    const firstMove: GameCommand = {
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: 1,
      action: { type: "move", from: "e2", to: "e4" },
    };
    const whiteUpdate = updated(whiteSocket, 2);
    const blackUpdate = updated(blackSocket, 2);
    expect((await postCommand(whiteCookie, view.game.id, firstMove)).statusCode).toBe(200);
    await application.tick();
    await second.tick();
    const received = await Promise.all([whiteUpdate, blackUpdate]);
    expect(received[0]).toEqual(received[1]);
    expect(received[0]?.position.moves).toHaveLength(1);
    expect(strangerUpdates).toEqual([]);
    blackSocket.disconnect();
    expect(
      (
        await postCommand(
          blackCookie,
          view.game.id,
          {
            protocolVersion: 1,
            commandId: randomUUID(),
            expectedRevision: 2,
            action: { type: "move", from: "e7", to: "e5" },
          },
          second,
        )
      ).statusCode,
    ).toBe(200);
    await second.tick();
    const reconnected = await socketAt(addressTwo, blackCookie);
    const restored = gameViewSchema.parse(await subscribe(reconnected, view.game.id));
    expect(restored.game.revision).toBe(3);
    expect(restored.game.position.moves).toHaveLength(2);
    const malformed = await reconnected
      .timeout(2_000)
      .emitWithAck("game:subscribe", { gameId: view.game.id, sessionId: randomUUID() });
    expect(malformed).toMatchObject({ error: { code: "SUBSCRIBE_FAILED" } });
  });
});
