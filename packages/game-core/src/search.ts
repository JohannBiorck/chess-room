import type {
  BotSearchPosition,
  CatchessConfig,
  CatEffect,
  CatPiece,
  Color,
  GameOutcome,
  MoveInput,
  RulesetId,
} from "@chess-room/contracts";
import type { Chess, Move, Square } from "chess.js";
import { adjudicatePosition } from "./adjudication.js";
import { catTargets, derivedCatPosition, mutateCatPosition } from "./cat-mutations.js";
import { CHESS_RULES_ADAPTERS } from "./rules.js";

type PathPosition = { key: string; previous: PathPosition | null };
export interface SearchPosition {
  chess: Chess;
  rulesetId: RulesetId;
  catchess: CatchessConfig | undefined;
  checks: Record<Color, number>;
  plies: number;
  repetitions: ReadonlyMap<string, number>;
  path: PathPosition | null;
  kingCapture: GameOutcome | null;
}
export interface PreparedSearchMove {
  previous: SearchPosition;
  chess: Chess;
  move: Move;
  mover: Color;
  capturedKing: boolean;
}
export interface CatChanceChoice {
  probability: number;
  action: "add" | "remove" | "none";
  piece?: CatPiece;
  square?: Square;
  kingExposure?: true;
}

export function searchPositionKey(position: SearchPosition): string {
  return (
    position.chess.fen().split(" ").slice(0, 4).join(" ") +
    CHESS_RULES_ADAPTERS[position.rulesetId].repetitionSuffix(position.checks)
  );
}

export function searchRepetitionCount(position: SearchPosition, key = searchPositionKey(position)) {
  let count = position.repetitions.get(key) ?? 0;
  for (let item = position.path; item; item = item.previous) if (item.key === key) count += 1;
  return count;
}

export function createSearchPosition(snapshot: BotSearchPosition): SearchPosition {
  const chess = derivedCatPosition(snapshot.fen);
  const missingKing =
    snapshot.rulesetId === "chaos-cat"
      ? (["white", "black"] as const).find(
          (side) =>
            chess.findPiece({ type: "k", color: side === "white" ? "w" : "b" }).length === 0,
        )
      : undefined;
  return {
    chess,
    rulesetId: snapshot.rulesetId,
    catchess: snapshot.catchess,
    checks: { ...snapshot.checks },
    plies: snapshot.plies,
    repetitions: new Map(snapshot.repetitions),
    path: null,
    kingCapture: missingKing
      ? { winner: missingKing === "white" ? "black" : "white", reason: "king-captured" }
      : null,
  };
}

export function searchOutcome(position: SearchPosition): GameOutcome | null {
  return adjudicatePosition({
    chess: position.chess,
    rulesetId: position.rulesetId,
    catchess: position.catchess,
    checks: position.checks,
    plies: position.plies,
    repetitionCount: searchRepetitionCount(position),
    kingCapture: position.kingCapture,
  });
}

export function searchLegalMoves(position: SearchPosition): Move[] {
  return searchOutcome(position) ? [] : position.chess.moves({ verbose: true });
}

const exchangeValues = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 100_000 } as const;

/**
 * A bounded capture-only estimate for ordering and horizon safety, not a rules
 * transition. Each recapture uses a legal least-value attacker; pinned pieces
 * and unsafe king captures cannot defend a piece. Future random cat visits are
 * deliberately excluded: search weighs those visits at its actual chance nodes.
 */
export function searchExchangeGain(
  position: Pick<SearchPosition, "chess" | "rulesetId">,
  target: Square,
  remaining = 8,
): number {
  const { chess, rulesetId } = position;
  const victim = chess.get(target);
  if (!victim || victim.color === chess.turn() || remaining <= 0) return 0;
  if (victim.type === "k" && rulesetId !== "chaos-cat") return 0;
  const color = chess.turn();
  const enemy = color === "w" ? "b" : "w";
  const attackers = chess.attackers(target, color).sort((left, right) => {
    const a = chess.get(left);
    const b = chess.get(right);
    return (a ? exchangeValues[a.type] : Infinity) - (b ? exchangeValues[b.type] : Infinity);
  });
  for (const from of attackers) {
    const attacker = chess.get(from);
    if (!attacker) continue;
    const candidate = derivedCatPosition(chess.fen({ forceEnpassantSquare: true }));
    candidate.remove(from);
    candidate.remove(target);
    const promoted = attacker.type === "p" && (target[1] === "1" || target[1] === "8");
    candidate.put({ color, type: promoted ? "q" : attacker.type }, target);
    const king = candidate.findPiece({ color, type: "k" })[0];
    if (!king || candidate.isAttacked(king, enemy)) continue;
    if (victim.type === "k") return exchangeValues.k;
    const fields = candidate.fen({ forceEnpassantSquare: true }).split(" ");
    fields[1] = enemy;
    fields[3] = "-";
    const next = derivedCatPosition(fields.join(" "));
    const gain = exchangeValues[victim.type] + (promoted ? exchangeValues.q - exchangeValues.p : 0);
    return Math.max(
      0,
      gain - searchExchangeGain({ chess: next, rulesetId }, target, remaining - 1),
    );
  }
  return 0;
}

