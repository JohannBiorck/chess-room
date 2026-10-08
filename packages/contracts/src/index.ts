import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const MAX_GAME_PLIES = 1200;

export const rulesetIdSchema = z.enum(["standard", "three-check", "catchess"]);
export const colorSchema = z.enum(["white", "black"]);
export const squareSchema = z.string().regex(/^[a-h][1-8]$/);
export const promotionSchema = z.enum(["q", "r", "b", "n"]);
export const timeControlSchema = z.enum(["untimed", "5+0", "10+5", "15+10"]);
export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .refine(
    (name) => !/[\p{Cc}\p{Cf}]/u.test(name),
    "Display names cannot contain control characters.",
  );

export const RULESETS = [
  {
    id: "standard",
    version: 1,
    label: "Standard chess",
    description: "Checkmate wins. Threefold repetition and fifty-move draws can be claimed.",
  },
  {
    id: "three-check",
    version: 1,
    label: "Three-check",
    description: "Standard legal moves. Deliver three checks to win; checkmate also wins.",
  },
  {
    id: "catchess",
    version: 1,
    label: "Catchess",
    description: "After each move, a helpful cat may add your pawn or an evil cat may remove one.",
  },
] as const;

export const TIME_CONTROLS = {
  untimed: { initialMs: null, incrementMs: 0, label: "Untimed" },
  "5+0": { initialMs: 300_000, incrementMs: 0, label: "5 minutes" },
  "10+5": { initialMs: 600_000, incrementMs: 5_000, label: "10 minutes + 5 seconds" },
  "15+10": { initialMs: 900_000, incrementMs: 10_000, label: "15 minutes + 10 seconds" },
} as const;

export const guestSessionSchema = z.object({ displayName: displayNameSchema }).strict();
export const catChanceSchema = z.number().int().min(-100).max(100);
export const catchessSettingsSchema = z
  .object({ host: catChanceSchema, guest: catChanceSchema })
  .strict();
export const catchessConfigSchema = z
  .object({ white: catChanceSchema, black: catChanceSchema })
  .strict();
export const createGameSchema = z
  .object({
    rulesetId: rulesetIdSchema.default("standard"),
    color: z.enum(["random", "white", "black"]).default("random"),
    timeControl: timeControlSchema.default("untimed"),
    catchess: catchessSettingsSchema.optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.rulesetId !== "catchess" && config.catchess !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Cat settings apply only to Catchess.",
        path: ["catchess"],
      });
    }
  })
  .transform((config) =>
    config.rulesetId === "catchess"
      ? { ...config, catchess: config.catchess ?? { host: 25, guest: 25 } }
      : config,
  );
export const invitationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const joinInvitationSchema = z.object({ token: invitationTokenSchema }).strict();

export const moveInputSchema = z
  .object({ from: squareSchema, to: squareSchema, promotion: promotionSchema.optional() })
  .strict()
  .refine((move) => move.from !== move.to, "A move must change squares.");
export const moveActionSchema = z
  .object({
    type: z.literal("move"),
    from: squareSchema,
    to: squareSchema,
    promotion: promotionSchema.optional(),
  })
  .strict()
  .refine((move) => move.from !== move.to, "A move must change squares.");

export const gameActionSchema = z.discriminatedUnion("type", [
  moveActionSchema,
  z.object({ type: z.literal("resign") }).strict(),
  z.object({ type: z.literal("offer-draw") }).strict(),
  z.object({ type: z.literal("accept-draw") }).strict(),
  z.object({ type: z.literal("decline-draw") }).strict(),
  z.object({ type: z.literal("claim-draw") }).strict(),
  z.object({ type: z.literal("request-rematch") }).strict(),
  z.object({ type: z.literal("accept-rematch") }).strict(),
]);

export const gameCommandSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    commandId: z.uuid(),
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    action: gameActionSchema,
  })
  .strict();

export const drawClaimSchema = z.enum(["threefold-repetition", "fifty-move"]);
export const outcomeReasonSchema = z.enum([
  "checkmate",
  "stalemate",
  "dead-position",
  "three-check",
  "fivefold-repetition",
  "seventy-five-move",
  "threefold-repetition",
  "fifty-move",
  "resignation",
  "agreement",
  "timeout",
  "timeout-insufficient-material",
  "move-limit",
  "session-expired",
]);
export const gameOutcomeSchema = z
  .object({ winner: colorSchema.nullable(), reason: outcomeReasonSchema })
  .strict();
export const boardPieceSchema = z
  .object({
    square: squareSchema,
    type: z.enum(["p", "n", "b", "r", "q", "k"]),
    color: colorSchema,
  })
  .strict();
export const moveRecordSchema = z
  .object({
    ply: z.number().int().min(1),
    color: colorSchema,
    from: squareSchema,
    to: squareSchema,
    promotion: promotionSchema.optional(),
    san: z.string().max(32),
  })
  .strict();
