# Architecture

Cat Chess is a modular application with React, Fastify and PostgreSQL.
Cat Chess, Chaos Cat, Standard chess and Three-check share one match service. Browsers render
public state and submit actions; the server owns moves, revisions, clocks,
random cat decisions and results.

Optional passkey accounts map rotating login credentials onto stable player
identities. Legacy guest UUIDs and receipt ownership remain unchanged when a
guest is explicitly claimed. Completed games have private, versioned archives
independent of operational match retention.

Rooms are private by default. Hosts can explicitly choose an open room for
public discovery. Full game state remains available only to the two seated
guests, including for open rooms.

## Boundaries

| Module | Responsibility |
| --- | --- |
| packages/contracts | Strict runtime schemas and versioned public protocol |
| packages/game-core | Pure transitions, legal moves, replay, adjudication and PGN |
| apps/server/src/application | Authorization, invitations, lifecycle, clocks and transport |
| apps/server/src/storage | SQL transactions, migrations, events and receipts |
| apps/web | Accessible board, lobby, controls and reconnect recovery |

Rules IDs and versions are immutable per match. Durable engine state retains
the initial position and accepted moves, preserving repetition on restart.
Compatibility fixtures protect saved games. Future modes with different boards
or movement can introduce another engine behind the application boundary;
the current adapters share standard movement and customize adjudication or
post-move board effects.

Cat Chess stores each player's signed chance and a server-generated random draw
alongside each accepted move. The rules engine derives the cat effect from that
draw, checks king safety and verifies the stored effect when replaying a game.
Replay and reconnects therefore reproduce the same board without rerolling.
Cat changes are part of a turn and happen before its final adjudication.
Standard and Three-check retain their original public message shape. Cat Chess
snapshots additionally carry the signed settings and one cat effect per move.

Chaos Cat uses its own immutable `chaos-cat` rules ID and version. It stores
one random draw and effect per move, with an explicit non-king piece type and
no adjustable chance settings. Independent weighted draws select giving or
stealing, piece type and a uniform eligible square. A missing chosen piece
does not reroll the type. Chaos effects can expose kings; the public projection
identifies threatened kings without duplicating attack logic in the browser.
Capturing a king ends the game before any further cat effect or ordinary draw
adjudication. Replay reconstructs and verifies the same terminal board.

The original `catchess` ID, signed settings, random derivation and pawn effect
shape remain unchanged so existing games and receipts recover correctly.

## Commands

1. Validate the bounded command and authenticated guest/account cookie.
2. Lock the match and revalidate the session and player seat.
3. Find an existing receipt before checking the expected revision.
4. Adjudicate any expired clock, check revision and apply the action.
5. Commit state, action/result event, revision, receipt and outbox together.
6. Publish the committed projection to authorized local sockets and acknowledge it.

Accepted retries return their original acknowledgement. Reusing a UUID with
different data fails. Rejected commands do not consume the UUID. Clients ignore
older revisions and retry uncertain requests with the same command identifier.
Commands use HTTP; authorized Socket.IO subscriptions distribute snapshots.
See [Socket.IO delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/).

Cat-mode entropy is generated inside the locked move execution after the
receipt, authorization, revision and turn checks. Its move, cat effect and
receipt commit atomically. Clients cannot choose the draw or a target square;
they animate the committed effect received in the public snapshot.

A legal move updates the acting player's board immediately using the server's
current legal destinations. This temporary display handles captures, castling,
en passant and promotion; it does not predict random effects, history, clocks,
turn changes or outcomes. Further input waits for confirmation. A newer
committed revision replaces the preview, and rejection restores the confirmed
board. A lost HTTP acknowledgement cannot undo a socket-confirmed move.

Both players animate newly committed cat effects from live socket updates,
command acknowledgements or connected recovery refreshes. Revision and ply
checks prevent repeats when those paths race. Initial and reconnect snapshots
restore history without replaying old visits; reduced motion remains respected.

Display names belong to guest profiles rather than match revisions. Renaming
keeps the same authenticated session, expiry and seats. A separate validated
`game:players` event updates names without changing the board or clock anchor.
Clients preserve current names when old move receipts or in-flight snapshots
arrive. Subscription snapshots and profile polling recover missed changes.

`GET /api/lobbies` returns at most 50 waiting open rooms with a valid host,
newest first. Summaries contain only the room ID, host name/color, mode, time
control, cat settings and room expiry. Private rooms, invitations, session
identifiers and boards are excluded. A partial index supports this query.
The lobby refreshes every ten seconds while visible and also supports manual
refresh; entering a game stops discovery polling.

Public joins authenticate the guest and lock the match. They recheck room,
host and guest expiry after capacity locks, fill the single available seat,
consume outstanding invitations and start the clock in one transaction.
Concurrent public and invitation joins therefore have one winner; retrying
an accepted public join returns the same seat. Only open games add a visibility
field to the existing public game message.

The sole seated host can close a waiting room through the existing command
protocol. Closing and joining share the match lock: whichever commits first
decides whether the room closes or the game starts. Accepted close retries use
the original receipt. A closed room uses the terminal storage state with an
explicit `closure` reason and timestamp, no chess outcome and no played moves.
Its invitations are expired, it frees room capacity, and it cannot create a
rematch or export a chess result. Ordinary game messages omit `closure`.

## Multiple instances and recovery

Socket.IO uses WebSocket transport only. A subscription validates guest expiry
and membership and returns a complete snapshot. Accepted HTTP commands and
joins immediately publish their committed projection to local subscribers,
without an extra database read. A shared revision guard prevents retries or
slower polling projections from delivering an older update. Each process checks its
subscribed games' durable revisions every 250 milliseconds and broadcasts
newer committed projections. Reconnection resubscribes and replaces the
snapshot, so missed individual broadcasts cannot lose an accepted move.