export function prepareSearchMove(position: SearchPosition, input: MoveInput): PreparedSearchMove {
  const chess = derivedCatPosition(position.chess.fen({ forceEnpassantSquare: true }));
  const move = chess.move({
    from: input.from,
    to: input.to,
    ...(input.promotion ? { promotion: input.promotion } : {}),
  });
  return {
    previous: position,
    chess,
    move,
    mover: move.color === "w" ? "white" : "black",
    capturedKing: position.rulesetId === "chaos-cat" && move.captured === "k",
  };
}

/** Exact chance mass; sampling search may select a bounded subset of these choices. */
export function searchChanceChoices(prepared: PreparedSearchMove): CatChanceChoice[] {
  const { previous, mover, chess } = prepared;
  if (
    prepared.capturedKing ||
    previous.rulesetId === "standard" ||
    previous.rulesetId === "three-check"
  )
    return [{ probability: 1, action: "none" }];
  if (previous.rulesetId === "catchess") {
    const chance = previous.catchess?.[mover] ?? 0;
    if (chance === 0) return [{ probability: 1, action: "none" }];
    const action: "add" | "remove" = chance > 0 ? "add" : "remove";
    const safe = catTargets(chess, mover, action, "p")
      .sort()
      .filter((square) => mutateCatPosition(chess, square, mover, action, "p", true) !== null);
    if (!safe.length) return [{ probability: 1, action: "none" }];
    const chanceMass = Math.abs(chance) / 100;
    return [
      ...(chanceMass < 1 ? [{ probability: 1 - chanceMass, action: "none" as const }] : []),
      ...safe.map((square) => ({ probability: chanceMass / safe.length, action, square })),
    ];
  }
  const choices: CatChanceChoice[] = [];
  for (const action of ["add", "remove"] as const)
    for (const piece of ["p", "r", "b", "n", "q"] as const) {
      const probability = piece === "p" ? 0.25 : 0.0625;
      const targets = catTargets(chess, mover, action, piece).sort();
      if (!targets.length) choices.push({ probability, action: "none", piece });
      else
        for (const square of targets) {
          let kingExposure = false;
          if (action === "remove") {
            const changed = mutateCatPosition(chess, square, mover, action, piece, false);
            const own = mover === "white" ? "w" : "b";
            const king = changed?.findPiece({ type: "k", color: own })[0];
            kingExposure =
              king !== undefined && changed?.isAttacked(king, own === "w" ? "b" : "w") === true;
          }
          choices.push({
            probability: probability / targets.length,
            action,
            piece,
            square,
            ...(kingExposure ? { kingExposure: true as const } : {}),
          });
        }
    }
  return choices;
}

export function completeSearchMove(
  prepared: PreparedSearchMove,
  choice: Pick<CatChanceChoice, "action" | "piece" | "square">,
): { position: SearchPosition; effect: CatEffect | null } {
  const { previous, mover } = prepared;
  const catMode = previous.rulesetId === "catchess" || previous.rulesetId === "chaos-cat";
  let chess = prepared.chess;
  if (choice.action !== "none") {
    if (!choice.square) throw new Error("A cat mutation needs a target.");
    const changed = mutateCatPosition(
      chess,
      choice.square,
      mover,
      choice.action,
      choice.piece ?? "p",
      previous.rulesetId === "catchess",
    );
    if (!changed) throw new Error("The cat mutation exposes a protected king.");
    chess = changed;
  } else if (catMode) chess = derivedCatPosition(chess.fen({ forceEnpassantSquare: true }));
  const checks = { ...previous.checks };
  if (!prepared.capturedKing && chess.inCheck()) checks[mover] += 1;
  const position: SearchPosition = {
    ...previous,
    chess,
    checks,
    plies: previous.plies + 1,
    kingCapture: prepared.capturedKing ? { winner: mover, reason: "king-captured" } : null,
  };
  position.path = { key: searchPositionKey(position), previous: previous.path };
  return {
    position,
    effect: catMode
      ? {
          ply: position.plies,
          color: mover,
          action: choice.action,
          ...(choice.square ? { square: choice.square } : {}),
          ...(choice.piece ? { piece: choice.piece } : {}),
        }
      : null,
  };
}

export function searchHistoryKey(position: SearchPosition): string {
  const keys: string[] = [];
  for (let item = position.path; item; item = item.previous) keys.push(item.key);
  return keys.join("|");
}

export function serializeSearchPosition(position: SearchPosition): BotSearchPosition {
  const repetitions = new Map(position.repetitions);
  for (let item = position.path; item; item = item.previous)
    repetitions.set(item.key, (repetitions.get(item.key) ?? 0) + 1);
  return {
    fen: position.chess.fen({ forceEnpassantSquare: true }),
    rulesetId: position.rulesetId,
    rulesVersion: 1,
    plies: position.plies,
    checks: { ...position.checks },
    repetitions: [...repetitions],
    ...(position.catchess ? { catchess: { ...position.catchess } } : {}),
  };
}
