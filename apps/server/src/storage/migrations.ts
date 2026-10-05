import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

export interface Migration {
  name: string;
  sql: string;
}

// Both src/storage and dist/storage are two levels below the server directory.
const migrationDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

export async function readMigrations(directory = migrationDirectory): Promise<Migration[]> {
  const files = (await readdir(directory))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (files.length === 0) throw new Error("No database migrations were found.");
  const prefixes = files.map((name) => name.slice(0, 3));
  if (new Set(prefixes).size !== prefixes.length)
    throw new Error("Migration numbers must be unique.");
  return Promise.all(
    files.map(async (name) => ({
      name,
      sql: await readFile(join(directory, name), "utf8"),
    })),
  );
}

export async function migrate(pool: Pool, migrations?: readonly Migration[]): Promise<string[]> {
  const resolved = [...(migrations ?? (await readMigrations()))].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const names = resolved.map((migration) => migration.name);
  if (names.some((name) => !/^\d{3}_[a-z0-9_]+\.sql$/.test(name))) {
    throw new Error("Migration names must contain a numeric prefix and SQL filename.");
  }
  if (new Set(names).size !== names.length) throw new Error("Migration names must be unique.");
  if (new Set(names.map((name) => name.slice(0, 3))).size !== names.length) {
    throw new Error("Migration numbers must be unique.");
  }
  const client = await pool.connect();
  let destroyClient = false;
  try {
    await client.query("BEGIN");
    // Serializes all migration runners without requiring a privileged database role.
    await client.query("SELECT pg_advisory_xact_lock(764338341)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    const applied = await applyMigrations(client, resolved);
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      destroyClient = true;
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
}

async function applyMigrations(
  client: PoolClient,
  migrations: readonly Migration[],
): Promise<string[]> {
  const stored = await client.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM schema_migrations ORDER BY name",
  );
  const expected = new Map(migrations.map((migration) => [migration.name, migration]));
  for (const [index, row] of stored.rows.entries()) {
    if (!expected.has(row.name)) throw new Error(`Applied migration is missing: ${row.name}`);
    if (migrations[index]?.name !== row.name) {
      throw new Error("New migrations must follow all previously applied migrations.");
    }
  }
  const checksums = new Map(stored.rows.map((row) => [row.name, row.checksum]));
  const applied: string[] = [];
  for (const migration of migrations) {
    const checksum = createHash("sha256").update(migration.sql).digest("hex");
    const previous = checksums.get(migration.name);
    if (previous !== undefined) {
      if (previous !== checksum)
        throw new Error(`Applied migration was changed: ${migration.name}`);
      continue;
    }
    await client.query(migration.sql);
    await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
      migration.name,
      checksum,
    ]);
    applied.push(migration.name);
  }
  return applied;
}
