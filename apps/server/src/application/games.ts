import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  type CatchessConfig,
  type Color,
  type CreateGame,
  type GameCommand,
  type GameOutcome,
  type GameView,
  gameViewSchema,
  type PublicGame,
  type SessionView,
  TIME_CONTROLS,
  type TimeControl,
} from "@chess-room/contracts";
import {
  applyEngineMove,
  canWinOnTime,
  claimEngineDraw,
  createEngineState,
  EngineError,
  engineStateSchema,
  exportPgn,
  inspectEngine,
  oppositeColor,
} from "@chess-room/game-core";
import type { Database, Transaction } from "../storage/database.js";
import type { GameRecord, JsonObject, SessionRecord } from "../storage/records.js";
import { ApplicationError } from "./errors.js";

export const SESSION_LIFETIME = 30 * 24 * 60 * 60 * 1000;
const INVITATION_LIFETIME = 24 * 60 * 60 * 1000;
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
}
const lifecycle = (game: GameRecord) => game.lifecycle as unknown as Lifecycle;

export class GameService {
  constructor(
    readonly database: Database,
    private readonly testNow?: () => number,
    private readonly serverDraw: () => string = () => randomBytes(32).toString("hex"),
  ) {}

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

  private async requireSeat(tx: Transaction, gameId: string, actor: SessionRecord): Promise<Color> {
    if (!(await tx.getSession(actor.tokenHash)))
      throw new ApplicationError("SESSION_REQUIRED", "Your guest session has expired.", 401);
    const seat = (await tx.listSeats(gameId)).find((item) => item.sessionId === actor.id);
    if (!seat)
      throw new ApplicationError("FORBIDDEN", "Only the two players can access this game.", 403);
    return seat.color;
  }

