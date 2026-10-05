# Architecture

Status: development foundation. Online gameplay is not implemented yet.

The workspace contains a React/Vite browser client and a Fastify backend.
They share TypeScript tooling and one dependency lockfile. The backend is one
deployable application; modules will separate transport, match orchestration,
rules and persistence as those capabilities are implemented.

## Intended game model

The server will own accepted moves, match revisions, clocks and outcomes.
Browsers submit validated actions and render public state. PostgreSQL will
persist matches and command receipts; realtime connections will distribute
committed state and recover through revisions and snapshots.

Game rules will be independent of sessions, networking and storage. Each match
will retain an immutable ruleset ID/version and validated configuration.
Standard chess comes first; additional curated modes will implement the same
boundary, with a separate engine where their rules require one.

## Current boundaries

| Path | Current responsibility |
| --- | --- |
| apps/web | Responsive setup page and real API connectivity status |
| apps/server | Validated process configuration, liveness route and shutdown |
| scripts | Local development process coordination |
| compose.yaml | Local PostgreSQL development service |

`GET /api/health` reports process liveness only. It does not certify a database,
game engine or realtime service. The current server has no game endpoints.

## Scaling approach

Begin with one backend and PostgreSQL. Keep match mutations transactional and
test concurrent commands before expanding to multiple instances. Add shared
event fanout, presence and rate limiting when measured load justifies them.
Durable game state stays in PostgreSQL, including enough history to replay
standard chess and evaluate repetition after a restart.

No production capacity or compliance claims have been measured or made.
