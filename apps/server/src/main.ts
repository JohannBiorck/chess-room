import { readConfig } from "./config.js";
import { buildServer } from "./server.js";

async function main() {
  const config = readConfig(process.env);
  const server = buildServer();
  let stopping = false;

  async function shutdown() {
    if (stopping) return;
    stopping = true;

    try {
      await server.close();
    } catch (error) {
      server.log.error({ err: error }, "Server shutdown failed");
      process.exitCode = 1;
    }
  }

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await server.listen(config);
}

main().catch((error: unknown) => {
  console.error(
    "Server failed to start:",
    error instanceof Error ? error.message : "Unknown startup error",
  );
  process.exitCode = 1;
});
