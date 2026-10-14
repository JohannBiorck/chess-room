import { BOT_ALGORITHM, botProfileSchema, botSearchPositionSchema } from "@chess-room/contracts";
import { z } from "zod";

export const botWorkerRequestSchema = z
  .object({
    type: z.literal("search"),
    requestId: z.uuid(),
    position: botSearchPositionSchema,
    profile: botProfileSchema,
    thinkMs: z.number().int().min(1).max(3000),
  })
  .strict();
export const botWorkerResultSchema = z
  .object({
    type: z.literal("result"),
    requestId: z.uuid(),
    result: z
      .object({
        algorithm: z.literal(BOT_ALGORITHM),
        move: z
          .object({
            from: z.string().regex(/^[a-h][1-8]$/),
            to: z.string().regex(/^[a-h][1-8]$/),
            promotion: z.enum(["q", "r", "b", "n"]).optional(),
          })
          .strict(),
        score: z.number().finite(),
        depth: z.number().int().min(0).max(8),
        nodes: z.number().int().min(0).max(50001),
        elapsedMs: z.number().finite().min(0),
        exhausted: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type BotWorkerRequest = z.infer<typeof botWorkerRequestSchema>;
