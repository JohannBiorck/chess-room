import { startApplication } from "./runtime.js";

startApplication().catch(() => {
  console.error(
    "Server failed to start. Check runtime settings, database availability, and migrations.",
  );
  process.exitCode = 1;
});
