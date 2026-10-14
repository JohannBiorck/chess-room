import { createHash } from "node:crypto";
import type { HistoryItem, HistoryList, HistoryQuery } from "@chess-room/contracts";
import {
  engineStateSchema,
  exportPgn,
  inspectEngine,
  inspectEngineReplay,
} from "@chess-room/game-core";
import { z } from "zod";
import { type Database, type Transaction, waitingDeadlineSql } from "../storage/database.js";
import type { GameRecord, JsonObject, SessionRecord } from "../storage/records.js";
import { ApplicationError } from "./errors.js";

const RESERVED_GAME_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024;
const STORAGE_BUDGET = 800 * 1024 * 1024;
interface ArchiveRow {
  match_id: string;
  ruleset_id: HistoryItem["rulesetId"];
  rules_version: number;
  engine_state: JsonObject;
  lifecycle: JsonObject;
  players: Record<string, { id: string; displayName: string }>;
  final_fen: string;
  opponent_kind: "human" | "bot";
  created_at: Date;
  finished_at: Date;
  color: "white" | "black";
  bot: JsonObject | null;
}

export class HistoryService {
  constructor(
    readonly database: Database,
    private readonly storageBudget = STORAGE_BUDGET,
    private readonly testClock?: () => number,
  ) {}

  async reserve(tx: Transaction, id: string, bytes = RESERVED_GAME_BYTES) {
    // The new match already exists in this transaction; its proposed allowance is counted below.
    await this.checkCapacity(tx, bytes, id);
    await tx.client.query(
      "INSERT INTO storage_reservations(match_id,reserved_bytes) VALUES($1,$2) ON CONFLICT(match_id) DO NOTHING",
      [id, bytes],
    );
  }
  async checkCapacity(tx: Transaction, bytes: number, incomingMatchId?: string) {
    await tx.client.query("SELECT pg_advisory_xact_lock(764338342,hashtext(current_schema()))");
    const now = this.testClock?.() ?? (await tx.databaseNow());
    const result = await tx.client.query<{ used: string; reserved: string }>(
      `SELECT (coalesce((SELECT sum(pg_total_relation_size(c.oid)) FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind IN ('r','p')),0)+75497472
           +(SELECT count(*) FROM accounts)*1048576)::text AS used,
       coalesce((SELECT sum(coalesce(r.reserved_bytes,CASE WHEN m.status IN ('waiting','active')
           THEN 67108864 ELSE 2097152 END)) FROM matches m LEFT JOIN storage_reservations r ON r.match_id=m.id
         WHERE ($2::uuid IS NULL OR m.id<>$2) AND (m.status<>'waiting' OR ${waitingDeadlineSql}>$1)),0)::text AS reserved`,
      [now, incomingMatchId ?? null],
    );
    const row = result.rows[0];
    if (!row || Number(row.used) + Number(row.reserved) + bytes > this.storageBudget)
      throw new ApplicationError(
        "STORAGE_CAPACITY",
        "Free storage is near capacity. Finish or export existing games and try again later.",
        429,
      );
  }

