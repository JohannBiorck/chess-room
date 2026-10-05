import { isIP } from "node:net";

export interface ApplicationConfig {
  databaseUrl: string;
  webOrigin: string;
  secureCookies: boolean;
  serveWeb: boolean;
  trustProxy?: string[];
}

export function readApplicationConfig(environment: NodeJS.ProcessEnv): ApplicationConfig {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  let database: URL;
  try {
    database = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(database.protocol))
    throw new Error("DATABASE_URL must be a PostgreSQL URL.");
  let origin: URL;
  try {
    origin = new URL(environment.WEB_ORIGIN ?? "http://127.0.0.1:5173");
  } catch {
    throw new Error("WEB_ORIGIN must be an HTTP origin.");
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("WEB_ORIGIN must be an HTTP origin without a path.");
  if (environment.NODE_ENV === "production" && origin.protocol !== "https:")
    throw new Error("Production WEB_ORIGIN must use HTTPS.");
  const trustProxy = environment.TRUST_PROXY
    ? environment.TRUST_PROXY.split(",").map((value) => value.trim())
    : undefined;
  if (
    trustProxy?.some((value) => {
      const [address = "", bits, extra] = value.split("/");
      const family = isIP(address);
      return (
        !family ||
        extra !== undefined ||
        (bits !== undefined && (!/^\d+$/.test(bits) || Number(bits) > (family === 4 ? 32 : 128)))
      );
    })
  )
    throw new Error("TRUST_PROXY must contain explicit IP addresses or CIDR ranges.");
  return {
    databaseUrl,
    webOrigin: origin.origin,
    secureCookies: origin.protocol === "https:",
    serveWeb: environment.SERVE_WEB === "true",
    ...(trustProxy ? { trustProxy } : {}),
  };
}
