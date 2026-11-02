import assert from "node:assert/strict";
import test from "node:test";
import { runVerification, type CheckResult, type ProbeClient } from "../src/lib/db-access-verify";

type Options = {
  database?: string;
  user?: string;
  schemas?: string[];
  tables?: string[];
  allowUpdate?: boolean;
  allowDelete?: boolean;
  denyInsert?: boolean;
  /** Thrown instead of a real denial for UPDATE/DELETE probes. */
  denyError?: Error;
  leaveRecords?: boolean;
  rollbackError?: Error;
};

/**
 * Builds the error Prisma 7 + @prisma/adapter-mariadb actually throws: the
 * driver facts live under `meta.driverAdapterError.cause`, and `code` is the
 * generic P2010 that syntax errors share.
 */
function prismaDriverError(errno: number, dbMessage: string, state = "42000"): Error {
  const error = new Error(
    `\nInvalid \`prisma.$executeRawUnsafe()\` invocation:\n\nRaw query failed. Code: \`${errno}\`. Message: \`${dbMessage}\``,
  );
  error.name = "PrismaClientKnownRequestError";
  Object.assign(error, {
    code: "P2010",
    clientVersion: "7.10.1",
    meta: {
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: String(errno),
          originalMessage: dbMessage,
          kind: "mysql",
          code: errno,
          message: dbMessage,
          state,
        },
      },
    },
  });
  return error;
}

function denied(operation: string, table: string): Error {
  return prismaDriverError(
    1142,
    `${operation} command denied to user 'aivideo_web'@'localhost' for table \`aivideo\`.\`${table}\``,
  );
}

function tableOf(sql: string): string {
  return /`([a-z_]+)`/i.exec(sql)?.[1] ?? "unknown";
}

/** In-memory stand-in for Prisma Client — no database is contacted. */
function makeClient(options: Options = {}) {
  const statements: string[] = [];
  const counts: Record<string, number> = { projects: 0, assets: 0 };
  const cfg = {
    database: options.database ?? "aivideo",
    user: options.user ?? "aivideo_web@localhost",
    schemas: options.schemas ?? ["aivideo", "information_schema"],
    tables: options.tables ?? ["projects", "assets"],
    allowUpdate: options.allowUpdate ?? false,
    allowDelete: options.allowDelete ?? false,
    denyInsert: options.denyInsert ?? false,
    denyError: options.denyError,
    leaveRecords: options.leaveRecords ?? false,
    rollbackError: options.rollbackError,
  };

  const client: ProbeClient = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes("information_schema.schemata")) {
        return cfg.schemas.map((name) => ({ name }));
      }
      if (sql.includes("information_schema.tables")) {
        return cfg.tables.map((name) => ({ name }));
      }
      if (sql.includes("DATABASE()")) {
        return [{ db: cfg.database, usr: cfg.user, version: "11.8.8-MariaDB" }];
      }
      const count = /COUNT\(\*\) AS n FROM `([a-z_]+)`/i.exec(sql);
      if (count) {
        return [{ n: counts[count[1]] ?? 0 }];
      }
      return [];
    },
    async execute(sql) {
      statements.push(sql);
      if (/^UPDATE/i.test(sql)) {
        if (cfg.allowUpdate) return 0;
        throw cfg.denyError ?? denied("UPDATE", tableOf(sql));
      }
      if (/^DELETE/i.test(sql)) {
        if (cfg.allowDelete) return 0;
        throw cfg.denyError ?? denied("DELETE", tableOf(sql));
      }
      const insert = /^INSERT INTO `([a-z_]+)`/i.exec(sql);
      if (insert && cfg.denyInsert) throw denied("INSERT", tableOf(sql));
      if (insert) {
        counts[insert[1]] = (counts[insert[1]] ?? 0) + 1;
      }
      return 0;
    },
    async rollbackTransaction(work) {
      if (cfg.rollbackError) throw cfg.rollbackError;
      const snapshot = { ...counts };
      await work(client);
      if (!cfg.leaveRecords) {
        for (const key of Object.keys(counts)) {
          counts[key] = snapshot[key] ?? 0;
        }
      }
    },
  };

  return { client, statements };
}

function byId(checks: CheckResult[]): Record<string, CheckResult> {
  return Object.fromEntries(checks.map((check) => [check.id, check]));
}

const DENY_IDS = ["deny:update:projects", "deny:update:assets", "deny:delete:projects", "deny:delete:assets"];

test("passes for a least-privilege account without DELETE rights", async () => {
  const { client, statements } = makeClient();
  const checks = await runVerification(client);
  const failed = checks.filter((check) => check.status === "FAIL");

  assert.deepEqual(failed, [], `unexpected failures: ${failed.map((f) => f.id).join(", ")}`);
  assert.equal(byId(checks).identity.detail.includes("11.8.8-MariaDB"), true);
  assert.equal(byId(checks).cleanup.status, "PASS");
  assert.equal(statements.length > 0, true);
});

