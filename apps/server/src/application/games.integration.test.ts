import { randomUUID } from "node:crypto";
import {
  type CreateGame,
  type GameAction,
  type GameCommand,
  type GameView,
  gameViewSchema,
} from "@chess-room/contracts";
import { createEngineState, engineStateSchema } from "@chess-room/game-core";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Database } from "../storage/database.js";
import { migrate } from "../storage/migrations.js";
import type { SessionRecord } from "../storage/records.js";
import { GameService, tokenHash } from "./games.js";

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("A PostgreSQL URL is required for game integration tests.");

describe("durable game application", () => {
  let administrator: Pool;
  let database: Database;
  let service: GameService;
  let schema: string;
  let now: number;
  let white: SessionRecord;
  let black: SessionRecord;

  beforeEach(async () => {
    schema = `game_test_${randomUUID().replaceAll("-", "")}`;
    administrator = new Pool({ connectionString, max: 1 });
    await administrator.query(`CREATE SCHEMA "${schema}"`);
    database = new Database(connectionString, { options: `-c search_path=${schema}` });
    await migrate(database.pool);
    now = Date.now();
    service = new GameService(database, () => now);
    white = (await service.createSession("White player")).session;
    black = (await service.createSession("Black player")).session;
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

  async function start(overrides: Partial<CreateGame> = {}): Promise<GameView> {
    const created = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
      ...overrides,
    });
    return service.join(black, created.invitation.token);
  }

  const command = (expectedRevision: number, action: GameAction): GameCommand => ({
    protocolVersion: 1,
    commandId: randomUUID(),
    expectedRevision,
    action,
  });

  async function act(view: GameView, actor: SessionRecord, action: GameAction): Promise<GameView> {
    return service.command(actor, view.game.id, command(view.game.revision, action));
  }

  it("maps custom Catchess settings to the host's chosen seat and keeps settings with players after a rematch", async () => {
    const created = await service.create(black, {
      rulesetId: "catchess",
      color: "black",
      timeControl: "untimed",
      catchess: { host: -35, guest: 70 },
    });
    expect(created.seat).toBe("black");
    expect(created.game.catchess).toEqual({ white: 70, black: -35 });
    let view = await service.join(white, created.invitation.token);
    expect(gameViewSchema.parse(view).game.catchess).toEqual({ white: 70, black: -35 });
    view = await act(view, black, { type: "resign" });
    view = await act(view, black, { type: "request-rematch" });
    view = await act(view, white, { type: "accept-rematch" });
    if (!view.game.rematchGameId) throw new Error("A Catchess rematch was not created.");
    const successor = await service.view(black, view.game.rematchGameId);
    expect(successor.seat).toBe("white");
    expect(successor.game.catchess).toEqual({ white: -35, black: 70 });
    expect(successor.game.position.catEffects).toEqual([]);
    expect(successor.game.position.board).toHaveLength(32);
    expect((await service.view(white, successor.game.id)).seat).toBe("black");
  });

  it.each([
    { chance: 100, action: "add", pawns: 9, pieces: 33 },
    { chance: -100, action: "remove", pawns: 7, pieces: 31 },
    { chance: 0, action: "none", pawns: 8, pieces: 32 },
  ])(
    "persists the guaranteed $action Catchess effect atomically with its move",
    async ({ chance, action, pawns, pieces }) => {
      service = new GameService(
        database,
        () => now,
        () => "0".repeat(64),
      );
      const view = await start({ rulesetId: "catchess", catchess: { host: chance, guest: 0 } });
      const accepted = await act(view, white, { type: "move", from: "e2", to: "e4" });
      expect(accepted.game.position.board).toHaveLength(pieces);
      expect(
        accepted.game.position.board.filter(
          (piece) => piece.type === "p" && piece.color === "white",
        ),
      ).toHaveLength(pawns);
      expect(accepted.game.position.catEffects).toHaveLength(1);
      const effect = accepted.game.position.catEffects?.[0];
      expect(effect).toMatchObject({ ply: 1, color: "white", action });
      if (action === "add") expect(effect?.square).toMatch(/^[a-h][1-4]$/);
      const stored = await database.transaction((tx) => tx.getGame(view.game.id));
      expect(engineStateSchema.parse(stored?.engineState).catTurns).toEqual([
        { draw: "0".repeat(64), effect },
      ]);
      const events = await database.transaction((tx) => tx.listEvents(view.game.id, 1));
      expect(events).toHaveLength(1);
      expect(events[0]?.payload.catEffect).toEqual(effect);
      expect(events[0]?.payload.fen).toBe(accepted.game.position.fen);
      expect(JSON.stringify(accepted)).not.toContain("0".repeat(64));
    },
  );

  it("draws server entropy only after authorization, revision and turn guards and never rerolls accepted retries", async () => {
    const draw = vi.fn(() => "a".repeat(64));
    service = new GameService(database, () => now, draw);
    const view = await start({ rulesetId: "catchess", catchess: { host: 100, guest: -100 } });
    const stranger = (await service.createSession("Stranger")).session;
    const first = command(1, { type: "move", from: "e2", to: "e4" });
    await expect(service.command(stranger, view.game.id, first)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      service.command(white, view.game.id, { ...first, expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });
    await expect(
      service.command(black, view.game.id, command(1, { type: "move", from: "e7", to: "e5" })),
    ).rejects.toMatchObject({ code: "NOT_YOUR_TURN" });
    expect(draw).not.toHaveBeenCalled();
    const acknowledgements = await Promise.all([
      service.command(white, view.game.id, first),
      service.command(white, view.game.id, first),
    ]);
    expect(acknowledgements[0]).toEqual(acknowledgements[1]);
    expect(draw).toHaveBeenCalledTimes(1);
    const accepted = acknowledgements[0];
    if (!accepted) throw new Error("Catchess move was not acknowledged.");
    const later = await act(accepted, black, { type: "move", from: "e7", to: "e5" });
    expect(draw).toHaveBeenCalledTimes(2);
    expect(await service.command(white, view.game.id, first)).toEqual(accepted);
    expect(draw).toHaveBeenCalledTimes(2);
    await database.close();
    database = new Database(connectionString, { options: `-c search_path=${schema}` });
    service = new GameService(database, () => now, draw);
    expect((await service.view(white, view.game.id)).game).toEqual(later.game);
    expect(await service.command(white, view.game.id, first)).toEqual(accepted);
    expect(draw).toHaveBeenCalledTimes(2);
    const events = await database.transaction((tx) => tx.listEvents(view.game.id, 1));
    expect(events).toHaveLength(2);
  });

  it("serializes competing Catchess commands without applying a second cat effect", async () => {
    const draw = vi.fn(() => "b".repeat(64));
    service = new GameService(database, () => now, draw);
    const view = await start({ rulesetId: "catchess", catchess: { host: 100, guest: 0 } });
    const results = await Promise.allSettled([
      service.command(white, view.game.id, command(1, { type: "move", from: "e2", to: "e4" })),
      service.command(white, view.game.id, command(1, { type: "move", from: "d2", to: "d4" })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({
      code: "STALE_REVISION",
    });
    expect(draw).toHaveBeenCalledTimes(1);
    const current = await service.view(white, view.game.id);
    expect(current.game.revision).toBe(2);
    expect(current.game.position.moves).toHaveLength(1);
    expect(current.game.position.catEffects).toHaveLength(1);
    expect(current.game.position.board).toHaveLength(33);
  });

  it.each(["standard", "three-check"] as const)(
    "reads old $0 records and acknowledgements without changing their wire shape",
    async (rulesetId) => {
      const view = await start({ rulesetId });
      const move = command(1, { type: "move", from: "e2", to: "e4" });
      const accepted = await service.command(white, view.game.id, move);
      await database.pool.query(
        "UPDATE matches SET rules_config='{}'::jsonb,engine_state=engine_state-'catchess'-'catTurns' WHERE id=$1",
        [view.game.id],
      );
      await database.pool.query(
        `UPDATE command_receipts SET acknowledgement=jsonb_set(
      jsonb_set(acknowledgement,'{game}',(acknowledgement->'game')-'catchess'),
      '{game,position}',(acknowledgement->'game'->'position')-'catEffects') WHERE match_id=$1`,
        [view.game.id],
      );
      const restored = await service.view(white, view.game.id);
      expect(restored.game).not.toHaveProperty("catchess");
      expect(restored.game.position).not.toHaveProperty("catEffects");
      expect(restored.game.position.fen).toBe(accepted.game.position.fen);
      const retry = await service.command(white, view.game.id, move);
      expect(retry).toStrictEqual(accepted);
      expect(retry.game).not.toHaveProperty("catchess");
      expect(retry.game.position).not.toHaveProperty("catEffects");
    },
  );

  it("claims exactly two seats despite simultaneous friends joining and retries a claimed invitation", async () => {
    const third = (await service.createSession("Third player")).session;
    const created = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
    });
    await expect(service.join(white, created.invitation.token)).rejects.toMatchObject({
      code: "OWN_INVITATION",
    });
    const claims = await Promise.allSettled([
      service.join(black, created.invitation.token),
      service.join(third, created.invitation.token),
    ]);
    const accepted = claims.find((claim) => claim.status === "fulfilled");
    const rejected = claims.find((claim) => claim.status === "rejected");
    expect(accepted?.status).toBe("fulfilled");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({ code: "INVITATION_UNAVAILABLE" });
    }
    const winner = claims[0]?.status === "fulfilled" ? black : third;
    const stranger = winner === black ? third : black;
    const retry = await service.join(winner, created.invitation.token);
    expect(retry.game.revision).toBe(1);
    expect(retry.seat).toBe("black");
    expect(await database.transaction((tx) => tx.listSeats(created.game.id))).toHaveLength(2);
    await expect(service.view(stranger, created.game.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      service.command(stranger, created.game.id, command(1, { type: "resign" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps illegal, out-of-turn and stale commands from changing durable state", async () => {
    const view = await start();
    await expect(
      service.command(white, view.game.id, command(1, { type: "move", from: "e2", to: "e5" })),
    ).rejects.toMatchObject({ code: "ILLEGAL_MOVE" });
    await expect(
      service.command(black, view.game.id, command(1, { type: "move", from: "e7", to: "e5" })),
    ).rejects.toMatchObject({ code: "NOT_YOUR_TURN" });
    await expect(
      service.command(white, view.game.id, command(0, { type: "move", from: "e2", to: "e4" })),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });
    const current = await service.view(white, view.game.id);
    expect(current.game.revision).toBe(1);
    expect(current.game.position.moves).toEqual([]);
    expect(await database.transaction((tx) => tx.listEvents(view.game.id, 1))).toEqual([]);
  });

  it("returns the original acknowledgement on a lost-ack retry after another move", async () => {
    const view = await start();
    const original = command(1, { type: "move", from: "e2", to: "e4" });
    const acknowledgement = await service.command(white, view.game.id, original);
    const later = await act(acknowledgement, black, { type: "move", from: "e7", to: "e5" });
    expect(later.game.revision).toBe(3);
    expect(await service.command(white, view.game.id, original)).toEqual(acknowledgement);
    await expect(
      service.command(white, view.game.id, {
        ...original,
        action: { type: "move", from: "d2", to: "d4" },
      }),
    ).rejects.toMatchObject({ code: "COMMAND_REUSED" });
    expect((await service.view(white, view.game.id)).game.revision).toBe(3);
    expect((await service.view(white, view.game.id)).game.position.moves).toHaveLength(2);
    const events = await database.transaction((tx) => tx.listEvents(view.game.id, 1));
    expect(events.map((event) => event.revision)).toEqual([2, 3]);
    expect(events[0]?.payload).toMatchObject({
      actor: "white",
      lifecycle: { drawOffer: null, outcome: null },
      action: original.action,
      fen: acknowledgement.game.position.fen,
      phase: "active",
      outcome: null,
    });
  });

  it("accepts one of two concurrent moves against the same revision", async () => {
    const view = await start();
    const results = await Promise.allSettled([
      service.command(white, view.game.id, command(1, { type: "move", from: "e2", to: "e4" })),
      service.command(white, view.game.id, command(1, { type: "move", from: "d2", to: "d4" })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") expect(rejected.reason.code).toBe("STALE_REVISION");
    const current = await service.view(white, view.game.id);
    expect(current.game.revision).toBe(2);
    expect(current.game.position.moves).toHaveLength(1);
  });

  it("restores move history and repetition claims after a process-style pool restart", async () => {
    let view = await start();
    for (let cycle = 0; cycle < 2; cycle += 1) {
      view = await act(view, white, { type: "move", from: "g1", to: "f3" });
      view = await act(view, black, { type: "move", from: "g8", to: "f6" });
      view = await act(view, white, { type: "move", from: "f3", to: "g1" });
      view = await act(view, black, { type: "move", from: "f6", to: "g8" });
    }
    expect(view.game.position.claimableDraws).toContain("threefold-repetition");
    await database.close();
    database = new Database(connectionString, { options: `-c search_path=${schema}` });
    service = new GameService(database, () => now);
    const restored = await service.view(white, view.game.id);
    expect(restored.game).toEqual(view.game);
    expect(restored.seat).toBe("white");
    const finished = await act(restored, white, { type: "claim-draw" });
    expect(finished.game.phase).toBe("finished");
    expect(finished.game.outcome).toEqual({ winner: null, reason: "threefold-repetition" });
    expect(await service.pgn(white, view.game.id)).toContain("1/2-1/2");
  });

  it("stores only hashed credentials and excludes identity secrets from public projections", async () => {
    const guest = await service.createSession("Private player");
    const persisted = await database.transaction((tx) => tx.getSession(tokenHash(guest.token)));
    expect(persisted?.tokenHash).toBe(tokenHash(guest.token));
    const view = await start();
    expect(gameViewSchema.parse(view)).toEqual(view);
    const publicOutput = JSON.stringify(view);
    expect(publicOutput).not.toContain(white.id);
    expect(publicOutput).not.toContain(white.tokenHash);
    expect(publicOutput).not.toContain(guest.token);
  });

  it("accepts a move just before the deadline and adds increment exactly once", async () => {
    const view = await start({ timeControl: "10+5" });
    now += 599_999;
    const move = command(1, { type: "move", from: "e2", to: "e4" });
    const accepted = await service.command(white, view.game.id, move);
    expect(accepted.game.clocks?.whiteMs).toBe(5_001);
    expect(accepted.game.clocks?.blackMs).toBe(600_000);
    expect(accepted.game.clocks?.runningColor).toBe("black");
    now += 1_000;
    expect((await service.command(white, view.game.id, move)).game.clocks?.whiteMs).toBe(5_001);
    expect((await service.view(black, view.game.id)).game.revision).toBe(2);
  });

  it("finishes and persists a timeout instead of accepting a move exactly at its deadline", async () => {
    const view = await start({ timeControl: "5+0" });
    now += 300_000;
    await expect(
      service.command(white, view.game.id, command(1, { type: "move", from: "e2", to: "e4" })),
    ).rejects.toMatchObject({ code: "GAME_FINISHED" });
    const current = await service.view(white, view.game.id);
    expect(current.game.phase).toBe("finished");
    expect(current.game.outcome).toEqual({ winner: "black", reason: "timeout" });
    expect(current.game.clocks?.whiteMs).toBe(0);
    expect(current.game.position.moves).toEqual([]);
    expect(current.game.revision).toBe(2);
  });

  it("expires games without connected clients and recovers persisted deadlines after restart", async () => {
    const view = await start({ timeControl: "5+0" });
    await database.close();
    database = new Database(connectionString, { options: `-c search_path=${schema}` });
    service = new GameService(database, () => now);
    now += 300_001;
    await service.expireDue();
    const current = await service.view(black, view.game.id);
    expect(current.game.outcome).toEqual({ winner: "black", reason: "timeout" });
    expect(current.game.revision).toBe(2);
    await service.expireDue();
    expect((await service.view(black, view.game.id)).game.revision).toBe(2);
  });

  it("persists draw offers, decline, agreement and a distinct rematch with colors swapped", async () => {
    let view = await start();
    view = await act(view, white, { type: "offer-draw" });
    expect(view.game.drawOffer).toBe("white");
    await expect(act(view, white, { type: "accept-draw" })).rejects.toMatchObject({
      code: "NO_DRAW_OFFER",
    });
    view = await act(view, black, { type: "decline-draw" });
    expect(view.game.drawOffer).toBeNull();
    view = await act(view, black, { type: "offer-draw" });
    view = await act(view, white, { type: "accept-draw" });
    expect(view.game.outcome).toEqual({ winner: null, reason: "agreement" });
    await expect(act(view, white, { type: "move", from: "e2", to: "e4" })).rejects.toMatchObject({
      code: "GAME_NOT_ACTIVE",
    });
    view = await act(view, white, { type: "request-rematch" });
    view = await act(view, black, { type: "accept-rematch" });
    const successorId = view.game.rematchGameId;
    expect(successorId).not.toBeNull();
    expect(successorId).not.toBe(view.game.id);
    if (!successorId) throw new Error("Rematch was not created.");
    const successor = await service.view(white, successorId);
    expect(successor.seat).toBe("black");
    expect((await service.view(black, successorId)).seat).toBe("white");
    expect(successor.game.phase).toBe("active");
    expect(successor.game.revision).toBe(0);
    expect(successor.game.position.moves).toEqual([]);
    expect((await service.view(white, view.game.id)).game.phase).toBe("finished");
  });

  it("ends a real game through checkmate and rejects post-result moves", async () => {
    let view = await start();
    view = await act(view, white, { type: "move", from: "f2", to: "f3" });
    view = await act(view, black, { type: "move", from: "e7", to: "e5" });
    view = await act(view, white, { type: "move", from: "g2", to: "g4" });
    view = await act(view, black, { type: "move", from: "d8", to: "h4" });
    expect(view.game.outcome).toEqual({ winner: "black", reason: "checkmate" });
    await expect(act(view, white, { type: "move", from: "e2", to: "e4" })).rejects.toMatchObject({
      code: "GAME_NOT_ACTIVE",
    });
  });

  it("uses the three-check ruleset across durable recovery without changing standard orchestration", async () => {
    let view = await start({ rulesetId: "three-check" });
    await database.pool.query("UPDATE matches SET engine_state=$2 WHERE id=$1", [
      view.game.id,
      createEngineState("three-check", "4k3/8/8/8/8/8/R7/K7 w - - 0 1"),
    ]);
    view = await act(view, white, { type: "move", from: "a2", to: "e2" });
    view = await act(view, black, { type: "move", from: "e8", to: "d8" });
    view = await act(view, white, { type: "move", from: "e2", to: "d2" });
    expect(view.game.position.checks.white).toBe(2);
    await database.close();
    database = new Database(connectionString, { options: `-c search_path=${schema}` });
    service = new GameService(database, () => now);
    view = await service.view(black, view.game.id);
    expect(view.game.rulesetId).toBe("three-check");
    expect(view.game.position.checks.white).toBe(2);
    view = await act(view, black, { type: "move", from: "d8", to: "c8" });
    view = await act(view, white, { type: "move", from: "d2", to: "c2" });
    expect(view.game.outcome).toEqual({ winner: "white", reason: "three-check" });
    expect(view.game.position.checks.white).toBe(3);
    expect(await service.pgn(white, view.game.id)).toContain('[Variant "Three-check"]');
  });

  it("draws on timeout when the potential winner has only a bare king", async () => {
    const view = await start({ timeControl: "5+0" });
    await database.pool.query("UPDATE matches SET engine_state=$2 WHERE id=$1", [
      view.game.id,
      createEngineState("standard", "4k3/8/8/8/8/8/R7/K7 w - - 0 1"),
    ]);
    now += 300_000;
    await service.expireDue();
    expect((await service.view(white, view.game.id)).game.outcome).toEqual({
      winner: null,
      reason: "timeout-insufficient-material",
    });
  });

  it("bounds open rooms and removes expired waiting rooms while retaining an active game", async () => {
    const active = await start();
    const waiting = [];
    for (let count = 0; count < 9; count += 1) {
      waiting.push(
        await service.create(white, {
          rulesetId: "standard",
          color: "white",
          timeControl: "untimed",
        }),
      );
    }
    await expect(
      service.create(white, { rulesetId: "standard", color: "white", timeControl: "untimed" }),
    ).rejects.toMatchObject({ code: "ROOM_LIMIT" });
    const expired = waiting[0];
    if (!expired) throw new Error("Waiting room is missing.");
    await database.pool.query(
      "UPDATE matches SET created_at=clock_timestamp()-interval '25 hours' WHERE id=$1",
      [expired.game.id],
    );
    await service.cleanup();
    await database.transaction(async (tx) => {
      expect(await tx.getGame(expired.game.id)).toBeNull();
      expect((await tx.getGame(active.game.id))?.status).toBe("active");
      expect(await tx.getInvitation(tokenHash(expired.invitation.token))).toBeNull();
      expect(await tx.listEvents(expired.game.id, -1)).toEqual([]);
    });
    expect(
      (
        await service.create(white, {
          rulesetId: "standard",
          color: "white",
          timeControl: "untimed",
        })
      ).game.phase,
    ).toBe("waiting");
  });

  it("keeps games with one live guest and closes unrecoverable games when both guest sessions expire", async () => {
    const view = await start();
    const expireSession = (id: string) =>
      database.pool.query(
        "UPDATE player_sessions SET created_at=clock_timestamp()-interval '2 seconds', expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [id],
      );
    await expireSession(white.id);
    await service.cleanup();
    expect((await service.view(black, view.game.id)).game.phase).toBe("active");
    await expireSession(black.id);
    await service.cleanup();
    const abandoned = await service.publicView(view.game.id);
    expect(abandoned?.phase).toBe("finished");
    expect(abandoned?.outcome).toEqual({ winner: null, reason: "session-expired" });
    expect(abandoned?.revision).toBe(2);
    const events = await database.transaction((tx) => tx.listEvents(view.game.id, 1));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("session-expired");
    expect(events[0]?.payload.outcome).toEqual({ winner: null, reason: "session-expired" });
    await service.cleanup();
    expect((await service.publicView(view.game.id))?.revision).toBe(2);
    await database.pool.query(
      "UPDATE matches SET updated_at=clock_timestamp()-interval '31 days' WHERE id=$1",
      [view.game.id],
    );
    await service.cleanup();
    expect(await service.publicView(view.game.id)).toBeNull();
    const sessions = await database.pool.query<{ count: string }>(
      "SELECT count(*) FROM player_sessions",
    );
    expect(sessions.rows[0]?.count).toBe("0");
  });

  it("does not consume an invitation when the joining guest already has ten open rooms", async () => {
    const rooms = [];
    for (let count = 0; count < 10; count += 1)
      rooms.push(
        await service.create(black, {
          rulesetId: "standard",
          color: "white",
          timeControl: "untimed",
        }),
      );
    const target = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
    });
    await expect(service.join(black, target.invitation.token)).rejects.toMatchObject({
      code: "ROOM_LIMIT",
    });
    await database.transaction(async (tx) => {
      expect((await tx.getGame(target.game.id))?.revision).toBe(0);
      expect((await tx.getInvitation(tokenHash(target.invitation.token)))?.consumedAt).toBeNull();
      expect(await tx.listSeats(target.game.id)).toHaveLength(1);
    });
    const disposable = rooms[0];
    if (!disposable) throw new Error("Waiting room is missing.");
    const third = (await service.createSession("Third")).session;
    const joined = await service.join(third, disposable.invitation.token);
    await act(joined, black, { type: "resign" });
    expect((await service.join(black, target.invitation.token)).game.phase).toBe("active");
  });

  it("keeps a rematch request retryable without creating a successor when either guest is at capacity", async () => {
    let view = await start();
    view = await act(view, white, { type: "resign" });
    view = await act(view, white, { type: "request-rematch" });
    const rooms = [];
    for (let count = 0; count < 10; count += 1)
      rooms.push(
        await service.create(white, {
          rulesetId: "standard",
          color: "white",
          timeControl: "untimed",
        }),
      );
    const accept = command(view.game.revision, { type: "accept-rematch" });
    await expect(service.command(black, view.game.id, accept)).rejects.toMatchObject({
      code: "ROOM_LIMIT",
    });
    expect((await service.view(black, view.game.id)).game.rematchGameId).toBeNull();
    expect((await service.view(black, view.game.id)).game.revision).toBe(view.game.revision);
    const disposable = rooms[0];
    if (!disposable) throw new Error("Waiting room is missing.");
    const third = (await service.createSession("Third")).session;
    const joined = await service.join(third, disposable.invitation.token);
    await act(joined, white, { type: "resign" });
    const accepted = await service.command(black, view.game.id, accept);
    expect(accepted.game.rematchGameId).not.toBeNull();
    expect(accepted.game.revision).toBe(view.game.revision + 1);
  });

  it("rejects a rematch whose requesting opponent session expired without creating an unusable successor", async () => {
    let view = await start();
    view = await act(view, white, { type: "resign" });
    view = await act(view, white, { type: "request-rematch" });
    await database.pool.query(
      "UPDATE player_sessions SET created_at=clock_timestamp()-interval '2 seconds', expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [white.id],
    );
    await expect(act(view, black, { type: "accept-rematch" })).rejects.toMatchObject({
      code: "SESSION_REQUIRED",
    });
    const retained = await service.view(black, view.game.id);
    expect(retained.game.rematchGameId).toBeNull();
    expect(retained.game.revision).toBe(view.game.revision);
    const matches = await database.pool.query<{ count: string }>("SELECT count(*) FROM matches");
    expect(matches.rows[0]?.count).toBe("1");
  });

  it("caps an invitation at the host session expiry and rejects a friend arriving after that deadline", async () => {
    const created = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
    });
    const hostExpiry = now + 1_000;
    await database.pool.query("UPDATE player_sessions SET expires_at=$2 WHERE id=$1", [
      white.id,
      new Date(hostExpiry),
    ]);
    const invitation = await service.invitation(white, created.game.id);
    expect(invitation.expiresAt).toBe(hostExpiry);
    now = hostExpiry + 1;
    await expect(service.join(black, invitation.token)).rejects.toMatchObject({
      code: "INVITATION_UNAVAILABLE",
      status: 409,
    });
    await database.transaction(async (tx) => {
      const retained = await tx.getGame(created.game.id);
      expect(retained?.status).toBe("waiting");
      expect(retained?.revision).toBe(0);
      expect(await tx.listSeats(created.game.id)).toHaveLength(1);
      expect((await tx.getInvitation(tokenHash(invitation.token)))?.consumedAt).toBeNull();
    });
  });
});
