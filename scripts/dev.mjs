import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const processes = [
  spawn(process.execPath, ["../../node_modules/vite/bin/vite.js", "--host", "127.0.0.1"], {
    cwd: `${root}/apps/web`,
    stdio: "inherit",
  }),
  spawn(
    process.execPath,
    ["--env-file-if-exists=../../.env", "--import", "tsx", "--watch", "src/main.ts"],
    { cwd: `${root}/apps/server`, stdio: "inherit" },
  ),
];

let stopping = false;
function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of processes) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  }
}
for (const child of processes) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => stop(code ?? 1));
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
