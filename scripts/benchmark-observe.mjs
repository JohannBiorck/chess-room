import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = fileURLToPath(new URL("../", import.meta.url));

function localUrl(input, protocols, setting) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${setting} must be a valid loopback URL.`);
  }
  if (
    !protocols.includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error(`${setting} must address a loopback host.`);
  }
  return url;
}

const databaseUrl = localUrl(
  process.env.DATABASE_URL,
  ["postgres:", "postgresql:"],
  "DATABASE_URL",
);
if (databaseUrl.search || databaseUrl.hash) {
  throw new Error(
    "DATABASE_URL must not contain parameters that can override its loopback destination.",
  );
}
const baseUrl = localUrl(
  process.env.BENCHMARK_BASE_URL ?? "http://127.0.0.1:3001",
  ["http:", "https:"],
  "BENCHMARK_BASE_URL",
);
const peerUrl = localUrl(
  process.env.BENCHMARK_PEER_URL ?? baseUrl.origin,
  ["http:", "https:"],
  "BENCHMARK_PEER_URL",
);
const ports = [
  ...new Set(
    [baseUrl, peerUrl].map((url) => Number(url.port || (url.protocol === "https:" ? 443 : 80))),
  ),
];
const pool = new pg.Pool({
  connectionString: databaseUrl.href,
  max: 1,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 2_000,
  application_name: "chess-room-benchmark-observer",
});
let idleDatabaseErrors = 0;
pool.on("error", () => {
  idleDatabaseErrors += 1;
});

async function lockProbe() {
  if (process.env.BENCHMARK_LOCK_PROBE !== "true") return null;
  const schema = `benchmark_lock_${randomUUID().replaceAll("-", "")}`;
  if (!/^benchmark_lock_[a-f0-9]{32}$/.test(schema))
    throw new Error("Invalid isolated probe schema.");
  const config = {
    connectionString: databaseUrl.href,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 3_000,
  };
  const holder = new pg.Client({ ...config, application_name: "chess-room-benchmark-lock-holder" });
  const waiter = new pg.Client({ ...config, application_name: "chess-room-benchmark-lock-waiter" });
  let pending;
  try {
    await Promise.all([holder.connect(), waiter.connect()]);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(
      `CREATE TABLE "${schema}".probe (id integer PRIMARY KEY, value integer NOT NULL)`,
    );
    await pool.query(`INSERT INTO "${schema}".probe VALUES (1, 0)`);
    await holder.query("BEGIN");
    await holder.query(`SELECT id FROM "${schema}".probe WHERE id=1 FOR UPDATE`);
    const started = performance.now();
    pending = waiter.query(`UPDATE "${schema}".probe SET value=value+1 WHERE id=1`);
    // Observe an error immediately even if detection takes longer than the query timeout.
    const guarded = pending.then(
      () => null,
      () => new Error("Controlled lock operation failed."),
    );
    let detectedAt;
    while (performance.now() - started < 2_000) {
      const observed = await pool.query(
        "SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE application_name=$1 AND cardinality(pg_blocking_pids(pid))>0",
        ["chess-room-benchmark-lock-waiter"],
      );
      if (observed.rows[0]?.blocked === 1) {
        detectedAt = performance.now();
        break;
      }
      await delay(10);
    }
    if (detectedAt === undefined) throw new Error("Controlled row lock was not observed.");
    await delay(50);
    await holder.query("COMMIT");
    const failure = await guarded;
    if (failure) throw failure;
    return {
      blockedBackendObserved: true,
      detectionLatencyMs: Number((detectedAt - started).toFixed(2)),
      blockerHeldAfterDetectionMs: 50,
      blockedOperationMs: Number((performance.now() - started).toFixed(2)),
      exactDatabaseLockDurationMeasured: false,
    };
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    if (pending) await pending.catch(() => {});
    await Promise.all([holder.end(), waiter.end()]);
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
}

async function windowsMemorySampler() {
  if (process.platform !== "win32")
    return { stop: async () => {}, snapshot: () => ({ supported: false }) };
  const script = `
