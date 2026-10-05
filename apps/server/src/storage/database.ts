import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";

import type {
  CommandReceipt,
  GameEvent,
  GameRecord,
  InvitationRecord,
  OutboxEvent,
  SeatRecord,
  SessionRecord,
} from "./records.js";

interface GameRow extends QueryResultRow {
  id: string;
  revision: number;
  status: GameRecord["status"];
  ruleset_id: string;
  rules_version: number;
  rules_config: GameRecord["rulesConfig"];
  engine_state: GameRecord["engineState"];
  lifecycle: GameRecord["lifecycle"];
  created_at: Date;
  updated_at: Date;
}

interface SessionRow extends QueryResultRow {
  id: string;
  token_hash: string;
  display_name: string;
  created_at: Date;
  expires_at: Date;
}

interface InvitationRow extends QueryResultRow {
  id: string;
  match_id: string;
  color: InvitationRecord["color"];
  token_hash: string;
  expires_at: Date;
  consumed_by: string | null;
  consumed_at: Date | null;
}

interface EventRow extends QueryResultRow {
  match_id: string;
  revision: number;
  type: string;
  payload: GameEvent["payload"];
  created_at: Date;
}

function gameRecord(row: GameRow): GameRecord {
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    rulesetId: row.ruleset_id,
    rulesVersion: row.rules_version,
    rulesConfig: row.rules_config,
    engineState: row.engine_state,
    lifecycle: row.lifecycle,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

function sessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    displayName: row.display_name,
    expiresAt: row.expires_at.getTime(),
    createdAt: row.created_at.getTime(),
  };
}

function invitationRecord(row: InvitationRow): InvitationRecord {
  return {
    id: row.id,
    gameId: row.match_id,
    color: row.color,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at.getTime(),
    consumedBy: row.consumed_by,
    consumedAt: row.consumed_at?.getTime() ?? null,
  };
}

function eventRecord(row: EventRow): GameEvent {
  return {
    gameId: row.match_id,
    revision: row.revision,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at.getTime(),
  };
}

export class StorageConflictError extends Error {
  constructor() {
    super("The stored match revision changed.");
    this.name = "StorageConflictError";
  }
}

/** PostgreSQL owns durable state; callers own authorization and chess decisions. */
export class Database {
  readonly pool: Pool;
  idleErrorCount = 0;
  private acquireWaitSamples: number[] = [];

  get transactionAcquireP95Ms(): number {
    const sorted = [...this.acquireWaitSamples].sort((a, b) => a - b);
    return Math.round((sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0) * 100) / 100;
  }

  constructor(connectionString: string, options: PoolConfig = {}) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      application_name: "chess-room",
      ...options,
    });
    // An idle client's failure must not become an uncaught process exception.
    // Readiness and the next command report the unavailable database to callers.
    this.pool.on("error", () => {
      this.idleErrorCount += 1;
    });
  }

  async ready(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1 FROM matches LIMIT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async transaction<T>(operation: (transaction: Transaction) => Promise<T>): Promise<T> {
    const started = performance.now();
    const client = await this.pool.connect();
    this.acquireWaitSamples.push(performance.now() - started);
    if (this.acquireWaitSamples.length > 256) this.acquireWaitSamples.shift();
    let destroyClient = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '3s'");
      const result = await operation(new Transaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        destroyClient = true;
      }
      throw error;
    } finally {
      client.release(destroyClient);
    }
  }
}

export class Transaction {
  constructor(readonly client: PoolClient) {}

  /** Use after acquiring the match lock; transaction-start time is too early. */
  async databaseNow(): Promise<number> {
    const result = await this.client.query<{ current_time: Date }>(
      "SELECT clock_timestamp() AS current_time",
    );
    const row = result.rows[0];
    if (!row) throw new Error("Database did not return the current time.");
    return row.current_time.getTime();
  }

