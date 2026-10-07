import type { Pool } from "pg";

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const applicationTables = [
  "player_sessions",
  "matches",
  "match_seats",
  "invitations",
  "match_events",
  "command_receipts",
  "event_outbox",
  "app_rate_limits",
] as const;

function validateIdentifier(value: string): string {
  if (!identifierPattern.test(value)) {
    throw new Error(
      "Database role and schema identifiers must contain 1 to 63 supported characters.",
    );
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function readRuntimeRole(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Invalid protocol");
    return validateIdentifier(decodeURIComponent(url.username));
  } catch {
    // Never include a supplied connection URL or its password in diagnostics.
    throw new Error("DATABASE_URL must include a valid PostgreSQL runtime role.");
  }
}

interface RolePolicy {
  database_name: string;
  can_login: boolean;
  privileged: boolean;
  has_membership: boolean;
  owns_database: boolean;
  owns_schema: boolean;
  owns_objects: boolean;
  schema_create: boolean;
  database_create: boolean;
  is_migration_role: boolean;
  migration_access: boolean;
}

/** Run with the migration owner after every migration; the runtime never receives DDL rights. */
export async function grantRuntimeAccess(
  owner: Pool,
  runtimeRole: string,
  schema = "public",
): Promise<void> {
  validateIdentifier(runtimeRole);
  validateIdentifier(schema);
  const client = await owner.connect();
  let destroyClient = false;
  try {
    await client.query("BEGIN");
    const result = await client.query<RolePolicy>(
      `SELECT current_database() AS database_name,
        r.rolcanlogin AS can_login,
        (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS privileged,
        EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS has_membership,
        (r.oid=d.datdba) AS owns_database,
        (r.oid=n.nspowner) AS owns_schema,
        EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid AND c.relowner=r.oid) AS owns_objects,
        has_schema_privilege(r.oid,n.oid,'CREATE') AS schema_create,
        has_database_privilege(r.oid,d.oid,'CREATE') AS database_create,
        (r.rolname=current_user) AS is_migration_role,
        EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid AND c.relname='schema_migrations'
          AND has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS migration_access
       FROM pg_roles r CROSS JOIN pg_database d JOIN pg_namespace n ON n.nspname=$2
       WHERE r.rolname=$1 AND d.datname=current_database()`,
      [runtimeRole, schema],
    );
    const role = result.rows[0];
    if (!role) throw new Error("The runtime role and application schema must already exist.");
    if (
      !role.can_login ||
      role.privileged ||
      role.has_membership ||
      role.owns_database ||
      role.owns_schema ||
      role.owns_objects ||
      role.schema_create ||
      role.database_create ||
      role.is_migration_role
    ) {
      throw new Error(
        "Use a separate runtime role without ownership, elevated privileges or role memberships.",
      );
    }
    if (role.migration_access)
      throw new Error("The runtime role must not have access to migration records.");
    const quotedRole = quoteIdentifier(runtimeRole);
    const quotedSchema = quoteIdentifier(schema);
    await client.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(role.database_name)} TO ${quotedRole}`,
    );
    await client.query(`GRANT USAGE ON SCHEMA ${quotedSchema} TO ${quotedRole}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${applicationTables
        .map((table) => `${quotedSchema}.${quoteIdentifier(table)}`)
        .join(", ")} TO ${quotedRole}`,
    );
    await client.query(
      `GRANT USAGE ON SEQUENCE ${quotedSchema}."event_outbox_id_seq" TO ${quotedRole}`,
    );
    await client.query("COMMIT");
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