test("a denial PASS carries the server's message, not 'unknown database error'", async () => {
  const { client } = makeClient();
  const checks = byId(await runVerification(client));

  for (const id of DENY_IDS) {
    assert.equal(checks[id].status, "PASS");
    assert.notEqual(checks[id].detail, "unknown database error");
    assert.match(checks[id].detail, /command denied/);
  }
  assert.match(checks["deny:update:projects"].detail, /projects/);
});

test("only probes the Phase 1 tables", async () => {
  const { client, statements } = makeClient();
  await runVerification(client);

  assert.equal(statements.some((sql) => /\bjobs\b/i.test(sql)), false, "the obsolete jobs probe must be gone");

  const touched = new Set(
    statements.flatMap((sql) =>
      [...sql.matchAll(/(?:FROM|INTO|UPDATE)\s+`([a-z_]+)`/gi)].map((match) => match[1]),
    ),
  );
  assert.deepEqual([...touched].sort(), ["assets", "projects"]);
});

test("DELETE and UPDATE probes can never modify data", async () => {
  const { client, statements } = makeClient();
  await runVerification(client);

  const destructive = statements.filter((sql) => /^(DELETE|UPDATE)/i.test(sql));
  assert.equal(destructive.length, 4, "one UPDATE and one DELETE per Phase 1 table");
  for (const sql of destructive) {
    assert.match(sql, /WHERE 1 = 0$/i, `guarded: ${sql}`);
  }
});

test("detects an over-privileged account", async () => {
  const { client } = makeClient({ allowUpdate: true, allowDelete: true });
  const checks = byId(await runVerification(client));

  for (const id of DENY_IDS) {
    assert.equal(checks[id].status, "FAIL", `${id} should fail when the privilege is granted`);
    assert.match(checks[id].detail, /must not be granted/);
  }
});

test("an unrecognised error never becomes a PASS", async () => {
  const { client } = makeClient({ denyError: new Error("socket hang up") });
  const checks = byId(await runVerification(client));

  for (const id of DENY_IDS) {
    assert.equal(checks[id].status, "FAIL", `${id} must not pass on an unknown error`);
    assert.match(checks[id].detail, /not a (UPDATE|DELETE) privilege denial/);
    assert.match(checks[id].detail, /errno=n\/a/);
  }
});

test("a syntax error never becomes a PASS", async () => {
  const syntax = prismaDriverError(
    1064,
    "You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near 'WHERE 1 = 0' at line 1",
  );
  const { client } = makeClient({ denyError: syntax });
  const checks = byId(await runVerification(client));

  for (const id of DENY_IDS) {
    assert.equal(checks[id].status, "FAIL", "SQLSTATE 42000 alone must not be accepted");
    assert.match(checks[id].detail, /errno=1064/);
  }
});

test("a missing table is reported as such instead of a clean denial", async () => {
  // MariaDB answers 1142 for a denied statement on a nonexistent table, so the
  // fake reproduces exactly that: denial error, table absent from information_schema.
  const { client } = makeClient({ tables: [] });
  const checks = byId(await runVerification(client));

  for (const id of DENY_IDS) {
    assert.equal(checks[id].status, "FAIL");
    assert.match(checks[id].detail, /not visible to this account/);
  }
});

test("detects the wrong database identity", async () => {
  const { client } = makeClient({ database: "other_db" });
  const checks = byId(await runVerification(client));
  assert.equal(checks.identity.status, "FAIL");
});

test("detects access to an unrelated database", async () => {
  const { client } = makeClient({ schemas: ["aivideo", "information_schema", "some_other_app"] });
  const checks = byId(await runVerification(client));
  assert.equal(checks.isolation.status, "FAIL");
  assert.match(checks.isolation.detail, /some_other_app/);
});

test("reports residue when the rollback does not take effect", async () => {
  const { client } = makeClient({ leaveRecords: true });
  const checks = byId(await runVerification(client));

  assert.equal(checks["insert:projects+assets"].status, "PASS");
  assert.equal(checks.cleanup.status, "FAIL");
  assert.match(checks.cleanup.detail, /row counts changed/);
});

test("a denied INSERT fails the check and skips the residue check", async () => {
  const { client } = makeClient({ denyInsert: true });
  const checks = byId(await runVerification(client));

  assert.equal(checks["insert:projects+assets"].status, "FAIL");
  assert.match(checks["insert:projects+assets"].detail, /needs INSERT on projects and assets/);
  assert.equal(checks.cleanup.status, "SKIP");
});

test("a non-denial during INSERT is rethrown, not reported as a clean summary", async () => {
  const { client } = makeClient();
  const broken: ProbeClient = {
    ...client,
    async rollbackTransaction() {
      throw prismaDriverError(1064, "You have an error in your SQL syntax");
    },
  };

  await assert.rejects(runVerification(broken), /SQL syntax/);
});

test("rollback failures surface instead of being swallowed", async () => {
  const { client } = makeClient({ rollbackError: new Error("rollback failed: connection lost") });
  await assert.rejects(runVerification(client), /rollback failed/);
});
