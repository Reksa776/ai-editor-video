import { describeDatabaseError, isPrivilegeDenial, readDriverError } from "./db-error";
import { ulid } from "./id";

/**
 * Access-boundary verification for the Phase 1 schema (`projects`, `assets`).
 *
 * Expectations for the Next.js runtime account (`aivideo_web`):
 *   SELECT on projects, assets
 *   INSERT on projects, assets
 *   NO UPDATE, NO DELETE, NO DDL, NO other database
 *
 * How each expectation is proven without touching real data:
 *   SELECT           — `SELECT COUNT(*)`, read-only.
 *   INSERT           — real inserts inside a transaction that is ALWAYS rolled
 *                      back. Proves the grant without needing DELETE and
 *                      without leaving rows behind.
 *   UPDATE / DELETE  — issued with `WHERE 1 = 0`. MySQL checks table privileges
 *                      before it evaluates the WHERE clause, so a granted user
 *                      gets "0 rows affected" (no data touched) and a denied
 *                      user gets ER_TABLEACCESS_DENIED (1142). Either way no
 *                      row is read, modified or removed.
 *
 * Classification is strict: a check PASSes only when the failure is positively
 * identified as a privilege denial of that operation on that table (see
 * `db-error.ts`). Syntax errors, missing tables, unknown databases, connection
 * failures and anything unrecognised are FAIL — MariaDB reports a denied
 * statement against a *nonexistent* table as 1142 too, so a table-visibility
 * gate runs first to keep that case from being scored as a clean denial.
 *
 * The client is a small interface so this logic is unit-testable without a
 * database. `scripts/verify-db-access.ts` adapts Prisma Client to it.
 */

export const EXPECTED_DATABASE = "aivideo";
export const EXPECTED_USER = "aivideo_web";

/** Phase 1 tables the web runtime may touch. */
export const PHASE1_TABLES = ["projects", "assets"] as const;

/** Schemas a correctly scoped account is allowed to see. */
export const ALLOWED_SCHEMAS: readonly string[] = [EXPECTED_DATABASE, "information_schema"];

export type ProbeClient = {
  query(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, params?: readonly unknown[]): Promise<number>;
  /** Runs `work` in a transaction that is always rolled back. */
  rollbackTransaction(work: (client: ProbeClient) => Promise<void>): Promise<void>;
};

export type CheckResult = {
  id: string;
  label: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
};

async function countRows(client: ProbeClient): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of PHASE1_TABLES) {
    const rows = await client.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
    counts[table] = Number(rows[0]?.n ?? 0);
  }
  return counts;
}

/**
 * Tables this account can see in the current database. Only granted tables are
 * listed, which is what makes the missing-table/denied distinction possible.
 */
async function grantedTables(client: ProbeClient): Promise<Set<string>> {
  const rows = await client.query(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()",
  );
  return new Set(rows.map((row) => String(row.name)));
}

/**
 * Inserts one throw-away project and one throw-away asset inside a transaction
 * that is rolled back. Returns the row counts before and after so the caller can
 * prove the rollback left nothing behind.
 */
export async function probeInsertWithRollback(client: ProbeClient): Promise<{
  before: Record<string, number>;
  after: Record<string, number>;
}> {
  const before = await countRows(client);
  const projectId = ulid();
  const assetId = ulid();

  await client.rollbackTransaction(async (tx) => {
    await tx.execute(
      "INSERT INTO `projects` (`id`, `name`, `status`, `created_at`, `updated_at`) VALUES (?, ?, 'active', NOW(3), NOW(3))",
      [projectId, "__db_access_probe__"],
    );
    await tx.execute(
      "INSERT INTO `assets` (`id`, `project_id`, `kind`, `rel_path`, `filename`, `mime_type`, `sha256`, `bytes`, `created_at`) VALUES (?, ?, 'source', ?, ?, ?, ?, ?, NOW(3))",
      [
        assetId,
        projectId,
        `${projectId}/source/${assetId}.mp4`,
        "probe.mp4",
        "video/mp4",
        "0".repeat(64),
        1,
      ],
    );
  });

  const after = await countRows(client);
  return { before, after };
}

type DenyProbe = {
  id: string;
  label: string;
  table: string;
  operation: "UPDATE" | "DELETE";
  sql: string;
};

async function expectDenied(
  client: ProbeClient,
  probe: DenyProbe,
  tables: ReadonlySet<string>,
): Promise<CheckResult> {
  const { id, label, table, operation, sql } = probe;

  // MariaDB answers a denied statement on a missing table with 1142 as well, so
  // without this gate a missing table would be scored as a clean denial.
  if (!tables.has(table)) {
    return {
      id,
      label,
      status: "FAIL",
      detail: `table \`${table}\` is not visible to this account (missing, or no grant) — a denial cannot be attributed to ${operation} privileges`,
    };
  }

  try {
    const affected = await client.execute(sql);
    // Privilege granted. The statement matches no rows by construction, so this
    // reports a grant that is too broad without having modified anything.
    return {
      id,
      label,
      status: "FAIL",
      detail: `statement was allowed (${affected} row(s) affected) — this privilege must not be granted`,
    };
  } catch (error) {
    if (isPrivilegeDenial(error, { operation, table })) {
      return { id, label, status: "PASS", detail: describeDatabaseError(error) };
    }
    const facts = readDriverError(error);
    return {
      id,
      label,
      status: "FAIL",
      detail: `not a ${operation} privilege denial (errno=${facts.errno ?? "n/a"}, sqlstate=${facts.sqlState ?? "n/a"}): ${describeDatabaseError(error)}`,
    };
  }
}

