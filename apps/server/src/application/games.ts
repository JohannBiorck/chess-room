import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  BOT_ALGORITHM,
  type BotCommand,
  type BotMetadata,
  type BotPositionView,
  botMetadataSchema,
  type CatchessConfig,
  type Color,
  type CreateBotGame,
  type CreateGame,
  displayNameSchema,
  type GameCommand,
  type GameOutcome,
  type GameView,
  gameViewSchema,
  MAX_OPEN_ROOMS,
  OPEN_ROOM_LIFETIME_MS,
  type OpenRoom,
  type PublicGame,
  type SessionView,
  TIME_CONTROLS,
  type TimeControl,
} from "@chess-room/contracts";
import {
  applyEngineMove,
  canWinOnTime,
  claimEngineDraw,
  createBotSearchPosition,
  createEngineState,
  EngineError,
  engineStateSchema,
  exportPgn,
  inspectEngine,
  oppositeColor,
} from "@chess-room/game-core";
import { type Database, type Transaction, waitingDeadlineSql } from "../storage/database.js";
import type { GameRecord, JsonObject, SessionRecord } from "../storage/records.js";
import { ApplicationError } from "./errors.js";
import { HistoryService } from "./history.js";

export const SESSION_LIFETIME = 30 * 24 * 60 * 60 * 1000;
const INVITATION_LIFETIME = 24 * 60 * 60 * 1000;
// Finish active play with two command slots left for a friends rematch.
const MAX_ACCEPTED_COMMANDS = 1500;
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
interface Lifecycle {
  timeControl: TimeControl;
  remaining: Record<Color, number> | null;
  turnStartedAt: number | null;
  deadlineAt: number | null;
  outcome: GameOutcome | null;
  drawOffer: Color | null;
  rematchRequested: Color[];
  rematchGameId: string | null;
  closure?: NonNullable<PublicGame["closure"]>;
  botRequestId?: string | null;
}
const lifecycle = (game: GameRecord) => game.lifecycle as unknown as Lifecycle;
const bot = (game: GameRecord): BotMetadata | null =>
  game.rulesConfig.bot
    ? {
        ...botMetadataSchema.parse(game.rulesConfig.bot),
        requestId: lifecycle(game).botRequestId ?? null,
      }
    : null;

export class GameService {
  readonly history: HistoryService;
  constructor(
    readonly database: Database,
    private readonly testNow?: () => number,
    private readonly serverDraw: () => string = () => randomBytes(32).toString("hex"),
  ) {
    this.history = new HistoryService(database, undefined, testNow);
  }

  private now(tx: Transaction) {
    return this.testNow ? Promise.resolve(this.testNow()) : tx.databaseNow();
  }

