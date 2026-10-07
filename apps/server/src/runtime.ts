import { readApplicationConfig } from "./application/config.js";
import { buildApplication } from "./application/server.js";
import { readConfig } from "./config.js";
import { Database } from "./storage/database.js";

export async function startApplication() {
  const config = readConfig(process.env);
  const applicationConfig = readApplicationConfig(process.env);
  const database = new Database(applicationConfig.databaseUrl);
  let application: Awaited<ReturnType<typeof buildApplication>> | undefined;
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    try {
      await application?.server.close();
    } catch {
      application?.server.log.error({ code: "shutdown-failed" }, "Server shutdown failed");
      process.exitCode = 1;
    } finally {
      try {
        await database.close();
      } catch {
        process.exitCode = 1;
      }
    }
  }
  const signalShutdown = () => void shutdown();
  try {
    if (!(await database.ready()))
      throw new Error("Database is unavailable or migrations are absent.");
    application = await buildApplication({ database, config: applicationConfig });
    process.once("SIGINT", signalShutdown);
    process.once("SIGTERM", signalShutdown);
    await application.server.listen(config);
  } catch (error) {
    process.removeListener("SIGINT", signalShutdown);
    process.removeListener("SIGTERM", signalShutdown);
    await shutdown();
    throw error;
  }
}
