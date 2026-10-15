import {
  BOT_ALGORITHM,
  BOT_PROFILES,
  type BotProfile,
  type BotSearchPosition,
  type Color,
  type MoveInput,
} from "@chess-room/contracts";
import {
  type CatChanceChoice,
  completeSearchMove,
  createSearchPosition,
  type PreparedSearchMove,
  prepareSearchMove,
  type SearchPosition,
  searchChanceChoices,
  searchExchangeGain,
  searchHistoryKey,
  searchLegalMoves,
  searchOutcome,
} from "@chess-room/game-core/search";
import type { Move, PieceSymbol } from "chess.js";

const VALUES: Readonly<Record<PieceSymbol, number>> = {
  p: 100,
  n: 320,
  b: 335,
  r: 500,
  q: 900,
  k: 0,
};
const WIN = 100_000;
const CHANCE_WIN = 1_000;
const CACHE_LIMIT = 4_000;
const ROOT_PREPARATION_LIMIT = 48;

export interface BotSearchOptions {
  profile?: BotProfile;
  thinkMs?: number;
  maxNodes?: number;
  maxDepth?: number;
  now?: () => number;
  exactChance?: boolean;
  fullWidth?: boolean;
  quiescenceDepth?: number;
}
export interface BotSearchResult {
  algorithm: typeof BOT_ALGORITHM;
  move: MoveInput;
  score: number;
  depth: number;
  nodes: number;
  elapsedMs: number;
  exhausted: boolean;
}
interface Context {
  root: Color;
  deadline: number;
  maxNodes: number;
  nodes: number;
  now: () => number;
  exactChance: boolean;
  fullWidth: boolean;
  quiescenceDepth: number;
  stochastic: boolean;
  cache: Map<string, number>;
  tacticalCache: Map<string, number>;
  rootPosition: SearchPosition | null;
  rootPreparations: Map<Move, PreparedSearchMove>;
  rootChoices: Map<Move, CatChanceChoice[]>;
}
class BudgetReached extends Error {}

function moveInput(move: Move): MoveInput {
  return {
    from: move.from,
    to: move.to,
    ...(move.promotion ? { promotion: move.promotion as "q" | "r" | "b" | "n" } : {}),
  };
}
function opposite(side: Color): Color {
  return side === "white" ? "black" : "white";
}
function sideToMove(position: SearchPosition): Color {
  return position.chess.turn() === "w" ? "white" : "black";
}
function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}

/** Stratify by action/type: the pawn and rare queen probabilities cannot vanish. */
export function sampleChanceChoices(
  choices: readonly CatChanceChoice[],
  perGroup: number,
  seed: string,
): CatChanceChoice[] {
  const groups = new Map<string, CatChanceChoice[]>();
  for (const choice of choices) {
    const key = `${choice.action}:${choice.piece ?? "p"}`;
    const group = groups.get(key) ?? [];
    group.push(choice);
    groups.set(key, group);
  }
  const selected: CatChanceChoice[] = [];
  for (const [key, group] of groups) {
    // Keep every lethal shielding theft at its real probability, then sample
    // remaining targets. Reweighting danger together with safe squares overstates risk.
    selected.push(...group.filter((choice) => choice.kingExposure));
    const ordinary = group.filter((choice) => !choice.kingExposure);
    if (ordinary.length <= perGroup) {
      selected.push(...ordinary);
      continue;
    }
    const count = Math.min(ordinary.length, perGroup);
    const mass = ordinary.reduce((sum, item) => sum + item.probability, 0);
    const offset = hash(`${seed}:${key}`) % ordinary.length;
    for (let i = 0; i < count; i += 1) {
      const choice =
        ordinary[(offset + Math.floor((i * ordinary.length) / count)) % ordinary.length];
      if (choice) selected.push({ ...choice, probability: mass / count });
    }
  }
  return selected;
}

