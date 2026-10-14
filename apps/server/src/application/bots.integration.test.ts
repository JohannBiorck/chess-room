import { randomUUID } from "node:crypto";
import {
  type BotCommand,
  botPositionViewSchema,
  type GameCommand,
  gameViewSchema,
} from "@chess-room/contracts";
import { createEngineState } from "@chess-room/game-core";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "../storage/database.js";
import { migrate } from "../storage/migrations.js";
import type { SessionRecord } from "../storage/records.js";
import { GameService } from "./games.js";

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("A local PostgreSQL URL is required.");

describe("server-authoritative browser bot games", () => {
  let administrator: Pool;
  let database: Database;
  let service: GameService;
  let schema: string;
  let owner: SessionRecord;
  let stranger: SessionRecord;
  let draws: number;

  beforeEach(async () => {
    schema = `bot_test_${randomUUID().replaceAll("-", "")}`;
    administrator = new Pool({ connectionString, max: 1 });
    await administrator.query(`CREATE SCHEMA "${schema}"`);
    database = new Database(connectionString, { options: `-c search_path=${schema}` });
    await migrate(database.pool);
    draws = 0;
    service = new GameService(database, undefined, () => (++draws).toString(16).padStart(64, "0"));
    owner = (await service.createSession("Human")).session;
    stranger = (await service.createSession("Stranger")).session;
  });
  afterEach(async () => {
    await database?.close();
    if (administrator) {
      try {
        await administrator.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await administrator.end();
      }
    }
  });
  const human = (revision: number, action: GameCommand["action"]): GameCommand => ({
    protocolVersion: 1,
    commandId: randomUUID(),
    expectedRevision: revision,
    action,
  });
  const seedReceipts = async (gameId: string, count: number) => {
    await database.pool.query(
      `INSERT INTO command_receipts(match_id,session_id,command_id,payload_hash,acknowledgement)
       SELECT $1::uuid,$2::uuid,md5($1::uuid::text || ':' || n::text)::uuid,repeat('0',64),'{}'::jsonb
       FROM generate_series(1,$3::integer) n`,
      [gameId, owner.id, count],
    );
  };
  const receiptCount = async (gameId: string) =>
    Number(
      (
        await database.pool.query("SELECT count(*) FROM command_receipts WHERE match_id=$1", [
          gameId,
        ])
      ).rows[0]?.count,
    );

  it.each(["standard", "three-check", "catchess", "chaos-cat"] as const)(
    "creates a private untimed %s game and accepts exactly one authoritative bot turn",
    async (rulesetId) => {
      const created = await service.createBot(owner, {
        rulesetId,
        color: "black",
        profile: "balanced",
        ...(rulesetId === "catchess" ? { catchess: { host: 100, guest: 100 } } : {}),
      });
      expect(gameViewSchema.parse(created)).toEqual(created);
      expect(created).toMatchObject({
        seat: "black",
        game: { phase: "active", timeControl: "untimed", bot: { color: "white" } },
      });
      expect(await service.openRooms()).toEqual([]);
      expect(await service.activeBot(owner)).toBe(created.game.id);
      expect(await service.activeBot(stranger)).toBeNull();
      await expect(service.botPosition(stranger, created.game.id)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      const turn = botPositionViewSchema.parse(await service.botPosition(owner, created.game.id));
      const command: BotCommand = {
        protocolVersion: 1,
        commandId: turn.requestId,
        expectedRevision: turn.revision,
        move: { from: "e2", to: "e4" },
      };
      await expect(service.botCommand(stranger, created.game.id, command)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      const [one, two] = await Promise.all([
        service.botCommand(owner, created.game.id, command),
        service.botCommand(owner, created.game.id, command),
      ]);
      expect(one).toEqual(two);
      expect(one.game.position.moves).toHaveLength(1);
      expect(draws).toBe(rulesetId === "catchess" || rulesetId === "chaos-cat" ? 1 : 0);
      expect(one.game.bot?.requestId).toBeNull();
      await expect(
        service.botCommand(owner, created.game.id, { ...command, move: { from: "d2", to: "d4" } }),
      ).rejects.toMatchObject({ code: "COMMAND_REUSED" });
      expect(await service.botCommand(owner, created.game.id, command)).toEqual(one);
      await expect(service.botPosition(owner, created.game.id)).rejects.toMatchObject({
        code: "BOT_NOT_READY",
      });
    },
  );

  it("rejects forged tickets and routes, resumes the saved turn and rematches with swapped colors", async () => {
    let game = await service.createBot(owner, {
      rulesetId: "standard",
      color: "white",
      profile: "strong",
    });
    await expect(
      service.botCommand(owner, game.game.id, {
        protocolVersion: 1,
        commandId: randomUUID(),
        expectedRevision: game.game.revision,
        move: { from: "e7", to: "e5" },
      }),
    ).rejects.toMatchObject({ code: "BOT_NOT_READY" });
    game = await service.command(
      owner,
      game.game.id,
      human(game.game.revision, { type: "move", from: "e2", to: "e4" }),
    );
    const turn = await service.botPosition(owner, game.game.id);
    expect((await service.view(owner, game.game.id)).game.bot?.requestId).toBe(turn.requestId);
    await expect(
      service.botCommand(owner, game.game.id, {
        protocolVersion: 1,
        commandId: randomUUID(),
        expectedRevision: turn.revision,
        move: { from: "e7", to: "e5" },
      }),
    ).rejects.toMatchObject({ code: "BOT_TICKET_CHANGED" });
    await expect(
      service.command(
        owner,
        game.game.id,
        human(game.game.revision, { type: "move", from: "e7", to: "e5" }),
      ),
    ).rejects.toMatchObject({ code: "NOT_YOUR_TURN" });
    const accepted = await service.botCommand(owner, game.game.id, {
      protocolVersion: 1,
      commandId: turn.requestId,
      expectedRevision: turn.revision,
      move: { from: "e7", to: "e5" },
    });
    const finished = await service.command(
      owner,
      game.game.id,
      human(accepted.game.revision, { type: "resign" }),
    );
    const rematch = await service.command(
      owner,
      game.game.id,
      human(finished.game.revision, { type: "request-rematch" }),
    );
    expect(rematch.game.rematchGameId).toBeTruthy();
    const next = await service.view(owner, rematch.game.rematchGameId ?? "");
    expect(next).toMatchObject({
      seat: "black",
      game: { phase: "active", bot: { color: "white", profile: "strong" } },
    });
  });

  it("does not let the bot endpoint control a friends match", async () => {
    const created = await service.create(owner, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
    });
    const game = await service.join(stranger, created.invitation.token);
    await expect(service.botPosition(owner, game.game.id)).rejects.toMatchObject({
      code: "BOT_NOT_READY",
    });
    await expect(
      service.botCommand(owner, game.game.id, {
        protocolVersion: 1,
        commandId: randomUUID(),
        expectedRevision: game.game.revision,
        move: { from: "e2", to: "e4" },
      }),
    ).rejects.toMatchObject({ code: "BOT_NOT_READY" });
    expect((await service.view(owner, game.game.id)).game.position.moves).toHaveLength(0);
  });

  it.each(["human", "bot"] as const)(
    "validates the %s move before the storage cap and draws exactly once after accepting it",
    async (route) => {
      const created = await service.createBot(owner, {
        rulesetId: "catchess",
        color: route === "human" ? "white" : "black",
        profile: "balanced",
        catchess: { host: 100, guest: 100 },
      });
      const gameId = created.game.id;
      await seedReceipts(gameId, 1497);
      const commandId = created.game.bot?.requestId ?? randomUUID();
      const botCommand: BotCommand = {
        protocolVersion: 1,
        commandId,
        expectedRevision: created.game.revision,
        move: { from: "e2", to: "e4" },
      };
      const humanCommand: GameCommand = {
        protocolVersion: 1,
        commandId,
        expectedRevision: created.game.revision,
        action: { type: "move", ...botCommand.move },
      };
      const send = (illegal: boolean) =>
        route === "bot"
          ? service.botCommand(owner, gameId, {
              ...botCommand,
              move: { ...botCommand.move, to: illegal ? "e5" : "e4" },
            })
          : service.command(owner, gameId, {
              ...humanCommand,
              action: { type: "move", from: "e2", to: illegal ? "e5" : "e4" },
            });
      await expect(send(true)).rejects.toMatchObject({ code: "ILLEGAL_MOVE" });
      expect((await service.view(owner, gameId)).game).toEqual(created.game);
      expect(draws).toBe(0);
      expect(await receiptCount(gameId)).toBe(1497);
      const accepted = await send(false);
      expect(accepted.game).toMatchObject({
        phase: "finished",
        outcome: { winner: null, reason: "move-limit" },
        bot: { requestId: null },
      });
      expect(gameViewSchema.parse(accepted)).toEqual(accepted);
      expect(accepted.game.position.moves).toHaveLength(1);
      expect(accepted.game.position.catEffects).toHaveLength(1);
      expect(draws).toBe(1);
      expect(await receiptCount(gameId)).toBe(1498);
      expect(await send(false)).toEqual(accepted);
      expect(draws).toBe(1);
      expect(await receiptCount(gameId)).toBe(1498);
      expect(await service.activeBot(owner)).toBeNull();
      await expect(service.botPosition(owner, gameId)).rejects.toMatchObject({
        code: "BOT_NOT_READY",
      });
      expect(
        (await database.pool.query("SELECT * FROM match_archives WHERE match_id=$1", [gameId]))
          .rowCount,
      ).toBe(1);
    },
  );

  it("preserves a bot's winning move instead of replacing it with a storage-cap draw", async () => {
    const created = await service.createBot(owner, {
      rulesetId: "standard",
      color: "black",
      profile: "balanced",
    });
    const gameId = created.game.id;
    await database.pool.query("UPDATE matches SET engine_state=$2 WHERE id=$1", [
      gameId,
      createEngineState("standard", "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1"),
    ]);
    await seedReceipts(gameId, 1497);
    const turn = await service.botPosition(owner, gameId);
    const accepted = await service.botCommand(owner, gameId, {
      protocolVersion: 1,
      commandId: turn.requestId,
      expectedRevision: turn.revision,
      move: { from: "f7", to: "g7" },
    });
    expect(accepted.game.outcome).toEqual({ winner: "white", reason: "checkmate" });
    expect(accepted.game.position.moves).toHaveLength(1);
    expect(draws).toBe(0);
  });

  it("preserves resignation and rejects draw offers without consuming a command or cat draw", async () => {
    const created = await service.createBot(owner, {
      rulesetId: "chaos-cat",
      color: "white",
      profile: "balanced",
    });
    const gameId = created.game.id;
    await seedReceipts(gameId, 1497);
    await expect(
      service.command(owner, gameId, human(created.game.revision, { type: "offer-draw" })),
    ).rejects.toMatchObject({ code: "BOT_DRAW_UNAVAILABLE" });
    expect(await receiptCount(gameId)).toBe(1497);
    const finished = await service.command(
      owner,
      gameId,
      human(created.game.revision, { type: "resign" }),
    );
    expect(finished.game.outcome).toEqual({ winner: "black", reason: "resignation" });
    expect(finished.game.position.moves).toHaveLength(0);
    expect(await receiptCount(gameId)).toBe(1498);
    expect(draws).toBe(0);
  });

  it("reserves two friends-rematch actions and keeps accepted retries available at the hard cap", async () => {
    const created = await service.create(owner, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
    });
    const joined = await service.join(stranger, created.invitation.token);
    const gameId = joined.game.id;
    await seedReceipts(gameId, 1497);
    const finished = await service.command(
      owner,
      gameId,
      human(joined.game.revision, { type: "move", from: "e2", to: "e4" }),
    );
    expect(finished.game.outcome).toEqual({ winner: null, reason: "move-limit" });
    const request = human(finished.game.revision, { type: "request-rematch" });
    const requested = await service.command(owner, gameId, request);
    const accept = human(requested.game.revision, { type: "accept-rematch" });
    const accepted = await service.command(stranger, gameId, accept);
    expect(await receiptCount(gameId)).toBe(1500);
    expect(accepted.game.rematchGameId).toBeTruthy();
    const next = await service.view(owner, accepted.game.rematchGameId ?? "");
    expect(next).toMatchObject({ seat: "black", game: { phase: "active" } });
    expect(await service.command(owner, gameId, request)).toEqual(requested);
    expect(await service.command(stranger, gameId, accept)).toEqual(accepted);
    await expect(
      service.command(owner, gameId, human(accepted.game.revision, { type: "request-rematch" })),
    ).rejects.toMatchObject({ code: "COMMAND_LIMIT" });
    expect((await service.view(owner, gameId)).game).toEqual(accepted.game);
    expect(await receiptCount(gameId)).toBe(1500);
    expect(draws).toBe(0);
  });
});