  async archive(tx: Transaction, game: GameRecord) {
    if (game.status !== "finished") return;
    const life = game.lifecycle as JsonObject;
    if (!life.outcome) {
      await tx.client.query(
        "UPDATE storage_reservations SET reserved_bytes=1048576 WHERE match_id=$1",
        [game.id],
      );
      return;
    }
    const seats = await tx.client.query<{
      color: string;
      id: string;
      account_id: string | null;
      display_name: string;
      kind: string;
    }>(
      `SELECT s.color,p.id,p.display_name,i.account_id,i.kind FROM match_seats s JOIN player_sessions p ON p.id=s.session_id
       JOIN players i ON i.id=p.id WHERE s.match_id=$1 ORDER BY s.color`,
      [game.id],
    );
    const owners = seats.rows.filter((p) => p.account_id !== null);
    {
      if (Buffer.byteLength(JSON.stringify(game.engineState)) > MAX_ARCHIVE_BYTES)
        throw new ApplicationError(
          "ARCHIVE_LIMIT",
          "This game exceeds its reserved history size.",
          409,
        );
      const position = inspectEngine(engineStateSchema.parse(game.engineState));
      const players = Object.fromEntries(
        seats.rows.map((p) => [p.color, { id: p.id, displayName: p.display_name }]),
      );
      const bot = game.rulesConfig.bot ?? null;
      await tx.client.query(
        `INSERT INTO match_archives(match_id,ruleset_id,rules_version,engine_state,lifecycle,players,final_fen,opponent_kind,bot,created_at,finished_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(match_id) DO NOTHING`,
        [
          game.id,
          game.rulesetId,
          game.rulesVersion,
          game.engineState,
          game.lifecycle,
          players,
          position.fen,
          seats.rows.some((p) => p.kind === "bot") ? "bot" : "human",
          bot,
          new Date(game.createdAt),
          new Date(game.updatedAt),
        ],
      );
      for (const owner of owners)
        await tx.client.query(
          `INSERT INTO account_match_history(account_id,match_id,color,finished_at)
        SELECT $1,$2,$3,finished_at FROM match_archives WHERE match_id=$2 ON CONFLICT DO NOTHING`,
          [owner.account_id, game.id, owner.color],
        );
    }
    const bytes = await tx.client.query<{ size: string }>(
      `SELECT coalesce(sum(pg_column_size(r)),0)::text AS size FROM command_receipts r WHERE match_id=$1`,
      [game.id],
    );
    await tx.client.query("UPDATE storage_reservations SET reserved_bytes=$2 WHERE match_id=$1", [
      game.id,
      2 * Number(bytes.rows[0]?.size ?? 0) + 2 * 1024 * 1024,
    ]);
  }

