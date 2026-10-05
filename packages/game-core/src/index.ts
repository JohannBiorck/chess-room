import {
  type BoardPiece,
  type Color,
  type DrawClaim,
  type EnginePosition,
  type GameOutcome,
  MAX_GAME_PLIES,
  type MoveInput,
  type MoveRecord,
  moveInputSchema,
  type RulesetId,
  rulesetIdSchema,
} from "@chess-room/contracts";
import { Chess, type Square as ChessSquare, DEFAULT_POSITION, type Move } from "chess.js";
import { z } from "zod";
import { CHESS_RULES_ADAPTERS, type ChessRulesAdapter } from "./rules.js";

export const RULES_VERSION = 1;
export const ENGINE_STATE_VERSION = 1;
export const STANDARD_INITIAL_FEN = DEFAULT_POSITION;

export const engineStateSchema = z
  .object({
    stateVersion: z.literal(ENGINE_STATE_VERSION),
    rulesetId: rulesetIdSchema,
    rulesVersion: z.literal(RULES_VERSION),
    initialFen: z.string().max(128),
    moves: z.array(moveInputSchema).max(MAX_GAME_PLIES),
  })
  .strict();

export type EngineState = z.infer<typeof engineStateSchema>;
export type EngineErrorCode =
  | "invalid-state"
  | "unsupported-version"
  | "illegal-move"
  | "game-finished"
  | "draw-unavailable";