export const catEffectSchema = z
  .object({
    ply: z.number().int().min(1).max(MAX_GAME_PLIES),
    color: colorSchema,
    action: z.enum(["add", "remove", "none"]),
    square: squareSchema.optional(),
  })
  .strict()
  .refine(
    (effect) =>
      effect.action === "none" ? effect.square === undefined : effect.square !== undefined,
    "Applied cat effects need a square; skipped effects do not.",
  );
export const enginePositionSchema = z
  .object({
    fen: z.string().max(128),
    turn: colorSchema,
    inCheck: z.boolean(),
    board: z.array(boardPieceSchema).max(64),
    legalMoves: z.array(moveInputSchema).max(2048),
    moves: z.array(moveRecordSchema).max(MAX_GAME_PLIES),
    checks: z.object({ white: z.number().int().min(0), black: z.number().int().min(0) }).strict(),
    claimableDraws: z.array(drawClaimSchema).max(2),
    outcome: gameOutcomeSchema.nullable(),
    catEffects: z.array(catEffectSchema).max(MAX_GAME_PLIES).default([]),
  })
  .strict();
// Existing protocol-one clients validate objects strictly. Keep their wire shape
// unchanged for existing modes while allowing the new mode's explicit effects.
export const publicEnginePositionSchema = enginePositionSchema.extend({
  catEffects: z.array(catEffectSchema).max(MAX_GAME_PLIES).optional(),
});
const publicPlayerSchema = z.object({ displayName: displayNameSchema }).strict();
const timestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const publicClocksSchema = z
  .object({
    whiteMs: z.number().min(0),
    blackMs: z.number().min(0),
    runningColor: colorSchema.nullable(),
    turnStartedAt: timestampSchema.nullable(),
    serverNow: timestampSchema,
  })
  .strict();
export const publicGameSchema = z
  .object({
    id: z.uuid(),
    revision: z.number().int().min(0),
    phase: z.enum(["waiting", "active", "finished"]),
    rulesetId: rulesetIdSchema,
    rulesVersion: z.literal(1),
    timeControl: timeControlSchema,
    catchess: catchessConfigSchema.nullable().optional(),
    players: z
      .object({ white: publicPlayerSchema.nullable(), black: publicPlayerSchema.nullable() })
      .strict(),
    position: publicEnginePositionSchema,
    clocks: publicClocksSchema.nullable(),
    outcome: gameOutcomeSchema.nullable(),
    drawOffer: colorSchema.nullable(),
    rematchRequested: z.array(colorSchema).max(2),
    rematchGameId: z.uuid().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((game, context) => {
    if (game.rulesetId === "catchess") {
      if (
        !game.catchess ||
        !game.position.catEffects ||
        game.position.catEffects.length !== game.position.moves.length
      ) {
        context.addIssue({
          code: "custom",
          message: "Catchess requires settings and one effect per move.",
        });
      } else if (
        game.position.moves.some(
          (move, index) =>
            game.position.catEffects?.[index]?.ply !== move.ply ||
            game.position.catEffects[index]?.color !== move.color,
        )
      ) {
        context.addIssue({ code: "custom", message: "Cat effects must match their moves." });
      }
    } else if (game.catchess !== undefined || game.position.catEffects !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Existing modes omit cat fields from the public protocol.",
      });
    }
  });
export const gameViewSchema = z
  .object({ game: publicGameSchema, seat: colorSchema.nullable() })
  .strict();
export const sessionViewSchema = z
  .object({ displayName: displayNameSchema, expiresAt: timestampSchema })
  .strict();

export type RulesetId = z.infer<typeof rulesetIdSchema>;
export type CatchessSettings = z.infer<typeof catchessSettingsSchema>;
export type CatchessConfig = z.infer<typeof catchessConfigSchema>;
export type CatEffect = z.infer<typeof catEffectSchema>;
export type Color = z.infer<typeof colorSchema>;
export type Square = z.infer<typeof squareSchema>;
export type Promotion = z.infer<typeof promotionSchema>;
export type TimeControl = z.infer<typeof timeControlSchema>;
export type CreateGame = z.infer<typeof createGameSchema>;
export type MoveInput = z.infer<typeof moveInputSchema>;
export type GameAction = z.infer<typeof gameActionSchema>;
export type GameCommand = z.infer<typeof gameCommandSchema>;
export type DrawClaim = z.infer<typeof drawClaimSchema>;
export type GameOutcome = z.infer<typeof gameOutcomeSchema>;
export type BoardPiece = z.infer<typeof boardPieceSchema>;
export type MoveRecord = z.infer<typeof moveRecordSchema>;
export type EnginePosition = z.infer<typeof enginePositionSchema>;
export type PublicClocks = z.infer<typeof publicClocksSchema>;
export type PublicGame = z.infer<typeof publicGameSchema>;
export type GameView = z.infer<typeof gameViewSchema>;
export type SessionView = z.infer<typeof sessionViewSchema>;
