import { isIP } from "node:net";

export interface ServerConfig {
  host: string;
  port: number;
}

export function readConfig(environment: Record<string, string | undefined>): ServerConfig {
  const host = environment.HOST ?? "127.0.0.1";
  if (host !== "localhost" && isIP(host) === 0) {
    throw new Error("HOST must be localhost or a valid IP address.");
  }

  const rawPort = environment.PORT ?? "3001";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  return { host, port };
}
