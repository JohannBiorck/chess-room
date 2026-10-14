import { randomBytes } from "node:crypto";
import {
  accountPreferencesSchema,
  ceremonyInputSchema,
  historyQuerySchema,
  recoveryInputSchema,
  registrationInputSchema,
} from "@chess-room/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SessionRecord } from "../storage/records.js";
import type { AccountService } from "./accounts.js";
import type { ApplicationConfig } from "./config.js";
import { ApplicationError } from "./errors.js";
import type { GameService } from "./games.js";
import { rateLimit } from "./rate-limit.js";

export function registerAccountRoutes(
  server: FastifyInstance,
  options: {
    accounts: AccountService;
    games: GameService;
    config: ApplicationConfig;
    actor: (request: FastifyRequest) => Promise<SessionRecord | null>;
    guest: (request: FastifyRequest) => Promise<SessionRecord | null>;
    accountCookie: string;
    guestCookie: string;
    onIdentityChange: () => Promise<void>;
  },
) {
  const { accounts, games, config } = options;
  const flowCookie = config.secureCookies ? "__Host-cat_authflow" : "cat_authflow";
  const recoveryCookie = config.secureCookies ? "__Host-cat_recovery" : "cat_recovery";
  const cookieOptions = {
    path: "/",
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax" as const,
  };
  const cookieToken = (request: FastifyRequest, reply: FastifyReply) => {
    const existing = request.cookies[flowCookie];
    if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing)) {
      reply.setCookie(flowCookie, existing, { ...cookieOptions, maxAge: 300 });
      return existing;
    }
    const raw = randomBytes(32).toString("base64url");
    reply.setCookie(flowCookie, raw, { ...cookieOptions, maxAge: 300 });
    return raw;
  };
  const required = async (request: FastifyRequest) => {
    const actor = await options.actor(request);
    if (!actor?.accountId)
      throw new ApplicationError("ACCOUNT_REQUIRED", "Sign in to manage your account.", 401);
    return actor;
  };
  const setSession = (reply: FastifyReply, raw: string) => {
    reply.setCookie(options.accountCookie, raw, { ...cookieOptions, maxAge: 30 * 86400 });
    reply.clearCookie(flowCookie, cookieOptions);
  };
  const limited = async (request: FastifyRequest, purpose: string, limit = 20) =>
    rateLimit(accounts.database, `auth:${purpose}:${request.ip}`, limit);
  const empty = z.object({}).strict();
  server.get("/api/account", async (request) =>
    accounts.status(await options.actor(request), await options.guest(request)),
  );
  server.post("/api/account/preferences", { bodyLimit: 16384 }, async (request) => {
    const actor = await required(request);
    await limited(request, "preferences", 30);
    const preferences = accountPreferencesSchema.parse(request.body);
    await accounts.database.pool.query("UPDATE accounts SET preferences=$2 WHERE id=$1", [
      actor.accountId,
      preferences,
    ]);
    return { ok: true };
  });
  server.get("/api/account/games", async (request) => {
    const actor = await required(request);
    const rows = await accounts.database.pool.query<{
      id: string;
      ruleset_id: string;
      status: string;
      updated_at: Date;
      display_name: string | null;
    }>(
      `SELECT m.id,m.ruleset_id,m.status,m.updated_at,opponent.display_name FROM matches m JOIN match_seats s ON s.match_id=m.id
       JOIN players p ON p.id=s.session_id LEFT JOIN match_seats other ON other.match_id=m.id AND other.color<>s.color
       LEFT JOIN player_sessions opponent ON opponent.id=other.session_id WHERE p.account_id=$1 AND m.status IN ('waiting','active')
       ORDER BY m.updated_at DESC,m.id LIMIT 20`,
      [actor.accountId],
    );
    return {
      games: rows.rows.map((row) => ({
        id: row.id,
        rulesetId: row.ruleset_id,
        phase: row.status,
        opponentName: row.display_name,
        updatedAt: row.updated_at.getTime(),
      })),
    };
  });
  server.post("/api/auth/registration/options", { bodyLimit: 16384 }, async (request, reply) => {
    await limited(request, "register", 10);
    const input = registrationInputSchema.parse(request.body);
    return accounts.begin(
      cookieToken(request, reply),
      "register",
      input,
      await options.actor(request),
      await options.guest(request),
    );
  });
  for (const purpose of ["login", "reauth", "add-passkey", "recover"] as const) {
    server.post(`/api/auth/${purpose}/options`, { bodyLimit: 16384 }, async (request, reply) => {
      empty.parse(request.body);
      await limited(request, purpose);
      return accounts.begin(
        cookieToken(request, reply),
        purpose,
        {},
        await options.actor(request),
        await options.guest(request),
        request.cookies[recoveryCookie],
      );
    });
  }
  server.post("/api/auth/verify", { bodyLimit: 65536 }, async (request, reply) => {
    await limited(request, "verify");
    const input = ceremonyInputSchema.parse(request.body);
    const result = await accounts.verify(
      request.cookies[flowCookie] ?? "",
      input.flowId,
      input.response,
    );
    setSession(reply, result.token);
    reply.clearCookie(recoveryCookie, cookieOptions);
    await options.onIdentityChange();
    return { recovery: result.recovery ?? null };
  });
  server.post("/api/auth/cancel", { bodyLimit: 16384 }, async (request) => {
    const input = z.object({ flowId: z.uuid() }).strict().parse(request.body);
    await accounts.cancel(request.cookies[flowCookie] ?? "", input.flowId);
    return { ok: true };
  });
  for (const [path, all] of [
    ["logout", false],
    ["logout-all", true],
  ] as const) {
    server.post(`/api/auth/${path}`, { bodyLimit: 16384 }, async (request, reply) => {
      empty.parse(request.body);
      const actor = await required(request);
      await accounts.logout(actor, all);
      reply.clearCookie(options.accountCookie, cookieOptions);
      reply.clearCookie(recoveryCookie, cookieOptions);
      reply.clearCookie(flowCookie, cookieOptions);
      await options.onIdentityChange();
      return { ok: true };
    });
  }
  server.post("/api/auth/recovery", { bodyLimit: 16384 }, async (request, reply) => {
    await limited(request, "recovery", 5);
    const input = recoveryInputSchema.parse(request.body);
    const result = await accounts.recover(input.locator, input.code);
    reply.setCookie(recoveryCookie, result.token, { ...cookieOptions, maxAge: 300 });
    return { ok: true };
  });
  server.post("/api/account/guest-claim", { bodyLimit: 16384 }, async (request, reply) => {
    empty.parse(request.body);
    await limited(request, "claim", 10);
    const guest = await options.guest(request);
    if (!guest)
      throw new ApplicationError(
        "GUEST_IMPORT_UNAVAILABLE",
        "No eligible guest session remains in this browser.",
        409,
      );
    const result = await accounts.claim(await required(request), guest);
    setSession(reply, result.token);
    reply.clearCookie(options.guestCookie, cookieOptions);
    await options.onIdentityChange();
    return { ok: true };
  });
  server.get("/api/account/passkeys", async (request) => ({
    credentials: await accounts.credentialList(await required(request)),
  }));
  server.delete("/api/account/passkeys/:id", async (request) => {
    await limited(request, "credentials");
    await accounts.removeCredential(
      await required(request),
      z
        .string()
        .min(1)
        .max(1400)
        .parse((request.params as { id: string }).id),
    );
    await options.onIdentityChange();
    return { ok: true };
  });
  server.post("/api/account/recovery-codes", { bodyLimit: 16384 }, async (request) => {
    empty.parse(request.body);
    await limited(request, "codes", 5);
    return { recovery: await accounts.replaceCodes(await required(request)) };
  });
  server.delete("/api/account", async (request, reply) => {
    await limited(request, "delete", 5);
    await accounts.delete(await required(request), (tx, id) => games.deleteAccountGames(tx, id));
    reply.clearCookie(options.accountCookie, cookieOptions);
    reply.clearCookie(options.guestCookie, cookieOptions);
    reply.clearCookie(flowCookie, cookieOptions);
    reply.clearCookie(recoveryCookie, cookieOptions);
    await options.onIdentityChange();
    return { ok: true };
  });
  const id = (request: FastifyRequest) => z.uuid().parse((request.params as { id: string }).id);
  server.get("/api/account/history", async (request) =>
    accounts.history.list(await required(request), historyQuerySchema.parse(request.query)),
  );
  server.get("/api/account/history/:id", async (request) =>
    accounts.history.detail(await required(request), id(request)),
  );
  server.get("/api/account/history/:id/pgn", async (request, reply) =>
    reply
      .type("application/x-chess-pgn")
      .header("Content-Disposition", `attachment; filename="${id(request)}.pgn"`)
      .send(await accounts.history.pgn(await required(request), id(request))),
  );
  server.get("/api/account/history/:id/json", async (request, reply) =>
    reply
      .type("application/json")
      .header("Content-Disposition", `attachment; filename="${id(request)}.json"`)
      .send(await accounts.history.detail(await required(request), id(request))),
  );
  server.delete("/api/account/history/:id", async (request) => {
    await accounts.history.hide(await required(request), id(request));
    return { ok: true };
  });
}