  private async requireCapacity(tx: Transaction, sessionId: string) {
    const participant = await tx.client.query<{ expires_at: Date }>(
      "SELECT expires_at FROM player_sessions WHERE id=$1 FOR UPDATE",
      [sessionId],
    );
    if (
      !participant.rows[0] ||
      participant.rows[0].expires_at.getTime() <= (await tx.databaseNow())
    )
      throw new ApplicationError(
        "SESSION_REQUIRED",
        "A player session has expired. Create a new room.",
        401,
      );
    const result = await tx.client.query<{ count: string }>(
      "SELECT count(*) FROM matches m JOIN match_seats s ON s.match_id=m.id WHERE s.session_id=$1 AND (m.status='active' OR (m.status='waiting' AND m.created_at>clock_timestamp()-interval '24 hours'))",
      [sessionId],
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
      state.rulesetId === "catchess" ? { ...legacyPosition, catEffects } : legacyPosition;
    const life = lifecycle(game);
    return {
      id: game.id,
      revision: game.revision,
      phase: game.status,
      rulesetId: state.rulesetId,
      rulesVersion: 1,
      timeControl: life.timeControl,
      ...(state.rulesetId === "catchess" ? { catchess: state.catchess } : {}),
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
    game.revision += 1;
    game.updatedAt = now;
    await tx.saveGame(game, previous);
    const position = inspectEngine(engineStateSchema.parse(game.engineState));
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

  private async expire(tx: Transaction, game: GameRecord, now: number): Promise<boolean> {
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
      await tx.client.query("SELECT id FROM player_sessions WHERE id=$1 FOR UPDATE", [actor.id]);
      if (!(await tx.getSession(actor.tokenHash)))
        throw new ApplicationError("SESSION_REQUIRED", "Your guest session has expired.", 401);
      const count = await tx.client.query<{ count: string }>(
        "SELECT count(*) FROM matches m JOIN match_seats s ON s.match_id=m.id WHERE s.session_id=$1 AND (m.status='active' OR (m.status='waiting' AND m.created_at>clock_timestamp()-interval '24 hours'))",
        [actor.id],
      );
      if (Number(count.rows[0]?.count) >= 10)
        throw new ApplicationError(
          "ROOM_LIMIT",
          "Finish an existing game before creating another.",
          429,
        );
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

  private async issue(tx: Transaction, game: GameRecord, color: Color, now: number) {
    const token = randomBytes(32).toString("base64url");
    const owner = await tx.client.query<{ expires_at: Date }>(
      "SELECT p.expires_at FROM match_seats s JOIN player_sessions p ON p.id=s.session_id WHERE s.match_id=$1 AND s.color=$2",
      [game.id, oppositeColor(color)],
    );
    const expiresAt = Math.min(
      now + INVITATION_LIFETIME,
      game.createdAt + INVITATION_LIFETIME,
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
    return this.database.transaction(async (tx) => {
      const game = await tx.lockGame(id);
      if (!game) throw new ApplicationError("NOT_FOUND", "Game not found.", 404);
      const seat = await this.requireSeat(tx, id, actor);
      if (game.status !== "waiting")
        throw new ApplicationError("GAME_STARTED", "This game already has two players.", 409);
      const now = await this.now(tx);
      if (game.createdAt + INVITATION_LIFETIME <= now)
        throw new ApplicationError(
          "ROOM_EXPIRED",
          "This room expired. Please create another.",
          410,
        );
      return this.issue(tx, game, oppositeColor(seat), now);
    });
  }

  async join(actor: SessionRecord, token: string): Promise<GameView> {
    return this.database.transaction(async (tx) => {
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
      const now = await this.now(tx);
      if (!(await tx.getSession(actor.tokenHash)))
        throw new ApplicationError("SESSION_REQUIRED", "Your guest session has expired.", 401);
      if (!invitation)
        throw new ApplicationError(
          "INVALID_INVITATION",
          "Invitation is invalid or has expired.",
          404,
        );
      if (invitation.consumedBy === actor.id)
        return { game: await this.project(tx, game, now), seat: invitation.color };
      if (
        game.status !== "waiting" ||
        invitation.consumedAt !== null ||
        invitation.expiresAt <= now ||
        game.createdAt + INVITATION_LIFETIME <= now
      )
        throw new ApplicationError(
          "INVITATION_UNAVAILABLE",
          "This invitation has expired or was already used.",
          409,
        );
      if ((await tx.listSeats(game.id)).some((seat) => seat.sessionId === actor.id))
        throw new ApplicationError(
          "OWN_INVITATION",
          "Open this invitation in your friend's browser.",
          409,
        );
      await this.requireCapacity(tx, actor.id);
      if (!(await tx.consumeInvitation(hash, actor.id)))
        throw new ApplicationError(
          "INVITATION_UNAVAILABLE",
          "This invitation has expired or was already used.",
          409,
        );
      await tx.addSeat({ gameId: game.id, color: invitation.color, sessionId: actor.id });
      this.start(game, now);
      await this.persist(tx, game, "joined", now);
      return { game: await this.project(tx, game, now), seat: invitation.color };
    });
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
      const game = await tx.getGame(id);
      return game ? this.project(tx, game, await this.now(tx)) : null;
    });
  }

  async command(actor: SessionRecord, id: string, command: GameCommand): Promise<GameView> {
    const payloadHash = tokenHash(JSON.stringify(command));
    const result = await this.database.transaction(async (tx) => {
      const game = await tx.lockGame(id);
      if (!game) throw new ApplicationError("NOT_FOUND", "Game not found.", 404);
      const seat = await this.requireSeat(tx, id, actor);
      const previous = await tx.getReceipt(id, actor.id, command.commandId);
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
          error: new ApplicationError("GAME_FINISHED", "The clock expired. Refresh the game.", 409),
        };
      if (game.revision !== command.expectedRevision)
        throw new ApplicationError(
          "STALE_REVISION",
          "The game changed. Refresh and try again.",
          409,
        );
      try {
        await this.act(tx, game, seat, command, now);
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
        sessionId: actor.id,
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
    if (action.type === "request-rematch" || action.type === "accept-rematch") {
      if (game.status !== "finished" || life.rematchGameId)
        throw new ApplicationError("REMATCH_UNAVAILABLE", "A rematch is unavailable.", 409);
      if (action.type === "request-rematch") {
        if (life.rematchRequested.includes(seat))
          throw new ApplicationError("ALREADY_REQUESTED", "You already requested a rematch.", 409);
        life.rematchRequested.push(seat);
        return;
      }
      if (!life.rematchRequested.includes(oppositeColor(seat)))
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
      for (const old of [...oldSeats].sort((a, b) => a.sessionId.localeCompare(b.sessionId)))
        await this.requireCapacity(tx, old.sessionId);
      await tx.createGame(next);
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
        const next = applyEngineMove(
          state,
          {
            from: action.from,
            to: action.to,
            ...(action.promotion ? { promotion: action.promotion } : {}),
          },
          state.rulesetId === "catchess" ? this.serverDraw() : undefined,
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
    return this.database.transaction(async (tx) => {
      const game = await tx.getGame(id);
      if (!game) throw new ApplicationError("NOT_FOUND", "Game not found.", 404);
      await this.requireSeat(tx, id, actor);
      return exportPgn(
        engineStateSchema.parse(game.engineState),
        lifecycle(game).outcome ?? undefined,
      );
    });
  }

  async expireDue(): Promise<void> {
    const ids = this.testNow
      ? (
          await this.database.pool.query<{ id: string }>(
            "SELECT id FROM matches WHERE status='active' AND (lifecycle->>'deadlineAt')::bigint <= $1 LIMIT 100",
            [this.testNow()],
          )
        ).rows.map((row) => row.id)
      : await this.database.transaction((tx) => tx.findGamesDue(100));
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
          JOIN player_sessions p ON p.id=s.session_id WHERE s.match_id=m.id AND p.expires_at>clock_timestamp())
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
        SELECT id FROM matches WHERE (status='waiting' AND created_at<clock_timestamp()-interval '24 hours')
          OR (status='finished' AND updated_at<clock_timestamp()-interval '30 days')
        LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await tx.client.query(`DELETE FROM player_sessions WHERE id IN (
        SELECT id FROM player_sessions p WHERE expires_at<clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM match_seats s WHERE s.session_id=p.id)
        AND NOT EXISTS (SELECT 1 FROM invitations i WHERE i.consumed_by=p.id)
        AND NOT EXISTS (SELECT 1 FROM command_receipts r WHERE r.session_id=p.id)
        LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await tx.client.query(
        "DELETE FROM app_rate_limits WHERE key IN (SELECT key FROM app_rate_limits WHERE window_start<floor(extract(epoch FROM clock_timestamp()-interval '24 hours')*1000)::bigint LIMIT 1000)",
      );
    });
  }
}