The same bounded polling batches also read player profiles and publish changed
names across instances without replaying game history. Profile generations
and match revisions prevent an older query from replacing a newer local name
change or removing a newly joined player.

Polling runs while a process has game subscribers. Otherwise an idle-aware
scheduler waits for the nearest durable game deadline or hourly cleanup,
and wakes on mutations or subscription changes. Each process performs one
worker cycle at a time. This preserves timeout processing without querying
an unused serverless database four times per second.

The outbox is drained in bounded batches after commit. Revision polling is the
cross-instance fanout and recovery source. Outbox completion does not prove a browser
received a message. PostgreSQL holds shared request counters and match locks.
Redis is not required at the measured scale. WebSocket-only transport avoids
polling's sticky-session requirement but requires WebSocket support.
See [multiple-node guidance](https://socket.io/docs/v4/using-multiple-nodes/).

## Time and lifecycle

Database time is read after the match lock. Remaining time and the turn
deadline are durable; no per-second writes are needed. A move deducts elapsed
time and adds increment. A bounded worker finishes overdue games without
clients. A move at or after its deadline loses to timeout. Clocks continue
through disconnection and restart.

Rematches create a separate match and swap colors. Cat Chess chances follow the
players to their new colors. Open waiting rooms close after one hour and private
waiting rooms after 24 hours; the host's session expiry can close either sooner.
The same deadline controls discovery, invitations, capacity, joins and recovery.
Join paths recheck it after acquiring capacity locks. The idle scheduler includes
waiting-room deadlines alongside active clocks, with bounded worker batches and
startup recovery. Discovery and joins reject expired rooms even while physical
closure processing is catching up after server sleep.

Finished games and closed rooms are removed after 30 days by hourly bounded cleanup.
Histories are bounded at 1,200 plies.

## Accounts and history

`players` retains each original participant ID; seats and accepted receipts keep
their existing identifiers. `account_sessions` stores only random-token hashes,
with absolute/idle expiry, rotation and revocation. Account ownership can include
explicitly imported guest identities. Names do not authorize access.

SimpleWebAuthn verifies purpose-bound, expiring, single-use server challenges
against the exact game origin and RP hostname. Passkey public keys, counters and
backup semantics are stored in PostgreSQL. Recovery codes create a restricted
session that must register a replacement passkey before accessing games/history.
There is no email or external authentication-provider integration.

Finishing a played account game archives its original rules/version, engine
record, outcome and finishing names atomically. Account history associations
authorize list/detail/export independently for each participant. Public replay
DTOs contain recorded positions/effects, never server draws, internal identities
or credentials. History is bounded at 500 games per account/up to 365 days;
operational cleanup cannot erase a required archive. Deletion removes the user's
associations and anonymizes results retained by opponents.

Admission serializes within the application schema and measures table/index/TOAST
sizes with conservative base overhead. Reservations cover remaining receipts,
events and archive growth for all games. Compressed receipts reproduce exact
accepted acknowledgements, including legacy JSON receipts. The application has
an 800 MiB storage allocation and retains headroom within the existing Free
database. A game is limited to 1,500 accepted operations as well as 1,200 plies.

## Browser bot and presentation

Bot games have an explicit bot participant with no usable bearer credential,
a real human controller seat, frozen algorithm/profile and a durable per-turn
ticket in match lifecycle state. Only the controller can submit that pending
bot turn. Revision/ticket/payload-hash checks and receipts prevent duplicate
commits or cat rerolls. The bot cannot join public rooms. Untimed bot games
pause computation when their owning browser is hidden; search is never run by
the web server.

`packages/game-core/search` exposes Node-free compact positions and shared
legality, mutation and adjudication primitives. The browser Worker uses bounded
iterative search, capture continuations and weighted chance branches. It cannot
choose the server's next draw. Every suggested root move is checked against the
authoritative legal destinations. Strength is measured locally without a public
Elo claim; browser-controlled opponents are casual, not rated authorities.

Presentation events are derived at the confirmed-view boundary, with game/ply
identities and explicit live/recovery handling. Immediate own-move previews are
confirmed without a second slide. Native overlays cannot intercept board input.
One bounded Web Audio service generates original cues only after activation;
sound scheduling is independent of reduced motion. Visibility, identity changes,
newer states and unmount cancel stale work. History replay stays read-only and
silent by default.

## Security

Guest and invitation tokens have 256 random bits and are stored as hashes.
Cookies are HttpOnly and SameSite=Lax, with Secure and the __Host- prefix for
HTTPS. Invitations use fragments redeemed by POST. Exact-origin checks protect
mutations and handshakes; a match ID does not authorize access. Strict schemas
bound input and React renders names as text. Custom modes are trusted code.

Payload, request, connection and room limits bound resources. Proxy forwarding
is trusted only for configured IP addresses or CIDRs. Logs exclude payloads,
tokens, cookies, URLs and display names. Aggregate diagnostics go to server logs.
See [operations](operations.md) and [performance](performance.md).

## Hosted startup

The [Free deployment](https://chess-room-c09w.onrender.com) serves browser
assets, API and sockets from one Render HTTPS origin, with durable PostgreSQL
18 in Neon. The database uses fixed 0.25 CU compute with idle suspension.
The normal server requires an already migrated schema. `start:hosted` instead
uses a separate owner connection to apply checksum-verified migrations and
grant the runtime role its required table/sequence permissions. It rejects
elevated or owning runtime roles, closes the owner pool, removes the migration
URL from its process environment, and starts using the restricted application
connection. The Render Blueprint disables automatic deployment and has no
stored secrets. See [hosting](hosting.md).

Migration `002_open_rooms.sql` adds only the waiting-open-room index. It does
not rewrite games or alter the original migration.
