/**
 * Database access-boundary verification for the Phase 1 schema.
 *
 * Context: this script used to load no env file, so `WEB_DATABASE_URL` was
 * invisible to `tsx` and the run always ended in BLOCKED. It also probed a
 * `jobs` table (Phase 2) and deleted a probe project afterwards, which required
 * DELETE rights the web account is not supposed to have.
 *
 * Now:
 *   - `src/lib/env-loader.ts` loads `.env` → `.env.local` (shell wins).
 *   - only `projects` and `assets` are probed.
 *   - INSERT is proven inside a rolled-back transaction; nothing is committed
 *     and no DELETE privilege is needed.
 *   - UPDATE/DELETE are probed with `WHERE 1 = 0`, so even a mis-granted
 *     account cannot modify data.
 *
 * Exit codes: 0 all checks PASS, 1 at least one FAIL, 2 configuration missing.
 * No credential or connection string is ever printed.
 *
 * Run: npm run verify:db-access
 */
import type { PrismaClient } from "../src/generated/prisma/client";
import { runVerification, type ProbeClient } from "../src/lib/db-access-verify";
import { describeDatabaseError } from "../src/lib/db-error";
import { loadEnvironment } from "../src/lib/env-loader";
import { getPrisma } from "../src/lib/prisma";
import { redactSecrets } from "../src/lib/redact";

type RawClient = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

/** Sentinel used to force a rollback; never a real failure. */
class RollbackSignal extends Error {
  constructor() {
    super("rollback");
    this.name = "RollbackSignal";
  }
}

function probeFor(
  raw: RawClient,
  rollback?: (work: (client: ProbeClient) => Promise<void>) => Promise<void>,
): ProbeClient {
  return {
    async query(sql, params = []) {
      const rows = await raw.$queryRawUnsafe<unknown>(sql, ...params);
      return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    },
    async execute(sql, params = []) {
      const affected = await raw.$executeRawUnsafe(sql, ...params);
      return typeof affected === "number" ? affected : Number(affected ?? 0);
    },
    rollbackTransaction(work) {
      if (!rollback) {
        throw new Error("nested transactions are not supported by the probe client");
      }
      return rollback(work);
    },
  };
}

async function main(): Promise<number> {
  const env = loadEnvironment();
  console.log(
    `env: loaded ${env.loaded.join(", ") || "none"} (missing: ${env.missing.join(", ") || "none"})`,
  );

  let prisma: PrismaClient | null = null;
  try {
    prisma = getPrisma();
  } catch (error) {
    console.log(redactSecrets(`BLOCKED  ${describeDatabaseError(error)}`));
    console.log("         copy .env.example to .env.local and add the aivideo_web credentials");
    return 2;
  }

  const client = prisma;
  try {
    const rollback = async (work: (probe: ProbeClient) => Promise<void>): Promise<void> => {
      try {
        await client.$transaction(async (tx) => {
          await work(probeFor(tx as unknown as RawClient));
          throw new RollbackSignal();
        });
      } catch (error) {
        // Only our own sentinel is expected; a real rollback failure must surface.
        if (!(error instanceof RollbackSignal)) {
          throw error;
        }
      }
    };

    const checks = await runVerification(probeFor(client as unknown as RawClient, rollback));

    console.log("");
    for (const check of checks) {
      console.log(
        `${check.status.padEnd(5)} ${check.id.padEnd(24)} ${redactSecrets(`${check.label} — ${check.detail}`)}`,
      );
    }

    const failed = checks.filter((check) => check.status === "FAIL");
    console.log("");
    console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
    return failed.length === 0 ? 0 : 1;
  } finally {
    await client.$disconnect();
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(redactSecrets(`FATAL  ${describeDatabaseError(error)}`));
    process.exit(1);
  });
