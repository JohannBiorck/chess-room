# Architecture

Chess Room is a modular application with React, Fastify and PostgreSQL.
Standard chess, Three-check and Catchess share one match service. Browsers render
public state and submit actions; the server owns moves, revisions, clocks,
random cat decisions and results.

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

Catchess stores each player's signed chance and a server-generated random draw
alongside each accepted move. The rules engine derives the cat effect from that
draw, checks king safety and verifies the stored effect when replaying a game.
Replay and reconnects therefore reproduce the same board without rerolling.
Cat changes are part of a turn and happen before its final adjudication.
Standard and Three-check retain their original public message shape. Catchess
snapshots additionally carry the signed settings and one cat effect per move.

## Commands

1. Validate the bounded command and authenticated guest cookie.
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

Catchess entropy is generated inside the locked move execution after the
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

## Multiple instances and recovery

Socket.IO uses WebSocket transport only. A subscription validates guest expiry
and membership and returns a complete snapshot. Accepted HTTP commands and
joins immediately publish their committed projection to local subscribers,
without an extra database read. A shared revision guard prevents retries or
slower polling projections from delivering an older update. Each process checks its
subscribed games' durable revisions every 250 milliseconds and broadcasts
newer committed projections. Reconnection resubscribes and replaces the
snapshot, so missed individual broadcasts cannot lose an accepted move.

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

Rematches create a separate match and swap colors. Catchess chances follow the
players to their new colors. Waiting rooms expire after
24 hours; finished games are removed after 30 days by hourly bounded cleanup.
Histories are bounded at 1,200 plies.

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
