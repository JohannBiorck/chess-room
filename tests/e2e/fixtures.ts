import { test as base } from "@playwright/test";
import { Pool, type PoolClient } from "pg";

function isolatedDatabase() {
  const schema = process.env.BROWSER_TEST_SCHEMA;
  const connection = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!schema || !/^browser_test_[a-f0-9]{32}$/.test(schema) || !connection)
    throw new Error("Browser checks must run through npm run test:e2e in a disposable schema.");
  let url: URL;
  try {
    url = new URL(connection);
  } catch {
    throw new Error("The browser fixture requires a valid local PostgreSQL URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.pathname.length < 2 ||
    url.hash ||
    [...url.searchParams.keys()].length !== 1 ||
    url.searchParams.get("options") !== `-c search_path=${schema}`
  )
    throw new Error("Browser fixture cleanup requires the runner's isolated loopback database.");
  return { schema, connection: url.href };
}

async function confirmSchema(client: PoolClient, schema: string) {
  const current = await client.query<{ name: string }>("SELECT current_schema() AS name");
  if (current.rows[0]?.name !== schema)
    throw new Error("Refusing browser fixture cleanup outside its disposable schema.");
}

async function resetFixtures(client: PoolClient, schema: string) {
  try {
    await client.query("BEGIN");
    await confirmSchema(client, schema);
    await client.query("SET LOCAL lock_timeout = '5s'");
    const crossSchema = await client.query<{ count: string }>(
      `WITH RECURSIVE dependants(oid) AS (
        SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relname IN ('matches','player_sessions','accounts','match_archives')
        UNION
        SELECT constraint_record.conrelid FROM pg_constraint constraint_record
        JOIN dependants d ON d.oid=constraint_record.confrelid
        WHERE constraint_record.contype='f'
      ) SELECT count(*)::text AS count FROM dependants d
        JOIN pg_class c ON c.oid=d.oid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname<>$1`,
      [schema],
    );
    if (crossSchema.rows[0]?.count !== "0")
      throw new Error("Refusing browser fixture cleanup with cross-schema dependencies.");
    // Preserve app_rate_limits and schema_migrations: real IP guard
    // windows and migration history remain intact between tests.
    await client.query(
      `TRUNCATE "${schema}".matches, "${schema}".player_sessions, "${schema}".accounts, "${schema}".match_archives CASCADE`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export const test = base.extend<{ isolatedFixtures: undefined }>({
  isolatedFixtures: [
    async ({ browser }, use) => {
      const { schema, connection } = isolatedDatabase();
      const pool = new Pool({
        connectionString: connection,
        max: 1,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 10_000,
      });
      const precedingContexts = new Set(browser.contexts());
      try {
        const client = await pool.connect();
        try {
          await confirmSchema(client, schema);
        } finally {
          client.release();
        }
        await use(undefined);
      } finally {
        try {
          // Auto fixtures initialize before page/context; also close any manually
          // created contexts left behind by a failed test before changing its data.
          await Promise.all(
            browser
              .contexts()
              .filter((context) => !precedingContexts.has(context))
              .map((context) => context.close()),
          );
          const client = await pool.connect();
          try {
            await resetFixtures(client, schema);
          } finally {
            client.release();
          }
        } finally {
          await pool.end();
        }
      }
    },
    { auto: true },
  ],
});
