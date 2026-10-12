# Chess Room

Play chess in your browser. Choose Standard chess, Three-check or Catchess,
then create a private invitation room or an open room that other visitors
can join. Players use display names without accounts.

Use the name button in the header to change your display name in the lobby
or during a game. Your browser session and seat stay the same. Open rooms
show the host's name, game mode, clock and cat settings on the home page;
the first visitor to join takes the available seat. Private rooms are the
default and never appear in that list.

Hosts can close a waiting room using **Close room**, with a confirmation before
its invitation and open seat become unavailable. An open room closes after one
hour without an opponent. Games that have already started continue normally.

In Catchess, each player has their own cat. Adjust each cat's slider in the
lobby: a positive percentage can add a pawn on that player's half of the board;
a negative percentage can remove one of their pawns. The cat acts after its
player moves, with an animation and an entry in the move history.

The server validates every move and stores games in PostgreSQL. Refreshing or
reconnecting restores the board, history, result and clock. Supported controls
are untimed, 5+0, 10+5 and 15+10. Players can resign, offer or claim a draw,
rematch with colors swapped, and download PGN.

Legal moves appear immediately on your board while the server confirms them.
Confirmed moves and cat visits are shared with both players; a rejected move
restores the saved position.

[Play Chess Room online](https://chess-room-c09w.onrender.com). The free service
can take approximately a minute to wake after inactivity. Read
[hosting limits](docs/hosting.md) before starting a timed game.

## Run locally

Requirements: Node.js 24.21.0, npm 11.19.0, and PostgreSQL 18.6. Docker with
Compose v2 supplies the database recipe. An existing PostgreSQL installation
with an ordinary database-owning application role also works.

Install with `npm ci`. Copy `.env.example` to `.env`, choose separate
application and administrator passwords, and put the application password in
`DATABASE_URL`. Set the matching administrator URL in `ADMIN_DATABASE_URL` for
integration tests. Percent-encode URL special characters in passwords.

```sh
npm run db:up
npm run db:migrate
npm run dev
```

Open [Chess Room locally](http://127.0.0.1:5173). Create a room and open its
invitation in another browser or an incognito window for the second player.
Alternatively, create an open room and join it from the second browser's
home page.
Development binds to localhost. A link containing 127.0.0.1 works only on the
same computer; internet play needs an HTTPS host and WebSocket routing.
See [operations](docs/operations.md) for configuration and
[free hosting](docs/hosting.md) for the Render/Neon deployment.

Keep the guest cookie to return to your seat. Losing it loses access; a guest
name cannot recover it. Sessions last 30 days. Open waiting rooms expire after
one hour and private waiting rooms after 24 hours, or sooner when the host
session expires. Invitations share their room's deadline; rotating a link does
not extend it. Finished games and closed rooms are retained for 30 days. Timed
games continue during disconnection and server downtime. Read the exact
[rules and adjudication policy](docs/rules.md).

Stop development with Ctrl+C. `npm run db:down` preserves the database volume.
Changing environment passwords does not update an initialized database.
Do not delete its volume to resolve a credential mismatch.

## Verify

| Command | Purpose |
| --- | --- |
| `npm run format` | Formatting and safe lint fixes |
| `npm run verify` | Lint, strict types, unit tests and production builds |
| `npm run test:integration` | Real PostgreSQL, concurrency, lifecycle, HTTP and sockets |
| `npx playwright install chromium` | Download the browser for end-to-end tests |
| `npm run test:e2e` | Two-player browser flows, mobile and keyboard checks |
| `npm run verify:full` | All verification; requires PostgreSQL and a browser |
| `npm run benchmark` | Bounded local synthetic load; see performance instructions |

Integration tests require `DATABASE_URL` and `ADMIN_DATABASE_URL` for a
disposable local database. They create and remove isolated schemas and roles
to verify runtime permissions. Use local test credentials, never production
connections. Browser tests create synthetic application games.
On Windows, set `PLAYWRIGHT_CHANNEL=msedge` to use installed Edge.

CI verifies Windows and Linux builds, PostgreSQL role privileges, integration
tests and Chromium browser flows. It has no deployment or external reporting
steps. Dependencies are pinned and install scripts are disabled.

## Built application

```sh
npm run build
npm run start
```

Set `SERVE_WEB=true` to serve the built browser assets from the backend, and
`WEB_ORIGIN` to their exact browser origin. Production requires HTTPS and uses
Secure HttpOnly cookies. `/api/health` reports process liveness;
`/api/ready` verifies database/schema availability.

For hosted startup, use `npm run start:hosted` with a separate owner credential
in `MIGRATION_DATABASE_URL` and a restricted application credential in
`DATABASE_URL`. Startup applies migrations, validates the runtime role and
grants its required table/sequence permissions, then closes the owner connection
before serving requests. On Render, the browser origin defaults to
`RENDER_EXTERNAL_URL` unless `WEB_ORIGIN` is set explicitly. See
[hosting setup](docs/hosting.md) for the Free service and database settings.

## Design

| Path | Responsibility |
| --- | --- |
| apps/web | React interface and realtime recovery |
| apps/server | HTTP/socket boundaries, match services and PostgreSQL |
| packages/contracts | Validated public protocol |
| packages/game-core | Deterministic versioned rules adapters |
| infra/database | Ordinary development database role initialization |

Transactions serialize competing actions; receipts make accepted retries
idempotent. Curated rules adapters remain independent of sessions, transport
and storage. See [architecture](docs/architecture.md),
[operations](docs/operations.md), and [measured performance](docs/performance.md).

Current scope excludes accounts, automatic matchmaking, ratings, spectators, chat and
executable custom scripts. No project license has been selected. See
[dependency notices](THIRD_PARTY_NOTICES.md).