const DENY_PROBES: DenyProbe[] = [
  {
    id: "deny:update:projects",
    label: "UPDATE projects denied",
    table: "projects",
    operation: "UPDATE",
    sql: "UPDATE `projects` SET `name` = `name` WHERE 1 = 0",
  },
  {
    id: "deny:update:assets",
    label: "UPDATE assets denied",
    table: "assets",
    operation: "UPDATE",
    sql: "UPDATE `assets` SET `filename` = `filename` WHERE 1 = 0",
  },
  {
    id: "deny:delete:projects",
    label: "DELETE projects denied",
    table: "projects",
    operation: "DELETE",
    sql: "DELETE FROM `projects` WHERE 1 = 0",
  },
  {
    id: "deny:delete:assets",
    label: "DELETE assets denied",
    table: "assets",
    operation: "DELETE",
    sql: "DELETE FROM `assets` WHERE 1 = 0",
  },
];

export async function runVerification(client: ProbeClient): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  // --- identity -----------------------------------------------------------
  const identityRows = await client.query(
    "SELECT DATABASE() AS db, CURRENT_USER() AS usr, VERSION() AS version",
  );
  const identity = identityRows[0] ?? {};
  const database = String(identity.db ?? "");
  const authenticated = String(identity.usr ?? "");
  const version = String(identity.version ?? "");
  const identityOk =
    database === EXPECTED_DATABASE && authenticated.toLowerCase().startsWith(`${EXPECTED_USER}@`);

  checks.push({
    id: "identity",
    label: `connected as ${authenticated || "?"} to ${database || "?"}`,
    status: identityOk ? "PASS" : "FAIL",
    detail: `server ${version || "unknown"}; expected ${EXPECTED_USER}@… on ${EXPECTED_DATABASE}`,
  });

  // --- isolation ----------------------------------------------------------
  const schemaRows = await client.query(
    "SELECT schema_name AS name FROM information_schema.schemata",
  );
  const visible = schemaRows.map((row) => String(row.name));
  const unexpected = visible.filter((name) => !ALLOWED_SCHEMAS.includes(name));
  checks.push({
    id: "isolation",
    label: "no access to unrelated databases",
    status: unexpected.length === 0 ? "PASS" : "FAIL",
    detail:
      unexpected.length === 0
        ? `visible: ${visible.join(", ") || "none"}`
        : `unexpected schemas visible: ${unexpected.join(", ")}`,
  });

  // --- SELECT -------------------------------------------------------------
  for (const table of PHASE1_TABLES) {
    try {
      const rows = await client.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
      checks.push({
        id: `select:${table}`,
        label: `SELECT ${table}`,
        status: "PASS",
        detail: `${Number(rows[0]?.n ?? 0)} row(s) readable`,
      });
    } catch (error) {
      checks.push({
        id: `select:${table}`,
        label: `SELECT ${table}`,
        status: "FAIL",
        detail: describeDatabaseError(error),
      });
    }
  }

  // --- INSERT (always rolled back) ---------------------------------------
  let insertDenied = false;
  try {
    const { before, after } = await probeInsertWithRollback(client);
    checks.push({
      id: "insert:projects+assets",
      label: "INSERT projects + assets (rolled back)",
      status: "PASS",
      detail: "both inserts executed inside a rolled-back transaction",
    });

    const residue = PHASE1_TABLES.filter((table) => (after[table] ?? 0) !== (before[table] ?? 0));
    checks.push({
      id: "cleanup",
      label: "rollback left no test records",
      status: residue.length === 0 ? "PASS" : "FAIL",
      detail:
        residue.length === 0
          ? `row counts unchanged (${PHASE1_TABLES.map((t) => `${t}=${before[t] ?? 0}`).join(", ")})`
          : `row counts changed after rollback: ${residue
              .map((t) => `${t} ${before[t] ?? 0}→${after[t] ?? 0}`)
              .join(", ")}`,
    });
  } catch (error) {
    if (!isPrivilegeDenial(error, { operation: "INSERT" })) {
      // Not a permission result: a failed transaction may have left rows behind
      // and the row counts cannot be trusted, so refuse to print a clean summary.
      throw error;
    }
    insertDenied = true;
    checks.push({
      id: "insert:projects+assets",
      label: "INSERT projects + assets (rolled back)",
      status: "FAIL",
      detail: `INSERT denied — aivideo_web needs INSERT on projects and assets: ${describeDatabaseError(error)}`,
    });
  }

  if (insertDenied) {
    checks.push({
      id: "cleanup",
      label: "rollback left no test records",
      status: "SKIP",
      detail: "INSERT was denied, so no row was written and there is nothing to roll back",
    });
  }

  // --- UPDATE / DELETE must be denied ------------------------------------
  const tables = await grantedTables(client);
  for (const probe of DENY_PROBES) {
    checks.push(await expectDenied(client, probe, tables));
  }

  return checks;
}
