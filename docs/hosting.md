# Free hosting configuration

The prepared deployment uses one Render Free web service and one Neon Free
PostgreSQL project, both in Frankfurt. The web service serves the built browser,
API and WebSocket transport from one HTTPS origin. `render.yaml` declares the
service; it contains no database credentials or database resource that expires
after a trial period.

## Keep the deployment at zero cost

Use a Render Hobby workspace with the service's compute plan set to **Free**,
and a Neon organization on **Free**. Keep both accounts without a payment
method. Do not select a trial, paid workspace, paid compute plan, paid database,
paid add-on or purchased domain. Use the supplied `onrender.com` address.
Verify the plan and billing state in each dashboard before creating resources.

As checked on 2026-10-07, Render's free compute is 0.1 CPU with 512 MB memory.
Its workspace allowance is 750 running hours per month. The current Hobby
workspace includes 5 GB outbound bandwidth and 500 build minutes per month.
Without a payment method, exhausting bandwidth pauses free services; exhausting
build minutes stops new builds. With a payment method, overages can incur
charges. [Free-service limits](https://render.com/docs/free),
[compute plans](https://render.com/docs/compute-plans),
[current workspace allowances](https://render.com/docs/new-workspace-plans).

Neon's Free plan is permanent and does not require a card. A project currently
includes 100 CU-hours per month, 1 GB database storage and 5 GB monthly egress.
Exhausting compute or egress suspends compute until the next billing period;
exhausting storage blocks writes. These limits do not delete the stored data.
Use an ordinary project in a signed-in account, rather than an unclaimed
temporary database. See [Neon pricing](https://neon.com/pricing).

Free hosting provides bounded availability. Render may restart the service,
and sleeps it after 15 minutes without incoming HTTP traffic or WebSocket
messages; a cold start takes approximately a minute. Connected WebSocket
traffic counts as activity. Neon compute suspends after five idle minutes.
At 0.25 CU, its allowance covers 400 active hours per month, so continuous
database polling can exhaust the free quota even when nobody is playing.
Avoid uptime pings and unnecessary background database queries. Use
`/api/health`, which does not query PostgreSQL, for Render's health check.
[Render behavior](https://render.com/docs/free),
[Neon compute allowances](https://neon.com/docs/introduction/plans),
[Neon scale to zero](https://neon.com/docs/introduction/scale-to-zero).

Clocks continue while the service is unavailable. A returning server reconciles
stored deadlines. Untimed games provide the best experience when availability
is limited by a free plan. Data persists in Neon; Render's local filesystem is
ephemeral. The local performance baseline is not a capacity measurement for
Render's smaller compute allocation.

## Database setup

Create a fresh Neon project with PostgreSQL 18 in AWS Europe Frankfurt
(`aws-eu-central-1`). Run the repository's migrations on this fresh database;
do not upload a local development database or local environment file.
PostgreSQL 18 is the default for new projects, with current minor releases
managed by Neon. [Regions](https://neon.com/docs/introduction/regions),
[PostgreSQL version support](https://neon.com/docs/postgresql/postgres-version-support).

Use two credentials:

| Render secret | Purpose |
| --- | --- |
| `MIGRATION_DATABASE_URL` | Direct connection using the database/schema owner for startup migrations |
| `DATABASE_URL` | Pooled connection using a separate application role for runtime queries |

Create the application role using **SQL**, with login enabled and no superuser,
database-creation, role-creation, replication or row-security-bypass privileges.
Do not create it through Neon's role UI/API: those roles automatically inherit
`neon_superuser`. The runtime role must not own the database or schema, or
inherit the owner role. Grant database connection, schema usage, the required
SELECT/INSERT/UPDATE/DELETE privileges on the eight application tables, and
USAGE on the outbox sequence. Keep migration metadata and DDL privileges with
the owner. Apply equivalent grants when future migrations introduce objects.
See [Neon roles](https://neon.com/docs/manage/roles).

Require certificate-verified TLS for both connection strings, such as
`sslmode=verify-full`. Never disable certificate verification. Neon's pooled
endpoint uses transaction pooling; application transactions and transaction-local
settings remain grouped together. Use a direct endpoint for migrations and
backup/restore tools. Store credentials only as service secrets.
[Secure connections](https://neon.com/docs/connect/connect-securely),
[connection pooling](https://neon.com/docs/connect/connection-pooling).

## Service setup and updates

Create the service from the sanitized repository and review the Blueprint's
single Free service before approving resource creation. It pins Node 24.21.0,
installs build dependencies even in production, builds all workspaces, and
starts using `npm run start:hosted`. Supply the two secrets when Render prompts.
The hosted start command applies migrations before starting the server.

Render supplies `PORT`, normally 10000. The service listens on `0.0.0.0` and
uses the same port for HTTP and WebSockets. Its external HTTPS URL supplies
the exact allowed browser origin; an explicit `WEB_ORIGIN` can override it.
Production cookies are Secure, HttpOnly and scoped to the host. Render
terminates TLS before forwarding to the process. See
[Render web services](https://render.com/docs/web-services) and
[Blueprint fields](https://render.com/docs/blueprint-spec).

Automatic deploys are disabled. A Git push updates source without deploying
it; review the change and trigger a manual deployment when ready. Review
runtime logs for readiness, worker failures, resource limits and migration
errors. Keep proxy trust restricted to verified infrastructure rather than
accepting arbitrary forwarded client addresses.

After deployment, verify HTTPS, two independent guest sessions, invitation
redemption, legal play over WebSockets, reconnection and refresh. Check database
replay and role restrictions, then confirm the dashboards still show only Free
resources and no payment method. Record private deployment credentials and
operational evidence outside public source files. See
[operations](operations.md) for retention, shutdown and backup procedures.
