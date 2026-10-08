import type { CatEffect, Color } from "@chess-room/contracts";

export function catChanceLabel(chance: number): string {
  return chance === 0 ? "Off" : `${Math.abs(chance)}% ${chance > 0 ? "helpful" : "evil"}`;
}

export function catChanceDescription(chance: number): string {
  return chance === 0
    ? "This cat stays off the board."
    : `${Math.abs(chance)}% chance after its owner's move to ${chance > 0 ? "add a pawn of their color to a safe, empty square on their half" : "remove one of their own pawns"}.`;
}

export function catEffectDescription(effect: CatEffect): string {
  const owner = effect.color === "white" ? "White" : "Black";
  if (effect.action === "none") return `${owner}’s cat made no change.`;
  return `${owner}’s cat ${effect.action === "add" ? "added a pawn on" : "removed a pawn from"} ${effect.square}.`;
}

export function catEffectAnnouncement(effect: CatEffect): string {
  return `Move ${effect.ply}: ${catEffectDescription(effect)}`;
}

export function catSquarePosition(square: string, orientation: Color) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const column = orientation === "white" ? file : 7 - file;
  const row = orientation === "white" ? 7 - rank : rank;
  return { column, row, left: column * 12.5, top: row * 12.5 };
}

export function liveCatEffects(
  previous: { id: string; ply: number } | null,
  next: { id: string; ply: number },
  effects: CatEffect[],
  live: boolean,
): CatEffect[] {
  if (!live || !previous || previous.id !== next.id) return [];
  return effects.filter(
    (effect) =>
      effect.ply > previous.ply &&
      effect.ply <= next.ply &&
      effect.action !== "none" &&
      effect.square !== undefined,
  );
}
