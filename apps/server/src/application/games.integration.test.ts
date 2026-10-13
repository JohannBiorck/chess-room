import { randomUUID } from "node:crypto";
import {
  type CreateGame,
  type GameAction,
  type GameCommand,
  type GameView,
  gameViewSchema,
  OPEN_ROOM_LIFETIME_MS,
  openRoomsSchema,
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

  it.each(["private", "open"] as const)(
    "lets the sole host close a %s room with one durable retryable acknowledgement",
    async (visibility) => {
      const created = await service.create(white, {
        rulesetId: "standard",
        color: "black",
        timeControl: "10+5",
        ...(visibility === "open" ? { visibility } : {}),
      });
      const close = command(0, { type: "close-room" });
      await expect(service.command(black, created.game.id, close)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      const accepted = await service.command(white, created.game.id, close);
      expect(gameViewSchema.parse(accepted)).toEqual(accepted);
      expect(accepted.game).toMatchObject({
        phase: "finished",
        revision: 1,
        outcome: null,
        closure: { reason: "host-closed", closedAt: now },
        rematchRequested: [],
        rematchGameId: null,
      });
      expect(accepted.game.position.moves).toEqual([]);
      expect(accepted.game.players.white).toBeNull();
      expect(accepted.game.clocks?.runningColor).toBeNull();
      expect(await service.command(white, created.game.id, close)).toEqual(accepted);
      await service.expireDue();
      const events = await database.transaction((tx) => tx.listEvents(created.game.id, 0));
      expect(events.map((event) => event.type)).toEqual(["close-room"]);
      const outbox = await database.transaction((tx) => tx.claimOutbox());
      expect(outbox.filter((event) => event.gameId === created.game.id)).toHaveLength(2);
      const invitation = await database.transaction((tx) =>
        tx.getInvitation(tokenHash(created.invitation.token)),
      );
      expect(invitation?.consumedAt).toBeNull();
      expect(invitation?.consumedBy).toBeNull();
      expect(invitation?.expiresAt).toBe(now);
      await expect(service.join(black, created.invitation.token)).rejects.toMatchObject({
        code: "INVITATION_UNAVAILABLE",
      });
      await expect(service.invitation(white, created.game.id)).rejects.toMatchObject({
        code: "ROOM_CLOSED",
      });
      await expect(act(accepted, white, { type: "request-rematch" })).rejects.toMatchObject({
        code: "REMATCH_UNAVAILABLE",
      });
      await expect(service.pgn(white, created.game.id)).rejects.toMatchObject({
        code: "ROOM_CLOSED",
      });
      if (visibility === "open") {
        expect(await service.openRooms()).toEqual([]);
        await expect(service.joinOpen(white, created.game.id)).rejects.toMatchObject({
          code: "ROOM_UNAVAILABLE",
        });
        await expect(service.joinOpen(black, created.game.id)).rejects.toMatchObject({
          code: "ROOM_UNAVAILABLE",
        });
      }
    },
  );

  it("rejects closing started and finished games without changing their result or accepting a receipt", async () => {
    let view = await start();
    const close = command(view.game.revision, { type: "close-room" });
    for (const actor of [white, black])
      await expect(service.command(actor, view.game.id, close)).rejects.toMatchObject({
        code: "CLOSE_UNAVAILABLE",
      });
    expect(await service.view(white, view.game.id)).toEqual({ ...view, seat: "white" });
    expect(
      await database.transaction((tx) => tx.getReceipt(view.game.id, white.id, close.commandId)),
    ).toBeNull();
    view = await act(view, white, { type: "resign" });
    await expect(act(view, black, { type: "close-room" })).rejects.toMatchObject({
      code: "CLOSE_UNAVAILABLE",
    });
    expect((await service.view(black, view.game.id)).game.outcome).toEqual({
      winner: "black",
      reason: "resignation",
    });
  });

  it.each(["public", "invitation"] as const)(
    "serializes room closure against a concurrent %s join",
    async (route) => {
      const created = await service.create(white, {
        rulesetId: "standard",
        color: "white",
        timeControl: "untimed",
        visibility: "open",
      });
      const close = command(0, { type: "close-room" });
      const results = await Promise.allSettled([
        service.command(white, created.game.id, close),
        route === "public"
          ? service.joinOpen(black, created.game.id)
          : service.join(black, created.invitation.token),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const retained = await service.view(white, created.game.id);
      expect(retained.game.revision).toBe(1);
      expect(await database.transaction((tx) => tx.listEvents(created.game.id, 0))).toHaveLength(1);
      const seats = await database.transaction((tx) => tx.listSeats(created.game.id));
      expect(seats).toHaveLength(retained.game.closure ? 1 : 2);
      expect(retained.game.phase).toBe(retained.game.closure ? "finished" : "active");
    },
  );

  it("allows one room-close receipt when two host commands race and rejects altered retry payloads", async () => {
    const created = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
    });
    const close = command(0, { type: "close-room" });
    const results = await Promise.all([
      service.command(white, created.game.id, close),
      service.command(white, created.game.id, close),
    ]);
    expect(results[0]).toEqual(results[1]);
    await expect(
      service.command(white, created.game.id, { ...close, action: { type: "resign" } }),
    ).rejects.toMatchObject({ code: "COMMAND_REUSED" });
    expect(await database.transaction((tx) => tx.listEvents(created.game.id, 0))).toHaveLength(1);
  });

  it("caps open invitations and discovery at exactly one hour while private rooms keep their original lifetime", async () => {
    const open = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
      visibility: "open",
    });
    const privateRoom = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
    });
    expect(open.invitation.expiresAt).toBe(now + OPEN_ROOM_LIFETIME_MS);
    expect(privateRoom.invitation.expiresAt).toBe(now + 86400000);
    now += OPEN_ROOM_LIFETIME_MS - 1;
    expect((await service.openRooms()).map((room) => room.id)).toEqual([open.game.id]);
    expect((await service.invitation(white, open.game.id)).expiresAt).toBe(
      open.invitation.expiresAt,
    );
    expect((await service.view(white, open.game.id)).game.phase).toBe("waiting");
    now += 1;
    expect(await service.openRooms()).toEqual([]);
    await expect(service.invitation(white, open.game.id)).rejects.toMatchObject({
      code: "ROOM_CLOSED",
    });
    const expired = await service.view(white, open.game.id);
    expect(expired.game.closure).toEqual({ reason: "expired", closedAt: now });
    expect(expired.game.revision).toBe(1);
    expect(expired.game.outcome).toBeNull();
    expect((await service.view(white, privateRoom.game.id)).game.phase).toBe("waiting");
    expect(await service.expireDue()).toBeUndefined();
    expect((await service.view(white, open.game.id)).game.revision).toBe(1);
  });

  it.each(["public", "invitation"] as const)(
    "rejects a late %s join and commits the recovered closure even with a legacy long-lived invite",
    async (route) => {
      const open = await service.create(white, {
        rulesetId: "standard",
        color: "white",
        timeControl: "untimed",
        visibility: "open",
      });
      await database.pool.query(
        "UPDATE invitations SET expires_at=expires_at+interval '23 hours' WHERE match_id=$1",
        [open.game.id],
      );
      now += OPEN_ROOM_LIFETIME_MS;
      await expect(
        route === "public"
          ? service.joinOpen(black, open.game.id)
          : service.join(black, open.invitation.token),
      ).rejects.toMatchObject({
        code: route === "public" ? "ROOM_UNAVAILABLE" : "INVITATION_UNAVAILABLE",
      });
      const expired = await service.view(white, open.game.id);
      expect(expired.game).toMatchObject({
        phase: "finished",
        revision: 1,
        outcome: null,
        closure: { reason: "expired", closedAt: now },
      });
      expect(await database.transaction((tx) => tx.listSeats(open.game.id))).toHaveLength(1);
      expect(await database.transaction((tx) => tx.listEvents(open.game.id, 0))).toHaveLength(1);
      expect(
        (await database.transaction((tx) => tx.getInvitation(tokenHash(open.invitation.token))))
          ?.consumedAt,
      ).toBeNull();
    },
  );

  it("expires a room during a stale close command without rolling back or storing an accepted close receipt", async () => {
    const created = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
      visibility: "open",
    });
    const close = command(0, { type: "close-room" });
    now += OPEN_ROOM_LIFETIME_MS;
    await expect(service.command(white, created.game.id, close)).rejects.toMatchObject({
      code: "ROOM_CLOSED",
    });
    const view = await service.view(white, created.game.id);
    expect(view.game.closure?.reason).toBe("expired");
    expect(
      await database.transaction((tx) => tx.getReceipt(created.game.id, white.id, close.commandId)),
    ).toBeNull();
    expect(
      (await database.transaction((tx) => tx.listEvents(created.game.id, 0))).map(
        (event) => event.type,
      ),
    ).toEqual(["room-expired"]);
  });

  it("recovers waiting deadlines across restart and ignores active open games after one hour", async () => {
    const active = await start({ visibility: "open" });
    const waiting = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
      visibility: "open",
    });
    now += OPEN_ROOM_LIFETIME_MS;
    await database.close();
    database = new Database(connectionString, { options: `-c search_path=${schema}` });
    service = new GameService(database, () => now);
    await service.expireDue();
    expect((await service.publicView(waiting.game.id))?.closure).toEqual({
      reason: "expired",
      closedAt: now,
    });
    expect((await service.view(white, active.game.id)).game.phase).toBe("active");
    expect((await service.view(white, active.game.id)).game).not.toHaveProperty("closure");
    await service.expireDue();
    expect(await database.transaction((tx) => tx.listEvents(waiting.game.id, 0))).toHaveLength(1);
  });

  it("excludes elapsed open rooms from capacity before the worker has processed them", async () => {
    for (let index = 0; index < 10; index += 1)
      await service.create(white, {
        rulesetId: "standard",
        color: "white",
        timeControl: "untimed",
        visibility: "open",
      });
    now += OPEN_ROOM_LIFETIME_MS;
    const privateRoom = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
    });
    expect(privateRoom.game.phase).toBe("waiting");
    const guestRoom = await service.create(black, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
    });
    expect((await service.join(white, guestRoom.invitation.token)).game.phase).toBe("active");
  });

  it.each(["public", "invitation"] as const)(
    "rechecks the one-hour deadline after a %s join waits for guest capacity",
    async (route) => {
      const created = await service.create(white, {
        rulesetId: "standard",
        color: "white",
        timeControl: "5+0",
        visibility: "open",
      });
      now += OPEN_ROOM_LIFETIME_MS - 1;
      let signalLocked: () => void = () => undefined;
      let releaseLock: () => void = () => undefined;
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const holder = database.transaction(async (tx) => {
        await tx.client.query("SELECT id FROM player_sessions WHERE id=$1 FOR UPDATE", [black.id]);
        signalLocked();
        await released;
      });
      await locked;
      const join =
        route === "public"
          ? service.joinOpen(black, created.game.id)
          : service.join(black, created.invitation.token);
      const rejected = expect(join).rejects.toMatchObject({
        code: route === "public" ? "ROOM_UNAVAILABLE" : "INVITATION_UNAVAILABLE",
      });
      try {
        await expect
          .poll(
            async () => {
              const result = await database.pool.query<{ blocked: boolean }>(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT expires_at FROM player_sessions%') AS blocked",
              );
              return result.rows[0]?.blocked;
            },
            { timeout: 2000, interval: 10 },
          )
          .toBe(true);
        now += 1;
      } finally {
        releaseLock();
        await holder;
      }
      await rejected;
      const view = await service.view(white, created.game.id);
      expect(view.game).toMatchObject({
        phase: "finished",
        revision: 1,
        closure: { reason: "expired", closedAt: now },
        outcome: null,
      });
      expect(view.game.clocks?.turnStartedAt).toBeNull();
      expect(await database.transaction((tx) => tx.listSeats(created.game.id))).toHaveLength(1);
      expect(
        (await database.transaction((tx) => tx.getInvitation(tokenHash(created.invitation.token))))
          ?.consumedAt,
      ).toBeNull();
    },
  );

  it("invalidates a renewed invitation when invitation rotation races host closure", async () => {
    const created = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
    });
    const results = await Promise.allSettled([
      service.invitation(white, created.game.id),
      service.command(white, created.game.id, command(0, { type: "close-room" })),
    ]);
    expect(results[1]?.status).toBe("fulfilled");
    const renewed = results[0];
    if (renewed?.status === "fulfilled")
      await expect(service.join(black, renewed.value.token)).rejects.toMatchObject({
        code: "INVITATION_UNAVAILABLE",
      });
    const invitations = await database.pool.query<{ expires_at: Date; consumed_at: Date | null }>(
      "SELECT expires_at,consumed_at FROM invitations WHERE match_id=$1",
      [created.game.id],
    );
    expect(invitations.rows).toHaveLength(1);
    expect(invitations.rows[0]?.expires_at.getTime()).toBe(now);
    expect(invitations.rows[0]?.consumed_at).toBeNull();
  });

  it("bounds expiration to a hundred candidates per pass and recovers the remaining room next time", async () => {
    const created = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
      visibility: "open",
    });
    await database.transaction(async (tx) => {
      const template = await tx.getGame(created.game.id);
      if (!template) throw new Error("Room is missing.");
      for (let index = 0; index < 100; index += 1) {
        const game = { ...template, id: randomUUID() };
        await tx.createGame(game);
        await tx.addSeat({ gameId: game.id, color: "white", sessionId: white.id });
      }
    });
    now += OPEN_ROOM_LIFETIME_MS;
    await service.expireDue();
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
    await service.expireDue();
    expect(await statuses()).toEqual([{ status: "finished", count: "101" }]);
  });

  it.each(["public-view", "pgn"] as const)(
    "recovers a waiting-room expiration when accessed through %s without a worker",
    async (route) => {
      const created = await service.create(white, {
        rulesetId: "standard",
        color: "white",
        timeControl: "untimed",
        visibility: "open",
      });
      now += OPEN_ROOM_LIFETIME_MS;
      if (route === "public-view")
        expect((await service.publicView(created.game.id))?.closure?.reason).toBe("expired");
      else
        await expect(service.pgn(white, created.game.id)).rejects.toMatchObject({
          code: "ROOM_CLOSED",
        });
      expect((await database.transaction((tx) => tx.getGame(created.game.id)))?.status).toBe(
        "finished",
      );
    },
  );

  it("renames the same guest identity without changing match state, clocks or saved acknowledgements", async () => {
    const started = await start({ timeControl: "10+5" });
    const move = command(started.game.revision, { type: "move", from: "e2", to: "e4" });
    const accepted = await service.command(white, started.game.id, move);
    const original = await database.transaction((tx) => tx.getGame(started.game.id));
    now += 5_000;
    const renamed = await service.rename(white, "  A new name  ");
    expect(renamed).toEqual({ ...white, displayName: "A new name" });
    expect((await service.view(black, started.game.id)).game.players.white).toEqual({
      displayName: "A new name",
    });
    expect(await database.transaction((tx) => tx.getGame(started.game.id))).toEqual(original);
    expect(await service.command(white, started.game.id, move)).toEqual(accepted);
    expect((await service.view(white, started.game.id)).seat).toBe("white");
    expect(await database.transaction((tx) => tx.listEvents(started.game.id, 2))).toEqual([]);
    const token = (await service.createSession("Other guest")).token;
    expect((await service.session(token))?.displayName).toBe("Other guest");
    await expect(service.rename(white, "\u0000Invalid")).rejects.toThrow();
    await expect(service.rename(white, " ")).rejects.toThrow();
    await database.pool.query(
      "UPDATE player_sessions SET created_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [white.id],
    );
    await expect(service.rename(white, "Expired")).rejects.toMatchObject({
      code: "SESSION_REQUIRED",
    });
  });

  it("rejects a rename when the unchanged guest session expires while its row lock is held", async () => {
    await database.pool.query(
      "UPDATE player_sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
      [white.id],
    );
    let signalLocked: () => void = () => undefined;
    let releaseLock: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holder = database.transaction(async (tx) => {
      await tx.client.query("SELECT id FROM player_sessions WHERE id=$1 FOR UPDATE", [white.id]);
      signalLocked();
      await released;
    });
    await locked;
    const rename = service.rename(white, "Expired rename");
    const rejected = expect(rename).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
    try {
      await expect
        .poll(
          async () => {
            const result = await database.pool.query<{ blocked: boolean }>(
              "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query='SELECT * FROM player_sessions WHERE id=$1 AND token_hash=$2 FOR UPDATE') AS blocked",
            );
            return result.rows[0]?.blocked;
          },
          { timeout: 2_000, interval: 10 },
        )
        .toBe(true);
      // Wait for the database deadline itself, not an arbitrary wall-clock sleep.
      await expect
        .poll(
          async () => {
            const result = await database.pool.query<{ expired: boolean }>(
              "SELECT expires_at<=clock_timestamp() AS expired FROM player_sessions WHERE id=$1",
              [white.id],
            );
            return result.rows[0]?.expired;
          },
          { timeout: 2_000, interval: 10 },
        )
        .toBe(true);
    } finally {
      releaseLock();
      await holder;
    }
    await rejected;
    const stored = await database.pool.query<{ display_name: string }>(
      "SELECT display_name FROM player_sessions WHERE id=$1",
      [white.id],
    );
    expect(stored.rows[0]?.display_name).toBe("White player");
  });

  it("lists only available deliberately open rooms and publishes summaries without invitation or identity secrets", async () => {
    const available = await service.create(white, {
      rulesetId: "catchess",
      color: "black",
      timeControl: "10+5",
      visibility: "open",
      catchess: { host: -30, guest: 80 },
    });
    const privateRoom = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
    });
    const expiredRoom = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
      visibility: "open",
    });
    await database.pool.query(
      "UPDATE matches SET created_at=to_timestamp($2/1000.0)-interval '24 hours' WHERE id=$1",
      [expiredRoom.game.id, now],
    );
    const expiredHost = (await service.createSession("Expired host")).session;
    const abandoned = await service.create(expiredHost, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
      visibility: "open",
    });
    await database.pool.query(
      "UPDATE player_sessions SET created_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [expiredHost.id],
    );
    const occupied = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
      visibility: "open",
    });
    await service.join(black, occupied.invitation.token);
    const rooms = await service.openRooms();
    expect(openRoomsSchema.parse({ rooms })).toEqual({ rooms });
    expect(rooms).toEqual([
      {
        id: available.game.id,
        host: { displayName: "White player", color: "black" },
        rulesetId: "catchess",
        timeControl: "10+5",
        catchess: { white: 80, black: -30 },
        createdAt: now,
        expiresAt: now + OPEN_ROOM_LIFETIME_MS,
      },
    ]);
    expect(available.game.visibility).toBe("open");
    expect(privateRoom.game).not.toHaveProperty("visibility");
    const encoded = JSON.stringify(rooms);
    for (const secret of [
      white.id,
      white.tokenHash,
      available.invitation.token,
      privateRoom.game.id,
      abandoned.game.id,
      occupied.game.id,
    ])
      expect(encoded).not.toContain(secret);
    await service.rename(white, "Updated host");
    expect((await service.openRooms())[0]?.host.displayName).toBe("Updated host");
    await expect(service.joinOpen(black, privateRoom.game.id)).rejects.toMatchObject({
      code: "ROOM_UNAVAILABLE",
    });
    await expect(service.joinOpen(black, expiredRoom.game.id)).rejects.toMatchObject({
      code: "ROOM_UNAVAILABLE",
    });
    await expect(service.joinOpen(black, abandoned.game.id)).rejects.toMatchObject({
      code: "ROOM_UNAVAILABLE",
    });
  });

  it("caps open discovery at fifty recent rooms and excludes rows without exactly one host", async () => {
    const created = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
      visibility: "open",
    });
    await database.transaction(async (tx) => {
      const template = await tx.getGame(created.game.id);
      if (!template) throw new Error("Room is missing.");
      for (let index = 0; index < 55; index += 1) {
        const game = {
          ...template,
          id: randomUUID(),
          createdAt: now + index + 1,
          updatedAt: now + index + 1,
        };
        await tx.createGame(game);
        await tx.addSeat({ gameId: game.id, color: "white", sessionId: white.id });
      }
      await tx.addSeat({ gameId: template.id, color: "black", sessionId: black.id });
      const empty = { ...template, id: randomUUID() };
      await tx.createGame(empty);
    });
    const rooms = await service.openRooms();
    expect(rooms).toHaveLength(50);
    expect(rooms[0]?.createdAt).toBe(now + 55);
    expect(rooms.at(-1)?.createdAt).toBe(now + 6);
    expect(rooms.map((room) => room.id)).not.toContain(created.game.id);
  });

  it("serializes open join competitors, recovers the winner's retry and atomically consumes the invitation", async () => {
    const third = (await service.createSession("Third player")).session;
    const created = await service.create(white, {
      rulesetId: "standard",
      color: "black",
      timeControl: "5+0",
      visibility: "open",
    });
    await expect(service.joinOpen(white, created.game.id)).rejects.toMatchObject({
      code: "OWN_ROOM",
    });
    const results = await Promise.allSettled([
      service.joinOpen(black, created.game.id),
      service.joinOpen(third, created.game.id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = results[0]?.status === "fulfilled" ? black : third;
    const loser = winner === black ? third : black;
    const view = await service.joinOpen(winner, created.game.id);
    expect(view.seat).toBe("white");
    expect(view.game.revision).toBe(1);
    expect(view.game.clocks?.runningColor).toBe("white");
    expect(view.game.clocks?.turnStartedAt).toBe(now);
    expect(await service.openRooms()).toEqual([]);
    expect(await service.join(winner, created.invitation.token)).toEqual(view);
    await expect(service.join(loser, created.invitation.token)).rejects.toMatchObject({
      code: "INVITATION_UNAVAILABLE",
    });
    await expect(service.joinOpen(loser, created.game.id)).rejects.toMatchObject({
      code: "ROOM_UNAVAILABLE",
    });
    expect(await database.transaction((tx) => tx.listSeats(created.game.id))).toHaveLength(2);
    expect(await database.transaction((tx) => tx.listEvents(created.game.id, 0))).toHaveLength(1);
  });

  it("allows only one winner when an invitation races an open-room join", async () => {
    const third = (await service.createSession("Third player")).session;
    const created = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
      visibility: "open",
    });
    const claims = await Promise.allSettled([
      service.join(black, created.invitation.token),
      service.joinOpen(third, created.game.id),
    ]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(await database.transaction((tx) => tx.listSeats(created.game.id))).toHaveLength(2);
    expect((await service.view(white, created.game.id)).game.revision).toBe(1);
  });

  it("rechecks host expiry after waiting for the joining guest's capacity lock", async () => {
    const created = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "5+0",
      visibility: "open",
    });
    await database.pool.query(
      "UPDATE player_sessions SET expires_at=to_timestamp($2/1000.0) WHERE id=$1",
      [white.id, now + 1_000],
    );
    let signalLocked: () => void = () => undefined;
    let releaseLock: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holder = database.transaction(async (tx) => {
      await tx.client.query("SELECT id FROM player_sessions WHERE id=$1 FOR UPDATE", [black.id]);
      signalLocked();
      await released;
    });
    await locked;
    const join = service.joinOpen(black, created.game.id);
    const rejected = expect(join).rejects.toMatchObject({ code: "ROOM_UNAVAILABLE" });
    try {
      await expect
        .poll(
          async () => {
            const result = await database.pool.query<{ blocked: boolean }>(
              "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT expires_at FROM player_sessions%') AS blocked",
            );
            return result.rows[0]?.blocked;
          },
          { timeout: 2_000, interval: 10 },
        )
        .toBe(true);
      now += 1_000;
    } finally {
      releaseLock();
      await holder;
    }
    await rejected;
    const stored = await database.transaction((tx) => tx.getGame(created.game.id));
    expect(stored?.status).toBe("finished");
    expect(stored?.revision).toBe(1);
    expect(stored?.lifecycle.closure).toEqual({ reason: "expired", closedAt: now });
    expect(await database.transaction((tx) => tx.listSeats(created.game.id))).toHaveLength(1);
    expect(
      (await database.transaction((tx) => tx.getInvitation(tokenHash(created.invitation.token))))
        ?.consumedAt,
    ).toBeNull();
  });

  it("limits open joins and profile broadcasts to the authenticated guest's available seats", async () => {
    for (let index = 0; index < 10; index += 1)
      await service.create(black, {
        rulesetId: "standard",
        color: "black",
        timeControl: "untimed",
      });
    const open = await service.create(white, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
      visibility: "open",
    });
    await expect(service.joinOpen(black, open.game.id)).rejects.toMatchObject({
      code: "ROOM_LIMIT",
    });
    expect((await service.openRooms()).map((room) => room.id)).toEqual([open.game.id]);
    expect(await service.profiles([open.game.id], black.id)).toEqual([]);
    expect(await service.profiles([open.game.id], white.id)).toEqual([
      {
        gameId: open.game.id,
        revision: 0,
        players: { white: { displayName: "White player" }, black: null },
      },
    ]);
    await expect(service.profiles(Array.from({ length: 101 }, () => open.game.id))).rejects.toThrow(
      "100 games",
    );
  });

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

  it("discovers a Chaos Cat lobby without adjustable settings and preserves its mode through a rematch", async () => {
    const created = await service.create(black, {
      rulesetId: "chaos-cat",
      color: "black",
      timeControl: "10+5",
      visibility: "open",
    });
    const rooms = openRoomsSchema.parse({ rooms: await service.openRooms() }).rooms;
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({
      id: created.game.id,
      rulesetId: "chaos-cat",
      host: { color: "black", displayName: "Black player" },
      timeControl: "10+5",
    });
    expect(rooms[0]).not.toHaveProperty("catchess");
    let view = await service.joinOpen(white, created.game.id);
    view = await act(view, black, { type: "resign" });
    view = await act(view, black, { type: "request-rematch" });
    view = await act(view, white, { type: "accept-rematch" });
    if (!view.game.rematchGameId) throw new Error("A Chaos Cat rematch was not created.");
    const successor = gameViewSchema.parse(await service.view(black, view.game.rematchGameId));
    expect(successor.seat).toBe("white");
    expect(successor.game).toMatchObject({
      rulesetId: "chaos-cat",
      timeControl: "10+5",
      phase: "active",
    });
    expect(successor.game).not.toHaveProperty("catchess");
    expect(successor.game.position.catEffects).toEqual([]);
    expect(successor.game.position.threatenedKings).toEqual([]);
    expect(successor.game.position.board).toHaveLength(32);
    expect((await service.view(white, successor.game.id)).seat).toBe("black");
  });

  it("persists a missing Chaos Cat target as a no-op without stealing a different piece", async () => {
    const draw = "17".padStart(64, "0");
    service = new GameService(
      database,
      () => now,
      () => draw,
    );
    const view = await start({ rulesetId: "chaos-cat" });
    await database.pool.query("UPDATE matches SET engine_state=$2 WHERE id=$1", [
      view.game.id,
      createEngineState("chaos-cat", "4k3/8/8/8/8/8/P7/4K3 w - - 0 1"),
    ]);
    const accepted = await act(view, white, { type: "move", from: "a2", to: "a3" });
    expect(gameViewSchema.parse(accepted)).toEqual(accepted);
    expect(accepted.game.phase).toBe("active");
    expect(accepted.game.position.board).toHaveLength(3);
    expect(accepted.game.position.catEffects).toEqual([
      { ply: 1, color: "white", action: "none", piece: "r" },
    ]);
    expect(accepted.game.position.board).toContainEqual({
      square: "a3",
      type: "p",
      color: "white",
    });
    const stored = await database.transaction((tx) => tx.getGame(view.game.id));
    expect(engineStateSchema.parse(stored?.engineState).catTurns).toEqual([
      { draw, effect: accepted.game.position.catEffects?.[0] },
    ]);
    const events = await database.transaction((tx) => tx.listEvents(view.game.id, 1));
    expect(events[0]?.payload.catEffect).toEqual(accepted.game.position.catEffects?.[0]);
    expect(await service.pgn(white, view.game.id)).toContain('[Variant "Chaos Cat"]');
  });

  it("recovers a cat-exposed king and finishes a captured king with one durable acknowledgement", async () => {
    const draw = vi.fn(() => "17".padStart(64, "0"));
    service = new GameService(database, () => now, draw);
    let view = await start({ rulesetId: "chaos-cat", timeControl: "10+5" });
    await database.pool.query("UPDATE matches SET engine_state=$2 WHERE id=$1", [
      view.game.id,
      createEngineState("chaos-cat", "k3r3/8/8/8/8/8/P3R3/4K3 w - - 0 1"),
    ]);
    view = await act(view, white, { type: "move", from: "a2", to: "a3" });
    expect(gameViewSchema.parse(view)).toEqual(view);
    expect(view.game.phase).toBe("active");
    expect(view.game.position.catEffects?.[0]).toEqual({
      ply: 1,
      color: "white",
      action: "remove",
      piece: "r",
      square: "e2",
    });
    expect(view.game.position.threatenedKings).toEqual(["white"]);
    expect(view.game.position.legalMoves).toContainEqual({ from: "e8", to: "e1" });
    await database.close();
    database = new Database(connectionString, { options: `-c search_path=${schema}` });
    service = new GameService(database, () => now, draw);
    const restored = await service.view(black, view.game.id);
    expect(restored.game.position).toEqual(view.game.position);
    const capture = command(restored.game.revision, { type: "move", from: "e8", to: "e1" });
    const accepted = await service.command(black, view.game.id, capture);
    expect(gameViewSchema.parse(accepted)).toEqual(accepted);
    expect(accepted.game).toMatchObject({
      phase: "finished",
      outcome: { winner: "black", reason: "king-captured" },
      clocks: { runningColor: null, turnStartedAt: null },
    });
    expect(accepted.game.position.outcome).toEqual(accepted.game.outcome);
    expect(
      accepted.game.position.board.some((piece) => piece.color === "white" && piece.type === "k"),
    ).toBe(false);
    expect(accepted.game.position.legalMoves).toEqual([]);
    expect(accepted.game.position.catEffects).toHaveLength(2);
    expect(accepted.game.position.catEffects?.[1]?.action).toBe("none");
    expect(await service.command(black, view.game.id, capture)).toEqual(accepted);
    const events = await database.transaction((tx) => tx.listEvents(view.game.id, 1));
    expect(events).toHaveLength(2);
    expect(events[1]?.payload.outcome).toEqual(accepted.game.outcome);
    expect(events[1]?.payload.catEffect).toEqual(accepted.game.position.catEffects?.[1]);
    await expect(
      act(accepted, white, { type: "move", from: "a3", to: "a4" }),
    ).rejects.toMatchObject({
      code: "GAME_NOT_ACTIVE",
    });
    const pgn = await service.pgn(white, view.game.id);
    expect(pgn).toContain('[Variant "Chaos Cat"]');
    expect(pgn).toContain('[Result "0-1"]');
    expect(pgn).toContain("remove");
    expect(pgn).toContain("r e2");
    expect(pgn).not.toContain("17".padStart(64, "0"));
    await database.close();
    database = new Database(connectionString, { options: `-c search_path=${schema}` });
    service = new GameService(database, () => now, draw);
    expect((await service.view(white, view.game.id)).game.position).toEqual(accepted.game.position);
    expect(await service.command(black, view.game.id, capture)).toEqual(accepted);
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

  it.each(["catchess", "chaos-cat"] as const)(
    "draws $0 entropy only after authorization, revision and turn guards and never rerolls accepted retries",
    async (rulesetId) => {
      const draw = vi.fn(() => "a".repeat(64));
      service = new GameService(database, () => now, draw);
      const view = await start({
        rulesetId,
        ...(rulesetId === "catchess" ? { catchess: { host: 100, guest: -100 } } : {}),
      });
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
      if (!accepted) throw new Error("Cat move was not acknowledged.");
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
    },
  );

  it.each(["catchess", "chaos-cat"] as const)(
    "serializes competing $0 commands without applying a second cat effect",
    async (rulesetId) => {
      const draw = vi.fn(() => "b".repeat(64));
      service = new GameService(database, () => now, draw);
      const view = await start({
        rulesetId,
        ...(rulesetId === "catchess" ? { catchess: { host: 100, guest: 0 } } : {}),
      });
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
      expect(current.game.position.board).toHaveLength(
        current.game.position.catEffects?.[0]?.action === "add" ? 33 : 31,
      );
    },
  );

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

  it("awards a Chaos Cat timeout to a bare king because the cat can grant winning material", async () => {
    const view = await start({ rulesetId: "chaos-cat", timeControl: "5+0" });
    await database.pool.query("UPDATE matches SET engine_state=$2 WHERE id=$1", [
      view.game.id,
      createEngineState("chaos-cat", "4k3/8/8/8/8/8/R7/K7 w - - 0 1"),
    ]);
    now += 300_000;
    await service.expireDue();
    const expired = gameViewSchema.parse(await service.view(white, view.game.id));
    expect(expired.game.outcome).toEqual({ winner: "black", reason: "timeout" });
    expect(expired.game.position.catEffects).toEqual([]);
    expect(expired.game.clocks?.runningColor).toBeNull();
  });

  it("bounds rooms and retains expired waiting closures while retaining an active game", async () => {
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
    await service.expireDue();
    await service.cleanup();
    await database.transaction(async (tx) => {
      expect((await tx.getGame(expired.game.id))?.lifecycle.closure).toEqual({
        reason: "expired",
        closedAt: now,
      });
      expect((await tx.getGame(active.game.id))?.status).toBe("active");
      const invitation = await tx.getInvitation(tokenHash(expired.invitation.token));
      expect(invitation?.consumedAt).toBeNull();
      expect(invitation?.expiresAt).toBe(now);
      expect((await tx.listEvents(expired.game.id, 0)).map((event) => event.type)).toEqual([
        "room-expired",
      ]);
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
      expect(retained?.status).toBe("finished");
      expect(retained?.revision).toBe(1);
      expect(retained?.lifecycle.closure).toEqual({ reason: "expired", closedAt: now });
      expect(await tx.listSeats(created.game.id)).toHaveLength(1);
      expect((await tx.getInvitation(tokenHash(invitation.token)))?.consumedAt).toBeNull();
    });
  });
});