export class EngineError extends Error {
  constructor(
    public readonly code: EngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

type Replay = {
  state: EngineState;
  chess: Chess;
  checks: Record<Color, number>;
  repetitions: Map<string, number>;
  records: MoveRecord[];
  adapter: ChessRulesAdapter;
};

function color(value: "w" | "b"): Color {
  return value === "w" ? "white" : "black";
}

export function oppositeColor(value: Color): Color {
  return value === "white" ? "black" : "white";
}

function toMoveInput(move: Move): MoveInput {
  return {
    from: move.from,
    to: move.to,
    ...(move.promotion ? { promotion: move.promotion as "q" | "r" | "b" | "n" } : {}),
  };
}

function positionKey(replay: Replay): string {
  // fen() omits en-passant rights when no legal capture exists, as repetition requires.
  const key = replay.chess.fen().split(" ").slice(0, 4).join(" ");
  return key + replay.adapter.repetitionSuffix(replay.checks);
}

function recordPosition(replay: Replay): void {
  const key = positionKey(replay);
  replay.repetitions.set(key, (replay.repetitions.get(key) ?? 0) + 1);
}

function board(chess: Chess): BoardPiece[] {
  return chess
    .board()
    .flat()
    .filter((piece) => piece !== null)
    .map((piece) => ({ square: piece.square, type: piece.type, color: color(piece.color) }));
}

function outcome(replay: Replay): GameOutcome | null {
  const turn = color(replay.chess.turn());
  if (replay.chess.isCheckmate()) return { winner: oppositeColor(turn), reason: "checkmate" };
  const extraOutcome = replay.adapter.extraOutcome(replay.checks);
  if (extraOutcome) return extraOutcome;
  if (replay.chess.isStalemate()) return { winner: null, reason: "stalemate" };
  if (replay.adapter.isDeadPosition(board(replay.chess)))
    return { winner: null, reason: "dead-position" };
  if ((replay.repetitions.get(positionKey(replay)) ?? 0) >= 5) {
    return { winner: null, reason: "fivefold-repetition" };
  }
  if (Number(replay.chess.fen().split(" ")[4]) >= 150) {
    return { winner: null, reason: "seventy-five-move" };
  }
  if (replay.records.length >= MAX_GAME_PLIES) return { winner: null, reason: "move-limit" };
  return null;
}

function drawClaims(replay: Replay): DrawClaim[] {
  if (outcome(replay)) return [];
  const claims: DrawClaim[] = [];
  if ((replay.repetitions.get(positionKey(replay)) ?? 0) >= 3) claims.push("threefold-repetition");
  if (Number(replay.chess.fen().split(" ")[4]) >= 100) claims.push("fifty-move");
  return claims;
}

function play(replay: Replay, input: MoveInput): void {
  const valid = replay.chess
    .moves({ verbose: true })
    .find(
      (move) =>
        move.from === input.from && move.to === input.to && move.promotion === input.promotion,
    );
  if (!valid) throw new EngineError("illegal-move", "That move is not legal in this position.");
  const accepted = replay.chess.move({
    from: input.from as ChessSquare,
    to: input.to as ChessSquare,
    ...(input.promotion ? { promotion: input.promotion } : {}),
  });
  const mover = color(accepted.color);
  if (replay.chess.inCheck()) replay.checks[mover] += 1;
  replay.records.push({
    ply: replay.records.length + 1,
    color: mover,
    ...toMoveInput(accepted),
    san: accepted.san,
  });
  recordPosition(replay);
}

function restore(value: EngineState): Replay {
  if (typeof value !== "object" || value === null) {
    throw new EngineError("invalid-state", "The saved position is invalid.");
  }
  if (value.rulesVersion !== RULES_VERSION || value.stateVersion !== ENGINE_STATE_VERSION) {
    throw new EngineError("unsupported-version", "The saved rules version is not supported.");
  }
  const parsed = engineStateSchema.safeParse(value);
  if (!parsed.success) throw new EngineError("invalid-state", "The saved position is invalid.");
  let chess: Chess;
  try {
    chess = new Chess(parsed.data.initialFen);
  } catch {
    throw new EngineError("invalid-state", "The initial position is invalid.");
  }
  const replay: Replay = {
    state: parsed.data,
    chess,
    checks: { white: 0, black: 0 },
    repetitions: new Map(),
    records: [],
    adapter: CHESS_RULES_ADAPTERS[parsed.data.rulesetId],
  };
  recordPosition(replay);
  for (const move of parsed.data.moves) {
    if (outcome(replay)) {
      throw new EngineError("invalid-state", "Saved moves continue after the game ended.");
    }
    try {
      play(replay, move);
    } catch {
      throw new EngineError("invalid-state", "The saved move history contains an illegal move.");
    }
  }
  return replay;
}

export function createEngineState(
  rulesetId: RulesetId = "standard",
  initialFen: string = STANDARD_INITIAL_FEN,
): EngineState {
  const state: EngineState = {
    stateVersion: ENGINE_STATE_VERSION,
    rulesetId,
    rulesVersion: RULES_VERSION,
    initialFen,
    moves: [],
  };
  const replay = restore(state);
  return { ...state, initialFen: replay.chess.fen() };
}

export function inspectEngine(state: EngineState): EnginePosition {
  const replay = restore(state);
  const result = outcome(replay);
  return {
    fen: replay.chess.fen(),
    turn: color(replay.chess.turn()),
    inCheck: replay.chess.inCheck(),
    board: board(replay.chess),
    legalMoves: result ? [] : replay.chess.moves({ verbose: true }).map(toMoveInput),
    moves: replay.records,
    checks: replay.checks,
    claimableDraws: drawClaims(replay),
    outcome: result,
  };
}

export function applyEngineMove(state: EngineState, input: MoveInput): EngineState {
  const replay = restore(state);
  if (outcome(replay)) throw new EngineError("game-finished", "This game has already finished.");
  const parsed = moveInputSchema.safeParse(input);
  if (!parsed.success) throw new EngineError("illegal-move", "The move format is invalid.");
  play(replay, parsed.data);
  return { ...replay.state, moves: [...replay.state.moves, parsed.data] };
}

export function claimEngineDraw(state: EngineState): GameOutcome {
  const replay = restore(state);
  const claim = drawClaims(replay)[0];
  if (!claim) throw new EngineError("draw-unavailable", "No draw can be claimed in this position.");
  return { winner: null, reason: claim };
}

export function canWinOnTime(state: EngineState, side: Color): boolean {
  const replay = restore(state);
  return replay.adapter.canWinOnTime(board(replay.chess), side);
}

export function exportPgn(state: EngineState, result?: GameOutcome): string {
  const replay = restore(state);
  const finalOutcome = result ?? outcome(replay);
  const score = finalOutcome
    ? finalOutcome.winner === "white"
      ? "1-0"
      : finalOutcome.winner === "black"
        ? "0-1"
        : "1/2-1/2"
    : "*";
  replay.chess.setHeader("Event", "Chess Room game");
  replay.chess.setHeader("Result", score);
  if (replay.adapter.pgnVariant) replay.chess.setHeader("Variant", replay.adapter.pgnVariant);
  return replay.chess.pgn();
}