  private owner(actor: SessionRecord) {
    if (!actor.accountId)
      throw new ApplicationError("ACCOUNT_REQUIRED", "Sign in to view your match history.", 401);
    return actor.accountId;
  }
  private item(row: ArchiveRow): HistoryItem {
    const outcome = row.lifecycle.outcome as { winner: "white" | "black" | null; reason: string };
    const opponent = row.color === "white" ? "black" : "white";
    return {
      id: row.match_id,
      rulesetId: row.ruleset_id,
      color: row.color,
      opponentName: row.players[opponent]?.displayName ?? "Deleted player",
      opponentKind: row.opponent_kind,
      result: outcome.winner === null ? "draw" : outcome.winner === row.color ? "win" : "loss",
      reason: outcome.reason,
      timeControl: row.lifecycle.timeControl as HistoryItem["timeControl"],
      createdAt: row.created_at.getTime(),
      finishedAt: row.finished_at.getTime(),
    };
  }
  async list(actor: SessionRecord, query: HistoryQuery): Promise<HistoryList> {
    const owner = this.owner(actor);
    let cursor: { at: number; id: string } | null = null;
    if (query.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString()) as {
          at: number;
          id: string;
        };
        if (
          !cursor ||
          !Number.isSafeInteger(cursor.at) ||
          cursor.at < 0 ||
          cursor.at > 8_640_000_000_000_000 ||
          !z.uuid().safeParse(cursor.id).success
        )
          throw new Error();
      } catch {
        throw new ApplicationError("INVALID_INPUT", "History cursor is invalid.", 400);
      }
    }
    const result = await this.database.pool.query<ArchiveRow>(
      `SELECT a.*,h.color FROM account_match_history h JOIN match_archives a ON a.match_id=h.match_id
      WHERE h.account_id=$1 AND NOT h.hidden AND a.finished_at>clock_timestamp()-interval '365 days'
      AND ($2::timestamptz IS NULL OR (h.finished_at,h.match_id)<($2::timestamptz,$3::uuid))
      AND ($4::text IS NULL OR a.ruleset_id=$4) AND ($5::text IS NULL OR a.opponent_kind=$5)
      AND ($6::text IS NULL OR CASE WHEN a.lifecycle->'outcome'->>'winner' IS NULL THEN 'draw'
       WHEN a.lifecycle->'outcome'->>'winner'=h.color THEN 'win' ELSE 'loss' END=$6)
      ORDER BY h.finished_at DESC,h.match_id DESC LIMIT $7`,
      [
        owner,
        cursor ? new Date(cursor.at) : null,
        cursor?.id ?? null,
        query.ruleset ?? null,
        query.opponentKind ?? null,
        query.result ?? null,
        query.limit + 1,
      ],
    );
    const rows = result.rows.slice(0, query.limit);
    const last = rows.at(-1);
    return {
      games: rows.map((row) => this.item(row)),
      nextCursor:
        result.rows.length > query.limit && last
          ? Buffer.from(
              JSON.stringify({ at: last.finished_at.getTime(), id: last.match_id }),
            ).toString("base64url")
          : null,
    };
  }
  private async read(actor: SessionRecord, id: string) {
    const result = await this.database.pool.query<ArchiveRow>(
      `SELECT a.*,h.color FROM match_archives a JOIN account_match_history h ON h.match_id=a.match_id
      WHERE h.account_id=$1 AND a.match_id=$2 AND NOT h.hidden AND a.finished_at>clock_timestamp()-interval '365 days'`,
      [this.owner(actor), id],
    );
    if (!result.rows[0]) throw new ApplicationError("NOT_FOUND", "Saved game is unavailable.", 404);
    if (result.rows[0].rules_version !== 1)
      throw new ApplicationError(
        "ARCHIVE_UNSUPPORTED",
        "This saved game's rules version is not supported.",
        409,
      );
    return result.rows[0];
  }
  async detail(actor: SessionRecord, id: string) {
    const row = await this.read(actor, id);
    const { state, replay } = this.verifiedReplay(row);
    return {
      game: this.item(row),
      schemaVersion: 1,
      rulesVersion: row.rules_version,
      initialFen: replay.initialFen,
      positions: replay.positions,
      finalFen: row.final_fen,
      outcome: row.lifecycle.outcome,
      players: Object.fromEntries(
        Object.entries(row.players).map(([color, p]) => [color, { displayName: p.displayName }]),
      ),
      ...(state.catchess ? { catchess: state.catchess } : {}),
      bot: row.bot,
    };
  }
  private verifiedReplay(row: ArchiveRow) {
    try {
      const state = engineStateSchema.parse(row.engine_state);
      const replay = inspectEngineReplay(state);
      if (
        state.rulesetId !== row.ruleset_id ||
        state.rulesVersion !== row.rules_version ||
        (replay.positions.at(-1)?.fen ?? replay.initialFen) !== row.final_fen
      )
        throw new Error("Archive metadata disagrees with its saved turns.");
      return { state, replay };
    } catch {
      throw new ApplicationError(
        "ARCHIVE_INVALID",
        "This saved game could not be verified. Its records have been preserved.",
        409,
      );
    }
  }
  async pgn(actor: SessionRecord, id: string) {
    const row = await this.read(actor, id);
    const { state } = this.verifiedReplay(row);
    const escapePgnName = (name: string) =>
      name
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/[\r\n]/g, "");
    const body = exportPgn(state, row.lifecycle.outcome as never).replace(
      /^\[(White|Black) ".*"\]\s*$/gm,
      "",
    );
    return `[White "${escapePgnName(row.players.white?.displayName ?? "Deleted player")}"]\n[Black "${escapePgnName(row.players.black?.displayName ?? "Deleted player")}"]\n${body}`;
  }
  async hide(actor: SessionRecord, id: string) {
    await this.read(actor, id);
    await this.database.pool.query(
      "UPDATE account_match_history SET hidden=true WHERE account_id=$1 AND match_id=$2",
      [this.owner(actor), id],
    );
  }
  async cleanup(tx: Transaction) {
    await tx.client.query(`DELETE FROM account_match_history WHERE (account_id,match_id) IN (
      SELECT account_id,match_id FROM (SELECT account_id,match_id,finished_at, row_number() OVER(PARTITION BY account_id ORDER BY finished_at DESC,match_id DESC) AS n FROM account_match_history) r
      WHERE n>500 OR finished_at<clock_timestamp()-interval '365 days' LIMIT 100)`);
    await tx.client.query(`DELETE FROM match_archives WHERE match_id IN (SELECT a.match_id FROM match_archives a
      WHERE NOT EXISTS(SELECT 1 FROM account_match_history h WHERE h.match_id=a.match_id AND NOT h.hidden)
      AND NOT EXISTS(SELECT 1 FROM matches m WHERE m.id=a.match_id) LIMIT 100)`);
  }
}

export function recoveryCodeHash(code: string) {
  return createHash("sha256")
    .update(`cat-chess-recovery:${code.replace(/\s/g, "")}`)
    .digest("hex");
}
