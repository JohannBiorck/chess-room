import { z } from "zod";

const name = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
const timestamp = z.number().int().nonnegative();
const color = z.enum(["white", "black"]);
const mode = z.enum(["standard", "three-check", "catchess", "chaos-cat"]);
export const accountPreferencesSchema = z
  .object({
    volume: z.number().int().min(0).max(100),
    motion: z.enum(["system", "reduced", "full"]),
  })
  .strict();
export const accountProfileSchema = z
  .object({
    displayName: name,
    createdAt: timestamp,
    expiresAt: timestamp,
    credentialCount: z.number().int().nonnegative(),
    recoveryCodesRemaining: z.number().int().nonnegative(),
    preferences: accountPreferencesSchema,
  })
  .strict();
export const accountStatusSchema = z
  .object({
    account: accountProfileSchema.nullable(),
    guestGames: z.number().int().nonnegative(),
    guestActiveGames: z.number().int().nonnegative(),
    historyPolicy: z.object({ maxGames: z.literal(500), maxDays: z.literal(365) }).strict(),
  })
  .strict();
export const registrationInputSchema = z
  .object({ displayName: name, keepGuestGames: z.boolean().default(false) })
  .strict();
export const ceremonyInputSchema = z
  .object({ flowId: z.uuid(), response: z.record(z.string(), z.unknown()) })
  .strict();
export const recoveryInputSchema = z
  .object({ locator: z.string().regex(/^[A-Za-z0-9_-]{22}$/), code: z.string().min(22).max(64) })
  .strict();
export const credentialLabelSchema = z.object({ label: z.string().trim().min(1).max(60) }).strict();
export const historyQuerySchema = z
  .object({
    cursor: z.string().max(180).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    ruleset: mode.optional(),
    opponentKind: z.enum(["human", "bot"]).optional(),
    result: z.enum(["win", "loss", "draw"]).optional(),
  })
  .strict();
export const historyItemSchema = z
  .object({
    id: z.uuid(),
    rulesetId: mode,
    color,
    opponentName: name,
    opponentKind: z.enum(["human", "bot"]),
    result: z.enum(["win", "loss", "draw"]),
    reason: z.string().min(1).max(60),
    createdAt: timestamp,
    finishedAt: timestamp,
    timeControl: z.enum(["untimed", "5+0", "10+5", "15+10"]),
  })
  .strict();
export const historyListSchema = z
  .object({ games: z.array(historyItemSchema).max(50), nextCursor: z.string().max(180).nullable() })
  .strict();
export type AccountProfile = z.infer<typeof accountProfileSchema>;
export type AccountStatus = z.infer<typeof accountStatusSchema>;
export type HistoryItem = z.infer<typeof historyItemSchema>;
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export type HistoryList = z.infer<typeof historyListSchema>;
