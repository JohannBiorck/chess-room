import { Pool } from "pg";
import { readApplicationConfig } from "./application/config.js";
import { grantRuntimeAccess, readRuntimeRole } from "./application/database-grants.js";
import { startApplication } from "./runtime.js";
import { migrate } from "./storage/migrations.js";

async function startHostedApplication() {
  const config = readApplicationConfig(process.env);
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  if (!migrationUrl) throw new Error("MIGRATION_DATABASE_URL is required for hosted startup.");
  const runtimeRole = readRuntimeRole(config.databaseUrl);
  const owner = new Pool({
    connectionString: migrationUrl,
    max: 1,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
    application_name: "chess-room-migrations",
  });
  let migrationConnectionFailed = false;
  owner.on("error", () => {
    migrationConnectionFailed = true;
  });
  try {
    await migrate(owner);
    await grantRuntimeAccess(owner, runtimeRole);
    if (migrationConnectionFailed) throw new Error("Migration connection failed.");
  } finally {
    await owner.end();
  }
  // The running application needs only its restricted connection credential.
  delete process.env.MIGRATION_DATABASE_URL;
  await startApplication();
}

startHostedApplication().catch(() => {
  console.error(
    "Hosted startup failed. Check database credentials, role privileges, and migration checksums.",
  );
  process.exitCode = 1;
});
