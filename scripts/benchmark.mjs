import { randomUUID } from "node:crypto";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { gameViewSchema, publicGameSchema } from "@chess-room/contracts";
import { io } from "socket.io-client";

function localOrigin(input, setting) {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${setting} must be a loopback HTTP origin.`);
  }
  return url.origin;
}

function boundedInteger(input, fallback, maximum, setting) {
  const value = Number(input ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${setting} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

const baseUrl = localOrigin(
  process.env.BENCHMARK_BASE_URL ?? "http://127.0.0.1:3001",
  "BENCHMARK_BASE_URL",
);
const peerUrl = localOrigin(process.env.BENCHMARK_PEER_URL ?? baseUrl, "BENCHMARK_PEER_URL");
const origin = localOrigin(
  process.env.BENCHMARK_ORIGIN ?? "http://127.0.0.1:5173",
  "BENCHMARK_ORIGIN",
);
const gameCount = boundedInteger(process.env.BENCHMARK_GAMES, 8, 8, "BENCHMARK_GAMES");
const pliesPerGame = boundedInteger(process.env.BENCHMARK_PLIES, 24, 48, "BENCHMARK_PLIES");
const sockets = new Set();
const games = [];
const acknowledgements = [];
const updateDelays = [];
let requestCount = 0;
let reconnects = 0;
let duplicatesVerified = 0;
let acceptedMoves = 0;
let cleanupFailures = 0;

async function request(client, path, body) {
  requestCount += 1;
  const response = await fetch(`${client.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: origin,
      ...(client.cookie ? { Cookie: client.cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${result.error?.code ?? "REQUEST_FAILED"}`);
  }
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (cookie) client.cookie = cookie;
  return result;
}

async function session(url, displayName) {
  const client = { url, cookie: "" };
  await request(client, "/api/session", { displayName });
  if (!client.cookie) throw new Error("Session response did not set a cookie.");
  return client;
}

async function connect(client, gameId) {
  const socket = io(client.url, {
    transports: ["websocket"],
    autoConnect: false,
    reconnection: false,
    extraHeaders: { Origin: origin, Cookie: client.cookie },
  });
  sockets.add(socket);
  let revision = -1;
  let projectionError;
  const waiters = [];
  const update = (payload) => {
    const parsed = publicGameSchema.safeParse(payload);
    if (!parsed.success) {
      projectionError = new Error("Player update failed contract validation.");
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(projectionError);
      }
      return;
    }
    const state = parsed.data;
    revision = Math.max(revision, state.revision);
    for (const waiter of [...waiters]) {
      if (revision >= waiter.revision) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(performance.now());
      }
    }
  };
  socket.on("game:updated", update);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Socket connection timed out.")), 5_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", () => {
      clearTimeout(timer);
      reject(new Error("Socket connection failed."));
    });
    socket.connect();
  });
  const view = gameViewSchema.parse(
    await socket.timeout(5_000).emitWithAck("game:subscribe", { gameId }),
  );
  revision = Math.max(revision, view.game.revision);
  return {
    socket,
    waitFor(targetRevision) {
      if (projectionError) return Promise.reject(projectionError);
      if (revision >= targetRevision) return Promise.resolve(performance.now());
      return new Promise((resolve, reject) => {
        const waiter = { revision: targetRevision, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error("Committed revision was not delivered to both players."));
        }, 5_000);
        waiters.push(waiter);
      });
    },
  };
}

function selectMove(position, gameIndex, ply) {
  const legal = position.legalMoves;
  // Stable inputs give a repeatable legal scenario without client-chosen positions.
  const index = ((gameIndex + 1) * 7919 + (ply + 1) * 104729) % legal.length;
  return legal[index];
}

async function prepare(index) {
  const white = await session(baseUrl, `Load White ${index + 1}`);
  const black = await session(peerUrl, `Load Black ${index + 1}`);
  const created = await request(white, "/api/games", {
    rulesetId: index % 2 === 0 ? "standard" : "three-check",
    color: "white",
    timeControl: "untimed",
  });
  const game = {
    white,
    black,
    view: gameViewSchema.parse({ game: created.game, seat: created.seat }),
    connections: [],
  };
  games.push(game);
  game.view = gameViewSchema.parse(
    await request(black, "/api/invitations/join", { token: created.invitation.token }),
  );
  game.connections = await Promise.all([
    connect(white, game.view.game.id),
    connect(black, game.view.game.id),
  ]);
  return game;
}

async function exercise(game, index) {
  for (let ply = 0; ply < pliesPerGame && game.view.game.phase === "active"; ply += 1) {
    const position = game.view.game.position;
    const move = selectMove(position, index, ply);
    if (!move) throw new Error("An active game had no legal moves.");
    const client = position.turn === "white" ? game.white : game.black;
    const command = {
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: game.view.game.revision,
      action: { type: "move", ...move },
    };
    const started = performance.now();
    game.view = gameViewSchema.parse(
      await request(client, `/api/games/${game.view.game.id}/commands`, command),
    );
    acknowledgements.push(performance.now() - started);
    acceptedMoves += 1;
    const delivered = await Promise.all(
      game.connections.map((connection) => connection.waitFor(game.view.game.revision)),
    );
    updateDelays.push(...delivered.map((at) => at - started));
    if (index === 0 && ply === 0) {
      const repeated = gameViewSchema.parse(
        await request(client, `/api/games/${game.view.game.id}/commands`, command),
      );
      if (repeated.game.revision !== game.view.game.revision)
        throw new Error("A retry changed the committed revision.");
      duplicatesVerified += 1;
    }
    if (index === 0 && ply === 2) {
      game.connections[1].socket.disconnect();
      const reconnect = await connect(game.black, game.view.game.id);
      await reconnect.waitFor(game.view.game.revision);
      game.connections[1] = reconnect;
      reconnects += 1;
    }
  }
}

function distribution(samples) {
  if (samples.length === 0) return null;
  const sorted = samples.toSorted((left, right) => left - right);
  const at = (quantile) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
  return {
    count: samples.length,
    p50Ms: Number(at(0.5).toFixed(2)),
    p95Ms: Number(at(0.95).toFixed(2)),
    maxMs: Number(sorted.at(-1).toFixed(2)),
  };
}

async function finish() {
  for (const game of games) {
    try {
      const current = gameViewSchema.parse(
        await request(game.white, `/api/games/${game.view.game.id}`),
      );
      if (current.game.phase === "active") {
        await request(game.white, `/api/games/${current.game.id}/commands`, {
          protocolVersion: 1,
          commandId: randomUUID(),
          expectedRevision: current.game.revision,
          action: { type: "resign" },
        });
      }
    } catch {
      // Closing every local socket is still required when a cleanup request fails.
      cleanupFailures += 1;
    }
  }
  for (const socket of sockets) socket.disconnect();
}

let result;
try {
  await Promise.all([
    request({ url: baseUrl }, "/api/ready"),
    request({ url: peerUrl }, "/api/ready"),
  ]);
  // Preparation is sequential so the measured interval covers play, not setup bursts.
  const prepared = [];
  for (let index = 0; index < gameCount; index += 1) prepared.push(await prepare(index));
  await delay(300);
  const started = performance.now();
  await Promise.all(prepared.map(exercise));
  const elapsedMs = performance.now() - started;
  result = {
    scenario: {
      concurrentGames: gameCount,
      simultaneousPlayerSockets: gameCount * 2,
      requestedPliesPerGame: pliesPerGame,
      acceptedMoves,
      backendOrigins: baseUrl === peerUrl ? 1 : 2,
      rulesets: ["standard", "three-check"],
      elapsedMs: Number(elapsedMs.toFixed(2)),
      movesPerSecond: Number((acceptedMoves / (elapsedMs / 1000)).toFixed(2)),
    },
    commandAcknowledgement: distribution(acknowledgements),
    moveStartToPlayerUpdate: distribution(updateDelays),
    sameCommandRetriesVerified: duplicatesVerified,
    reconnectsVerified: reconnects,
    hardware: {
      platform: `${platform()} ${release()}`,
      architecture: arch(),
      cpuModel: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
      node: process.version,
    },
  };
} catch (error) {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : "Benchmark failed.");
} finally {
  await finish();
  if (cleanupFailures > 0) {
    process.exitCode = 1;
    console.error(`${cleanupFailures} synthetic games could not be finished.`);
  }
  if (result)
    console.log(
      JSON.stringify({ ...result, totalHttpRequests: requestCount, cleanupFailures }, null, 2),
    );
}
