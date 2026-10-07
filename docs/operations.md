# Operations

The [live application](https://chess-room-c09w.onrender.com) runs on one Render
Free web service with Neon PostgreSQL in Frankfurt. See
[hosting](hosting.md) for the free-plan configuration and limits. This runbook
covers startup, access controls and recovery.

## Start and verify

Install the pinned Node/npm versions, configure a local `.env`, start
PostgreSQL, then run:

```sh
npm ci
npm run db:migrate
npm run verify
npm run dev
```

`GET /api/health` reports process liveness. `GET /api/ready` checks database
connectivity and the matches table; route traffic only to ready instances.
Standard startup fails when the database is unavailable or migrations are absent.
Migrations are explicit, ordered, transactional and checksum checked. Do not
edit an applied migration. `MIGRATION_DATABASE_URL` can supply a separate
migration credential; otherwise the migration command uses `DATABASE_URL`.

`npm run start:hosted` requires both connection URLs. It applies migrations with
the database/schema owner, validates a separate restricted runtime role, and
grants only the application tables and outbox sequence permissions. Privileged
roles, role memberships, schema/database/object ownership, DDL rights and access
to migration records are rejected for the runtime role. The owner connection
closes before normal request handling; its URL is removed from the running
process environment. Use the restricted `DATABASE_URL` for application traffic.

Local integration tests require `ADMIN_DATABASE_URL` in addition to the local
owner/application URL. This administrator creates disposable role fixtures;
it is not a runtime or hosted-service credential. Use the placeholders in
`.env.example` with a disposable local database. CI supplies separate local
application and administrator credentials for the same checks.

The Compose recipe gives the application a non-superuser database login.
For production, use separate migration and application roles and grant only
the application's required table/sequence operations. Protect connection
credentials, restrict PostgreSQL network access, and use authenticated TLS
when the database is reached across an untrusted network.

## HTTPS, origin and proxy configuration

Set `NODE_ENV=production` and `WEB_ORIGIN` to the exact HTTPS browser origin,
for example `https://chess.example`. A path, wildcard or HTTP production origin
is rejected. Serve the built browser and API from the same origin; set
`SERVE_WEB=true` when using the backend's static-file serving.
On Render, `RENDER_EXTERNAL_URL` supplies the origin when `WEB_ORIGIN` is absent.
The service binds to `0.0.0.0` using Render's supplied `PORT`; the Blueprint
uses `/api/health` for platform checks so probes do not wake an idle database.

The HTTPS configuration uses a Secure, HttpOnly, SameSite cookie with the
`__Host-` prefix and no Domain attribute. Guest identity is stored in that
cookie. Losing it or reaching the fixed 30-day expiry loses access to the old
seat; display names do not restore authorization. Invitation tokens are
redeemed from the URL fragment and expire within 24 hours, or sooner when the
host session or waiting room expires. Keep request bodies,
cookies, invitation fragments and database backups out of access logs.

Place the backend behind a reverse proxy that terminates HTTPS, forwards
`/api/` and `/socket.io/`, and supports HTTP/1.1 WebSocket upgrades. Pass the
original `Host`, `Origin` and forwarding headers. Set a proxy read timeout
longer than Socket.IO's heartbeat interval plus timeout. See the official
[Socket.IO reverse-proxy guidance](https://socket.io/docs/v4/reverse-proxy/).

`TRUST_PROXY` accepts only explicit proxy IP addresses or CIDR ranges, separated
by commas. Leave it empty for direct local access. Trust only the proxy network
you control, block direct public access to backend ports, and prevent clients
from injecting forwarding headers. Otherwise per-IP limits may either group
all clients under a proxy address or trust attacker-chosen addresses.

Socket transport is WebSocket only, with no polling fallback. Multiple backend
instances share PostgreSQL and independently synchronize their local subscribed
rooms by committed revision. They do not require sticky sessions for polling.
Configure the same browser origin and database on every instance. PostgreSQL
locking serializes mutations; process-local socket IDs are not player identity.

## Shutdown, clocks and diagnostics

Send SIGTERM for a graceful shutdown. The process stops its workers, closes
socket connections and HTTP handling, waits for in-flight background work,
and drains the database pool. Let the process finish before force termination.
Players reconnect and request a current snapshot from a surviving or restarted
instance. A committed command with a lost response can be retried with its
original identifier and payload.

Timed games continue through disconnection and server downtime. Persisted
deadlines are reevaluated on startup and by the background worker; PostgreSQL
time is read after acquiring the match lock. Keep the database host's clock
synchronized. The service does not pause clocks automatically during an outage.
The exact draw and timeout policies are documented in [rules](rules.md).

The background scheduler polls revisions at 250 ms only while game subscribers
are connected. Without subscribers it waits for the nearest durable clock
deadline or cleanup deadline, with an hourly upper bound. Mutations and
subscription changes wake it immediately. Idle database connections expire
through the pool's idle timeout, allowing a serverless database to suspend
between scheduled work. Closing unused game tabs avoids retaining active
subscriptions; continuous activity still consumes the provider's free quota.

Structured logs use request identifiers and safe error codes. Runtime summaries
include request duration, event-loop delay, fanout delay, active sockets and
database-pool state. They are written to server logs; a hosting platform may
retain those logs. No external reporting integration is configured. Monitor
readiness failures, worker failures, pool wait, lock timeouts, disk space and retained row counts before
operating the service for others. [Performance](performance.md) records the
measured local baseline and its limits.

## Retention

The background worker performs bounded cleanup at startup and approximately
hourly:

| Material | Eligibility | Maximum per cleanup batch |
| --- | --- | ---: |
| Waiting rooms | More than 24 hours since creation | Combined 100 rooms/games |
| Finished games | More than 30 days since last update | Combined 100 rooms/games |
| Expired sessions | No remaining seat, consumed invitation or receipt reference | 100 |
| Rate-limit keys | Window older than 24 hours | 1,000 |

Deleting a game also removes its seats, invitations, receipts, events and
outbox rows through database constraints. Rotating an invitation does not
extend a waiting room's lifetime. Cleanup is bounded and can lag behind a
large backlog; monitor counts and tune scheduling from measured demand.
Active games are preserved while either participant has a valid session. When
both sessions expire, a bounded worker pass locks and finishes the game as an
abandoned draw with reason `session-expired`. It then follows the finished-game
retention period. Export a game's PGN before its retention period ends when a
permanent record is wanted.

## Backup and restore

Backups contain display names, session hashes and match history. Restrict access
and store them outside the source tree. Choose a destination and retention
policy deliberately. Use a PostgreSQL client compatible with the server and
provide credentials through a protected password file or secure environment,
rather than including a password in command arguments.

With `PGHOST`, `PGPORT`, `PGUSER` and `PGDATABASE` set for the intended database:

```sh
pg_dump --format=custom --no-owner --no-privileges --file=chess-room.dump
pg_restore --list chess-room.dump
```

Restore first into a separately created empty database. Set `PGDATABASE` to
that restore database, then run:

```sh
pg_restore --no-owner --no-privileges --exit-on-error --dbname=chess_room_restore chess-room.dump
```

Reapply the intended roles and grants, run migration checksum verification,
and confirm readiness. Check session and seat relationships, revisions,
accepted move replay, lifecycle/clocks, receipts and event/outbox rows. Start
an isolated application instance against the restored database and verify a
synthetic game's position and retry behavior before selecting it as a recovery
source. Never restore over a live database as a test. See the PostgreSQL
[pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html) and
[pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html)
documentation for archive behavior and restore permissions.

A local restore drill on 2026-10-05 used an isolated schema with synthetic
players, one joined game and one accepted move. A custom-format schema dump
was restored after removing only that isolated schema. Verification retained
the exact position and revision 2, three events and one command receipt. The
isolated schema was then removed. This demonstrates logical restore of the
application data; it does not measure recovery time or provide point-in-time
recovery. Plan WAL archiving and recovery drills separately if that recovery
objective is required.

Before changing schema or rules versions, take a verified backup and test both
the migration and recovery path. Prefer a forward repair migration for a
deployed schema. Rolling back application code is safe only while it still
understands the stored schema and immutable game rules versions.