export function evaluatePosition(position: SearchPosition, side: Color): number {
  let white = 0;
  let black = 0;
  const board = position.chess.board();
  for (const row of board)
    for (const piece of row) {
      if (!piece) continue;
      const file = piece.square.charCodeAt(0) - 97;
      const rank = Number(piece.square[1]) - 1;
      const forward = piece.color === "w" ? rank : 7 - rank;
      const center = 7 - Math.abs(file - 3.5) - Math.abs(rank - 3.5);
      let value = VALUES[piece.type];
      if (piece.type === "p") value += forward * 9 + center * 3;
      if (piece.type === "n") value += center * 12;
      if (piece.type === "b") value += center * 5;
      if (piece.type === "r") value += forward * 3;
      if (piece.type === "q") value += center * 2;
      if (piece.type === "k") {
        value -= forward < 2 ? center * 8 : center * 2;
        for (const nearby of board.flat())
          if (
            nearby?.type === "p" &&
            nearby.color === piece.color &&
            Math.abs(nearby.square.charCodeAt(0) - piece.square.charCodeAt(0)) <= 1 &&
            Number(nearby.square[1]) === Number(piece.square[1]) + (piece.color === "w" ? 1 : -1)
          )
            value += 12;
      }
      if (piece.color === "w") white += value;
      else black += value;
    }
  if (position.rulesetId === "three-check") {
    white += position.checks.white * 240;
    black += position.checks.black * 240;
  }
  if (position.rulesetId === "chaos-cat") {
    for (const color of ["w", "b"] as const) {
      const king = position.chess.findPiece({ type: "k", color })[0];
      if (king && position.chess.isAttacked(king, color === "w" ? "b" : "w")) {
        const exposedSide = color === "w" ? "white" : "black";
        const danger = sideToMove(position) === opposite(exposedSide) ? 4_000 : 300;
        if (color === "w") white -= danger;
        else black -= danger;
      }
    }
  }
  return side === "white" ? white - black : black - white;
}

