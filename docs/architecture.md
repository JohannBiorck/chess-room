# Architecture

Chess Room is a modular application with React, Fastify and PostgreSQL.
Standard chess and Three-check share one match service. Browsers render public
state and submit actions; the server owns moves, revisions, clocks and results.

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
the current adapters share standard movement and customize adjudication.

## Commands

1. Validate the bounded command and authenticated guest cookie.
2. Lock the match and revalidate the session and player seat.
3. Find an existing receipt before checking the expected revision.
4. Adjudicate any expired clock, check revision and apply the action.
5. Commit state, action/result event, revision, receipt and outbox together.
6. Acknowledge the committed projection.

Accepted retries return their original acknowledgement. Reusing a UUID with
different data fails. Rejected commands do not consume the UUID. Clients ignore
older revisions and retry uncertain requests with the same command identifier.
Commands use HTTP; authorized Socket.IO subscriptions distribute snapshots.
See [Socket.IO delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/).

## Multiple instances and recovery

Socket.IO uses WebSocket transport only. A subscription validates guest expiry
and membership and returns a complete snapshot. Each process checks its
subscribed games' durable revisions every 250 milliseconds and broadcasts
newer committed projections. Reconnection resubscribes and replaces the
snapshot, so missed individual broadcasts cannot lose an accepted move.

The outbox is drained in bounded batches after commit. Revision polling is the
shared fanout and recovery source. Outbox completion does not prove a browser
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

Rematches create a separate match and swap colors. Waiting rooms expire after
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
tokens, cookies, URLs and display names. Aggregate diagnostics stay local.
See [operations](operations.md) and [performance](performance.md).
