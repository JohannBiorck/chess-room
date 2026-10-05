# Chess Room

A website for playing chess with friends, designed to support additional
curated game modes over time.

**Status: development foundation.** The browser setup page and API liveness
endpoint work. Chess gameplay, invitations, sessions, realtime connections,
database persistence and clocks are not implemented yet.

## Requirements

- Node.js 24.21.0 (24 LTS), npm 11.19.0. Versions are recorded in `.node-version`
  and `package.json`; use a Node version manager or the official distribution.
- PostgreSQL 18.6 for future persistence work. Docker with Compose v2 is one
  supported local development recipe. The current web/API scaffold runs
  independently of the database.

## Start locally

From the repository root:

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. The setup page checks the real API through Vite's
proxy. The API also responds at <http://127.0.0.1:3001/api/health> with
`{"status":"ok"}`. This endpoint reports process liveness only.

Both services bind to localhost by default. Stop them with Ctrl+C. To run
either service separately, use `npm run dev:web` or `npm run dev:server`.
Ports are fixed at 5173 and 3001; the web proxy expects the API at port 3001.

## Local database

Create a local `.env` from `.env.example`. Choose a development database
password and update both `POSTGRES_PASSWORD` and the password in `DATABASE_URL`.
Use a URL-safe password or percent-encode its characters in the URL.

On PowerShell:

```powershell
Copy-Item .env.example .env
```

On Linux/macOS:

```sh
cp .env.example .env
```

After editing `.env`:

```sh
npm run db:up
npm run db:check
npm run db:down
```

The database is exposed only at `127.0.0.1:5433` and data remains in the named
volume when stopped. Changing `.env` does not change the credentials of an
already initialized database. Do not remove the volume to fix a password
unless its data is deliberately disposable.

The Compose role is for local development. Production persistence will use
separate migration and application roles with narrower privileges. The current
API does not consume `DATABASE_URL` or create tables.

## Checks and build

| Task | Command |
| --- | --- |
| Format and apply safe lint fixes | `npm run format` |
| Check formatting and lint | `npm run lint` |
| Strict type checking | `npm run typecheck` |
| Run server boundary tests | `npm test` |
| Watch tests | `npm run test:watch` |
| Build client and server | `npm run build` |
| Run required checks | `npm run verify` |

CI runs the same verification on Windows and Linux and checks the PostgreSQL
Compose recipe on Linux. It contains no deployment or reporting steps.
Dependency versions are locked; install lifecycle scripts and automatic audit
requests are disabled in `.npmrc`.

The web build is in `apps/web/dist`; compiled server files are in
`apps/server/dist`. After building, start the server with:

```sh
npm run start --workspace @chess-room/server
```

Serving production assets and deploying the application are future work.

## Structure

```text
apps/web/       React browser client and Vite configuration
apps/server/    Fastify process, configuration and liveness endpoint
scripts/        Development process coordination
docs/           Product architecture
compose.yaml    Local PostgreSQL recipe
```

The intended design keeps authoritative match decisions on the server and
separates rules from transport and storage. Each future match will retain a
ruleset ID/version, allowing new modes to coexist with existing matches.
See [architecture](docs/architecture.md) for the current boundaries and direction.

No production capacity has been measured. No project license has been selected.
