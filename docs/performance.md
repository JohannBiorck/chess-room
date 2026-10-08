# Performance baseline

The current validation scenario is eight concurrent games with sixteen player
WebSocket connections. It is a small local baseline, not a production capacity
claim or a sustained-load test.

## Reproduce

Start two backend processes on ports 3001 and 3002 against the same migrated
local PostgreSQL database. Both must use `WEB_ORIGIN=http://127.0.0.1:5173`.
Use the normal development or built-server commands and set `PORT` separately
for each process.

From the repository root, after installing dependencies and building packages:

```sh
BENCHMARK_PEER_URL=http://127.0.0.1:3002 node scripts/benchmark.mjs
```

In PowerShell:

```powershell
$env:BENCHMARK_PEER_URL = 'http://127.0.0.1:3002'
node scripts/benchmark.mjs
```

The script accepts only loopback origins. `BENCHMARK_BASE_URL` defaults to
port 3001, `BENCHMARK_PEER_URL` defaults to the base URL, and
`BENCHMARK_ORIGIN` defaults to port 5173. `BENCHMARK_GAMES` accepts 1–8;
`BENCHMARK_PLIES` accepts 1–48 and defaults to 24.

Use a disposable local database with synthetic data. The script creates two
guest sessions per game, finishes its active games by resignation, and closes
all sockets. Finished records remain subject to the normal retention policy.
Leave at least one minute between runs and avoid simultaneous guest-creation
tests: the application intentionally shares its per-IP limits across instances.
The benchmark never disables those limits.

To observe PostgreSQL contention and backend memory throughout setup, play and
cleanup, run the bounded observer instead:

```powershell
$env:BENCHMARK_PEER_URL = 'http://127.0.0.1:3002'
$env:BENCHMARK_LOCK_PROBE = 'true'
node --env-file=.env scripts/benchmark-observe.mjs
```

The observer accepts only a loopback PostgreSQL URL with no override parameters.
It supplies credentials through the environment, samples only aggregate
connection/lock counts, and never prints SQL text, backend identifiers or
credentials. PostgreSQL sampling is every 250 ms; Windows backend working-set
sampling is every second. Memory sampling is currently unsupported on other
platforms. The optional lock probe requires a local role that can create a
schema. It creates and removes only its uniquely named synthetic schema and
uses two connections to verify observation of a deliberately held row lock.

## Observed run, 2026-10-05

Windows 11 build 26200, x64; Intel Core i9-13900H, twenty logical processors,
15.7 GiB system memory; Node.js 24.21.0 and native PostgreSQL 18.6. The two
backends, database and load client all ran on the same laptop using loopback.
Backend execution used development processes, so these results include their
runtime overhead.

Eight games played 24 accepted moves each: four Standard and four Three-check.
White sent commands to one backend and Black to the other. Both players had
authenticated socket subscriptions. Each game's next move waited for both
players to receive the committed revision. This deliberately measures a
complete play-and-delivery cycle rather than maximum request throughput.

| Measurement | Samples | p50 | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| HTTP command acknowledgement | 192 | 131.36 ms | 300.39 ms | 438.98 ms |
| Move start to player update | 384 | 307.08 ms | 574.49 ms | 760.01 ms |

The measured play interval was 9.810 seconds, or 19.57 accepted moves per
second. There were 243 HTTP requests including setup and cleanup, no failed
commands or cleanup failures, one verified same-command retry without a new
revision, and one verified reconnect to the current revision.

Memory observation began before guest/game setup and continued through cleanup.
Twelve one-second samples per backend observed at most 179.77 MiB for port 3001
and 168.95 MiB for port 3002. These are point-sampled working-set maxima,
including process memory retained from earlier activity. They are not true
continuous peak-memory measurements and exclude database, observer and load-client
memory.

Forty-five PostgreSQL samples across the same span observed at most sixteen
application connections. No sample contained an application connection waiting
on a PostgreSQL lock or reported blocked by another backend. Short waits can
fall between the 250 ms observations; this does not establish zero lock-wait
time or measure exact wait durations.

The separate controlled probe verified a real row-lock wait. A second
connection was observed blocked 6.99 ms after sending its update. The blocker
was held for a further 50 ms after detection, then released. The update
completed in 73.28 ms overall, including connection dispatch, waiting and result
delivery. That operation duration is not an exact PostgreSQL lock-wait duration.

The next one-minute runtime log from each backend captured these aggregates:

| Local diagnostic | Port 3001 | Port 3002 |
| --- | ---: | ---: |
| HTTP requests | 130 | 113 |
| Server request-duration p95 | 267.64 ms | 294.25 ms |
| Committed update to local fanout p95 | 537 ms | 423 ms |
| Event-loop monitor p95 | 32.19 ms | 32.21 ms |
| Transaction connection-acquisition p95 | 0.13 ms | 0.14 ms |
| Worker failures | 0 | 0 |
| Resident memory at log time | 178.81 MiB | 169.25 MiB |

Request and fanout diagnostics use at most the recent 256 samples. Connection
acquisition also includes background transactions. The event-loop monitor uses
20 ms resolution and reports its raw observed delay. These logs were emitted
after play ended: both instances had zero active sockets, one database
connection and zero clients waiting for a connection at that instant. Those
instantaneous figures do not establish peak connection counts or queue lengths.

## Interpretation and next measurements

The run demonstrates that players connected to two backend instances converge
on one PostgreSQL-authoritative game, including a retry and reconnect. It does
not determine a maximum player count, an internet-latency target, or behavior
under sustained pressure. The measured version checked subscribed revisions
on a 250 ms worker cadence, which contributed to delivery latency. Accepted
commands and joins now also publish their committed projection immediately to
local subscribers, without waiting for that worker. Cross-instance delivery
and missed-update recovery retain the 250 ms cadence. The acting player's board
previews a legal move before acknowledgement, while game history, clocks and
cat effects await the server. The measurements above describe the earlier
version; they are not latency measurements for these changes.

Exact database lock-wait durations and true continuous memory peaks were not
captured by this baseline. Before choosing a hosting size, repeat
longer scenarios on documented hardware, vary game history length, measure
pool/lock waits and worker lag, and test instance/database failure while games
are active. Optimize measured bottlenecks before introducing another shared
service or claiming higher capacity.