  async getSession(tokenHash: string): Promise<SessionRecord | null> {
    const result = await this.client.query<SessionRow>(
      "SELECT * FROM player_sessions WHERE token_hash = $1 AND expires_at > clock_timestamp()",
      [tokenHash],
    );
    return result.rows[0] ? sessionRecord(result.rows[0]) : null;
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO player_sessions (id, token_hash, display_name, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        session.id,
        session.tokenHash,
        session.displayName,
        new Date(session.createdAt),
        new Date(session.expiresAt),
      ],
    );
  }

  async renewSession(sessionId: string, expiresAt: number): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE player_sessions SET expires_at = $2
       WHERE id = $1 AND expires_at > clock_timestamp()`,
      [sessionId, new Date(expiresAt)],
    );
    return result.rowCount === 1;
  }

  async lockGame(gameId: string): Promise<GameRecord | null> {
    const result = await this.client.query<GameRow>(
      "SELECT * FROM matches WHERE id = $1 FOR UPDATE",
      [gameId],
    );
    return result.rows[0] ? gameRecord(result.rows[0]) : null;
  }

  async getGame(gameId: string): Promise<GameRecord | null> {
    const result = await this.client.query<GameRow>("SELECT * FROM matches WHERE id = $1", [
      gameId,
    ]);
    return result.rows[0] ? gameRecord(result.rows[0]) : null;
  }

  /** Candidates only: the worker must lock and reevaluate the deadline before finishing. */
  async findGamesDue(limit = 100): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Deadline page size must be between 1 and 1000.");
    }
    const result = await this.client.query<{ id: string }>(
      `SELECT id FROM matches WHERE status = 'active'
       AND (lifecycle ->> 'deadlineAt')::bigint <=
         floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
       ORDER BY (lifecycle ->> 'deadlineAt')::bigint, id LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.id);
  }

  async createGame(game: GameRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO matches (id, revision, status, ruleset_id, rules_version, rules_config,
       engine_state, lifecycle, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        game.id,
        game.revision,
        game.status,
        game.rulesetId,
        game.rulesVersion,
        game.rulesConfig,
        game.engineState,
        game.lifecycle,
        new Date(game.createdAt),
        new Date(game.updatedAt),
      ],
    );
  }

  async saveGame(game: GameRecord, expectedRevision: number): Promise<void> {
    if (game.revision !== expectedRevision + 1) throw new StorageConflictError();
    const result = await this.client.query(
      `UPDATE matches SET revision = $2, status = $3, engine_state = $4, lifecycle = $5,
       updated_at = $6 WHERE id = $1 AND revision = $7`,
      [
        game.id,
        game.revision,
        game.status,
        game.engineState,
        game.lifecycle,
        new Date(game.updatedAt),
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) throw new StorageConflictError();
  }

  async listSeats(gameId: string): Promise<SeatRecord[]> {
    const result = await this.client.query<{
      match_id: string;
      color: SeatRecord["color"];
      session_id: string;
    }>("SELECT match_id, color, session_id FROM match_seats WHERE match_id = $1 ORDER BY color", [
      gameId,
    ]);
    return result.rows.map((row) => ({
      gameId: row.match_id,
      color: row.color,
      sessionId: row.session_id,
    }));
  }

  async addSeat(seat: SeatRecord): Promise<void> {
    await this.client.query(
      "INSERT INTO match_seats (match_id, color, session_id) VALUES ($1, $2, $3)",
      [seat.gameId, seat.color, seat.sessionId],
    );
  }

  async createInvitation(invitation: InvitationRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO invitations (id, match_id, color, token_hash, expires_at, consumed_by, consumed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        invitation.id,
        invitation.gameId,
        invitation.color,
        invitation.tokenHash,
        new Date(invitation.expiresAt),
        invitation.consumedBy,
        invitation.consumedAt === null ? null : new Date(invitation.consumedAt),
      ],
    );
  }

  async getInvitation(tokenHash: string, lock = false): Promise<InvitationRecord | null> {
    const result = await this.client.query<InvitationRow>(
      `SELECT * FROM invitations WHERE token_hash = $1${lock ? " FOR UPDATE" : ""}`,
      [tokenHash],
    );
    return result.rows[0] ? invitationRecord(result.rows[0]) : null;
  }

  /** Call after locking the match. Expiry and consumption are checked atomically. */
  async consumeInvitation(tokenHash: string, sessionId: string): Promise<InvitationRecord | null> {
    const result = await this.client.query<InvitationRow>(
      `UPDATE invitations SET consumed_by = $2, consumed_at = clock_timestamp()
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > clock_timestamp()
       RETURNING *`,
      [tokenHash, sessionId],
    );
    return result.rows[0] ? invitationRecord(result.rows[0]) : null;
  }

  async getReceipt(
    gameId: string,
    sessionId: string,
    commandId: string,
  ): Promise<CommandReceipt | null> {
    const result = await this.client.query<{
      match_id: string;
      session_id: string;
      command_id: string;
      payload_hash: string;
      acknowledgement: CommandReceipt["acknowledgement"];
      created_at: Date;
    }>(
      "SELECT * FROM command_receipts WHERE match_id = $1 AND session_id = $2 AND command_id = $3",
      [gameId, sessionId, commandId],
    );
    const row = result.rows[0];
    return row
      ? {
          gameId: row.match_id,
          sessionId: row.session_id,
          commandId: row.command_id,
          payloadHash: row.payload_hash,
          acknowledgement: row.acknowledgement,
          createdAt: row.created_at.getTime(),
        }
      : null;
  }

  async storeReceipt(receipt: CommandReceipt): Promise<void> {
    await this.client.query(
      `INSERT INTO command_receipts
       (match_id, session_id, command_id, payload_hash, acknowledgement, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        receipt.gameId,
        receipt.sessionId,
        receipt.commandId,
        receipt.payloadHash,
        receipt.acknowledgement,
        new Date(receipt.createdAt),
      ],
    );
  }

  async appendEvent(event: GameEvent): Promise<void> {
    await this.client.query(
      `INSERT INTO match_events (match_id, revision, type, payload, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [event.gameId, event.revision, event.type, event.payload, new Date(event.createdAt)],
    );
    await this.client.query("INSERT INTO event_outbox (match_id, revision) VALUES ($1, $2)", [
      event.gameId,
      event.revision,
    ]);
  }

  async listEvents(gameId: string, afterRevision: number, limit = 100): Promise<GameEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Event page size must be between 1 and 1000.");
    }
    const result = await this.client.query<EventRow>(
      `SELECT * FROM match_events WHERE match_id = $1 AND revision > $2
       ORDER BY revision LIMIT $3`,
      [gameId, afterRevision, limit],
    );
    return result.rows.map(eventRecord);
  }

  async claimOutbox(limit = 100, leaseMilliseconds = 10_000): Promise<OutboxEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Outbox page size must be between 1 and 1000.");
    }
    if (
      !Number.isInteger(leaseMilliseconds) ||
      leaseMilliseconds < 100 ||
      leaseMilliseconds > 60_000
    ) {
      throw new RangeError("Outbox leases must be between 100 and 60000 milliseconds.");
    }
    const leaseToken = randomUUID();
    const result = await this.client.query<
      EventRow & { id: string; lease_token: string; attempts: number }
    >(
      `WITH pending AS (
         SELECT id FROM event_outbox WHERE delivered_at IS NULL
         AND (lease_until IS NULL OR lease_until <= clock_timestamp())
         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1
       ), claimed AS (
         UPDATE event_outbox AS outbox
         SET lease_until = clock_timestamp() + ($2 * interval '1 millisecond'),
             lease_token = $3, attempts = attempts + 1
         FROM pending WHERE outbox.id = pending.id
         RETURNING outbox.id, outbox.match_id, outbox.revision, outbox.lease_token, outbox.attempts
       ) SELECT claimed.id, claimed.lease_token, claimed.attempts, events.*
         FROM claimed JOIN match_events AS events
         ON events.match_id = claimed.match_id AND events.revision = claimed.revision
         ORDER BY claimed.id`,
      [limit, leaseMilliseconds, leaseToken],
    );
    return result.rows.map((row) => ({
      ...eventRecord(row),
      id: row.id,
      leaseToken: row.lease_token,
      attempts: row.attempts,
    }));
  }

  async completeOutbox(id: string, leaseToken: string): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE event_outbox SET delivered_at = clock_timestamp(), lease_until = NULL, lease_token = NULL
       WHERE id = $1 AND lease_token = $2 AND delivered_at IS NULL`,
      [id, leaseToken],
    );
    return result.rowCount === 1;
  }
}
