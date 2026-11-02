import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@/generated/prisma/client";
import { readWebDatabaseConfig } from "./env";

/**
 * Prisma Client singleton.
 *
 * Constructed lazily so that pages still render (with an explicit
 * "database not configured" state) when WEB_DATABASE_URL is absent.
 *
 * Pool settings override the driver adapter's defaults, which are far too
 * generous for this host (default: connectionLimit 10, connectTimeout 1s,
 * idleTimeout 1800s):
 *   connectionLimit 5  - keeps total app connections at 10 alongside FastAPI
 *   connectTimeout 5s  - 1s drops connections while a render saturates cores
 *   idleTimeout 300s   - release sockets between jobs
 */
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

export function getPrisma(): PrismaClient {
  if (globalForPrisma.__prisma) {
    return globalForPrisma.__prisma;
  }

  const config = readWebDatabaseConfig();
  const adapter = new PrismaMariaDb({
    ...config,
    connectionLimit: 5,
    connectTimeout: 5000,
    acquireTimeout: 10000,
    idleTimeout: 300,
  });

  const client = new PrismaClient({ adapter });
  globalForPrisma.__prisma = client;
  return client;
}
