import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database, StorageConflictError } from "./database.js";
import { migrate, readMigrations } from "./migrations.js";
import type { GameRecord, SessionRecord } from "./records.js";

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!connectionString)("PostgreSQL durable storage", () => {
  let administrator: Pool;
  let database: Database;
  let schema: string;

  beforeEach(async () => {
    schema = `storage_test_${randomUUID().replaceAll("-", "")}`;
    administrator = new Pool({ connectionString, max: 1 });
    await administrator.query(`CREATE SCHEMA "${schema}"`);
    database = new Database(connectionString ?? "", { options: `-c search_path=${schema}` });
    await migrate(database.pool);
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

  function makeSession(displayName = "Player"): SessionRecord {
    return {
      id: randomUUID(),
      tokenHash: randomUUID().replaceAll("-", "").repeat(2),
      displayName,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
  }

  function makeGame(): GameRecord {
    return {
      id: randomUUID(),
      revision: 0,
      status: "waiting",
      rulesetId: "standard",
      rulesVersion: 1,
      rulesConfig: {},
      engineState: { initialFen: "initial-position", moves: [] },
      lifecycle: { clocks: null, drawOfferedBy: null },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  async function seedGame(): Promise<{ game: GameRecord; session: SessionRecord }> {
    const game = makeGame();
    const session = makeSession();
    await database.transaction(async (transaction) => {
      await transaction.createSession(session);
      await transaction.createGame(game);
      await transaction.addSeat({ gameId: game.id, color: "white", sessionId: session.id });
    });
    return { game, session };
  }

  it("runs migrations with an ordinary role and checks immutable migration checksums", async () => {
    const role = await database.pool.query<{
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>("SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user");
    expect(role.rows[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    expect(await database.ready()).toBe(true);
    expect(await migrate(database.pool)).toEqual([]);
    const migrations = await readMigrations();
    const first = migrations[0];
    if (!first) throw new Error("Initial migration is missing.");
    await expect(
      migrate(database.pool, [{ ...first, sql: `${first.sql}\n-- altered migration` }]),
    ).rejects.toThrow("Applied migration was changed");
  });

  it("rolls back an entire failed migration and preserves the previous schema", async () => {
    const migrations = await readMigrations();
    await expect(
      migrate(database.pool, [
        ...migrations,
        {
          name: "002_failed.sql",
          sql: "CREATE TABLE should_rollback (id integer); SELECT * FROM missing_table;",
        },
      ]),
    ).rejects.toThrow();
    const result = await database.pool.query<{ table_name: string | null }>(
      "SELECT to_regclass('should_rollback')::text AS table_name",
    );
    expect(result.rows[0]?.table_name).toBeNull();
    expect(await migrate(database.pool)).toEqual([]);
    expect(await database.ready()).toBe(true);
  });

  it("serializes conflicting writers through separate real PostgreSQL connections", async () => {
    const { game } = await seedGame();
    let arrivals = 0;
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connections = new Set<number>();
    const write = () =>
      database.transaction(async (transaction) => {
        const result = await transaction.client.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const pid = result.rows[0]?.pid;
        if (pid === undefined) throw new Error("Database connection is missing.");
        connections.add(pid);
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
        const stored = await transaction.lockGame(game.id);
        if (stored?.revision !== 0) return false;
        await transaction.saveGame({ ...stored, revision: 1, status: "active" }, 0);
        await transaction.appendEvent({
          gameId: game.id,
          revision: 1,
          type: "joined",
          payload: { revision: 1 },
          createdAt: await transaction.databaseNow(),
        });
        return true;
      });
    expect((await Promise.all([write(), write()])).sort()).toEqual([false, true]);
    expect(connections.size).toBe(2);
    await database.transaction(async (transaction) => {
      expect((await transaction.getGame(game.id))?.revision).toBe(1);
      expect(await transaction.listEvents(game.id, 0)).toHaveLength(1);
    });
  });

  it("rejects a stale revision even when the caller omitted a match lock", async () => {
    const { game } = await seedGame();
    await database.transaction((transaction) => transaction.saveGame({ ...game, revision: 1 }, 0));
    await expect(
      database.transaction((transaction) => transaction.saveGame({ ...game, revision: 1 }, 0)),
    ).rejects.toBeInstanceOf(StorageConflictError);
  });

  it("recovers overdue active games while excluding waiting, completed and future deadlines", async () => {
    const now = Date.now();
    const overdue = {
      ...makeGame(),
      status: "active" as const,
      lifecycle: { deadlineAt: now - 1_000 },
    };
    const waiting = { ...makeGame(), lifecycle: { deadlineAt: now - 1_000 } };
    const finished = {
      ...makeGame(),
      status: "finished" as const,
      lifecycle: { deadlineAt: now - 1_000 },
    };
    const future = {
      ...makeGame(),
      status: "active" as const,
      lifecycle: { deadlineAt: now + 60_000 },
    };
    await database.transaction(async (transaction) => {
      for (const game of [overdue, waiting, finished, future]) await transaction.createGame(game);
      expect(await transaction.findGamesDue()).toEqual([overdue.id]);
    });
    await database.close();
    database = new Database(connectionString ?? "", { options: `-c search_path=${schema}` });
    expect(await database.transaction((transaction) => transaction.findGamesDue())).toEqual([
      overdue.id,
    ]);
  });

  it("rolls snapshots, ordered events, receipts and the outbox back together", async () => {
    const { game, session } = await seedGame();
    const commandId = randomUUID();
    await expect(
      database.transaction(async (transaction) => {
        await transaction.lockGame(game.id);
        await transaction.saveGame({ ...game, revision: 1 }, 0);
        await transaction.appendEvent({
          gameId: game.id,
          revision: 1,
          type: "move",
          payload: { from: "e2", to: "e4" },
          createdAt: Date.now(),
        });
        await transaction.storeReceipt({
          gameId: game.id,
          sessionId: session.id,
          commandId,
          payloadHash: "a".repeat(64),
          acknowledgement: { accepted: true, revision: 1 },
          createdAt: Date.now(),
        });
        throw new Error("Simulated application failure before commit");
      }),
    ).rejects.toThrow("before commit");
    await database.transaction(async (transaction) => {
      expect((await transaction.getGame(game.id))?.revision).toBe(0);
      expect(await transaction.listEvents(game.id, -1)).toEqual([]);
      expect(await transaction.getReceipt(game.id, session.id, commandId)).toBeNull();
      expect(await transaction.claimOutbox()).toEqual([]);
    });
  });

  it("keeps hashed sessions and command acknowledgements across pool restart", async () => {
    const { game, session } = await seedGame();
    const commandId = randomUUID();
    const acknowledgement = { accepted: true, revision: 0 };
    await database.transaction((transaction) =>
      transaction.storeReceipt({
        gameId: game.id,
        sessionId: session.id,
        commandId,
        payloadHash: "b".repeat(64),
        acknowledgement,
        createdAt: Date.now(),
      }),
    );
    await database.close();
    database = new Database(connectionString ?? "", { options: `-c search_path=${schema}` });
    await database.transaction(async (transaction) => {
      expect(await transaction.getSession(session.tokenHash)).toEqual(session);
      expect(await transaction.getSession("c".repeat(64))).toBeNull();
      expect(await transaction.getGame(game.id)).toEqual(game);
      expect(
        (await transaction.getReceipt(game.id, session.id, commandId))?.acknowledgement,
      ).toEqual(acknowledgement);
    });
  });

  it("allows only one competing invitation claim and enforces one seat per participant", async () => {
    const { game } = await seedGame();
    const first = makeSession("First");
    const second = makeSession("Second");
    const tokenHash = "d".repeat(64);
    await database.transaction(async (transaction) => {
      await transaction.createSession(first);
      await transaction.createSession(second);
      await transaction.createInvitation({
        id: randomUUID(),
        gameId: game.id,
        color: "black",
        tokenHash,
        expiresAt: Date.now() + 60_000,
        consumedBy: null,
        consumedAt: null,
      });
    });
    const claim = (sessionId: string) =>
      database.transaction(async (transaction) => {
        await transaction.lockGame(game.id);
        const invitation = await transaction.consumeInvitation(tokenHash, sessionId);
        if (!invitation) return false;
        await transaction.addSeat({ gameId: game.id, color: "black", sessionId });
        return true;
      });
    expect((await Promise.all([claim(first.id), claim(second.id)])).sort()).toEqual([false, true]);
    await database.transaction(async (transaction) => {
      expect(await transaction.listSeats(game.id)).toHaveLength(2);
      expect((await transaction.getInvitation(tokenHash))?.consumedBy).not.toBeNull();
    });
    await expect(
      database.transaction((transaction) =>
        transaction.addSeat({ gameId: game.id, color: "black", sessionId: first.id }),
      ),
    ).rejects.toThrow();
  });

  it("rejects expired sessions and invitation claims without consuming the invitation", async () => {
    const { game } = await seedGame();
    const session = makeSession();
    session.createdAt = Date.now() - 10_000;
    session.expiresAt = Date.now() - 1;
    const tokenHash = "e".repeat(64);
    await database.transaction(async (transaction) => {
      await transaction.createSession(session);
      await transaction.createInvitation({
        id: randomUUID(),
        gameId: game.id,
        color: "black",
        tokenHash,
        expiresAt: Date.now() - 1,
        consumedBy: null,
        consumedAt: null,
      });
      expect(await transaction.getSession(session.tokenHash)).toBeNull();
      expect(await transaction.renewSession(session.id, Date.now() + 60_000)).toBe(false);
      expect(await transaction.consumeInvitation(tokenHash, session.id)).toBeNull();
      expect((await transaction.getInvitation(tokenHash))?.consumedBy).toBeNull();
    });
  });

  it("leases outbox work once, rejects stale lease completion and supports retry", async () => {
    const { game } = await seedGame();
    await database.transaction((transaction) =>
      transaction.appendEvent({
        gameId: game.id,
        revision: 0,
        type: "created",
        payload: { status: "waiting" },
        createdAt: Date.now(),
      }),
    );
    const claim = () => database.transaction((transaction) => transaction.claimOutbox(1, 100));
    const results = await Promise.all([claim(), claim()]);
    expect(results.flat()).toHaveLength(1);
    const event = results.flat()[0];
    if (!event) throw new Error("Outbox event is missing.");
    expect(event.attempts).toBe(1);
    await database.pool.query(
      "UPDATE event_outbox SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1",
      [event.id],
    );
    const retried = (await claim())[0];
    if (!retried) throw new Error("Outbox retry is missing.");
    expect(retried.attempts).toBe(2);
    expect(retried.leaseToken).not.toBe(event.leaseToken);
    await database.transaction(async (transaction) => {
      expect(await transaction.completeOutbox(event.id, event.leaseToken)).toBe(false);
      expect(await transaction.completeOutbox(retried.id, retried.leaseToken)).toBe(true);
      expect(await transaction.claimOutbox()).toEqual([]);
    });
  });
});
