import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";
import { migrate } from "../apps/server/dist/storage/migrations.js";

const root = fileURLToPath(new URL("../", import.meta.url));
// Matches playwright.config.ts; a surviving server must never lose its fixtures.
const serverPort = 5174;

export function localDatabaseUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("TEST_DATABASE_URL or DATABASE_URL must be a valid local PostgreSQL URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.pathname.length < 2 ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Browser tests require a loopback PostgreSQL database URL without query parameters or a fragment.",
    );
  }
  return url;
}

function serverListening() {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port: serverPort });
    const finish = (listening) => {
      socket.destroy();
      done(listening);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(true));
  });
}

async function serverStopped() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await serverListening())) return true;
    await delay(250);
  }
  return false;
}

async function run() {
  const database = localDatabaseUrl(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL);
  if (await serverListening())
    throw new Error("Stop the existing local server on port 5174 before running browser tests.");

  const schema = `browser_test_${randomUUID().replaceAll("-", "")}`;
  if (!/^browser_test_[a-f0-9]{32}$/.test(schema)) throw new Error("Invalid browser-test schema.");
  const options = {
    connectionString: database.href,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    application_name: "chess-room-browser-tests",
  };
  const owner = new Pool(options);
  const databaseFailure = () => {
    console.error("A local browser-test database connection failed.");
    process.exitCode = 1;
  };
  owner.on("error", databaseFailure);
  let created = false;
  let child;
  let interrupted = null;
  let stopping = Promise.resolve();
  const stop = (signal) => {
    interrupted ??= signal;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
      // Windows signals do not reliably stop grandchildren. Target only our own tree.
      stopping = new Promise((done) => {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
        });
        killer.once("error", done);
        killer.once("close", done);
      });
    } else {
      child.kill(signal);
    }
  };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);

  try {
    await owner.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const isolated = new URL(database);
    isolated.searchParams.set("options", `-c search_path=${schema}`);
    const pool = new Pool({ ...options, connectionString: isolated.href });
    pool.on("error", databaseFailure);
    try {
      await migrate(pool);
    } finally {
      await pool.end();
    }
    if (interrupted) return interrupted === "SIGINT" ? 130 : 143;
    console.log("Browser tests use a fresh disposable local schema; existing data is preserved.");
    const environment = {
      ...process.env,
      DATABASE_URL: isolated.href,
      TEST_DATABASE_URL: isolated.href,
      BROWSER_TEST_SCHEMA: schema,
    };
    // Browser checks need only the ordinary local owner role.
    delete environment.ADMIN_DATABASE_URL;
    delete environment.MIGRATION_DATABASE_URL;
    const args = process.argv.slice(2);
    if (args[0] === "--") args.shift();
    child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.resolve("@playwright/test/cli")), "test", ...args],
      {
        cwd: root,
        env: environment,
        stdio: "inherit",
        detached: process.platform !== "win32",
      },
    );
    const exitCode = await new Promise((done, reject) => {
      child.once("error", () => reject(new Error("The local Playwright process could not start.")));
      child.once("close", (code) => done(code ?? 1));
    });
    await stopping;
    return interrupted ? (interrupted === "SIGINT" ? 130 : 143) : exitCode;
  } catch {
    throw new Error(
      "Browser-test setup failed. Check the local database connection, schema creation permissions and built migrations.",
    );
  } finally {
    await stopping;
    if (created) {
      if (await serverStopped()) {
        try {
          // This generated, validated schema is the only cleanup target.
          await owner.query(`DROP SCHEMA "${schema}" CASCADE`);
        } catch {
          console.error(
            `Could not remove disposable schema ${schema}; existing data was preserved.`,
          );
          process.exitCode = 1;
        }
      } else {
        console.error(
          `Local server shutdown could not be confirmed; disposable schema ${schema} was retained. Stop the browser-test server before removing it.`,
        );
        process.exitCode = 1;
      }
    }
    try {
      await owner.end();
    } catch {
      databaseFailure();
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const code = await run();
    if (!process.exitCode) process.exitCode = code;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
