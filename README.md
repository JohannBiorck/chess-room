# Cat Chess

Play chess with mischievous cats in your browser. Cat Chess is the default
mode, with a helpful or evil pawn cat for each player. Try Chaos Cat for
unpredictable gifts and thefts, or choose Standard chess or Three-check.
Create a private invitation room or an open room that other visitors can join.
Play immediately as a guest, or create a free passkey account to keep your
seats and private match history across devices. No email or payment card is required.

## Accounts and saved games

Use **Sign in** to create an account with a passkey. You can explicitly import
this browser's eligible guest games. Existing-account login does not silently
import games on a shared computer. Save the recovery kit: its codes work once,
and there is no email reset. You can add a second passkey, sign out devices and
delete your account through **Account & history**.
Up to 16 browser sessions are kept; a further sign-in signs out the oldest.

History retains your latest 500 completed games for up to 365 days. It is
private to the participating accounts and includes friends and casual bot games.
Filter results, replay actual moves and cat effects, or download PGN/replay JSON.
PGN annotations describe cat actions; ordinary chess tools may not reproduce them.
Account deletion revokes login access and anonymizes results retained by opponents.

## Play the cat

Choose **Play the cat** in the lobby for a private, untimed game in any of the
four modes. Balanced and Strong profiles bound thinking time on your device;
smaller devices use a lighter budget. Cat Bot uses variant-aware search in a
lazy browser Worker, with shared legal transitions and weighted cat outcomes.
The server still validates every move and generates all real cat randomness.
No remote engine, paid API or server search process is used.

You can resume one unfinished bot game and rematch with colors swapped.
Hiding or closing the tab pauses search; returning resumes the saved turn.
These are casual games without ratings. A lighter legal fallback is explicitly
reported if the Worker cannot run. No published Elo or Stockfish-level strength
is claimed.

## Sound and movement

Chess moves, captures, castling, promotions and cat actions have short animations.
Sound starts off; enable original move and cat cues under **Sound & motion**.
Volume and motion can be adjusted separately, and device reduced-motion settings
are respected. Refresh/reconnect does not play missed sound effects. Account
volume/motion settings can sync; sound activation remains a device gesture.
No sound CDN, audio service or background music is used.

Use the name button in the header to change your display name in the lobby
or during a game. Your browser session and seat stay the same. Open rooms
show the host's name, game mode, clock and cat settings on the home page;
the first visitor to join takes the available seat. Private rooms are the
default and never appear in that list.

Hosts can close a waiting room using **Close room**, with a confirmation before
its invitation and open seat become unavailable. An open room closes after one
hour without an opponent. Games that have already started continue normally.

In Cat Chess, each player has their own cat. Adjust each cat's slider in the
lobby: a positive percentage can add a pawn on that player's half of the board;
a negative percentage can remove one of their pawns. The cat acts after its
player moves, with an animation and an entry in the move history.

In Chaos Cat, the cat always attempts an action after its owner's move:
50% to give a piece and 50% to steal one. Pawns have a 50% selection chance;
rooks, bishops, knights and queens each have 12.5%. A missing piece of the
chosen type means no theft; the probabilities are never reweighted. Kings
are never given or stolen. A theft can expose your king, and your opponent
wins by capturing it. Both players see the actual piece in the cat animation
and history. Read the complete [Chaos Cat rules](docs/rules.md#chaos-cat-version-1).

The server validates every move and stores games in PostgreSQL. Refreshing or
reconnecting restores the board, history, result and clock. Supported controls
are untimed, 5+0, 10+5 and 15+10. Players can resign, offer or claim a draw,
rematch with colors swapped, and download PGN.

Legal moves appear immediately on your board while the server confirms them.
Confirmed moves and cat visits are shared with both players; a rejected move
restores the saved position.

[Play Cat Chess online](https://catchess.onrender.com). This free shortcut
opens the existing game host, so saved seats and rooms keep working. The free service
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

Open [Cat Chess locally](http://localhost:5173). Passkeys require the localhost
origin for development, or HTTPS in production; use the matching `WEB_ORIGIN`.
Create a room and open its
invitation in another browser or an incognito window for the second player.
Alternatively, create an open room and join it from the second browser's
home page.
Development binds to loopback. A link containing localhost works only on the
same computer; internet play needs an HTTPS host and WebSocket routing.
See [operations](docs/operations.md) for configuration and
[free hosting](docs/hosting.md) for the Render/Neon deployment.

Keep the guest cookie to return to an unclaimed guest seat. Losing it loses
access; a guest name cannot recover it. Guest sessions last 30 days. Account
ownership survives login-session expiry; sign in again to return.
Open waiting rooms expire after
one hour and private waiting rooms after 24 hours, or sooner when the host
guest session expires. Account rooms retain their normal waiting-room deadline.
Invitations share their room's deadline; rotating a link does
not extend it. Operational finished games and closed rooms are retained for 30 days;
required account archives are preserved separately. Timed
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
connections. Browser tests use `TEST_DATABASE_URL` when set, otherwise
`DATABASE_URL`. The URL must address localhost, 127.0.0.1 or ::1 without query
parameters or a fragment. Each run creates and migrates a fresh disposable
schema using the ordinary local database owner, then removes only that schema
after its server stops. Existing games and prior test data are preserved. Stop
any server on port 5174 first; browser checks always start their own server.
Within that schema, each test clears its synthetic game and identity fixtures
after closing browser contexts. Genuine IP rate-limit windows are preserved;
the suites wait for those windows rather than disabling the limits.
To select a file or forward Playwright options, use
`npm run test:e2e -- tests/e2e/presentation.spec.ts --max-failures=1`.
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

Free storage is finite. Admission reserves space before starting games and may
temporarily refuse new games near capacity. Played games are bounded at 1,200
plies and 1,500 accepted commands; repeated draw offers cannot grow storage forever.

Current scope excludes automatic matchmaking, ratings, spectators, chat and
executable custom scripts. No project license has been selected. See
[dependency notices](THIRD_PARTY_NOTICES.md).