$ErrorActionPreference = 'Stop'
$observedPorts = @(${ports.join(",")})
$listeners = @(Get-NetTCPConnection -LocalPort $observedPorts -State Listen | Select-Object LocalPort, OwningProcess)
if (($listeners | Select-Object -ExpandProperty LocalPort -Unique).Count -ne $observedPorts.Count) { throw 'A backend listener is missing.' }
for ($sample = 0; $sample -lt 100; $sample++) {
  $backends = @()
  foreach ($listener in $listeners) {
    $backend = Get-Process -Id $listener.OwningProcess
    $backends += [PSCustomObject]@{ port=$listener.LocalPort; workingSetBytes=$backend.WorkingSet64 }
  }
  [PSCustomObject]@{ backends=$backends } | ConvertTo-Json -Compress -Depth 4
  Start-Sleep -Seconds 1
}`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const observations = new Map();
  let buffer = "";
  let stopping = false;
  let stopped = false;
  let samplerFailed = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timeout = setTimeout(
    () => readyReject(new Error("Memory sampler did not become ready.")),
    10_000,
  );
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const sample = JSON.parse(line);
        for (const backend of sample.backends) {
          if (!ports.includes(backend.port) || !Number.isFinite(backend.workingSetBytes))
            throw new Error("Invalid memory sample.");
          const current = observations.get(backend.port) ?? { samples: 0, maxWorkingSetBytes: 0 };
          current.samples += 1;
          current.maxWorkingSetBytes = Math.max(
            current.maxWorkingSetBytes,
            backend.workingSetBytes,
          );
          observations.set(backend.port, current);
        }
        clearTimeout(timeout);
        readyResolve();
      } catch {
        samplerFailed = true;
        readyReject(new Error("Memory sampler returned invalid data."));
      }
    }
  });
  child.stderr.resume();
  child.on("error", () => {
    samplerFailed = true;
    readyReject(new Error("Memory sampler could not start."));
  });
  child.on("exit", () => {
    if (!stopping) {
      samplerFailed = true;
      readyReject(new Error("Memory sampler stopped early."));
    }
  });
  try {
    await ready;
  } catch (error) {
    child.kill();
    clearTimeout(timeout);
    throw error;
  }
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      stopping = true;
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) {
        const ended = new Promise((resolve) => child.once("exit", resolve));
        child.kill();
        await ended;
      }
    },
    snapshot() {
      if (samplerFailed) throw new Error("Memory sampler did not cover the full benchmark.");
      return {
        supported: true,
        sampleIntervalMs: 1_000,
        span: "setup, play and cleanup",
        backends: [...observations].map(([port, observed]) => ({
          port,
          samples: observed.samples,
          observedMaxWorkingSetMiB: Number((observed.maxWorkingSetBytes / 1024 ** 2).toFixed(2)),
        })),
      };
    },
  };
}

async function runBenchmark() {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./benchmark.mjs", import.meta.url))],
    {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  const timeout = setTimeout(() => child.kill(), 90_000);
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    if (stdout.length > 65_536) child.kill();
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8_192);
  });
  try {
    await new Promise((resolve, reject) => {
      child.once("error", () => reject(new Error("Benchmark process could not start.")));
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                `Benchmark failed${stderr.includes("RATE_LIMITED") ? ": guest/IP quota needs a full minute to reset" : "."}`,
              ),
            ),
      );
    });
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timeout);
  }
}

let memory;
let collecting = false;
let sampler;
let sampleFailure;
const databaseSamples = [];
try {
  await pool.query("SELECT 1");
  const controlledLockProbe = await lockProbe();
  memory = await windowsMemorySampler();
  collecting = true;
  sampler = (async () => {
    while (collecting) {
      try {
        const result = await pool.query(`SELECT count(*)::int AS connections,
          count(*) FILTER (WHERE wait_event_type='Lock')::int AS lock_waiters,
          count(*) FILTER (WHERE cardinality(pg_blocking_pids(pid))>0)::int AS blocked
          FROM pg_stat_activity WHERE datname=current_database() AND application_name='chess-room'`);
        databaseSamples.push(result.rows[0]);
      } catch {
        sampleFailure = true;
        collecting = false;
      }
      if (collecting) await delay(250);
    }
  })();
  const benchmark = await runBenchmark();
  collecting = false;
  await sampler;
  await memory.stop();
  if (sampleFailure || idleDatabaseErrors > 0)
    throw new Error("Database observation failed during the benchmark.");
  console.log(
    JSON.stringify(
      {
        benchmark,
        databaseObservation: {
          sampleIntervalMs: 250,
          samples: databaseSamples.length,
          idleDatabaseErrors,
          span: "setup, play and cleanup",
          maxApplicationConnections: Math.max(
            0,
            ...databaseSamples.map((sample) => sample.connections),
          ),
          maxLockWaiters: Math.max(0, ...databaseSamples.map((sample) => sample.lock_waiters)),
          maxBlockedBackends: Math.max(0, ...databaseSamples.map((sample) => sample.blocked)),
          samplesWithLockWaiters: databaseSamples.filter((sample) => sample.lock_waiters > 0)
            .length,
          exactDatabaseLockDurationMeasured: false,
        },
        backendMemory: memory.snapshot(),
        controlledLockProbe,
      },
      null,
      2,
    ),
  );
} catch {
  process.exitCode = 1;
  console.error(
    "Observed benchmark failed. Check loopback settings, running backends, local database privileges and per-minute quotas.",
  );
} finally {
  collecting = false;
  if (sampler) await sampler;
  if (memory) await memory.stop();
  await pool.end();
}
