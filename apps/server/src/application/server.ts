import { fileURLToPath } from "node:url";
import {
  createGameSchema,
  gameCommandSchema,
  guestSessionSchema,
  joinInvitationSchema,
} from "@chess-room/contracts";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import type { FastifyRequest } from "fastify";
import { Server as SocketServer } from "socket.io";
import { z } from "zod";
import { buildServer } from "../server.js";
import type { Database } from "../storage/database.js";
import type { SessionRecord } from "../storage/records.js";
import { BackgroundScheduler } from "./background.js";
import type { ApplicationConfig } from "./config.js";
import { ApplicationError, errorBody } from "./errors.js";
import { GameService, SESSION_LIFETIME } from "./games.js";
import { RuntimeMetrics } from "./metrics.js";
import { rateLimit } from "./rate-limit.js";

const idSchema = z.uuid();
const subscriptionSchema = z.object({ gameId: idSchema }).strict();

export async function buildApplication(options: {
  database: Database;
  config: ApplicationConfig;
  logger?: boolean;
  workers?: boolean;
  service?: GameService;
}) {
  const { database, config } = options;
  const server = buildServer({
    logger: options.logger ?? true,
    ...(config.trustProxy ? { trustProxy: config.trustProxy } : {}),
  });
  const service = options.service ?? new GameService(database);
  const metrics = new RuntimeMetrics();
  let scheduler: BackgroundScheduler | undefined;
  const requestStarts = new WeakMap<FastifyRequest, number>();
  const cookieName = config.secureCookies ? "__Host-chess_session" : "chess_session";
  await server.register(cookie);
  server.addHook("onRequest", async (request, reply) => {
    requestStarts.set(request, performance.now());
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (request.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (
      (mutation && request.headers.origin !== config.webOrigin) ||
      (request.headers.origin && request.headers.origin !== config.webOrigin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    )
      throw new ApplicationError("ORIGIN_REJECTED", "Request origin is not allowed.", 403);
    if (request.url.startsWith("/api/") && !["/api/health", "/api/ready"].includes(request.url)) {
      await rateLimit(database, `http:${request.ip}`, 600);
    }
  });
  server.addHook("onResponse", async (request, reply) => {
    metrics.requests += 1;
    metrics.requestDuration.add(
      performance.now() - (requestStarts.get(request) ?? performance.now()),
    );
    const route = request.routeOptions.url;
    if (
      request.method === "POST" &&
      ["/api/games", "/api/invitations/join", "/api/games/:id/commands"].includes(route ?? "") &&
      (reply.statusCode < 400 || reply.statusCode === 409)
    ) {
      scheduler?.wake();
    }
  });

  server.setErrorHandler((error, request, reply) => {
    const details = error as { code?: string; statusCode?: number };
    if (error instanceof ApplicationError) return reply.code(error.status).send(errorBody(error));
    if (
      error instanceof z.ZodError ||
      details.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
      details.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
    )
      return reply
        .code(400)
        .send({ error: { code: "INVALID_INPUT", message: "Request data is invalid." } });
    if (details.statusCode === 413)
      return reply
        .code(413)
        .send({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request exceeds the size limit." } });
    server.log.error({ requestId: request.id, code: "request-failed" }, "Request failed");
    return reply.code(503).send({
      error: {
        code: "UNAVAILABLE",
        message: "The service is temporarily unavailable. Please retry.",
      },
    });
  });
  server.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "Resource not found." } }),
  );

  const actor = async (request: FastifyRequest): Promise<SessionRecord> => {
    const session = await service.session(request.cookies[cookieName]);
    if (!session)
      throw new ApplicationError(
        "SESSION_REQUIRED",
        "Your guest session has expired. Please enter your name again.",
        401,
      );
    return session;
  };
  const gameId = (request: FastifyRequest) => idSchema.parse((request.params as { id: string }).id);
  server.get("/api/ready", async (_request, reply) => {
    const ready = await database.ready();
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "unavailable" });
  });
  server.get("/api/session", async (request) => {
    const session = await service.session(request.cookies[cookieName]);
    return { session: session ? service.sessionView(session) : null };
  });
  server.post("/api/session", { bodyLimit: 16_384 }, async (request, reply) => {
    const input = guestSessionSchema.parse(request.body);
    await rateLimit(database, `session:${request.ip}`, 20);
    const existing = await service.session(request.cookies[cookieName]);
    if (existing) return { session: service.sessionView(existing) };
    const created = await service.createSession(input.displayName);
    reply.setCookie(cookieName, created.token, {
      path: "/",
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: "lax",
      maxAge: SESSION_LIFETIME / 1000,
    });
    return { session: service.sessionView(created.session) };
  });
  server.post("/api/games", { bodyLimit: 16_384 }, async (request, reply) => {
    const session = await actor(request);
    await rateLimit(database, `create:${session.id}`, 10);
    return reply
      .code(201)
      .send(await service.create(session, createGameSchema.parse(request.body)));
  });
  server.get("/api/games/:id", async (request) =>
    service.view(await actor(request), gameId(request)),
  );
  server.post("/api/games/:id/invitation", { bodyLimit: 16_384 }, async (request) => {
    const session = await actor(request);
    await rateLimit(database, `invite:${session.id}`, 20);
    return service.invitation(session, gameId(request));
  });
  server.post("/api/invitations/join", { bodyLimit: 16_384 }, async (request) => {
    const session = await actor(request);
    await rateLimit(database, `join:${session.id}`, 20);
    return service.join(session, joinInvitationSchema.parse(request.body).token);
  });
  server.post("/api/games/:id/commands", { bodyLimit: 16_384 }, async (request) => {
    const session = await actor(request);
    await rateLimit(database, `command:${session.id}`, 120);
    return service.command(session, gameId(request), gameCommandSchema.parse(request.body));
  });
  server.get("/api/games/:id/pgn", async (request, reply) => {
    const id = gameId(request);
    return reply
      .type("application/x-chess-pgn")
      .header("Content-Disposition", `attachment; filename="${id}.pgn"`)
      .send(await service.pgn(await actor(request), id));
  });
  if (config.serveWeb) {
    await server.register(staticFiles, {
      root: fileURLToPath(new URL("../../../web/dist/", import.meta.url)),
      wildcard: false,
      index: ["index.html"],
    });
  }

  const io = new SocketServer(server.server, {
    transports: ["websocket"],
    serveClient: false,
    maxHttpBufferSize: 16_384,
    allowRequest: (request, callback) =>
      callback(null, request.headers.origin === config.webOrigin),
  });
  const connections = new Map<string, number>();
  io.use(async (socket, next) => {
    try {
      const parsed = server.parseCookie(socket.request.headers.cookie ?? "");
      const session = await service.session(parsed[cookieName]);
      if (!session) return next(new Error("SESSION_REQUIRED"));
      await rateLimit(database, `socket:${session.id}`, 30);
      if ((connections.get(session.id) ?? 0) >= 8) return next(new Error("CONNECTION_LIMIT"));
      connections.set(session.id, (connections.get(session.id) ?? 0) + 1);
      socket.data.session = session;
      socket.conn.once("close", () => {
        const count = (connections.get(session.id) ?? 1) - 1;
        if (count > 0) connections.set(session.id, count);
        else connections.delete(session.id);
      });
      next();
    } catch {
      next(new Error("CONNECTION_UNAVAILABLE"));
    }
  });
  const revisions = new Map<string, number>();
  io.on("connection", (socket) => {
    const session = socket.data.session as SessionRecord;
    // Long guest lifetimes exceed Node's maximum single timeout duration.
    const expiry = setInterval(() => {
      if (session.expiresAt <= Date.now()) socket.disconnect(true);
    }, 1000);
    expiry.unref();
    socket.on("game:subscribe", async (payload: unknown, acknowledge: unknown) => {
      if (typeof acknowledge !== "function") return;
      try {
        await rateLimit(database, `subscribe:${session.id}`, 60);
        const id = subscriptionSchema.parse(payload).gameId;
        const refreshed = await service.session(
          server.parseCookie(socket.request.headers.cookie ?? "")[cookieName],
        );
        if (!refreshed)
          throw new ApplicationError("SESSION_REQUIRED", "Your guest session expired.", 401);
        const view = await service.view(refreshed, id);
        for (const room of socket.rooms) if (room.startsWith("game:")) await socket.leave(room);
        await socket.join(`game:${id}`);
        revisions.set(id, Math.min(revisions.get(id) ?? view.game.revision, view.game.revision));
        acknowledge(view);
        scheduler?.wake();
      } catch (error) {
        acknowledge(
          errorBody(
            error instanceof ApplicationError
              ? error
              : new ApplicationError("SUBSCRIBE_FAILED", "Unable to subscribe to this game."),
          ),
        );
      }
    });
    socket.on("disconnect", () => {
      clearInterval(expiry);
      scheduler?.wake();
    });
  });

  let working: Promise<void> | null = null;
  let cleanupAt = 0;
  const performTick = (): Promise<void> => {
    if (working) return working;
    working = (async () => {
      await service.expireDue();
      if (Date.now() >= cleanupAt) {
        await service.cleanup();
        cleanupAt = Date.now() + 3_600_000;
      }
      // Durable outbox acknowledges committed events. Each instance also checks its
      // own subscribed revisions, so another dispatcher cannot consume its update.
      await database.transaction(async (tx) => {
        for (const event of await tx.claimOutbox(100))
          await tx.completeOutbox(event.id, event.leaseToken);
      });
      for (const [id, previous] of revisions) {
        if (!io.sockets.adapter.rooms.has(`game:${id}`)) {
          revisions.delete(id);
          continue;
        }
        const current = await database.pool.query<{ revision: number }>(
          "SELECT revision FROM matches WHERE id=$1",
          [id],
        );
        if ((current.rows[0]?.revision ?? -1) > previous) {
          const game = await service.publicView(id);
          if (game) {
            io.to(`game:${id}`).emit("game:updated", game);
            metrics.fanoutDelay.add(Math.max(0, Date.now() - game.updatedAt));
            revisions.set(id, game.revision);
          }
        }
      }
    })().finally(() => {
      working = null;
    });
    return working;
  };
  const reportWorkerFailure = () => {
    metrics.workerFailures += 1;
    server.log.error({ code: "background-failed" }, "Background processing failed");
  };
  const tick = async () => {
    try {
      await performTick();
    } catch {
      reportWorkerFailure();
    }
  };
  if (options.workers !== false) {
    scheduler = new BackgroundScheduler({
      hasSubscribers: () =>
        [...revisions.keys()].some((id) => io.sockets.adapter.rooms.has(`game:${id}`)),
      work: performTick,
      nextWakeDelay: async () => {
        const result = await database.pool.query<{
          deadline_at: string | null;
          database_now: string;
        }>(
          `SELECT min((lifecycle->>'deadlineAt')::bigint)::text AS deadline_at,
           floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS database_now
           FROM matches WHERE status='active'`,
        );
        const row = result.rows[0];
        if (!row) throw new Error("Database did not return a background deadline.");
        const deadlineDelay =
          row.deadline_at === null ? Infinity : Number(row.deadline_at) - Number(row.database_now);
        return Math.min(deadlineDelay, Math.max(0, cleanupAt - Date.now()));
      },
      onError: reportWorkerFailure,
    });
    scheduler.wake();
  }
  const diagnostics =
    options.workers === false
      ? null
      : setInterval(() => {
          server.log.info(
            {
              metrics: {
                ...metrics.snapshot(),
                activeConnections: io.engine.clientsCount,
                dbConnections: database.pool.totalCount,
                dbWaiting: database.pool.waitingCount,
                transactionAcquireP95Ms: database.transactionAcquireP95Ms,
              },
            },
            "Runtime metrics",
          );
        }, 60_000);
  diagnostics?.unref();
  server.addHook("onClose", async () => {
    await scheduler?.close();
    if (diagnostics) clearInterval(diagnostics);
    await new Promise<void>((resolve) => io.close(() => resolve()));
    if (working) await working.catch(reportWorkerFailure);
    metrics.close();
  });
  return { server, service, io, tick, metrics, scheduler };
}