  async session(token: string | undefined): Promise<SessionRecord | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.database.transaction((tx) => tx.getSession(tokenHash(token)));
  }

  sessionView(session: SessionRecord): SessionView {
    return { displayName: session.displayName, expiresAt: session.expiresAt };
  }

  async createSession(displayName: string) {
    displayName = displayNameSchema.parse(displayName);
    const token = randomBytes(32).toString("base64url");
    const session = await this.database.transaction(async (tx) => {
      const now = await this.now(tx);
      const record = {
        id: randomUUID(),
        tokenHash: tokenHash(token),
        displayName,
        createdAt: now,
        expiresAt: now + SESSION_LIFETIME,
      };
      await tx.createSession(record);
      return record;
    });
    return { token, session };
  }

  async rename(actor: SessionRecord, displayName: string): Promise<SessionRecord> {
    displayName = displayNameSchema.parse(displayName);
    return this.database.transaction(async (tx) => {
      if (actor.accountId) {
        const active = await tx.getSession(actor.tokenHash);
        if (!active || active.accountId !== actor.accountId)
          throw new ApplicationError("SESSION_REQUIRED", "Your account session expired.", 401);
        await tx.client.query("UPDATE accounts SET display_name=$2 WHERE id=$1", [
          actor.accountId,
          displayName,
        ]);
        await tx.client.query(
          "UPDATE player_sessions SET display_name=$2 WHERE id IN(SELECT id FROM players WHERE account_id=$1)",
          [actor.accountId, displayName],
        );
        return { ...active, displayName };
      }
      const session = await tx.renameSession(actor.id, actor.tokenHash, displayName);
      if (!session)
        throw new ApplicationError("SESSION_REQUIRED", "Your guest session has expired.", 401);
      return session;
    });
  }

  /** Profiles are independent of match revisions, clocks and immutable command receipts. */
  async profiles(gameIds: string[], participantId?: string) {
    if (gameIds.length > 100) throw new RangeError("Profile batches cannot exceed 100 games.");
    if (gameIds.length === 0) return [];
    const result = await this.database.pool.query<{
      id: string;
      revision: number;
      color: Color;
      display_name: string;
    }>(
      `SELECT m.id,m.revision,s.color,p.display_name FROM matches m
       JOIN match_seats s ON s.match_id=m.id
       JOIN player_sessions p ON p.id=s.session_id
       WHERE m.id=ANY($1::uuid[]) AND ($2::uuid IS NULL OR EXISTS (
         SELECT 1 FROM match_seats member JOIN players member_identity ON member_identity.id=member.session_id
         WHERE member.match_id=m.id AND (member.session_id=$2 OR member_identity.account_id=(SELECT account_id FROM players WHERE id=$2))))`,
      [gameIds, participantId ?? null],
    );
    const games = new Map<
      string,
      { gameId: string; revision: number; players: PublicGame["players"] }
    >();
    for (const row of result.rows) {
      let game = games.get(row.id);
      if (!game) {
        game = { gameId: row.id, revision: row.revision, players: { white: null, black: null } };
        games.set(row.id, game);
      }
      game.players[row.color] = { displayName: row.display_name };
    }
    return [...games.values()];
  }

  async openRooms(): Promise<OpenRoom[]> {
    return this.database.transaction(async (tx) => {
      const now = await this.now(tx);
      const result = await tx.client.query<{
        id: string;
        ruleset_id: OpenRoom["rulesetId"];
        lifecycle: JsonObject;
        engine_state: JsonObject;
        color: Color;
        display_name: string;
        created_at: Date;
        expires_at: Date;
      }>(
        `SELECT m.id,m.ruleset_id,m.lifecycle,m.engine_state,s.color,p.display_name,
                m.created_at,CASE WHEN identity.account_id IS NOT NULL THEN clock_timestamp()+interval '100 years' ELSE p.expires_at END AS expires_at FROM matches m
         JOIN match_seats s ON s.match_id=m.id
         JOIN player_sessions p ON p.id=s.session_id
         JOIN players identity ON identity.id=p.id
         WHERE m.status='waiting' AND m.rules_config->>'visibility'='open'
           AND m.created_at>to_timestamp(($1::bigint-$3::bigint)/1000.0)
           AND (identity.account_id IS NOT NULL OR p.expires_at>to_timestamp($1::bigint/1000.0))
           AND NOT EXISTS (SELECT 1 FROM match_seats other
             WHERE other.match_id=m.id AND other.color<>s.color)
         ORDER BY m.created_at DESC,m.id LIMIT $2`,
        [now, MAX_OPEN_ROOMS, OPEN_ROOM_LIFETIME_MS],
      );
      return result.rows.map((row) => ({
        id: row.id,
        host: { displayName: row.display_name, color: row.color },
        rulesetId: row.ruleset_id,
        timeControl: (row.lifecycle as unknown as Lifecycle).timeControl,
        ...(row.ruleset_id === "catchess"
          ? { catchess: engineStateSchema.parse(row.engine_state).catchess }
          : {}),
        createdAt: row.created_at.getTime(),
        expiresAt: Math.min(
          row.created_at.getTime() + OPEN_ROOM_LIFETIME_MS,
          row.expires_at.getTime(),
        ),
      }));
    });
  }

  private async requireSeat(tx: Transaction, gameId: string, actor: SessionRecord): Promise<Color> {
    if (!(await tx.getSession(actor.tokenHash)))
      throw new ApplicationError("SESSION_REQUIRED", "Your guest session has expired.", 401);
    const seat = await this.ownedSeat(tx, gameId, actor);
    if (!seat)
      throw new ApplicationError("FORBIDDEN", "Only the two players can access this game.", 403);
    return seat.color;
  }

  private async ownedSeat(tx: Transaction, id: string, actor: SessionRecord) {
    const result = await tx.client.query<{ color: Color; session_id: string }>(
      `SELECT s.color,s.session_id FROM match_seats s JOIN players p ON p.id=s.session_id
      WHERE s.match_id=$1 AND (s.session_id=$2 OR ($3::uuid IS NOT NULL AND p.account_id=$3)) ORDER BY s.color`,
      [id, actor.id, actor.accountId ?? null],
    );
    return result.rows[0]
      ? { color: result.rows[0].color, sessionId: result.rows[0].session_id }
      : null;
  }

  private async requireCapacity(tx: Transaction, sessionId: string) {
    const participant = await tx.client.query<{
      expires_at: Date;
      account_id: string | null;
      kind: string;
    }>(
      "SELECT p.expires_at,i.account_id,i.kind FROM player_sessions p JOIN players i ON i.id=p.id WHERE p.id=$1 FOR UPDATE OF p",
      [sessionId],
    );
    if (
      !participant.rows[0] ||
      (participant.rows[0].kind !== "bot" &&
        !participant.rows[0].account_id &&
        participant.rows[0].expires_at.getTime() <= (await tx.databaseNow()))
    )
      throw new ApplicationError(
        "SESSION_REQUIRED",
        "A player session has expired. Create a new room.",
        401,
      );
    const result = await tx.client.query<{ count: string }>(
      `SELECT count(*) FROM matches m JOIN match_seats s ON s.match_id=m.id
       JOIN players owner ON owner.id=s.session_id
       WHERE (s.session_id=$1 OR ($3::uuid IS NOT NULL AND owner.account_id=$3)) AND (m.status='active' OR
         (m.status='waiting' AND ${waitingDeadlineSql}>$2))`,
      [sessionId, await this.now(tx), participant.rows[0]?.account_id ?? null],
    );
    if (Number(result.rows[0]?.count) >= 10)
      throw new ApplicationError(
        "ROOM_LIMIT",
        "Finish an existing game before joining another.",
        429,
      );
  }

  private async project(tx: Transaction, game: GameRecord, now: number): Promise<PublicGame> {
    const seats = await tx.client.query<{ color: Color; display_name: string }>(
      "SELECT s.color, p.display_name FROM match_seats s JOIN player_sessions p ON p.id=s.session_id WHERE s.match_id=$1",
      [game.id],
    );
    const players: PublicGame["players"] = { white: null, black: null };
    for (const seat of seats.rows) players[seat.color] = { displayName: seat.display_name };
    const state = engineStateSchema.parse(game.engineState);
    const enginePosition = inspectEngine(state);
    const { catEffects, ...legacyPosition } = enginePosition;
    const position =
      state.rulesetId === "catchess" || state.rulesetId === "chaos-cat"
        ? { ...legacyPosition, catEffects }
        : legacyPosition;
    const life = lifecycle(game);
    return {
      id: game.id,
      revision: game.revision,
      phase: game.status,
      rulesetId: state.rulesetId,
      rulesVersion: 1,
      timeControl: life.timeControl,
      ...(game.rulesConfig.visibility === "open" ? { visibility: "open" as const } : {}),
      ...(state.rulesetId === "catchess" ? { catchess: state.catchess } : {}),
      ...(bot(game) ? { bot: bot(game) as BotMetadata } : {}),
      players,
      position,
      clocks: life.remaining
        ? {
            whiteMs: life.remaining.white,
            blackMs: life.remaining.black,
            runningColor: game.status === "active" ? position.turn : null,
            turnStartedAt: life.turnStartedAt,
            serverNow: now,
          }
        : null,
      outcome: life.outcome,
      ...(life.closure ? { closure: life.closure } : {}),
      drawOffer: life.drawOffer,
      rematchRequested: life.rematchRequested,
      rematchGameId: life.rematchGameId,
      createdAt: game.createdAt,
      updatedAt: game.updatedAt,
    };
  }

  private fresh(config: CreateGame, now: number, catchess?: CatchessConfig): GameRecord {
    const initial = TIME_CONTROLS[config.timeControl].initialMs;
    const life: Lifecycle = {
      timeControl: config.timeControl,
      remaining: initial === null ? null : { white: initial, black: initial },
      turnStartedAt: null,
      deadlineAt: null,
      outcome: null,
      drawOffer: null,
      rematchRequested: [],
      rematchGameId: null,
    };
    return {
      id: randomUUID(),
      revision: 0,
      status: "waiting",
      rulesetId: config.rulesetId,
      rulesVersion: 1,
      rulesConfig: json(config),
      engineState: json(createEngineState(config.rulesetId, undefined, catchess)),
      lifecycle: json(life),
      createdAt: now,
      updatedAt: now,
    };
  }

  private async persist(
    tx: Transaction,
    game: GameRecord,
    type: string,
    now: number,
    action?: GameCommand["action"],
    actor?: Color,
  ) {
    const previous = game.revision;
    const position = inspectEngine(engineStateSchema.parse(game.engineState));
    const opponent = bot(game);
    if (opponent) {
      lifecycle(game).botRequestId =
        game.status === "active" && position.turn === opponent.color
          ? (opponent.requestId ?? randomUUID())
          : null;
    }
    game.revision += 1;
    game.updatedAt = now;
    await tx.saveGame(game, previous);
    await this.history.archive(tx, game);
    await tx.appendEvent({
      gameId: game.id,
      revision: game.revision,
      type,
      payload: json({
        phase: game.status,
        action: action ?? null,
        actor: actor ?? null,
        fen: position.fen,
        catEffect: action?.type === "move" ? (position.catEffects.at(-1) ?? null) : null,
        outcome: lifecycle(game).outcome,
        clocks: lifecycle(game).remaining,
        lifecycle: lifecycle(game),
      }),
      createdAt: now,
    });
  }

  private start(game: GameRecord, now: number) {
    game.status = "active";
    const life = lifecycle(game);
    life.turnStartedAt = life.remaining ? now : null;
    life.deadlineAt = life.remaining ? now + life.remaining.white : null;
  }

  private finish(game: GameRecord, outcome: GameOutcome, now: number) {
    const life = lifecycle(game);
    if (life.remaining && life.turnStartedAt !== null) {
      const turn = inspectEngine(engineStateSchema.parse(game.engineState)).turn;
      life.remaining[turn] = Math.max(
        0,
        life.remaining[turn] - Math.max(0, now - life.turnStartedAt),
      );
    }
    game.status = "finished";
    life.outcome = outcome;
    life.drawOffer = null;
    life.turnStartedAt = null;
    life.deadlineAt = null;
  }

  private async waitingDeadline(tx: Transaction, game: GameRecord): Promise<number> {
    const owner = await tx.client.query<{ expires_at: Date | null }>(
      `SELECT min(CASE WHEN i.account_id IS NOT NULL THEN clock_timestamp()+interval '100 years' ELSE p.expires_at END) AS expires_at FROM match_seats s
       JOIN player_sessions p ON p.id=s.session_id JOIN players i ON i.id=p.id WHERE s.match_id=$1`,
      [game.id],
    );
    return Math.min(
      game.createdAt +
        (game.rulesConfig.visibility === "open" ? OPEN_ROOM_LIFETIME_MS : INVITATION_LIFETIME),
      owner.rows[0]?.expires_at?.getTime() ?? Infinity,
    );
  }

  private async close(
    tx: Transaction,
    game: GameRecord,
    reason: NonNullable<PublicGame["closure"]>["reason"],
    now: number,
  ) {
    const life = lifecycle(game);
    game.status = "finished";
    life.closure = { reason, closedAt: now };
    life.outcome = null;
    life.drawOffer = null;
    life.turnStartedAt = null;
    life.deadlineAt = null;
    life.rematchRequested = [];
    life.rematchGameId = null;
    // Keep the original invitation record for diagnostics without fabricating a join.
    await tx.client.query(
      `UPDATE invitations SET expires_at=LEAST(expires_at,to_timestamp($2/1000.0))
       WHERE match_id=$1 AND consumed_at IS NULL`,
      [game.id, now],
    );
  }

  private async expire(tx: Transaction, game: GameRecord, now: number): Promise<boolean> {
    if (game.status === "waiting" && now >= (await this.waitingDeadline(tx, game))) {
      await this.close(tx, game, "expired", now);
      await this.persist(tx, game, "room-expired", now);
      return true;
    }
    const life = lifecycle(game);
    if (game.status !== "active" || life.deadlineAt === null || now < life.deadlineAt) return false;
    const state = engineStateSchema.parse(game.engineState);
    const loser = inspectEngine(state).turn;
    if (life.remaining) life.remaining[loser] = 0;
    const winner = oppositeColor(loser);
    this.finish(
      game,
      canWinOnTime(state, winner)
        ? { winner, reason: "timeout" }
        : { winner: null, reason: "timeout-insufficient-material" },
      now,
    );
    await this.persist(tx, game, "timeout", now);
    return true;
  }

  async create(actor: SessionRecord, config: CreateGame) {
    return this.database.transaction(async (tx) => {
      if (!(await tx.getSession(actor.tokenHash)))
        throw new ApplicationError("SESSION_REQUIRED", "Your guest session has expired.", 401);
      await this.requireCapacity(tx, actor.id);
      const now = await this.now(tx);
      const color = config.color === "random" ? (randomInt(2) ? "white" : "black") : config.color;
      const settings = config.catchess ?? { host: 25, guest: 25 };
      const game = this.fresh(
        config,
        now,
        config.rulesetId === "catchess"
          ? color === "white"
            ? { white: settings.host, black: settings.guest }
            : { white: settings.guest, black: settings.host }
          : undefined,
      );
      await tx.createGame(game);
      await this.history.reserve(tx, game.id);
      await tx.addSeat({ gameId: game.id, color, sessionId: actor.id });
      await tx.appendEvent({
        gameId: game.id,
        revision: 0,
        type: "created",
        payload: { phase: "waiting" },
        createdAt: now,
      });
      const invitation = await this.issue(tx, game, oppositeColor(color), now);
      return { game: await this.project(tx, game, now), seat: color, invitation };
    });
  }

  async createBot(actor: SessionRecord, input: CreateBotGame): Promise<GameView> {
    return this.database.transaction(async (tx) => {
      if (!(await tx.getSession(actor.tokenHash)))
        throw new ApplicationError("SESSION_REQUIRED", "Sign in or create a guest session.", 401);
      await this.requireCapacity(tx, actor.id);
      await this.requireBotCapacity(tx, actor.id);
      const now = await this.now(tx);
      const color: Color =
        input.color === "random" ? (randomInt(2) ? "white" : "black") : input.color;
      const chances = input.catchess ?? { host: 25, guest: 25 };
      const game = this.fresh(
        {
          rulesetId: input.rulesetId,
          color,
          timeControl: "untimed",
          ...(input.rulesetId === "catchess" ? { catchess: chances } : {}),
        },
        now,
        input.rulesetId === "catchess"
          ? color === "white"
            ? { white: chances.host, black: chances.guest }
            : { white: chances.guest, black: chances.host }
          : undefined,
      );
      const opponent: BotMetadata = {
        color: oppositeColor(color),
        profile: input.profile,
        algorithm: BOT_ALGORITHM,
        requestId: color === "black" ? randomUUID() : null,
      };
      game.rulesConfig.bot = json({ ...opponent, requestId: null });
      lifecycle(game).botRequestId = opponent.requestId;
      this.start(game, now);
      // Bot identities have no usable authentication token and can only be
      // controlled through the real owner's dedicated, fenced turn route.
      const participant: SessionRecord = {
        id: randomUUID(),
        tokenHash: tokenHash(randomBytes(32).toString("hex")),
        displayName: "Cat Bot",
        createdAt: now,
        expiresAt: now + SESSION_LIFETIME,
      };
      await tx.createSession(participant);
      await tx.client.query("UPDATE players SET kind='bot' WHERE id=$1", [participant.id]);
      await tx.createGame(game);
      await this.history.reserve(tx, game.id);
      await tx.addSeat({ gameId: game.id, color, sessionId: actor.id });
      await tx.addSeat({ gameId: game.id, color: opponent.color, sessionId: participant.id });
      await tx.appendEvent({
        gameId: game.id,
        revision: 0,
        type: "bot-created",
        payload: { phase: "active" },
        createdAt: now,
      });
      return { game: await this.project(tx, game, now), seat: color };
    });
  }

  private async requireBotCapacity(tx: Transaction, playerId: string) {
    const existing = await tx.client.query(
      `SELECT m.id FROM matches m JOIN match_seats s ON s.match_id=m.id
      JOIN players p ON p.id=s.session_id WHERE m.status='active' AND m.rules_config ? 'bot'
      AND (s.session_id=$1 OR p.account_id=(SELECT account_id FROM players WHERE id=$1)) LIMIT 1`,
      [playerId],
    );
    if (existing.rows.length)
      throw new ApplicationError(
        "BOT_GAME_LIMIT",
        "Resume or finish your existing cat game first.",
        429,
      );
  }

  async activeBot(actor: SessionRecord): Promise<string | null> {
    return this.database.transaction(async (tx) => {
      if (!(await tx.getSession(actor.tokenHash)))
        throw new ApplicationError("SESSION_REQUIRED", "Your session has expired.", 401);
      const result = await tx.client.query<{ id: string }>(
        `SELECT m.id FROM matches m
        JOIN match_seats s ON s.match_id=m.id JOIN players p ON p.id=s.session_id
        WHERE m.status='active' AND m.rules_config ? 'bot' AND p.kind='human'
        AND (s.session_id=$1 OR ($2::uuid IS NOT NULL AND p.account_id=$2))
        ORDER BY m.updated_at DESC,m.id LIMIT 1`,
        [actor.id, actor.accountId ?? null],
      );
      return result.rows[0]?.id ?? null;
    });
  }

  private async requireBot(tx: Transaction, game: GameRecord, actor: SessionRecord) {
    const seat = await this.requireSeat(tx, game.id, actor);
    const opponent = bot(game);
    if (
      !opponent ||
      seat === opponent.color ||
      game.status !== "active" ||
      inspectEngine(engineStateSchema.parse(game.engineState)).turn !== opponent.color ||
      !opponent.requestId
    )
      throw new ApplicationError(
        "BOT_NOT_READY",
        "There is no pending cat turn in this game.",
        409,
      );
    return { seat, opponent };
  }

  async botPosition(actor: SessionRecord, id: string): Promise<BotPositionView> {
    return this.database.transaction(async (tx) => {
      const game = await tx.lockGame(id);
      if (!game) throw new ApplicationError("NOT_FOUND", "Game not found.", 404);
      const { opponent } = await this.requireBot(tx, game, actor);
      return {
        gameId: id,
        revision: game.revision,
        requestId: opponent.requestId as string,
        profile: opponent.profile,
        algorithm: opponent.algorithm,
        position: createBotSearchPosition(engineStateSchema.parse(game.engineState)),
      };
    });
  }

  async botCommand(actor: SessionRecord, id: string, command: BotCommand): Promise<GameView> {
    const payloadHash = tokenHash(JSON.stringify(command));
    return this.database.transaction(async (tx) => {
      const game = await tx.lockGame(id);
      if (!game) throw new ApplicationError("NOT_FOUND", "Game not found.", 404);
      const seat = await this.requireSeat(tx, id, actor);
      const opponent = bot(game);
      if (!opponent || seat === opponent.color)
        throw new ApplicationError(
          "BOT_NOT_READY",
          "This game has no controlled cat opponent.",
          409,
        );
      const participant = (await tx.listSeats(id)).find((entry) => entry.color === opponent.color);
      if (!participant)
        throw new ApplicationError("BOT_NOT_READY", "The cat seat is unavailable.", 409);
      const previous = await tx.getReceipt(id, participant.sessionId, command.commandId);
      if (previous) {
        if (previous.payloadHash !== payloadHash)
          throw new ApplicationError(
            "COMMAND_REUSED",
            "A command identifier cannot be reused for another move.",
            409,
          );
        return gameViewSchema.parse(previous.acknowledgement);
      }
      await this.requireBot(tx, game, actor);
      if (command.expectedRevision !== game.revision)
        throw new ApplicationError(
          "STALE_REVISION",
          "The game changed. Refresh and try again.",
          409,
        );
      if (command.commandId !== opponent.requestId)
        throw new ApplicationError(
          "BOT_TICKET_CHANGED",
          "This cat turn has a different command identifier.",
          409,
        );
      const now = await this.now(tx);
      const action: GameCommand["action"] = { type: "move", ...command.move };
      try {
        const count = await tx.client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM command_receipts WHERE match_id=$1",
          [id],
        );
        const accepted = Number(count.rows[0]?.count ?? 0);
        this.requireCommandCapacity(accepted);
        await this.act(tx, game, opponent.color, { ...command, action }, now);
        if (accepted >= MAX_ACCEPTED_COMMANDS - 3 && game.status === "active")
          this.finish(game, { winner: null, reason: "move-limit" }, now);
      } catch (error) {
        if (error instanceof EngineError)
          throw new ApplicationError(
            error.code.toUpperCase().replaceAll("-", "_"),
            error.message,
            409,
          );
        throw error;
      }
      await this.persist(tx, game, "bot-move", now, action, opponent.color);
      const view = { game: await this.project(tx, game, now), seat };
      await tx.storeReceipt({
        gameId: id,
        sessionId: participant.sessionId,
        commandId: command.commandId,
        payloadHash,
        acknowledgement: json(view),
        createdAt: now,
      });
      return view;
    });
  }

  private async issue(tx: Transaction, game: GameRecord, color: Color, now: number) {
    const token = randomBytes(32).toString("base64url");
    const owner = await tx.client.query<{ expires_at: Date }>(
      "SELECT CASE WHEN i.account_id IS NOT NULL THEN clock_timestamp()+interval '100 years' ELSE p.expires_at END AS expires_at FROM match_seats s JOIN player_sessions p ON p.id=s.session_id JOIN players i ON i.id=p.id WHERE s.match_id=$1 AND s.color=$2",
      [game.id, oppositeColor(color)],
    );
    const expiresAt = Math.min(
      now + INVITATION_LIFETIME,
      game.createdAt +
        (game.rulesConfig.visibility === "open" ? OPEN_ROOM_LIFETIME_MS : INVITATION_LIFETIME),
      owner.rows[0]?.expires_at.getTime() ?? now,
    );
    if (expiresAt <= now)
      throw new ApplicationError(
        "SESSION_REQUIRED",
        "The host session expired. Please create a new room.",
        401,
      );
    await tx.client.query("DELETE FROM invitations WHERE match_id=$1 AND consumed_at IS NULL", [
      game.id,
    ]);
    await tx.createInvitation({
      id: randomUUID(),
      gameId: game.id,
      color,
      tokenHash: tokenHash(token),
      expiresAt,
      consumedBy: null,
      consumedAt: null,
    });
    return { token, expiresAt };
  }

  async invitation(actor: SessionRecord, id: string) {
    const result = await this.database.transaction(async (tx) => {
      const game = await tx.lockGame(id);
      if (!game) throw new ApplicationError("NOT_FOUND", "Game not found.", 404);
      const seat = await this.requireSeat(tx, id, actor);
      const now = await this.now(tx);
      await this.expire(tx, game, now);
      if (lifecycle(game).closure)
        return {
          error: new ApplicationError(
            "ROOM_CLOSED",
            "This room is closed. Please create another.",
            410,
          ),
        };
      if (game.status !== "waiting")
        return {
          error: new ApplicationError("GAME_STARTED", "This game already has two players.", 409),
        };
      return { invitation: await this.issue(tx, game, oppositeColor(seat), now) };
    });
    if (result.error) throw result.error;
    return result.invitation;
  }

  async join(actor: SessionRecord, token: string): Promise<GameView> {
    const result = await this.database.transaction(async (tx) => {
      const hash = tokenHash(token);
      const candidate = await tx.getInvitation(hash);
      if (!candidate)
        throw new ApplicationError(
          "INVALID_INVITATION",
          "Invitation is invalid or has expired.",
          404,
        );
      const game = await tx.lockGame(candidate.gameId);
      if (!game) throw new ApplicationError("NOT_FOUND", "Game not found.", 404);
      const invitation = await tx.getInvitation(hash, true);
      let now = await this.now(tx);
      if (!(await tx.getSession(actor.tokenHash)))
        throw new ApplicationError("SESSION_REQUIRED", "Your guest session has expired.", 401);
      if (!invitation)
        throw new ApplicationError(
          "INVALID_INVITATION",
          "Invitation is invalid or has expired.",
          404,
        );
      const unavailable = () =>
        new ApplicationError(
          "INVITATION_UNAVAILABLE",
          "This invitation has expired or was already used.",
          409,
        );
      // Returning the error out of the transaction commits any recovered closure.
      const expired = await this.expire(tx, game, now);
      const returning = await this.ownedSeat(tx, game.id, actor);
      if (invitation.consumedBy && returning?.sessionId === invitation.consumedBy)
        return { view: { game: await this.project(tx, game, now), seat: invitation.color } };
      if (expired) return { error: unavailable() };
      if (
        game.status !== "waiting" ||
        invitation.consumedAt !== null ||
        invitation.expiresAt <= now
      )
        throw unavailable();
      if (returning)
        throw new ApplicationError(
          "OWN_INVITATION",
          "Open this invitation in your friend's browser.",
          409,
        );
      await this.requireCapacity(tx, actor.id);
      now = await this.now(tx);
      if (await this.expire(tx, game, now)) return { error: unavailable() };
      if (invitation.expiresAt <= now || !(await tx.consumeInvitation(hash, actor.id)))
        throw unavailable();
      await tx.addSeat({ gameId: game.id, color: invitation.color, sessionId: actor.id });
      this.start(game, now);
      await this.persist(tx, game, "joined", now);
      return { view: { game: await this.project(tx, game, now), seat: invitation.color } };
    });
    if (result.error) throw result.error;
    return result.view;
  }

  async joinOpen(actor: SessionRecord, id: string): Promise<GameView> {
    const result = await this.database.transaction(async (tx) => {
      const game = await tx.lockGame(id);
      const unavailable = () =>
        new ApplicationError(
          "ROOM_UNAVAILABLE",
          "This open room is no longer available. Choose another room.",
          409,
        );
      if (game?.rulesConfig.visibility !== "open") throw unavailable();
      if (!(await tx.getSession(actor.tokenHash)))
        throw new ApplicationError("SESSION_REQUIRED", "Your guest session has expired.", 401);
      const seats = await tx.listSeats(id);
      const existing = await this.ownedSeat(tx, id, actor);
      let now = await this.now(tx);
      const expired = await this.expire(tx, game, now);
      // A lost join acknowledgement remains recoverable once this room has started.
      // A cancelled host room never acknowledges a join that did not happen.
      if (existing && game.status !== "waiting" && !lifecycle(game).closure)
        return { view: { game: await this.project(tx, game, now), seat: existing.color } };
      if (expired) return { error: unavailable() };
      if (existing && game.status === "waiting")
        throw new ApplicationError(
          "OWN_ROOM",
          "You already host this room. Wait for another player.",
          409,
        );
      if (game.status !== "waiting" || seats.length !== 1) throw unavailable();
      const host = seats[0];
      if (!host) throw unavailable();
      await this.requireCapacity(tx, actor.id);
      // Capacity can wait on the guest's session lock. Reevaluate the room's
      // lifetime and host expiry and start the clock only after that wait.
      now = await this.now(tx);
      if (await this.expire(tx, game, now)) return { error: unavailable() };
      const seat = oppositeColor(host.color);
      await tx.addSeat({ gameId: id, color: seat, sessionId: actor.id });
      // The same match lock serializes invitation and public joins. Consuming its
      // remaining invitation atomically prevents an invite from claiming a third seat.
      await tx.client.query(
        "UPDATE invitations SET consumed_by=$2,consumed_at=to_timestamp($3/1000.0) WHERE match_id=$1 AND consumed_at IS NULL",
        [id, actor.id, now],
      );
      this.start(game, now);
      await this.persist(tx, game, "joined", now);
      return { view: { game: await this.project(tx, game, now), seat } };
    });
    if (result.error) throw result.error;
    return result.view;
  }

  async view(actor: SessionRecord, id: string): Promise<GameView> {
    return this.database.transaction(async (tx) => {
      const game = await tx.lockGame(id);
      if (!game) throw new ApplicationError("NOT_FOUND", "Game not found.", 404);
      const seat = await this.requireSeat(tx, id, actor);
      const now = await this.now(tx);
      await this.expire(tx, game, now);
      return { game: await this.project(tx, game, now), seat };
    });
  }

  async publicView(id: string): Promise<PublicGame | null> {
    return this.database.transaction(async (tx) => {
      const game = await tx.lockGame(id);
      if (!game) return null;
      const now = await this.now(tx);
      await this.expire(tx, game, now);
      return this.project(tx, game, now);
    });
  }

  async command(actor: SessionRecord, id: string, command: GameCommand): Promise<GameView> {
    const payloadHash = tokenHash(JSON.stringify(command));
    const result = await this.database.transaction(async (tx) => {
      const game = await tx.lockGame(id);
      if (!game) throw new ApplicationError("NOT_FOUND", "Game not found.", 404);
      const seat = await this.requireSeat(tx, id, actor);
      const identity = await this.ownedSeat(tx, id, actor);
      if (!identity)
        throw new ApplicationError("FORBIDDEN", "Only the players can access this game.", 403);
      const previous = await tx.getReceipt(id, identity.sessionId, command.commandId);
      if (previous) {
        if (previous.payloadHash !== payloadHash)
          throw new ApplicationError(
            "COMMAND_REUSED",
            "A command identifier cannot be reused for a different action.",
            409,
          );
        return { view: gameViewSchema.parse(previous.acknowledgement) };
      }
      const now = await this.now(tx);
      if (await this.expire(tx, game, now))
        return {
          error: lifecycle(game).closure
            ? new ApplicationError("ROOM_CLOSED", "This room expired. Please create another.", 409)
            : new ApplicationError("GAME_FINISHED", "The clock expired. Refresh the game.", 409),
        };
      if (game.revision !== command.expectedRevision)
        throw new ApplicationError(
          "STALE_REVISION",
          "The game changed. Refresh and try again.",
          409,
        );
      try {
        const count = await tx.client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM command_receipts WHERE match_id=$1",
          [id],
        );
        const accepted = Number(count.rows[0]?.count ?? 0);
        this.requireCommandCapacity(accepted);
        await this.act(tx, game, seat, command, now);
        if (accepted >= MAX_ACCEPTED_COMMANDS - 3 && game.status === "active")
          this.finish(game, { winner: null, reason: "move-limit" }, now);
      } catch (error) {
        if (error instanceof EngineError)
          throw new ApplicationError(
            error.code.toUpperCase().replaceAll("-", "_"),
            error.message,
            409,
          );
        throw error;
      }
      await this.persist(tx, game, command.action.type, now, command.action, seat);
      const view = { game: await this.project(tx, game, now), seat };
      await tx.storeReceipt({
        gameId: id,
        sessionId: identity.sessionId,
        commandId: command.commandId,
        payloadHash,
        acknowledgement: json(view),
        createdAt: now,
      });
      return { view };
    });
    if (result.error) throw result.error;
    return result.view;
  }

  private requireCommandCapacity(accepted: number) {
    if (accepted >= MAX_ACCEPTED_COMMANDS)
      throw new ApplicationError(
        "COMMAND_LIMIT",
        "This game has reached its command limit. Its result and accepted retries remain available.",
        409,
      );
  }

  private async act(
    tx: Transaction,
    game: GameRecord,
    seat: Color,
    command: GameCommand,
    now: number,
  ) {
    const life = lifecycle(game);
    const action = command.action;
    const state = engineStateSchema.parse(game.engineState);
    const position = inspectEngine(state);
    if (action.type === "close-room") {
      if (game.status !== "waiting" || (await tx.listSeats(game.id)).length !== 1)
        throw new ApplicationError(
          "CLOSE_UNAVAILABLE",
          "Only a room waiting for an opponent can be closed.",
          409,
        );
      await this.close(tx, game, "host-closed", now);
      return;
    }
    if (action.type === "request-rematch" || action.type === "accept-rematch") {
      if (game.status !== "finished" || life.closure || !life.outcome || life.rematchGameId)
        throw new ApplicationError("REMATCH_UNAVAILABLE", "A rematch is unavailable.", 409);
      if (action.type === "request-rematch") {
        if (life.rematchRequested.includes(seat))
          throw new ApplicationError("ALREADY_REQUESTED", "You already requested a rematch.", 409);
        life.rematchRequested.push(seat);
        if (!bot(game)) return;
      }
      if (action.type === "accept-rematch" && !life.rematchRequested.includes(oppositeColor(seat)))
        throw new ApplicationError("NO_REMATCH", "Your opponent has not requested a rematch.", 409);
      const next = this.fresh(
        {
          rulesetId: state.rulesetId,
          color: "white",
          timeControl: life.timeControl,
          ...(state.catchess
            ? { catchess: { host: state.catchess.black, guest: state.catchess.white } }
            : {}),
        },
        now,
        state.catchess ? { white: state.catchess.black, black: state.catchess.white } : undefined,
      );
      const oldSeats = await tx.listSeats(game.id);
      const oldBot = bot(game);
      if (oldBot) {
        const owner = oldSeats.find((entry) => entry.color !== oldBot.color);
        if (!owner)
          throw new ApplicationError("REMATCH_UNAVAILABLE", "The human seat is unavailable.", 409);
        await this.requireBotCapacity(tx, owner.sessionId);
        next.rulesConfig.bot = json({
          ...oldBot,
          color: oppositeColor(oldBot.color),
          requestId: null,
        });
        lifecycle(next).botRequestId = oldBot.color === "black" ? randomUUID() : null;
      }
      for (const old of [...oldSeats].sort((a, b) => a.sessionId.localeCompare(b.sessionId)))
        await this.requireCapacity(tx, old.sessionId);
      await tx.createGame(next);
      await this.history.reserve(tx, next.id);
      for (const old of oldSeats)
        await tx.addSeat({
          gameId: next.id,
          color: oppositeColor(old.color),
          sessionId: old.sessionId,
        });
      this.start(next, now);
      // Creation has no predecessor revision; the active successor begins at revision zero.
      await tx.client.query("UPDATE matches SET status=$2,lifecycle=$3 WHERE id=$1", [
        next.id,
        next.status,
        next.lifecycle,
      ]);
      await tx.appendEvent({
        gameId: next.id,
        revision: 0,
        type: "rematch-created",
        payload: { phase: "active" },
        createdAt: now,
      });
      life.rematchGameId = next.id;
      return;
    }
    if (game.status !== "active")
      throw new ApplicationError("GAME_NOT_ACTIVE", "This game is not active.", 409);
    switch (action.type) {
      case "move": {
        if (position.turn !== seat)
          throw new ApplicationError("NOT_YOUR_TURN", "Wait for your opponent's move.", 409);
        if (
          !position.legalMoves.some(
            (move) =>
              move.from === action.from &&
              move.to === action.to &&
              move.promotion === action.promotion,
          )
        )
          throw new EngineError("illegal-move", "That move is not legal.");
        const next = applyEngineMove(
          state,
          {
            from: action.from,
            to: action.to,
            ...(action.promotion ? { promotion: action.promotion } : {}),
          },
          state.rulesetId === "catchess" || state.rulesetId === "chaos-cat"
            ? this.serverDraw()
            : undefined,
        );
        if (life.remaining && life.turnStartedAt !== null) {
          life.remaining[seat] =
            Math.max(0, life.remaining[seat] - (now - life.turnStartedAt)) +
            TIME_CONTROLS[life.timeControl].incrementMs;
          life.turnStartedAt = now;
          life.deadlineAt = now + life.remaining[oppositeColor(seat)];
        }
        game.engineState = json(next);
        life.drawOffer = null;
        const outcome = inspectEngine(next).outcome;
        if (outcome) this.finish(game, outcome, now);
        return;
      }
      case "resign":
        this.finish(game, { winner: oppositeColor(seat), reason: "resignation" }, now);
        return;
      case "offer-draw":
        if (bot(game))
          throw new ApplicationError(
            "BOT_DRAW_UNAVAILABLE",
            "The cat plays on. You can claim an eligible draw.",
            409,
          );
        if (life.drawOffer)
          throw new ApplicationError("DRAW_PENDING", "A draw offer is already pending.", 409);
        life.drawOffer = seat;
        return;
      case "accept-draw":
        if (life.drawOffer !== oppositeColor(seat))
          throw new ApplicationError("NO_DRAW_OFFER", "Your opponent has not offered a draw.", 409);
        this.finish(game, { winner: null, reason: "agreement" }, now);
        return;
      case "decline-draw":
        if (life.drawOffer !== oppositeColor(seat))
          throw new ApplicationError("NO_DRAW_OFFER", "Your opponent has not offered a draw.", 409);
        life.drawOffer = null;
        return;
      case "claim-draw":
        if (position.turn !== seat)
          throw new ApplicationError(
            "NOT_YOUR_TURN",
            "Only the player to move can claim a draw.",
            409,
          );
        this.finish(game, claimEngineDraw(state), now);
        return;
    }
  }

  async pgn(actor: SessionRecord, id: string): Promise<string> {
    const result = await this.database.transaction(async (tx) => {
      const game = await tx.lockGame(id);
      if (!game) throw new ApplicationError("NOT_FOUND", "Game not found.", 404);
      await this.requireSeat(tx, id, actor);
      await this.expire(tx, game, await this.now(tx));
      if (lifecycle(game).closure)
        return {
          error: new ApplicationError(
            "ROOM_CLOSED",
            "This room closed before a game was played.",
            409,
          ),
        };
      return {
        pgn: exportPgn(
          engineStateSchema.parse(game.engineState),
          lifecycle(game).outcome ?? undefined,
        ),
      };
    });
    if (result.error) throw result.error;
    return result.pgn;
  }

  async expireDue(): Promise<void> {
    const ids = await this.database.transaction((tx) => tx.findGamesDue(100, this.testNow?.()));
    for (const id of ids)
      await this.database.transaction(async (tx) => {
        const game = await tx.lockGame(id);
        if (game) await this.expire(tx, game, await this.now(tx));
      });
  }

  async cleanup(): Promise<void> {
    await this.database.transaction(async (tx) => {
      const abandoned = await tx.client.query<{ id: string }>(`SELECT m.id FROM matches m
        WHERE m.status='active' AND NOT EXISTS (SELECT 1 FROM match_seats s
          JOIN player_sessions p ON p.id=s.session_id JOIN players identity ON identity.id=p.id WHERE s.match_id=m.id AND identity.kind='human'
          AND ((identity.account_id IS NULL AND p.expires_at>clock_timestamp()) OR (identity.account_id IS NOT NULL AND m.updated_at>clock_timestamp()-interval '30 days')))
        LIMIT 100 FOR UPDATE OF m SKIP LOCKED`);
      for (const row of abandoned.rows) {
        const game = await tx.getGame(row.id);
        if (game) {
          const now = await this.now(tx);
          this.finish(game, { winner: null, reason: "session-expired" }, now);
          await this.persist(tx, game, "session-expired", now);
        }
      }
      await tx.client.query(`DELETE FROM matches WHERE id IN (
        SELECT id FROM matches WHERE status='finished' AND updated_at<clock_timestamp()-interval '30 days'
        AND (lifecycle->'outcome' IS NULL OR lifecycle->'outcome'='null'::jsonb OR NOT EXISTS(SELECT 1 FROM match_seats s JOIN players p ON p.id=s.session_id WHERE s.match_id=matches.id AND p.account_id IS NOT NULL)
          OR EXISTS(SELECT 1 FROM match_archives a WHERE a.match_id=matches.id))
        LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await tx.client.query(`DELETE FROM player_sessions WHERE id IN (
        SELECT id FROM player_sessions p WHERE expires_at<clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM players i WHERE i.id=p.id AND i.account_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM match_seats s WHERE s.session_id=p.id)
        AND NOT EXISTS (SELECT 1 FROM invitations i WHERE i.consumed_by=p.id)
        AND NOT EXISTS (SELECT 1 FROM command_receipts r WHERE r.session_id=p.id)
        LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await tx.client.query(
        "DELETE FROM app_rate_limits WHERE key IN (SELECT key FROM app_rate_limits WHERE window_start<floor(extract(epoch FROM clock_timestamp()-interval '24 hours')*1000)::bigint LIMIT 1000)",
      );
      await this.history.cleanup(tx);
    });
  }

  async deleteAccountGames(tx: Transaction, accountId: string) {
    const matches = await tx.client.query<{ id: string; color: Color }>(
      `SELECT m.id,s.color FROM matches m JOIN match_seats s ON s.match_id=m.id
      JOIN players p ON p.id=s.session_id WHERE p.account_id=$1 AND m.status IN ('waiting','active') ORDER BY m.id FOR UPDATE OF m`,
      [accountId],
    );
    for (const row of matches.rows) {
      const game = await tx.getGame(row.id);
      if (!game) continue;
      const now = await this.now(tx);
      if (game.status === "waiting") await this.close(tx, game, "host-closed", now);
      else this.finish(game, { winner: oppositeColor(row.color), reason: "resignation" }, now);
      await this.persist(tx, game, "account-deleted", now);
    }
  }
}
