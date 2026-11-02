import { defineConfig } from "prisma/config";
import { loadEnvironment } from "./src/lib/env-loader";

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
 *
 * Environment loading goes through `src/lib/env-loader.ts` — the single loader
 * shared with `scripts/*` and the tests — instead of a second dotenv setup that
 * would drift. Precedence: `.env`, then `.env.local`, with the real process
 * environment (shell/CI) always winning. Missing files are silent, so every
 * lookup still falls back to the ambient environment.
 */
loadEnvironment();

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
