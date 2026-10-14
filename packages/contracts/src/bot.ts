import { z } from "zod";

export const BOT_ALGORITHM = "cat-search-v1" as const;
export const botProfileSchema = z.enum(["balanced", "strong"]);
export const BOT_PROFILES = {
  balanced: { label: "Balanced cat", thinkMs: 700, maxNodes: 8_000, maxDepth: 4 },
  strong: { label: "Strong cat", thinkMs: 1_800, maxNodes: 24_000, maxDepth: 6 },
} as const;
const botRulesSchema = z.enum(["standard", "three-check", "catchess", "chaos-cat"]);
const botColorSchema = z.enum(["white", "black"]);
const chanceSchema = z.number().int().min(-100).max(100);
export const createBotGameSchema = z
  .object({
    rulesetId: botRulesSchema.default("catchess"),
    color: z.enum(["random", "white", "black"]).default("random"),
    profile: botProfileSchema.default("strong"),
    catchess: z.object({ host: chanceSchema, guest: chanceSchema }).strict().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.rulesetId !== "catchess" && value.catchess !== undefined)
      context.addIssue({ code: "custom", message: "Cat settings apply only to Cat Chess." });
  })
  .transform((value) =>
    value.rulesetId === "catchess"
      ? { ...value, catchess: value.catchess ?? { host: 25, guest: 25 } }
      : value,
  );

export const botMetadataSchema = z
  .object({
    color: botColorSchema,
    profile: botProfileSchema,
    algorithm: z.literal(BOT_ALGORITHM),
    requestId: z.uuid().nullable(),
  })
  .strict();

export const botCommandSchema = z
  .object({
    protocolVersion: z.literal(1),
    commandId: z.uuid(),
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    move: z
      .object({
        from: z.string().regex(/^[a-h][1-8]$/),
        to: z.string().regex(/^[a-h][1-8]$/),
        promotion: z.enum(["q", "r", "b", "n"]).optional(),
      })
      .strict()
      .refine((move) => move.from !== move.to, "A move must change squares."),
  })
  .strict();

/** Search context contains past position counts, never real random draws. */
export const botSearchPositionSchema = z
  .object({
    fen: z.string().min(1).max(128),
    rulesetId: botRulesSchema,
    rulesVersion: z.literal(1),
    plies: z.number().int().min(0).max(1200),
    checks: z.object({ white: z.number().int().min(0), black: z.number().int().min(0) }).strict(),
    catchess: z.object({ white: chanceSchema, black: chanceSchema }).strict().optional(),
    repetitions: z.array(z.tuple([z.string().max(180), z.number().int().min(1).max(5)])).max(1201),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.rulesetId === "catchess") !== (value.catchess !== undefined))
      context.addIssue({ code: "custom", message: "Only Cat Chess needs signed cat settings." });
    if (new Set(value.repetitions.map(([key]) => key)).size !== value.repetitions.length)
      context.addIssue({ code: "custom", message: "Position counts must be unique." });
  });

export const botPositionViewSchema = z
  .object({
    gameId: z.uuid(),
    revision: z.number().int().min(0),
    requestId: z.uuid(),
    profile: botProfileSchema,
    algorithm: z.literal(BOT_ALGORITHM),
    position: botSearchPositionSchema,
  })
  .strict();

export type CreateBotGame = z.infer<typeof createBotGameSchema>;
export type BotProfile = z.infer<typeof botProfileSchema>;
export type BotMetadata = z.infer<typeof botMetadataSchema>;
export type BotCommand = z.infer<typeof botCommandSchema>;
export type BotSearchPosition = z.infer<typeof botSearchPositionSchema>;
export type BotPositionView = z.infer<typeof botPositionViewSchema>;
