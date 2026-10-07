import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../storage/database.js";
import { migrate } from "../storage/migrations.js";
import { grantRuntimeAccess, readRuntimeRole } from "./database-grants.js";
import { GameService } from "./games.js";
import { rateLimit } from "./rate-limit.js";

const ownerUrl =
  process.env.MIGRATION_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const administratorUrl = process.env.ADMIN_DATABASE_URL;
if (!ownerUrl || !administratorUrl) {
  throw new Error(
    "PostgreSQL grant integration tests require an owner database URL and ADMIN_DATABASE_URL.",
  );
}

describe("separate migration and runtime database privileges", () => {
  let administrator: Pool;
  let owner: Pool;
  let runtime: Database;
  let schema: string;
  let role: string;
  let databaseName: string;
  const ownerRole = readRuntimeRole(ownerUrl);

  const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

  beforeEach(async () => {
    schema = `grants_test_${randomUUID().replaceAll("-", "")}`;
    role = `runtime_test_${randomUUID().replaceAll("-", "")}`;
    const password = randomBytes(32).toString("hex");
    administrator = new Pool({ connectionString: administratorUrl, max: 1 });
    owner = new Pool({ connectionString: ownerUrl, max: 1, options: `-c search_path=${schema}` });
    const result = await owner.query<{ database_name: string }>(
      "SELECT current_database() AS database_name",
    );
    const name = result.rows[0]?.database_name;
    if (!name) throw new Error("Database name is unavailable.");
    databaseName = name;
    await owner.query(`CREATE SCHEMA ${quote(schema)}`);
    await administrator.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await migrate(owner);
    const url = new URL(ownerUrl);
    url.username = role;
    url.password = password;
    runtime = new Database(url.toString(), { options: `-c search_path=${schema}` });
  });

  afterEach(async () => {
    await runtime?.close();
    await owner?.end();
    if (administrator) {
      try {
        await administrator.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
        await administrator.query(
          `REVOKE CONNECT ON DATABASE ${quote(databaseName)} FROM ${quote(role)}`,
        );
        await administrator.query(`REVOKE ${quote(ownerRole)} FROM ${quote(role)}`);
        await administrator.query(`DROP ROLE IF EXISTS ${quote(role)}`);
      } finally {
        await administrator.end();
      }
    }
  });

  it("permits the real game flow through an ordinary runtime login and grants explicit database connection access", async () => {
    await grantRuntimeAccess(owner, role, schema);
    await grantRuntimeAccess(owner, role, schema);
    const service = new GameService(runtime);
    const white = await service.createSession("White");
    const black = await service.createSession("Black");
    const created = await service.create(white.session, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
    });
    const joined = await service.join(black.session, created.invitation.token);
    const moved = await service.command(white.session, joined.game.id, {
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: joined.game.revision,
      action: { type: "move", from: "e2", to: "e4" },
    });
    expect(moved.game.revision).toBe(2);
    await rateLimit(runtime, "grant-integration", 10);
    const events = await runtime.transaction((tx) => tx.claimOutbox());
    expect(events).toHaveLength(3);
    const connection = await owner.query<{ explicit_connect: boolean }>(
      `SELECT EXISTS (
      SELECT 1 FROM pg_database d, LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
      JOIN pg_roles r ON r.oid=a.grantee WHERE d.datname=current_database()
      AND r.rolname=$1 AND a.privilege_type='CONNECT') AS explicit_connect`,
      [role],
    );
    expect(connection.rows[0]?.explicit_connect).toBe(true);
    const privileges = await runtime.pool.query<{ allowed: boolean }>(`SELECT bool_and(
      has_table_privilege(current_user,relation,'SELECT') AND has_table_privilege(current_user,relation,'INSERT')
      AND has_table_privilege(current_user,relation,'UPDATE') AND has_table_privilege(current_user,relation,'DELETE')
      AND NOT has_table_privilege(current_user,relation,'TRUNCATE')) AS allowed
      FROM unnest(ARRAY['player_sessions','matches','match_seats','invitations','match_events','command_receipts','event_outbox','app_rate_limits']) AS relation`);
    expect(privileges.rows[0]?.allowed).toBe(true);
  });

  it("denies migration-table access, DDL, truncate and administrative sequence access", async () => {
    await grantRuntimeAccess(owner, role, schema);
    for (const sql of [
      "SELECT * FROM schema_migrations",
      "INSERT INTO schema_migrations(name,checksum) VALUES ('999_forbidden.sql',repeat('a',64))",
      "CREATE TABLE forbidden_table (id integer)",
      "ALTER TABLE matches ADD COLUMN forbidden_column integer",
      "DROP TABLE matches",
      "TRUNCATE matches CASCADE",
      "SELECT last_value FROM event_outbox_id_seq",
    ]) {
      await expect(runtime.pool.query(sql)).rejects.toMatchObject({ code: "42501" });
    }
    const existing = await owner.query<{ count: string }>("SELECT count(*) FROM schema_migrations");
    expect(existing.rows[0]?.count).toBe("1");
  });

  it("rejects the migration owner and inherited owner membership before granting access", async () => {
    await expect(grantRuntimeAccess(owner, ownerRole, schema)).rejects.toThrow(
      "separate runtime role",
    );
    await administrator.query(`GRANT ${quote(ownerRole)} TO ${quote(role)}`);
    await expect(grantRuntimeAccess(owner, role, schema)).rejects.toThrow("separate runtime role");
  });

  it.each(["SUPERUSER", "CREATEDB", "CREATEROLE", "REPLICATION", "BYPASSRLS"])(
    "rejects a runtime role with the %s attribute",
    async (attribute) => {
      await administrator.query(`ALTER ROLE ${quote(role)} ${attribute}`);
      await expect(grantRuntimeAccess(owner, role, schema)).rejects.toThrow(
        "separate runtime role",
      );
    },
  );

  it("rejects a runtime schema owner or a role with preexisting DDL grants", async () => {
    await owner.query(`GRANT CREATE ON SCHEMA ${quote(schema)} TO ${quote(role)}`);
    await expect(grantRuntimeAccess(owner, role, schema)).rejects.toThrow("separate runtime role");
    await administrator.query(`ALTER SCHEMA ${quote(schema)} OWNER TO ${quote(role)}`);
    await expect(grantRuntimeAccess(owner, role, schema)).rejects.toThrow("separate runtime role");
  });

  it("rejects a role with existing migration-record access or without login capability", async () => {
    await administrator.query(`ALTER ROLE ${quote(role)} NOLOGIN`);
    await expect(grantRuntimeAccess(owner, role, schema)).rejects.toThrow("separate runtime role");
    await administrator.query(`ALTER ROLE ${quote(role)} LOGIN`);
    await owner.query(`GRANT SELECT ON schema_migrations TO ${quote(role)}`);
    await expect(grantRuntimeAccess(owner, role, schema)).rejects.toThrow("migration records");
  });

  it("rejects missing roles and rolls all grants back when an application table is missing", async () => {
    await expect(
      grantRuntimeAccess(owner, `missing_${randomUUID().replaceAll("-", "")}`, schema),
    ).rejects.toThrow("already exist");
    await owner.query("DROP TABLE app_rate_limits");
    await expect(grantRuntimeAccess(owner, role, schema)).rejects.toMatchObject({ code: "42P01" });
    const privileges = await owner.query<{ schema_usage: boolean; table_select: boolean }>(
      "SELECT has_schema_privilege($1,$2,'USAGE') AS schema_usage, has_table_privilege($1,$3,'SELECT') AS table_select",
      [role, schema, `${schema}.matches`],
    );
    expect(privileges.rows[0]).toEqual({ schema_usage: false, table_select: false });
  });
});