function ordering(move: Move): number {
  const file = move.to.charCodeAt(0) - 97;
  const rank = Number(move.to[1]) - 1;
  const center = 7 - Math.abs(file - 3.5) - Math.abs(rank - 3.5);
  return (
    (move.captured === "k"
      ? WIN
      : move.captured
        ? VALUES[move.captured] * 12 - VALUES[move.piece]
        : 0) +
    (move.promotion ? VALUES[move.promotion] * 10 : 0) +
    (move.san.includes("#") ? 8_000 : move.san.includes("+") ? 100 : 0) +
    (move.piece === "n" ? center * 12 : move.piece === "p" ? center * 6 : center * 2)
  );
}
function rootOrdering(position: SearchPosition, move: Move): number {
  const enemy = move.color === "w" ? "b" : "w";
  const loss =
    move.captured !== "k" && position.chess.isAttacked(move.to, enemy)
      ? Math.max(0, VALUES[move.piece] - (move.captured ? VALUES[move.captured] : 0)) * 12
      : 0;
  return ordering(move) - loss;
}
function orderedMoves(position: SearchPosition, context: Context, depth: number): Move[] {
  const moves = searchLegalMoves(position).sort(
    (a, b) => ordering(b) - ordering(a) || a.lan.localeCompare(b.lan),
  );
  if (context.fullWidth || !context.stochastic || position.chess.inCheck()) return moves;
  // Chance nodes multiply branching. Keep tactical moves plus a bounded quiet beam.
  const limit = depth >= 2 ? 7 : 5;
  return moves.filter(
    (move, index) =>
      index < limit ||
      move.captured !== undefined ||
      move.promotion !== undefined ||
      /[+#]/.test(move.san),
  );
}
function visit(context: Context): void {
  context.nodes += 1;
  if (context.nodes > context.maxNodes || context.now() >= context.deadline)
    throw new BudgetReached();
}
function terminalScore(position: SearchPosition, context: Context): number | null {
  const result = searchOutcome(position);
  if (!result) return null;
  if (!result.winner) return 0;
  return (
    (result.winner === context.root ? 1 : -1) *
    (context.stochastic ? CHANCE_WIN : WIN - position.plies)
  );
}
function utility(value: number, context: Context): number {
  // Mate distance is useful in deterministic chess. At a chance node, mixing
  // 100000 for a rare mate with centipawn material rewards desperate sacrifices.
  // This bounded heuristic is a search utility, not a measured win probability.
  return context.stochastic ? Math.tanh(value / 600) * CHANCE_WIN : value;
}
function tacticalEvaluation(position: SearchPosition, context: Context): number {
  const key = `${position.chess.fen()}:${position.checks.white}:${position.checks.black}:${position.plies}`;
  const cached = context.tacticalCache.get(key);
  if (cached !== undefined) return cached;
  let gain = 0;
  for (const row of position.chess.board())
    for (const piece of row) {
      if (!piece || piece.color === position.chess.turn()) continue;
      if (piece.type !== "k" || position.rulesetId === "chaos-cat")
        gain = Math.max(gain, searchExchangeGain(position, piece.square));
    }
  const side = sideToMove(position) === context.root ? 1 : -1;
  const value =
    gain >= WIN
      ? side * (context.stochastic ? CHANCE_WIN : WIN - position.plies - 1)
      : utility(evaluatePosition(position, context.root) + side * gain, context);
  if (context.tacticalCache.size < 1_000) context.tacticalCache.set(key, value);
  return value;
}
function rootPreparation(position: SearchPosition, move: Move, context: Context) {
  let prepared = context.rootPreparations.get(move);
  if (!prepared) {
    prepared = prepareSearchMove(position, moveInput(move));
    if (context.rootPreparations.size < ROOT_PREPARATION_LIMIT)
      context.rootPreparations.set(move, prepared);
  }
  return prepared;
}
function rootStaticValue(position: SearchPosition, move: Move, context: Context): number {
  const prepared = rootPreparation(position, move, context);
  let all = context.rootChoices.get(move);
  if (!all) {
    all = searchChanceChoices(prepared);
    if (context.rootChoices.size < ROOT_PREPARATION_LIMIT) context.rootChoices.set(move, all);
  }
  const choices = context.exactChance
    ? all
    : sampleChanceChoices(all, 2, `${position.chess.fen()}:root`);
  let value = 0;
  for (const choice of choices) {
    visit(context);
    const child = completeSearchMove(prepared, choice).position;
    value +=
      choice.probability * (terminalScore(child, context) ?? tacticalEvaluation(child, context));
  }
  return value;
}
function expectation(
  position: SearchPosition,
  move: Move,
  depth: number,
  context: Context,
): number {
  const prepared =
    (position === context.rootPosition ? context.rootPreparations.get(move) : undefined) ??
    prepareSearchMove(position, moveInput(move));
  const all =
    (position === context.rootPosition ? context.rootChoices.get(move) : undefined) ??
    searchChanceChoices(prepared);
  const choices = context.exactChance
    ? all
    : sampleChanceChoices(all, depth === 0 ? 2 : 1, `${position.chess.fen()}:${depth}`);
  let value = 0;
  for (const choice of choices) {
    visit(context);
    const child = completeSearchMove(prepared, choice).position;
    // An expectation needs complete child values, not ordinary alpha-beta bounds.
    value += choice.probability * decision(child, depth, context, -WIN, WIN);
  }
  return value;
}
function decision(
  position: SearchPosition,
  depth: number,
  context: Context,
  alpha: number,
  beta: number,
): number {
  const terminal = terminalScore(position, context);
  if (terminal !== null) return terminal;
  if (depth === 0) return quiescence(position, context, context.quiescenceDepth, alpha, beta);
  const key = `${depth}:${position.chess.fen()}:${position.checks.white}:${position.checks.black}:${position.plies}:${searchHistoryKey(position)}`;
  const cached = context.cache.get(key);
  if (cached !== undefined) return cached;
  const maximizing = sideToMove(position) === context.root;
  const originalAlpha = alpha;
  const originalBeta = beta;
  let best = maximizing ? -WIN : WIN;
  let pruned = false;
  const deterministic = !context.stochastic;
  for (const move of orderedMoves(position, context, depth)) {
    const value = deterministic
      ? deterministicValue(position, move, depth - 1, context, alpha, beta)
      : expectation(position, move, depth - 1, context);
    best = maximizing ? Math.max(best, value) : Math.min(best, value);
    if (deterministic) {
      if (maximizing) alpha = Math.max(alpha, best);
      else beta = Math.min(beta, best);
      if (beta <= alpha) {
        pruned = true;
        break;
      }
    }
  }
  if (
    !pruned &&
    (!deterministic || (best > originalAlpha && best < originalBeta)) &&
    context.cache.size < CACHE_LIMIT
  )
    context.cache.set(key, best);
  return best;
}

/** Resolve immediate exchanges instead of mistaking a hanging piece for a gain. */
function quiescence(
  position: SearchPosition,
  context: Context,
  remaining: number,
  alpha: number,
  beta: number,
): number {
  const terminal = terminalScore(position, context);
  if (terminal !== null) return terminal;
  if (remaining === 0) return tacticalEvaluation(position, context);
  const standing = utility(evaluatePosition(position, context.root), context);
  const maximizing = sideToMove(position) === context.root;
  const inCheck = position.chess.inCheck();
  let best = inCheck ? (maximizing ? -WIN : WIN) : standing;
  const deterministic = !context.stochastic;
  if (deterministic && !inCheck) {
    if (maximizing) {
      if (best >= beta) return best;
      alpha = Math.max(alpha, best);
    } else {
      if (best <= alpha) return best;
      beta = Math.min(beta, best);
    }
  }
  const moves = searchLegalMoves(position)
    .filter((move) => inCheck || move.captured !== undefined || move.promotion !== undefined)
    .sort((a, b) => ordering(b) - ordering(a));
  for (const move of moves.slice(0, inCheck ? moves.length : 6)) {
    const prepared = prepareSearchMove(position, moveInput(move));
    const all = searchChanceChoices(prepared);
    const choices = context.exactChance
      ? all
      : sampleChanceChoices(all, 1, `${position.chess.fen()}:quiet`);
    let value = 0;
    for (const choice of choices) {
      visit(context);
      const child = completeSearchMove(prepared, choice).position;
      value +=
        choice.probability *
        quiescence(
          child,
          context,
          remaining - 1,
          deterministic ? alpha : -WIN,
          deterministic ? beta : WIN,
        );
    }
    best = maximizing ? Math.max(best, value) : Math.min(best, value);
    if (deterministic) {
      if (maximizing) alpha = Math.max(alpha, best);
      else beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
  }
  return best;
}
function deterministicValue(
  position: SearchPosition,
  move: Move,
  depth: number,
  context: Context,
  alpha: number,
  beta: number,
): number {
  visit(context);
  const child = completeSearchMove(prepareSearchMove(position, moveInput(move)), {
    action: "none",
  }).position;
  return decision(child, depth, context, alpha, beta);
}

export function chooseBotMove(
  snapshot: BotSearchPosition,
  options: BotSearchOptions = {},
): BotSearchResult {
  const profile = BOT_PROFILES[options.profile ?? "strong"];
  const now = options.now ?? (() => performance.now());
  const started = now();
  const stochastic =
    snapshot.rulesetId === "chaos-cat" ||
    (snapshot.rulesetId === "catchess" &&
      (snapshot.catchess?.white !== 0 || snapshot.catchess?.black !== 0));
  const context: Context = {
    root: snapshot.fen.split(" ")[1] === "w" ? "white" : "black",
    deadline: started + Math.max(1, Math.min(options.thinkMs ?? profile.thinkMs, 3_000)),
    maxNodes: Math.max(1, Math.min(options.maxNodes ?? profile.maxNodes, 50_000)),
    nodes: 0,
    now,
    exactChance: options.exactChance ?? false,
    fullWidth: options.fullWidth ?? false,
    // Legal exchange analysis resolves the chance-search horizon without
    // expanding another exponential tree of random recaptures at every leaf.
    quiescenceDepth: Math.max(0, Math.min(options.quiescenceDepth ?? (stochastic ? 0 : 2), 3)),
    stochastic,
    cache: new Map(),
    tacticalCache: new Map(),
    rootPosition: null,
    rootPreparations: new Map(),
    rootChoices: new Map(),
  };
  const position = createSearchPosition(snapshot);
  const moves = searchLegalMoves(position).sort(
    (a, b) => rootOrdering(position, b) - rootOrdering(position, a) || a.lan.localeCompare(b.lan),
  );
  const first = moves[0];
  if (!first) throw new Error("The bot has no legal move in this position.");
  const immediateWin = moves.find((move) =>
    position.rulesetId === "chaos-cat"
      ? move.captured === "k"
      : !context.stochastic
        ? move.san.endsWith("#") ||
          (position.rulesetId === "three-check" &&
            position.checks[context.root] >= 2 &&
            move.san.endsWith("+"))
        : false,
  );
  if (immediateWin)
    return {
      algorithm: BOT_ALGORITHM,
      move: moveInput(immediateWin),
      score: context.stochastic ? CHANCE_WIN : WIN - snapshot.plies - 1,
      depth: 1,
      nodes: 1,
      elapsedMs: Math.max(0, now() - started),
      exhausted: false,
    };
  let best = first;
  let score = utility(evaluatePosition(position, context.root), context);
  let completedDepth = 0;
  let exhausted = false;
  let rankings = moves.map((move) => ({ move, score: rootOrdering(position, move) }));
  context.rootPosition = position;
  // First compare every root move cheaply. Expensive chance/quiescence trees
  // must not monopolize the turn before a safe quiet alternative is considered.
  const coarse: typeof rankings = [];
  try {
    for (const { move } of rankings) {
      visit(context);
      const prepared = rootPreparation(position, move, context);
      const child = completeSearchMove(prepared, { action: "none" }).position;
      const value = terminalScore(child, context) ?? tacticalEvaluation(child, context);
      coarse.push({ move, score: value });
    }
  } catch (error) {
    if (!(error instanceof BudgetReached)) throw error;
    exhausted = true;
  }
  if (coarse.length) {
    coarse.sort((a, b) => b.score - a.score);
    rankings = coarse;
    best = coarse[0]?.move ?? best;
    score = coarse[0]?.score ?? score;
  }
  if (context.stochastic && !exhausted) {
    const weighted: typeof rankings = [];
    try {
      for (const candidate of rankings)
        weighted.push({
          move: candidate.move,
          score: rootStaticValue(position, candidate.move, context),
        });
      weighted.sort((a, b) => b.score - a.score);
      rankings = weighted;
      best = weighted[0]?.move ?? best;
      score = weighted[0]?.score ?? score;
      completedDepth = 1;
    } catch (error) {
      if (!(error instanceof BudgetReached)) throw error;
      exhausted = true;
    }
  }
  const maximumDepth = Math.max(1, Math.min(options.maxDepth ?? profile.maxDepth, 8));
  for (let depth = context.stochastic ? 2 : 1; depth <= maximumDepth; depth += 1) {
    if (exhausted) break;
    const next: { move: Move; score: number }[] = [];
    let rootAlpha = -WIN;
    const candidates =
      depth === 1 || context.fullWidth || !context.stochastic ? rankings : rankings.slice(0, 8);
    try {
      for (const candidate of candidates) {
        const value = !context.stochastic
          ? deterministicValue(position, candidate.move, depth - 1, context, rootAlpha, WIN)
          : expectation(position, candidate.move, depth - 1, context);
        next.push({ move: candidate.move, score: value });
        rootAlpha = Math.max(rootAlpha, value);
      }
      next.sort((a, b) => b.score - a.score);
      const winner = next[0];
      if (winner) {
        best = winner.move;
        score = winner.score;
        completedDepth = depth;
        rankings = next;
      }
      if (score >= (context.stochastic ? CHANCE_WIN : WIN - snapshot.plies - maximumDepth - 1))
        break;
    } catch (error) {
      if (!(error instanceof BudgetReached)) throw error;
      exhausted = true;
      break;
    }
  }
  return {
    algorithm: BOT_ALGORITHM,
    move: moveInput(best),
    score,
    depth: completedDepth,
    nodes: context.nodes,
    elapsedMs: Math.max(0, now() - started),
    exhausted,
  };
}
