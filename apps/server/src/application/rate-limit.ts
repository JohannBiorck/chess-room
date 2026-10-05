import type { Database } from "../storage/database.js";
import { ApplicationError } from "./errors.js";
import { tokenHash } from "./games.js";

export async function rateLimit(
  database: Database,
  identity: string,
  limit: number,
  windowMs = 60_000,
) {
  const result = await database.pool.query<{ count: number }>(
    `INSERT INTO app_rate_limits (key, window_start, count)
     VALUES ($1, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint, 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN app_rate_limits.window_start + $2 <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint THEN 1 ELSE app_rate_limits.count + 1 END,
       window_start = CASE WHEN app_rate_limits.window_start + $2 <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint THEN floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint ELSE app_rate_limits.window_start END
     RETURNING count`,
    [tokenHash(identity), windowMs],
  );
  if ((result.rows[0]?.count ?? limit + 1) > limit)
    throw new ApplicationError("RATE_LIMITED", "Too many requests. Please wait a minute.", 429);
}
