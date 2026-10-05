import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { type GameCommand, gameViewSchema, type PublicGame } from "@chess-room/contracts";
import { Pool } from "pg";
import { io as connectSocket, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../storage/database.js";
import { migrate } from "../storage/migrations.js";
import { tokenHash } from "./games.js";
import { buildApplication } from "./server.js";

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString)
  throw new Error("A PostgreSQL URL is required for transport integration tests.");
const origin = "http://127.0.0.1:5173";
type Application = Awaited<ReturnType<typeof buildApplication>>;

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

  async function create(cookie: string) {
    const response = await application.server.inject({
      method: "POST",
      url: "/api/games",
      headers: { origin, cookie },
      payload: { rulesetId: "standard", color: "white", timeControl: "untimed" },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ game: PublicGame; invitation: { token: string } }>();
  }

  async function startedGame() {
    const whiteCookie = await guest("White");
    const blackCookie = await guest("Black");
    const created = await create(whiteCookie);
    const joined = await application.server.inject({
      method: "POST",
      url: "/api/invitations/join",
      headers: { origin, cookie: blackCookie },
      payload: { token: created.invitation.token },
    });
    expect(joined.statusCode).toBe(200);
    return { whiteCookie, blackCookie, view: gameViewSchema.parse(joined.json()) };
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

  it("sends no success or uncommitted socket update when PostgreSQL rejects the commit", async () => {
    const { whiteCookie, view } = await startedGame();
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
    expect(updates).toEqual([]);
    expect(await database.transaction((tx) => tx.listEvents(view.game.id, 1))).toEqual([]);
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
    expect((await postCommand(whiteCookie, view.game.id, firstMove)).statusCode).toBe(200);
    const whiteUpdate = updated(whiteSocket, 2);
    const blackUpdate = updated(blackSocket, 2);
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
