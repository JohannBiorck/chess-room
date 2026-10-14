import type {
  BoardPiece,
  CatchessConfig,
  Color,
  GameOutcome,
  RulesetId,
} from "@chess-room/contracts";
import { MAX_GAME_PLIES } from "@chess-room/contracts";
import type { Chess } from "chess.js";
import { CHESS_RULES_ADAPTERS } from "./rules.js";

export function chessBoard(chess: Chess): BoardPiece[] {
  return chess.board().flatMap((row) =>
    row.flatMap((piece) =>
      piece
        ? [
            {
              square: piece.square,
              type: piece.type,
              color: piece.color === "w" ? "white" : "black",
            },
          ]
        : [],
    ),
  );
}

export function adjudicatePosition(input: {
  chess: Chess;
  rulesetId: RulesetId;
  checks: Readonly<Record<Color, number>>;
  catchess: CatchessConfig | undefined;
  repetitionCount: number;
  plies: number;
  kingCapture: GameOutcome | null;
}): GameOutcome | null {
  if (input.kingCapture) return input.kingCapture;
  const turn = input.chess.turn() === "w" ? "white" : "black";
  if (input.chess.isCheckmate())
    return { winner: turn === "white" ? "black" : "white", reason: "checkmate" };
  const adapter = CHESS_RULES_ADAPTERS[input.rulesetId];
  const extra = adapter.extraOutcome(input.checks);
  if (extra) return extra;
  if (input.chess.isStalemate()) return { winner: null, reason: "stalemate" };
  if (adapter.isDeadPosition(chessBoard(input.chess), input.catchess))
    return { winner: null, reason: "dead-position" };
  if (input.repetitionCount >= 5) return { winner: null, reason: "fivefold-repetition" };
  if (Number(input.chess.fen().split(" ")[4]) >= 150)
    return { winner: null, reason: "seventy-five-move" };
  if (input.plies >= MAX_GAME_PLIES) return { winner: null, reason: "move-limit" };
  return null;
}
