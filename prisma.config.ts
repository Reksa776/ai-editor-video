import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 configuration.
 *
 * - `datasource.url` lives here, NOT in schema.prisma (unsupported in v7).
 * - `process.env` is used instead of the `env()` helper on purpose: the helper
 *   throws on a missing variable, which would break `prisma generate` during
 *   builds where no database URL exists.
 * - This CLI config uses the MIGRATOR credentials. The Next.js runtime uses
 *   WEB_DATABASE_URL via src/lib/prisma.ts, so application code never holds
 *   DDL rights.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL ?? "",
  },
});
