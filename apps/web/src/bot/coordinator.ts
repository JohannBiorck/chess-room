import {
  type BotCommand,
  type BotMetadata,
  type BotPositionView,
  botCommandSchema,
  type GameView,
  type MoveInput,
  type PublicGame,
} from "@chess-room/contracts";

const STORAGE_KEY = "cat-chess.pending-bot-command";
export interface PendingBotCommand {
  gameId: string;
  command: BotCommand;
}
export function matchesMove(left: MoveInput, right: MoveInput): boolean {
  return left.from === right.from && left.to === right.to && left.promotion === right.promotion;
}
export function isBotTurn(game: PublicGame): game is PublicGame & { bot: BotMetadata } {
  return (
    game.bot !== undefined &&
    game.phase === "active" &&
    game.position.turn === game.bot.color &&
    game.bot.requestId !== null
  );
}
export function readPendingBotCommand(
  storage?: Pick<Storage, "getItem">,
): PendingBotCommand | null {
  try {
    const raw = (storage ?? sessionStorage).getItem(STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("gameId" in value) ||
      typeof value.gameId !== "string" ||
      !("command" in value)
    )
      return null;
    const parsed = botCommandSchema.safeParse(value.command);
    return parsed.success ? { gameId: value.gameId, command: parsed.data } : null;
  } catch {
    return null;
  }
}
export function savePendingBotCommand(
  value: PendingBotCommand | null,
  storage?: Pick<Storage, "setItem" | "removeItem">,
): void {
  try {
    const destination = storage ?? sessionStorage;
    if (value) destination.setItem(STORAGE_KEY, JSON.stringify(value));
    else destination.removeItem(STORAGE_KEY);
  } catch {
    /* An in-memory pending command still supports same-tab retries. */
  }
}
export function reusableBotCommand(
  pending: PendingBotCommand | null,
  game: PublicGame,
): BotCommand | null {
  return pending?.gameId === game.id &&
    pending.command.expectedRevision === game.revision &&
    pending.command.commandId === game.bot?.requestId &&
    game.position.legalMoves.some((move) => matchesMove(move, pending.command.move))
    ? pending.command
    : null;
}
export function validateBotPosition(view: BotPositionView, game: PublicGame): void {
  if (
    !isBotTurn(game) ||
    view.gameId !== game.id ||
    view.revision !== game.revision ||
    view.requestId !== game.bot.requestId ||
    view.profile !== game.bot.profile ||
    view.algorithm !== game.bot.algorithm ||
    view.position.rulesetId !== game.rulesetId ||
    view.position.plies !== game.position.moves.length ||
    view.position.fen
      .split(" ")
      .filter((_, index) => index !== 3)
      .join(" ") !==
      game.position.fen
        .split(" ")
        .filter((_, index) => index !== 3)
        .join(" ") ||
    view.position.checks.white !== game.position.checks.white ||
    view.position.checks.black !== game.position.checks.black ||
    view.position.catchess?.white !== game.catchess?.white ||
    view.position.catchess?.black !== game.catchess?.black
  )
    throw new Error("The game changed while the cat was preparing. Reconnect to continue.");
}
/** Small emergency fallback: legality is supplied by the authoritative snapshot. */
export function fallbackBotMove(game: PublicGame): MoveInput {
  const values: Record<string, number> = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 100000 };
  const score = (move: MoveInput) =>
    (values[game.position.board.find((piece) => piece.square === move.to)?.type ?? ""] ?? 0) +
    (move.promotion ? (values[move.promotion] ?? 0) : 0);
  const moves = [...game.position.legalMoves].sort(
    (a, b) =>
      score(b) - score(a) ||
      `${a.from}${a.to}${a.promotion ?? ""}`.localeCompare(`${b.from}${b.to}${b.promotion ?? ""}`),
  );
  const move = moves[0];
  if (!move) throw new Error("The cat has no legal move. Reconnect to continue.");
  return move;
}
export function acceptedBotView(view: GameView, game: PublicGame, command: BotCommand): boolean {
  const applied = view.game.position.moves.at(game.position.moves.length);
  return (
    view.game.id === game.id &&
    view.game.revision > command.expectedRevision &&
    applied !== undefined &&
    matchesMove(applied, command.move)
  );
}
