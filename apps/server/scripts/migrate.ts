import { Pool } from "pg";

import { migrate } from "../src/storage/migrations.js";

const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  console.error("MIGRATION_DATABASE_URL or DATABASE_URL is required to run migrations.");
  process.exitCode = 1;
} else {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    application_name: "chess-room-migrations",
  });
  try {
    const applied = await migrate(pool);
    console.log(
      applied.length === 0 ? "Database schema is current." : `Applied: ${applied.join(", ")}`,
    );
  } catch {
    // Driver errors can contain connection strings, SQL values or credentials.
    console.error(
      "Database migration failed. Check connectivity, privileges and migration checksums.",
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
